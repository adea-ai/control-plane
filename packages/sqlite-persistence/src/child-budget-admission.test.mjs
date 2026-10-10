import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import {
  ExecutionAttemptSchema,
  ExecutionLifecycleService,
  ExecutionSchema,
  previewLifecycleTransition,
} from '@control-plane/domain'
import { deriveExecutionPlan, ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { SqliteDelegationRepository } from './delegation-repository.ts'
import { SqliteContextPackageRepository } from './repositories-extra.ts'
import { SqliteExecutionPlanRepository } from './repositories.ts'
import { SqliteExecutionRepository } from './repositories.ts'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteDurableUsageStore } from './usage-store.ts'

const digest = (character) => `sha256:${character.repeat(64)}`
const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  parentAttemptId: 'att_01JABCDEF0123456789ABCDEFG',
  childTaskId: 'tsk_01JBBCDEF0123456789ABCDEFG',
  childRequestId: 'req_01JBBCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  actor: 'usr_01JABCDEF0123456789ABCDEFG',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
}
const acceptedAt = '2026-10-09T12:00:00.000Z'

async function fixture({
  parentBudget = { maximumMicrounits: 10_000_000, maximumTokens: 250_000 },
  maximumTotal = 1,
  maximumParallel = 1,
  startParent = true,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-child-budget-admission-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  await provider.migrate()
  const parentInput = createExecutionPlanTestFixtureInputs()
  const compiler = new ExecutionPlanCompiler('1.0.0')
  parentInput.correlation.workspaceId = ids.workspaceId
  parentInput.correlation.taskId = 'tsk_01JABCDEF0123456789ABCDEFG'
  parentInput.correlation.requestId = 'req_01JABCDEF0123456789ABCDEFG'
  parentInput.constraints.limits.childExecutions.maximumTotal = maximumTotal
  parentInput.constraints.limits.childExecutions.maximumDepth = 2
  parentInput.constraints.limits.concurrency.maximumParallel = maximumParallel
  const canonicalParentPlan = compiler.compile(parentInput)
  const parentContextPackage = contextPackageSerializationFixtures.futurePi
  const executionPlans = new SqliteExecutionPlanRepository(provider)
  const contexts = new SqliteContextPackageRepository(provider)
  await contexts.put(parentContextPackage)
  await executionPlans.put(canonicalParentPlan)

  const executions = new SqliteExecutionRepository(provider)
  const lifecycle = new ExecutionLifecycleService(executions)
  const parentExecution = ExecutionSchema.parse({
    executionId: ids.parentExecutionId,
    state: 'accepted',
    version: 1,
    correlation: canonicalParentPlan.correlation,
    executionPlan: {
      executionPlanId: canonicalParentPlan.executionPlanId,
      contentDigest: canonicalParentPlan.contentDigest,
      schemaVersion: canonicalParentPlan.schemaVersion,
    },
    attemptCount: 0,
    acceptedAt,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  })
  await executions.insertExecution(parentExecution)
  const parentAttempt = await lifecycle.createAttempt({
    executionId: ids.parentExecutionId,
    attemptId: ids.parentAttemptId,
    expectedExecutionVersion: 1,
    queuedAt: '2026-10-09T12:00:01.000Z',
  })
  let parentExecutionVersion = 2
  let parentAttemptVersion = 1
  if (startParent) {
    await lifecycle.transitionExecution({
      executionId: ids.parentExecutionId,
      expectedVersion: parentExecutionVersion,
      to: 'queued',
      transitionedAt: '2026-10-09T12:00:02.000Z',
    })
    parentExecutionVersion += 1
    await lifecycle.transitionExecution({
      executionId: ids.parentExecutionId,
      expectedVersion: parentExecutionVersion,
      to: 'running',
      transitionedAt: '2026-10-09T12:00:03.000Z',
    })
    parentExecutionVersion += 1
    await lifecycle.transitionAttempt({
      attemptId: ids.parentAttemptId,
      expectedVersion: parentAttemptVersion,
      to: 'running',
      transitionedAt: '2026-10-09T12:00:03.000Z',
    })
    parentAttemptVersion += 1
  }
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
  async function childAdmission() {
    nextChild += 1
    const childExecutionId =
      nextChild === 1 ? ids.childExecutionId : 'exe_01JDBCDEF0123456789ABCDEFG'
    const childAttemptId =
      nextChild === 1 ? 'att_01JBBCDEF0123456789ABCDEFG' : 'att_01JDBCDEF0123456789ABCDEFG'
    const delegationId = nextChild === 1 ? ids.delegationId : 'dlg_01JDBCDEF0123456789ABCDEFG'
    const childTaskId = nextChild === 1 ? ids.childTaskId : 'tsk_01JDBCDEF0123456789ABCDEFG'
    const childRequestId = nextChild === 1 ? ids.childRequestId : 'req_01JDBCDEF0123456789ABCDEFG'
    const childContext = deriveContextPackage(parentContextPackage, {
      objective: 'Run one bounded child task',
      allowedStateItemIds: [],
      allowedArtifactIds: [],
      budgets: {
        maximumBytes: Math.min(512, parentContextPackage.budgets.maximumBytes),
        maximumTokens: Math.min(128, parentContextPackage.budgets.maximumTokens),
      },
      successCriteria: ['Return focused evidence'],
      returnContract: { contractRef: 'contract://adapter-result/v1' },
      compiledAt: acceptedAt,
    })
    await contexts.put(childContext)
    const childCorrelation = {
      ...canonicalParentPlan.correlation,
      taskId: childTaskId,
      requestId: childRequestId,
    }
    const childPlan = deriveExecutionPlan(canonicalParentPlan, {
      correlation: childCorrelation,
      contextPackage: childContext,
      constraints: canonicalParentPlan.constraints,
      runtimeRequirements: canonicalParentPlan.runtimeRequirements,
      outputContract: canonicalParentPlan.outputContract,
      compiledAt: acceptedAt,
    })
    await executionPlans.put(childPlan)
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
      parentExecutionId: ids.parentExecutionId,
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
    const queuedChildExecution = ExecutionSchema.parse({
      ...previewLifecycleTransition(childExecution, { to: 'queued', transitionedAt: acceptedAt }),
      attemptCount: 1,
      latestAttemptId: childAttemptId,
    })
    const childRequestDigest = digest(nextChild === 1 ? 'c' : 'd')
    const childDispatch = {
      delegationId,
      childAttemptId,
      runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
      dispatchedAt: acceptedAt,
    }
    const request = {
      workspaceId: ids.workspaceId,
      parentIntentId: 'intent:child-budget-fixture',
      parentExecutionId: ids.parentExecutionId,
      parentAttemptId: ids.parentAttemptId,
      parentExecutionVersion,
      parentPlan: {
        executionPlanId: canonicalParentPlan.executionPlanId,
        contentDigest: canonicalParentPlan.contentDigest,
        schemaVersion: canonicalParentPlan.schemaVersion,
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
      profileVersionId: canonicalParentPlan.profile.profileVersionId,
      originalActorPrincipalId: ids.actor,
      childRequestDigest,
      acceptedAt,
    }
    const delegation = {
      delegationId,
      parentExecutionId: ids.parentExecutionId,
      parentAttemptId: ids.parentAttemptId,
      admittedToolCallId: ids.toolCallId,
      childExecutionId,
      parentExecutionPlanId: canonicalParentPlan.executionPlanId,
      parentExecutionPlanDigest: canonicalParentPlan.contentDigest,
      childExecutionPlanId: childPlan.executionPlanId,
      childExecutionPlanDigest: childPlan.contentDigest,
      contextPackageId: childPlan.contextPackage.contextPackageId,
      contextPackageDigest: childPlan.contextPackage.contentDigest,
      role: 'researcher',
      profileVersionId: canonicalParentPlan.profile.profileVersionId,
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
      childExecution: queuedChildExecution,
      childAttempt,
      request,
      receipt,
      delegation,
      allocator: new SqliteDelegationRepository(provider),
      executionRepository: executions,
      usageStore,
      childPlan,
      get childIds() {
        return { childExecutionId, delegationId }
      },
    }
  }
  return {
    directory,
    provider,
    canonicalParentPlan,
    parentAttempt,
    parentAttemptVersion,
    usageStore,
    childAdmission,
    async close() {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('child admission transaction rolls back execution and budget when current authority denies', async () => {
  const f = await fixture()
  try {
    const child = await f.childAdmission()
    await expect(
      child.allocator.allocate({
        request: child.request,
        receipt: child.receipt,
        execution: child.childExecution,
        attempt: child.childAttempt,
        delegation: child.delegation,
        assertCurrent: async () => {
          throw new Error('revoked child audience')
        },
      })
    ).rejects.toThrow('revoked child audience')
    expect(
      await child.executionRepository.getExecution(child.childIds.childExecutionId)
    ).toBeUndefined()
    expect(await child.executionRepository.getAttempt(child.request.childAttemptId)).toBeUndefined()
    expect(await child.allocator.get(child.childIds.delegationId)).toBeUndefined()
    await expect(
      child.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(child.childIds.childExecutionId)
      )
    ).resolves.toBeUndefined()
    const parentBudget = await child.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    expect(parentBudget?.reservations).toEqual([])
  } finally {
    await f.close()
  }
})

test('child admission rejects a non-running canonical parent before any allocation', async () => {
  const f = await fixture({ startParent: false })
  try {
    const child = await f.childAdmission()
    await expect(
      child.allocator.allocate({
        request: child.request,
        receipt: child.receipt,
        execution: child.childExecution,
        attempt: child.childAttempt,
        delegation: child.delegation,
        assertCurrent: async () => undefined,
      })
    ).rejects.toMatchObject({ code: 'CHILD_ADMISSION_DENIED' })
    expect(
      await child.executionRepository.getExecution(child.childIds.childExecutionId)
    ).toBeUndefined()
    expect(await child.executionRepository.getAttempt(child.request.childAttemptId)).toBeUndefined()
    expect(await child.allocator.get(child.childIds.delegationId)).toBeUndefined()
    await expect(
      child.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(child.childIds.childExecutionId)
      )
    ).resolves.toBeUndefined()
  } finally {
    await f.close()
  }
})

test('concurrent child admissions serialize parallel limits without loser allocation', async () => {
  const f = await fixture({ maximumTotal: 2, maximumParallel: 1 })
  try {
    const left = await f.childAdmission()
    const right = await f.childAdmission()
    const results = await Promise.allSettled(
      [left, right].map((child) =>
        child.allocator.allocate({
          request: child.request,
          receipt: child.receipt,
          execution: child.childExecution,
          attempt: child.childAttempt,
          delegation: child.delegation,
          assertCurrent: async () => undefined,
        })
      )
    )
    expect(results.filter((result) => result.status === 'fulfilled' && result.value)).toHaveLength(
      1
    )
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
      code: 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED',
    })
    const children = await left.allocator.listByParent(ids.parentExecutionId)
    expect(children).toHaveLength(1)
    const winner = results[0].status === 'fulfilled' ? left : right
    await expect(
      winner.allocator.allocate({
        request: winner.request,
        receipt: winner.receipt,
        execution: winner.childExecution,
        attempt: winner.childAttempt,
        delegation: winner.delegation,
        assertCurrent: async () => undefined,
      })
    ).resolves.toBe(false)
    expect(await winner.allocator.listByParent(ids.parentExecutionId)).toHaveLength(1)
    const loser = results[0].status === 'rejected' ? left : right
    expect(
      await loser.executionRepository.getExecution(loser.childIds.childExecutionId)
    ).toBeUndefined()
    expect(await loser.executionRepository.getAttempt(loser.request.childAttemptId)).toBeUndefined()
    await expect(
      loser.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(loser.childIds.childExecutionId)
      )
    ).resolves.toBeUndefined()
  } finally {
    await f.close()
  }
})

