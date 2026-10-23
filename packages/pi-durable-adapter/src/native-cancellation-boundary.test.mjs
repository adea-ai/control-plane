import { expect, test } from 'bun:test'
import { piCancellationRequestDigest } from './cancellation-owner.ts'
import {
  PiNativeCancellationTargetSchema,
  PiNativeCancellationPreparationSchema,
  PiNativeCancellationCommitReceiptSchema,
  PiNativeCancellationFenceRequestSchema,
  PiNativeCancellationFenceReceiptSchema,
  PiNativeCancellationReceiptIdentitySchema,
  UnavailablePiNativeCancellationBoundary,
  assertPiNativeCancellationReceiptBinding,
  assertPiNativeCancellationFenceReceiptBinding,
  piNativeCancellationTargetDigest,
} from './native-cancellation-boundary.ts'

const at = '2026-10-20T12:00:00.000Z'
const end = '2026-10-20T12:01:00.000Z'
const hash = `sha256:${'a'.repeat(64)}`
const otherHash = `sha256:${'b'.repeat(64)}`
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
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
    restoreGeneration: 'restore:fixture:1',
    ownerEpoch: 4,
    turnKey: 'turn:initial',
    targetKind: 'active_generation',
    generation: { inferenceId: 'native:1', inferenceKey: 'turn:initial:native:1' },
    authorityExpiresAt: end,
  }
  const body = { target, requestedAt: at, idempotencyKey: 'cancel:one' }
  const intent = {
    ...body,
    schemaVersion: 'pi-cancellation-retained-intent/v1',
    requestDigest: piCancellationRequestDigest(body),
  }
  const candidate = {
    target,
    nativeSessionId: target.handle.externalSessionId,
    conversationId: 1,
    scopeRevision: 3,
    taskRevisionDigest: hash,
    inputRevisionDigest: hash,
    processClaimId: 'process:one',
  }
  const preparation = {
    schemaVersion: 'pi-native-cancellation-preparation/v1',
    preparationId: 'prepare:one',
    requestDigest: intent.requestDigest,
    candidate,
    preparedAt: at,
  }
  const receipt = {
    schemaVersion: 'pi-native-cancellation-commit-receipt/v1',
    nativeReceiptId: 'native:receipt:one',
    requestDigest: intent.requestDigest,
    nativeTargetDigest: piNativeCancellationTargetDigest(candidate),
    processClaimId: candidate.processClaimId,
    restoreGeneration: target.restoreGeneration,
    ownerEpoch: target.ownerEpoch,
    nativeCommitSequence: 8,
    admittedAt: at,
    committedAt: at,
    earliestAuthorityExpiresAt: end,
    outcome: 'committed_effect',
  }
  const fence = {
    mutationId: 'mutation:one',
    scopeSetDigest: hash,
    closureGeneration: 'closure:one',
    processClaimId: candidate.processClaimId,
    restoreGeneration: target.restoreGeneration,
    ownerEpoch: target.ownerEpoch,
    previousEpoch: 4,
    fenceEpoch: 5,
  }
  const installation = {
    ...fence,
    schemaVersion: 'pi-native-cancellation-fence-receipt/v1',
    installationReceiptId: 'installation:one',
    nativeCommitSequence: 9,
    installedAt: at,
  }
  const identity = Object.fromEntries(
    [
      'nativeReceiptId',
      'requestDigest',
      'nativeTargetDigest',
      'processClaimId',
      'restoreGeneration',
      'ownerEpoch',
    ].map((key) => [key, receipt[key]])
  )
  return { intent, candidate, preparation, receipt, fence, installation, identity }
}

test('native target digest binds scope/task/input cut, claim and exact product generation', () => {
  const { candidate } = fixture()
  for (const patch of [
    { conversationId: 2 },
    { scopeRevision: 4 },
    { taskRevisionDigest: otherHash },
    { inputRevisionDigest: otherHash },
    { processClaimId: 'process:successor' },
    { target: { ...candidate.target, restoreGeneration: 'restore:successor' } },
    { target: { ...candidate.target, ownerEpoch: 5 } },
    {
      target: {
        ...candidate.target,
        generation: { inferenceId: 'native:2', inferenceKey: 'turn:initial:native:2' },
      },
    },
  ])
    expect(piNativeCancellationTargetDigest({ ...candidate, ...patch })).not.toBe(
      piNativeCancellationTargetDigest(candidate)
    )
  for (const patch of [
    { conversationId: -1 },
    { nativeSessionId: 'native:other' },
    { scopeRevision: 1.1 },
    { processClaimId: ' ' },
    { authorizes: true },
  ])
    expect(PiNativeCancellationTargetSchema.safeParse({ ...candidate, ...patch }).success).toBe(
      false
    )
})

test('preparation and retained intent cannot be parsed as native commit evidence or a fence ACK', () => {
  const { intent, preparation } = fixture()
  expect(PiNativeCancellationPreparationSchema.parse(preparation)).toEqual(preparation)
  for (const input of [intent, preparation, { ...preparation, authorized: true }]) {
    expect(PiNativeCancellationCommitReceiptSchema.safeParse(input).success).toBe(false)
    expect(PiNativeCancellationFenceReceiptSchema.safeParse(input).success).toBe(false)
  }
})

