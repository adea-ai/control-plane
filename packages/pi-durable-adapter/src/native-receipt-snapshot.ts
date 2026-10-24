import { z } from 'zod'
import { canonicalJsonStringify } from '@control-plane/contracts'

const Reference = z.string().min(1).max(8192)
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Ids = z
  .array(z.number().int().positive().safe())
  .refine((ids) => new Set(ids).size === ids.length)

/** The pins a caller holds for one historical cancellation request. They name evidence only. */
export const PiFrozenReceiptIdentitySchema = z.strictObject({
  sessionId: Reference,
  requestId: Reference,
  requestDigest: Digest,
  targetDigest: Digest,
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  turnKey: Reference,
  inferenceId: Reference.nullable(),
})
export type PiFrozenReceiptIdentity = z.infer<typeof PiFrozenReceiptIdentitySchema>

const ReceiptSchema = z.strictObject({
  version: z.literal(1),
  requestId: Reference,
  requestDigest: Digest,
  conversationId: z.number().int().positive().safe(),
  background: z.literal(false),
  taskIds: Ids,
  queuedInputIds: Ids,
  metadata: z.strictObject({
    targetDigest: Digest,
    expiresAt: z.string(),
    fenceRevision: z.number().int().nonnegative().safe(),
    inferenceId: z.string().nullable(),
    turnKey: z.string(),
    scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
})
export type PiFrozenReceipt = z.infer<typeof ReceiptSchema>

/**
 * What an issuer must say about the snapshot it captured. It is a requirement on the issuer,
 * not something a caller can supply: the reader only accepts these values from a handle the
 * issuer sealed.
 */
export interface PiReceiptSnapshotProvenance {
  readonly sessionId: string
  readonly conversationId: number
  readonly restoreGeneration: string
  readonly ownerEpoch: number
  /** The captured state is detached from any live store, WAL or sidecar. */
  readonly detached: true
  /** The capture is one coherent cut, not a file copied while a writer was active. */
  readonly coherent: true
  /** Reads of the snapshot are SELECT-only; the issuer opened nothing writable. */
  readonly access: 'select_only'
}

export interface PiReceiptSnapshotSource {
  readonly provenance: PiReceiptSnapshotProvenance
  /** The replayed `pi.guarded-abort-receipts` ledger as already read by the issuer. */
  readonly ledger: unknown
}

declare const issuedBrand: unique symbol

/**
 * Opaque handle for one detached, coherent, SELECT-only snapshot. It exposes no path, hash,
 * store, statement or flag. Only {@link sealPiReceiptSnapshot} makes one, and that function is
 * deliberately not exported from the package index: until an SDK-owned issuer exists, nothing
 * in production can call it. The brand is encapsulation, not cryptography.
 */
export interface PiIssuedReceiptSnapshot {
  readonly [issuedBrand]: never
}

interface Sealed {
  readonly provenance: PiReceiptSnapshotProvenance
  readonly ledger: unknown
}
const sealed = new WeakMap<object, Sealed>()

function detach(value: unknown): unknown {
  // canonicalJsonStringify rejects non-JSON values; parse gives a private, unshared copy.
  const copy = JSON.parse(canonicalJsonStringify(value)) as unknown
  const freeze = (item: unknown): unknown => {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child)
      Object.freeze(item)
    }
    return item
  }
  return freeze(copy)
}

/**
 * Issuer seam. A trusted issuer calls this once it holds a detached coherent cut it read with
 * SELECT only. The ledger is copied and frozen here, so later mutation of the caller's value
 * cannot change what the reader sees.
 */
export function sealPiReceiptSnapshot(source: PiReceiptSnapshotSource): PiIssuedReceiptSnapshot {
  const { provenance } = source
  if (
    provenance.detached !== true ||
    provenance.coherent !== true ||
    provenance.access !== 'select_only' ||
    !Reference.safeParse(provenance.sessionId).success ||
    !Reference.safeParse(provenance.restoreGeneration).success ||
    !Number.isSafeInteger(provenance.conversationId) ||
    provenance.conversationId < 1 ||
    !Number.isSafeInteger(provenance.ownerEpoch) ||
    provenance.ownerEpoch < 0
  )
    throw new Error('PI_RECEIPT_SNAPSHOT_PROVENANCE_INVALID')
  const handle = Object.freeze(Object.create(null)) as PiIssuedReceiptSnapshot
  sealed.set(
    handle,
    Object.freeze({
      provenance: Object.freeze({ ...provenance }),
      ledger: detach(source.ledger),
    })
  )
  return handle
}

