import { expect, test } from 'bun:test'
import {
  assertPiWriterClosureReceipt,
  PiWriterClosureReceiptSchema,
} from './native-writer-closure-receipt.ts'

const expected = {
  mutationId: 'mutation:one',
  lineageId: 'lineage:1',
  generation: 'gen:1',
  previousEpoch: 1,
  observedSeq: 10,
}
const receipt = (over = {}) => ({
  schemaVersion: 'pi-writer-closure-receipt/v1',
  mutationId: 'mutation:one',
  ownerKey: 'owner:a',
  lineageId: 'lineage:1',
  generation: 'gen:1',
  previousEpoch: 1,
  epoch: 2,
  lastSeq: 12,
  settledInFlight: true,
  closedAt: '2026-10-24T12:00:00.000Z',
  ...over,
})
const code = (fn) => {
  try {
    fn()
  } catch (error) {
    return error.message
  }
  return 'no error'
}

test('a matching receipt is frozen evidence that carries no authority', () => {
  const evidence = assertPiWriterClosureReceipt(receipt(), expected)
  expect(evidence.kind).toBe('writer-closure-evidence')
  expect(evidence.qualifiedAuthorization).toBe(false)
  expect(Object.isFrozen(evidence)).toBe(true)
  expect(Object.isFrozen(evidence.receipt)).toBe(true)
  expect(assertPiWriterClosureReceipt(receipt({ lastSeq: 10 }), expected).receipt.lastSeq).toBe(10)
})

test('every mismatch fails closed with its own code', () => {
  const cases = [
    [{ mutationId: 'mutation:two' }, 'PI_WRITER_CLOSURE_MUTATION'],
    [{ lineageId: 'lineage:2' }, 'PI_WRITER_CLOSURE_LINEAGE'],
    [{ generation: 'gen:2' }, 'PI_WRITER_CLOSURE_GENERATION'],
    [{ previousEpoch: 2, epoch: 3 }, 'PI_WRITER_CLOSURE_EPOCH'],
    [{ lastSeq: 9 }, 'PI_WRITER_CLOSURE_SEQUENCE'],
  ]
  for (const [over, expectedCode] of cases)
    expect(code(() => assertPiWriterClosureReceipt(receipt(over), expected))).toBe(expectedCode)
})

test('malformed receipts are refused: unsettled, epoch not advancing by one, extra or missing fields', () => {
  for (const bad of [
    receipt({ settledInFlight: false }),
    receipt({ epoch: 1 }),
    receipt({ epoch: 4 }),
    receipt({ epoch: -1, previousEpoch: -2 }),
    receipt({ closedAt: 'yesterday' }),
    receipt({ schemaVersion: 'pi-writer-closure-receipt/v2' }),
    { ...receipt(), extra: true },
    { ...receipt(), ownerKey: undefined },
    null,
    'receipt',
  ])
    expect(code(() => assertPiWriterClosureReceipt(bad, expected))).toBe(
      'PI_WRITER_CLOSURE_RECEIPT_INVALID'
    )
  expect(PiWriterClosureReceiptSchema.safeParse(receipt()).success).toBe(true)
})

test('a receipt from a rolled-back epoch or an earlier closure is not accepted for this one', () => {
  expect(
    code(() => assertPiWriterClosureReceipt(receipt({ previousEpoch: 0, epoch: 1 }), expected))
  ).toBe('PI_WRITER_CLOSURE_EPOCH')
})

test('a malformed or non-finite expectation is refused, so no floor can be silently skipped', () => {
  const unsafe = [
    Number.NaN,
    undefined,
    null,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    1.5,
    '10',
    Number.MAX_SAFE_INTEGER + 1,
  ]
  const bad = [null, undefined, 'expected', [], { ...expected, extra: true }]
  for (const field of ['mutationId', 'lineageId', 'generation', 'previousEpoch', 'observedSeq'])
    bad.push(Object.fromEntries(Object.entries(expected).filter(([key]) => key !== field)))
  for (const field of ['previousEpoch', 'observedSeq'])
    for (const value of unsafe) bad.push({ ...expected, [field]: value })
  for (const field of ['mutationId', 'lineageId', 'generation'])
    for (const value of ['', ' padded', 7, undefined, null])
      bad.push({ ...expected, [field]: value })
  for (const input of bad)
    expect(code(() => assertPiWriterClosureReceipt(receipt(), input))).toBe(
      'PI_WRITER_CLOSURE_EXPECTATION_INVALID'
    )
  // The reported hole: NaN used to make the sequence comparison false and accept below-floor evidence.
  expect(
    code(() =>
      assertPiWriterClosureReceipt(receipt({ lastSeq: 0 }), {
        ...expected,
        observedSeq: Number.NaN,
      })
    )
  ).toBe('PI_WRITER_CLOSURE_EXPECTATION_INVALID')
  // A valid expectation still behaves as before at the boundaries.
  expect(
    assertPiWriterClosureReceipt(receipt({ lastSeq: 0 }), { ...expected, observedSeq: 0 }).receipt
      .lastSeq
  ).toBe(0)
  expect(code(() => assertPiWriterClosureReceipt(receipt({ lastSeq: 0 }), expected))).toBe(
    'PI_WRITER_CLOSURE_SEQUENCE'
  )
})

test('epochs beyond the safe integer range are refused on both sides', () => {
  const max = Number.MAX_SAFE_INTEGER
  // previousEpoch at the maximum would need an unsafe successor, so the receipt cannot be valid.
  for (const bad of [
    receipt({ previousEpoch: max, epoch: max + 1 }),
    receipt({ previousEpoch: max - 1, epoch: max + 1 }),
    receipt({ lastSeq: max + 1 }),
  ])
    expect(code(() => assertPiWriterClosureReceipt(bad, { ...expected, previousEpoch: max }))).toBe(
      'PI_WRITER_CLOSURE_RECEIPT_INVALID'
    )
  // The last representable advance is accepted.
  expect(
    assertPiWriterClosureReceipt(receipt({ previousEpoch: max - 1, epoch: max }), {
      ...expected,
      previousEpoch: max - 1,
    }).receipt.epoch
  ).toBe(max)
})
