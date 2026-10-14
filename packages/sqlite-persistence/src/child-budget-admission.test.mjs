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
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { SqliteDelegationRepository } from './delegation-repository.ts'
import { SqliteExecutionPlanRepository } from './repositories.ts'
import { SqliteExecutionRepository } from './repositories.ts'
import { SqlitePersistenceProvider } from './provider.ts'
import { createSqliteChildAdmissionReader } from './child-admission-reader.ts'
import { SqliteDurableUsageStore } from './usage-store.ts'
import { acceptedAt, fixture, ids } from './child-allocation-fixture.mjs'

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

test('child admission retains one mapping and receipt across duplicate allocation and reopen', async () => {
  const f = await fixture()
  let reopened
  try {
    const child = await f.childAdmission()
    const input = {
      request: child.request,
      receipt: child.receipt,
      execution: child.childExecution,
      attempt: child.childAttempt,
      delegation: child.delegation,
      assertCurrent: async () => undefined,
    }
    expect(await child.allocator.allocate(input)).toBe(true)
    expect(await child.allocator.allocate(input)).toBe(false)
    const retained = { request: child.request, receipt: child.receipt }
    expect(await child.allocator.getAdmissionReceipt(child.request.delegationId)).toEqual(retained)
    await f.provider.close()
    reopened = new SqlitePersistenceProvider({ path: join(f.directory, 'state.sqlite') })
    await reopened.migrate()
    const repository = new SqliteDelegationRepository(reopened)
    expect(await repository.getAdmissionReceipt(child.request.delegationId)).toEqual(retained)
    expect(await repository.getChildMapping(child.request.childAttemptId)).toEqual({
      workspaceId: ids.workspaceId,
      parentExecutionId: ids.parentExecutionId,
      delegationId: child.request.delegationId,
      childExecutionId: child.request.childExecutionId,
      childAttemptId: child.request.childAttemptId,
      runtimeConnectionId: child.request.childDispatch.runtime.runtimeConnectionId,
    })
    const receipt = await repository.getAdmissionReceipt(child.request.delegationId)
    receipt.request.role = 'mutated'
    expect(await repository.getAdmissionReceipt(child.request.delegationId)).toEqual(retained)
  } finally {
    await reopened?.close()
    await f.close()
  }
})