test('total child limit denial creates no execution, delegation, or child budget', async () => {
  const f = await fixture({ maximumTotal: 1, maximumParallel: 2 })
  try {
    const admitted = await f.childAdmission()
    const denied = await f.childAdmission()
    await admitted.allocator.allocate({
      request: admitted.request,
      receipt: admitted.receipt,
      execution: admitted.childExecution,
      attempt: admitted.childAttempt,
      delegation: admitted.delegation,
      assertCurrent: async () => undefined,
    })
    await expect(
      denied.allocator.allocate({
        request: denied.request,
        receipt: denied.receipt,
        execution: denied.childExecution,
        attempt: denied.childAttempt,
        delegation: denied.delegation,
        assertCurrent: async () => undefined,
      })
    ).rejects.toMatchObject({ code: 'DELEGATION_LIMIT_EXCEEDED' })
    expect(
      await denied.executionRepository.getExecution(denied.childIds.childExecutionId)
    ).toBeUndefined()
    expect(
      await denied.executionRepository.getAttempt(denied.request.childAttemptId)
    ).toBeUndefined()
    expect(await denied.allocator.get(denied.childIds.delegationId)).toBeUndefined()
    await expect(
      denied.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(denied.childIds.childExecutionId)
      )
    ).resolves.toBeUndefined()
    const parentBudget = await denied.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    expect(parentBudget?.reservations).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test('child budget exhaustion rolls back the child execution and delegation in the same transaction', async () => {
  const f = await fixture({ parentBudget: { maximumMicrounits: 0, maximumTokens: 0 } })
  try {
    const child = await f.childAdmission()
    await expect(
      child.allocator.allocate({
        request: child.request,
        receipt: child.receipt,
        execution: child.childExecution,
        attempt: child.childAttempt,
        delegation: child.delegation,
        assertCurrent: async () => undefined,
      })
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
    expect(
      await child.executionRepository.getExecution(child.childIds.childExecutionId)
    ).toBeUndefined()
    expect(await child.executionRepository.getAttempt(child.request.childAttemptId)).toBeUndefined()
    expect(await child.allocator.get(child.childIds.delegationId)).toBeUndefined()
    await expect(
      child.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(child.childIds.childExecutionId)
      )
    ).resolves.toBeUndefined()
  } finally {
    await f.close()
  }
})

const retryAttemptId = 'att_01EABCDEF0123456789ABCDEFG'

/** Canonical retry shape: a failed child returns to `requested` with retryCount+1. */
async function simulateRetry(allocator, delegationId) {
  const stored = await allocator.get(delegationId)
  const retried = {
    ...stored,
    state: 'requested',
    retryCount: stored.retryCount + 1,
    revision: stored.revision + 1,
    updatedAt: '2026-10-09T12:00:05.000Z',
  }
  expect(await allocator.compareAndSet(stored.revision, retried)).toBe(true)
  return retried
}

test('a retried child cannot mint a second allocation, budget, or parent reservation', async () => {
  const f = await fixture({ maximumTotal: 2, maximumParallel: 2 })
  try {
    const admitted = await f.childAdmission()
    await admitted.allocator.allocate({
      request: admitted.request,
      receipt: admitted.receipt,
      execution: admitted.childExecution,
      attempt: admitted.childAttempt,
      delegation: admitted.delegation,
      assertCurrent: async () => undefined,
    })
    const childBudgetBefore = await admitted.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(admitted.childIds.childExecutionId)
    )
    const parentBefore = await admitted.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )

    const retried = await simulateRetry(admitted.allocator, admitted.childIds.delegationId)

    // Re-admitting the SAME identity is an identity conflict, never a second
    // allocation: no new execution, attempt, delegation revision, child
    // budget, or parent reservation can appear on the retry path.
    expect(
      await admitted.allocator.allocate({
        request: admitted.request,
        receipt: admitted.receipt,
        execution: admitted.childExecution,
        attempt: admitted.childAttempt,
        delegation: admitted.delegation,
        assertCurrent: async () => undefined,
      })
    ).toBe(false)
    const afterRecord = await admitted.allocator.get(admitted.childIds.delegationId)
    expect(afterRecord.revision).toBe(retried.revision)
    expect(afterRecord.retryCount).toBe(1)
    expect(
      await admitted.executionRepository.getAttempt(admitted.request.childAttemptId)
    ).toBeDefined()
    const childBudgetAfter = await admitted.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(admitted.childIds.childExecutionId)
    )
    expect(childBudgetAfter).toStrictEqual(childBudgetBefore)
    const parentAfter = await admitted.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    expect(parentAfter).toStrictEqual(parentBefore)
    expect(parentAfter.reservations).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test('retry keeps the identical sibling cap and budget ceiling for the next admission', async () => {
  const f = await fixture({ maximumTotal: 1, maximumParallel: 2 })
  try {
    const admitted = await f.childAdmission()
    await admitted.allocator.allocate({
      request: admitted.request,
      receipt: admitted.receipt,
      execution: admitted.childExecution,
      attempt: admitted.childAttempt,
      delegation: admitted.delegation,
      assertCurrent: async () => undefined,
    })
    await simulateRetry(admitted.allocator, admitted.childIds.delegationId)

    // The same total-child limit applies during the retry state: a NEW sibling
    // is denied with the identical code, and the retried child does not free
    // or double-count its slot.
    const denied = await f.childAdmission()
    await expect(
      denied.allocator.allocate({
        request: denied.request,
        receipt: denied.receipt,
        execution: denied.childExecution,
        attempt: denied.childAttempt,
        delegation: denied.delegation,
        assertCurrent: async () => undefined,
      })
    ).rejects.toMatchObject({ code: 'DELEGATION_LIMIT_EXCEEDED' })
    expect(await denied.allocator.get(denied.childIds.delegationId)).toBeUndefined()

    // The same child-budget ceiling binds the retry attempt as it binds the
    // first dispatch: the first reservation may take the full ceiling, and one
    // more unit for the retry attempt is exhausted — not silently granted.
    const lifecycle = new ExecutionLifecycleService(admitted.executionRepository)
    const childBudget = await admitted.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(admitted.childIds.childExecutionId)
    )
    const ledger = new DurableUsageLedger({ store: admitted.usageStore, now: () => acceptedAt })
    // First dispatch reserves the full child ceiling while it is the latest
    // canonical attempt.
    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: admitted.childIds.childExecutionId,
      attemptId: admitted.request.childAttemptId,
      reservationKey: `runtime-attempt:${admitted.request.childAttemptId}`,
      maximumMicrounits: childBudget.maximumMicrounits,
      maximumTokens: childBudget.maximumTokens,
      source: { sourceId: 'first-dispatch', idempotencyKey: 'first-dispatch-reserve' },
    })
    const childExecution = await admitted.executionRepository.getExecution(
      admitted.childIds.childExecutionId
    )
    // Canonical retry order: the new attempt cannot be created while the
    // prior attempt still holds its runtime-attempt reservation — the retry
    // waits for settlement, it never bypasses it.
    await expect(
      lifecycle.createAttempt({
        executionId: admitted.childIds.childExecutionId,
        attemptId: retryAttemptId,
        expectedExecutionVersion: childExecution.version,
        queuedAt: '2026-10-09T12:00:05.000Z',
      })
    ).rejects.toThrow('SETTLEMENT_INCOMPLETE')
    await ledger.settle({
      workspaceId: ids.workspaceId,
      executionId: admitted.childIds.childExecutionId,
      reservationKey: `runtime-attempt:${admitted.request.childAttemptId}`,
      source: { sourceId: 'first-dispatch-settle', idempotencyKey: 'first-dispatch-settle' },
    })
    const childAfterSettle = await admitted.executionRepository.getExecution(
      admitted.childIds.childExecutionId
    )
    await lifecycle.createAttempt({
      executionId: admitted.childIds.childExecutionId,
      attemptId: retryAttemptId,
      expectedExecutionVersion: childAfterSettle.version,
      queuedAt: '2026-10-09T12:00:05.000Z',
    })
    // The retry attempt receives the identical ceiling, and one reservation
    // cannot exceed it — no fresh or doubled budget on the retry path.
    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: admitted.childIds.childExecutionId,
      attemptId: retryAttemptId,
      reservationKey: `runtime-attempt:${retryAttemptId}`,
      maximumMicrounits: childBudget.maximumMicrounits,
      maximumTokens: childBudget.maximumTokens,
      source: { sourceId: 'retry-dispatch', idempotencyKey: 'retry-dispatch-reserve' },
    })
    await expect(
      ledger.reserve({
        workspaceId: ids.workspaceId,
        executionId: admitted.childIds.childExecutionId,
        attemptId: retryAttemptId,
        reservationKey: `runtime-attempt:${retryAttemptId}:extra`,
        maximumMicrounits: 1,
        maximumTokens: 0,
        source: { sourceId: 'retry-dispatch-extra', idempotencyKey: 'retry-dispatch-extra' },
      })
    ).rejects.toThrow('BUDGET_EXHAUSTED')

    // The retry never doubles the parent-side reservation either.
    const parentBudget = await admitted.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    expect(parentBudget.reservations).toHaveLength(1)
  } finally {
    await f.close()
  }
})

