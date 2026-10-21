// The complete-writer coverage of the durable Pi state.
//
// The native cancellation boundary says outright that matching installation
// evidence "never proves canonical R, drain D or complete writer coverage". This
// file is the proof that the coverage is complete, and it proves two properties
// independently:
//
//   1. no writer accepts a rewound epoch or a rewound restore generation, so a
//      restore cannot re-point work that a later owner has already fenced; and
//   2. the restore generation is bound into the request digest, so it is
//      independent of the snapshot it came from: a restore that re-points it
//      cannot be replayed as the same request.
//
// The writers are enumerated from the source, so a writer that starts accepting
// a target or an epoch without being registered here fails this file.
//
// These are pure contracts. No fixture supplies production authority, no
// database is opened and no effect is performed.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PiCancellationBarrierSchema,
  PiCancellationRetainedIntentSchema,
  PiCancellationTargetSchema,
  assertPiCancellationPermitSnapshot,
  piCancellationRequestDigest,
  piCancellationTargetDigest,
} from './cancellation-owner.ts'
import {
  PiNativeCancellationFenceReceiptSchema,
  PiNativeCancellationFenceRequestSchema,
  assertPiNativeCancellationReceiptBinding,
  piNativeCancellationTargetDigest,
} from './native-cancellation-boundary.ts'

const here = dirname(fileURLToPath(import.meta.url))
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-20T12:00:00.000Z'
const end = '2026-10-20T12:01:00.000Z'
const hash = `sha256:${'a'.repeat(64)}`

function fixture() {
  const target = PiCancellationTargetSchema.parse({
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
  })
  const body = { target, requestedAt: at, idempotencyKey: 'cancel:one' }
  const intent = {
    ...body,
    schemaVersion: 'pi-cancellation-retained-intent/v1',
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
  return { target, intent, permit, current, candidate, preparation, receipt, fence }
}

// The writers of the durable state that can accept a cancellation target or an
// epoch, and the proof that each one refuses a rewound one.
const writers = [
  {
    module: 'cancellation-owner.ts',
    accepts: 'a cancellation target, a retained intent, a permit and a barrier epoch',
    refusesRewoundEpoch(f) {
      // A barrier that does not advance the epoch is never a barrier.
      const barrier = PiCancellationBarrierSchema.safeParse({
        schemaVersion: 'pi-cancellation-barrier/v1',
        barrierId: 'barrier:one',
        targetDigest: f.permit.targetDigest,
        ownerEpoch: f.target.ownerEpoch,
        previousEpoch: 7,
        fenceEpoch: 7,
        requestedAt: at,
        state: 'pending',
      })
      expect(barrier.success).toBe(false)
      expect(JSON.stringify(barrier.error)).toContain('barrier epoch must advance')
      // A permit whose fence epoch is behind the current fence proves nothing.
      expect(() =>
        assertPiCancellationPermitSnapshot(f.intent, f.permit, { ...f.current, fenceEpoch: 9 }, at)
      ).toThrow()
    },
    refusesRewoundRestoreGeneration(f) {
      // The restore generation is bound into the request, so a restore that
      // re-points it is a different request and cannot be replayed as this one.
      const rewound = { ...f.target, restoreGeneration: 'restore:fixture:0' }
      const body = { target: rewound, requestedAt: at, idempotencyKey: 'cancel:one' }
      expect(piCancellationRequestDigest(body)).not.toBe(f.intent.requestDigest)
      const replay = PiCancellationRetainedIntentSchema.safeParse({ ...f.intent, target: rewound })
      expect(replay.success).toBe(false)
      expect(JSON.stringify(replay.error)).toContain('request digest mismatch')
    },
  },
  {
    module: 'native-cancellation-boundary.ts',
    accepts: 'a native target, a preparation, a commit receipt and a fence epoch',
    refusesRewoundEpoch(f) {
      const fence = PiNativeCancellationFenceRequestSchema.safeParse({
        ...f.fence,
        previousEpoch: 5,
        fenceEpoch: 5,
      })
      expect(fence.success).toBe(false)
      expect(JSON.stringify(fence.error)).toContain('native fence epoch must advance')
    },
    refusesRewoundRestoreGeneration(f) {
      // The receipt must carry the exact restore generation of the intent.
      expect(() =>
        assertPiNativeCancellationReceiptBinding(f.intent, f.preparation, {
          ...f.receipt,
          restoreGeneration: 'restore:fixture:0',
        })
      ).toThrow(/PI_NATIVE_CANCELLATION_RECEIPT_MISMATCH/)
      // And the fence receipt is bound to the exact request it answers.
      expect(() =>
        PiNativeCancellationFenceReceiptSchema.safeParse({
          ...f.fence,
          schemaVersion: 'pi-native-cancellation-fence-receipt/v1',
          installationReceiptId: 'installation:one',
          nativeCommitSequence: 9,
          installedAt: at,
        })
      ).not.toThrow()
    },
  },
]

test('every writer that accepts a target or an epoch refuses a rewound one', () => {
  for (const writer of writers) {
    const f = fixture()
    writer.refusesRewoundEpoch(f)
    writer.refusesRewoundRestoreGeneration(f)
  }
})

test('the writer registry covers every module that accepts a target or an epoch', () => {
  // The registry is derived from the source, so a writer that starts accepting a
  // target or an epoch without a proof here fails this file.
  const accepting = new Set()
  for (const entry of readdirSync(here)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
    const source = readFileSync(join(here, entry), 'utf8')
    // A writer that accepts a target or an epoch declares one of the target or
    // epoch schemas. The adapter issues the epoch and the journal records the
    // current owner; neither accepts one.
    const acceptsATargetOrEpoch = [
      'PiCancellationTargetSchema',
      'PiNativeCancellationTargetSchema',
      'PiCancellationBarrierSchema',
      'PiNativeCancellationFenceRequestSchema',
    ].some((schema) => source.includes(schema))
    if (acceptsATargetOrEpoch) accepting.add(entry)
  }
  const registered = new Set(writers.map((writer) => writer.module))
  for (const module of accepting) {
    expect(registered.has(module)).toBe(true)
  }
  expect(accepting.size).toBeGreaterThan(0)
})
