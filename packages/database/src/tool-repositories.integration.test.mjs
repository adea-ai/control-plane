import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  FakeToolExecutor,
  InMemoryToolRateLimiter,
  InteractionToolApprovalCoordinator,
  PolicyControlledToolExecutionService,
  StaticToolPolicyAuthorizer,
  ToolGateway,
  ToolRegistry,
  toolInputDigest,
  toolRequestDigestLegacy,
} from '@control-plane/tool-execution'
import { InMemoryInteractionRepository, InteractionService } from '@control-plane/domain'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { ToolExecutorError } from '@control-plane/tool-sdk'
import { sql } from 'drizzle-orm'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import * as schema from './schema/index.ts'
import { PostgresToolCallRepository, PostgresToolRegistryRepository } from './tool-repositories.ts'

const integrationEnabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const otherWorkspaceId = 'wsp_01JABCDEF0123456789ABCDEGH'
const requestedAt = '2026-09-30T09:00:00.000Z'
const ids = {
  profile: 'prf_01JABCDEF0123456789ABCDEFG',
  execution: 'exe_01JABCDEF0123456789ABCDEFG',
  otherExecution: 'exe_01JABCDEF0123456789ABCDEFH',
  // Its own execution: tests share one isolated database, so a fixture row on ids.execution would
  // otherwise show up in the idempotency test's exact listByExecution(ids.execution) assertion
  // whenever test order puts it first.
  taggedExecution: 'exe_01JABCDEF0123456789ABCDEFJ',
  attempt: 'att_01JABCDEF0123456789ABCDEFG',
  otherAttempt: 'att_01JABCDEF0123456789ABCDEFH',
  request: 'req_01JABCDEF0123456789ABCDEFG',
  otherRequest: 'req_01JABCDEF0123456789ABCDEFH',
  trace: 'trc_01JABCDEF0123456789ABCDEFG',
  definition: 'tld_01JABCDEF0123456789ABCDEFG',
  serviceDefinition: 'tld_01JABCDEF0123456789ABCDEFH',
  corruptDefinition: 'tld_01JABCDEF0123456789ABCDEFA',
  version: 'tlv_01JABCDEF0123456789ABCDEFG',
  serviceVersion: 'tlv_01JABCDEF0123456789ABCDEFE',
  corruptVersion: 'tlv_01JABCDEF0123456789ABCDEFD',
  call: 'tlc_01JABCDEF0123456789ABCDEFG',
  otherCall: 'tlc_01JABCDEF0123456789ABCDEFH',
  serviceCall: 'tlc_01JABCDEF0123456789ABCDEFA',
  corruptCall: 'tlc_01JABCDEF0123456789ABCDEFB',
  ambiguousCall: 'tlc_01JABCDEF0123456789ABCDEFC',
  pendingCall: 'tlc_01JABCDEF0123456789ABCDEFE',
  historicalCall: 'tlc_01JABCDEF0123456789ABCDEFJ',
  historicalDefinition: 'tld_01JABCDEF0123456789ABCDEFK',
  historicalVersion: 'tlv_01JABCDEF0123456789ABCDEFK',
  taggedHistoricalCall: 'tlc_01JABCDEF0123456789ABCDEFM',
  pendingRequest: 'req_01JABCDEF0123456789ABCDEFC',
}

const historicalSwedishToolReceipt = {
  inputBytes: '{"z":"zee","å":"a-ring","ä":"a-diaeresis"}',
  requestBytes:
    '{"attemptId":"att_01JABCDEF0123456789ABCDEFG","executionId":"exe_01JABCDEF0123456789ABCDEFG","idempotencyKey":"tool-effect-0001","input":{"z":"zee","å":"a-ring","ä":"a-diaeresis"},"operation":"write","policySnapshotRef":"policy://workspace/v7","principalRef":"service:runtime-worker","profileId":"prf_01JABCDEF0123456789ABCDEFG","toolCallId":"tlc_01JABCDEF0123456789ABCDEFJ","toolDefinitionId":"tld_01JABCDEF0123456789ABCDEFK","toolVersionId":"tlv_01JABCDEF0123456789ABCDEFK","workspaceId":"wsp_01JABCDEF0123456789ABCDEFG"}',
  inputDigest: 'sha256:13df5d9701ee0f10b54eda343f77b053bf317cf5a8628c41638ae5216993f312',
  requestDigest: 'sha256:49d28c7262e29c1b4f63d4ad4c263fb9abd480e31298997a3f2b29d5c76a93f0',
}

