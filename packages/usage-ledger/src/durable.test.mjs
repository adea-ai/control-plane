import { describe, expect, test } from 'bun:test'
import { DurableUsageLedger } from './durable.js'

const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  otherWorkspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JABCDEF0123456789ABCDEFH',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
}

const source = (id, idempotencyKey = id) => ({ sourceId: id, idempotencyKey })
const clone = (value) => structuredClone(value)

class TransactionalMemoryStore {
  #workspaces = new Map()
  #tails = new Map()

  failNextAppend = false
  failNextEffect = false

  async transaction(workspaceId, operation) {
    const previous = this.#tails.get(workspaceId) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.#tails.set(workspaceId, tail)
    await previous

    const persisted = this.#workspaces.get(workspaceId) ?? emptyWorkspace()
    const draft = clone(persisted)
    const transaction = {
      async getBudget(executionId) {
        return clone(draft.budgets.get(executionId))
      },
      async putBudget(budget) {
        if (budget.workspaceId !== workspaceId) throw new Error('workspace mismatch')
        draft.budgets.set(budget.executionId, clone(budget))
      },
      async getEffect(idempotencyKey) {
        return clone(draft.effects.get(idempotencyKey))
      },
      async putEffect(effect) {
        if (thisStore.failNextEffect) {
          thisStore.failNextEffect = false
          throw new Error('injected effect write failure')
        }
        if (effect.workspaceId !== workspaceId) throw new Error('workspace mismatch')
        draft.effects.set(effect.idempotencyKey, clone(effect))
      },
      async appendEntry(entry) {
        if (thisStore.failNextAppend) {
          thisStore.failNextAppend = false
          throw new Error('injected entry write failure')
        }
        if (entry.workspaceId !== workspaceId) throw new Error('workspace mismatch')
        for (const entries of draft.entries.values()) {
          if (
            entries.some(
              (existing) =>
                existing.source.idempotencyKey === entry.source.idempotencyKey ||
                existing.entryId === entry.entryId
            )
          ) {
            throw new Error('duplicate workspace ledger entry identity')
          }
        }
        const entries = draft.entries.get(entry.executionId) ?? []
        entries.push(clone(entry))
        draft.entries.set(entry.executionId, entries)
      },
      async listEntries(executionId) {
        return clone(draft.entries.get(executionId) ?? [])
      },
    }
    const thisStore = this

    try {
      const result = await operation(transaction)
      this.#workspaces.set(workspaceId, draft)
      return result
    } finally {
      release()
      if (this.#tails.get(workspaceId) === tail) this.#tails.delete(workspaceId)
    }
  }

  async snapshot(workspaceId) {
    return clone(this.#workspaces.get(workspaceId) ?? emptyWorkspace())
  }

  async corruptBudget(workspaceId, executionId, update) {
    const state = this.#workspaces.get(workspaceId)
    const budget = state?.budgets.get(executionId)
    if (!budget) throw new Error('budget not found in test store')
    update(budget)
  }

  async corruptEffect(workspaceId, idempotencyKey, update) {
    const state = this.#workspaces.get(workspaceId)
    const effect = state?.effects.get(idempotencyKey)
    if (!effect) throw new Error('effect not found in test store')
    update(effect)
  }
}

function emptyWorkspace() {
  return { budgets: new Map(), effects: new Map(), entries: new Map() }
}

function makeLedger(store) {
  return new DurableUsageLedger({
    store,
    now: () => '2026-09-27T12:00:00.000Z',
  })
}

function rootBudget(overrides = {}) {
  return {
    workspaceId: ids.workspaceId,
    executionId: ids.executionId,
    currency: 'USD',
    maximumMicrounits: 1_000,
    maximumTokens: 100,
    source: source('open-root'),
    ...overrides,
  }
}

describe('durable usage ledger', () => {
  test('reopens against the same store and replays identical effects after settlement and finalization', async () => {
    const store = new TransactionalMemoryStore()
    const ledger = makeLedger(store)
    const open = rootBudget()
    const opened = await ledger.openBudget(open)
    expect(Object.isFrozen(opened)).toBe(true)
    const openEntry = (await ledger.entries(ids.workspaceId, ids.executionId))[0]
    expect(openEntry.entryId).toMatch(/^usg_[0-9A-HJKMNP-TV-Z]{26}$/)
    const reopened = makeLedger(store)

    expect(await reopened.openBudget(open)).toEqual(opened)
    const reserve = {
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      reservationKey: 'model:one',
      maximumMicrounits: 800,
      maximumTokens: 80,
      source: source('reserve-one'),
    }
    const reserved = await reopened.reserve(reserve)
    expect(Object.isFrozen(reserved)).toBe(true)
    expect(await makeLedger(store).reserve(reserve)).toEqual(reserved)

    const charge = {
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      reservationKey: 'model:one',
      kind: 'model_usage',
      quantity: { unit: 'tokens', value: 30 },
      costMicrounits: 250,
      fundingSource: 'hq_managed',
      source: source('provider-one'),
    }
    const charged = await makeLedger(store).charge(charge)
    expect(Object.isFrozen(charged)).toBe(true)
    const settlementInput = {
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'model:one',
      source: source('settle-one'),
    }
    const settlement = await makeLedger(store).settle(settlementInput)
    expect(Object.isFrozen(settlement)).toBe(true)
    expect(await makeLedger(store).charge(charge)).toEqual(charged)
    expect(await makeLedger(store).settle(settlementInput)).toEqual(settlement)

    const finalizeInput = {
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      source: source('finalize-root'),
    }
    const finalized = await makeLedger(store).finalizeBudget(finalizeInput)
    expect(await makeLedger(store).finalizeBudget(finalizeInput)).toEqual(finalized)
    expect(finalized).toMatchObject({
      spentMicrounits: 250,
      spentTokens: 30,
      availableMicrounits: 750,
      availableTokens: 70,
      settled: true,
    })
  })

  test('replays the original opening summary after later activity and rejects altered opening receipts', async () => {
    const store = new TransactionalMemoryStore()
    const ledger = makeLedger(store)
    const open = rootBudget({ source: source('historical-open') })
    const opening = await ledger.openBudget(open)

    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'after-open',
      maximumMicrounits: 100,
      maximumTokens: 10,
      source: source('after-open-reserve'),
    })
    expect(await makeLedger(store).openBudget(open)).toEqual(opening)

    await store.corruptEffect(ids.workspaceId, 'historical-open', (effect) => {
      effect.result.spentMicrounits = 1
      effect.result.availableMicrounits -= 1
    })
    await expect(makeLedger(store).openBudget(open)).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })
  })

  test('replays a child opening allocation instead of recomputing from later parent availability', async () => {
    const store = new TransactionalMemoryStore()
    const ledger = makeLedger(store)
    await ledger.openBudget(rootBudget({ maximumMicrounits: 1_000, maximumTokens: 100 }))
    const childOpen = {
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      parentExecutionId: ids.executionId,
      currency: 'USD',
      maximumMicrounits: 800,
      maximumTokens: 80,
      source: source('historical-child-open'),
    }
    const opening = await ledger.openBudget(childOpen)

    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'after-child-open',
      maximumMicrounits: 100,
      maximumTokens: 10,
      source: source('after-child-open-parent-reserve'),
    })
    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      reservationKey: 'after-child-open-work',
      maximumMicrounits: 50,
      maximumTokens: 5,
      source: source('after-child-open-reserve'),
    })

    expect(await makeLedger(store).openBudget(childOpen)).toEqual(opening)
    await store.corruptEffect(ids.workspaceId, 'historical-child-open', (effect) => {
      effect.result.maximumMicrounits = 801
      effect.result.availableMicrounits = 801
    })
    await expect(makeLedger(store).openBudget(childOpen)).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })
  })

  test('binds child and parent finalized summaries to settled rollups after parent activity', async () => {
    const store = new TransactionalMemoryStore()
    const ledger = makeLedger(store)
    await ledger.openBudget(rootBudget({ maximumMicrounits: 1_000, maximumTokens: 100 }))

    const childOpen = {
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      parentExecutionId: ids.executionId,
      currency: 'USD',
      maximumMicrounits: 400,
      maximumTokens: 40,
      source: source('summary-child-open'),
    }
    await ledger.openBudget(childOpen)
    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      attemptId: ids.attemptId,
      reservationKey: 'summary-child-work',
      maximumMicrounits: 200,
      maximumTokens: 20,
      source: source('summary-child-reserve'),
    })
    await ledger.charge({
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      attemptId: ids.attemptId,
      reservationKey: 'summary-child-work',
      kind: 'model_usage',
      quantity: { unit: 'tokens', value: 4 },
      costMicrounits: 30,
      fundingSource: 'hq_managed',
      source: source('summary-child-charge'),
    })
    await ledger.settle({
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      reservationKey: 'summary-child-work',
      source: source('summary-child-settle'),
    })

    const childFinalize = {
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      source: source('summary-child-finalize'),
    }
    const childFinalized = await ledger.finalizeBudget(childFinalize)

    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'after-child-finalize',
      maximumMicrounits: 100,
      maximumTokens: 10,
      source: source('after-child-finalize-reserve'),
    })
    await ledger.charge({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      reservationKey: 'after-child-finalize',
      kind: 'tool_charge',
      quantity: { unit: 'tokens', value: 3 },
      costMicrounits: 7,
      fundingSource: 'hq_managed',
      source: source('after-child-finalize-charge'),
    })
    await ledger.settle({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'after-child-finalize',
      source: source('after-child-finalize-settle'),
    })

    expect(await makeLedger(store).finalizeBudget(childFinalize)).toEqual(childFinalized)

    const parentFinalize = {
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      source: source('summary-parent-finalize'),
    }
    const parentFinalized = await ledger.finalizeBudget(parentFinalize)
    expect(parentFinalized).toMatchObject({ spentMicrounits: 37, spentTokens: 7, settled: true })
    expect(await makeLedger(store).finalizeBudget(parentFinalize)).toEqual(parentFinalized)
    expect(await makeLedger(store).finalizeBudget(childFinalize)).toEqual(childFinalized)

    await store.corruptEffect(ids.workspaceId, 'summary-child-finalize', (effect) => {
      effect.result.spentTokens += 1
    })
    const childReplayError = await makeLedger(store)
      .finalizeBudget(childFinalize)
      .then(
        () => undefined,
        (error) => error
      )

    await store.corruptEffect(ids.workspaceId, 'summary-parent-finalize', (effect) => {
      effect.result.spentMicrounits += 1
      effect.result.availableMicrounits -= 1
    })
    const parentReplayError = await makeLedger(store)
      .finalizeBudget(parentFinalize)
      .then(
        () => undefined,
        (error) => error
      )
    expect([childReplayError?.code, parentReplayError?.code]).toEqual([
      'STORE_STATE_INVALID',
      'STORE_STATE_INVALID',
    ])
  })

  test('uses workspace-global method and input fingerprints to reject changed retries', async () => {
    const store = new TransactionalMemoryStore()
    const ledger = makeLedger(store)
    const open = rootBudget()
    await ledger.openBudget(open)

    await expect(
      ledger.openBudget({
        ...open,
        executionId: 'exe_01JABCDEF0123456789ABCDEFJ',
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(
      ledger.reserve({
        workspaceId: ids.workspaceId,
        executionId: ids.executionId,
        reservationKey: 'different-method',
        maximumMicrounits: 1,
        maximumTokens: 1,
        source: source('changed-method', 'open-root'),
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(
      ledger.openBudget({
        ...open,
        maximumMicrounits: 999,
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  test('serializes concurrent reservations and stores only one identical retry', async () => {
    const store = new TransactionalMemoryStore()
    const ledger = makeLedger(store)
    await ledger.openBudget(rootBudget({ maximumMicrounits: 100, maximumTokens: 100 }))

    const identical = {
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'same',
      maximumMicrounits: 50,
      maximumTokens: 50,
      source: source('same-reservation'),
    }
    const duplicateResults = await Promise.all([
      ledger.reserve(identical),
      makeLedger(store).reserve(identical),
    ])
    expect(duplicateResults[0]).toEqual(duplicateResults[1])

    const overbooked = await Promise.allSettled([
      ledger.reserve({
        ...identical,
        reservationKey: 'different-a',
        source: source('different-a'),
      }),
      ledger.reserve({
        ...identical,
        reservationKey: 'different-b',
        source: source('different-b'),
      }),
    ])
    expect(overbooked.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(overbooked.filter((result) => result.status === 'rejected')[0].reason.code).toBe(
      'BUDGET_EXHAUSTED'
    )
    const state = await store.snapshot(ids.workspaceId)
    expect(state.entries.get(ids.executionId)).toHaveLength(3)
  })

  test('rolls back budget, entry, sequence, and effect writes when the callback fails', async () => {
    const store = new TransactionalMemoryStore()
    const ledger = makeLedger(store)
    const input = rootBudget({ source: source('rollback-open') })

    store.failNextAppend = true
    await expect(ledger.openBudget(input)).rejects.toThrow('injected entry write failure')
    expect((await store.snapshot(ids.workspaceId)).budgets.has(ids.executionId)).toBe(false)

    store.failNextEffect = true
    await expect(ledger.openBudget(input)).rejects.toThrow('injected effect write failure')
    expect((await store.snapshot(ids.workspaceId)).budgets.has(ids.executionId)).toBe(false)

    const opened = await ledger.openBudget(input)
    expect(opened.executionId).toBe(ids.executionId)
    const entries = await ledger.entries(ids.workspaceId, ids.executionId)
    expect(entries).toHaveLength(1)
    expect(entries[0].sequence).toBe(1)
  })

  test('funds children from parent money and tokens, then releases unused child authority', async () => {
    const store = new TransactionalMemoryStore()
    const ledger = makeLedger(store)
    await ledger.openBudget(rootBudget({ maximumMicrounits: 100, maximumTokens: 100 }))
    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'parent-work',
      maximumMicrounits: 20,
      maximumTokens: 80,
      source: source('parent-reserve'),
    })

    const childOpen = {
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      parentExecutionId: ids.executionId,
      currency: 'USD',
      maximumMicrounits: 80,
      maximumTokens: 90,
      source: source('open-child'),
    }
    const child = await ledger.openBudget(childOpen)
    expect(child).toMatchObject({ maximumMicrounits: 80, maximumTokens: 20 })

    await expect(
      ledger.reserve({
        workspaceId: ids.workspaceId,
        executionId: ids.childExecutionId,
        reservationKey: 'too-much-money',
        maximumMicrounits: 81,
        maximumTokens: 1,
        source: source('too-much-money'),
      })
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
    await expect(
      ledger.reserve({
        workspaceId: ids.workspaceId,
        executionId: ids.childExecutionId,
        reservationKey: 'too-many-tokens',
        maximumMicrounits: 1,
        maximumTokens: 21,
        source: source('too-many-tokens'),
      })
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })

    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      attemptId: ids.attemptId,
      reservationKey: 'child-work',
      maximumMicrounits: 70,
      maximumTokens: 15,
      source: source('child-reserve'),
    })
    await ledger.charge({
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      attemptId: ids.attemptId,
      reservationKey: 'child-work',
      kind: 'model_usage',
      quantity: { unit: 'tokens', value: 5 },
      costMicrounits: 10,
      fundingSource: 'hq_managed',
      source: source('child-charge'),
    })
    await ledger.settle({
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      reservationKey: 'child-work',
      source: source('child-settle'),
    })

    await expect(
      ledger.finalizeBudget({
        workspaceId: ids.workspaceId,
        executionId: ids.executionId,
        source: source('premature-parent-finalize'),
      })
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INCOMPLETE' })

    const childFinalizeInput = {
      workspaceId: ids.workspaceId,
      executionId: ids.childExecutionId,
      source: source('finalize-child'),
    }
    const childFinal = await ledger.finalizeBudget(childFinalizeInput)
    expect(await makeLedger(store).finalizeBudget(childFinalizeInput)).toEqual(childFinal)
    expect(childFinal).toMatchObject({ spentMicrounits: 10, spentTokens: 5, settled: true })

    expect(await ledger.summary(ids.workspaceId, ids.executionId)).toMatchObject({
      spentMicrounits: 10,
      reservedMicrounits: 20,
      availableMicrounits: 70,
      spentTokens: 5,
      reservedTokens: 80,
      availableTokens: 15,
    })
    const parentEntries = await ledger.entries(ids.workspaceId, ids.executionId)
    expect(parentEntries.filter((entry) => entry.kind === 'model_usage')).toHaveLength(0)
    expect(
      parentEntries
        .filter((entry) => entry.reservationKey === `child:${ids.childExecutionId}`)
        .every((entry) => entry.attemptId === undefined)
    ).toBe(true)
    expect(
      parentEntries
        .filter((entry) => entry.reservationKey === `child:${ids.childExecutionId}`)
        .every((entry) => entry.parentExecutionId === undefined)
    ).toBe(true)

    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'use-released-authority',
      maximumMicrounits: 70,
      maximumTokens: 15,
      source: source('released-funds'),
    })
    await expect(
      ledger.finalizeBudget({
        workspaceId: ids.workspaceId,
        executionId: ids.executionId,
        source: source('still-premature'),
      })
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INCOMPLETE' })

    for (const reservationKey of ['parent-work', 'use-released-authority']) {
      await ledger.settle({
        workspaceId: ids.workspaceId,
        executionId: ids.executionId,
        reservationKey,
        source: source(`settle-${reservationKey}`),
      })
    }
    expect(
      await ledger.finalizeBudget({
        workspaceId: ids.workspaceId,
        executionId: ids.executionId,
        source: source('finalize-parent'),
      })
    ).toMatchObject({ settled: true, spentMicrounits: 10, spentTokens: 5 })
  })

  test('keeps missing and cross-workspace budgets indistinguishable', async () => {
    const ledger = makeLedger(new TransactionalMemoryStore())
    await ledger.openBudget(rootBudget())

    await expect(ledger.summary(ids.otherWorkspaceId, ids.executionId)).rejects.toMatchObject({
      code: 'BUDGET_NOT_FOUND',
    })
    await expect(
      ledger.summary(ids.otherWorkspaceId, 'exe_01JBBCDEF0123456789ABCDEFG')
    ).rejects.toMatchObject({ code: 'BUDGET_NOT_FOUND' })
    await expect(
      ledger.reserve({
        workspaceId: ids.otherWorkspaceId,
        executionId: ids.executionId,
        reservationKey: 'cross-tenant',
        maximumMicrounits: 1,
        maximumTokens: 1,
        source: source('cross-tenant'),
      })
    ).rejects.toMatchObject({ code: 'BUDGET_NOT_FOUND' })
  })

  test('fails closed on corrupted budget arithmetic and effect receipts', async () => {
    const store = new TransactionalMemoryStore()
    const ledger = makeLedger(store)
    await ledger.openBudget(rootBudget())
    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'corrupt-me',
      maximumMicrounits: 100,
      maximumTokens: 10,
      source: source('corrupt-reserve'),
    })

    await store.corruptBudget(ids.workspaceId, ids.executionId, (budget) => {
      budget.reservations[0].chargedMicrounits = 1
    })
    await expect(ledger.summary(ids.workspaceId, ids.executionId)).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })

    const effectStore = new TransactionalMemoryStore()
    const effectLedger = makeLedger(effectStore)
    const open = rootBudget({ source: source('corrupt-effect') })
    await effectLedger.openBudget(open)
    await effectStore.corruptEffect(ids.workspaceId, 'corrupt-effect', (effect) => {
      effect.fingerprint = 'sha256:invalid'
    })
    await expect(effectLedger.openBudget(open)).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })

    const entryStore = new TransactionalMemoryStore()
    const entryLedger = makeLedger(entryStore)
    await entryLedger.openBudget(rootBudget())
    await entryLedger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'receipt-entry',
      maximumMicrounits: 100,
      maximumTokens: 10,
      source: source('receipt-entry-reserve'),
    })
    const charge = {
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      reservationKey: 'receipt-entry',
      kind: 'tool_charge',
      quantity: { unit: 'calls', value: 1 },
      costMicrounits: 5,
      fundingSource: 'hq_managed',
      source: source('corrupt-entry-result'),
    }
    await entryLedger.charge(charge)
    await entryStore.corruptEffect(ids.workspaceId, 'corrupt-entry-result', (effect) => {
      effect.result.costMicrounits = 6
    })
    await expect(entryLedger.charge(charge)).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })
  })

  test('binds replayed entry receipts to the original operation identity', async () => {
    const store = new TransactionalMemoryStore()
    const ledger = makeLedger(store)
    await ledger.openBudget(rootBudget())
    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'receipt-binding',
      maximumMicrounits: 100,
      maximumTokens: 10,
      source: source('receipt-binding-reserve'),
    })

    const firstCharge = {
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      reservationKey: 'receipt-binding',
      kind: 'tool_charge',
      quantity: { unit: 'calls', value: 1 },
      costMicrounits: 5,
      fundingSource: 'hq_managed',
      source: source('receipt-binding-first'),
    }
    const firstEntry = await ledger.charge(firstCharge)
    const secondEntry = await ledger.charge({
      ...firstCharge,
      costMicrounits: 6,
      source: source('receipt-binding-second'),
    })
    expect(firstEntry.entryId).not.toBe(secondEntry.entryId)

    await store.corruptEffect(ids.workspaceId, 'receipt-binding-first', (effect) => {
      effect.result = clone(secondEntry)
    })
    await expect(ledger.charge(firstCharge)).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })
  })

  test('binds replayed settlement release totals to the immutable release entry', async () => {
    const store = new TransactionalMemoryStore()
    const ledger = makeLedger(store)
    await ledger.openBudget(rootBudget())
    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'release-binding',
      maximumMicrounits: 100,
      maximumTokens: 10,
      source: source('release-binding-reserve'),
    })
    await ledger.charge({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      reservationKey: 'release-binding',
      kind: 'tool_charge',
      quantity: { unit: 'calls', value: 1 },
      costMicrounits: 5,
      fundingSource: 'hq_managed',
      source: source('release-binding-charge'),
    })
    const settlement = {
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'release-binding',
      source: source('release-binding-settle'),
    }
    await ledger.settle(settlement)

    await store.corruptEffect(ids.workspaceId, 'release-binding-settle', (effect) => {
      effect.result.releasedMicrounits += 1
    })
    await expect(ledger.settle(settlement)).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })
  })

  test('rejects invalid and unsafe monetary or token values and external priced costs', async () => {
    const ledger = makeLedger(new TransactionalMemoryStore())
    await expect(ledger.openBudget(rootBudget({ currency: 'usd' }))).rejects.toMatchObject({
      code: 'INVALID_ENTRY',
    })
    await expect(
      ledger.openBudget(rootBudget({ maximumTokens: Number.MAX_SAFE_INTEGER + 1 }))
    ).rejects.toMatchObject({ code: 'INVALID_ENTRY' })
    await expect(ledger.openBudget({ ...rootBudget(), unexpected: true })).rejects.toMatchObject({
      code: 'INVALID_ENTRY',
    })
    await ledger.openBudget(rootBudget())
    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'external',
      maximumMicrounits: 50,
      maximumTokens: 50,
      source: source('external-reserve'),
    })
    await expect(
      ledger.charge({
        workspaceId: ids.workspaceId,
        executionId: ids.executionId,
        attemptId: ids.attemptId,
        reservationKey: 'external',
        kind: 'model_usage',
        quantity: { unit: 'tokens', value: 1 },
        costMicrounits: 1,
        fundingSource: 'external_subscription',
        source: source('priced-external'),
      })
    ).rejects.toMatchObject({ code: 'INVALID_ENTRY' })
  })

  test('classifies external subscription effects as zero-cost and non-exact', async () => {
    const ledger = makeLedger(new TransactionalMemoryStore())
    await ledger.openBudget(rootBudget())
    await ledger.reserve({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      reservationKey: 'external',
      maximumMicrounits: 100,
      maximumTokens: 100,
      source: source('external-reserve'),
    })
    const entry = await ledger.charge({
      workspaceId: ids.workspaceId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      reservationKey: 'external',
      kind: 'model_usage',
      quantity: { unit: 'tokens', value: 25 },
      costMicrounits: 0,
      fundingSource: 'external_subscription',
      source: source('external-charge'),
    })

    expect(entry).toMatchObject({
      fundingSource: 'external_subscription',
      costMicrounits: 0,
      costExact: false,
    })
    expect(await ledger.publicSummary(ids.workspaceId, ids.executionId)).toEqual({
      executionId: ids.executionId,
      currency: 'USD',
      funding: { hqManagedMicrounits: 0, externalSubscriptionEffects: 1 },
      usage: { tokens: 25 },
      settled: false,
    })
  })

  test('returns deeply immutable entries, summaries, and public summaries', async () => {
    const ledger = makeLedger(new TransactionalMemoryStore())
    await ledger.openBudget(rootBudget())
    const entries = await ledger.entries(ids.workspaceId, ids.executionId)
    const summary = await ledger.summary(ids.workspaceId, ids.executionId)
    const publicSummary = await ledger.publicSummary(ids.workspaceId, ids.executionId)

    expect(Object.isFrozen(entries)).toBe(true)
    expect(Object.isFrozen(entries[0])).toBe(true)
    expect(Object.isFrozen(entries[0].source)).toBe(true)
    expect(Object.isFrozen(summary)).toBe(true)
    expect(Object.isFrozen(publicSummary.funding)).toBe(true)
    expect(Object.isFrozen(publicSummary.usage)).toBe(true)
    expect(() => entries.push({})).toThrow()
    expect(() => {
      entries[0].source.sourceId = 'changed'
    }).toThrow()
  })
})
