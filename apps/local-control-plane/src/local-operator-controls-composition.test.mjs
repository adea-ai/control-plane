import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalJsonStringify,
  ControlApiFixtures,
  CredentialApiFixtures,
} from '@control-plane/contracts'
import {
  createControlApiApplication,
  createCredentialAdministrationService,
} from '@control-plane/control-api'
import {
  ExecutionLifecycleService,
  DurableExecutionCancellationService,
} from '@control-plane/domain'
import {
  assertSqliteWorkflowExecutionReference,
  SqliteCredentialVaultRepository,
  SqliteEncryptedSecretStore,
  SqliteExecutionCancellationRepository,
  SqlitePersistenceProvider,
  SqliteToolCallRepository,
} from '@control-plane/sqlite-persistence'
import {
  EmbeddedExecutionWorkflowDispatcher,
  WorkflowJobStore,
} from '@control-plane/workflow-runtime'
import { LocalAdmissionControlService } from './operator-admission-control-service.ts'
import {
  applyAdmissionControl,
  getWorkflowAdmissionStop,
  listWorkflowAdmissionOutcomes,
} from './operator-admission-controls.ts'
import { LocalControlApiComposition } from './local-api-composition.ts'
import {
  createSqliteRecordReader,
  inspectStuckJobs,
  openReadOnlyInspectionDatabase,
} from './operator-inspection.ts'
import { createLocalGraphToolFixture } from './local-graph-tool-fixture.mjs'

// Every value here is synthetic. Canaries must never appear in stored bytes or responses.
const CREDENTIAL_CANARY = 'operator-controls-composition-SECRET-canary-51c0'
const ROTATION_CANARY = 'operator-controls-composition-ROTATED-canary-9a4e'
const CANCEL_CALLER = 'svc_graph-tool-test'
const CANCEL_TOKEN = 'operator-controls-cancel-token'
const CREDENTIAL_TOKEN = 'operator-controls-credential-token'
const ADMISSION_TOKEN = 'operator-controls-admission-token'
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const metadata = {
  serviceName: 'local-control-plane',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'local-operator-controls-composition-test',
}

/** Deterministic canonical identifiers (prefix + Crockford characters), per index. */
function canonicalId(prefix, index, length) {
  let value = index
  let suffix = ''
  for (let position = 0; position < length; position++) {
    suffix = ALPHABET[value % 32] + suffix
    value = Math.floor(value / 32)
  }
  return `${prefix}${suffix}`
}
const commandId = (index) => canonicalId('cmd_', index, 26)

function authenticatorFor(token, principal) {
  return {
    authenticate: async (request, requiredScopes) => {
      if (
        request.headers.authorization !== `Bearer ${token}` ||
        !requiredScopes.every((scope) => principal.scopes.includes(scope))
      ) {
        throw new Error('TEST_SERVICE_AUTHENTICATION_REJECTED')
      }
      return principal
    },
  }
}

async function postJson(application, url, token, payload) {
  const response = await application.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  })
  return { statusCode: response.statusCode, body: response.json(), raw: response.body }
}

/** Failing or healthy dispatcher around the real embedded workflow dispatcher. */
class ToggledCancelDispatcher {
  attempts = 0
  accepted = 0
  failNext = false
  constructor(inner) {
    this.inner = inner
  }
  async cancel(request) {
    this.attempts += 1
    if (this.failNext) {
      this.failNext = false
      throw new Error('DISPATCH_UNAVAILABLE')
    }
    this.accepted += 1
    return this.inner.cancel(request)
  }
}

/** Secret store whose deletes fail while the provider is down. Every other method is the real one. */
class ProviderOutageSecretStore {
  failDeletes = false
  constructor(inner) {
    this.inner = inner
  }
  put(input) {
    return this.inner.put(input)
  }
  get(input) {
    return this.inner.get(input)
  }
  async delete(input) {
    if (this.failDeletes) throw new Error('SECRET_PROVIDER_UNAVAILABLE')
    return this.inner.delete(input)
  }
}

function cancelCommand(fixture, { commandIdValue, idempotencyKey, payloadOverrides = {} }) {
  const { executionScope: _acceptanceScope, ...base } =
    ControlApiFixtures.executionAcceptance.request
  const payload = { executionId: fixture.operation.executionId, ...payloadOverrides }
  return {
    ...base,
    caller: { servicePrincipalId: CANCEL_CALLER },
    operation: 'execution.cancel',
    workspaceId: fixture.operation.workspaceId,
    projectId: fixture.plan.correlation.projectId,
    commandId: commandIdValue,
    idempotencyKey,
    issuedAt: fixture.at,
    payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
    payload,
  }
}

