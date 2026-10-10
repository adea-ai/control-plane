import { expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlApiFixtures, canonicalJsonStringify } from '@control-plane/contracts'
import {
  ConfiguredCredentialRevocationChecker,
  Ed25519ServiceCredentialVerifier,
  PolicyServiceAuthenticator,
  createControlApiApplication,
} from '@control-plane/control-api'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { LocalAdmissionControlService } from './operator-admission-control-service.ts'
import {
  getWorkflowAdmissionStop,
  listWorkflowAdmissionOutcomes,
} from './operator-admission-controls.ts'

/**
 * Proves the operator admission stop/resume control through the real
 * production entrypoint — `createControlApiApplication` with the real
 * `PolicyServiceAuthenticator` guard pipeline (real Ed25519 verification,
 * real revocation and envelope-scope checks) in front of the local
 * `LocalAdmissionControlService` over disposable SQLite. The five mandated
 * scenarios each assert the durable state or the absence of any state change.
 */

const metadata = {
  serviceName: 'local-control-plane',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'admission-entrypoint-test',
}

const WORKSPACE = ControlApiFixtures.executionAcceptance.request.workspaceId
const PROJECT = ControlApiFixtures.executionAcceptance.request.projectId
const OTHER_WORKSPACE = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const PRINCIPAL = 'svc_agent-hq'
const SCOPE = { kind: 'workspace', workspaceId: WORKSPACE }
const DUPLICATE_COMMAND_ID = 'cmd_01GABCDEF0123456789ABCDEFG'
const RESUME_COMMAND_ID = 'cmd_01FABCDEF0123456789ABCDEFG'
const CREDENTIAL_ID = 'credential-admission-entrypoint-test'
const KEY_ID = 'test-key-admission-1029'
const ISSUER = 'https://agent-hq.example'
const AUDIENCE = 'control-plane'
const NOW = '2026-08-23T12:00:00.000Z'

const keys = generateKeyPairSync('ed25519')
const verifier = new Ed25519ServiceCredentialVerifier([
  { keyId: KEY_ID, publicKey: keys.publicKey.export({ format: 'jwk' }).x },
])