test('native child session binding is attempt-fenced and cannot rebind a retained session', async () => {
  const f = await fixture()
  try {
    const child = await f.childAdmission()
    const { delegations } = await retryableChild(f, child)
    const current = await delegations.get(child.request.delegationId)
    const mapping = {
      ...(await delegations.getChildMapping(child.request.childAttemptId)),
      externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
    }
    await expect(delegations.bindChildSession(current.revision - 1, mapping)).rejects.toThrow(
      'DELEGATION_CHILD_MAPPING_STALE'
    )
    for (const patch of [
      { workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' },
      { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
      { childAttemptId: 'att_01JDBCDEF0123456789ABCDEFG' },
    ])
      await expect(
        delegations.bindChildSession(current.revision, { ...mapping, ...patch })
      ).rejects.toThrow('DELEGATION_CHILD_MAPPING_STALE')
    expect(await delegations.bindChildSession(current.revision, mapping)).toEqual(mapping)
    expect(await delegations.bindChildSession(current.revision, mapping)).toEqual(mapping)
    expect(
      await delegations.findChildBySession(mapping.runtimeConnectionId, mapping.externalSessionId)
    ).toEqual(mapping)
    expect(
      await delegations.findChildBySession(
        'rtc_01JBBCDEF0123456789ABCDEFG',
        mapping.externalSessionId
      )
    ).toBeUndefined()
    await expect(
      delegations.bindChildSession(current.revision, {
        ...mapping,
        externalSessionId: 'ses_01JBBCDEF0123456789ABCDEFG',
      })
    ).rejects.toThrow('DELEGATION_CHILD_MAPPING_CONFLICT')
    expect(await delegations.getChildMapping(child.request.childAttemptId)).toEqual(mapping)
  } finally {
    await f.close()
  }
})

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
    expect(await child.allocator.getAdmissionReceipt(child.childIds.delegationId)).toBeUndefined()
    expect(await child.allocator.getChildMapping(child.request.childAttemptId)).toBeUndefined()
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

test('SQLite child admission fences preserve the parent budget across total, parallel, and depth denials', async () => {
  const fixtures = []
  const allocate = (child) =>
    child.allocator.allocate({
      request: child.request,
      receipt: child.receipt,
      execution: child.childExecution,
      attempt: child.childAttempt,
      delegation: child.delegation,
      assertCurrent: async () => undefined,
    })
  try {
    const total = await fixture({ maximumTotal: 1, maximumParallel: 2 })
    fixtures.push(total)
    const parallel = await fixture({ maximumTotal: 2, maximumParallel: 1 })
    fixtures.push(parallel)
    const depth = await fixture({ maximumTotal: 2, maximumParallel: 2, maximumDepth: 0 })
    fixtures.push(depth)

    const totalAdmitted = await total.childAdmission()
    const totalSibling = await total.childAdmission()
    await allocate(totalAdmitted)
    const totalBudgetBefore = await total.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    await expect(allocate(totalSibling)).rejects.toMatchObject({
      code: 'DELEGATION_LIMIT_EXCEEDED',
    })
    await expect(
      total.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(totalAdmitted.childIds.childExecutionId)
      )
    ).resolves.toBeDefined()
    await expect(
      total.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(totalSibling.childIds.childExecutionId)
      )
    ).resolves.toBeUndefined()
    await expect(
      total.usageStore.transaction(ids.workspaceId, (tx) => tx.getBudget(ids.parentExecutionId))
    ).resolves.toEqual(totalBudgetBefore)

    const parallelAdmitted = await parallel.childAdmission()
    const parallelSibling = await parallel.childAdmission()
    await allocate(parallelAdmitted)
    const parallelBudgetBefore = await parallel.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    await expect(allocate(parallelSibling)).rejects.toMatchObject({
      code: 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED',
    })
    await expect(
      parallel.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(parallelAdmitted.childIds.childExecutionId)
      )
    ).resolves.toBeDefined()
    await expect(
      parallel.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(parallelSibling.childIds.childExecutionId)
      )
    ).resolves.toBeUndefined()
    await expect(
      parallel.usageStore.transaction(ids.workspaceId, (tx) => tx.getBudget(ids.parentExecutionId))
    ).resolves.toEqual(parallelBudgetBefore)

    const tooDeep = await depth.childAdmission()
    const depthBudgetBefore = await depth.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    await expect(allocate(tooDeep)).rejects.toMatchObject({
      code: 'DELEGATION_DEPTH_EXCEEDED',
    })
    await expect(
      depth.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(tooDeep.childIds.childExecutionId)
      )
    ).resolves.toBeUndefined()
    await expect(
      depth.usageStore.transaction(ids.workspaceId, (tx) => tx.getBudget(ids.parentExecutionId))
    ).resolves.toEqual(depthBudgetBefore)
  } finally {
    await Promise.all(fixtures.map((item) => item.close()))
  }
})

