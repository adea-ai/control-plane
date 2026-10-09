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
