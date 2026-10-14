import { describe, expect, test } from 'bun:test'
import { CommandInboxService, InMemoryCommandAcceptanceRepository } from '@control-plane/domain'
import {
  createExecutionPlanTestFixture,
  createExecutionPlanTestFixtureInputs,
} from '@control-plane/execution-plan/testing'
import { ExecutionPlanCompiler, executionPlanBudgetAllowance } from '@control-plane/execution-plan'
import { childAllowanceStatementOf, DurableUsageLedger } from '@control-plane/usage-ledger'
import { DurableRuntimeBudgetAdmission } from './runtime-budget-admission.ts'

const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JABCDEF0123456789ABCDEFH',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  wrongAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
}

const acceptedAt = '2026-08-28T12:00:00.000Z'

describe('durable runtime budget admission', () => {
  test('reserves funded money and tokens once before an attempt, preserving read-only preflight', async () => {
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(store, ids.executionId)
    const allowance = await openAcceptedBudget(store, fixture)
    const guard = makeAdmission(store, fixture.repository)
    await guard.reserve(admissionInput(fixture))
    const ledger = new DurableUsageLedger({ store })
    const beforeReplay = await ledger.entries(allowance.workspaceId, allowance.executionId)
    expect(beforeReplay.filter((entry) => entry.kind === 'reservation')).toHaveLength(1)
    expect(await ledger.summary(allowance.workspaceId, allowance.executionId)).toMatchObject({
      reservedMicrounits: allowance.maximumMicrounits,
      reservedTokens: allowance.maximumTokens,
      availableMicrounits: 0,
      availableTokens: 0,
      spentMicrounits: 0,
      spentTokens: 0,
    })
    await guard.reserve(admissionInput(fixture))
    expect(await ledger.entries(allowance.workspaceId, allowance.executionId)).toEqual(beforeReplay)
    store.writeCalls = 0
    await guard.authorize(admissionInput(fixture))
    expect(store.writeCalls).toBe(0)
  })

  test('denies another attempt when its full funded envelope is already reserved', async () => {
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(store, ids.executionId)
    const allowance = await openAcceptedBudget(store, fixture)
    const guard = makeAdmission(store, fixture.repository)
    await guard.reserve(admissionInput(fixture))
    const input = admissionInput(fixture)
    input.attemptId = ids.wrongAttemptId
    input.execution.latestAttemptId = ids.wrongAttemptId
    await expect(guard.reserve(input)).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')
    const entries = await new DurableUsageLedger({ store }).entries(
      allowance.workspaceId,
      allowance.executionId
    )
    expect(entries.filter((entry) => entry.kind === 'reservation')).toHaveLength(1)
  })

  test('reserves remaining funded authority after another consumer and replays that same envelope', async () => {
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(store, ids.executionId)
    const allowance = await openAcceptedBudget(store, fixture)
    const ledger = new DurableUsageLedger({ store, now: () => acceptedAt })
    await ledger.reserve({
      workspaceId: allowance.workspaceId,
      executionId: allowance.executionId,
      reservationKey: 'other-consumer',
      maximumMicrounits: allowance.maximumMicrounits - 1,
      maximumTokens: allowance.maximumTokens - 1,
      source: { sourceId: 'other-consumer', idempotencyKey: 'other-consumer' },
    })
    const guard = makeAdmission(store, fixture.repository)
    const authority = await guard.reserve(admissionInput(fixture))
    const reservation = store.workspaces
      .get(allowance.workspaceId)
      .budgets.get(ids.executionId)
      .reservations.find((value) => value.attemptId === ids.attemptId)
    expect(reservation).toMatchObject({ maximumMicrounits: 1, maximumTokens: 1 })
    expect(authority).toEqual({
      schemaVersion: 1,
      workspaceId: allowance.workspaceId,
      executionId: allowance.executionId,
      attemptId: ids.attemptId,
      executionPlanId: fixture.plan.executionPlanId,
      executionPlanDigest: fixture.plan.contentDigest,
      reservationKey: `runtime-attempt:${ids.attemptId}`,
      currency: 'USD',
      maximumMicrounits: 1,
      maximumTokens: 1,
    })
    expect(Object.isFrozen(authority)).toBe(true)
    const entries = await ledger.entries(allowance.workspaceId, allowance.executionId)
    expect(await guard.reserve(admissionInput(fixture))).toEqual(authority)
    expect(await ledger.entries(allowance.workspaceId, allowance.executionId)).toEqual(entries)
  })

  test('a failed store commit cannot expose allocation authority or persist the reservation', async () => {
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(store, ids.executionId)
    const allowance = await openAcceptedBudget(store, fixture)
    const guard = makeAdmission(store, fixture.repository)
    store.failCommit = true
    await expect(guard.reserve(admissionInput(fixture))).rejects.toThrow(
      'RUNTIME_BUDGET_ADMISSION_DENIED'
    )
    expect(
      store.workspaces.get(allowance.workspaceId).budgets.get(ids.executionId).reservations
    ).toHaveLength(0)
    store.failCommit = false
    expect(await guard.reserve(admissionInput(fixture))).toMatchObject({
      attemptId: ids.attemptId,
      maximumTokens: allowance.maximumTokens,
      maximumMicrounits: allowance.maximumMicrounits,
    })
  })

  test('a settled attempt cannot regain released runtime authority through reservation replay', async () => {
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(store, ids.executionId)
    const allowance = await openAcceptedBudget(store, fixture)
    const guard = makeAdmission(store, fixture.repository)
    await guard.reserve(admissionInput(fixture))
    const reservation = store.workspaces.get(allowance.workspaceId).budgets.get(ids.executionId)
      .reservations[0]
    const ledger = new DurableUsageLedger({ store, now: () => acceptedAt })
    await ledger.settle({
      workspaceId: allowance.workspaceId,
      executionId: allowance.executionId,
      reservationKey: reservation.reservationKey,
      source: { sourceId: 'fixture:settle', idempotencyKey: 'fixture:settle' },
    })
    const entries = await ledger.entries(allowance.workspaceId, allowance.executionId)
    await expect(guard.reserve(admissionInput(fixture))).rejects.toThrow(
      'RUNTIME_BUDGET_ADMISSION_DENIED'
    )
    expect(await ledger.entries(allowance.workspaceId, allowance.executionId)).toEqual(entries)
  })

  test('uses the actual funded child envelope rather than the requested plan ceiling', async () => {
    const store = new TransactionalMemoryStore()
    const parent = await acceptedExecution(store, ids.executionId)
    const allowance = await openAcceptedBudget(store, parent)
    const ledger = new DurableUsageLedger({ store, now: () => acceptedAt })
    await ledger.reserve({
      workspaceId: allowance.workspaceId,
      executionId: allowance.executionId,
      reservationKey: 'parent-hold',
      maximumMicrounits: allowance.maximumMicrounits - 1,
      maximumTokens: allowance.maximumTokens - 1,
      source: { sourceId: 'parent-hold', idempotencyKey: 'parent-hold' },
    })
    const child = await acceptedExecution(store, ids.childExecutionId, {
      parentExecutionId: parent.execution.executionId,
    })
    await openAcceptedBudget(store, child)
    await makeAdmission(store, child.repository).reserve(admissionInput(child))
    expect(await ledger.summary(allowance.workspaceId, child.execution.executionId)).toMatchObject({
      maximumMicrounits: 1,
      maximumTokens: 1,
      reservedMicrounits: 1,
      reservedTokens: 1,
      availableMicrounits: 0,
      availableTokens: 0,
    })
  })

  test('reservation writes roll back together when their replay receipt cannot persist', async () => {
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(store, ids.executionId)
    const allowance = await openAcceptedBudget(store, fixture)
    store.failEffectWrites = true
    await expect(
      makeAdmission(store, fixture.repository).reserve(admissionInput(fixture))
    ).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')
    const ledger = new DurableUsageLedger({ store })
    expect(await ledger.summary(allowance.workspaceId, allowance.executionId)).toMatchObject({
      reservedMicrounits: 0,
      reservedTokens: 0,
    })
    expect(await ledger.entries(allowance.workspaceId, allowance.executionId)).toHaveLength(1)
  })
  test('allows a matching root allowance using one read-only store transaction', async () => {
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(store, ids.executionId)
    await openAcceptedBudget(store, fixture)
    store.transactionCalls = 0
    store.writeCalls = 0

    await expect(
      makeAdmission(store, fixture.repository).authorize(admissionInput(fixture))
    ).resolves.toBeUndefined()

    expect(store.transactionCalls).toBe(1)
    expect(store.writeCalls).toBe(0)
  })

  test('allows child maxima clamped by the parent while checking the original requested fingerprint', async () => {
    const store = new TransactionalMemoryStore()
    const parent = await acceptedExecution(store, ids.executionId)
    const ledger = new DurableUsageLedger({ store, now: () => acceptedAt })
    const parentAllowance = await openAcceptedBudget(store, parent)
    await ledger.reserve({
      workspaceId: parentAllowance.workspaceId,
      executionId: parentAllowance.executionId,
      reservationKey: 'parent-hold',
      maximumMicrounits: parentAllowance.maximumMicrounits - 1,
      maximumTokens: parentAllowance.maximumTokens - 1,
      source: { sourceId: 'parent-hold', idempotencyKey: 'parent-hold' },
    })

    const child = await acceptedExecution(store, ids.childExecutionId, {
      parentExecutionId: parent.execution.executionId,
    })
    const childAllowance = await openAcceptedBudget(store, child)
    expect(
      await ledger.summary(childAllowance.workspaceId, childAllowance.executionId)
    ).toMatchObject({
      maximumMicrounits: 1,
      maximumTokens: 1,
    })
    store.transactionCalls = 0

    await expect(
      makeAdmission(store, child.repository).authorize(admissionInput(child))
    ).resolves.toBeUndefined()
    expect(store.transactionCalls).toBe(1)
  })

  test('denies a missing accepted command or budget', async () => {
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(store, ids.executionId)
    const guard = makeAdmission(store, {
      getByExecutionId: async () => undefined,
    })
    await expect(guard.authorize(admissionInput(fixture))).rejects.toThrow(
      'RUNTIME_BUDGET_ADMISSION_DENIED'
    )

    await expect(
      makeAdmission(store, fixture.repository).authorize(admissionInput(fixture))
    ).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')
  })

  test('denies a settled budget and a missing opening receipt', async () => {
    const settledStore = new TransactionalMemoryStore()
    const settled = await acceptedExecution(settledStore, ids.executionId)
    const allowance = await openAcceptedBudget(settledStore, settled)
    await new DurableUsageLedger({ store: settledStore, now: () => acceptedAt }).finalizeBudget({
      workspaceId: allowance.workspaceId,
      executionId: allowance.executionId,
      source: { sourceId: 'finalize', idempotencyKey: 'finalize' },
    })
    await expect(
      makeAdmission(settledStore, settled.repository).authorize(admissionInput(settled))
    ).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')

    const missingReceiptStore = new TransactionalMemoryStore()
    const missingReceipt = await acceptedExecution(missingReceiptStore, ids.executionId)
    const missingAllowance = await openAcceptedBudget(missingReceiptStore, missingReceipt)
    await missingReceiptStore.deleteEffect(
      missingAllowance.workspaceId,
      missingAllowance.source.idempotencyKey
    )
    await expect(
      makeAdmission(missingReceiptStore, missingReceipt.repository).authorize(
        admissionInput(missingReceipt)
      )
    ).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')
  })

  test('denies a corrupted opening fingerprint and opening source', async () => {
    const fingerprintStore = new TransactionalMemoryStore()
    const fingerprintFixture = await acceptedExecution(fingerprintStore, ids.executionId)
    const fingerprintAllowance = await openAcceptedBudget(fingerprintStore, fingerprintFixture)
    await fingerprintStore.corruptEffect(
      fingerprintAllowance.workspaceId,
      fingerprintAllowance.source.idempotencyKey,
      (effect) => {
        effect.fingerprint = `sha256:${'f'.repeat(64)}`
      }
    )
    await expect(
      makeAdmission(fingerprintStore, fingerprintFixture.repository).authorize(
        admissionInput(fingerprintFixture)
      )
    ).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')

    const sourceStore = new TransactionalMemoryStore()
    const sourceFixture = await acceptedExecution(sourceStore, ids.executionId)
    const sourceAllowance = await openAcceptedBudget(sourceStore, sourceFixture)
    await sourceStore.corruptEntry(
      sourceAllowance.workspaceId,
      sourceAllowance.executionId,
      (entry) => {
        entry.source.sourceId = 'allocation:incorrect'
      }
    )
    await expect(
      makeAdmission(sourceStore, sourceFixture.repository).authorize(admissionInput(sourceFixture))
    ).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')
  })

  test('holds the plan child allowance out of the attempt envelope so a child can be funded', async () => {
    const childAllowance = { maximumMicrounits: 4_000_000, maximumTokens: 100_000 }
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(
      store,
      ids.executionId,
      {},
      planWithChildAllowance(childAllowance)
    )
    const allowance = await openAcceptedBudget(store, fixture)
    const guard = makeAdmission(store, fixture.repository)
    const authority = await guard.reserve(admissionInput(fixture))
    expect(authority).toMatchObject({
      maximumMicrounits: allowance.maximumMicrounits - childAllowance.maximumMicrounits,
      maximumTokens: allowance.maximumTokens - childAllowance.maximumTokens,
    })
    const ledger = new DurableUsageLedger({ store, now: () => acceptedAt })
    expect(await ledger.summary(allowance.workspaceId, allowance.executionId)).toMatchObject({
      maximumMicrounits: allowance.maximumMicrounits,
      reservedMicrounits: authority.maximumMicrounits,
      availableMicrounits: childAllowance.maximumMicrounits,
      availableTokens: childAllowance.maximumTokens,
    })
    // Replay reuses the same envelope and writes nothing.
    const entries = await ledger.entries(allowance.workspaceId, allowance.executionId)
    expect(await guard.reserve(admissionInput(fixture))).toEqual(authority)
    expect(await ledger.entries(allowance.workspaceId, allowance.executionId)).toEqual(entries)

    // The child is funded from the held-back share and cannot take more than it.
    const openChild = (maximumMicrounits, maximumTokens, source) =>
      ledger.openBudget({
        workspaceId: allowance.workspaceId,
        executionId: ids.childExecutionId,
        parentExecutionId: allowance.executionId,
        currency: 'USD',
        maximumMicrounits,
        maximumTokens,
        source: { sourceId: source, idempotencyKey: source },
      })
    expect(await openChild(8_000_000, 200_000, 'child-funding')).toMatchObject({
      maximumMicrounits: childAllowance.maximumMicrounits,
      maximumTokens: childAllowance.maximumTokens,
    })
    expect(await ledger.summary(allowance.workspaceId, allowance.executionId)).toMatchObject({
      reservedMicrounits: allowance.maximumMicrounits,
      availableMicrounits: 0,
      availableTokens: 0,
    })
    // The child's budget is its own: the parent's attempt envelope never moved.
    expect(
      store.workspaces
        .get(allowance.workspaceId)
        .budgets.get(ids.executionId)
        .reservations.find((value) => value.attemptId === ids.attemptId)
    ).toMatchObject({
      maximumMicrounits: authority.maximumMicrounits,
      maximumTokens: authority.maximumTokens,
    })
  })

  test('a later attempt keeps holding back only the part no child has been funded from yet', async () => {
    const childAllowance = { maximumMicrounits: 4_000_000, maximumTokens: 100_000 }
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(
      store,
      ids.executionId,
      {},
      planWithChildAllowance(childAllowance)
    )
    const allowance = await openAcceptedBudget(store, fixture)
    const guard = makeAdmission(store, fixture.repository)
    const first = await guard.reserve(admissionInput(fixture))
    const ledger = new DurableUsageLedger({ store, now: () => acceptedAt })
    await ledger.openBudget({
      workspaceId: allowance.workspaceId,
      executionId: ids.childExecutionId,
      parentExecutionId: allowance.executionId,
      currency: 'USD',
      maximumMicrounits: 1_000_000,
      maximumTokens: 25_000,
      source: { sourceId: 'child-funding', idempotencyKey: 'child-funding' },
    })
    await ledger.settle({
      workspaceId: allowance.workspaceId,
      executionId: allowance.executionId,
      reservationKey: first.reservationKey,
      source: { sourceId: 'first-settle', idempotencyKey: 'first-settle' },
    })
    const retry = admissionInput(fixture)
    retry.attemptId = ids.wrongAttemptId
    retry.execution.latestAttemptId = ids.wrongAttemptId
    const second = await guard.reserve(retry)
    // 10M ceiling, 1M funded to the child, 3M of the allowance still held back.
    expect(second).toMatchObject({
      maximumMicrounits: allowance.maximumMicrounits - 1_000_000 - 3_000_000,
      maximumTokens: allowance.maximumTokens - 25_000 - 75_000,
    })
    expect(await ledger.summary(allowance.workspaceId, allowance.executionId)).toMatchObject({
      availableMicrounits: 3_000_000,
      availableTokens: 75_000,
    })
  })

  test('shares one allowance between siblings: each is clamped to what is left, none can exceed it', async () => {
    const childAllowance = { maximumMicrounits: 4_000_000, maximumTokens: 100_000 }
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(
      store,
      ids.executionId,
      {},
      planWithChildAllowance(childAllowance)
    )
    const allowance = await openAcceptedBudget(store, fixture)
    const attempt = await makeAdmission(store, fixture.repository).reserve(admissionInput(fixture))
    const ledger = new DurableUsageLedger({ store, now: () => acceptedAt })
    const openSibling = (name, maximumMicrounits, maximumTokens) =>
      ledger.openBudget({
        workspaceId: allowance.workspaceId,
        executionId: siblingId(name),
        parentExecutionId: allowance.executionId,
        currency: 'USD',
        maximumMicrounits,
        maximumTokens,
        parentChildAllowance: childAllowanceStatementOf(fixture.plan.constraints.limits),
        source: { sourceId: `sibling-${name}`, idempotencyKey: `sibling-${name}` },
      })

    expect(await openSibling('a', 3_000_000, 60_000)).toMatchObject({
      maximumMicrounits: 3_000_000,
      maximumTokens: 60_000,
    })
    expect(await openSibling('b', 3_000_000, 60_000)).toMatchObject({
      maximumMicrounits: 1_000_000,
      maximumTokens: 40_000,
    })
    await expect(openSibling('c', 1_000_000, 10_000)).rejects.toThrow()
    // The siblings consumed exactly the stated allowance and never touched the attempt's share.
    expect(await ledger.summary(allowance.workspaceId, allowance.executionId)).toMatchObject({
      reservedMicrounits: allowance.maximumMicrounits,
      availableMicrounits: 0,
      availableTokens: 0,
    })
    expect(
      store.workspaces
        .get(allowance.workspaceId)
        .budgets.get(allowance.executionId)
        .reservations.find((value) => value.attemptId === ids.attemptId)
    ).toMatchObject({
      maximumMicrounits: attempt.maximumMicrounits,
      maximumTokens: attempt.maximumTokens,
    })
  })

  test('a settled child frees only what it did not spend, for a sibling and for a later attempt', async () => {
    const childAllowance = { maximumMicrounits: 4_000_000, maximumTokens: 100_000 }
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(
      store,
      ids.executionId,
      {},
      planWithChildAllowance(childAllowance)
    )
    const allowance = await openAcceptedBudget(store, fixture)
    const guard = makeAdmission(store, fixture.repository)
    const first = await guard.reserve(admissionInput(fixture))
    const ledger = new DurableUsageLedger({ store, now: () => acceptedAt })
    const openSibling = (name, maximumMicrounits, maximumTokens) =>
      ledger.openBudget({
        workspaceId: allowance.workspaceId,
        executionId: siblingId(name),
        parentExecutionId: allowance.executionId,
        currency: 'USD',
        maximumMicrounits,
        maximumTokens,
        parentChildAllowance: childAllowanceStatementOf(fixture.plan.constraints.limits),
        source: { sourceId: `sibling-${name}`, idempotencyKey: `sibling-${name}` },
      })
    await openSibling('a', 3_000_000, 60_000)
    // The first child spends 1M of its 3M and settles: the other 2M of its funding comes back.
    await spendAndFinalize(ledger, allowance.workspaceId, siblingId('a'), 1_000_000, 10_000)
    expect(await ledger.summary(allowance.workspaceId, allowance.executionId)).toMatchObject({
      spentMicrounits: 1_000_000,
      availableMicrounits: 3_000_000,
      availableTokens: 90_000,
    })
    // A sibling can use what is left of the allowance, counted at what the first child spent.
    expect(await openSibling('b', 5_000_000, 100_000)).toMatchObject({
      maximumMicrounits: 3_000_000,
      maximumTokens: 90_000,
    })

    // A later attempt, after the first one ends, holds back only the part still unfunded: the
    // second child is open at its ceiling and the first is counted at its spend.
    await ledger.settle({
      workspaceId: allowance.workspaceId,
      executionId: allowance.executionId,
      reservationKey: first.reservationKey,
      source: { sourceId: 'first-settle', idempotencyKey: 'first-settle' },
    })
    const retry = admissionInput(fixture)
    retry.attemptId = ids.wrongAttemptId
    retry.execution.latestAttemptId = ids.wrongAttemptId
    const second = await guard.reserve(retry)
    expect(second).toMatchObject({
      // 10M ceiling - 1M spent by the first child - 3M open for the second; the whole allowance is
      // now spent or funded, so nothing is still held back
      maximumMicrounits: allowance.maximumMicrounits - 1_000_000 - 3_000_000,
      maximumTokens: allowance.maximumTokens - 10_000 - 90_000,
    })
  })

  test('a settled lead reservation still cannot give children more than the stated allowance', async () => {
    const childAllowance = { maximumMicrounits: 4_000_000, maximumTokens: 100_000 }
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(
      store,
      ids.executionId,
      {},
      planWithChildAllowance(childAllowance)
    )
    const allowance = await openAcceptedBudget(store, fixture)
    const guard = makeAdmission(store, fixture.repository)
    const attempt = await guard.reserve(admissionInput(fixture))
    const ledger = new DurableUsageLedger({ store, now: () => acceptedAt })
    // Settling the lead reservation releases its whole envelope; this test does not transition the attempt.
    await ledger.settle({
      workspaceId: allowance.workspaceId,
      executionId: allowance.executionId,
      reservationKey: attempt.reservationKey,
      source: { sourceId: 'lead-settle', idempotencyKey: 'lead-settle' },
    })
    expect(await ledger.summary(allowance.workspaceId, allowance.executionId)).toMatchObject({
      availableMicrounits: allowance.maximumMicrounits,
      availableTokens: allowance.maximumTokens,
    })
    const openSibling = (name, maximumMicrounits, maximumTokens) =>
      ledger.openBudget({
        workspaceId: allowance.workspaceId,
        executionId: siblingId(name),
        parentExecutionId: allowance.executionId,
        currency: 'USD',
        maximumMicrounits,
        maximumTokens,
        parentChildAllowance: childAllowanceStatementOf(fixture.plan.constraints.limits),
        source: { sourceId: `sibling-${name}`, idempotencyKey: `sibling-${name}` },
      })
    // Asking for the whole plan ceiling yields the stated allowance, not the freed balance.
    expect(
      await openSibling('a', allowance.maximumMicrounits, allowance.maximumTokens)
    ).toMatchObject({
      maximumMicrounits: childAllowance.maximumMicrounits,
      maximumTokens: childAllowance.maximumTokens,
    })
    await expect(openSibling('b', 1, 1)).rejects.toThrow('BUDGET_EXHAUSTED')
    // Without the cap the same freed balance would have funded the sibling.
    expect(await ledger.summary(allowance.workspaceId, allowance.executionId)).toMatchObject({
      availableMicrounits: allowance.maximumMicrounits - childAllowance.maximumMicrounits,
    })
  })

  test('scales the allowance of a clamped child and lets a grandchild draw on that share', async () => {
    const childAllowance = { maximumMicrounits: 4_000_000, maximumTokens: 100_000 }
    const store = new TransactionalMemoryStore()
    const parent = await acceptedExecution(store, ids.executionId)
    const parentAllowance = await openAcceptedBudget(store, parent)
    const ledger = new DurableUsageLedger({ store, now: () => acceptedAt })
    // Leave the child only half of the money and tokens its plan asks for.
    const fundedMicrounits = parentAllowance.maximumMicrounits / 2
    const fundedTokens = parentAllowance.maximumTokens / 2
    await ledger.reserve({
      workspaceId: parentAllowance.workspaceId,
      executionId: parentAllowance.executionId,
      reservationKey: 'parent-hold',
      maximumMicrounits: parentAllowance.maximumMicrounits - fundedMicrounits,
      maximumTokens: parentAllowance.maximumTokens - fundedTokens,
      source: { sourceId: 'parent-hold', idempotencyKey: 'parent-hold' },
    })
    const child = await acceptedExecution(
      store,
      ids.childExecutionId,
      { parentExecutionId: parent.execution.executionId },
      planWithChildAllowance(childAllowance)
    )
    const childBudget = await openAcceptedBudget(store, child)
    expect(childBudget.maximumMicrounits).toBe(parentAllowance.maximumMicrounits)
    const attempt = await makeAdmission(store, child.repository).reserve(admissionInput(child))
    // Its plan holds back 4M of 10M; the child was funded half of 10M, so it holds back 2M of 5M.
    const heldMicrounits =
      (childAllowance.maximumMicrounits * fundedMicrounits) / childBudget.maximumMicrounits
    const heldTokens = (childAllowance.maximumTokens * fundedTokens) / childBudget.maximumTokens
    expect(attempt).toMatchObject({
      maximumMicrounits: fundedMicrounits - heldMicrounits,
      maximumTokens: fundedTokens - heldTokens,
    })
    expect(heldMicrounits).toBeGreaterThan(0)
    expect(attempt.maximumMicrounits).toBeGreaterThan(0)

    // A grandchild is funded only from that share and cannot take more.
    expect(
      await ledger.openBudget({
        workspaceId: parentAllowance.workspaceId,
        executionId: siblingId('grandchild'),
        parentExecutionId: child.execution.executionId,
        currency: 'USD',
        maximumMicrounits: parentAllowance.maximumMicrounits,
        maximumTokens: parentAllowance.maximumTokens,
        parentChildAllowance: childAllowanceStatementOf(child.plan.constraints.limits),
        source: { sourceId: 'grandchild', idempotencyKey: 'grandchild' },
      })
    ).toMatchObject({ maximumMicrounits: heldMicrounits, maximumTokens: heldTokens })
  })

  test('an allowance of a child clamped to almost nothing never leaves its attempt empty', async () => {
    const store = new TransactionalMemoryStore()
    const parent = await acceptedExecution(store, ids.executionId)
    const parentAllowance = await openAcceptedBudget(store, parent)
    const ledger = new DurableUsageLedger({ store, now: () => acceptedAt })
    await ledger.reserve({
      workspaceId: parentAllowance.workspaceId,
      executionId: parentAllowance.executionId,
      reservationKey: 'parent-hold',
      maximumMicrounits: parentAllowance.maximumMicrounits - 1,
      maximumTokens: parentAllowance.maximumTokens - 1,
      source: { sourceId: 'parent-hold', idempotencyKey: 'parent-hold' },
    })
    const child = await acceptedExecution(
      store,
      ids.childExecutionId,
      { parentExecutionId: parent.execution.executionId },
      planWithChildAllowance({ maximumMicrounits: 4_000_000, maximumTokens: 100_000 })
    )
    await openAcceptedBudget(store, child)
    // One microunit and one token cannot be split, so nothing is held back and the child runs.
    expect(
      await makeAdmission(store, child.repository).reserve(admissionInput(child))
    ).toMatchObject({ maximumMicrounits: 1, maximumTokens: 1 })
  })

  test('a plan that allows children but states no allowance cannot fund one while its full lead reservation is open', async () => {
    const store = new TransactionalMemoryStore()
    const inputs = createExecutionPlanTestFixtureInputs()
    inputs.constraints.limits.childExecutions = { maximumTotal: 1, maximumDepth: 1 }
    inputs.profile.definition.executionConstraints = structuredClone(inputs.constraints)
    const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
    expect(plan.constraints.limits.childExecutions.budgetAllowance).toBeUndefined()
    const fixture = await acceptedExecution(store, ids.executionId, {}, plan)
    const allowance = await openAcceptedBudget(store, fixture)
    expect(
      await makeAdmission(store, fixture.repository).reserve(admissionInput(fixture))
    ).toMatchObject({
      maximumMicrounits: allowance.maximumMicrounits,
      maximumTokens: allowance.maximumTokens,
    })
    await expect(
      new DurableUsageLedger({ store, now: () => acceptedAt }).openBudget({
        workspaceId: allowance.workspaceId,
        executionId: ids.childExecutionId,
        parentExecutionId: allowance.executionId,
        currency: 'USD',
        maximumMicrounits: 1,
        maximumTokens: 1,
        source: { sourceId: 'unfunded-child', idempotencyKey: 'unfunded-child' },
      })
    ).rejects.toThrow('BUDGET_EXHAUSTED')
  })

  test('without a child allowance the attempt still reserves everything that is left', async () => {
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(store, ids.executionId)
    expect(fixture.plan.constraints.limits.childExecutions.budgetAllowance).toBeUndefined()
    const allowance = await openAcceptedBudget(store, fixture)
    expect(
      await makeAdmission(store, fixture.repository).reserve(admissionInput(fixture))
    ).toMatchObject({
      maximumMicrounits: allowance.maximumMicrounits,
      maximumTokens: allowance.maximumTokens,
    })
  })

  test('denies a stale or malformed attempt identity', async () => {
    const store = new TransactionalMemoryStore()
    const fixture = await acceptedExecution(store, ids.executionId)
    await openAcceptedBudget(store, fixture)
    const admission = makeAdmission(store, fixture.repository)

    await expect(
      admission.authorize({ ...admissionInput(fixture), attemptId: ids.wrongAttemptId })
    ).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')
    await expect(
      admission.authorize({ ...admissionInput(fixture), attemptId: 'not-an-attempt' })
    ).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')
  })
})

