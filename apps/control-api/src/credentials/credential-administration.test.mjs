import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialApiFixtures } from '@control-plane/contracts'
import {
  CredentialVault,
  NeonEncryptedSecretProvider,
  VaultToolCredentialBroker,
} from '@control-plane/credential-vault'
import {
  SqliteCredentialVaultRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { createControlApiApplication } from '../application.ts'
import { PolicyServiceAuthenticator } from '../auth/service-authentication.ts'
import { VaultCredentialAdministrationService } from './credential-administration.service.ts'

const canary = 'control-api-credential-SECRET-canary-9e27'
const rotatedCanary = 'control-api-credential-SECRET-canary-rotated-4410'
const workspaceId = CredentialApiFixtures.create.request.workspaceId
const otherWorkspaceId = 'wsp_01JABCDEF0123456789ABCDEFH'
const principal = CredentialApiFixtures.create.request.caller.servicePrincipalId
const now = new Date('2026-10-06T12:00:00.000Z')
const metadata = {
  serviceName: 'control-api',
  version: '1.0.0',
  commitSha: 'abc123',
  // Development composes the console trace adapter, so spans reach the captured logger too.
  environment: 'development',
  instanceId: 'credential-api-test',
}
const baseClaims = {
  credentialKind: 'service',
  credentialId: 'credential-admin-fixture',
  keyId: 'credential-key',
  audience: 'control-plane',
  issuer: 'https://credential-api.example',
  principalId: principal,
  issuedAt: '2026-10-06T11:00:00.000Z',
  expiresAt: '2026-10-06T12:55:00.000Z',
  scopes: ['credential:write', 'credential:read'],
  workspaceIds: [workspaceId, otherWorkspaceId],
  projectIds: [],
}

function serialize(value) {
  return JSON.stringify(value, (_key, entry) =>
    entry instanceof Error
      ? { name: entry.name, message: entry.message, stack: entry.stack, ...entry }
      : entry
  )
}

const create = (overrides = {}) => ({
  ...CredentialApiFixtures.create.request,
  payload: { ...CredentialApiFixtures.create.request.payload, secret: canary },
  ...overrides,
})
const read = (operation, parameters, overrides = {}) => ({
  ...CredentialApiFixtures.get.request,
  operation,
  parameters,
  ...overrides,
})
const command = (operation, payload, idempotencyKey, overrides = {}) => ({
  ...CredentialApiFixtures.rotate.request,
  operation,
  payload,
  idempotencyKey,
  ...overrides,
})

describe('credential Control API', () => {
  let directory
  let persistence
  let app
  let logs
  let claims
  let secretStore
  let vault

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'credential-api-'))
    persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
    await persistence.migrate()
    secretStore = new Map()
    const provider = new NeonEncryptedSecretProvider({
      store: {
        async put(input) {
          secretStore.set(`${input.locator}:${input.version}`, input)
        },
        async get(input) {
          return secretStore.get(`${input.locator}:${input.version}`)
        },
        async delete(input) {
          secretStore.delete(`${input.locator}:${input.version}`)
        },
      },
      encryptionKey: 'c'.repeat(64),
      keyReference: 'control-plane-secret-encryption-key/v1',
    })
    const repository = new SqliteCredentialVaultRepository(persistence)
    vault = new CredentialVault({
      provider,
      repository,
      decisionPoint: {
        async authorize(request) {
          return {
            effect: 'allow',
            decisionId: `sha256:${'d'.repeat(64)}`,
            reasonCode: 'CEDAR_PERMIT',
            policySnapshot: request.policySnapshot,
            evaluatedAt: request.context.requestedAt,
          }
        },
      },
      now: () => now.toISOString(),
    })
    logs = []
    claims = baseClaims
    const logger = { write: (entry) => logs.push(entry) }
    app = await createControlApiApplication({
      metadata,
      logger,
      health: () => ({ status: 'ok', metadata }),
      readiness: () => ({ status: 'ready', metadata }),
      serviceAuthenticator: new PolicyServiceAuthenticator({
        audience: baseClaims.audience,
        issuer: baseClaims.issuer,
        now: () => now,
        logger,
        revocationChecker: { isRevoked: async () => false },
        verifier: { verify: async () => claims },
      }),
      credentialAdministrationService: new VaultCredentialAdministrationService({
        vault,
        receipts: repository,
        now: () => now,
      }),
    })
  })

  afterEach(async () => {
    await app?.close()
    await persistence?.close()
    await rm(directory, { recursive: true, force: true })
  })

  const post = (path, payload, authorized = true) =>
    app.inject({
      method: 'POST',
      url: `/v1/credentials/${path}`,
      payload,
      ...(authorized ? { headers: { authorization: 'Bearer credential-admin-fixture' } } : {}),
    })

  async function assertNoSecretAnywhere(responses) {
    const surfaces = serialize({
      responses: responses.map((response) => response.body),
      logs,
      audit: await vault.audit(),
      ciphertext: [...secretStore.values()].map((record) => record.ciphertext),
    })
    expect(surfaces.includes(canary)).toBe(false)
    expect(surfaces.includes(rotatedCanary)).toBe(false)
    for (const file of await readdir(directory)) {
      const bytes = await readFile(join(directory, file))
      expect(bytes.includes(Buffer.from(canary))).toBe(false)
      expect(bytes.includes(Buffer.from(rotatedCanary))).toBe(false)
    }
  }

  test('creates, reads, lists, rotates and revokes without ever returning or logging the secret', async () => {
    const responses = []
    const created = await post('create', create())
    responses.push(created)
    expect(created.statusCode).toBe(200)
    const credential = created.json().data.credential
    expect(credential).toMatchObject({
      workspaceId,
      connectorRef: 'connector:github',
      provider: 'github',
      status: 'active',
      revision: 1,
      createdBy: principal,
      createdAt: now.toISOString(),
    })
    expect(Object.keys(created.json().data.credential).toSorted()).toEqual(
      [
        'connectorRef',
        'createdAt',
        'createdBy',
        'credentialId',
        'provider',
        'revision',
        'status',
        'workspaceId',
      ].toSorted()
    )

    // An identical retry replays the receipt and never stores another secret.
    const replay = await post(
      'create',
      create({ payload: { ...create().payload, secret: rotatedCanary } })
    )
    responses.push(replay)
    expect(replay.json().data.credential).toEqual(credential)
    expect(secretStore.size).toBe(1)
    const conflicting = await post(
      'create',
      create({ payload: { ...create().payload, connectorRef: 'connector:other' } })
    )
    responses.push(conflicting)
    expect(conflicting.statusCode).toBe(409)
    expect(conflicting.json().error.code).toBe('CREDENTIAL_COMMAND_CONFLICT')
    const duplicateConnector = await post(
      'create',
      create({ idempotencyKey: 'credential-create-second-connector-0001' })
    )
    responses.push(duplicateConnector)
    expect(duplicateConnector.statusCode).toBe(409)
    expect(duplicateConnector.json().error.code).toBe('CREDENTIAL_CONNECTOR_IN_USE')

    const fetched = await post(
      'get',
      read('credential.get', { credentialId: credential.credentialId })
    )
    responses.push(fetched)
    expect(fetched.json().data.credential).toEqual(credential)
    const listed = await post('list', read('credential.list', { limit: 10 }))
    responses.push(listed)
    expect(listed.json().data).toEqual({ credentials: [credential] })

    const rotation = command(
      'credential.rotate',
      { credentialId: credential.credentialId, expectedRevision: 1, secret: rotatedCanary },
      'credential-rotate-http-0000001'
    )
    const rotated = await post('rotate', rotation)
    responses.push(rotated)
    expect(rotated.statusCode).toBe(200)
    expect(rotated.json().data.credential).toMatchObject({ revision: 2, status: 'active' })
    const rotatedAgain = await post('rotate', rotation)
    responses.push(rotatedAgain)
    expect(rotatedAgain.json().data.credential.revision).toBe(2)
    const stale = await post('rotate', {
      ...rotation,
      idempotencyKey: 'credential-rotate-http-0000002',
    })
    responses.push(stale)
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('CREDENTIAL_REVISION_CONFLICT')

    // The tool-gateway lease path resolves the newest revision for this workspace connector.
    const broker = new VaultToolCredentialBroker({
      vault,
      policySnapshot: () => ({
        policyId: 'workspace-standard',
        version: 1,
        digest: `sha256:${'a'.repeat(64)}`,
      }),
      now: () => now,
    })
    await expect(
      broker.withCredential(
        {
          workspaceId,
          connectorRef: 'connector:github',
          requestId: 'req_01JABCDEF0123456789ABCDEFG',
          principalRef: 'service:tool-gateway',
          operation: 'issues.create',
          resourceRef: 'mcp/github/issues.create',
        },
        (secret) => secret === rotatedCanary
      )
    ).resolves.toBe(true)

    const revoke = command(
      'credential.revoke',
      { credentialId: credential.credentialId },
      'credential-revoke-http-0000001'
    )
    const revoked = await post('revoke', revoke)
    responses.push(revoked)
    expect(revoked.json().data.credential).toMatchObject({ status: 'revoked', revision: 2 })
    expect((await post('revoke', revoke)).json().data.credential.status).toBe('revoked')
    expect(secretStore.size).toBe(0)
    const afterRevoke = await post('rotate', {
      ...rotation,
      idempotencyKey: 'credential-rotate-http-0000003',
      payload: { ...rotation.payload, expectedRevision: 2 },
    })
    responses.push(afterRevoke)
    expect(afterRevoke.json().error.code).toBe('CREDENTIAL_REVOKED')

    const audit = await vault.audit({ workspaceId })
    expect(audit.map(({ action }) => action)).toEqual([
      'credential.created',
      'credential.rotated',
      'lease.issued',
      'lease.used',
      'credential.revoked',
    ])
    expect(
      audit.every(
        (event) => event.principalRef === undefined || /^svc_|^service:/.test(event.principalRef)
      )
    ).toBe(true)
    await assertNoSecretAnywhere(responses)
  })

  test('denies missing authentication, missing scopes and caller or workspace mismatches before storing', async () => {
    const responses = []
    responses.push(await post('create', create(), false))
    expect(responses.at(-1).statusCode).toBe(401)
    claims = { ...baseClaims, scopes: ['credential:read'] }
    responses.push(await post('create', create()))
    expect(responses.at(-1).statusCode).toBe(403)
    claims = { ...baseClaims, scopes: ['credential:write'] }
    responses.push(await post('list', read('credential.list', {})))
    expect(responses.at(-1).statusCode).toBe(403)
    responses.push(
      await post('get', read('credential.get', { credentialId: 'crd_01JABCDEF0123456789ABCDEFG' }))
    )
    expect(responses.at(-1).statusCode).toBe(403)
    claims = { ...baseClaims, scopes: ['graph:publish'] }
    responses.push(
      await post(
        'rotate',
        command(
          'credential.rotate',
          { credentialId: 'crd_01JABCDEF0123456789ABCDEFG', expectedRevision: 1, secret: canary },
          'credential-rotate-denied-001'
        )
      )
    )
    expect(responses.at(-1).statusCode).toBe(403)
    claims = baseClaims
    responses.push(
      await post('create', create({ caller: { servicePrincipalId: 'svc_other-service' } }))
    )
    expect(responses.at(-1).statusCode).toBe(403)
    claims = { ...baseClaims, workspaceIds: [otherWorkspaceId] }
    responses.push(await post('create', create()))
    expect(responses.at(-1).statusCode).toBe(403)
    expect(secretStore.size).toBe(0)
    expect((await vault.list(workspaceId, { limit: 10 })).credentials).toHaveLength(0)
    await assertNoSecretAnywhere(responses)
  })

  test('cross-workspace get, rotate and revoke are indistinguishable from a missing credential', async () => {
    const created = (await post('create', create())).json().data.credential
    const responses = []
    responses.push(
      await post(
        'get',
        read(
          'credential.get',
          { credentialId: created.credentialId },
          { workspaceId: otherWorkspaceId }
        )
      )
    )
    responses.push(
      await post(
        'rotate',
        command(
          'credential.rotate',
          { credentialId: created.credentialId, expectedRevision: 1, secret: rotatedCanary },
          'credential-rotate-cross-0001',
          { workspaceId: otherWorkspaceId }
        )
      )
    )
    responses.push(
      await post(
        'revoke',
        command(
          'credential.revoke',
          { credentialId: created.credentialId },
          'credential-revoke-cross-01',
          {
            workspaceId: otherWorkspaceId,
          }
        )
      )
    )
    responses.push(
      await post('get', read('credential.get', { credentialId: 'crd_01JABCDEF0123456789ABCDEFZ' }))
    )
    for (const response of responses) {
      expect(response.statusCode).toBe(404)
      expect(response.json().error.code).toBe('CREDENTIAL_NOT_FOUND')
    }
    const listed = await post(
      'list',
      read('credential.list', {}, { workspaceId: otherWorkspaceId })
    )
    expect(listed.json().data.credentials).toEqual([])
    expect((await vault.metadata(created.credentialId)).status).toBe('active')
    expect(secretStore.size).toBe(1)
    await assertNoSecretAnywhere(responses)
  })

  test('validation failures never echo a rejected secret', async () => {
    const responses = []
    for (const secret of [`${canary}\n`, `${canary}`.slice(0, 5), `${canary}\u0000x`]) {
      const response = await post('create', create({ payload: { ...create().payload, secret } }))
      responses.push(response)
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('VALIDATION_ERROR')
    }
    responses.push(
      await post('create', create({ payload: { ...create().payload, unexpected: canary } }))
    )
    expect(responses.at(-1).statusCode).toBe(400)
    responses.push(await post('list', read('credential.list', { cursor: 'cur_not-a-real-cursor' })))
    expect(responses.at(-1).statusCode).toBe(400)
    expect(secretStore.size).toBe(0)
    await assertNoSecretAnywhere(responses)
  })

  test('paginates workspace credentials with opaque cursors', async () => {
    for (const index of [1, 2, 3]) {
      const response = await post(
        'create',
        create({
          idempotencyKey: `credential-create-page-000${index}`,
          payload: { ...create().payload, connectorRef: `connector:page-${index}` },
        })
      )
      expect(response.statusCode).toBe(200)
    }
    const first = (await post('list', read('credential.list', { limit: 2 }))).json().data
    expect(first.credentials).toHaveLength(2)
    expect(first.nextCursor).toMatch(/^cur_/)
    const second = (
      await post('list', read('credential.list', { limit: 2, cursor: first.nextCursor }))
    ).json().data
    expect(second.credentials).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
    expect(
      new Set([...first.credentials, ...second.credentials].map(({ credentialId }) => credentialId))
        .size
    ).toBe(3)
  })
})

test('credential routes fail closed when no vault is composed', async () => {
  const app = await createControlApiApplication({
    metadata: { ...metadata, environment: 'test' },
    logger: { write() {} },
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    serviceAuthenticator: new PolicyServiceAuthenticator({
      audience: baseClaims.audience,
      issuer: baseClaims.issuer,
      now: () => now,
      logger: { write() {} },
      revocationChecker: { isRevoked: async () => false },
      verifier: { verify: async () => baseClaims },
    }),
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/credentials/create',
      payload: create(),
      headers: { authorization: 'Bearer credential-admin-fixture' },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('CREDENTIAL_VAULT_NOT_CONFIGURED')
    expect(response.body.includes(canary)).toBe(false)
  } finally {
    await app.close()
  }
})