function definition(ownerWorkspaceId = workspaceId, toolDefinitionId = ids.definition) {
  return {
    toolDefinitionId,
    name: 'records.write',
    displayName: 'Write record',
    description: 'Writes one scoped record.',
    ownership: { scope: 'workspace', workspaceId: ownerWorkspaceId },
    createdAt: '2026-09-30T08:00:00.000Z',
  }
}

function version(
  toolVersionId = ids.version,
  semanticVersion = '1.0.0',
  toolDefinitionId = ids.definition
) {
  return {
    toolVersionId,
    toolDefinitionId,
    semanticVersion,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', maxLength: 64 } },
      required: ['value'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { saved: { type: 'boolean' } },
      required: ['saved'],
      additionalProperties: false,
    },
    operations: [
      {
        name: 'write',
        requiredCapabilities: ['records.write'],
        riskClass: 'low',
        approvalMode: 'never',
        idempotency: 'provider_key',
      },
    ],
    executor: { type: 'connector', reference: 'records-v1' },
    limits: { maxInputBytes: 256, maxOutputBytes: 256, timeoutMs: 10_000 },
    createdAt: '2026-09-30T08:01:00.000Z',
    publishedAt: '2026-09-30T08:02:00.000Z',
    revision: 1,
    lifecycle: 'published',
    contentDigest: `sha256:${'a'.repeat(64)}`,
  }
}

function call(overrides = {}) {
  return {
    toolCallId: ids.call,
    requestDigest: `sha256:${'a'.repeat(64)}`,
    executionId: ids.execution,
    attemptId: ids.attempt,
    workspaceId,
    profileId: ids.profile,
    principalRef: 'service:runtime-worker',
    toolDefinitionId: ids.definition,
    toolVersionId: ids.version,
    operation: 'write',
    inputDigest: `sha256:${'b'.repeat(64)}`,
    policySnapshotRef: 'policy://workspace/v7',
    executor: { type: 'connector', reference: 'records-v1' },
    idempotencyKey: 'tool-effect-pg-0001',
    status: 'requested',
    revision: 1,
    requestedAt,
    history: [{ status: 'requested', at: requestedAt }],
    ...overrides,
  }
}

function executionRequest(overrides = {}) {
  const toolDefinitionId = overrides.toolDefinitionId ?? ids.definition
  const toolVersionId = overrides.toolVersionId ?? ids.version
  return {
    toolCallId: ids.call,
    idempotencyKey: 'tool-effect-service-0001',
    requestedAt,
    policySnapshotRef: 'policy://workspace/v7',
    requestId: ids.request,
    executionId: ids.execution,
    attemptId: ids.attempt,
    workspaceId,
    profileId: ids.profile,
    toolDefinitionId,
    toolVersionId,
    operation: 'write',
    input: { value: 'durable' },
    grant: {
      workspaceId,
      profileId: ids.profile,
      toolDefinitionId,
      toolVersionId,
      operations: ['write'],
    },
    audit: { principalRef: 'service:runtime-worker', traceId: ids.trace },
    ...overrides,
  }
}

function service(database, executor) {
  const registry = new ToolRegistry(new PostgresToolRegistryRepository(database, workspaceId))
  const gateway = new ToolGateway(registry)
  gateway.registerExecutor('connector', 'records-v1', executor)
  const interactions = new InMemoryInteractionRepository()
  return new PolicyControlledToolExecutionService({
    gateway,
    calls: new PostgresToolCallRepository(database, workspaceId),
    authorizer: new StaticToolPolicyAuthorizer({
      effect: 'allow',
      decisionId: 'policy-decision-pg-0001',
      policyVersion: 'workspace-v7',
      reasonCode: 'GRANTED',
      requiresApproval: false,
      evaluatedAt: requestedAt,
    }),
    approvals: new InteractionToolApprovalCoordinator(
      new InteractionService(interactions),
      interactions
    ),
    rateLimiter: new InMemoryToolRateLimiter(),
    now: () => requestedAt,
  })
}

function deferred() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function jsonDigest(value) {
  return digestValue(value)
}

