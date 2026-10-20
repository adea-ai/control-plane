import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  PiCancellationTargetSchema,
  PiCancellationRetainedIntentSchema,
  PiCancellationPermitSchema,
  PiCancellationBarrierSchema,
  PiCancellationEffectObservationSchema,
  UnavailablePiCancellationOwner,
  assertPiCancellationIntentReplay,
  assertPiCancellationBarrierTarget,
  assertPiCancellationPermitSnapshot,
  piCancellationRequestDigest,
  piCancellationTargetDigest,
} from './cancellation-owner.ts'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-20T12:00:00.000Z'
const end = '2026-10-20T12:01:00.000Z'
const hash = `sha256:${'a'.repeat(64)}`
// Raw test digest permits exercising malformed timestamps without calling the validated helper.
const rawDigest = (body) =>
  `sha256:${createHash('sha256').update(canonicalJsonStringify(body)).digest('hex')}`
function fixture() {
  const target = {
    workspaceId: id('wsp'),
    productIntentId: 'f643a115-617d-4bae-8d52-cfe458c0b8ac',
    originalActorPrincipalId: 'user:original',
    servicePrincipalId: 'svc:adea',
    scopeRef: 'adea:workspace',
    executionId: id('exe'),
    attemptId: id('att'),
    executionVersion: 2,
    attemptVersion: 3,
    admissionDigest: hash,
    handle: {
      handleId: 'pi-handle',
      attemptId: id('att'),
      startedAt: at,
      externalSessionId: id('ses'),
    },
    restoreGeneration: 'restore:qualified:1',
    ownerEpoch: 4,
    turnKey: 'turn:initial',
    targetKind: 'active_generation',
    generation: { inferenceId: 'native:1', inferenceKey: 'turn:initial:native:1' },
    authorityExpiresAt: end,
  }
  const body = { target, idempotencyKey: 'cancel:one', requestedAt: at }
  const intent = {
    schemaVersion: 'pi-cancellation-retained-intent/v1',
    ...body,
    requestDigest: piCancellationRequestDigest(body),
  }
  const permit = {
    schemaVersion: 'pi-cancellation-revocable-permit/v1',
    permitId: 'permit:one',
    requestDigest: intent.requestDigest,
    targetDigest: piCancellationTargetDigest(target),
    fenceEpoch: 7,
    issuedAt: at,
    expiresAt: end,
  }
  const current = {
    schemaVersion: 'pi-cancellation-current-fence/v1',
    target,
    requestDigest: intent.requestDigest,
    permitId: permit.permitId,
    fenceEpoch: 7,
    fenceState: 'open',
    permitState: 'active',
  }
  const barrier = {
    schemaVersion: 'pi-cancellation-barrier/v1',
    barrierId: 'barrier:one',
    targetDigest: permit.targetDigest,
    ownerEpoch: 4,
    previousEpoch: 7,
    fenceEpoch: 8,
    requestedAt: at,
    state: 'pending',
  }
  return { target, intent, permit, current, barrier }
}

// These tests validate pure contracts/snapshots. No fixture supplies production authority.
test('an exact current snapshot can be compared; retained intent is never a permit', () => {
  const { intent, permit, current } = fixture()
  expect(PiCancellationRetainedIntentSchema.parse(intent)).toEqual(intent)
  assertPiCancellationPermitSnapshot(intent, permit, current, at)
  expect(PiCancellationPermitSchema.safeParse(intent).success).toBe(false)
  expect(() => assertPiCancellationPermitSnapshot(intent, intent, current, at)).toThrow()
  expect(() => PiCancellationRetainedIntentSchema.parse({ ...intent, authorized: true })).toThrow()
})

