import { expect, test } from 'bun:test'
import { PiChildTerminalSettlement } from './child-terminal-settlement.ts'

function settlement(records, overrides = {}) {
  const reads = { journal: 0, delegations: 0, ledger: 0 }
  return {
    reads,
    settlement: new PiChildTerminalSettlement({
      journal: {
        list: () => {
          reads.journal += 1
          return records
        },
      },
      ledger: new Proxy(
        {},
        {
          get: () => async () => {
            reads.ledger += 1
            throw new Error('TEST_LEDGER_NOT_EXPECTED')
          },
        }
      ),
      delegations: {
        findByChild: async () => {
          reads.delegations += 1
          return undefined
        },
      },
      usageOutcomes: () => {
        throw new Error('TEST_OUTCOMES_NOT_EXPECTED')
      },
      now: () => '2026-10-15T00:00:00.000Z',
      ...overrides,
    }),
  }
}

test('a pass over records that are not completed children touches no ledger or delegation', async () => {
  const { settlement: pass, reads } = settlement([
    { state: 'running', admission: {}, detail: {} },
    { state: 'unknown', admission: { request: {} }, detail: {} },
    { state: 'completed', admission: undefined, detail: {} },
    { state: 'completed', admission: { request: { attemptId: 'not-a-request' } }, detail: {} },
  ])
  expect(await pass.settle()).toEqual({ settled: 0, pending: 0, unpriced: 0 })
  expect(pass.blocked).toBe(false)
  expect(reads).toMatchObject({ delegations: 0, ledger: 0 })
})

test('callers that arrive during a pass share it', async () => {
  const { settlement: pass, reads } = settlement([])
  const results = await Promise.all([pass.settle(), pass.settle(), pass.settle()])
  expect(results).toEqual(Array(3).fill({ settled: 0, pending: 0, unpriced: 0 }))
  expect(reads.journal).toBe(1)
  await pass.settle()
  expect(reads.journal).toBe(2)
})

test('a journal that cannot be read blocks the settlement and the next pass retries', async () => {
  let failing = true
  const { settlement: pass } = settlement([], {
    journal: {
      list: () => {
        if (failing) throw new Error('TEST_JOURNAL_UNAVAILABLE')
        return []
      },
    },
  })
  await expect(pass.settle()).rejects.toThrow('TEST_JOURNAL_UNAVAILABLE')
  expect(pass.blocked).toBe(true)
  failing = false
  expect(await pass.settle()).toEqual({ settled: 0, pending: 0, unpriced: 0 })
  expect(pass.blocked).toBe(false)
})

test('a closed settlement refuses further passes and waits for a running one', async () => {
  const { settlement: pass } = settlement([])
  const running = pass.settle()
  await pass.close()
  await running
  await expect(pass.settle()).rejects.toThrow('PI_CHILD_TERMINAL_SETTLEMENT_CLOSED')
})