test('receipt binding rejects changed request, native scope, owner and generation without granting authority', () => {
  const { intent, preparation, receipt } = fixture()
  expect(() => assertPiNativeCancellationReceiptBinding(intent, preparation, receipt)).not.toThrow()
  for (const patch of [
    { requestDigest: otherHash },
    { nativeTargetDigest: otherHash },
    { processClaimId: 'process:successor' },
    { restoreGeneration: 'restore:successor' },
    { ownerEpoch: 5 },
    { earliestAuthorityExpiresAt: '2026-10-20T12:02:00.000Z' },
  ])
    expect(() =>
      assertPiNativeCancellationReceiptBinding(intent, preparation, { ...receipt, ...patch })
    ).toThrow('PI_NATIVE_CANCELLATION_RECEIPT_MISMATCH')
  for (const patch of [
    { requestDigest: otherHash },
    { candidate: { ...preparation.candidate, scopeRevision: 4 } },
    {
      candidate: {
        ...preparation.candidate,
        target: { ...intent.target, originalActorPrincipalId: 'user:other' },
      },
    },
    { preparedAt: '2026-10-20T11:59:59.999Z' },
    { preparedAt: '2026-10-20T12:00:00.001Z' },
  ])
    expect(() =>
      assertPiNativeCancellationReceiptBinding(intent, { ...preparation, ...patch }, receipt)
    ).toThrow('PI_NATIVE_CANCELLATION_RECEIPT_MISMATCH')
})

for (const patch of [
  { requestedAt: 'malformed' },
  { idempotencyKey: 'cancel:changed-with-old-digest' },
])
  test(`receipt binding rejects invalid retained intent ${JSON.stringify(patch)}`, () => {
    const { intent, preparation, receipt } = fixture()
    expect(() =>
      assertPiNativeCancellationReceiptBinding({ ...intent, ...patch }, preparation, receipt)
    ).toThrow()
  })

test('native receipt requires exclusive admission deadline and millisecond precision', () => {
  const { receipt, preparation } = fixture()
  for (const patch of [
    { admittedAt: end, committedAt: end },
    { committedAt: '2026-10-20T11:59:59.999Z' },
    { admittedAt: '2026-10-20T12:00:00.0009Z' },
    { committedAt: '2026-10-20T12:00:00.0009Z' },
    { earliestAuthorityExpiresAt: '2026-10-20T12:01:00.0009Z' },
    { outcome: 'unknown' },
    { authorized: true },
  ])
    expect(
      PiNativeCancellationCommitReceiptSchema.safeParse({ ...receipt, ...patch }).success
    ).toBe(false)
  expect(
    PiNativeCancellationPreparationSchema.safeParse({
      ...preparation,
      preparedAt: '2026-10-20T12:00:00.0009Z',
    }).success
  ).toBe(false)
  // Admission and fsync completion are distinct; a persisted historical receipt is not a new permit.
  expect(
    PiNativeCancellationCommitReceiptSchema.safeParse({
      ...receipt,
      committedAt: '2026-10-20T12:02:00.000Z',
    }).success
  ).toBe(true)
})

test('fence ACK binds mutation-owned closure and cannot claim drain or canonical mutation', () => {
  const { fence, installation } = fixture()
  expect(PiNativeCancellationFenceRequestSchema.parse(fence)).toEqual(fence)
  expect(PiNativeCancellationFenceReceiptSchema.parse(installation)).toEqual(installation)
  expect(() => assertPiNativeCancellationFenceReceiptBinding(fence, installation)).not.toThrow()
  for (const patch of [
    { mutationId: 'mutation:other' },
    { scopeSetDigest: otherHash },
    { closureGeneration: 'closure:other' },
    { processClaimId: 'process:other' },
    { restoreGeneration: 'restore:other' },
    { ownerEpoch: 5 },
    { previousEpoch: 3 },
    { fenceEpoch: 6 },
  ])
    expect(() =>
      assertPiNativeCancellationFenceReceiptBinding(fence, { ...installation, ...patch })
    ).toThrow('PI_NATIVE_CANCELLATION_FENCE_RECEIPT_MISMATCH')
  for (const patch of [
    { fenceEpoch: 4 },
    { fenceEpoch: 3 },
    { mutationId: '' },
    { drained: true },
    { canonicalCommitted: true },
    { installedAt: '2026-10-20T12:00:00.0001Z' },
  ])
    expect(
      PiNativeCancellationFenceReceiptSchema.safeParse({ ...installation, ...patch }).success
    ).toBe(false)
})

test('nested target refinement failures return safeParse failure, never a throw', () => {
  const { preparation } = fixture()
  for (const patch of [
    {
      handle: {
        ...preparation.candidate.target.handle,
        attemptId: 'att_01JABCDEF0123456789ABCDEFH',
      },
    },
    { generation: { inferenceId: 'native:1', inferenceKey: 'wrong' } },
  ]) {
    const input = {
      ...preparation,
      candidate: {
        ...preparation.candidate,
        target: { ...preparation.candidate.target, ...patch },
      },
    }
    expect(() => PiNativeCancellationPreparationSchema.safeParse(input)).not.toThrow()
    expect(PiNativeCancellationPreparationSchema.safeParse(input).success).toBe(false)
  }
})

test('unqualified native boundary never synthesizes preparation, commit, installation, replay or drain', async () => {
  const { intent, candidate, preparation, fence, identity, receipt } = fixture()
  const boundary = new UnavailablePiNativeCancellationBoundary()
  expect(PiNativeCancellationReceiptIdentitySchema.parse(identity)).toEqual(identity)
  for (const call of [
    () => boundary.prepare(intent, candidate),
    () => boundary.commit(intent, preparation, intent),
    () => boundary.installFence(fence),
    () => boundary.readReceipt(identity),
    () => boundary.drain(identity),
    () => boundary.drain({ ...identity, processClaimId: 'process:successor' }),
    () => boundary.commit(intent, preparation, receipt),
  ])
    await expect(call()).rejects.toThrow('PI_NATIVE_CANCELLATION_BOUNDARY_UNAVAILABLE')
})