test('strict contracts reject invalid identities, mismatched handle and ambiguous generation', () => {
  const { target } = fixture()
  for (const changed of [
    { workspaceId: 'invalid' },
    { originalActorPrincipalId: ' ' },
    { servicePrincipalId: '' },
    { productIntentId: 'invalid' },
    { attemptVersion: 0 },
    { ownerEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { generation: null },
    { targetKind: 'no_active_generation' },
    { handle: { ...target.handle, attemptId: id('att').replace(/G$/, 'H') } },
    { generation: { ...target.generation, inferenceKey: 'other' } },
    { callerAuthorizes: true },
  ])
    expect(PiCancellationTargetSchema.safeParse({ ...target, ...changed }).success).toBe(false)
})

test('request digest binds the complete target, key and original requested instant', () => {
  const { intent } = fixture()
  for (const changed of [
    { idempotencyKey: 'cancel:two' },
    { requestedAt: '2026-10-20T12:00:01.000Z' },
    { target: { ...intent.target, originalActorPrincipalId: 'user:other' } },
    { target: { ...intent.target, executionVersion: 3 } },
    { target: { ...intent.target, restoreGeneration: 'restore:other' } },
  ])
    expect(PiCancellationRetainedIntentSchema.safeParse({ ...intent, ...changed }).success).toBe(
      false
    )
  expect(() => assertPiCancellationIntentReplay(intent, structuredClone(intent))).not.toThrow()
  const body = {
    target: intent.target,
    requestedAt: intent.requestedAt,
    idempotencyKey: 'cancel:two',
  }
  const other = { ...intent, ...body, requestDigest: piCancellationRequestDigest(body) }
  expect(() => assertPiCancellationIntentReplay(intent, other)).toThrow(
    'PI_CANCELLATION_IDEMPOTENCY_CONFLICT'
  )
})

for (const changed of [
  { fenceEpoch: 6 },
  { fenceEpoch: 8 },
  { fenceState: 'closing' },
  { fenceState: 'closed' },
  { fenceState: 'unknown' },
  { permitState: 'revoked' },
  { permitState: 'unknown' },
  { permitId: 'permit:other' },
  { requestDigest: `sha256:${'b'.repeat(64)}` },
])
  test(`permit snapshot rejects stale, revoked or unknown current facts ${JSON.stringify(changed)}`, () => {
    const { intent, permit, current } = fixture()
    expect(() =>
      assertPiCancellationPermitSnapshot(intent, permit, { ...current, ...changed }, at)
    ).toThrow()
  })

for (const changed of [
  { ownerEpoch: 5 },
  { restoreGeneration: 'restore:other' },
  { attemptVersion: 4 },
  { generation: { inferenceId: 'native:2', inferenceKey: 'turn:initial:native:2' } },
  {
    handle: {
      handleId: 'other',
      attemptId: id('att'),
      startedAt: at,
      externalSessionId: id('ses'),
    },
  },
])
  test(`permit cannot migrate to a changed exact target ${JSON.stringify(changed)}`, () => {
    const { intent, permit, current } = fixture()
    expect(() =>
      assertPiCancellationPermitSnapshot(
        intent,
        permit,
        { ...current, target: { ...current.target, ...changed } },
        at
      )
    ).toThrow()
  })

test('expiry is exclusive, future issuance is denied, and permit cannot extend authority', () => {
  const { intent, permit, current } = fixture()
  for (const now of [end, '2026-10-20T12:02:00.000Z', '2026-10-20T11:59:59.999Z'])
    expect(() => assertPiCancellationPermitSnapshot(intent, permit, current, now)).toThrow()
  expect(() =>
    assertPiCancellationPermitSnapshot(
      intent,
      { ...permit, expiresAt: '2026-10-20T12:02:00.000Z' },
      current,
      at
    )
  ).toThrow()
  expect(PiCancellationPermitSchema.safeParse({ ...permit, expiresAt: at }).success).toBe(false)
})

test('untracked target may retain a request but never qualifies a permit snapshot', () => {
  const { intent, permit, current } = fixture()
  const target = { ...intent.target, targetKind: 'untracked_generation', generation: null }
  const body = { target, idempotencyKey: intent.idempotencyKey, requestedAt: at }
  const unknown = { ...intent, ...body, requestDigest: piCancellationRequestDigest(body) }
  expect(PiCancellationRetainedIntentSchema.safeParse(unknown).success).toBe(true)
  expect(() =>
    assertPiCancellationPermitSnapshot(
      unknown,
      {
        ...permit,
        requestDigest: unknown.requestDigest,
        targetDigest: piCancellationTargetDigest(target),
      },
      { ...current, target, requestDigest: unknown.requestDigest },
      at
    )
  ).toThrow()
})

test('barrier epochs only advance and unresolved records cannot claim drain', () => {
  const { barrier } = fixture()
  expect(PiCancellationBarrierSchema.safeParse(barrier).success).toBe(true)
  for (const changed of [
    { fenceEpoch: 7 },
    { fenceEpoch: 6 },
    { state: 'drained' },
    { drainedAt: end },
    { drainReceiptDigest: hash },
    { state: 'unknown', drainedAt: end, drainReceiptDigest: hash },
    { state: 'drained', drainedAt: '2026-10-20T11:00:00.000Z', drainReceiptDigest: hash },
  ])
    expect(PiCancellationBarrierSchema.safeParse({ ...barrier, ...changed }).success).toBe(false)
  expect(
    PiCancellationBarrierSchema.safeParse({
      ...barrier,
      state: 'drained',
      drainedAt: end,
      drainReceiptDigest: hash,
    }).success
  ).toBe(true)
})

test('unknown effect observation carries no success or permission assertion', () => {
  const { intent, permit } = fixture()
  const unknown = {
    schemaVersion: 'pi-cancellation-effect-observation/v1',
    requestDigest: intent.requestDigest,
    targetDigest: permit.targetDigest,
    observedAt: at,
    state: 'unknown',
  }
  expect(PiCancellationEffectObservationSchema.safeParse(unknown).success).toBe(true)
  for (const changed of [
    { authorized: true },
    { applied: true },
    { state: 'cancelled' },
    { noSend: true },
  ])
    expect(
      PiCancellationEffectObservationSchema.safeParse({ ...unknown, ...changed }).success
    ).toBe(false)
})

test('a barrier cannot be reused for another generation or process owner', () => {
  const { target, barrier } = fixture()
  expect(() => assertPiCancellationBarrierTarget(target, barrier)).not.toThrow()
  for (const changed of [{ ownerEpoch: 5 }, { targetDigest: `sha256:${'b'.repeat(64)}` }])
    expect(() => assertPiCancellationBarrierTarget(target, { ...barrier, ...changed })).toThrow()
})

test('same request key with a rehashed different target still conflicts', () => {
  const { intent } = fixture()
  const body = {
    target: { ...intent.target, ownerEpoch: 5 },
    idempotencyKey: intent.idempotencyKey,
    requestedAt: intent.requestedAt,
  }
  const changed = { ...intent, ...body, requestDigest: piCancellationRequestDigest(body) }
  expect(() => assertPiCancellationIntentReplay(intent, changed)).toThrow(
    'PI_CANCELLATION_IDEMPOTENCY_CONFLICT'
  )
})

test('unavailable owner never retains, permits, drains or infers an effect', async () => {
  const { target, intent } = fixture()
  const owner = new UnavailablePiCancellationOwner()
  for (const operation of [
    () => owner.retainIntent(intent),
    () => owner.readPermit(intent),
    () => owner.readBarrier(target),
    () => owner.readOutcome(intent),
    () => owner.readCurrentFence(intent),
  ])
    await expect(operation()).rejects.toThrow('PI_CANCELLATION_AUTHORITY_UNAVAILABLE')
})

for (const [name, change] of [
  [
    'handle attempt mismatch',
    (target) => ({
      ...target,
      handle: { ...target.handle, attemptId: id('att').replace(/G$/, 'H') },
    }),
  ],
  [
    'generation key mismatch',
    (target) => ({ ...target, generation: { ...target.generation, inferenceKey: 'wrong:key' } }),
  ],
]) {
  test(`retained intent safeParse returns failure without throwing for nested ${name}`, () => {
    const { intent } = fixture()
    let result
    expect(() => {
      result = PiCancellationRetainedIntentSchema.safeParse({
        ...intent,
        target: change(intent.target),
      })
    }).not.toThrow()
    expect(result?.success).toBe(false)
  })
}

test('submillisecond future issuance and request instants cannot compare equal to an earlier now', () => {
  const { intent, permit, current } = fixture()
  const issuedAt = '2026-10-20T12:00:00.0009Z'
  const now = '2026-10-20T12:00:00.0001Z'
  expect(PiCancellationPermitSchema.safeParse({ ...permit, issuedAt }).success).toBe(false)
  expect(() =>
    assertPiCancellationPermitSnapshot(intent, { ...permit, issuedAt }, current, now)
  ).toThrow()
  const body = {
    target: intent.target,
    idempotencyKey: intent.idempotencyKey,
    requestedAt: issuedAt,
  }
  expect(
    PiCancellationRetainedIntentSchema.safeParse({
      ...intent,
      ...body,
      requestDigest: rawDigest(body),
    }).success
  ).toBe(false)
  expect(() => assertPiCancellationPermitSnapshot(intent, permit, current, now)).toThrow()
})

test('submillisecond permit expiry cannot silently exceed product authority expiry', () => {
  const { intent, permit, current } = fixture()
  const target = { ...intent.target, authorityExpiresAt: '2026-10-20T12:01:00.0001Z' }
  const body = { target, idempotencyKey: intent.idempotencyKey, requestedAt: at }
  const changedIntent = { ...intent, ...body, requestDigest: rawDigest(body) }
  const targetDigest = rawDigest(target)
  const changedPermit = {
    ...permit,
    requestDigest: changedIntent.requestDigest,
    targetDigest,
    expiresAt: '2026-10-20T12:01:00.0009Z',
  }
  expect(PiCancellationRetainedIntentSchema.safeParse(changedIntent).success).toBe(false)
  expect(PiCancellationPermitSchema.safeParse(changedPermit).success).toBe(false)
  expect(() =>
    assertPiCancellationPermitSnapshot(
      changedIntent,
      changedPermit,
      { ...current, target, requestDigest: changedIntent.requestDigest },
      at
    )
  ).toThrow()
})

test('submillisecond drain before barrier request cannot silently compare equal', () => {
  const { barrier } = fixture()
  expect(
    PiCancellationBarrierSchema.safeParse({
      ...barrier,
      state: 'drained',
      requestedAt: '2026-10-20T12:00:00.0009Z',
      drainedAt: '2026-10-20T12:00:00.0001Z',
      drainReceiptDigest: hash,
    }).success
  ).toBe(false)
})

test('target, nested handle and outcome timestamps use the same millisecond precision', () => {
  const { target, intent, permit } = fixture()
  for (const instant of ['2026-10-20T12:00:00Z', '2026-10-20T12:00:00.0001Z']) {
    expect(
      PiCancellationTargetSchema.safeParse({ ...target, authorityExpiresAt: instant }).success
    ).toBe(false)
    expect(
      PiCancellationTargetSchema.safeParse({
        ...target,
        handle: { ...target.handle, startedAt: instant },
      }).success
    ).toBe(false)
    expect(
      PiCancellationEffectObservationSchema.safeParse({
        schemaVersion: 'pi-cancellation-effect-observation/v1',
        requestDigest: intent.requestDigest,
        targetDigest: permit.targetDigest,
        observedAt: instant,
        state: 'unknown',
      }).success
    ).toBe(false)
  }
})
