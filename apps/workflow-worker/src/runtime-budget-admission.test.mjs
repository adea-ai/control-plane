import { describe, expect, test } from 'bun:test'
import { CommandInboxService, InMemoryCommandAcceptanceRepository } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { executionPlanBudgetAllowance } from '@control-plane/execution-plan'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
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

async function acceptedExecution(store, executionId, extra = {}) {
  const plan = createExecutionPlanTestFixture()
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
