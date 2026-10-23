// CP #937 / #1018 (M13.04.1): the retry-after-compaction admission intersection.
//
// Existing coverage proves each acceptance state separately: retry races without native
// compaction (`child-budget-admission.test.mjs`), and native compaction without a retry
// (`pi-durable-adapter`'s `compaction-child-admission.test.mjs`). This module proves the missing
// combined state: a child retry that commits only AFTER a native Pi compaction and a SQLite
// database reopen must preserve the sibling identity, total, parallel and budget admission
// fences exactly as at initial admission. It is a new unit module only — no runtime source and
// no existing test is touched.
//
// The native harness `retry` setting below is the model-call retry (kept off for determinism);
// the retry under test is the CP delegation retry committed after the compaction and reopen.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { CompactionEntry, createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { DelegationService } from '@control-plane/orchestration'
import { SqliteDelegationRepository } from './delegation-repository.ts'
import { SqliteExecutionPlanRepository, SqliteExecutionRepository } from './repositories.ts'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteDurableUsageStore } from './usage-store.ts'
import { fixture, ids } from './child-allocation-fixture.mjs'

const runningObservedAt = '2026-10-09T12:00:10.000Z'
const failedObservedAt = '2026-10-09T12:00:20.000Z'

const allocationOf = (child) => ({
  request: child.request,
  receipt: child.receipt,
  execution: child.childExecution,
  attempt: child.childAttempt,
  delegation: child.delegation,
  assertCurrent: async () => undefined,
})

/** The same child with a delegation policy that allows exactly the one retry committed below. */
const retryable = (child) => ({
  ...child,
  delegation: {
    ...child.delegation,
    policy: { ...child.delegation.policy, maximumRetries: 1 },
  },
})

/** One store's delegation/execution/usage views plus the service that commits progress. */
function admissionStore(provider) {
  const executions = new SqliteExecutionRepository(provider)
  const delegations = new SqliteDelegationRepository(provider)
  const usageStore = new SqliteDurableUsageStore(provider)
  const service = new DelegationService({
    delegations,
    lifecycle: new ExecutionLifecycleService(executions),
    plans: new SqliteExecutionPlanRepository(provider),
    events: { async publish() {} },
  })
  return { executions, delegations, usageStore, service }
}

const budgetOf = (store, executionId) =>
  store.usageStore.transaction(ids.workspaceId, (tx) => tx.getBudget(executionId))

/**
 * One deterministic native Pi compaction: a real parent turn, an explicit `root.compact`, and a
 * persisted summary in its own native session file, mirroring the manual-compaction shape the
 * suite already qualifies.
 */
async function compactNativeSession() {
  const directory = await mkdtemp(join(tmpdir(), 'pi-retry-compaction-'))
  const storage = await openNodeSqliteStorage(join(directory, 'pi.sqlite'))
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage('The parent turn is recorded before the child retry compaction.'),
    fauxAssistantMessage('The recorded parent turn remains preserved in this summary.'),
  ])
  const harness = await Harness.open(
    storage,
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
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    })
    const firstTurn = await root.submit(
      {
        type: 'input',
        requestId: 'retry-compaction:turn:1',
        content: 'Record the parent turn before compaction.',
      },
      BACKGROUND_CONTEXT
    )
    expect((await firstTurn.wait(BACKGROUND_CONTEXT)).status).toBe('done')
    const taskId = await root.compact('Preserve the recorded parent turn.', BACKGROUND_CONTEXT)
    const task = await harness.waitForTask(taskId, BACKGROUND_CONTEXT)
    expect(task.state.status).toBe('terminal')
    expect(task.state.outcome.status).toBe('completed')
    const compacted = await root.context(BACKGROUND_CONTEXT)
    const summary = compacted.entries.find((entry) => entry.kind === CompactionEntry.kind)
    expect(summary).toBeDefined()
    expect(JSON.stringify(summary)).toContain('recorded parent turn')
  } finally {
    await harness.close(BACKGROUND_CONTEXT)
    await storage.close(BACKGROUND_CONTEXT)
    await rm(directory, { recursive: true, force: true })
  }
}

/** Closes the CP store and reopens the same SQLite database through a fresh provider. */
async function reopenDatabase(f) {
  await f.provider.close()
  const provider = new SqlitePersistenceProvider({ path: join(f.directory, 'state.sqlite') })
  await provider.migrate()
  return provider
}

