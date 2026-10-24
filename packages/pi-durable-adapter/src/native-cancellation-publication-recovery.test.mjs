import { expect, test } from 'bun:test'
import {
  classifyPiNativeCancellationPublication,
  PiPublicationRecoveryIdentitySchema,
} from './cancellation-history.ts'

const hash = (c) => `sha256:${c.repeat(64)}`
const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const turnKey = `pi-turn:${attemptId}:initial`
const expiresAt = '2026-10-20T12:01:00.000Z'
const identity = {
  requestId: 'cancel:one',
  requestDigest: hash('a'),
  targetDigest: hash('b'),
  expiresAt,
  turnKey,
  inferenceId: 'native:1',
}
const receipt = (over = {}) => ({
  version: 1,
  requestId: identity.requestId,
  requestDigest: identity.requestDigest,
  conversationId: 1,
  background: false,
  taskIds: [],
  queuedInputIds: [],
  metadata: {
    targetDigest: identity.targetDigest,
    expiresAt,
    fenceRevision: 1,
    inferenceId: identity.inferenceId,
    turnKey,
    scopeDigest: 'c'.repeat(64),
  },
  ...over,
})
const generation = (over = {}) => ({
  schemaVersion: 'pi-inference-generation/v1',
  attemptId,
  turnKey,
  inferenceId: 'native:1',
  inferenceKey: `${turnKey}:native:1`,
  ...over,
})
const record = (detail = {}, state = 'running') => ({
  handleId: 'pi-handle',
  attemptId,
  state,
  detail,
})
const none = Symbol('no receipt observed')
const classify = (rec, id = identity, r = receipt()) =>
  classifyPiNativeCancellationPublication(rec, id, r === none ? undefined : r)

test('journal retaining the matching action and receipt classifies as published', () => {
  const rec = record({
    actions: { [identity.requestId]: identity.requestDigest },
    nativeCancellationReceipt: receipt(),
  })
  expect(classify(rec)).toEqual({ outcome: 'published' })
  expect(classify(rec, identity, none)).toEqual({ outcome: 'published' })
})

test('no observed receipt is receipt_absent, never proof of zero effect', () => {
  expect(classify(record({ activeInference: generation() }), identity, none)).toEqual({
    outcome: 'receipt_absent',
  })
})

test('a matching receipt the journal does not retain is receipt_unpublished', () => {
  expect(classify(record({ activeInference: generation() }))).toEqual({
    outcome: 'receipt_unpublished',
  })
  expect(classify(record({}))).toEqual({ outcome: 'receipt_unpublished' })
})

test('a journal that moved on classifies as receipt_superseded', () => {
  expect(classify(record({ turn: { requestId: 'pi-turn:next' } }))).toEqual({
    outcome: 'receipt_superseded',
  })
  for (const state of ['completed', 'failed', 'timed_out', 'cancelled'])
    expect(classify(record({}, state))).toEqual({ outcome: 'receipt_superseded' })
  expect(
    classify(
      record({
        activeInference: generation({
          inferenceId: 'native:2',
          inferenceKey: `${turnKey}:native:2`,
        }),
      })
    )
  ).toEqual({ outcome: 'receipt_superseded' })
  expect(
    classify(record({ inferenceReceipts: { [`${turnKey}:native:1`]: { settled: true } } }))
  ).toEqual({ outcome: 'receipt_superseded' })
})

test('contradictory or malformed evidence fails closed as a coded conflict', () => {
  const code = (decision) => (decision.outcome === 'conflict' ? decision.code : decision.outcome)
  expect(code(classify(record(), { ...identity, extra: 1 }))).toBe(
    'PI_PUBLICATION_RECOVERY_IDENTITY_INVALID'
  )
  expect(code(classify(record(), { ...identity, requestDigest: 'nope' }))).toBe(
    'PI_PUBLICATION_RECOVERY_IDENTITY_INVALID'
  )
  expect(code(classify(record(), identity, receipt({ requestId: 'cancel:two' })))).toBe(
    'PI_PUBLICATION_RECOVERY_RECEIPT_BINDING_INVALID'
  )
  expect(code(classify(record(), identity, { version: 2 }))).toBe(
    'PI_PUBLICATION_RECOVERY_RECEIPT_BINDING_INVALID'
  )
  expect(
    code(
      classify(
        record(),
        identity,
        receipt({ metadata: { ...receipt().metadata, turnKey: 'pi-turn:other' } })
      )
    )
  ).toBe('PI_PUBLICATION_RECOVERY_RECEIPT_BINDING_INVALID')
  expect(code(classify(record({ actions: { [identity.requestId]: hash('d') } })))).toBe(
    'PI_PUBLICATION_RECOVERY_ACTION_DIGEST'
  )
  expect(
    code(classify(record({ actions: { [identity.requestId]: identity.requestDigest } })))
  ).toBe('PI_PUBLICATION_RECOVERY_RETAINED_RECEIPT')
  expect(code(classify(record({ nativeCancellationReceipt: receipt() })))).toBe(
    'PI_PUBLICATION_RECOVERY_RETAINED_RECEIPT'
  )
  expect(
    code(
      classify(
        record({
          actions: { [identity.requestId]: identity.requestDigest },
          nativeCancellationReceipt: receipt({ conversationId: 2 }),
        })
      )
    )
  ).toBe('PI_PUBLICATION_RECOVERY_RETAINED_RECEIPT')
  expect(code(classify(record({ activeInference: { bad: true } })))).toBe(
    'PI_PUBLICATION_RECOVERY_GENERATION_INVALID'
  )
  expect(code(classify({ ...record(), detail: null }))).toBe(
    'PI_PUBLICATION_RECOVERY_RECORD_INVALID'
  )
})

