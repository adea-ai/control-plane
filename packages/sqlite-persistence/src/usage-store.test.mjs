import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionSchema, ExecutionAttemptSchema } from '@control-plane/domain'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteDurableUsageStore, SQLITE_USAGE_NAMESPACES } from './usage-store.ts'
import { recordId } from './record-storage.ts'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const attemptId = 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const otherWorkspace = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW'

function budget() {
  return {
    schemaVersion: 1,
    workspaceId,
    executionId,
    currency: 'USD',
    maximumMicrounits: 1000,
    maximumTokens: 1000,
    status: 'open',
    nextSequence: 2,
    reservations: [
      {
        reservationKey: 'runtime',
        attemptId,
        maximumMicrounits: 100,
        maximumTokens: 100,
        chargedMicrounits: 0,
        chargedTokens: 0,
        status: 'open',
      },
    ],
  }
}

function entry() {
  return {
    entryId: 'usg_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    sequence: 1,
    workspaceId,
    executionId,
    attemptId,
    kind: 'reservation',
    source: { sourceId: 'runtime', idempotencyKey: 'reserve' },
    reservationKey: 'runtime',
    fundingSource: 'hq_managed',
    quantity: { unit: 'microunits', value: 100 },
    currency: 'USD',
    costMicrounits: 100,
    costExact: true,
    recordedAt: '2026-09-27T00:00:00.000Z',
  }
}

function effect() {
  return {
    schemaVersion: 1,
    workspaceId,
    executionId,
    idempotencyKey: 'reserve',
    fingerprint: `sha256:${'a'.repeat(64)}`,
    result: entry(),
  }
}