/** Admits the retryable child, dispatches it and records it running — all before the compaction. */
async function admitRunningChild(f, child) {
  const store = admissionStore(f.provider)
  const admitted = retryable(child)
  expect(await store.delegations.allocate(allocationOf(admitted))).toBe(true)
  await store.service.dispatchChild(child.request.childDispatch)
  await store.service.recordChildProgress({
    delegationId: child.childIds.delegationId,
    childAttemptId: child.request.childAttemptId,
    state: 'running',
    observedAt: runningObservedAt,
  })
  return admitted
}

/** The canonical retry: a retryable failure returns the same child to `requested`, retryCount+1. */
async function commitRetry(store, child) {
  const outcome = await store.service.recordChildProgress({
    delegationId: child.childIds.delegationId,
    childAttemptId: child.request.childAttemptId,
    state: 'failed',
    observedAt: failedObservedAt,
    failure: {
      classification: 'runtime_unavailable',
      code: 'RUNTIME_LOST',
      retryable: true,
    },
  })
  expect(outcome).toMatchObject({
    resolution: 'retry',
    record: { state: 'requested', retryCount: 1 },
  })
}

/** A denied sibling must leave no execution, attempt, delegation or child budget row behind. */
async function expectNoAllocationRows(store, sibling) {
  expect(await store.executions.getExecution(sibling.childIds.childExecutionId)).toBeUndefined()
  expect(await store.executions.getAttempt(sibling.request.childAttemptId)).toBeUndefined()
  expect(await store.delegations.get(sibling.childIds.delegationId)).toBeUndefined()
  expect(await store.delegations.findByChild(sibling.childIds.childExecutionId)).toBeUndefined()
  await expect(budgetOf(store, sibling.childIds.childExecutionId)).resolves.toBeUndefined()
}

test('a child retry after native compaction and a database reopen keeps the sibling identity and parallel admission fences', async () => {
  const f = await fixture({ maximumTotal: 2, maximumParallel: 1 })
  let reopenedProvider
  try {
    const child = await f.childAdmission()
    const sibling = await f.childAdmission()
    const admitted = await admitRunningChild(f, child)
    const parentBudgetBefore = await budgetOf({ usageStore: f.usageStore }, ids.parentExecutionId)
    const childBudgetBefore = await budgetOf(
      { usageStore: f.usageStore },
      admitted.childIds.childExecutionId
    )
    expect(parentBudgetBefore?.reservations).toHaveLength(1)

    await compactNativeSession()
    reopenedProvider = await reopenDatabase(f)
    const store = admissionStore(reopenedProvider)

    // The retry commits only after the native compaction and the database reopen.
    await commitRetry(store, admitted)

    // Sibling identity fence: the retried child reuses its identity; nothing is minted twice.
    expect(await store.delegations.allocate(allocationOf(admitted))).toBe(false)
    const recordAfterRetry = await store.delegations.get(admitted.childIds.delegationId)
    expect(recordAfterRetry).toMatchObject({ state: 'requested', retryCount: 1 })
    expect(await store.delegations.get(admitted.childIds.delegationId)).toEqual(recordAfterRetry)
    expect(await store.delegations.listByParent(ids.parentExecutionId)).toHaveLength(1)
    await expect(budgetOf(store, ids.parentExecutionId)).resolves.toEqual(parentBudgetBefore)
    await expect(budgetOf(store, admitted.childIds.childExecutionId)).resolves.toEqual(
      childBudgetBefore
    )

    // Parallel fence: the retried child still holds the one parallel slot across the reopen.
    await expect(store.delegations.allocate(allocationOf(sibling))).rejects.toMatchObject({
      code: 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED',
    })
    await expectNoAllocationRows(store, sibling)
    await expect(budgetOf(store, ids.parentExecutionId)).resolves.toEqual(parentBudgetBefore)
    expect(await store.delegations.listByParent(ids.parentExecutionId)).toHaveLength(1)
  } finally {
    await reopenedProvider?.close()
    await f.close()
  }
})

