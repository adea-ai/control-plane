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
import { DelegationService } from '@control-plane/orchestration'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { SqliteDelegationRepository } from './delegation-repository.ts'
import { SqliteContextPackageRepository } from './repositories-extra.ts'
import { SqliteExecutionPlanRepository } from './repositories.ts'
import { SqliteExecutionRepository } from './repositories.ts'
import { SqlitePersistenceProvider } from './provider.ts'
import { createSqliteChildAdmissionReader } from './child-admission-reader.ts'
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
    executions,
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

function createReleaseGate() {
  let resolveEntered
  let releaseParked
  let enteredState
  let released = false
  const entered = new Promise((resolve) => (resolveEntered = resolve))
  const parked = new Promise((resolve) => (releaseParked = resolve))
  return {
    entered,
    async pause() {
      if (!released && enteredState === undefined) {
        enteredState = 'entered'
        resolveEntered(enteredState)
      }
      await parked
    },
    release() {
      if (released) return
      released = true
      if (enteredState === undefined) {
        enteredState = 'released'
        resolveEntered(enteredState)
      }
      releaseParked()
    },
  }
}

function gateProviderBeforeTransaction(provider) {
  const gate = createReleaseGate()
  let armed = true
  const gatedProvider = new Proxy(provider, {
    get(target, property) {
      if (property === 'transaction') {
        return async (operation) => {
          if (armed) {
            armed = false
            await gate.pause()
          }
          return target.transaction(operation)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { provider: gatedProvider, entered: gate.entered, release: gate.release }
}

function gateBeforeRetryCommit(repository) {
  const gate = createReleaseGate()
  let armed = true
  const gatedRepository = new Proxy(repository, {
    get(target, property) {
      if (property === 'compareAndSet') {
        return async (expectedRevision, record) => {
          if (armed && record.state === 'requested' && record.retryCount === 1) {
            armed = false
            // Pause before the SQLite repository call opens its transaction.
            await gate.pause()
          }
          return target.compareAndSet(expectedRevision, record)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { repository: gatedRepository, entered: gate.entered, release: gate.release }
}

const raceWaitLimitMs = 5_000

function observeOperation(promise) {
  const outcome = Promise.resolve(promise).then(
    (value) => ({ status: 'fulfilled', value }),
    (error) => ({ status: 'rejected', error })
  )
  return { promise, outcome }
}

async function raceWithLimit(promises, label) {
  let timer
  let settleTimeout
  const timeout = new Promise((resolve) => {
    settleTimeout = resolve
    timer = setTimeout(() => resolve({ status: 'timeout' }), raceWaitLimitMs)
  })
  try {
    const outcome = await Promise.race([...promises, timeout])
    if (outcome.status === 'timeout') {
      throw new Error(`${label} did not settle within ${raceWaitLimitMs}ms`)
    }
    return outcome
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    settleTimeout({ status: 'cancelled' })
  }
}

async function waitForGateOrOperation(entered, operation, label) {
  const outcome = await raceWithLimit(
    [
      entered.then((state) => ({ status: state })),
      operation.outcome.then((result) => ({ status: 'operation', result })),
    ],
    `${label} gate`
  )
  if (outcome.status === 'entered') return
  if (outcome.status === 'released') {
    throw new Error(`${label} gate was released before the operation entered it`)
  }
  if (outcome.result.status === 'rejected') throw outcome.result.error
  throw new Error(`${label} settled before its gate was entered`)
}

async function settleOperation(operation, label) {
  return raceWithLimit([operation.outcome], label)
}

async function settleOwnedOperationsAndClose(f, gate, operations) {
  gate?.release()
  let failed = false
  let failure
  const unsettled = []
  const rememberFailure = (error) => {
    if (!failed) {
      failed = true
      failure = error
    }
  }

  for (const [operation, label] of operations) {
    if (!operation) continue
    try {
      await settleOperation(operation, label)
    } catch (error) {
      rememberFailure(error)
      unsettled.push([operation, label])
    }
  }
  let closeOperation
  try {
    closeOperation = observeOperation(Promise.resolve().then(() => f.close()))
    const closeOutcome = await settleOperation(closeOperation, 'fixture close')
    if (closeOutcome.status === 'rejected') throw closeOutcome.error
  } catch (error) {
    rememberFailure(error)
    if (closeOperation) unsettled.push([closeOperation, 'fixture close'])
  }
  for (const [operation, label] of unsettled) {
    try {
      const outcome = await settleOperation(operation, `${label} after fixture close`)
      if (label === 'fixture close' && outcome.status === 'rejected') {
        rememberFailure(outcome.error)
      }
    } catch (error) {
      rememberFailure(error)
    }
  }
  if (failed) throw failure
}

test('cleanup releases an entered gate and settles its operation after assertion failure', async () => {
  const gate = createReleaseGate()
  const operation = observeOperation(
    (async () => {
      await gate.pause()
      return 'released'
    })()
  )
  await expect(gate.entered).resolves.toBe('entered')

  const assertionFailure = new Error('injected assertion failure')
  let observedFailure
  try {
    throw assertionFailure
  } catch (error) {
    observedFailure = error
  }

  let closed = false
  await settleOwnedOperationsAndClose(
    {
      async close() {
        closed = true
      },
    },
    gate,
    [[operation, 'gated operation']]
  )
  expect(observedFailure).toBe(assertionFailure)
  expect(await operation.outcome).toEqual({ status: 'fulfilled', value: 'released' })
  expect(await gate.entered).toBe('entered')
  expect(closed).toBe(true)
})

test('cleanup settles an unused gate signal when an operation finishes early', async () => {
  const gate = createReleaseGate()
  const operationFailure = new Error('operation finished before reaching the gate')
  const operation = observeOperation(Promise.reject(operationFailure))
  let observedFailure
  try {
    await waitForGateOrOperation(gate.entered, operation, 'early operation')
  } catch (error) {
    observedFailure = error
  }

  let closed = false
  await settleOwnedOperationsAndClose(
    {
      async close() {
        closed = true
      },
    },
    gate,
    [[operation, 'early operation']]
  )
  expect(observedFailure).toBe(operationFailure)
  expect(await gate.entered).toBe('released')
  expect(await operation.outcome).toEqual({ status: 'rejected', error: operationFailure })
  expect(closed).toBe(true)
})

async function retryableChild(f, child) {
  const delegation = {
    ...child.delegation,
    policy: { ...child.delegation.policy, maximumRetries: 1 },
  }
  await child.allocator.allocate({
    request: child.request,
    receipt: child.receipt,
    execution: child.childExecution,
    attempt: child.childAttempt,
    delegation,
    assertCurrent: async () => undefined,
  })

  const delegations = new SqliteDelegationRepository(f.provider)
  const lifecycle = new ExecutionLifecycleService(new SqliteExecutionRepository(f.provider))
  const createService = (delegationRepository = delegations) =>
    new DelegationService({
      delegations: delegationRepository,
      lifecycle,
      plans: new SqliteExecutionPlanRepository(f.provider),
      events: { async publish() {} },
    })
  const service = createService()
  await service.dispatchChild(child.request.childDispatch)
  await service.recordChildProgress({
    delegationId: child.childIds.delegationId,
    childAttemptId: child.request.childAttemptId,
    state: 'running',
    observedAt: '2026-10-09T12:00:10.000Z',
  })
  return { service, createService, delegations, lifecycle }
}

async function expectSiblingDenialLeavesNoRows(f, sibling, expectedCode, budgetBefore, allocation) {
  const repository = new SqliteDelegationRepository(f.provider)
  const result =
    allocation ??
    sibling.allocator.allocate({
      request: sibling.request,
      receipt: sibling.receipt,
      execution: sibling.childExecution,
      attempt: sibling.childAttempt,
      delegation: sibling.delegation,
      assertCurrent: async () => undefined,
    })
  await expect(result).rejects.toMatchObject({ code: expectedCode })
  expect(await f.executions.getExecution(sibling.childIds.childExecutionId)).toBeUndefined()
  expect(await f.executions.getAttempt(sibling.request.childAttemptId)).toBeUndefined()
  expect(await repository.get(sibling.childIds.delegationId)).toBeUndefined()
  expect(await repository.findByChild(sibling.childIds.childExecutionId)).toBeUndefined()
  await expect(
    f.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(sibling.childIds.childExecutionId)
    )
  ).resolves.toBeUndefined()
  await expect(
    f.usageStore.transaction(ids.workspaceId, (tx) => tx.getBudget(ids.childExecutionId))
  ).resolves.toEqual(budgetBefore)
  await expect(repository.listByParent(ids.parentExecutionId)).resolves.toHaveLength(1)
}

const retryAdmissionRaces = [
  {
    limit: 'total',
    maximumTotal: 1,
    maximumParallel: 2,
    code: 'DELEGATION_LIMIT_EXCEEDED',
  },
  {
    limit: 'parallel',
    maximumTotal: 2,
    maximumParallel: 1,
    code: 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED',
  },
]

for (const scenario of retryAdmissionRaces) {
  test(`retrying child remains counted against the ${scenario.limit} limit when retry commits first`, async () => {
    const f = await fixture(scenario)
    let gate
    let allocation
    let retryProgress
    let failed = false
    let failure
    try {
      const childA = await f.childAdmission()
      const childB = await f.childAdmission()
      const retry = await retryableChild(f, childA)
      const budgetBefore = await f.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(childA.childIds.childExecutionId)
      )
      gate = gateProviderBeforeTransaction(f.provider)
      const sibling = {
        ...childB,
        allocator: new SqliteDelegationRepository(gate.provider),
      }
      allocation = observeOperation(
        sibling.allocator.allocate({
          request: sibling.request,
          receipt: sibling.receipt,
          execution: sibling.childExecution,
          attempt: sibling.childAttempt,
          delegation: sibling.delegation,
          assertCurrent: async () => undefined,
        })
      )
      await waitForGateOrOperation(gate.entered, allocation, 'sibling allocation')
      retryProgress = observeOperation(
        retry.service.recordChildProgress({
          delegationId: childA.childIds.delegationId,
          childAttemptId: childA.request.childAttemptId,
          state: 'failed',
          observedAt: '2026-10-09T12:00:20.000Z',
          failure: {
            classification: 'runtime_unavailable',
            code: 'RUNTIME_LOST',
            retryable: true,
          },
        })
      )
      const retryOutcome = await settleOperation(retryProgress, 'retry commit')
      if (retryOutcome.status === 'rejected') throw retryOutcome.error
      expect(retryOutcome.value).toMatchObject({
        resolution: 'retry',
        record: { state: 'requested', retryCount: 1 },
      })
      gate.release()
      await expectSiblingDenialLeavesNoRows(
        f,
        sibling,
        scenario.code,
        budgetBefore,
        allocation.promise
      )
    } catch (error) {
      failed = true
      failure = error
    }
    try {
      await settleOwnedOperationsAndClose(f, gate, [
        [allocation, 'sibling allocation cleanup'],
        [retryProgress, 'retry commit cleanup'],
      ])
    } catch (cleanupError) {
      if (!failed) {
        failed = true
        failure = cleanupError
      } else {
        console.error(
          'retry admission test cleanup failed after its assertion failed',
          cleanupError
        )
      }
    }
    if (failed) throw failure
  })

  test(`sibling admission sees the active child during a paused ${scenario.limit} retry commit`, async () => {
    const f = await fixture(scenario)
    let gate
    let allocation
    let retryProgress
    let failed = false
    let failure
    try {
      const childA = await f.childAdmission()
      const childB = await f.childAdmission()
      const retry = await retryableChild(f, childA)
      const budgetBefore = await f.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(childA.childIds.childExecutionId)
      )
      gate = gateBeforeRetryCommit(retry.delegations)
      const service = retry.createService(gate.repository)
      retryProgress = observeOperation(
        service.recordChildProgress({
          delegationId: childA.childIds.delegationId,
          childAttemptId: childA.request.childAttemptId,
          state: 'failed',
          observedAt: '2026-10-09T12:00:20.000Z',
          failure: {
            classification: 'runtime_unavailable',
            code: 'RUNTIME_LOST',
            retryable: true,
          },
        })
      )
      await waitForGateOrOperation(gate.entered, retryProgress, 'retry transition')
      expect(await retry.delegations.get(childA.childIds.delegationId)).toMatchObject({
        state: 'running',
        retryCount: 0,
        pendingProgress: { state: 'failed' },
      })
      expect(await f.executions.getAttempt(childA.request.childAttemptId)).toMatchObject({
        state: 'failed',
      })
      allocation = observeOperation(
        childB.allocator.allocate({
          request: childB.request,
          receipt: childB.receipt,
          execution: childB.childExecution,
          attempt: childB.childAttempt,
          delegation: childB.delegation,
          assertCurrent: async () => undefined,
        })
      )
      await expectSiblingDenialLeavesNoRows(
        f,
        childB,
        scenario.code,
        budgetBefore,
        allocation.promise
      )
      gate.release()
      const retryOutcome = await settleOperation(retryProgress, 'retry commit')
      if (retryOutcome.status === 'rejected') throw retryOutcome.error
      expect(retryOutcome.value).toMatchObject({
        resolution: 'retry',
        record: { state: 'requested', retryCount: 1 },
      })
    } catch (error) {
      failed = true
      failure = error
    }
    try {
      await settleOwnedOperationsAndClose(f, gate, [
        [allocation, 'sibling allocation cleanup'],
        [retryProgress, 'retry transition cleanup'],
      ])
    } catch (cleanupError) {
      if (!failed) {
        failed = true
        failure = cleanupError
      } else {
        console.error(
          'retry admission test cleanup failed after its assertion failed',
          cleanupError
        )
      }
    }
    if (failed) throw failure
  })
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

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

test('child authority reads go through the allocation transaction reader and match the repositories', async () => {
  const f = await fixture()
  try {
    const child = await f.childAdmission()
    const parentBefore = await child.executionRepository.getExecution(
      child.request.parentExecutionId
    )
    const attemptBefore = await child.executionRepository.getAttempt(child.request.parentAttemptId)
    let observed
    await expect(
      child.allocator.allocate({
        request: child.request,
        receipt: child.receipt,
        execution: child.childExecution,
        attempt: child.childAttempt,
        delegation: child.delegation,
        assertCurrent: async (reader) => {
          observed = {
            execution: await reader.getExecution(child.request.parentExecutionId),
            attempt: await reader.getAttempt(child.request.parentAttemptId),
            toolCall: await reader.getToolCall(child.request.admittedToolCallId),
          }
        },
      })
    ).resolves.toBe(true)
    expect(observed.execution).toEqual(parentBefore)
    expect(observed.attempt).toEqual(attemptBefore)
    expect(observed.toolCall).toBeUndefined()
    expect(
      await child.executionRepository.getExecution(child.childIds.childExecutionId)
    ).toBeDefined()
  } finally {
    await f.close()
  }
})

test('an unrelated reader stays outside an open child allocation fence until it commits', async () => {
  const f = await fixture()
  try {
    const child = await f.childAdmission()
    let fenceEntered
    const entered = new Promise((resolve) => (fenceEntered = resolve))
    let release
    const parked = new Promise((resolve) => (release = resolve))
    const allocation = child.allocator.allocate({
      request: child.request,
      receipt: child.receipt,
      execution: child.childExecution,
      attempt: child.childAttempt,
      delegation: child.delegation,
      assertCurrent: async (reader) => {
        await reader.getExecution(child.request.parentExecutionId)
        fenceEntered()
        await parked
      },
    })
    await entered
    let unrelatedSettled = false
    const unrelated = child.executionRepository
      .getExecution(child.childIds.childExecutionId)
      .then((value) => {
        unrelatedSettled = true
        return value
      })
    await pause(25)
    expect(unrelatedSettled).toBe(false)
    release()
    await expect(allocation).resolves.toBe(true)
    expect(await unrelated).toBeDefined()
  } finally {
    await f.close()
  }
})

test('a refused child fence leaves no canonical rows after restart', async () => {
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
        assertCurrent: async (reader) => {
          await reader.getExecution(child.request.parentExecutionId)
          throw new Error('revoked child audience')
        },
      })
    ).rejects.toThrow('revoked child audience')
    await f.provider.close()
    const reopened = new SqlitePersistenceProvider({ path: join(f.directory, 'state.sqlite') })
    await reopened.migrate()
    try {
      expect(
        await new SqliteExecutionRepository(reopened).getExecution(child.childIds.childExecutionId)
      ).toBeUndefined()
      expect(
        await new SqliteExecutionRepository(reopened).getAttempt(child.request.childAttemptId)
      ).toBeUndefined()
      expect(
        await new SqliteDelegationRepository(reopened).get(child.childIds.delegationId)
      ).toBeUndefined()
    } finally {
      await reopened.close()
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a committed child allocation and its transaction-bound reads survive restart', async () => {
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
        assertCurrent: async () => {},
      })
    ).resolves.toBe(true)
    await f.provider.close()
    const reopened = new SqlitePersistenceProvider({ path: join(f.directory, 'state.sqlite') })
    await reopened.migrate()
    try {
      const persisted = await new SqliteExecutionRepository(reopened).getExecution(
        child.childIds.childExecutionId
      )
      expect(persisted).toBeDefined()
      expect(
        await new SqliteDelegationRepository(reopened).findByChild(child.childIds.childExecutionId)
      ).toMatchObject({ delegationId: child.childIds.delegationId })
      const seen = await reopened.transaction(async (transaction) => {
        const reader = createSqliteChildAdmissionReader(transaction, ids.workspaceId)
        try {
          return await reader.getExecution(child.childIds.childExecutionId)
        } finally {
          reader.close()
        }
      })
      expect(seen).toEqual(persisted)
    } finally {
      await reopened.close()
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a child authority reader is unusable after its fence returns', async () => {
  const f = await fixture()
  try {
    const child = await f.childAdmission()
    let captured
    await child.allocator.allocate({
      request: child.request,
      receipt: child.receipt,
      execution: child.childExecution,
      attempt: child.childAttempt,
      delegation: child.delegation,
      assertCurrent: async (reader) => {
        captured = reader
      },
    })
    await expect(captured.getExecution(child.request.parentExecutionId)).rejects.toThrow(
      'CHILD_ADMISSION_READER_CLOSED'
    )
    await expect(captured.getToolCall(child.request.admittedToolCallId)).rejects.toThrow(
      'CHILD_ADMISSION_READER_CLOSED'
    )
  } finally {
    await f.close()
  }
})
