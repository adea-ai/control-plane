import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import { RuntimeExecutionHandleSchema } from '@control-plane/runtime-sdk'

const Reference = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => value.trim() === value && value.trim().length > 0)
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Epoch = z.number().int().nonnegative().safe()
// Date.parse preserves milliseconds only. Reject finer precision rather than silently truncating it.
const Instant = z.iso.datetime({ precision: 3 })
const Generation = z.strictObject({
  inferenceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
  inferenceKey: Reference,
})

/** Structural contracts only. Parsing cannot establish current authority or restore provenance. */
export const PiCancellationTargetSchema = z
  .strictObject({
    workspaceId: IdentifierSchemas.workspaceId,
    productIntentId: z.uuid(),
    originalActorPrincipalId: Reference,
    servicePrincipalId: Reference,
    scopeRef: Reference,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    executionVersion: z.number().int().positive().safe(),
    attemptVersion: z.number().int().positive().safe(),
    admissionDigest: Digest,
    handle: RuntimeExecutionHandleSchema.extend({ startedAt: Instant }),
    restoreGeneration: Reference,
    ownerEpoch: Epoch,
    turnKey: z.string().min(1).max(4096),
    targetKind: z.enum(['active_generation', 'no_active_generation', 'untracked_generation']),
    generation: Generation.nullable(),
    authorityExpiresAt: Instant,
  })
  .superRefine((target, context) => {
    if (target.handle.attemptId !== target.attemptId)
      context.addIssue({ code: 'custom', message: 'attempt mismatch' })
    if ((target.targetKind === 'active_generation') !== (target.generation !== null))
      context.addIssue({ code: 'custom', message: 'generation required only for active target' })
    if (
      target.generation &&
      target.generation.inferenceKey !== `${target.turnKey}:${target.generation.inferenceId}`
    )
      context.addIssue({ code: 'custom', message: 'generation key mismatch' })
  })