test('a child retry after native compaction and a database reopen keeps the total child admission fence', async () => {
  const f = await fixture({ maximumTotal: 1, maximumParallel: 2 })
  let reopenedProvider
  try {
    const child = await f.childAdmission()
    const sibling = await f.childAdmission()
    const admitted = await admitRunningChild(f, child)
    const parentBudgetBefore = await budgetOf({ usageStore: f.usageStore }, ids.parentExecutionId)
    const childBudgetBefore = await budgetOf(
      { usageStore: f.usageStore },
      admitted.childIds.childExecutionId
    )
    expect(parentBudgetBefore?.reservations).toHaveLength(1)

    await compactNativeSession()
    reopenedProvider = await reopenDatabase(f)
    const store = admissionStore(reopenedProvider)

    await commitRetry(store, admitted)

    // The retry reuses its identity: one delegation, one child budget, one parent reservation.
    expect(await store.delegations.allocate(allocationOf(admitted))).toBe(false)
    expect(await store.delegations.get(admitted.childIds.delegationId)).toMatchObject({
      state: 'requested',
      retryCount: 1,
    })
    expect(await store.delegations.listByParent(ids.parentExecutionId)).toHaveLength(1)
    await expect(budgetOf(store, ids.parentExecutionId)).resolves.toEqual(parentBudgetBefore)
    await expect(budgetOf(store, admitted.childIds.childExecutionId)).resolves.toEqual(
      childBudgetBefore
    )

    // Total fence: one child is the whole total, so the sibling is refused after the reopen.
    await expect(store.delegations.allocate(allocationOf(sibling))).rejects.toMatchObject({
      code: 'DELEGATION_LIMIT_EXCEEDED',
    })
    await expectNoAllocationRows(store, sibling)
    await expect(budgetOf(store, ids.parentExecutionId)).resolves.toEqual(parentBudgetBefore)
    expect(await store.delegations.listByParent(ids.parentExecutionId)).toHaveLength(1)
  } finally {
    await reopenedProvider?.close()
    await f.close()
  }
})

test('a child retry after native compaction and a database reopen keeps the parent and child budget admission fences', async () => {
  const f = await fixture({ maximumTotal: 2, maximumParallel: 2 })
  let reopenedProvider
  try {
    const child = await f.childAdmission()
    const sibling = await f.childAdmission()
    const admitted = await admitRunningChild(f, child)

    // The admitted child is funded at the whole parent balance (the plan ceiling the fixture
    // states), so no parent balance is left for a later sibling once the retry has committed.
    const planCeiling = f.canonicalParentPlan.constraints.limits.budget.maximumMicrounits
    const planTokens = f.canonicalParentPlan.constraints.limits.tokens.maximumTotal
    const parentBudgetBefore = await budgetOf({ usageStore: f.usageStore }, ids.parentExecutionId)
    const childBudgetBefore = await budgetOf(
      { usageStore: f.usageStore },
      admitted.childIds.childExecutionId
    )
    expect(parentBudgetBefore?.reservations).toHaveLength(1)
    expect(parentBudgetBefore?.reservations[0].reservationKey).toBe(
      `child:${admitted.childIds.childExecutionId}`
    )
    expect(parentBudgetBefore?.reservations[0].maximumMicrounits).toBe(planCeiling)
    expect(childBudgetBefore?.maximumMicrounits).toBe(planCeiling)
    expect(childBudgetBefore?.maximumTokens).toBe(planTokens)

    await compactNativeSession()
    reopenedProvider = await reopenDatabase(f)
    const store = admissionStore(reopenedProvider)

    await commitRetry(store, admitted)

    // The retry does not re-fund: same child ceiling, same single parent reservation.
    expect(await store.delegations.allocate(allocationOf(admitted))).toBe(false)
    expect(await store.delegations.get(admitted.childIds.delegationId)).toMatchObject({
      state: 'requested',
      retryCount: 1,
    })
    await expect(budgetOf(store, admitted.childIds.childExecutionId)).resolves.toEqual(
      childBudgetBefore
    )
    const parentBudgetAfterRetry = await budgetOf(store, ids.parentExecutionId)
    expect(parentBudgetAfterRetry).toEqual(parentBudgetBefore)

    // Budget fence: limits admit the sibling, so the refusal comes from the parent balance
    // itself, inside the same transaction — no rows and no reservation for the sibling.
    await expect(store.delegations.allocate(allocationOf(sibling))).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    })
    await expectNoAllocationRows(store, sibling)
    await expect(budgetOf(store, ids.parentExecutionId)).resolves.toEqual(parentBudgetBefore)
    expect(await store.delegations.listByParent(ids.parentExecutionId)).toHaveLength(1)
  } finally {
    await reopenedProvider?.close()
    await f.close()
  }
})