async function seedOwner(provider, overrides = {}, ownerAttemptId = attemptId) {
  const at = '2026-05-01T00:00:00.000Z'
  const owner = ExecutionSchema.parse({
    executionId,
    state: 'completed',
    version: 2,
    correlation: {
      workspaceId,
      projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    },
    executionPlan: {
      executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schemaVersion: 1,
    },
    attemptCount: 1,
    latestAttemptId: ownerAttemptId,
    acceptedAt: at,
    terminalAt: at,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  })
  const attempt = ExecutionAttemptSchema.parse({
    attemptId: ownerAttemptId,
    executionId: owner.executionId,
    state: 'completed',
    sequence: 1,
    version: 2,
    acceptedAt: at,
    terminalAt: at,
    createdAt: at,
    updatedAt: at,
  })
  await provider.transaction(async (tx) => {
    const existing = await tx.get('executions', recordId(owner.executionId))
    await tx.put({
      namespace: 'executions',
      id: recordId(owner.executionId),
      value: owner,
      ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
    })
    const existingAttempt = await tx.get('execution-attempts', recordId(ownerAttemptId))
    if (existingAttempt === undefined)
      await tx.put({
        namespace: 'execution-attempts',
        id: recordId(ownerAttemptId),
        value: attempt,
      })
  })
}

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-durable-usage-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    await seedOwner(provider)
    await run(provider, new SqliteDurableUsageStore(provider))
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('SQLite durable usage transactions', () => {
  test('preserves a failed operation error while rolling back bound writes', async () => {
    await withStore(async (provider) => {
      const failure = new Error('BOUND_USAGE_ORIGINAL_FAILURE')
      await expect(
        provider.transaction((transaction) =>
          SqliteDurableUsageStore.withTransaction(transaction, workspaceId, (store) =>
            store.transaction(workspaceId, async (usage) => {
              await usage.putBudget(budget())
              throw failure
            })
          )
        )
      ).rejects.toBe(failure)
      expect(
        await provider.transaction((transaction) =>
          transaction.list(SQLITE_USAGE_NAMESPACES.budgets)
        )
      ).toEqual([])
    })
  })

  test('uses the caller transaction and rolls back owner and budget writes together', async () => {
    await withStore(async (provider) => {
      const ownerRecordId = recordId(executionId)
      const before = await provider.transaction((transaction) =>
        transaction.get('executions', ownerRecordId)
      )

      await expect(
        provider.transaction(async (transaction) => {
          const owner = await transaction.get('executions', ownerRecordId)
          await transaction.put({
            namespace: 'executions',
            id: ownerRecordId,
            expectedRevision: owner.revision,
            value: {
              ...owner.value,
              updatedAt: '2026-05-02T00:00:00.000Z',
              version: owner.value.version + 1,
            },
          })

          await SqliteDurableUsageStore.withTransaction(transaction, workspaceId, async (store) => {
            try {
              await store.transaction(workspaceId, async (usage) => {
                await usage.putBudget(budget())
                throw new Error('BOUND_USAGE_CALLBACK_FAILURE')
              })
            } catch (error) {
              expect(error.message).toBe('BOUND_USAGE_CALLBACK_FAILURE')
            }
          })
        })
      ).rejects.toThrow('STORE_STATE_INVALID')

      const after = await provider.transaction(async (transaction) => ({
        owner: await transaction.get('executions', ownerRecordId),
        budgets: await transaction.list(SQLITE_USAGE_NAMESPACES.budgets),
      }))
      expect(after.owner).toEqual(before)
      expect(after.budgets).toEqual([])
    })
  })

  test('bounds callback stores and transaction methods to a single scoped operation', async () => {
    await withStore(async (provider) => {
      let escapedStore
      let escapedTransaction
      await provider.transaction(async (transaction) => {
        await SqliteDurableUsageStore.withTransaction(transaction, workspaceId, async (store) => {
          escapedStore = store
          await expect(store.transaction(otherWorkspace, async () => undefined)).rejects.toThrow(
            'USAGE_LEDGER_SCOPE_MISMATCH'
          )

          await store.transaction(workspaceId, async (usage) => {
            escapedTransaction = usage
            await expect(store.transaction(workspaceId, async () => undefined)).rejects.toThrow(
              'STORE_STATE_INVALID'
            )
          })

          await expect(escapedTransaction.getBudget(executionId)).rejects.toThrow(
            'STORE_STATE_INVALID'
          )
          await expect(escapedTransaction.putBudget(budget())).rejects.toThrow(
            'STORE_STATE_INVALID'
          )
        })
      })

      await expect(escapedStore.transaction(workspaceId, async () => undefined)).rejects.toThrow(
        'STORE_STATE_INVALID'
      )
    })
  })

  test('drains pending callback operations before rejecting and rolling back the enclosing transaction', async () => {
    await withStore(async (provider) => {
      let escapedOperation
      await expect(
        provider.transaction(async (transaction) => {
          await SqliteDurableUsageStore.withTransaction(transaction, workspaceId, (store) => {
            escapedOperation = store.transaction(workspaceId, async (usage) => {
              await new Promise((resolve) => setTimeout(resolve, 0))
              return usage.getBudget(executionId)
            })
          })
        })
      ).rejects.toThrow('STORE_STATE_INVALID')

      await expect(escapedOperation).rejects.toThrow('STORE_STATE_INVALID')
      await expect(
        provider.transaction((transaction) => transaction.list(SQLITE_USAGE_NAMESPACES.budgets))
      ).resolves.toEqual([])
    })
  })

  test('commits budget, immutable entry, sequence and receipt together across reopen', async () => {
    await withStore(async (provider, store) => {
      await store.transaction(workspaceId, async (tx) => {
        await tx.putBudget(budget())
        await tx.appendEntry(entry())
        await tx.putEffect(effect())
      })
      provider.close()
      await provider.migrate()
      const reopened = new SqliteDurableUsageStore(provider)
      await reopened.transaction(workspaceId, async (tx) => {
        expect(await tx.getBudget(executionId)).toEqual(budget())
        expect(await tx.getEffect('reserve')).toEqual(effect())
        expect(await tx.listEntries(executionId)).toEqual([entry()])
        await tx.appendEntry(entry())
        await tx.putEffect(effect())
        await expect(tx.appendEntry({ ...entry(), costMicrounits: 101 })).rejects.toThrow(
          'IDEMPOTENCY_CONFLICT'
        )
        await expect(tx.putEffect({ ...effect(), result: null })).rejects.toThrow(
          'IDEMPOTENCY_CONFLICT'
        )
      })
      for (const namespace of Object.values(SQLITE_USAGE_NAMESPACES)) {
        expect(await provider.transaction((tx) => tx.list(namespace))).toHaveLength(1)
      }
    })
  })

  test('a lost receipt commit rolls back every namespace and can be retried', async () => {
    await withStore(async (provider, store) => {
      await expect(
        store.transaction(workspaceId, async (tx) => {
          await tx.putBudget(budget())
          await tx.appendEntry(entry())
          await tx.putEffect(effect())
          throw new Error('LOST_TRANSACTION_COMMIT')
        })
      ).rejects.toThrow('LOST_TRANSACTION_COMMIT')
      for (const namespace of Object.values(SQLITE_USAGE_NAMESPACES)) {
        expect(await provider.transaction((tx) => tx.list(namespace))).toHaveLength(0)
      }
      await store.transaction(workspaceId, async (tx) => {
        await tx.putBudget(budget())
        await tx.appendEntry(entry())
        await tx.putEffect(effect())
      })
      expect(await store.transaction(workspaceId, (tx) => tx.listEntries(executionId))).toEqual([
        entry(),
      ])
    })
  })

  test('checks owner workspace, parent attribution and attempt identity on writes', async () => {
    await withStore(async (provider, store) => {
      await expect(
        store.transaction(otherWorkspace, (tx) =>
          tx.putBudget({ ...budget(), workspaceId: otherWorkspace })
        )
      ).rejects.toThrow('USAGE_LEDGER_SCOPE_MISMATCH')
      await expect(
        store.transaction(workspaceId, (tx) =>
          tx.appendEntry({ ...entry(), attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
        )
      ).rejects.toThrow('USAGE_LEDGER_SCOPE_MISMATCH')
      await seedOwner(provider, { parentExecutionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
      await expect(store.transaction(workspaceId, (tx) => tx.putBudget(budget()))).rejects.toThrow(
        'USAGE_LEDGER_SCOPE_MISMATCH'
      )
      await expect(store.transaction(workspaceId, (tx) => tx.appendEntry(entry()))).rejects.toThrow(
        'USAGE_LEDGER_SCOPE_MISMATCH'
      )
      expect(
        await store.transaction(otherWorkspace, (tx) => tx.getBudget(executionId))
      ).toBeUndefined()
      expect(await store.transaction(otherWorkspace, (tx) => tx.listEntries(executionId))).toEqual(
        []
      )
    })
  })

  test('does not overwrite corrupt persisted budget or effect state', async () => {
    await withStore(async (provider, store) => {
      await store.transaction(workspaceId, async (tx) => {
        await tx.putBudget(budget())
        await tx.putEffect(effect())
      })
      await provider.transaction(async (tx) => {
        for (const namespace of [
          SQLITE_USAGE_NAMESPACES.budgets,
          SQLITE_USAGE_NAMESPACES.effects,
        ]) {
          const [record] = await tx.list(namespace)
          await tx.put({
            namespace,
            id: record.id,
            expectedRevision: record.revision,
            value: { schemaVersion: 999 },
          })
        }
      })
      await expect(
        store.transaction(workspaceId, (tx) => tx.getBudget(executionId))
      ).rejects.toThrow('STORE_STATE_INVALID')
      await expect(store.transaction(workspaceId, (tx) => tx.putBudget(budget()))).rejects.toThrow(
        'STORE_STATE_INVALID'
      )
      await expect(store.transaction(workspaceId, (tx) => tx.getEffect('reserve'))).rejects.toThrow(
        'STORE_STATE_INVALID'
      )
      await expect(store.transaction(workspaceId, (tx) => tx.putEffect(effect()))).rejects.toThrow(
        'STORE_STATE_INVALID'
      )
    })
  })

  test('rejects canonical owner and attempt payloads stored under another identity', async () => {
    for (const namespace of ['executions', 'execution-attempts']) {
      await withStore(async (provider, store) => {
        const id = recordId(namespace === 'executions' ? executionId : attemptId)
        await provider.transaction(async (tx) => {
          const record = await tx.get(namespace, id)
          await tx.put({
            namespace,
            id,
            expectedRevision: record.revision,
            value: {
              ...record.value,
              ...(namespace === 'executions'
                ? { executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW' }
                : { attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW' }),
            },
          })
        })
        await expect(
          store.transaction(workspaceId, (tx) => tx.appendEntry(entry()))
        ).rejects.toThrow('USAGE_LEDGER_SCOPE_MISMATCH')
        expect(
          await provider.transaction((tx) => tx.list(SQLITE_USAGE_NAMESPACES.entries))
        ).toHaveLength(0)
      })
    }
  })

  test('fails closed instead of silently omitting missing or scope-damaged indexed entries', async () => {
    for (const damage of [
      'missing-entry',
      'entry-workspace',
      'entry-execution',
      'missing-index',
      'index-workspace',
      'missing-pair',
    ]) {
      await withStore(async (provider, store) => {
        await store.transaction(workspaceId, async (tx) => {
          await tx.putBudget(budget())
          await tx.appendEntry(entry())
        })
        await provider.transaction(async (tx) => {
          if (damage === 'missing-pair') {
            for (const namespace of [
              SQLITE_USAGE_NAMESPACES.entries,
              SQLITE_USAGE_NAMESPACES.sequences,
            ]) {
              const [record] = await tx.list(namespace)
              await tx.delete(namespace, record.id, record.revision)
            }
            return
          }
          const namespace =
            damage.startsWith('index') || damage === 'missing-index'
              ? SQLITE_USAGE_NAMESPACES.sequences
              : SQLITE_USAGE_NAMESPACES.entries
          const [record] = await tx.list(namespace)
          if (damage.startsWith('missing')) {
            await tx.delete(namespace, record.id, record.revision)
          } else {
            await tx.put({
              namespace,
              id: record.id,
              expectedRevision: record.revision,
              value: {
                ...record.value,
                ...(damage === 'entry-execution'
                  ? { executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW' }
                  : { workspaceId: otherWorkspace }),
              },
            })
          }
        })
        await expect(
          store.transaction(workspaceId, (tx) => tx.listEntries(executionId))
        ).rejects.toThrow('STORE_STATE_INVALID')
      })
    }
  })

  test('native reopen rejects persisted attempts reassigned to another execution', async () => {
    await withStore(async (provider) => {
      const store = new SqliteDurableUsageStore(provider)
      await store.transaction(workspaceId, async (tx) => {
        await tx.putBudget(budget())
        await tx.appendEntry(entry())
      })
      await provider.transaction(async (tx) => {
        const id = recordId(attemptId)
        const record = await tx.get('execution-attempts', id)
        await tx.put({
          namespace: 'execution-attempts',
          id,
          expectedRevision: record.revision,
          value: { ...record.value, executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
        })
      })
      await provider.close()
      await provider.migrate()
      const reopened = new SqliteDurableUsageStore(provider)
      await expect(
        reopened.transaction(workspaceId, (tx) => tx.listEntries(executionId))
      ).rejects.toThrow('STORE_STATE_INVALID')
    })
  })

  test('ordered reads preserve valid foreign-workspace entry pairs without exposing them', async () => {
    await withStore(async (provider, store) => {
      await store.transaction(workspaceId, async (tx) => {
        await tx.putBudget(budget())
        await tx.appendEntry(entry())
      })
      const foreignExecutionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW'
      const foreignAttemptId = 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW'
      const owner = await provider.transaction((tx) => tx.get('executions', recordId(executionId)))
      await seedOwner(
        provider,
        {
          executionId: foreignExecutionId,
          correlation: { ...owner.value.correlation, workspaceId: otherWorkspace },
        },
        foreignAttemptId
      )
      const foreignEntry = {
        ...entry(),
        entryId: 'usg_01ARZ3NDEKTSV4RRFFQ69G5FAW',
        workspaceId: otherWorkspace,
        executionId: foreignExecutionId,
        attemptId: foreignAttemptId,
      }
      await store.transaction(otherWorkspace, async (tx) => {
        await tx.putBudget({
          ...budget(),
          workspaceId: otherWorkspace,
          executionId: foreignExecutionId,
          reservations: [{ ...budget().reservations[0], attemptId: foreignAttemptId }],
        })
        await tx.appendEntry(foreignEntry)
      })
      expect(await store.transaction(workspaceId, (tx) => tx.listEntries(executionId))).toEqual([
        entry(),
      ])
      expect(
        await store.transaction(workspaceId, (tx) => tx.listEntries(foreignExecutionId))
      ).toEqual([])
      expect(
        await store.transaction(otherWorkspace, (tx) => tx.listEntries(foreignExecutionId))
      ).toEqual([foreignEntry])
    })
  })

  test('native reopen rejects schema-valid altered replay receipts without changing entries', async () => {
    const { DurableUsageLedger } = await import('@control-plane/usage-ledger')
    await withStore(async (provider, store) => {
      const ledger = new DurableUsageLedger({ store })
      const source = (idempotencyKey) => ({ sourceId: 'receipt-integrity', idempotencyKey })
      const openInput = {
        workspaceId,
        executionId,
        currency: 'USD',
        maximumMicrounits: 1000,
        maximumTokens: 100,
        source: source('open'),
      }
      const opening = await ledger.openBudget(openInput)
      await ledger.reserve({
        workspaceId,
        executionId,
        attemptId,
        reservationKey: 'provider',
        maximumMicrounits: 800,
        maximumTokens: 80,
        source: source('reserve'),
      })
      const chargeInput = {
        workspaceId,
        executionId,
        attemptId,
        reservationKey: 'provider',
        kind: 'model_usage',
        quantity: { unit: 'tokens', value: 10 },
        costMicrounits: 100,
        fundingSource: 'hq_managed',
        source: source('charge-one'),
      }
      const charge = await ledger.charge(chargeInput)
      const otherCharge = await ledger.charge({ ...chargeInput, source: source('charge-two') })
      const settleInput = {
        workspaceId,
        executionId,
        reservationKey: 'provider',
        source: source('settle'),
      }
      const settlement = await ledger.settle(settleInput)
      const finalizeInput = { workspaceId, executionId, source: source('finalize') }
      const finalized = await ledger.finalizeBudget(finalizeInput)
      const before = await ledger.entries(workspaceId, executionId)
      for (const [key, corruptedResult, replay, expected] of [
        [
          'open',
          { ...opening, spentTokens: 1, availableTokens: opening.availableTokens - 1 },
          (reopened) => reopened.openBudget(openInput),
          opening,
        ],
        ['charge-one', otherCharge, (reopened) => reopened.charge(chargeInput), charge],
        [
          'settle',
          { ...settlement, releasedMicrounits: settlement.releasedMicrounits + 1 },
          (reopened) => reopened.settle(settleInput),
          settlement,
        ],
        [
          'finalize',
          { ...finalized, spentTokens: finalized.spentTokens + 1 },
          (reopened) => reopened.finalizeBudget(finalizeInput),
          finalized,
        ],
      ]) {
        const original = await provider.transaction(async (tx) => {
          const record = (await tx.list(SQLITE_USAGE_NAMESPACES.effects)).find(
            (receipt) => receipt.value.idempotencyKey === key
          )
          expect(record).toBeDefined()
          await tx.put({
            namespace: SQLITE_USAGE_NAMESPACES.effects,
            id: record.id,
            expectedRevision: record.revision,
            value: { ...record.value, result: corruptedResult },
          })
          return record
        })
        provider.close()
        await provider.migrate()
        const reopened = new DurableUsageLedger({ store: new SqliteDurableUsageStore(provider) })
        await expect(replay(reopened)).rejects.toThrow('STORE_STATE_INVALID')
        expect(await reopened.entries(workspaceId, executionId)).toEqual(before)
        await provider.transaction(async (tx) => {
          const damaged = await tx.get(SQLITE_USAGE_NAMESPACES.effects, original.id)
          await tx.put({
            namespace: SQLITE_USAGE_NAMESPACES.effects,
            id: original.id,
            expectedRevision: damaged.revision,
            value: original.value,
          })
        })
        expect(await replay(reopened)).toEqual(expected)
        expect(await reopened.entries(workspaceId, executionId)).toEqual(before)
      }
    })
  })

  test('public durable service preserves charge replay after native reopen and budget finalization', async () => {
    const { DurableUsageLedger } = await import('@control-plane/usage-ledger')
    await withStore(async (provider, store) => {
      const ledger = new DurableUsageLedger({ store, now: () => '2026-09-27T12:00:00.000Z' })
      const source = (idempotencyKey) => ({ sourceId: 'native-service', idempotencyKey })
      await ledger.openBudget({
        workspaceId,
        executionId,
        currency: 'USD',
        maximumMicrounits: 1000,
        maximumTokens: 100,
        source: source('open'),
      })
      await ledger.reserve({
        workspaceId,
        executionId,
        attemptId,
        reservationKey: 'provider',
        maximumMicrounits: 800,
        maximumTokens: 80,
        source: source('reserve'),
      })
      const charge = {
        workspaceId,
        executionId,
        attemptId,
        reservationKey: 'provider',
        kind: 'model_usage',
        quantity: { unit: 'tokens', value: 30 },
        costMicrounits: 250,
        fundingSource: 'hq_managed',
        source: source('charge'),
      }
      const first = await ledger.charge(charge)
      const settleInput = {
        workspaceId,
        executionId,
        reservationKey: 'provider',
        source: source('settle'),
      }
      const settled = await ledger.settle(settleInput)
      await ledger.finalizeBudget({ workspaceId, executionId, source: source('finalize') })
      const before = await ledger.entries(workspaceId, executionId)
      provider.close()
      await provider.migrate()
      const reopened = new DurableUsageLedger({ store: new SqliteDurableUsageStore(provider) })
      expect(await reopened.charge(charge)).toEqual(first)
      expect(await reopened.settle(settleInput)).toEqual(settled)
      await expect(reopened.charge({ ...charge, costMicrounits: 251 })).rejects.toThrow(
        'IDEMPOTENCY_CONFLICT'
      )
      expect(await reopened.summary(workspaceId, executionId)).toMatchObject({
        spentMicrounits: 250,
        spentTokens: 30,
        availableMicrounits: 750,
        availableTokens: 70,
        settled: true,
      })
      expect(await reopened.entries(workspaceId, executionId)).toEqual(before)
    })
  })

  test('native durable service serializes simultaneous admissions without overbooking money or tokens', async () => {
    const { DurableUsageLedger } = await import('@control-plane/usage-ledger')
    for (const [money, tokens] of [
      [600, 10],
      [100, 60],
    ]) {
      await withStore(async (_provider, store) => {
        const ledger = new DurableUsageLedger({ store })
        const source = (idempotencyKey) => ({ sourceId: 'native-concurrency', idempotencyKey })
        await ledger.openBudget({
          workspaceId,
          executionId,
          currency: 'USD',
          maximumMicrounits: 1000,
          maximumTokens: 100,
          source: source('open'),
        })
        const admissions = ['a', 'b'].map((reservationKey) => ({
          workspaceId,
          executionId,
          attemptId,
          reservationKey,
          maximumMicrounits: money,
          maximumTokens: tokens,
          source: source(`reserve:${reservationKey}`),
        }))
        const outcomes = await Promise.allSettled(admissions.map((input) => ledger.reserve(input)))
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
        expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
        const loser = outcomes.find((outcome) => outcome.status === 'rejected')
        expect(loser.reason.code).toBe('BUDGET_EXHAUSTED')
        expect(await ledger.summary(workspaceId, executionId)).toMatchObject({
          reservedMicrounits: money,
          reservedTokens: tokens,
          availableMicrounits: 1000 - money,
          availableTokens: 100 - tokens,
        })
        const winner = outcomes.findIndex((outcome) => outcome.status === 'fulfilled')
        expect(await ledger.reserve(admissions[winner])).toEqual(outcomes[winner].value)
        expect(
          (await ledger.entries(workspaceId, executionId)).filter(
            (usageEntry) => usageEntry.kind === 'reservation'
          )
        ).toHaveLength(1)
      })
    }
  }, 30_000)

  test('native child funding limits both money and tokens and rolls measured usage into the parent once', async () => {
    const { DurableUsageLedger } = await import('@control-plane/usage-ledger')
    await withStore(async (provider, store) => {
      const childId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW'
      const childAttemptId = 'att_01ARZ3NDEKTSV4RRFFQ69G5FAW'
      await seedOwner(
        provider,
        { executionId: childId, parentExecutionId: executionId },
        childAttemptId
      )
      const ledger = new DurableUsageLedger({ store })
      const source = (idempotencyKey) => ({ sourceId: 'native-family', idempotencyKey })
      await ledger.openBudget({
        workspaceId,
        executionId,
        currency: 'USD',
        maximumMicrounits: 1000,
        maximumTokens: 100,
        source: source('parent-open'),
      })
      await ledger.openBudget({
        workspaceId,
        executionId: childId,
        parentExecutionId: executionId,
        currency: 'USD',
        maximumMicrounits: 800,
        maximumTokens: 80,
        source: source('child-open'),
      })
      await expect(
        ledger.reserve({
          workspaceId,
          executionId,
          attemptId,
          reservationKey: 'overbooked',
          maximumMicrounits: 201,
          maximumTokens: 21,
          source: source('overbooked'),
        })
      ).rejects.toThrow('BUDGET_EXHAUSTED')
      await ledger.reserve({
        workspaceId,
        executionId: childId,
        attemptId: childAttemptId,
        reservationKey: 'provider',
        maximumMicrounits: 500,
        maximumTokens: 50,
        source: source('child-reserve'),
      })
      await ledger.charge({
        workspaceId,
        executionId: childId,
        attemptId: childAttemptId,
        reservationKey: 'provider',
        kind: 'model_usage',
        quantity: { unit: 'tokens', value: 30 },
        costMicrounits: 250,
        fundingSource: 'hq_managed',
        source: source('child-charge'),
      })
      await expect(
        ledger.finalizeBudget({ workspaceId, executionId, source: source('too-soon') })
      ).rejects.toThrow('SETTLEMENT_INCOMPLETE')
      await ledger.settle({
        workspaceId,
        executionId: childId,
        reservationKey: 'provider',
        source: source('child-settle'),
      })
      const finalize = { workspaceId, executionId: childId, source: source('child-finalize') }
      await ledger.finalizeBudget(finalize)
      provider.close()
      await provider.migrate()
      const reopened = new DurableUsageLedger({ store: new SqliteDurableUsageStore(provider) })
      await reopened.finalizeBudget(finalize)
      expect(await reopened.summary(workspaceId, executionId)).toMatchObject({
        spentMicrounits: 250,
        spentTokens: 30,
        availableMicrounits: 750,
        availableTokens: 70,
      })
      const parentEntries = await reopened.entries(workspaceId, executionId)
      expect(parentEntries.some((usageEntry) => usageEntry.kind === 'model_usage')).toBe(false)
      expect(parentEntries.every((usageEntry) => usageEntry.attemptId === undefined)).toBe(true)
    })
  })
})