function receiptScope(command) {
  return {
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    caller: command.caller,
    operation: command.operation,
    idempotencyKey: command.idempotencyKey,
  }
}

function cancelPrincipal(fixture) {
  return {
    principalId: CANCEL_CALLER,
    workspaceIds: [fixture.operation.workspaceId],
    projectIds: [fixture.plan.correlation.projectId],
    scopes: ['execution:cancel'],
  }
}

async function cancelApplication(fixture, persistence, api, dispatcher) {
  return await createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    metadata,
    logger: { write: () => undefined },
    serviceAuthenticator: authenticatorFor(CANCEL_TOKEN, cancelPrincipal(fixture)),
    executionCancellationService: new DurableExecutionCancellationService(
      new SqliteExecutionCancellationRepository(persistence),
      api.commandRepository,
      dispatcher,
      () => fixture.at
    ),
  })
}

// ---------------------------------------------------------------------------
// Fence: in-flight cancellation across a real restart, with a terminal transition
// and stale or conflicting follow-up commands.
// ---------------------------------------------------------------------------

test('an in-flight cancel survives a real restart, completes exactly once, and refuses new work on the terminal execution', async () => {
  const fixture = await createLocalGraphToolFixture({ graphInput: { cancel: 'in-flight' } })
  const executionId = fixture.operation.executionId
  const path = join(fixture.directory, 'state.sqlite')
  const persistence = fixture.persistence
  let originalClosed = false
  let application
  let restartedPersistence
  try {
    const workflowJobs = new WorkflowJobStore(persistence, {
      beforeEnqueue: assertSqliteWorkflowExecutionReference,
    })
    const dispatcher = new ToggledCancelDispatcher(
      new EmbeddedExecutionWorkflowDispatcher({ store: workflowJobs, now: () => fixture.at })
    )
    dispatcher.failNext = true
    application = await cancelApplication(fixture, persistence, fixture.api, dispatcher)

    // 1. The first dispatch fails: the signal is not acknowledged and the intent is reserved.
    const first = cancelCommand(fixture, {
      commandIdValue: commandId(1),
      idempotencyKey: 'in-flight-cancel-0001',
    })
    const unconfirmed = await postJson(application, '/v1/executions/cancel', CANCEL_TOKEN, first)
    expect(unconfirmed.statusCode).toBe(503)
    expect(unconfirmed.body.error.code).toBe('EXECUTION_CANCELLATION_UNCONFIRMED')
    const reserved = await new SqliteExecutionCancellationRepository(persistence).get(
      receiptScope(first)
    )
    expect(reserved).toBeDefined()
    expect(reserved.acceptedAt).toBeUndefined()
    expect(dispatcher.attempts).toBe(1)
    expect(dispatcher.accepted).toBe(0)

    // 2. The execution reaches a terminal state while that intent is still in flight.
    const lifecycle = new ExecutionLifecycleService(fixture.api.executions)
    const execution = await fixture.api.executions.getExecution(executionId)
    await lifecycle.transitionExecution({
      executionId,
      expectedVersion: execution.version,
      to: 'cancelled',
      transitionedAt: fixture.at,
    })

    // 3. A real restart: close, reopen the same database file, rebuild every repository.
    await application.close()
    application = undefined
    persistence.close({ checkpoint: true })
    originalClosed = true
    restartedPersistence = new SqlitePersistenceProvider({ path })
    await restartedPersistence.migrate()
    const restartedApi = new LocalControlApiComposition(restartedPersistence, 'http://127.0.0.1:1')
    const restartedJobs = new WorkflowJobStore(restartedPersistence, {
      beforeEnqueue: assertSqliteWorkflowExecutionReference,
    })
    const restartedDispatcher = new ToggledCancelDispatcher(
      new EmbeddedExecutionWorkflowDispatcher({ store: restartedJobs, now: () => fixture.at })
    )
    application = await cancelApplication(
      fixture,
      restartedPersistence,
      restartedApi,
      restartedDispatcher
    )
    const survivor = await new SqliteExecutionCancellationRepository(restartedPersistence).get(
      receiptScope(first)
    )
    expect(survivor.acceptedAt).toBeUndefined()

    // 4. Retrying the in-flight command completes it: accepted, replayed, one dispatch.
    const completed = await postJson(application, '/v1/executions/cancel', CANCEL_TOKEN, first)
    expect(completed.statusCode).toBe(202)
    expect(completed.body.data).toMatchObject({ executionId, status: 'accepted', replayed: true })
    expect(restartedDispatcher.accepted).toBe(1)
    const accepted = await new SqliteExecutionCancellationRepository(restartedPersistence).get(
      receiptScope(first)
    )
    expect(accepted.acceptedAt).toBeDefined()

    // 5. An exact replay after completion is idempotent and does not dispatch again.
    const replay = await postJson(application, '/v1/executions/cancel', CANCEL_TOKEN, first)
    expect(replay.statusCode).toBe(202)
    expect(replay.body.data.replayed).toBe(true)
    expect(restartedDispatcher.accepted).toBe(1)

    // 6. A new command against the terminal execution is refused and leaves no receipt.
    const fresh = cancelCommand(fixture, {
      commandIdValue: commandId(2),
      idempotencyKey: 'in-flight-cancel-0002',
    })
    const refused = await postJson(application, '/v1/executions/cancel', CANCEL_TOKEN, fresh)
    expect(refused.statusCode).toBe(409)
    expect(refused.body.error.code).toBe('EXECUTION_CANCELLATION_EXECUTION_INACTIVE')
    expect(
      await new SqliteExecutionCancellationRepository(restartedPersistence).get(receiptScope(fresh))
    ).toBeUndefined()
  } finally {
    if (application) await application.close()
    if (!originalClosed) persistence.close({ checkpoint: true })
    restartedPersistence?.close({ checkpoint: true })
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('a reused idempotency key with an extra payload field is refused by the strict contract and leaves the receipt unchanged', async () => {
  const fixture = await createLocalGraphToolFixture({ graphInput: { cancel: 'conflict' } })
  const workflowJobs = new WorkflowJobStore(fixture.persistence, {
    beforeEnqueue: assertSqliteWorkflowExecutionReference,
  })
  const dispatcher = new ToggledCancelDispatcher(
    new EmbeddedExecutionWorkflowDispatcher({ store: workflowJobs, now: () => fixture.at })
  )
  const application = await cancelApplication(fixture, fixture.persistence, fixture.api, dispatcher)
  try {
    const original = cancelCommand(fixture, {
      commandIdValue: commandId(3),
      idempotencyKey: 'conflict-cancel-0001',
    })
    expect(
      (await postJson(application, '/v1/executions/cancel', CANCEL_TOKEN, original)).statusCode
    ).toBe(202)
    const before = await new SqliteExecutionCancellationRepository(fixture.persistence).get(
      receiptScope(original)
    )
    // Same key and scope, different payload: a stale or forged replay of the same command.
    const forged = cancelCommand(fixture, {
      commandIdValue: commandId(3),
      idempotencyKey: 'conflict-cancel-0001',
      payloadOverrides: { note: 'different-intent' },
    })
    const conflict = await postJson(application, '/v1/executions/cancel', CANCEL_TOKEN, forged)
    // The strict payload schema refuses the extra field before the service runs. This is a
    // contract refusal, not the service payload-conflict path, which needs a second execution.
    expect(conflict.statusCode).toBe(400)
    expect(conflict.body.error.code).toBe('EXECUTION_CANCELLATION_INVALID')
    expect(
      await new SqliteExecutionCancellationRepository(fixture.persistence).get(
        receiptScope(original)
      )
    ).toEqual(before)
    expect(dispatcher.accepted).toBe(1)
  } finally {
    await application.close()
    fixture.persistence.close({ checkpoint: true })
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Revoke: a provider outage during revocation, a real restart, and stale evidence.
// ---------------------------------------------------------------------------

function credentialApplication(persistence, secretStore, principal = null) {
  const workspaceId = CredentialApiFixtures.create.request.workspaceId
  const grant = principal ?? {
    principalId: CredentialApiFixtures.create.request.caller.servicePrincipalId,
    workspaceIds: [workspaceId],
    projectIds: [],
    scopes: ['credential:write', 'credential:read'],
  }
  return createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    metadata,
    logger: { write: () => undefined },
    serviceAuthenticator: authenticatorFor(CREDENTIAL_TOKEN, grant),
    credentialAdministrationService: createCredentialAdministrationService({
      repository: new SqliteCredentialVaultRepository(persistence),
      secretStore,
      encryptionKey: 'f'.repeat(64),
      keyReference: 'control-plane-local-secret-key',
      secretPrefix: 'local://credential-secrets',
    }),
  })
}

async function secretRevisionCount(persistence) {
  return await persistence.transaction(async (transaction) => {
    return (await transaction.list('credential-secrets')).length
  })
}

test('a revocation that the secret provider fails to finish is retried after a restart until every revision is gone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-controls-revoke-'))
  const path = join(directory, 'control-plane.sqlite')
  let persistence = new SqlitePersistenceProvider({ path })
  await persistence.migrate()
  const outage = new ProviderOutageSecretStore(new SqliteEncryptedSecretStore(persistence))
  let application = await credentialApplication(persistence, outage)
  let restarted
  try {
    const created = await postJson(application, '/v1/credentials/create', CREDENTIAL_TOKEN, {
      ...CredentialApiFixtures.create.request,
      payload: { ...CredentialApiFixtures.create.request.payload, secret: CREDENTIAL_CANARY },
    })
    expect(created.statusCode).toBe(200)
    expect(created.raw.includes(CREDENTIAL_CANARY)).toBe(false)
    const credentialId = created.body.data.credential.credentialId
    expect(await secretRevisionCount(persistence)).toBe(1)

    // The provider is down during revocation: the fence is durable, the secret is not yet gone.
    outage.failDeletes = true
    const degraded = await postJson(application, '/v1/credentials/revoke', CREDENTIAL_TOKEN, {
      ...CredentialApiFixtures.revoke.request,
      payload: { credentialId },
    })
    expect(degraded.statusCode).toBe(503)
    expect(degraded.body.error.code).toBe('CREDENTIAL_PROVIDER_UNAVAILABLE')
    expect(await secretRevisionCount(persistence)).toBe(1)

    // Real restart with a healthy provider: the revoked state persists and retry finishes the delete.
    await application.close()
    persistence.close({ checkpoint: true })
    persistence = new SqlitePersistenceProvider({ path })
    await persistence.migrate()
    restarted = await credentialApplication(
      persistence,
      new SqliteEncryptedSecretStore(persistence)
    )
    const readAfterRestart = await postJson(restarted, '/v1/credentials/get', CREDENTIAL_TOKEN, {
      ...CredentialApiFixtures.get.request,
      parameters: { credentialId },
    })
    expect(readAfterRestart.body.data.credential.status).toBe('revoked')
    const retried = await postJson(restarted, '/v1/credentials/revoke', CREDENTIAL_TOKEN, {
      ...CredentialApiFixtures.revoke.request,
      payload: { credentialId },
    })
    expect(retried.statusCode).toBe(200)
    expect(retried.body.data.credential.status).toBe('revoked')
    expect(await secretRevisionCount(persistence)).toBe(0)

    // Stale evidence: a rotation that still names the revoked credential cannot resurrect a secret.
    const stale = await postJson(restarted, '/v1/credentials/rotate', CREDENTIAL_TOKEN, {
      ...CredentialApiFixtures.rotate.request,
      payload: {
        credentialId,
        expectedRevision: 1,
        secret: ROTATION_CANARY,
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.body.error.code).toBe('CREDENTIAL_REVOKED')
    expect(await secretRevisionCount(persistence)).toBe(0)
  } finally {
    await restarted?.close()
    await application?.close().catch(() => undefined)
    persistence.close({ checkpoint: true })
  }

  for (const file of await readdir(directory)) {
    const bytes = await readFile(join(directory, file))
    expect(bytes.includes(Buffer.from(CREDENTIAL_CANARY))).toBe(false)
    expect(bytes.includes(Buffer.from(ROTATION_CANARY))).toBe(false)
  }
  await rm(directory, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Reconciliation over the real HTTP composition: typed refusals, no state change.
// ---------------------------------------------------------------------------

test('reconciliation refuses an unknown tool call over HTTP with a typed not-found and writes nothing', async () => {
  const fixture = await createLocalGraphToolFixture({ graphInput: { reconcile: 'unknown' } })
  const principal = {
    principalId: CANCEL_CALLER,
    workspaceIds: [fixture.operation.workspaceId],
    projectIds: [fixture.plan.correlation.projectId],
    scopes: ['execution:reconcile'],
  }
  const { LocalGraphToolOperations } = await import('./local-graph-tool-operations.ts')
  const { FilesystemObjectStore } = await import('@control-plane/object-store')
  const objectStore = new FilesystemObjectStore({
    rootDirectory: join(fixture.directory, 'objects'),
    maxObjectBytes: 4_096,
  })
  const operations = new LocalGraphToolOperations({
    api: fixture.api,
    persistence: fixture.persistence,
    objectStore,
    prices: [
      {
        pin: fixture.operation.toolPin,
        currency: fixture.plan.constraints.limits.budget.currency,
        costMicrounits: 25,
      },
    ],
    now: () => fixture.at,
  })
  const application = await createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    metadata,
    logger: { write: () => undefined },
    serviceAuthenticator: authenticatorFor('operator-controls-reconcile-token', principal),
    toolEffectRecoveryService: operations,
  })
  try {
    const toolCallId = canonicalId('tlc_', 7, 26)
    const callsBefore = await new SqliteToolCallRepository(
      fixture.persistence,
      fixture.operation.workspaceId
    ).listByExecution(fixture.operation.executionId)
    expect(callsBefore).toEqual([])
    const payload = {
      executionId: fixture.operation.executionId,
      toolCallId,
      expectedRevision: 1,
      action: 'resume',
    }
    const command = {
      contractVersion: { major: 3, minor: 0 },
      requestId: fixture.plan.correlation.requestId,
      correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
      operation: 'execution.tool-effect.reconcile',
      workspaceId: fixture.operation.workspaceId,
      projectId: fixture.plan.correlation.projectId,
      caller: { servicePrincipalId: CANCEL_CALLER },
      commandId: commandId(9),
      idempotencyKey: 'operator-controls-reconcile-0001',
      issuedAt: fixture.at,
      payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
      payload,
    }
    const reconciled = await postJson(
      application,
      '/v1/executions/tool-effects/reconcile',
      'operator-controls-reconcile-token',
      command
    )
    expect(reconciled.statusCode).toBe(404)
    expect(reconciled.body.error.code).toBe('NOT_FOUND')
    // The inspect route takes a read envelope (requestedAt and parameters), not a state-changing command.
    const inspected = await postJson(
      application,
      '/v1/executions/tool-effects/inspect',
      'operator-controls-reconcile-token',
      {
        contractVersion: command.contractVersion,
        requestId: command.requestId,
        correlation: command.correlation,
        caller: command.caller,
        workspaceId: command.workspaceId,
        projectId: command.projectId,
        operation: 'execution.tool-effect.inspect',
        requestedAt: fixture.at,
        parameters: { executionId: fixture.operation.executionId, toolCallId },
      }
    )
    expect(inspected.statusCode).toBe(404)
    expect(inspected.body.error.code).toBe('NOT_FOUND')
    // Refusals create no tool call and no reconciliation state.
    expect(
      await new SqliteToolCallRepository(
        fixture.persistence,
        fixture.operation.workspaceId
      ).listByExecution(fixture.operation.executionId)
    ).toEqual([])
  } finally {
    await application.close()
    fixture.persistence.close({ checkpoint: true })
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Global controls stay explicit, and incomplete inventory is reported as incomplete.
// ---------------------------------------------------------------------------

test('a deployment-wide admission stop is typed unavailable and never records a stop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-controls-global-'))
  const persistence = new SqlitePersistenceProvider({
    path: join(directory, 'control-plane.sqlite'),
  })
  await persistence.migrate()
  const workspaceScope = {
    kind: 'workspace',
    workspaceId: ControlApiFixtures.executionAcceptance.request.workspaceId,
  }
  try {
    const actor = {
      kind: 'agent_hq_service',
      principalId: 'svc_global-control-test',
      projectIds: ['prj_01JABCDEF0123456789ABCDEFG'],
      scopes: ['operations:admission'],
      workspaceIds: [workspaceScope.workspaceId],
    }
    const outcome = await applyAdmissionControl(persistence, 'stop', {
      actor,
      scope: { kind: 'global' },
      commandId: commandId(11),
      reasonClass: 'incident_response',
      at: '2026-10-10T03:00:00.000Z',
    })
    expect(outcome).toEqual({
      status: 'unavailable',
      reason: 'ADMISSION_STOP_SCOPE_GLOBAL_UNSUPPORTED',
    })
    expect(await getWorkflowAdmissionStop(persistence, workspaceScope)).toEqual({
      status: 'open',
      scope: workspaceScope,
    })
    expect(await listWorkflowAdmissionOutcomes(persistence, workspaceScope)).toHaveLength(0)

    // The HTTP surface cannot smuggle a global scope past its strict contract.
    const application = await createControlApiApplication({
      health: () => ({ status: 'ok', metadata }),
      readiness: () => ({ status: 'ready', metadata }),
      metadata,
      logger: { write: () => undefined },
      serviceAuthenticator: authenticatorFor(ADMISSION_TOKEN, {
        principalId: 'svc_global-control-test',
        workspaceIds: [workspaceScope.workspaceId],
        projectIds: [],
        scopes: ['execution:admission'],
      }),
      admissionControlService: new LocalAdmissionControlService({
        persistence,
        now: () => '2026-10-10T03:00:00.000Z',
      }),
    })
    try {
      const base = ControlApiFixtures.executionAcceptance.request
      const payload = { reasonClass: 'incident_response' }
      const globalAttempt = await postJson(
        application,
        '/v1/executions/admission-stop',
        ADMISSION_TOKEN,
        {
          ...base,
          operation: 'execution.admission-stop',
          commandId: commandId(12),
          issuedAt: '2026-10-10T03:00:00.000Z',
          idempotencyKey: 'global-stop-attempt-0001',
          payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
          payload,
          scope: { kind: 'global' },
        }
      )
      expect(globalAttempt.statusCode).toBe(400)
      expect(await getWorkflowAdmissionStop(persistence, workspaceScope)).toMatchObject({
        status: 'open',
      })
    } finally {
      await application.close()
    }
  } finally {
    persistence.close({ checkpoint: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('stuck-job inspection over a real store reports an incomplete bounded inventory explicitly and keeps unsupported controls unavailable', async () => {
  const fixture = await createLocalGraphToolFixture({ graphInput: { inventory: 'bounded' } })
  const workspaceId = fixture.operation.workspaceId
  const statePath = join(fixture.directory, 'state.sqlite')
  try {
    // Two real cancel commands write two in-scope receipts through the composed service.
    const workflowJobs = new WorkflowJobStore(fixture.persistence, {
      beforeEnqueue: assertSqliteWorkflowExecutionReference,
    })
    const dispatcher = new ToggledCancelDispatcher(
      new EmbeddedExecutionWorkflowDispatcher({ store: workflowJobs, now: () => fixture.at })
    )
    const application = await cancelApplication(
      fixture,
      fixture.persistence,
      fixture.api,
      dispatcher
    )
    try {
      for (const [index, key] of [
        [21, 'inventory-cancel-0001'],
        [22, 'inventory-cancel-0002'],
      ]) {
        const accepted = await postJson(
          application,
          '/v1/executions/cancel',
          CANCEL_TOKEN,
          cancelCommand(fixture, { commandIdValue: commandId(index), idempotencyKey: key })
        )
        expect(accepted.statusCode).toBe(202)
      }
    } finally {
      await application.close()
    }

    // Complete inventory first, under the default bounds: an honest zero-incomplete baseline.
    const complete = await inspectOverStore(statePath, { workspaceId, now: fixture.at })
    expect(complete.summary.complete).toBe(true)
    expect(complete.summary.incompleteScans).toEqual([])
    expect(complete.controlOperations.channelOwnership).toMatchObject({ status: 'unavailable' })
    expect(complete.controlOperations.credentialFence).toMatchObject({ status: 'unavailable' })

    // Bounded inventory: a one-match budget cannot cover the store, so the report says so.
    const bounded = await inspectOverStore(statePath, {
      workspaceId,
      now: fixture.at,
      maxScanMatches: 1,
    })
    expect(bounded.summary.complete).toBe(false)
    const receiptsScan = bounded.summary.incompleteScans.find(
      (scan) => scan.namespace === 'execution-cancellation-receipts'
    )
    expect(receiptsScan).toMatchObject({ reason: 'match_budget_reached' })
    // Unsupported controls never turn into success just because the walk stopped.
    expect(bounded.controlOperations.channelOwnership.status).toBe('unavailable')
    expect(bounded.controlOperations.credentialFence.status).toBe('unavailable')
  } finally {
    await fixture.cleanup()
  }
})

async function inspectOverStore(statePath, options) {
  const handle = await openReadOnlyInspectionDatabase(statePath)
  try {
    return inspectStuckJobs(createSqliteRecordReader(handle), options)
  } finally {
    handle.close?.()
  }
}