const RequestBody = z.strictObject({
  target: PiCancellationTargetSchema,
  idempotencyKey: z.string().min(1).max(512),
  requestedAt: Instant,
})
const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`

export function piCancellationRequestDigest(input: z.input<typeof RequestBody>): string {
  return digest(RequestBody.parse(input))
}
export function piCancellationTargetDigest(
  input: z.input<typeof PiCancellationTargetSchema>
): string {
  return digest(PiCancellationTargetSchema.parse(input))
}

/** Durable retry intent. It is deliberately not a permit. */
export const PiCancellationRetainedIntentSchema = RequestBody.extend({
  schemaVersion: z.literal('pi-cancellation-retained-intent/v1'),
  requestDigest: Digest,
}).superRefine((intent, context) => {
  const { target, idempotencyKey, requestedAt } = intent
  // Nested continuable refinements may already have added issues. Hash this parsed
  // body directly: reparsing it here could throw from the enclosing safeParse.
  if (intent.requestDigest !== digest({ target, idempotencyKey, requestedAt }))
    context.addIssue({ code: 'custom', message: 'request digest mismatch' })
  if (Date.parse(requestedAt) >= Date.parse(target.authorityExpiresAt))
    context.addIssue({ code: 'custom', message: 'request expired' })
})
export type PiCancellationRetainedIntent = z.infer<typeof PiCancellationRetainedIntentSchema>

/** Revocable snapshot, never a bearer grant. A real effect owner must serialize its consumption. */
export const PiCancellationPermitSchema = z
  .strictObject({
    schemaVersion: z.literal('pi-cancellation-revocable-permit/v1'),
    permitId: Reference,
    requestDigest: Digest,
    targetDigest: Digest,
    fenceEpoch: Epoch,
    issuedAt: Instant,
    expiresAt: Instant,
  })
  .superRefine((permit, context) => {
    if (Date.parse(permit.issuedAt) >= Date.parse(permit.expiresAt))
      context.addIssue({ code: 'custom', message: 'invalid permit lifetime' })
  })
export type PiCancellationPermit = z.infer<typeof PiCancellationPermitSchema>

export const PiCancellationCurrentFenceSchema = z.strictObject({
  schemaVersion: z.literal('pi-cancellation-current-fence/v1'),
  target: PiCancellationTargetSchema,
  requestDigest: Digest,
  permitId: Reference,
  fenceEpoch: Epoch,
  fenceState: z.enum(['open', 'closing', 'closed', 'unknown']),
  permitState: z.enum(['active', 'revoked', 'unknown']),
})

/** A drained record needs external proof. Its shape alone cannot authorize a writer to commit. */
export const PiCancellationBarrierSchema = z
  .strictObject({
    schemaVersion: z.literal('pi-cancellation-barrier/v1'),
    barrierId: Reference,
    targetDigest: Digest,
    ownerEpoch: Epoch,
    previousEpoch: Epoch,
    fenceEpoch: Epoch,
    requestedAt: Instant,
    state: z.enum(['pending', 'unknown', 'drained']),
    drainedAt: Instant.optional(),
    drainReceiptDigest: Digest.optional(),
  })
  .superRefine((barrier, context) => {
    if (barrier.fenceEpoch <= barrier.previousEpoch)
      context.addIssue({ code: 'custom', message: 'barrier epoch must advance' })
    if (
      (barrier.state === 'drained') !==
      (barrier.drainedAt !== undefined && barrier.drainReceiptDigest !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'drain receipt required only for drained barrier',
      })
    if (
      barrier.state !== 'drained' &&
      (barrier.drainedAt !== undefined || barrier.drainReceiptDigest !== undefined)
    )
      context.addIssue({ code: 'custom', message: 'unresolved barrier cannot claim drain' })
    if (barrier.drainedAt && Date.parse(barrier.drainedAt) < Date.parse(barrier.requestedAt))
      context.addIssue({ code: 'custom', message: 'drain predates barrier' })
  })
export type PiCancellationBarrier = z.infer<typeof PiCancellationBarrierSchema>

export const PiCancellationEffectObservationSchema = z.strictObject({
  schemaVersion: z.literal('pi-cancellation-effect-observation/v1'),
  requestDigest: Digest,
  targetDigest: Digest,
  observedAt: Instant,
  state: z.enum(['pending', 'unknown', 'denied']),
})
export type PiCancellationEffectObservation = z.infer<typeof PiCancellationEffectObservationSchema>

function rejected(): never {
  throw new Error('PI_CANCELLATION_AUTHORITY_REJECTED')
}

export function assertPiCancellationIntentReplay(retained: unknown, incoming: unknown): void {
  const first = PiCancellationRetainedIntentSchema.parse(retained)
  const next = PiCancellationRetainedIntentSchema.parse(incoming)
  if (canonicalJsonStringify(first) !== canonicalJsonStringify(next))
    throw new Error('PI_CANCELLATION_IDEMPOTENCY_CONFLICT')
}

/** Pure snapshot rejection helper only; no I/O, lease, effect permission or atomicity claim. */
export function assertPiCancellationPermitSnapshot(
  intentInput: unknown,
  permitInput: unknown,
  currentInput: unknown,
  nowInput: string
): void {
  const intent = PiCancellationRetainedIntentSchema.parse(intentInput)
  const permit = PiCancellationPermitSchema.parse(permitInput)
  const current = PiCancellationCurrentFenceSchema.parse(currentInput)
  const now = Date.parse(Instant.parse(nowInput))
  if (
    intent.target.targetKind === 'untracked_generation' ||
    current.fenceState !== 'open' ||
    current.permitState !== 'active' ||
    current.fenceEpoch !== permit.fenceEpoch ||
    current.permitId !== permit.permitId ||
    current.requestDigest !== intent.requestDigest ||
    permit.requestDigest !== intent.requestDigest ||
    permit.targetDigest !== piCancellationTargetDigest(intent.target) ||
    piCancellationTargetDigest(current.target) !== permit.targetDigest ||
    Date.parse(permit.expiresAt) > Date.parse(intent.target.authorityExpiresAt) ||
    Date.parse(permit.issuedAt) < Date.parse(intent.requestedAt) ||
    now < Date.parse(permit.issuedAt) ||
    now >= Date.parse(permit.expiresAt)
  )
    rejected()
}

/** Exact barrier binding only. A matching receipt still needs a qualified owner to prove drain. */
export function assertPiCancellationBarrierTarget(
  targetInput: unknown,
  barrierInput: unknown
): void {
  const target = PiCancellationTargetSchema.parse(targetInput)
  const barrier = PiCancellationBarrierSchema.parse(barrierInput)
  if (
    barrier.targetDigest !== piCancellationTargetDigest(target) ||
    barrier.ownerEpoch !== target.ownerEpoch
  )
    rejected()
}

/** Proposed owner seam only; deliberately not injected into the production adapter. */
export interface PiCancellationOwnerPort {
  retainIntent(intent: PiCancellationRetainedIntent): Promise<PiCancellationRetainedIntent>
  readPermit(intent: PiCancellationRetainedIntent): Promise<PiCancellationPermit | undefined>
  readCurrentFence(
    intent: PiCancellationRetainedIntent
  ): Promise<z.infer<typeof PiCancellationCurrentFenceSchema>>
  readBarrier(
    target: z.infer<typeof PiCancellationTargetSchema>
  ): Promise<PiCancellationBarrier | undefined>
  readOutcome(intent: PiCancellationRetainedIntent): Promise<PiCancellationEffectObservation>
}

export class UnavailablePiCancellationOwner implements PiCancellationOwnerPort {
  async retainIntent(_intent: PiCancellationRetainedIntent): Promise<PiCancellationRetainedIntent> {
    return this.unavailable()
  }
  async readPermit(
    _intent: PiCancellationRetainedIntent
  ): Promise<PiCancellationPermit | undefined> {
    return this.unavailable()
  }
  async readBarrier(
    _target: z.infer<typeof PiCancellationTargetSchema>
  ): Promise<PiCancellationBarrier | undefined> {
    return this.unavailable()
  }
  async readCurrentFence(
    _intent: PiCancellationRetainedIntent
  ): Promise<z.infer<typeof PiCancellationCurrentFenceSchema>> {
    return this.unavailable()
  }
  async readOutcome(
    _intent: PiCancellationRetainedIntent
  ): Promise<PiCancellationEffectObservation> {
    return this.unavailable()
  }
  private unavailable(): never {
    throw new Error('PI_CANCELLATION_AUTHORITY_UNAVAILABLE')
  }
}
