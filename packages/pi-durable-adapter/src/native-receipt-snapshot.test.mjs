import { expect, test } from 'bun:test'
import {
  readPiFrozenReceipt,
  sealPiReceiptSnapshot,
  UnavailablePiReceiptSnapshotIssuer,
} from './native-receipt-snapshot.ts'

const hash = (c) => `sha256:${c.repeat(64)}`
const expiresAt = '2026-10-20T12:01:00.000Z'
const pins = {
  sessionId: 'ses_one',
  requestId: 'cancel:one',
  requestDigest: hash('a'),
  targetDigest: hash('b'),
  expiresAt,
  turnKey: 'turn:initial',
  inferenceId: 'native:1',
}
const receipt = (over = {}) => ({
  version: 1,
  requestId: pins.requestId,
  requestDigest: pins.requestDigest,
  conversationId: 7,
  background: false,
  taskIds: [1],
  queuedInputIds: [],
  metadata: {
    targetDigest: pins.targetDigest,
    expiresAt,
    fenceRevision: 1,
    inferenceId: pins.inferenceId,
    turnKey: pins.turnKey,
    scopeDigest: 'c'.repeat(64),
  },
  ...over,
})
const provenance = (over = {}) => ({
  sessionId: pins.sessionId,
  conversationId: 7,
  restoreGeneration: 'restore:1',
  ownerEpoch: 2,
  detached: true,
  coherent: true,
  access: 'select_only',
  ...over,
})
const seal = (ledger, over) => sealPiReceiptSnapshot({ provenance: provenance(over), ledger })
const code = (fn) => {
  try {
    fn()
  } catch (error) {
    return error.message
  }
  return 'no error'
}

test('finds the receipt in a sealed snapshot and returns frozen historical evidence', () => {
  const found = readPiFrozenReceipt(seal({ receipts: [receipt()] }), pins)
  expect(found.outcome).toBe('found')
  expect(found.receipt).toEqual(receipt())
  expect(Object.isFrozen(found)).toBe(true)
})

const frozenDeep = (value) =>
  value === null ||
  typeof value !== 'object' ||
  (Object.isFrozen(value) && Object.values(value).every(frozenDeep))

test('a found receipt is frozen all the way down and cannot be altered by the caller', () => {
  const snapshot = seal({ receipts: [receipt({ taskIds: [1, 2], queuedInputIds: [3] })] })
  const found = readPiFrozenReceipt(snapshot, pins)
  expect(frozenDeep(found)).toBe(true)
  expect(Object.isFrozen(found.receipt)).toBe(true)
  expect(Object.isFrozen(found.receipt.metadata)).toBe(true)
  expect(Object.isFrozen(found.receipt.taskIds)).toBe(true)
  expect(Object.isFrozen(found.receipt.queuedInputIds)).toBe(true)
  expect(() => found.receipt.taskIds.push(9)).toThrow()
  expect(() => {
    found.receipt.metadata.turnKey = 'turn:other'
  }).toThrow()
  expect(() => {
    found.receipt.conversationId = 8
  }).toThrow()
  expect(() => {
    found.receipt.metadata.extra = true
  }).toThrow()
  // The failed mutations changed nothing, here or in a later read of the same snapshot.
  const again = readPiFrozenReceipt(snapshot, pins)
  expect(again.receipt).toEqual(receipt({ taskIds: [1, 2], queuedInputIds: [3] }))
  expect(frozenDeep(again)).toBe(true)
})

test('an absent request stays absent and says nothing about live effect', () => {
  expect(readPiFrozenReceipt(seal({ receipts: [] }), pins)).toEqual({ outcome: 'absent' })
  expect(
    readPiFrozenReceipt(seal({ receipts: [receipt({ requestId: 'cancel:two' })] }), pins)
  ).toEqual({ outcome: 'absent' })
})

test('anything not sealed by the issuer seam is refused', () => {
  const real = seal({ receipts: [receipt()] })
  const forged = [
    undefined,
    null,
    'snapshot',
    {},
    { path: '/tmp/x.sqlite', sha256: hash('a'), coherent: true },
    { ...real },
    JSON.parse(JSON.stringify(real)),
    Object.create(real),
    new Proxy(real, {}),
    { provenance: provenance(), ledger: { receipts: [receipt()] } },
  ]
  for (const candidate of forged)
    expect(code(() => readPiFrozenReceipt(candidate, pins))).toBe(
      'PI_FROZEN_RECEIPT_SNAPSHOT_NOT_ISSUED'
    )
})

test('the issuer must attest detached, coherent and select-only', () => {
  for (const over of [
    { detached: false },
    { coherent: false },
    { access: 'read_write' },
    { sessionId: '' },
    { conversationId: 0 },
    { ownerEpoch: -1 },
  ])
    expect(code(() => seal({ receipts: [] }, over))).toBe('PI_RECEIPT_SNAPSHOT_PROVENANCE_INVALID')
})

