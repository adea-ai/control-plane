import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { CompactionEntry, createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createNodePiDurableRuntime } from './composition.ts'
import {
  ExecutionAttemptSchema,
  ExecutionLifecycleService,
  ExecutionSchema,
  previewLifecycleTransition,
} from '@control-plane/domain'
import { deriveExecutionPlan, ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import {
  SqliteContextPackageRepository,
  SqliteDelegationRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
  SqliteDurableUsageStore,
} from '@control-plane/sqlite-persistence'

const digest = (character) => 'sha256:' + character.repeat(64)
const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  parentAttemptId: 'att_01JABCDEF0123456789ABCDEFG',
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  actor: 'usr_01JABCDEF0123456789ABCDEFG',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
}
const acceptedAt = '2026-10-09T12:00:00.000Z'

async function fixture({
  parentBudget = { maximumMicrounits: 20_000_000, maximumTokens: 500_000 },
  maximumTotal = 2,
  maximumParallel = 1,
  maximumDepth = 1,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-compaction-child-admission-'))
  const databasePath = join(directory, 'control-plane.sqlite')
  const runtimeDirectory = join(directory, 'pi-durable')
  await mkdir(runtimeDirectory, { recursive: true })
  const provider = new SqlitePersistenceProvider({ path: databasePath })
  await provider.migrate()

  const parentInput = createExecutionPlanTestFixtureInputs()
  parentInput.profile.definition.skills = []
  parentInput.profile.definition.capabilityRequirements = []
  parentInput.skills = []
  parentInput.correlation.workspaceId = ids.workspaceId
  parentInput.correlation.taskId = 'tsk_01JABCDEF0123456789ABCDEFG'
  parentInput.correlation.requestId = 'req_01JABCDEF0123456789ABCDEFG'
  parentInput.constraints.limits.childExecutions.maximumTotal = maximumTotal
  parentInput.constraints.limits.childExecutions.maximumDepth = maximumDepth
  parentInput.constraints.limits.concurrency.maximumParallel = maximumParallel
  const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(parentInput)
  const parentContext = parentInput.contextPackage
  const contexts = new SqliteContextPackageRepository(provider)
  const plans = new SqliteExecutionPlanRepository(provider)
  await contexts.put(parentContext)
  await plans.put(parentPlan)

  const executions = new SqliteExecutionRepository(provider)
  const lifecycle = new ExecutionLifecycleService(executions)
  await executions.insertExecution(
    ExecutionSchema.parse({
      executionId: ids.parentExecutionId,
      state: 'accepted',
      version: 1,
      correlation: parentPlan.correlation,
      executionPlan: {
        executionPlanId: parentPlan.executionPlanId,
        contentDigest: parentPlan.contentDigest,
        schemaVersion: parentPlan.schemaVersion,
      },
      attemptCount: 0,
      acceptedAt,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    })
  )
  await lifecycle.createAttempt({
    executionId: ids.parentExecutionId,
    attemptId: ids.parentAttemptId,
    expectedExecutionVersion: 1,
    queuedAt: '2026-10-09T12:00:01.000Z',
  })
  await lifecycle.transitionExecution({
    executionId: ids.parentExecutionId,
    expectedVersion: 2,
    to: 'queued',
    transitionedAt: '2026-10-09T12:00:02.000Z',
  })
  await lifecycle.transitionExecution({
    executionId: ids.parentExecutionId,
    expectedVersion: 3,
    to: 'running',
    transitionedAt: '2026-10-09T12:00:03.000Z',
  })
  await lifecycle.transitionAttempt({
    attemptId: ids.parentAttemptId,
    expectedVersion: 1,
    to: 'running',
    transitionedAt: '2026-10-09T12:00:03.000Z',
  })

  const usageStore = new SqliteDurableUsageStore(provider)
  const ledger = new DurableUsageLedger({ store: usageStore, now: () => acceptedAt })
  await ledger.openBudget({
    workspaceId: ids.workspaceId,
    executionId: ids.parentExecutionId,
    currency: 'USD',
    ...parentBudget,
    source: { sourceId: 'root-admission-fixture', idempotencyKey: 'root-budget-open' },
  })

  let nextChild = 0
  async function childAdmission({
    parentExecutionId = ids.parentExecutionId,
    parentAttemptId = ids.parentAttemptId,
    parentExecutionVersion = 4,
    admissionParentPlan = parentPlan,
    admissionParentContext = parentContext,
  } = {}) {
    nextChild += 1
    const suffixes = [
      '01JBBCDEF0123456789ABCDEFG',
      '01JDBCDEF0123456789ABCDEFG',
      '01JEBCDEF0123456789ABCDEFG',
      '01JFBCDEF0123456789ABCDEFG',
    ]
    const suffix = suffixes[nextChild - 1]
    const childExecutionId = 'exe_' + suffix
    const childAttemptId = 'att_' + suffix
    const delegationId = 'dlg_' + suffix
    const childTaskId = 'tsk_' + suffix
    const childRequestId = 'req_' + suffix
    const childContext = admissionParentContext
    await contexts.put(childContext)
    const childPlan = deriveExecutionPlan(admissionParentPlan, {
      correlation: {
        ...admissionParentPlan.correlation,
        taskId: childTaskId,
        requestId: childRequestId,
      },
      contextPackage: childContext,
      constraints: admissionParentPlan.constraints,
      runtimeRequirements: admissionParentPlan.runtimeRequirements,
      outputContract: admissionParentPlan.outputContract,
      compiledAt: acceptedAt,
    })
    await plans.put(childPlan)

    const childExecution = ExecutionSchema.parse({
      executionId: childExecutionId,
      state: 'accepted',
      version: 1,
      correlation: childPlan.correlation,
      executionPlan: {
        executionPlanId: childPlan.executionPlanId,
        contentDigest: childPlan.contentDigest,
        schemaVersion: childPlan.schemaVersion,
      },
      parentExecutionId,
      attemptCount: 0,
      acceptedAt,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    })
    const childAttempt = ExecutionAttemptSchema.parse({
      attemptId: childAttemptId,
      executionId: childExecutionId,
      sequence: 1,
      state: 'queued',
      version: 1,
      acceptedAt,
      queuedAt: acceptedAt,
      runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    })
    const childDispatch = {
      delegationId,
      childAttemptId,
      runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
      dispatchedAt: acceptedAt,
    }
    const childRequestDigest = digest(['c', 'd', 'e', 'f'][nextChild - 1])
    const request = {
      workspaceId: ids.workspaceId,
      parentIntentId: 'intent:pi-compaction-child-admission',
      parentExecutionId,
      parentAttemptId,
      parentExecutionVersion,
      parentPlan: {
        executionPlanId: admissionParentPlan.executionPlanId,
        contentDigest: admissionParentPlan.contentDigest,
        schemaVersion: admissionParentPlan.schemaVersion,
      },
      admittedToolCallId: ids.toolCallId,
      delegationId,
      childRequestId: childPlan.correlation.requestId,
      childExecutionId,
      childAttemptId,
      childDispatch,
      childPlan: {
        executionPlanId: childPlan.executionPlanId,
        contentDigest: childPlan.contentDigest,
        schemaVersion: childPlan.schemaVersion,
      },
      role: 'researcher',
      profileVersionId: admissionParentPlan.profile.profileVersionId,
      originalActorPrincipalId: ids.actor,
      childRequestDigest,
      acceptedAt,
    }
    const delegation = {
      delegationId,
      parentExecutionId,
      parentAttemptId,
      admittedToolCallId: ids.toolCallId,
      childExecutionId,
      parentExecutionPlanId: admissionParentPlan.executionPlanId,
      parentExecutionPlanDigest: admissionParentPlan.contentDigest,
      childExecutionPlanId: childPlan.executionPlanId,
      childExecutionPlanDigest: childPlan.contentDigest,
      contextPackageId: childPlan.contextPackage.contextPackageId,
      contextPackageDigest: childPlan.contextPackage.contentDigest,
      role: 'researcher',
      profileVersionId: admissionParentPlan.profile.profileVersionId,
      objective: 'Run one bounded child task',
      policy: {
        cancellation: 'cascade',
        deadline: 'bounded_by_parent',
        failure: 'manual',
        maximumRetries: 0,
      },
      state: 'requested',
      pendingDispatch: childDispatch,
      retryCount: 0,
      inputDigest: childRequestDigest,
      revision: 1,
      acceptedAt,
      updatedAt: acceptedAt,
    }
    const receipt = {
      schemaVersion: 'pi-child-admission/v1',
      ...request,
      authorityRevision: 1,
      productRevision: 'product:rev-1',
      productReaderPrincipalId: 'svc_product-reader',
      selectionRef: 'selection:child-role',
      selectionRevision: nextChild,
      expiresAt: '2999-01-01T00:00:00.000Z',
    }
    return {
      childExecution: ExecutionSchema.parse({
        ...previewLifecycleTransition(childExecution, {
          to: 'queued',
          transitionedAt: acceptedAt,
        }),
        attemptCount: 1,
        latestAttemptId: childAttemptId,
      }),
      childAttempt,
      request,
      receipt,
      delegation,
      childExecutionId,
      childAttemptId,
      delegationId,
      childPlan,
      childContext,
    }
  }

  return {
    directory,
    databasePath,
    runtimeDirectory,
    provider,
    parentPlan,
    executions,
    usageStore,
    childAdmission,
  }
}

function nativeSessionPath(runtimeDirectory, externalSessionId) {
  // Matches createPiDurableEngine's production mapping: sessions/<sha256(sessionId)>.sqlite.
  const fileDigest = createHash('sha256').update(externalSessionId).digest('hex')
  return join(runtimeDirectory, 'sessions', `${fileDigest}.sqlite`)
}

async function allocate(allocator, child) {
  return allocator.allocate({
    request: child.request,
    receipt: child.receipt,
    execution: child.childExecution,
    attempt: child.childAttempt,
    delegation: child.delegation,
    assertCurrent: async () => undefined,
  })
}

test('native Pi compaction preserves one canonical parent’s child budget, depth, total, and parallel fences across reopen', async () => {
  const f = await fixture()
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage('The parent task is ready.'),
    fauxAssistantMessage('The compacted parent summary preserves the task and its limits.'),
  ])

  let runtime
  let reopenedRuntime
  let piStorage
  let harness
  let reopenedProvider
  let reopenedPiStorage
  let reopenedHarness
  let runtimeOptions
  let handle
  let rootConversationId
  let mappedNativeStorePath
  try {
    const model = models.getModel(faux.provider.id, 'faux-1')
    const selection = { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 }
    runtimeOptions = {
      directory: f.runtimeDirectory,
      now: () => acceptedAt,
      resolveAdmission: async () => ({
        schemaVersion: 'pi-durable-admission/v1',
        prompt: 'The parent task is ready.',
        selection,
        authority: {
          revision: 1,
          principalRef: 'principal:compaction-test',
          scopeRef: 'scope:compaction-test',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
      }),
      assertAuthority: async () => {},
      resolveProvider: async (providerSelection) => ({
        ...providerSelection,
        workspaceId: ids.workspaceId,
        provider: faux.provider.id,
        providerModel: 'faux-1',
        location: 'remote_host',
        harness: 'pi_durable',
        harnessVersion: '1.1.0',
        providerBinding: 'pi_durable_models',
        withModels: async (use) => use(models),
      }),
      authorizeInference: async () => ({
        maxOutputTokens: Math.min(128, model.maxTokens),
        maximumInputTokens: model.contextWindow,
        assertActive: async () => {},
      }),
      settleUsage: async (_authority, _key, usage) => usage,
      reconcileInference: async () => 'unresolved',
      engineFactory: undefined,
    }
    const parentRuntimeRequest = {
      executionId: ids.parentExecutionId,
      attemptId: ids.parentAttemptId,
      idempotencyKey: 'canonical-parent:run',
      executionPlan: f.parentPlan,
      attemptBudget: {
        schemaVersion: 1,
        workspaceId: ids.workspaceId,
        executionId: ids.parentExecutionId,
        attemptId: ids.parentAttemptId,
        executionPlanId: f.parentPlan.executionPlanId,
        executionPlanDigest: f.parentPlan.contentDigest,
        reservationKey: `runtime-attempt:${ids.parentAttemptId}`,
        currency: 'USD',
        maximumMicrounits: f.parentPlan.constraints.limits.budget.maximumMicrounits,
        maximumTokens: f.parentPlan.constraints.limits.tokens.maximumTotal,
      },
    }

    // Synthetic authority and accounting callbacks exercise the adapter mapping and separate CP
    // persistence layout, not full production child-tool qualification.
    runtime = await createNodePiDurableRuntime(runtimeOptions)
    handle = await runtime.adapter.start(parentRuntimeRequest)
    await runtime.adapter.drain()
    await expect(runtime.adapter.status(handle)).resolves.toMatchObject({ state: 'completed' })
    const retainedParent = runtime.adapter.journal.get(handle.handleId)
    expect(retainedParent.attemptId).toBe(ids.parentAttemptId)
    expect(retainedParent.admission.request).toMatchObject({
      executionId: ids.parentExecutionId,
      attemptId: ids.parentAttemptId,
    })
    expect(retainedParent.admission.handle).toEqual(handle)
    mappedNativeStorePath = nativeSessionPath(f.runtimeDirectory, handle.externalSessionId)
    expect(mappedNativeStorePath).not.toBe(f.databasePath)

    const admitted = await f.childAdmission()
    const parallelCandidate = await f.childAdmission()
    const totalCandidate = await f.childAdmission()
    await expect(allocate(new SqliteDelegationRepository(f.provider), admitted)).resolves.toBe(true)
    expect(admitted.request.parentExecutionId).toBe(retainedParent.admission.request.executionId)
    expect(admitted.request.parentAttemptId).toBe(retainedParent.admission.request.attemptId)
    const parentBudgetBeforeCompaction = await f.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    const lifecycle = new ExecutionLifecycleService(f.executions)
    await lifecycle.transitionExecution({
      executionId: admitted.childExecutionId,
      expectedVersion: 2,
      to: 'running',
      transitionedAt: '2026-10-09T12:00:04.000Z',
    })
    await lifecycle.transitionAttempt({
      attemptId: admitted.childAttemptId,
      expectedVersion: 1,
      to: 'running',
      transitionedAt: '2026-10-09T12:00:04.000Z',
    })
    const depthCandidate = await f.childAdmission({
      parentExecutionId: admitted.childExecutionId,
      parentAttemptId: admitted.childAttemptId,
      parentExecutionVersion: 3,
      admissionParentPlan: admitted.childPlan,
      admissionParentContext: admitted.childContext,
    })

    await runtime.close()
    runtime = undefined
    f.provider.close()

    // Auto-compaction remains disabled; explicitly compact the native file selected by the
    // journal's canonical execution/attempt -> handle -> externalSessionId mapping.
    piStorage = await openNodeSqliteStorage(mappedNativeStorePath)
    harness = await Harness.open(
      piStorage,
      {
        models,
        registry: createRegistry(),
        settings: {
          compaction: {
            enabled: false,
            keepRecentTokens: 1,
            reserveTokens: 128,
            backgroundTokens: 0,
          },
          retry: { enabled: false, maxRetries: 0 },
        },
      },
      BACKGROUND_CONTEXT
    )
    const root = await harness.root(BACKGROUND_CONTEXT)
    expect((await root.context(BACKGROUND_CONTEXT)).entries.length).toBeGreaterThan(0)
    const taskId = await root.compact(
      'Preserve the parent task and its child limits.',
      BACKGROUND_CONTEXT
    )
    const task = await harness.waitForTask(taskId, BACKGROUND_CONTEXT)
    expect(task.state.outcome.status).toBe('completed')
    const summary = (await root.context(BACKGROUND_CONTEXT)).entries.find(
      (entry) => entry.kind === CompactionEntry.kind
    )
    expect(summary).toBeDefined()
    rootConversationId = root.id

    await harness.close(BACKGROUND_CONTEXT)
    harness = undefined
    await piStorage.close(BACKGROUND_CONTEXT)
    piStorage = undefined

    // Reopen the adapter journal to recover the production native-session mapping itself.
    reopenedRuntime = await createNodePiDurableRuntime(runtimeOptions)
    const reopenedParent = reopenedRuntime.adapter.journal.get(handle.handleId)
    expect(reopenedParent.attemptId).toBe(ids.parentAttemptId)
    expect(reopenedParent.admission.request).toMatchObject({
      executionId: ids.parentExecutionId,
      attemptId: ids.parentAttemptId,
    })
    expect(reopenedParent.admission.handle).toEqual(handle)
    expect(
      nativeSessionPath(f.runtimeDirectory, reopenedParent.admission.handle.externalSessionId)
    ).toBe(mappedNativeStorePath)
    await reopenedRuntime.close()
    reopenedRuntime = undefined

    reopenedProvider = new SqlitePersistenceProvider({ path: f.databasePath })
    await reopenedProvider.migrate()
    reopenedPiStorage = await openNodeSqliteStorage(mappedNativeStorePath)
    reopenedHarness = await Harness.open(
      reopenedPiStorage,
      {
        models,
        registry: createRegistry(),
        settings: {
          compaction: {
            enabled: false,
            keepRecentTokens: 1,
            reserveTokens: 128,
            backgroundTokens: 0,
          },
          retry: { enabled: false, maxRetries: 0 },
        },
      },
      BACKGROUND_CONTEXT
    )
    const reopenedRoot = await reopenedHarness.root(BACKGROUND_CONTEXT)
    expect(reopenedRoot.id).toBe(rootConversationId)
    const reopenedSummary = (await reopenedRoot.context(BACKGROUND_CONTEXT)).entries.find(
      (entry) => entry.kind === CompactionEntry.kind
    )
    expect(reopenedSummary).toBeDefined()
    await reopenedHarness.close(BACKGROUND_CONTEXT)
    reopenedHarness = undefined
    await reopenedPiStorage.close(BACKGROUND_CONTEXT)
    reopenedPiStorage = undefined

    const reopenedExecutions = new SqliteExecutionRepository(reopenedProvider)
    await expect(reopenedExecutions.getExecution(ids.parentExecutionId)).resolves.toMatchObject({
      executionId: ids.parentExecutionId,
      state: 'running',
    })
    const reopenedUsageStore = new SqliteDurableUsageStore(reopenedProvider)
    const parentBudgetBefore = await reopenedUsageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    expect(parentBudgetBefore).toEqual(parentBudgetBeforeCompaction)
    const childBudgetBeforeProbe = await reopenedUsageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(admitted.childExecutionId)
    )
    const reopenedLedger = new DurableUsageLedger({
      store: reopenedUsageStore,
      now: () => acceptedAt,
    })
    await expect(
      reopenedLedger.reserve({
        workspaceId: ids.workspaceId,
        executionId: admitted.childExecutionId,
        attemptId: admitted.childAttemptId,
        reservationKey: 'post-compaction-child-budget-probe',
        maximumMicrounits: childBudgetBeforeProbe.maximumMicrounits + 1,
        maximumTokens: 0,
        source: {
          sourceId: 'post-compaction-child-budget-probe',
          idempotencyKey: 'post-compaction-child-budget-probe',
        },
      })
    ).rejects.toThrow('BUDGET_EXHAUSTED')
    await expect(
      reopenedUsageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(admitted.childExecutionId)
      )
    ).resolves.toEqual(childBudgetBeforeProbe)
    const reopenedAllocator = new SqliteDelegationRepository(reopenedProvider)
    await expect(allocate(reopenedAllocator, parallelCandidate)).rejects.toMatchObject({
      code: 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED',
    })
    await expect(allocate(reopenedAllocator, depthCandidate)).rejects.toMatchObject({
      code: 'DELEGATION_DEPTH_EXCEEDED',
    })
    await expect(reopenedAllocator.get(depthCandidate.delegationId)).resolves.toBeUndefined()
    await expect(reopenedAllocator.listByParent(ids.parentExecutionId)).resolves.toHaveLength(1)
    await expect(
      reopenedExecutions.getExecution(parallelCandidate.childExecutionId)
    ).resolves.toBeUndefined()
    await expect(
      reopenedExecutions.getAttempt(parallelCandidate.childAttemptId)
    ).resolves.toBeUndefined()
    await expect(
      reopenedExecutions.getExecution(depthCandidate.childExecutionId)
    ).resolves.toBeUndefined()
    await expect(
      reopenedExecutions.getAttempt(depthCandidate.childAttemptId)
    ).resolves.toBeUndefined()
    const budgetAfterFenceDenials = await reopenedUsageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    expect(budgetAfterFenceDenials).toEqual(parentBudgetBefore)

    const admittedRecord = await reopenedAllocator.get(admitted.delegationId)
    const { pendingDispatch: _pendingDispatch, ...withoutPendingDispatch } = admittedRecord
    await expect(
      reopenedAllocator.compareAndSet(admittedRecord.revision, {
        ...withoutPendingDispatch,
        state: 'cancelled',
        revision: admittedRecord.revision + 1,
      })
    ).resolves.toBe(true)
    await expect(allocate(reopenedAllocator, parallelCandidate)).resolves.toBe(true)
    await expect(reopenedAllocator.listByParent(ids.parentExecutionId)).resolves.toHaveLength(2)

    const parentBudgetAfterSecondChild = await reopenedUsageStore.transaction(
      ids.workspaceId,
      (tx) => tx.getBudget(ids.parentExecutionId)
    )
    await expect(allocate(reopenedAllocator, totalCandidate)).rejects.toMatchObject({
      code: 'DELEGATION_LIMIT_EXCEEDED',
    })
    await expect(reopenedAllocator.get(totalCandidate.delegationId)).resolves.toBeUndefined()
    await expect(
      reopenedUsageStore.transaction(ids.workspaceId, (tx) => tx.getBudget(ids.parentExecutionId))
    ).resolves.toEqual(parentBudgetAfterSecondChild)
    expect(parentBudgetBefore).not.toEqual(parentBudgetAfterSecondChild)
  } finally {
    await reopenedRuntime?.close()
    await runtime?.close()
    await reopenedHarness?.close(BACKGROUND_CONTEXT)
    await reopenedPiStorage?.close(BACKGROUND_CONTEXT)
    await harness?.close(BACKGROUND_CONTEXT)
    await piStorage?.close(BACKGROUND_CONTEXT)
    reopenedProvider?.close()
    f.provider.close()
    await rm(f.directory, { recursive: true, force: true })
  }
})
