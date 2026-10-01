import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  FakeToolExecutor,
  InMemoryToolRegistryRepository,
  InMemoryToolRateLimiter,
  InteractionToolApprovalCoordinator,
  PolicyControlledToolExecutionService,
  StaticToolPolicyAuthorizer,
  ToolGateway,
  ToolRegistry,
} from '@control-plane/tool-execution'
import { InMemoryInteractionRepository, InteractionService } from '@control-plane/domain'
import { ToolExecutorError } from '@control-plane/tool-sdk'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteToolCallRepository, SqliteToolRegistryRepository } from './tool-repositories.ts'

const ids = {
  workspace: 'wsp_01JABCDEF0123456789ABCDEFG',
  otherWorkspace: 'wsp_01JABCDEF0123456789ABCDEFH',
  profile: 'prf_01JABCDEF0123456789ABCDEFG',
  execution: 'exe_01JABCDEF0123456789ABCDEFG',
  otherExecution: 'exe_01JABCDEF0123456789ABCDEFH',
  attempt: 'att_01JABCDEF0123456789ABCDEFG',
  otherAttempt: 'att_01JABCDEF0123456789ABCDEFH',
  request: 'req_01JABCDEF0123456789ABCDEFG',
  trace: 'trc_01JABCDEF0123456789ABCDEFG',
  definition: 'tld_01JABCDEF0123456789ABCDEFG',
  otherDefinition: 'tld_01JABCDEF0123456789ABCDEFH',
  version: 'tlv_01JABCDEF0123456789ABCDEFG',
  otherVersion: 'tlv_01JABCDEF0123456789ABCDEFH',
  call: 'tlc_01JABCDEF0123456789ABCDEFG',
  otherCall: 'tlc_01JABCDEF0123456789ABCDEFH',
}

const requestedAt = '2026-08-25T09:00:00.000Z'

function definition(workspaceId = ids.workspace, toolDefinitionId = ids.definition) {
  return {
    toolDefinitionId,
    name: 'records.write',
    displayName: 'Write record',
    description: 'Writes one scoped record.',
    ownership: { scope: 'workspace', workspaceId },
    createdAt: '2026-08-25T08:00:00.000Z',
  }
}

function versionDraft(toolVersionId = ids.version, semanticVersion = '1.0.0') {
  return {
    toolVersionId,
    toolDefinitionId: ids.definition,
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
    createdAt: '2026-08-25T08:01:00.000Z',
    publishedAt: '2026-08-25T08:02:00.000Z',
  }
}

function executionRequest(overrides = {}) {
  const grant = {
    workspaceId: ids.workspace,
    profileId: ids.profile,
    toolDefinitionId: ids.definition,
    toolVersionId: ids.version,
    operations: ['write'],
  }
  return {
    toolCallId: ids.call,
    idempotencyKey: 'tool-effect-0001',
    requestedAt,
    policySnapshotRef: 'policy://workspace/v7',
    requestId: ids.request,
    executionId: ids.execution,
    attemptId: ids.attempt,
    workspaceId: ids.workspace,
    profileId: ids.profile,
    toolDefinitionId: ids.definition,
    toolVersionId: ids.version,
    operation: 'write',
    input: { value: 'durable' },
    grant,
    audit: { principalRef: 'service:runtime-worker', traceId: ids.trace },
    ...overrides,
  }
}