test('manual Pi compaction persists its explicit summary in SQLite', async () => {
  const compactionDirectory = await mkdtemp(join(tmpdir(), 'pi-manual-compaction-'))
  const compactionStorage = await openNodeSqliteStorage(join(compactionDirectory, 'pi.sqlite'))
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage('The parent turn is recorded before compaction.'),
    fauxAssistantMessage('The recorded parent turn remains preserved in this summary.'),
  ])
  let harness
  try {
    harness = await Harness.open(
      compactionStorage,
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
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    })
    const firstTurn = await root.submit(
      {
        type: 'input',
        requestId: 'manual-compaction-child-fences:turn:1',
        content: 'Record the parent turn before manual compaction.',
      },
      BACKGROUND_CONTEXT
    )
    expect((await firstTurn.wait(BACKGROUND_CONTEXT)).status).toBe('done')
    expect(faux.state.callCount).toBe(1)

    const taskId = await root.compact('Preserve the recorded parent turn.', BACKGROUND_CONTEXT)
    const task = await harness.waitForTask(taskId, BACKGROUND_CONTEXT)
    expect(task.state.status).toBe('terminal')
    expect(task.state.outcome.status).toBe('completed')
    expect(task.state.outcome.result.submissionId).toBeDefined()
    const compactionSubmission = await harness.submission(
      task.state.outcome.result.submissionId,
      BACKGROUND_CONTEXT
    )
    expect(compactionSubmission).toBeDefined()
    expect((await compactionSubmission.wait(BACKGROUND_CONTEXT)).status).toBe('done')
    expect(faux.state.callCount).toBe(2)
    const compacted = await root.context(BACKGROUND_CONTEXT)
    const summary = compacted.entries.find((entry) => entry.kind === CompactionEntry.kind)
    expect(summary).toBeDefined()
    expect(JSON.stringify(summary)).toContain('recorded parent turn')
  } finally {
    await harness?.close(BACKGROUND_CONTEXT)
    await compactionStorage.close(BACKGROUND_CONTEXT)
    await rm(compactionDirectory, { recursive: true, force: true })
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
  const gate = createReleaseGate()
  let allocation
  let unrelated
  let failed = false
  let failure
  try {
    const child = await f.childAdmission()
    allocation = observeOperation(
      child.allocator.allocate({
        request: child.request,
        receipt: child.receipt,
        execution: child.childExecution,
        attempt: child.childAttempt,
        delegation: child.delegation,
        assertCurrent: async (reader) => {
          await reader.getExecution(child.request.parentExecutionId)
          await gate.pause()
        },
      })
    )
    await waitForGateOrOperation(gate.entered, allocation, 'child allocation fence')
    unrelated = observeOperation(
      Promise.resolve().then(() =>
        child.executionRepository.getExecution(child.childIds.childExecutionId)
      )
    )
    const readerRace = await raceWithLimit(
      [
        unrelated.outcome.then((result) => ({ status: 'operation', result })),
        new Promise((resolve) => setTimeout(() => resolve({ status: 'observation-window' }), 25)),
      ],
      'unrelated reader fence observation'
    )
    expect(readerRace.status).toBe('observation-window')
    expect(await gate.entered).toBe('entered')
    gate.release()
    const allocationOutcome = await settleOperation(allocation, 'child allocation')
    if (allocationOutcome.status === 'rejected') throw allocationOutcome.error
    expect(allocationOutcome.value).toBe(true)
    const unrelatedOutcome = await settleOperation(unrelated, 'unrelated reader')
    if (unrelatedOutcome.status === 'rejected') throw unrelatedOutcome.error
    expect(unrelatedOutcome.value).toBeDefined()
  } catch (error) {
    failed = true
    failure = error
  }
  try {
    await settleOwnedOperationsAndClose(f, gate, [
      [allocation, 'child allocation cleanup'],
      [unrelated, 'unrelated reader cleanup'],
    ])
  } catch (cleanupError) {
    if (!failed) {
      failed = true
      failure = cleanupError
    } else {
      console.error('allocation-fence cleanup failed after its assertion failed', cleanupError)
    }
  }
  if (failed) throw failure
})

