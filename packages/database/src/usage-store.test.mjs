import { expect, test } from 'bun:test'
import {
  fromUsageBudgetStateRow,
  fromUsageEffectReceiptRow,
  toUsageBudgetStateRow,
  toUsageEffectReceiptRow,
} from './usage-store.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'

const budget = {
  schemaVersion: 1,
  workspaceId,
  executionId,
  currency: 'USD',
  maximumMicrounits: 10_000,
  maximumTokens: 1_000,
  status: 'open',
  nextSequence: 1,
  reservations: [],
}

const effect = {
  schemaVersion: 1,
  workspaceId,
  executionId,
  idempotencyKey: 'open-root',
  fingerprint: `sha256:${'a'.repeat(64)}`,
  result: { executionId, maximumMicrounits: 10_000 },
}

test('budget state row codecs preserve JSON while checking every indexed identity field', () => {
  const row = toUsageBudgetStateRow(budget)
  expect(fromUsageBudgetStateRow({ ...row, state: structuredClone(row.state) })).toEqual(budget)

  expect(() =>
    fromUsageBudgetStateRow({ ...row, workspaceId: 'wsp_01JABCDEF0123456789ABCDEFA' })
  ).toThrow('STORE_STATE_INVALID')
  expect(() =>
    fromUsageBudgetStateRow({ ...row, parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFA' })
  ).toThrow('STORE_STATE_INVALID')
  expect(() => fromUsageBudgetStateRow({ ...row, schemaVersion: 2 })).toThrow('STORE_STATE_INVALID')
})

test('operation receipt codecs bind workspace, operation key, execution, fingerprint, and version', () => {
  const row = toUsageEffectReceiptRow(effect)
  expect(fromUsageEffectReceiptRow({ ...row, receipt: structuredClone(row.receipt) })).toEqual(
    effect
  )

  for (const damaged of [
    { ...row, workspaceId: 'wsp_01JABCDEF0123456789ABCDEFA' },
    { ...row, idempotencyKey: 'other-operation' },
    { ...row, executionId: 'exe_01JABCDEF0123456789ABCDEFA' },
    { ...row, fingerprint: `sha256:${'b'.repeat(64)}` },
    { ...row, schemaVersion: 2 },
  ]) {
    expect(() => fromUsageEffectReceiptRow(damaged)).toThrow('STORE_STATE_INVALID')
  }
})

test('public database aggregate exports the durable PostgreSQL store', async () => {
  const database = await import('../dist/index.js')
  expect(typeof database.PostgresDurableUsageStore).toBe('function')
  expect(database.usageBudgetStates).toBeDefined()
  expect(database.usageOperationReceipts).toBeDefined()
})