test('wrong pins, wrong session and bad identity fail closed', () => {
  const snapshot = seal({ receipts: [receipt()] })
  expect(code(() => readPiFrozenReceipt(snapshot, { ...pins, extra: 1 }))).toBe(
    'PI_FROZEN_RECEIPT_IDENTITY_INVALID'
  )
  expect(code(() => readPiFrozenReceipt(snapshot, { ...pins, sessionId: 'ses_two' }))).toBe(
    'PI_FROZEN_RECEIPT_SESSION_MISMATCH'
  )
  for (const wrong of [
    { requestDigest: hash('d') },
    { targetDigest: hash('d') },
    { expiresAt: '2026-10-20T12:02:00.000Z' },
    { turnKey: 'turn:other' },
    { inferenceId: 'native:2' },
    { inferenceId: null },
  ])
    expect(code(() => readPiFrozenReceipt(snapshot, { ...pins, ...wrong }))).toBe(
      'PI_FROZEN_RECEIPT_BINDING_INVALID'
    )
})

test('malformed, duplicate or foreign-shaped ledgers fail closed', () => {
  for (const ledger of [null, {}, { receipts: 'x' }, []])
    expect(code(() => readPiFrozenReceipt(seal(ledger), pins))).toBe(
      'PI_FROZEN_RECEIPT_LEDGER_INVALID'
    )
  expect(code(() => readPiFrozenReceipt(seal({ receipts: [receipt(), receipt()] }), pins))).toBe(
    'PI_FROZEN_RECEIPT_LEDGER_INVALID'
  )
  for (const bad of [
    receipt({ version: 2 }),
    receipt({ background: true }),
    { ...receipt(), extra: true },
    null,
    'x',
  ])
    expect(code(() => readPiFrozenReceipt(seal({ receipts: [bad] }), pins))).toBe(
      'PI_FROZEN_RECEIPT_LEDGER_INVALID'
    )
})

test('sealing copies the ledger so later mutation cannot change the lookup', () => {
  const ledger = { receipts: [receipt()] }
  const snapshot = seal(ledger)
  ledger.receipts[0].requestDigest = hash('d')
  ledger.receipts.push(receipt())
  expect(readPiFrozenReceipt(snapshot, pins).outcome).toBe('found')
  expect(code(() => seal({ receipts: [() => 1] }))).not.toBe('no error')
})

test('the default issuer refuses and no store, path or flag is ever involved', async () => {
  await expect(new UnavailablePiReceiptSnapshotIssuer().issue()).rejects.toThrow(
    'PI_RECEIPT_SNAPSHOT_ISSUER_UNAVAILABLE'
  )
  const snapshot = seal({ receipts: [receipt()] })
  expect(Object.keys(snapshot)).toEqual([])
  expect(Object.getPrototypeOf(snapshot)).toBeNull()
})

test('a malformed entry anywhere in the ledger never reads as absent', () => {
  // An unrelated-looking but malformed entry still fails the whole ledger before "absent".
  for (const bad of [
    receipt({ requestId: 'cancel:two', version: 2 }),
    { requestId: pins.requestId },
    receipt({ taskIds: [1, 1] }),
  ])
    expect(code(() => readPiFrozenReceipt(seal({ receipts: [bad] }), pins))).toBe(
      'PI_FROZEN_RECEIPT_LEDGER_INVALID'
    )
  expect(
    code(() =>
      readPiFrozenReceipt(
        seal({ receipts: [receipt({ requestId: 'cancel:two', version: 2 }), receipt()] }),
        pins
      )
    )
  ).toBe('PI_FROZEN_RECEIPT_LEDGER_INVALID')
})

test('the same request in another conversation is a cross-conversation conflict', () => {
  expect(
    code(() => readPiFrozenReceipt(seal({ receipts: [receipt({ conversationId: 8 })] }), pins))
  ).toBe('PI_FROZEN_RECEIPT_CROSS_CONVERSATION')
  expect(
    code(() =>
      readPiFrozenReceipt(seal({ receipts: [receipt(), receipt({ conversationId: 8 })] }), pins)
    )
  ).toBe('PI_FROZEN_RECEIPT_CROSS_CONVERSATION')
  // Another request in another conversation is unrelated and stays absent.
  expect(
    readPiFrozenReceipt(
      seal({ receipts: [receipt({ conversationId: 8, requestId: 'cancel:two' })] }),
      pins
    )
  ).toEqual({ outcome: 'absent' })
})

test('every pin is validated against the found receipt, including cross-turn and cross-inference', () => {
  const snapshot = seal({ receipts: [receipt()] })
  for (const wrong of [
    { turnKey: 'pi-turn:att_other:initial' },
    { turnKey: 'turn:next' },
    { inferenceId: 'native:9' },
    { inferenceId: null },
    { expiresAt: '2026-10-20T12:03:00.000Z' },
  ])
    expect(code(() => readPiFrozenReceipt(snapshot, { ...pins, ...wrong }))).toBe(
      'PI_FROZEN_RECEIPT_BINDING_INVALID'
    )
})
