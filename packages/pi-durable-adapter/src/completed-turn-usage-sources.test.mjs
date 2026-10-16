import { expect, test } from 'bun:test'
import { RuntimeUsageSchema } from '@control-plane/runtime-sdk'
import { aggregateUsage, completedTurnUsageSources } from './adapter.ts'

const usage = (sourceId, microunits, tokens) =>
  RuntimeUsageSchema.parse({
    inputTokens: tokens,
    outputTokens: 1,
    durationMs: 10,
    cost: { amount: `0.${String(microunits).padStart(6, '0')}`, currency: 'USD' },
    accounting: {
      schemaVersion: 1,
      sourceId,
      fundingSource: 'byo_api',
      currency: 'USD',
      chargedMicrounits: microunits,
      costExact: true,
    },
  })

const turn = 'pi-turn:att_01JABCDEF0123456789ABCDEFG:initial'
const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const one = usage('pi-inference:one', 11, 5)
const two = usage('pi-inference:two', 7, 4)
const receipts = {
  [`${turn}:pi-generation:1`]: { turnKey: turn, usage: one },
  [`${turn}:pi-generation:2`]: { turnKey: turn, usage: two },
}
const aggregate = aggregateUsage([one, two])

test('a single inference reports its own source', () => {
  expect(completedTurnUsageSources({ attemptId, detail: {} }, one)).toEqual([one.accounting])
})

test('a composite turn usage resolves to every retained constituent source', () => {
  expect(aggregate.accounting.sourceId.startsWith('pi-turn-usage:')).toBe(true)
  expect(
    completedTurnUsageSources({ attemptId, detail: { inferenceReceipts: receipts } }, aggregate)
  ).toEqual([one.accounting, two.accounting])
})

test('receipts of another turn are not part of this turn', () => {
  const other = {
    ...receipts,
    'pi-turn:other:pi-generation:3': {
      turnKey: 'pi-turn:other',
      usage: usage('pi-inference:three', 3, 2),
    },
  }
  expect(
    completedTurnUsageSources({ attemptId, detail: { inferenceReceipts: other } }, aggregate)
  ).toEqual([one.accounting, two.accounting])
})

test('a composite that the retained receipts do not reproduce has no sources', () => {
  const missing = { [`${turn}:pi-generation:1`]: receipts[`${turn}:pi-generation:1`] }
  const altered = {
    ...receipts,
    [`${turn}:pi-generation:2`]: { turnKey: turn, usage: usage('pi-inference:two', 8, 4) },
  }
  for (const inferenceReceipts of [missing, altered, {}, undefined, 'not receipts'])
    expect(
      completedTurnUsageSources({ attemptId, detail: { inferenceReceipts } }, aggregate)
    ).toBeUndefined()
  expect(completedTurnUsageSources({ attemptId, detail: {} }, aggregate)).toBeUndefined()
  expect(
    completedTurnUsageSources(
      { attemptId, detail: { inferenceReceipts: receipts } },
      { inputTokens: 1, outputTokens: 1, durationMs: 1 }
    )
  ).toBeUndefined()
})