// --- Admission/allocator integration regressions: interruption, restart,
// duplicate request, and cancellation exercised against the real SQLite
// provider and allocator (not in-memory doubles). ---

async function reopenStore(directory) {
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  await provider.migrate()
  return {
    provider,
    executions: new SqliteExecutionRepository(provider),
    delegations: new SqliteDelegationRepository(provider),
    usageStore: new SqliteDurableUsageStore(provider),
    lifecycle: new ExecutionLifecycleService(new SqliteExecutionRepository(provider)),
  }
}

test('an admission interrupted before the budget reservation leaves no allocation after a store restart', async () => {
  const f = await fixture()
  let restarted
  try {
    const admitted = await f.childAdmission()
    // The current-authority check runs inside the allocation transaction before
    // the budget reservation can commit, so this is a before-reservation
    // interruption: nothing may survive it.
    await expect(
      admitted.allocator.allocate({
        request: admitted.request,
        receipt: admitted.receipt,
        execution: admitted.childExecution,
        attempt: admitted.childAttempt,
        delegation: admitted.delegation,
        assertCurrent: async () => {
          throw new Error('AUTHORITY_INTERRUPTED_BEFORE_RESERVATION')
        },
      })
    ).rejects.toThrow('AUTHORITY_INTERRUPTED_BEFORE_RESERVATION')

    await f.provider.close()
    restarted = await reopenStore(f.directory)
    expect(
      await restarted.executions.getExecution(admitted.childIds.childExecutionId)
    ).toBeUndefined()
    expect(await restarted.executions.getAttempt(admitted.request.childAttemptId)).toBeUndefined()
    expect(await restarted.delegations.get(admitted.childIds.delegationId)).toBeUndefined()
    await expect(
      restarted.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(admitted.childIds.childExecutionId)
      )
    ).resolves.toBeUndefined()
    const parentBudget = await restarted.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    expect(parentBudget?.reservations).toEqual([])
  } finally {
    await restarted?.provider.close()
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a restarted store still denies a duplicate admission request and keeps exactly one allocation', async () => {
  const f = await fixture()
  let restarted
  try {
    const admitted = await f.childAdmission()
    expect(
      await admitted.allocator.allocate({
        request: admitted.request,
        receipt: admitted.receipt,
        execution: admitted.childExecution,
        attempt: admitted.childAttempt,
        delegation: admitted.delegation,
        assertCurrent: async () => undefined,
      })
    ).toBe(true)

    await f.provider.close()
    restarted = await reopenStore(f.directory)
    const persisted = await restarted.delegations.get(admitted.childIds.delegationId)
    expect(persisted.childExecutionId).toBe(admitted.childIds.childExecutionId)

    // The identical request re-submitted after a restart is a duplicate: the
    // allocator must refuse it and keep the single persisted allocation.
    const duplicate = await restarted.delegations.allocate({
      request: admitted.request,
      receipt: admitted.receipt,
      execution: admitted.childExecution,
      attempt: admitted.childAttempt,
      delegation: admitted.delegation,
      assertCurrent: async () => undefined,
    })
    expect(duplicate).toBe(false)
    expect(await restarted.delegations.get(admitted.childIds.delegationId)).toEqual(persisted)
    expect(
      await restarted.executions.getExecution(admitted.childIds.childExecutionId)
    ).toBeDefined()
    const parentBudget = await restarted.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    expect(parentBudget.reservations).toHaveLength(1)
  } finally {
    await restarted?.provider.close()
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('cancelling an admitted child persists consistently across a store restart', async () => {
  const f = await fixture()
  let restarted
  try {
    const admitted = await f.childAdmission()
    expect(
      await admitted.allocator.allocate({
        request: admitted.request,
        receipt: admitted.receipt,
        execution: admitted.childExecution,
        attempt: admitted.childAttempt,
        delegation: admitted.delegation,
        assertCurrent: async () => undefined,
      })
    ).toBe(true)

    // Cancel the admitted child through the canonical lifecycle.
    const lifecycle = new ExecutionLifecycleService(admitted.executionRepository)
    const childExecution = await admitted.executionRepository.getExecution(
      admitted.childIds.childExecutionId
    )
    await lifecycle.transitionAttempt({
      attemptId: admitted.request.childAttemptId,
      expectedVersion: 1,
      to: 'cancelled',
      transitionedAt: '2026-10-09T12:05:00.000Z',
    })
    await lifecycle.transitionExecution({
      executionId: admitted.childIds.childExecutionId,
      expectedVersion: childExecution.version,
      to: 'cancelled',
      transitionedAt: '2026-10-09T12:05:00.000Z',
    })

    await f.provider.close()
    restarted = await reopenStore(f.directory)
    const cancelledExecution = await restarted.executions.getExecution(
      admitted.childIds.childExecutionId
    )
    expect(cancelledExecution.state).toBe('cancelled')
    const cancelledAttempt = await restarted.executions.getAttempt(admitted.request.childAttemptId)
    expect(cancelledAttempt.state).toBe('cancelled')
    // Cancellation must not mint or lose admission evidence across the restart.
    expect(await restarted.delegations.get(admitted.childIds.delegationId)).toBeDefined()
    const childBudget = await restarted.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(admitted.childIds.childExecutionId)
    )
    expect(childBudget).toBeDefined()
    const parentBudget = await restarted.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    expect(parentBudget.reservations).toHaveLength(1)
  } finally {
    await restarted?.provider.close()
    await rm(f.directory, { recursive: true, force: true })
  }
})