/** Issuer port. The default refuses; no production issuer exists. */
export interface PiReceiptSnapshotIssuerPort {
  issue(request: {
    readonly sessionId: string
    readonly conversationId: number
  }): Promise<PiIssuedReceiptSnapshot>
}

export class UnavailablePiReceiptSnapshotIssuer implements PiReceiptSnapshotIssuerPort {
  issue(): Promise<never> {
    return Promise.reject(new Error('PI_RECEIPT_SNAPSHOT_ISSUER_UNAVAILABLE'))
  }
}

export type PiFrozenReceiptLookup =
  /** The snapshot holds a receipt matching every pin. Historical evidence, not authority. */
  | { readonly outcome: 'found'; readonly receipt: PiFrozenReceipt }
  /** No receipt for this request in this snapshot. Not proof the effect never happened live. */
  | { readonly outcome: 'absent' }

/**
 * Looks up one historical native abort receipt in a sealed snapshot. It takes no path, hash or
 * boolean, opens no store and cannot write. Anything that is not a handle sealed by the issuer
 * seam, any binding mismatch and any malformed or ambiguous ledger fails closed with a coded
 * error. A result describes a past committed effect and never authorizes a new one.
 */
export function readPiFrozenReceipt(
  snapshot: unknown,
  identityInput: unknown
): PiFrozenReceiptLookup {
  const issued =
    typeof snapshot === 'object' && snapshot !== null ? sealed.get(snapshot) : undefined
  if (issued === undefined) throw new Error('PI_FROZEN_RECEIPT_SNAPSHOT_NOT_ISSUED')
  const parsed = PiFrozenReceiptIdentitySchema.safeParse(identityInput)
  if (!parsed.success) throw new Error('PI_FROZEN_RECEIPT_IDENTITY_INVALID')
  const pins = parsed.data
  if (pins.sessionId !== issued.provenance.sessionId)
    throw new Error('PI_FROZEN_RECEIPT_SESSION_MISMATCH')

  // The whole ledger is validated before any absent or found result, so a malformed, foreign
  // or ambiguous entry can never read as "absent".
  const ledger = issued.ledger
  if (
    typeof ledger !== 'object' ||
    ledger === null ||
    !Array.isArray((ledger as { receipts?: unknown }).receipts)
  )
    throw new Error('PI_FROZEN_RECEIPT_LEDGER_INVALID')
  const entries: PiFrozenReceipt[] = []
  const seen = new Set<string>()
  for (const item of (ledger as { receipts: unknown[] }).receipts) {
    const entry = ReceiptSchema.safeParse(item)
    if (!entry.success) throw new Error('PI_FROZEN_RECEIPT_LEDGER_INVALID')
    const key = `${entry.data.conversationId}\u0000${entry.data.requestId}`
    if (seen.has(key)) throw new Error('PI_FROZEN_RECEIPT_LEDGER_INVALID')
    seen.add(key)
    entries.push(entry.data)
  }
  const forRequest = entries.filter((entry) => entry.requestId === pins.requestId)
  // The same request in another conversation is a foreign container, not an absent receipt.
  if (forRequest.some((entry) => entry.conversationId !== issued.provenance.conversationId))
    throw new Error('PI_FROZEN_RECEIPT_CROSS_CONVERSATION')
  const match = forRequest[0]
  if (match === undefined) return Object.freeze({ outcome: 'absent' })

  if (
    match.requestDigest !== pins.requestDigest ||
    match.metadata.targetDigest !== pins.targetDigest ||
    match.metadata.expiresAt !== pins.expiresAt ||
    match.metadata.turnKey !== pins.turnKey ||
    match.metadata.inferenceId !== pins.inferenceId
  )
    throw new Error('PI_FROZEN_RECEIPT_BINDING_INVALID')
  return Object.freeze({ outcome: 'found', receipt: match })
}
