import { expect, test } from 'bun:test'
import { PostgresToolRateLimiter } from './tool-rate-limiter.ts'

test('Postgres limiter rejects a missing durable receipt ID before opening a transaction', async () => {
  let transactions = 0
  const database = {
    transaction: async () => {
      transactions += 1
      return true
    },
  }
  const limiter = new PostgresToolRateLimiter(database)

  await expect(
    limiter.consume(
      'wsp_01JABCDEF0123456789ABCDEFG:service:runtime-worker:tld_01JABCDEF0123456789ABCDEFG:store-json',
      60,
      60_000,
      '2026-10-03T09:00:00.000Z'
    )
  ).rejects.toThrow('POSTGRES_TOOL_RATE_LIMIT_INPUT_INVALID')
  expect(transactions).toBe(0)
})