test('allocation-fence cleanup releases parked work and preserves the original assertion failure', async () => {
  const f = await fixture()
  const gate = createReleaseGate()
  let allocation
  let unrelated
  let observedFailure
  const assertionFailure = new Error('injected allocation-fence assertion failure')
  try {
    const child = await f.childAdmission()
    allocation = observeOperation(
      child.allocator.allocate({
        request: child.request,
        receipt: child.receipt,
        execution: child.childExecution,
        attempt: child.childAttempt,
        delegation: child.delegation,
        assertCurrent: async (reader) => {
          await reader.getExecution(child.request.parentExecutionId)
          await gate.pause()
        },
      })
    )
    await waitForGateOrOperation(gate.entered, allocation, 'fault-path allocation fence')
    unrelated = observeOperation(
      Promise.resolve().then(() =>
        child.executionRepository.getExecution(child.childIds.childExecutionId)
      )
    )
    throw assertionFailure
  } catch (error) {
    observedFailure = error
  }

  let cleanupFailure
  try {
    await settleOwnedOperationsAndClose(f, gate, [
      [allocation, 'fault-path allocation cleanup'],
      [unrelated, 'fault-path unrelated reader cleanup'],
    ])
  } catch (error) {
    cleanupFailure = error
  }
  expect(observedFailure).toBe(assertionFailure)
  expect(cleanupFailure).toBeUndefined()
  expect(await allocation.outcome).toMatchObject({ status: 'fulfilled', value: true })
  expect(await unrelated.outcome).toMatchObject({ status: 'fulfilled' })
  expect(await gate.entered).toBe('entered')
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

test('a failed admission receipt write rolls back the mapping, execution and budget reservation', async () => {
  const f = await fixture()
  try {
    const child = await f.childAdmission()
    const repository = new SqliteDelegationRepository({
      transaction(operation) {
        return f.provider.transaction((tx) =>
          operation(
            new Proxy(tx, {
              get(target, key) {
                if (key === 'put')
                  return async (write) => {
                    if (write.namespace === 'delegation-admission-receipts')
                      throw new Error('receipt write failed')
                    return target.put(write)
                  }
                const value = target[key]
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          )
        )
      },
    })
    await expect(
      repository.allocate({
        request: child.request,
        receipt: child.receipt,
        execution: child.childExecution,
        attempt: child.childAttempt,
        delegation: child.delegation,
        assertCurrent: async () => undefined,
      })
    ).rejects.toThrow('receipt write failed')
    expect(await child.allocator.getAdmissionReceipt(child.request.delegationId)).toBeUndefined()
    expect(await child.allocator.getChildMapping(child.request.childAttemptId)).toBeUndefined()
    expect(
      await child.executionRepository.getExecution(child.request.childExecutionId)
    ).toBeUndefined()
    const budget = await child.usageStore.transaction(ids.workspaceId, (tx) =>
      tx.getBudget(ids.parentExecutionId)
    )
    expect(budget.reservations).toEqual([])
  } finally {
    await f.close()
  }
})

test('one native session cannot be assigned to two canonical child attempts', async () => {
  const f = await fixture({
    maximumTotal: 2,
    maximumParallel: 2,
    parentBudget: { maximumMicrounits: 20_000_000, maximumTokens: 500_000 },
  })
  try {
    const first = await f.childAdmission()
    const second = await f.childAdmission()
    const { delegations } = await retryableChild(f, first)
    await retryableChild(f, second)
    const mapping = {
      ...(await delegations.getChildMapping(first.request.childAttemptId)),
      externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
    }
    await delegations.bindChildSession(
      (await delegations.get(first.request.delegationId)).revision,
      mapping
    )
    const secondMapping = await delegations.getChildMapping(second.request.childAttemptId)
    await expect(
      delegations.bindChildSession((await delegations.get(second.request.delegationId)).revision, {
        ...secondMapping,
        externalSessionId: mapping.externalSessionId,
      })
    ).rejects.toThrow('DELEGATION_CHILD_MAPPING_CONFLICT')
    expect(await delegations.getChildMapping(second.request.childAttemptId)).toEqual(secondMapping)
    expect(
      await delegations.findChildBySession(mapping.runtimeConnectionId, mapping.externalSessionId)
    ).toEqual(mapping)
  } finally {
    await f.close()
  }
})