function siblingId(name) {
  const suffix = { a: 'A', b: 'B', c: 'C', grandchild: 'G' }[name]
  return `exe_01JCBCDEF0123456789ABCDEF${suffix}`
}

/** A child reserves, spends and settles part of its own funding, then finalizes into its parent. */
async function spendAndFinalize(ledger, workspaceId, executionId, microunits, tokens) {
  const source = (name) => ({
    sourceId: `${executionId}:${name}`,
    idempotencyKey: `${executionId}:${name}`,
  })
  await ledger.reserve({
    workspaceId,
    executionId,
    attemptId: ids.attemptId,
    reservationKey: 'child-work',
    maximumMicrounits: microunits,
    maximumTokens: tokens,
    source: source('reserve'),
  })
  await ledger.charge({
    workspaceId,
    executionId,
    attemptId: ids.attemptId,
    reservationKey: 'child-work',
    kind: 'model_usage',
    quantity: { unit: 'tokens', value: tokens },
    costMicrounits: microunits,
    fundingSource: 'hq_managed',
    source: source('charge'),
  })
  await ledger.settle({
    workspaceId,
    executionId,
    reservationKey: 'child-work',
    source: source('settle'),
  })
  await ledger.finalizeBudget({ workspaceId, executionId, source: source('finalize') })
}

