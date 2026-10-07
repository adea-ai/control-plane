import { expect, test } from 'bun:test'
import { fromUsageLedgerRow, toUsageLedgerRow } from './usage-ledger-repository.js'

test('model request holds preserve quote and request identity through PostgreSQL row conversion', () => {
  const entry = {
    entryId: 'usg_01JABCDEF0123456789ABCDEFG',
    sequence: 3,
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    modelCallId: 'mdc_01JABCDEF0123456789ABCDEFG',
    kind: 'model_reservation',
    source: { sourceId: 'model-quote', idempotencyKey: 'model-request-hold' },
    reservationKey: 'runtime-attempt:att_01JABCDEF0123456789ABCDEFG',
    fundingSource: 'hq_managed',
    quantity: { unit: 'microunits', value: 256 },
    currency: 'USD',
    costMicrounits: 256,
    costExact: true,
    reservedTokens: 128,
    priceSnapshotDigest: `sha256:${'c'.repeat(64)}`,
    requestDigest: `sha256:${'d'.repeat(64)}`,
    recordedAt: '2026-10-07T12:00:00.000Z',
  }
  expect(fromUsageLedgerRow(toUsageLedgerRow(entry))).toEqual(entry)
})

test('usage ledger row conversion preserves immutable attribution fields', () => {
  const entry = {
    entryId: 'usg_01JABCDEF0123456789ABCDEFG',
    sequence: 1,
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    kind: 'model_usage',
    source: { sourceId: 'provider-request', idempotencyKey: 'model-call-1' },
    reservationKey: 'models',
    fundingSource: 'hq_managed',
    quantity: { unit: 'tokens', value: 128 },
    currency: 'USD',
    costMicrounits: 42,
    costExact: true,
    recordedAt: '2026-08-25T12:00:00.000Z',
  }
  const row = toUsageLedgerRow(entry)
  expect(fromUsageLedgerRow(row)).toEqual(entry)
  expect(row).not.toHaveProperty('credential')
})