/** Signs a real Ed25519 service JWT for the requested claim overrides. */
function bearer(overrides = {}) {
  const claims = {
    audience: AUDIENCE,
    credentialId: CREDENTIAL_ID,
    credentialKind: 'service',
    expiresAt: '2026-08-23T13:00:00.000Z',
    issuedAt: '2026-08-23T11:59:00.000Z',
    issuer: ISSUER,
    keyId: KEY_ID,
    principalId: PRINCIPAL,
    projectIds: [PROJECT],
    scopes: ['execution:admission'],
    workspaceIds: [WORKSPACE],
    ...overrides,
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: KEY_ID })}.${encode(claims)}`
  return `${signingInput}.${sign(null, Buffer.from(signingInput), keys.privateKey).toString('base64url')}`
}

function admissionCommand(overrides = {}, payloadOverrides = {}) {
  const base = ControlApiFixtures.executionAcceptance.request
  const payload = {
    reasonClass: 'incident_response',
    reason: 'Entrypoint admission proof',
    ...payloadOverrides,
  }
  return {
    ...base,
    operation: 'execution.admission-stop',
    idempotencyKey: 'admission-entrypoint-0000',
    payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
    payload,
    ...overrides,
  }
}

async function withControlPlane(options, run) {
  const directory = await mkdtemp(join(tmpdir(), 'admission-entrypoint-'))
  const persistence = new SqlitePersistenceProvider({
    path: join(directory, 'control-plane.sqlite'),
  })
  await persistence.migrate()
  const application = await createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    metadata,
    logger: { write: () => undefined },
    serviceAuthenticator: new PolicyServiceAuthenticator({
      audience: AUDIENCE,
      issuer: ISSUER,
      clockSkewMs: 30_000,
      now: () => new Date(NOW),
      logger: { write: () => undefined },
      verifier,
      revocationChecker: new ConfiguredCredentialRevocationChecker(
        options.revokedCredentialIds ?? []
      ),
    }),
    ...(options.unconfigured
      ? {}
      : {
          admissionControlService: new LocalAdmissionControlService({
            persistence,
            ...(options.enforcement === undefined ? {} : { enforcement: options.enforcement }),
          }),
        }),
  })
  try {
    await run(application, persistence)
  } finally {
    await application.close()
    persistence.close({ checkpoint: true })
    await rm(directory, { recursive: true, force: true })
  }
}

function post(application, payload, token = bearer(), url = '/v1/executions/admission-stop') {
  return application.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  })
}

test(
  'authorized stop applies once, replays its receipt, and records audited outcomes',
  async () =>
    withControlPlane({}, async (application, persistence) => {
      const command = admissionCommand()
      const first = await post(application, command)
      expect(first.statusCode).toBe(202)
      expect(first.json()).toEqual({
        ...ControlApiFixtures.executionAcceptance.response,
        data: {
          commandId: command.commandId,
          workspaceId: WORKSPACE,
          operation: 'execution.admission-stop',
          outcome: 'applied',
          admission: 'stopped',
        },
      })

      // Durable state and the append-only audit trail committed together.
      expect(await getWorkflowAdmissionStop(persistence, SCOPE)).toMatchObject({
        status: 'stopped',
        commandId: command.commandId,
        actorPrincipalId: PRINCIPAL,
        reasonClass: 'incident_response',
      })
      const outcomes = await listWorkflowAdmissionOutcomes(persistence, SCOPE)
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]).toMatchObject({
        action: 'stop',
        result: 'applied',
        actorPrincipalId: PRINCIPAL,
        stateAfter: 'stopped',
      })

      // An exact repeat of the same command returns the earlier receipt and
      // writes no second outcome.
      const replay = await post(application, command)
      expect(replay.statusCode).toBe(202)
      expect(replay.json().data).toMatchObject({ outcome: 'replayed', admission: 'stopped' })
      expect(await listWorkflowAdmissionOutcomes(persistence, SCOPE)).toHaveLength(1)

      // A fresh command against the already-achieved state is an idempotent
      // success recorded as a duplicate.
      const duplicate = await post(
        application,
        admissionCommand({
          commandId: DUPLICATE_COMMAND_ID,
          idempotencyKey: 'admission-entrypoint-duplicate-0001',
          issuedAt: '2026-08-23T12:02:00.000Z',
        })
      )
      expect(duplicate.statusCode).toBe(202)
      expect(duplicate.json().data).toMatchObject({ outcome: 'duplicate', admission: 'stopped' })
      const audited = await listWorkflowAdmissionOutcomes(persistence, SCOPE)
      expect(audited).toHaveLength(2)
      expect(audited.map((outcome) => outcome.result)).toEqual(['applied', 'duplicate'])
    }),
  30_000
)

test(
  'authorized resume reopens admission with an audited outcome',
  async () =>
    withControlPlane({}, async (application, persistence) => {
      await post(application, admissionCommand())
      const resume = await post(
        application,
        admissionCommand({
          operation: 'execution.admission-resume',
          commandId: RESUME_COMMAND_ID,
          idempotencyKey: 'admission-entrypoint-resume-0001',
          issuedAt: '2026-08-23T12:01:00.000Z',
        }),
        bearer(),
        '/v1/executions/admission-resume'
      )
      expect(resume.statusCode).toBe(202)
      expect(resume.json().data).toMatchObject({
        outcome: 'applied',
        admission: 'open',
        operation: 'execution.admission-resume',
      })
      expect(await getWorkflowAdmissionStop(persistence, SCOPE)).toEqual({
        status: 'open',
        scope: SCOPE,
      })
      const outcomes = await listWorkflowAdmissionOutcomes(persistence, SCOPE)
      expect(
        outcomes.map((outcome) => [outcome.action, outcome.result, outcome.stateAfter])
      ).toEqual([
        ['stop', 'applied', 'stopped'],
        ['resume', 'applied', 'open'],
      ])
    }),
  30_000
)

test(
  'a credential without the target workspace is denied before any state change',
  async () =>
    withControlPlane({}, async (application, persistence) => {
      const response = await post(
        application,
        admissionCommand(),
        bearer({ workspaceIds: [OTHER_WORKSPACE] })
      )
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('SERVICE_CREDENTIAL_SCOPE_MISMATCH')
      expect(await getWorkflowAdmissionStop(persistence, SCOPE)).toEqual({
        status: 'open',
        scope: SCOPE,
      })
      expect(await listWorkflowAdmissionOutcomes(persistence, SCOPE)).toHaveLength(0)
    }),
  30_000
)

test(
  'a revoked service credential is rejected before the control runs',
  async () =>
    withControlPlane(
      { revokedCredentialIds: [CREDENTIAL_ID] },
      async (application, persistence) => {
        const response = await post(application, admissionCommand())
        expect(response.statusCode).toBe(401)
        expect(response.json().error.code).toBe('SERVICE_CREDENTIAL_REVOKED')
        expect(await getWorkflowAdmissionStop(persistence, SCOPE)).toEqual({
          status: 'open',
          scope: SCOPE,
        })
        expect(await listWorkflowAdmissionOutcomes(persistence, SCOPE)).toHaveLength(0)
      }
    ),
  30_000
)

test(
  'a profile without an admission control reports explicit unavailability',
  async () =>
    withControlPlane({ unconfigured: true }, async (application, persistence) => {
      const response = await post(application, admissionCommand())
      expect(response.statusCode).toBe(503)
      const envelope = response.json()
      expect(envelope.error.code).toBe('ADMISSION_CONTROL_UNAVAILABLE')
      expect(envelope.error.class).toBe('runtime_unavailable')
      expect(envelope.error.retryable).toBe(true)
      expect(await getWorkflowAdmissionStop(persistence, SCOPE)).toEqual({
        status: 'open',
        scope: SCOPE,
      })
    }),
  30_000
)

test(
  'a composition whose runtime cannot enforce admission reports the same bounded unavailability',
  async () =>
    withControlPlane({ enforcement: 'unavailable' }, async (application, persistence) => {
      const response = await post(application, admissionCommand())
      expect(response.statusCode).toBe(503)
      const envelope = response.json()
      expect(envelope.error.code).toBe('ADMISSION_CONTROL_UNAVAILABLE')
      expect(response.body).not.toContain('ADMISSION_CONTROL_RUNTIME_UNAVAILABLE')
      expect(await getWorkflowAdmissionStop(persistence, SCOPE)).toEqual({
        status: 'open',
        scope: SCOPE,
      })
      expect(await listWorkflowAdmissionOutcomes(persistence, SCOPE)).toHaveLength(0)
    }),
  30_000
)