function planWithChildAllowance(budgetAllowance) {
  const inputs = createExecutionPlanTestFixtureInputs()
  inputs.constraints.limits.childExecutions = { maximumTotal: 1, maximumDepth: 1, budgetAllowance }
  inputs.profile.definition.executionConstraints = structuredClone(inputs.constraints)
  return new ExecutionPlanCompiler('1.0.0').compile(inputs)
}

async function acceptedExecution(
  store,
  executionId,
  extra = {},
  plan = createExecutionPlanTestFixture()
) {
  const repository = new InMemoryCommandAcceptanceRepository()
  const accepted = await new CommandInboxService({
    repository,
    executionIdFactory: () => executionId,
    executionPlanValidator: { validate: async () => true },
    now: () => acceptedAt,
  }).acceptExecution({
    callerPrincipalId: 'svc_runtime-budget-admission',
    operation: 'execution.accept',
    commandId:
      executionId === ids.executionId
        ? 'cmd_01JABCDEF0123456789ABCDEFG'
        : 'cmd_01JBBCDEF0123456789ABCDEFG',
    requestId: plan.correlation.requestId,
    idempotencyKey: `runtime-budget-admission-${executionId}`,
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
    },
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    },
    receivedAt: acceptedAt,
    retentionExpiresAt: '2026-09-27T12:00:00.000Z',
    ...extra,
  })
  return { ...accepted, plan, repository, store }
}