test('classification is frozen, does not mutate inputs and grants no authority', () => {
  const rec = record({ activeInference: generation() })
  const before = JSON.stringify(rec)
  const decision = classify(rec)
  expect(Object.isFrozen(decision)).toBe(true)
  expect(JSON.stringify(rec)).toBe(before)
  expect(Object.keys(decision)).toEqual(['outcome'])
  expect(PiPublicationRecoveryIdentitySchema.safeParse(identity).success).toBe(true)
})

const publishedDetail = (extra = {}) => ({
  actions: { [identity.requestId]: identity.requestDigest },
  nativeCancellationReceipt: receipt(),
  ...extra,
})
const metadata = (over) => ({ ...receipt().metadata, ...over })
const codeOf = (decision) => (decision.outcome === 'conflict' ? decision.code : decision.outcome)

test('a retained receipt must match every pin, not only request and target', () => {
  for (const wrong of [
    { requestId: 'cancel:two' },
    { requestDigest: hash('d') },
    { metadata: metadata({ targetDigest: hash('d') }) },
    { metadata: metadata({ expiresAt: '2026-10-20T12:02:00.000Z' }) },
    { metadata: metadata({ turnKey: 'pi-turn:next' }) },
    { metadata: metadata({ inferenceId: 'native:2' }) },
    { metadata: metadata({ inferenceId: null }) },
  ])
    for (const observed of [none, receipt()])
      expect(
        codeOf(
          classify(
            record(publishedDetail({ nativeCancellationReceipt: receipt(wrong) })),
            identity,
            observed
          )
        )
      ).toBe('PI_PUBLICATION_RECOVERY_RETAINED_RECEIPT')
})

test('a mismatched observed pin conflicts for every pin on every journal shape', () => {
  for (const wrong of [
    { requestDigest: hash('d') },
    { metadata: metadata({ targetDigest: hash('d') }) },
    { metadata: metadata({ expiresAt: '2026-10-20T12:02:00.000Z' }) },
    { metadata: metadata({ turnKey: 'pi-turn:next' }) },
    { metadata: metadata({ inferenceId: 'native:2' }) },
  ])
    for (const rec of [
      record(),
      record(publishedDetail()),
      record({ activeInference: generation() }),
    ])
      expect(codeOf(classify(rec, identity, receipt(wrong)))).toBe(
        'PI_PUBLICATION_RECOVERY_RECEIPT_BINDING_INVALID'
      )
})

test('malformed generation or container identity conflicts before absent or published', () => {
  const bad = [
    { activeInference: { bad: true } },
    { activeInference: generation({ inferenceKey: 'wrong' }) },
    { activeInference: generation({ inferenceId: '' }) },
    { activeInference: null },
    { actions: [] },
    { actions: 'x' },
    { inferenceReceipts: [] },
    { turn: [] },
    { turn: { requestId: 7 } },
    { turn: { requestId: '' } },
  ]
  for (const detail of bad)
    for (const [rec, observed] of [
      [record(detail), none],
      [record({ ...publishedDetail(), ...detail }), receipt()],
      [record({ ...publishedDetail(), ...detail }), none],
      [record(detail), receipt()],
    ])
      expect(codeOf(classify(rec, identity, observed))).toMatch(/^PI_PUBLICATION_RECOVERY_/)
  for (const detail of bad)
    expect(codeOf(classify(record(detail), identity, none))).not.toBe('receipt_absent')
  expect(codeOf(classify({ ...record(), handleId: '' }, identity, none))).toBe(
    'PI_PUBLICATION_RECOVERY_RECORD_INVALID'
  )
  expect(codeOf(classify({ ...record(), state: undefined }, identity, none))).toBe(
    'PI_PUBLICATION_RECOVERY_RECORD_INVALID'
  )
})

test('cross-attempt and cross-turn identity is a conflict, never absent or published', () => {
  const other = 'att_01JZZZZZZZZZZZZZZZZZZZZZZZ'
  const foreign = generation({
    attemptId: other,
    turnKey: `pi-turn:${other}:initial`,
    inferenceKey: `pi-turn:${other}:initial:native:1`,
  })
  for (const observed of [none, receipt()])
    expect(codeOf(classify(record({ activeInference: foreign }), identity, observed))).toBe(
      'PI_PUBLICATION_RECOVERY_CROSS_ATTEMPT'
    )
  // Same attempt but a generation belonging to another turn than the journal's current turn.
  const otherTurn = generation({ turnKey: 'pi-turn:next', inferenceKey: 'pi-turn:next:native:1' })
  for (const observed of [none, receipt()])
    expect(codeOf(classify(record({ activeInference: otherTurn }), identity, observed))).toBe(
      'PI_PUBLICATION_RECOVERY_CROSS_TURN'
    )
  expect(
    codeOf(
      classify(record({ ...publishedDetail(), activeInference: otherTurn }), identity, receipt())
    )
  ).toBe('PI_PUBLICATION_RECOVERY_CROSS_TURN')
  // Pins that name another attempt's initial turn are a foreign request, not a successor.
  const foreignPins = { ...identity, turnKey: `pi-turn:${other}:initial` }
  const foreignReceipt = receipt({ metadata: metadata({ turnKey: foreignPins.turnKey }) })
  expect(codeOf(classify(record(), foreignPins, foreignReceipt))).toBe(
    'PI_PUBLICATION_RECOVERY_CROSS_ATTEMPT'
  )
  expect(codeOf(classify(record(), foreignPins, none))).toBe(
    'PI_PUBLICATION_RECOVERY_CROSS_ATTEMPT'
  )
  // A genuine successor turn of this attempt is still superseded.
  expect(classify(record({ turn: { requestId: 'pi-turn:next' } }))).toEqual({
    outcome: 'receipt_superseded',
  })
})
