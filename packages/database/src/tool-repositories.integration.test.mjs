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
} from '@control-plane/tool-execution'
import { InMemoryInteractionRepository, InteractionService } from '@control-plane/domain'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { ToolExecutorError } from '@control-plane/tool-sdk'
import { sql } from 'drizzle-orm'
import { createIsolatedTestDatabase } from './testing.ts'
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
  pendingRequest: 'req_01JABCDEF0123456789ABCDEFC',
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
  }, 60_000)

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

  test('policy-controlled tool effects preserve completed and ambiguous receipts across independent restarts', async () => {
    const firstConnection = await openIndependentConnection()
    const versionedRegistry = new PostgresToolRegistryRepository(
      firstConnection.database,
      workspaceId
    )
    expect(
      await versionedRegistry.insertDefinition(definition(workspaceId, ids.serviceDefinition))
    ).toBe(true)
    expect(
      await versionedRegistry.insertVersion(
        version(ids.serviceVersion, '1.0.0', ids.serviceDefinition)
      )
    ).toBe(true)

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