function call(overrides = {}) {
  return {
    toolCallId: ids.call,
    requestDigest: `sha256:${'a'.repeat(64)}`,
    executionId: ids.execution,
    attemptId: ids.attempt,
    workspaceId: ids.workspace,
    profileId: ids.profile,
    principalRef: 'service:runtime-worker',
    toolDefinitionId: ids.definition,
    toolVersionId: ids.version,
    operation: 'write',
    inputDigest: `sha256:${'b'.repeat(64)}`,
    policySnapshotRef: 'policy://workspace/v7',
    executor: { type: 'connector', reference: 'records-v1' },
    idempotencyKey: 'tool-effect-0001',
    status: 'requested',
    revision: 1,
    requestedAt,
    history: [{ status: 'requested', at: requestedAt }],
    ...overrides,
  }
}

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-tool-storage-'))
  const path = join(directory, 'state.sqlite')
  let current = new SqlitePersistenceProvider({ path })
  try {
    await current.migrate()
    await run({
      path,
      provider: () => current,
      reopen: async () => {
        current.close()
        current = new SqlitePersistenceProvider({ path })
        await current.migrate()
        return current
      },
    })
  } finally {
    current.close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function competingInsertWorker({ path, workspaceId, repositoryKind }) {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads')
      ;(async () => {
        const { SqlitePersistenceProvider } = await import(workerData.providerUrl)
        const repositories = await import(workerData.repositoriesUrl)
        const provider = new SqlitePersistenceProvider({ path: workerData.path })
        try {
          await provider.migrate()
          const repository = workerData.repositoryKind === 'calls'
            ? new repositories.SqliteToolCallRepository(provider, workerData.workspaceId)
            : new repositories.SqliteToolRegistryRepository(provider, workerData.workspaceId)
          parentPort.postMessage({ state: 'ready' })
          parentPort.once('message', async ({ value }) => {
            try {
              const inserted = workerData.repositoryKind === 'calls'
                ? await repository.insert(value)
                : await repository.insertVersion(value)
              parentPort.postMessage({ state: 'complete', inserted })
            } catch (error) {
              parentPort.postMessage({ state: 'failure', message: String(error?.message ?? error) })
            } finally {
              provider.close()
            }
          })
        } catch (error) {
          provider.close()
          parentPort.postMessage({ state: 'failure', message: String(error?.message ?? error) })
        }
      })()
    `,
    {
      eval: true,
      workerData: {
        path,
        workspaceId,
        repositoryKind,
        providerUrl: new URL('./provider.ts', import.meta.url).href,
        repositoriesUrl: new URL('./tool-repositories.ts', import.meta.url).href,
      },
    }
  )
  try {
    await waitForWorkerState(worker, 'ready')
  } catch (error) {
    await worker.terminate()
    throw error
  }
  return {
    async insert(value) {
      const result = waitForWorkerState(worker, 'complete')
      // Node worker_threads accepts a transfer list, not a browser targetOrigin.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage({ value })
      return (await result).inserted
    },
    close: () => worker.terminate(),
  }
}

function waitForWorkerState(worker, expectedState) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }
    const onMessage = (message) => {
      if (message.state === 'failure') {
        cleanup()
        reject(new Error(message.message))
      } else if (message.state === expectedState) {
        cleanup()
        resolve(message)
      }
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`SQLite worker exited before ${expectedState}: ${code}`))
    }
    worker.on('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
  })
}

async function seedRegistry(provider) {
  const registry = new ToolRegistry(new SqliteToolRegistryRepository(provider, ids.workspace))
  await registry.createDefinition(definition())
  await registry.publishVersion(versionDraft())
}

async function publishedVersion(toolVersionId, semanticVersion) {
  const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
  await registry.createDefinition(definition())
  return registry.publishVersion(versionDraft(toolVersionId, semanticVersion))
}

function service(provider, executor) {
  const registry = new ToolRegistry(new SqliteToolRegistryRepository(provider, ids.workspace))
  const gateway = new ToolGateway(registry)
  gateway.registerExecutor('connector', 'records-v1', executor)
  const interactions = new InMemoryInteractionRepository()
  return new PolicyControlledToolExecutionService({
    gateway,
    calls: new SqliteToolCallRepository(provider, ids.workspace),
    authorizer: new StaticToolPolicyAuthorizer({
      effect: 'allow',
      decisionId: 'policy-decision-0001',
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

describe('SQLite tool repositories', () => {
  test('registry definitions and versions are validated, immutable, unique, workspace-scoped, and durable', async () => {
    await withDatabase(async ({ path, provider, reopen }) => {
      const persistence = provider()
      const workspaceA = new SqliteToolRegistryRepository(persistence, ids.workspace)
      const workspaceB = new SqliteToolRegistryRepository(persistence, ids.otherWorkspace)
      expect(() => new SqliteToolRegistryRepository(persistence, 'not-a-workspace-id')).toThrow()

      expect(await workspaceA.insertDefinition(definition())).toBe(true)
      expect(
        await workspaceA.insertDefinition({ ...definition(), displayName: 'Altered definition' })
      ).toBe(false)
      await expect(workspaceA.insertDefinition(definition(ids.otherWorkspace))).rejects.toThrow()
      expect(await workspaceB.getDefinition(ids.definition)).toBeUndefined()
      expect(await workspaceB.listDefinitions()).toEqual([])
      expect(await workspaceB.getVersion(ids.version)).toBeUndefined()
      expect(await workspaceB.listVersions(ids.definition)).toEqual([])

      const first = await new ToolRegistry(workspaceA).publishVersion(versionDraft())
      expect(await workspaceA.insertVersion(first)).toBe(false)
      expect(
        await workspaceA.insertVersion({
          ...first,
          semanticVersion: '2.0.0',
          contentDigest: `sha256:${'c'.repeat(64)}`,
        })
      ).toBe(false)
      expect(await workspaceA.getVersion(ids.version)).toEqual(first)

      const competingVersion = await publishedVersion(ids.otherVersion, '1.1.0')
      const localVersion = await publishedVersion('tlv_01JABCDEF0123456789ABCDEFA', '1.1.0')
      const worker = await competingInsertWorker({
        path,
        workspaceId: ids.workspace,
        repositoryKind: 'versions',
      })
      try {
        const raced = await Promise.all([
          workspaceA.insertVersion(localVersion),
          worker.insert(competingVersion),
        ])
        expect(raced.filter(Boolean)).toHaveLength(1)
        expect(raced.filter((inserted) => !inserted)).toHaveLength(1)
        const accepted = raced[0] ? localVersion : competingVersion
        const rejected = raced[0] ? competingVersion : localVersion
        expect(await workspaceA.getVersion(accepted.toolVersionId)).toEqual(accepted)
        expect(await workspaceA.getVersion(rejected.toolVersionId)).toBeUndefined()
      } finally {
        await worker.close()
      }

      const workspaceBRegistry = new ToolRegistry(workspaceB)
      await workspaceBRegistry.createDefinition(definition(ids.otherWorkspace))
      const workspaceBVersion = await workspaceBRegistry.publishVersion(
        versionDraft(ids.version, '1.0.0')
      )
      expect(workspaceBVersion.toolVersionId).toBe(ids.version)

      const reopened = await reopen()
      const reopenedA = new SqliteToolRegistryRepository(reopened, ids.workspace)
      const reopenedB = new SqliteToolRegistryRepository(reopened, ids.otherWorkspace)
      expect(await reopenedA.listDefinitions()).toEqual([definition()])
      expect(await reopenedA.listVersions(ids.definition)).toHaveLength(2)
      expect(await reopenedB.listDefinitions()).toEqual([definition(ids.otherWorkspace)])
      expect(await reopenedB.listVersions(ids.definition)).toHaveLength(1)
      expect(await reopenedB.getVersion(ids.version)).toMatchObject({
        toolDefinitionId: ids.definition,
        semanticVersion: '1.0.0',
      })
    })
  })

  test('tool-call uniqueness is atomic across provider connections and idempotency is workspace-scoped', async () => {
    await withDatabase(async ({ path, provider }) => {
      const persistence = provider()
      const first = new SqliteToolCallRepository(persistence, ids.workspace)
      const second = new SqliteToolCallRepository(persistence, ids.workspace)
      const worker = await competingInsertWorker({
        path,
        workspaceId: ids.workspace,
        repositoryKind: 'calls',
      })
      let concurrent
      try {
        concurrent = await Promise.all([
          first.insert(call()),
          worker.insert(call({ toolCallId: ids.otherCall })),
        ])
      } finally {
        await worker.close()
      }
      expect(concurrent.filter(Boolean)).toHaveLength(1)
      expect(concurrent.filter((inserted) => !inserted)).toHaveLength(1)

      expect(await second.insert(call({ toolCallId: 'tlc_01JABCDEF0123456789ABCDEFA' }))).toBe(
        false
      )
      expect(await second.get('tlc_01JABCDEF0123456789ABCDEFA')).toBeUndefined()
      const winner = await second.getByIdempotencyKey(ids.workspace, 'tool-effect-0001')
      expect([ids.call, ids.otherCall]).toContain(winner.toolCallId)
      const storedCandidates = await Promise.all([first.get(ids.call), first.get(ids.otherCall)])
      expect(storedCandidates.filter(Boolean)).toHaveLength(1)
      expect(await second.listByExecution(ids.execution)).toHaveLength(1)

      const workspaceB = new SqliteToolCallRepository(persistence, ids.otherWorkspace)
      expect(await workspaceB.get(winner.toolCallId)).toBeUndefined()
      expect(
        await workspaceB.getByIdempotencyKey(ids.otherWorkspace, 'tool-effect-0001')
      ).toBeUndefined()
      expect(await workspaceB.listByExecution(ids.execution)).toEqual([])
      const sameKeyOtherWorkspace = call({
        workspaceId: ids.otherWorkspace,
      })
      expect(await workspaceB.insert(sameKeyOtherWorkspace)).toBe(true)
      expect(
        await workspaceB.getByIdempotencyKey(ids.otherWorkspace, 'tool-effect-0001')
      ).toMatchObject({ workspaceId: ids.otherWorkspace, toolCallId: ids.call })
      expect(await first.getByIdempotencyKey(ids.workspace, 'tool-effect-0001')).toMatchObject({
        workspaceId: ids.workspace,
        toolCallId: winner.toolCallId,
      })
    })
  })

  test('cross-workspace tool writes and explicit scoped reads fail before opening a transaction', async () => {
    await withDatabase(async ({ provider }) => {
      const persistence = provider()
      let transactions = 0
      const observedProvider = {
        transaction(operation) {
          transactions += 1
          return persistence.transaction(operation)
        },
      }
      const registry = new SqliteToolRegistryRepository(observedProvider, ids.workspace)
      const calls = new SqliteToolCallRepository(observedProvider, ids.workspace)

      await expect(registry.insertDefinition(definition(ids.otherWorkspace))).rejects.toThrow(
        'SQLITE_TOOL_SCOPE_MISMATCH'
      )
      await expect(
        calls.insert(call({ workspaceId: ids.otherWorkspace, toolCallId: ids.otherCall }))
      ).rejects.toThrow('SQLITE_TOOL_SCOPE_MISMATCH')
      await expect(
        calls.getByIdempotencyKey(ids.otherWorkspace, 'tool-effect-0001')
      ).rejects.toThrow('SQLITE_TOOL_SCOPE_MISMATCH')
      expect(transactions).toBe(0)
    })
  })

  test('tool-call compare-and-set rejects stale or changed ownership and attempt fields', async () => {
    await withDatabase(async ({ provider }) => {
      const persistence = provider()
      const first = new SqliteToolCallRepository(persistence, ids.workspace)
      const second = new SqliteToolCallRepository(persistence, ids.workspace)
      const original = call()
      expect(await first.insert(original)).toBe(true)

      const authorized = {
        ...original,
        status: 'authorized',
        revision: 2,
        authorizedAt: requestedAt,
        history: [...original.history, { status: 'authorized', at: requestedAt }],
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
      expect(await first.compareAndSet(1, { ...authorized, toolVersionId: ids.otherVersion })).toBe(
        false
      )
      await expect(
        first.compareAndSet(1, { ...authorized, workspaceId: ids.otherWorkspace })
      ).rejects.toThrow()

      const raced = await Promise.all([
        first.compareAndSet(1, authorized),
        second.compareAndSet(1, authorized),
      ])
      expect(raced.filter(Boolean)).toHaveLength(1)
      expect(raced.filter((updated) => !updated)).toHaveLength(1)
      expect(await first.compareAndSet(1, { ...authorized, revision: 3 })).toBe(false)
      expect(await first.get(ids.call)).toEqual(authorized)
      expect(
        await new SqliteToolCallRepository(persistence, ids.otherWorkspace).get(ids.call)
      ).toBeUndefined()
    })
  })

  test('policy-controlled tool effects retain in-progress and completed receipts across service instances and reopen', async () => {
    await withDatabase(async ({ path, provider, reopen }) => {
      const persistence = provider()
      await seedRegistry(persistence)
      let releaseEffect
      let markStarted
      const started = new Promise((resolve) => {
        markStarted = resolve
      })
      const pendingEffect = new Promise((resolve) => {
        releaseEffect = resolve
      })
      const firstExecutor = new FakeToolExecutor(async () => {
        markStarted()
        return pendingEffect
      })
      const firstService = service(persistence, firstExecutor)
      const request = executionRequest()
      const firstExecution = firstService.execute(request)
      await started
      expect(
        await new SqliteToolCallRepository(persistence, ids.workspace).getByIdempotencyKey(
          ids.workspace,
          request.idempotencyKey
        )
      ).toMatchObject({ status: 'executing', attemptId: ids.attempt })

      const concurrentProvider = new SqlitePersistenceProvider({ path })
      try {
        await concurrentProvider.migrate()
        const concurrentExecutor = new FakeToolExecutor(() => ({ saved: false }))
        const concurrentReplay = await service(concurrentProvider, concurrentExecutor).execute(
          request
        )
        expect(concurrentReplay).toMatchObject({
          state: 'in_progress',
          call: { status: 'executing' },
        })
        expect(concurrentExecutor.requests).toHaveLength(0)
      } finally {
        concurrentProvider.close()
      }

      releaseEffect({ saved: true })
      const completed = await firstExecution
      expect(completed).toMatchObject({
        state: 'succeeded',
        call: { status: 'succeeded', result: { output: { saved: true } } },
      })
      expect(firstExecutor.requests).toHaveLength(1)

      const reopened = await reopen()
      const afterRestartExecutor = new FakeToolExecutor(() => ({ saved: false }))
      const replay = await service(reopened, afterRestartExecutor).execute(request)
      expect(replay).toEqual(completed)
      expect(afterRestartExecutor.requests).toHaveLength(0)
      expect(
        await new SqliteToolCallRepository(reopened, ids.workspace).listByExecution(ids.execution)
      ).toEqual([completed.call])
    })
  })

  test('ambiguous external effects remain reconciliation-required after reopen and are not retried', async () => {
    await withDatabase(async ({ provider, reopen }) => {
      const persistence = provider()
      await seedRegistry(persistence)
      const uncertainExecutor = new FakeToolExecutor(async () => {
        throw new ToolExecutorError('PROVIDER_OUTCOME_UNKNOWN', false, 'unknown')
      })
      const request = executionRequest({
        toolCallId: ids.otherCall,
        idempotencyKey: 'tool-effect-ambiguous',
        requestId: 'req_01JABCDEF0123456789ABCDEFH',
      })
      const outcome = await service(persistence, uncertainExecutor).execute(request)
      expect(outcome).toMatchObject({
        state: 'reconciliation_required',
        call: { status: 'reconciliation_required' },
      })
      expect(uncertainExecutor.requests).toHaveLength(1)

      const reopened = await reopen()
      const replayExecutor = new FakeToolExecutor(() => ({ saved: true }))
      const replay = await service(reopened, replayExecutor).execute(request)
      expect(replay).toEqual(outcome)
      expect(replayExecutor.requests).toHaveLength(0)
    })
  })
})