function durableRequestDigest(request) {
  return digestValue({
    toolCallId: request.toolCallId,
    executionId: request.executionId,
    attemptId: request.attemptId,
    workspaceId: request.workspaceId,
    profileId: request.profileId,
    principalRef: request.audit.principalRef,
    toolDefinitionId: request.toolDefinitionId,
    toolVersionId: request.toolVersionId,
    operation: request.operation,
    input: request.input,
    idempotencyKey: request.idempotencyKey,
    policySnapshotRef: request.policySnapshotRef,
  })
}

function digestValue(value) {
  return `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(value) ?? 'null')
    .digest('hex')}`
}

function digestReceiptBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function withDefaultLocaleCompare(locale, callback) {
  const originalLocaleCompare = String.prototype.localeCompare
  Reflect.set(String.prototype, 'localeCompare', function (...args) {
    return args.length === 1
      ? originalLocaleCompare.call(this, args[0], locale)
      : originalLocaleCompare.apply(this, args)
  })
  try {
    return await callback()
  } finally {
    Reflect.set(String.prototype, 'localeCompare', originalLocaleCompare)
  }
}

describe.skipIf(!integrationEnabled)('PostgreSQL tool storage', () => {
  let isolated
  let applicationCredentials
  const openClients = new Map()

  async function openIndependentConnection() {
    const url = new URL(applicationCredentials.url)
    url.pathname = `/${isolated.name}`
    const client = postgres(url.toString(), { max: 1, prepare: false })
    openClients.set(client, true)
    return {
      database: drizzle(client, { schema }),
      async close() {
        if (openClients.delete(client)) await client.end({ timeout: 5 })
      },
    }
  }

  beforeAll(async () => {
    const administration = loadDatabaseCredentials(process.env, 'administration')
    applicationCredentials = loadDatabaseCredentials(process.env, 'application')
    const migration = loadDatabaseCredentials(process.env, 'migration')
    isolated = await createIsolatedTestDatabase({
      administration,
      application: applicationCredentials,
      migration,
    })
    await isolated.migrate()
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    await Promise.all([...openClients.keys()].map((client) => client.end({ timeout: 5 })))
    openClients.clear()
    await isolated?.dispose()
  })

  test('migration creates tool definition, version, and call storage tables', async () => {
    const [tables] = await isolated.application.execute(sql`
      select
        to_regclass('public.tool_definitions') as "toolDefinitions",
        to_regclass('public.tool_versions') as "toolVersions",
        to_regclass('public.tool_calls') as "toolCalls"
    `)

    expect(tables).toEqual({
      toolDefinitions: 'tool_definitions',
      toolVersions: 'tool_versions',
      toolCalls: 'tool_calls',
    })
  })

  test('registry immutability, workspace scope, semantic uniqueness, and concurrent inserts survive reconnect', async () => {
    const firstConnection = await openIndependentConnection()
    const secondConnection = await openIndependentConnection()
    try {
      const first = new PostgresToolRegistryRepository(firstConnection.database, workspaceId)
      const second = new PostgresToolRegistryRepository(secondConnection.database, workspaceId)
      const otherWorkspace = new PostgresToolRegistryRepository(
        firstConnection.database,
        otherWorkspaceId
      )
      expect(
        () => new PostgresToolRegistryRepository(firstConnection.database, 'not-a-workspace')
      ).toThrow()

      expect(await first.insertDefinition(definition())).toBe(true)
      expect(await second.insertDefinition({ ...definition(), displayName: 'Changed name' })).toBe(
        false
      )
      await expect(first.insertDefinition(definition(otherWorkspaceId))).rejects.toThrow(
        'POSTGRES_TOOL_SCOPE_MISMATCH'
      )
      expect(await otherWorkspace.getDefinition(ids.definition)).toBeUndefined()
      expect(await otherWorkspace.listDefinitions()).toEqual([])

      expect(await otherWorkspace.insertDefinition(definition(otherWorkspaceId))).toBe(true)
      expect(await otherWorkspace.getDefinition(ids.definition)).toEqual(
        definition(otherWorkspaceId)
      )
      expect(await otherWorkspace.insertVersion(version())).toBe(true)
      expect(await otherWorkspace.getVersion(ids.version)).toEqual(version())

      const otherVersion = version('tlv_01JABCDEF0123456789ABCDEFH', '1.1.0')
      const competingVersion = version('tlv_01JABCDEF0123456789ABCDEFA', '1.1.0')
      const inserted = await Promise.all([
        first.insertVersion(otherVersion),
        second.insertVersion(competingVersion),
      ])
      expect(inserted.filter(Boolean)).toHaveLength(1)
      expect(inserted.filter((value) => !value)).toHaveLength(1)
      expect(await otherWorkspace.getVersion(otherVersion.toolVersionId)).toBeUndefined()
      expect(await otherWorkspace.listVersions(ids.definition)).toEqual([version()])

      const expectedVersion = inserted[0] ? otherVersion : competingVersion
      const missingVersion = inserted[0] ? competingVersion : otherVersion
      expect(await first.getVersion(expectedVersion.toolVersionId)).toEqual(expectedVersion)
      expect(await first.getVersion(missingVersion.toolVersionId)).toBeUndefined()
      expect(await first.insertVersion(expectedVersion)).toBe(false)

      await firstConnection.close()
      await secondConnection.close()
      const reopened = await openIndependentConnection()
      try {
        const persisted = new PostgresToolRegistryRepository(reopened.database, workspaceId)
        expect(await persisted.listDefinitions()).toEqual([definition()])
        expect(await persisted.listVersions(ids.definition)).toEqual([expectedVersion])
      } finally {
        await reopened.close()
      }
    } finally {
      await firstConnection.close()
      await secondConnection.close()
    }
  })

  test('call idempotency insert and compare-and-set serialize across independent database connections', async () => {
    const firstConnection = await openIndependentConnection()
    const secondConnection = await openIndependentConnection()
    try {
      const first = new PostgresToolCallRepository(firstConnection.database, workspaceId)
      const second = new PostgresToolCallRepository(secondConnection.database, workspaceId)
      const otherWorkspace = new PostgresToolCallRepository(
        firstConnection.database,
        otherWorkspaceId
      )
      const competing = call({ toolCallId: ids.otherCall })
      const inserted = await Promise.all([first.insert(call()), second.insert(competing)])
      expect(inserted.filter(Boolean)).toHaveLength(1)
      expect(inserted.filter((value) => !value)).toHaveLength(1)
      const winnerId = inserted[0] ? ids.call : ids.otherCall
      const winner = await first.getByIdempotencyKey(workspaceId, 'tool-effect-pg-0001')
      expect(await first.insert(winner)).toBe(false)
      expect(winner?.toolCallId).toBe(winnerId)
      expect(await second.get(winnerId)).toEqual(winner)
      expect(await second.get(inserted[0] ? ids.otherCall : ids.call)).toBeUndefined()
      expect(await second.listByExecution(ids.execution)).toEqual([winner])

      expect(await otherWorkspace.get(winnerId)).toBeUndefined()
      expect(await otherWorkspace.listByExecution(ids.execution)).toEqual([])
      await expect(
        otherWorkspace.getByIdempotencyKey(workspaceId, 'tool-effect-pg-0001')
      ).rejects.toThrow('POSTGRES_TOOL_SCOPE_MISMATCH')
      expect(await otherWorkspace.insert(call({ workspaceId: otherWorkspaceId }))).toBe(true)
      expect(
        await otherWorkspace.getByIdempotencyKey(otherWorkspaceId, 'tool-effect-pg-0001')
      ).toMatchObject({ workspaceId: otherWorkspaceId, toolCallId: ids.call })

      const authorized = {
        ...winner,
        status: 'authorized',
        revision: 2,
        authorizedAt: requestedAt,
        history: [...winner.history, { status: 'authorized', at: requestedAt }],
      }
      expect(await first.compareAndSet(0, authorized)).toBe(false)
      expect(await first.compareAndSet(1, { ...authorized, attemptId: ids.otherAttempt })).toBe(
        false
      )
      expect(await first.compareAndSet(1, { ...authorized, principalRef: 'service:other' })).toBe(
        false
      )
      expect(await first.compareAndSet(1, { ...authorized, executionId: ids.otherExecution })).toBe(
        false
      )
      expect(
        await first.compareAndSet(1, {
          ...authorized,
          toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFE',
        })
      ).toBe(false)
      await expect(
        first.compareAndSet(1, { ...authorized, workspaceId: otherWorkspaceId })
      ).rejects.toThrow('POSTGRES_TOOL_SCOPE_MISMATCH')
      const transitions = await Promise.all([
        first.compareAndSet(1, authorized),
        second.compareAndSet(1, authorized),
      ])
      expect(transitions.filter(Boolean)).toHaveLength(1)
      expect(transitions.filter((value) => !value)).toHaveLength(1)
      expect(await first.compareAndSet(1, { ...authorized, revision: 3 })).toBe(false)
      expect(await first.get(winnerId)).toEqual(authorized)

      await firstConnection.close()
      await secondConnection.close()
      const reopened = await openIndependentConnection()
      try {
        const persisted = new PostgresToolCallRepository(reopened.database, workspaceId)
        expect(await persisted.get(winnerId)).toEqual(authorized)
        expect(await persisted.getByIdempotencyKey(workspaceId, 'tool-effect-pg-0001')).toEqual(
          authorized
        )
      } finally {
        await reopened.close()
      }
    } finally {
      await firstConnection.close()
      await secondConnection.close()
    }
  })

  test('tagged tool-call digest versions are immutable across compare-and-set', async () => {
    const connection = await openIndependentConnection()
    try {
      const repository = new PostgresToolCallRepository(connection.database, workspaceId)
      const tagged = call({
        toolCallId: 'tlc_01JABCDEF0123456789ABCDEFF',
        executionId: ids.taggedExecution,
        idempotencyKey: 'tool-tag-immutability-pg-0001',
        requestDigestVersion: 2,
        inputDigestVersion: 2,
      })
      expect(await repository.insert(tagged)).toBe(true)

      const authorized = {
        ...tagged,
        status: 'authorized',
        revision: 2,
        authorizedAt: requestedAt,
        history: [...tagged.history, { status: 'authorized', at: requestedAt }],
      }
      expect(await repository.compareAndSet(1, authorized)).toBe(true)

      const requestTagDowngrade = { ...authorized }
      delete requestTagDowngrade.requestDigestVersion
      expect(await repository.compareAndSet(2, { ...requestTagDowngrade, revision: 3 })).toBe(false)
      const inputTagDowngrade = { ...authorized }
      delete inputTagDowngrade.inputDigestVersion
      expect(await repository.compareAndSet(2, { ...inputTagDowngrade, revision: 3 })).toBe(false)

      await expect(
        repository.compareAndSet(2, {
          ...authorized,
          revision: 3,
          inputDigestVersion: 3,
        })
      ).rejects.toThrow()
      expect(await repository.get(tagged.toolCallId)).toEqual(authorized)
    } finally {
      await connection.close()
    }
  })

  test('coexisting tagged and Swedish legacy tool receipts replay after PostgreSQL reconnect without repeating effects', async () => {
    // Qualify the actual reader against fixed bytes before exercising persistence.
    // This is independent of the production matcher and its runtime allowlist.
    const collator = new Intl.Collator('sv-SE')
    const serialize = (value) => {
      if (Array.isArray(value)) return '[' + value.map(serialize).join(',') + ']'
      if (value !== null && typeof value === 'object')
        return (
          '{' +
          Object.keys(value)
            .toSorted(collator.compare)
            .map((key) => JSON.stringify(key) + ':' + serialize(value[key]))
            .join(',') +
          '}'
        )
      return JSON.stringify(value)
    }
    for (const bytes of [
      historicalSwedishToolReceipt.inputBytes,
      historicalSwedishToolReceipt.requestBytes,
    ]) {
      expect(serialize(JSON.parse(bytes))).toBe(bytes)
    }
    let connection = await openIndependentConnection()
    const registryRepository = new PostgresToolRegistryRepository(connection.database, workspaceId)
    expect(
      await registryRepository.insertDefinition(definition(workspaceId, ids.historicalDefinition))
    ).toBe(true)
    const registry = new ToolRegistry(registryRepository)
    const draft = version(ids.historicalVersion, '1.0.0', ids.historicalDefinition)
    draft.inputSchema = { type: 'object', additionalProperties: true }
    delete draft.revision
    delete draft.lifecycle
    delete draft.contentDigest
    const published = await registry.publishVersion(draft)
    expect(await registry.readVersion(ids.historicalVersion, workspaceId)).toEqual(published)

    const input = { ä: 'a-diaeresis', å: 'a-ring', z: 'zee' }
    const historicalRequest = executionRequest({
      toolCallId: ids.historicalCall,
      idempotencyKey: 'tool-effect-0001',
      toolDefinitionId: ids.historicalDefinition,
      toolVersionId: ids.historicalVersion,
      input,
    })
    const taggedRequest = executionRequest({
      toolCallId: ids.taggedHistoricalCall,
      idempotencyKey: 'tool-effect-pg-tagged-v2-0001',
      toolDefinitionId: ids.historicalDefinition,
      toolVersionId: ids.historicalVersion,
      input,
    })
    expect(digestReceiptBytes(historicalSwedishToolReceipt.inputBytes)).toBe(
      historicalSwedishToolReceipt.inputDigest
    )
    expect(digestReceiptBytes(historicalSwedishToolReceipt.requestBytes)).toBe(
      historicalSwedishToolReceipt.requestDigest
    )

    const initialExecutor = new FakeToolExecutor(() => ({ saved: true }))
    try {
      const historicalCompleted = await service(connection.database, initialExecutor).execute(
        historicalRequest
      )
      const taggedCompleted = await service(connection.database, initialExecutor).execute(
        taggedRequest
      )
      expect(historicalCompleted.call).toMatchObject({
        status: 'succeeded',
        requestDigestVersion: 2,
        inputDigestVersion: 2,
      })
      expect(taggedCompleted.call).toMatchObject({
        status: 'succeeded',
        requestDigestVersion: 2,
        inputDigestVersion: 2,
      })
      expect(initialExecutor.requests).toHaveLength(2)

      const historicalCall = { ...historicalCompleted.call }
      historicalCall.requestDigest = historicalSwedishToolReceipt.requestDigest
      historicalCall.inputDigest = historicalSwedishToolReceipt.inputDigest
      delete historicalCall.requestDigestVersion
      delete historicalCall.inputDigestVersion
      await connection.database.execute(sql`
        update tool_calls
        set call = ${JSON.stringify(historicalCall)}::jsonb
        where workspace_id = ${workspaceId} and tool_call_id = ${ids.historicalCall}
      `)
      const calls = new PostgresToolCallRepository(connection.database, workspaceId)
      expect(await calls.get(ids.historicalCall)).toEqual(historicalCall)
      expect(await calls.get(ids.taggedHistoricalCall)).toMatchObject({
        requestDigestVersion: 2,
        inputDigestVersion: 2,
      })
    } finally {
      await connection.close()
    }

    connection = await openIndependentConnection()
    try {
      const persistedRepository = new PostgresToolCallRepository(connection.database, workspaceId)
      const persistedHistorical = await persistedRepository.get(ids.historicalCall)
      const persistedTagged = await persistedRepository.get(ids.taggedHistoricalCall)
      expect(persistedHistorical).toBeDefined()
      expect(persistedHistorical.requestDigest).toBe(historicalSwedishToolReceipt.requestDigest)
      expect(persistedHistorical.inputDigest).toBe(historicalSwedishToolReceipt.inputDigest)
      expect(persistedHistorical.requestDigestVersion).toBeUndefined()
      expect(persistedHistorical.inputDigestVersion).toBeUndefined()
      expect(persistedTagged).toMatchObject({
        requestDigestVersion: 2,
        inputDigestVersion: 2,
      })

      const replayExecutor = new FakeToolExecutor(() => ({ saved: false }))
      await withDefaultLocaleCompare('en-US', async () => {
        expect(toolInputDigest(input)).not.toBe(historicalSwedishToolReceipt.inputDigest)
        expect(toolRequestDigestLegacy(historicalRequest)).not.toBe(
          historicalSwedishToolReceipt.requestDigest
        )

        const legacyReplay = await service(connection.database, replayExecutor).execute(
          historicalRequest
        )
        expect(legacyReplay).toMatchObject({
          state: 'succeeded',
          call: {
            status: 'succeeded',
            requestDigest: historicalSwedishToolReceipt.requestDigest,
            inputDigest: historicalSwedishToolReceipt.inputDigest,
          },
        })
        expect(legacyReplay.call.requestDigestVersion).toBeUndefined()
        expect(legacyReplay.call.inputDigestVersion).toBeUndefined()

        const taggedReplay = await service(connection.database, replayExecutor).execute(
          taggedRequest
        )
        expect(taggedReplay).toMatchObject({
          state: 'succeeded',
          call: {
            requestDigestVersion: 2,
            inputDigestVersion: 2,
          },
        })
        await expect(
          service(connection.database, replayExecutor).execute({
            ...historicalRequest,
            input: { ...input, z: 'changed' },
          })
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
        await expect(
          service(connection.database, replayExecutor).execute({
            ...taggedRequest,
            input: { ...input, z: 'changed' },
          })
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
      })
      expect(replayExecutor.requests).toHaveLength(0)
    } finally {
      await connection.close()
    }
  })

  test('tool-call revisions above PostgreSQL int32 range persist and advance through CAS', async () => {
    const connection = await openIndependentConnection()
    try {
      const repository = new PostgresToolCallRepository(connection.database, workspaceId)
      const maxInt32PlusOne = 2_147_483_648
      const initial = call({
        toolCallId: 'tlc_01JABCDEF0123456789ABCDEFD',
        idempotencyKey: 'tool-revision-boundary-pg',
        revision: maxInt32PlusOne,
      })

      expect(await repository.insert(initial)).toBe(true)
      expect(await repository.get(initial.toolCallId)).toEqual(initial)

      const next = {
        ...initial,
        status: 'authorized',
        revision: maxInt32PlusOne + 1,
        authorizedAt: requestedAt,
        history: [...initial.history, { status: 'authorized', at: requestedAt }],
      }
      expect(await repository.compareAndSet(maxInt32PlusOne, next)).toBe(true)
      expect(await repository.get(initial.toolCallId)).toEqual(next)
    } finally {
      await connection.close()
    }
  })

  test('policy-controlled tool effects preserve completed and ambiguous receipts across independent restarts', async () => {
    const firstConnection = await openIndependentConnection()
    const versionedRegistry = new PostgresToolRegistryRepository(
      firstConnection.database,
      workspaceId
    )
    expect(
      await versionedRegistry.insertDefinition(definition(workspaceId, ids.serviceDefinition))
    ).toBe(true)
    // Gateway effects require a genuinely published version, including its content digest.
    const draft = version(ids.serviceVersion, '1.0.0', ids.serviceDefinition)
    delete draft.revision
    delete draft.lifecycle
    delete draft.contentDigest
    const registry = new ToolRegistry(versionedRegistry)
    const published = await registry.publishVersion(draft)
    expect(await registry.readVersion(ids.serviceVersion, workspaceId)).toEqual(published)

    const started = deferred()
    const release = deferred()
    const firstExecutor = new FakeToolExecutor(async () => {
      started.resolve()
      return release.promise
    })
    const request = executionRequest({
      toolCallId: ids.serviceCall,
      toolDefinitionId: ids.serviceDefinition,
      toolVersionId: ids.serviceVersion,
    })
    const firstExecution = service(firstConnection.database, firstExecutor).execute(request)
    try {
      await started.promise
      const concurrentConnection = await openIndependentConnection()
      try {
        const concurrentExecutor = new FakeToolExecutor(() => ({ saved: false }))
        const concurrent = await service(concurrentConnection.database, concurrentExecutor).execute(
          request
        )
        expect(concurrent).toMatchObject({ state: 'in_progress', call: { status: 'executing' } })
        expect(concurrentExecutor.requests).toHaveLength(0)
      } finally {
        await concurrentConnection.close()
      }

      release.resolve({ saved: true })
      const completed = await firstExecution
      expect(completed).toMatchObject({
        state: 'succeeded',
        call: { status: 'succeeded', result: { output: { saved: true } } },
      })
      expect(firstExecutor.requests).toHaveLength(1)

      const pendingRequest = executionRequest({
        toolCallId: ids.pendingCall,
        idempotencyKey: 'tool-effect-pending-pg',
        requestId: ids.pendingRequest,
        executionId: ids.otherExecution,
        attemptId: ids.otherAttempt,
        toolDefinitionId: ids.serviceDefinition,
        toolVersionId: ids.serviceVersion,
      })
      expect(
        await new PostgresToolCallRepository(firstConnection.database, workspaceId).insert(
          call({
            toolCallId: pendingRequest.toolCallId,
            requestDigest: durableRequestDigest(pendingRequest),
            executionId: pendingRequest.executionId,
            attemptId: pendingRequest.attemptId,
            toolDefinitionId: pendingRequest.toolDefinitionId,
            toolVersionId: pendingRequest.toolVersionId,
            inputDigest: jsonDigest(pendingRequest.input),
            policySnapshotRef: pendingRequest.policySnapshotRef,
            idempotencyKey: pendingRequest.idempotencyKey,
            status: 'executing',
            revision: 2,
            startedAt: requestedAt,
            history: [
              { status: 'requested', at: requestedAt },
              { status: 'authorized', at: requestedAt },
              { status: 'executing', at: requestedAt },
            ],
          })
        )
      ).toBe(true)
      await firstConnection.close()

      const reopened = await openIndependentConnection()
      try {
        const pendingExecutor = new FakeToolExecutor(() => ({ saved: false }))
        expect(
          await service(reopened.database, pendingExecutor).execute(pendingRequest)
        ).toMatchObject({ state: 'in_progress', call: { status: 'executing' } })
        expect(pendingExecutor.requests).toHaveLength(0)

        const replayExecutor = new FakeToolExecutor(() => ({ saved: false }))
        expect(await service(reopened.database, replayExecutor).execute(request)).toEqual(completed)
        expect(replayExecutor.requests).toHaveLength(0)

        const uncertainRequest = executionRequest({
          toolCallId: ids.ambiguousCall,
          idempotencyKey: 'tool-effect-ambiguous-pg',
          requestId: ids.otherRequest,
          toolDefinitionId: ids.serviceDefinition,
          toolVersionId: ids.serviceVersion,
        })
        const uncertainExecutor = new FakeToolExecutor(async () => {
          throw new ToolExecutorError('PROVIDER_OUTCOME_UNKNOWN', false, 'unknown')
        })
        const uncertain = await service(reopened.database, uncertainExecutor).execute(
          uncertainRequest
        )
        expect(uncertain).toMatchObject({
          state: 'reconciliation_required',
          call: { status: 'reconciliation_required' },
        })
        expect(uncertainExecutor.requests).toHaveLength(1)
        await reopened.close()

        const finalConnection = await openIndependentConnection()
        try {
          const ambiguousReplayExecutor = new FakeToolExecutor(() => ({ saved: false }))
          expect(
            await service(finalConnection.database, ambiguousReplayExecutor).execute(
              uncertainRequest
            )
          ).toEqual(uncertain)
          expect(ambiguousReplayExecutor.requests).toHaveLength(0)
        } finally {
          await finalConnection.close()
        }
      } finally {
        await reopened.close()
      }
    } finally {
      release.resolve({ saved: false })
      await firstConnection.close()
    }
  })

  test('repositories fail closed when a persisted definition, version, or call no longer matches its schema', async () => {
    const connection = await openIndependentConnection()
    try {
      const registry = new PostgresToolRegistryRepository(connection.database, workspaceId)
      const calls = new PostgresToolCallRepository(connection.database, workspaceId)
      expect(await registry.insertDefinition(definition(workspaceId, ids.corruptDefinition))).toBe(
        true
      )
      expect(
        await registry.insertVersion(version(ids.corruptVersion, '1.0.0', ids.corruptDefinition))
      ).toBe(true)
      expect(
        await calls.insert(
          call({
            toolCallId: ids.corruptCall,
            toolDefinitionId: ids.corruptDefinition,
            toolVersionId: ids.corruptVersion,
            idempotencyKey: 'tool-corrupt-pg-0001',
          })
        )
      ).toBe(true)

      await isolated.application.execute(sql`
        update tool_definitions
        set definition = jsonb_set(definition, '{displayName}', '""'::jsonb)
        where workspace_id = ${workspaceId} and tool_definition_id = ${ids.corruptDefinition}
      `)
      await expect(registry.getDefinition(ids.corruptDefinition)).rejects.toThrow(
        'POSTGRES_TOOL_DEFINITION_CORRUPT'
      )

      await isolated.application.execute(sql`
        update tool_versions
        set version = jsonb_set(version, '{lifecycle}', '"invalid"'::jsonb)
        where workspace_id = ${workspaceId} and tool_version_id = ${ids.corruptVersion}
      `)
      await expect(registry.getVersion(ids.corruptVersion)).rejects.toThrow(
        'POSTGRES_TOOL_VERSION_CORRUPT'
      )

      await isolated.application.execute(sql`
        update tool_calls
        set call = jsonb_set(call, '{status}', '"invalid"'::jsonb)
        where workspace_id = ${workspaceId} and tool_call_id = ${ids.corruptCall}
      `)
      await expect(calls.get(ids.corruptCall)).rejects.toThrow('POSTGRES_TOOL_CALL_CORRUPT')
      await expect(calls.getByIdempotencyKey(workspaceId, 'tool-corrupt-pg-0001')).rejects.toThrow(
        'POSTGRES_TOOL_CALL_CORRUPT'
      )
    } finally {
      await connection.close()
    }
  })
})