async function openAcceptedBudget(store, fixture) {
  const allowance = executionPlanBudgetAllowance(fixture.command, fixture.execution, fixture.plan)
  await new DurableUsageLedger({ store, now: () => acceptedAt }).openBudget(allowance)
  return allowance
}

function admissionInput(fixture) {
  return {
    execution: {
      ...fixture.execution,
      attemptCount: 1,
      latestAttemptId: ids.attemptId,
    },
    executionPlan: fixture.plan,
    attemptId: ids.attemptId,
  }
}

function makeAdmission(store, repository) {
  return new DurableRuntimeBudgetAdmission({ store, commands: repository })
}

class TransactionalMemoryStore {
  workspaces = new Map()
  transactionCalls = 0
  writeCalls = 0

  async transaction(workspaceId, operation) {
    this.transactionCalls += 1
    const persisted = this.workspaces.get(workspaceId) ?? emptyWorkspace()
    const draft = structuredCloneWorkspace(persisted)
    const transaction = {
      getBudget: async (executionId) => clone(draft.budgets.get(executionId)),
      putBudget: async (budget) => {
        this.writeCalls += 1
        draft.budgets.set(budget.executionId, clone(budget))
      },
      getEffect: async (idempotencyKey) => clone(draft.effects.get(idempotencyKey)),
      putEffect: async (effect) => {
        if (this.failEffectWrites) throw new Error('FIXTURE_RECEIPT_WRITE_FAILED')
        this.writeCalls += 1
        draft.effects.set(effect.idempotencyKey, clone(effect))
      },
      appendEntry: async (entry) => {
        this.writeCalls += 1
        const entries = draft.entries.get(entry.executionId) ?? []
        entries.push(clone(entry))
        draft.entries.set(entry.executionId, entries)
      },
      listEntries: async (executionId) => clone(draft.entries.get(executionId) ?? []),
    }
    const result = await operation(transaction)
    if (this.failCommit) throw new Error('FIXTURE_COMMIT_FAILED')
    this.workspaces.set(workspaceId, draft)
    return result
  }

  async corruptEffect(workspaceId, idempotencyKey, update) {
    update(this.workspaces.get(workspaceId)?.effects.get(idempotencyKey))
  }

  async corruptEntry(workspaceId, executionId, update) {
    const entry = this.workspaces.get(workspaceId)?.entries.get(executionId)?.[0]
    if (entry === undefined) throw new Error('test opening entry missing')
    update(entry)
  }

  async deleteEffect(workspaceId, idempotencyKey) {
    this.workspaces.get(workspaceId)?.effects.delete(idempotencyKey)
  }
}

function emptyWorkspace() {
  return { budgets: new Map(), effects: new Map(), entries: new Map() }
}

function structuredCloneWorkspace(workspace) {
  return {
    budgets: new Map([...workspace.budgets].map(([key, value]) => [key, clone(value)])),
    effects: new Map([...workspace.effects].map(([key, value]) => [key, clone(value)])),
    entries: new Map([...workspace.entries].map(([key, value]) => [key, clone(value)])),
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}
