import { z } from 'zod'
import { canonicalJsonStringify } from '@control-plane/contracts'

const Reference = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => value.trim() === value)
const Revision = z.number().int().nonnegative().safe()

/** Structural evidence only; parsing cannot establish independence from restored stores. */
export const PiRestoreGenerationSnapshotSchema = z.strictObject({
  lineageId: Reference,
  restoreGeneration: Reference,
  revision: Revision,
  state: z.enum(['open', 'closing']),
})
export type PiRestoreGenerationSnapshot = z.infer<typeof PiRestoreGenerationSnapshotSchema>

const ExpectedGenerationSchema = PiRestoreGenerationSnapshotSchema.omit({ state: true })
export type PiRestoreGenerationExpected = z.infer<typeof ExpectedGenerationSchema>

/**
 * The provider must live outside every restorable product, CP and native snapshot.
 * This port does not supply that provider, advance generations or fence writers.
 * Implementations must fail on missing or ambiguous current authority.
 */
export interface PiRestoreGenerationAuthorityPort {
  readCurrent(lineageId: string): Promise<PiRestoreGenerationSnapshot>
}

export class UnavailablePiRestoreGenerationAuthority implements PiRestoreGenerationAuthorityPort {
  async readCurrent(_lineageId: string): Promise<PiRestoreGenerationSnapshot> {
    throw new Error('PI_RESTORE_GENERATION_AUTHORITY_UNAVAILABLE')
  }
}

/**
 * Dormant evidence reader, with no production wiring or independent storage provider.
 * A successful async read is only a snapshot, NOT atomic write/effect authority:
 * authority may change immediately after it resolves. Native admission and every
 * writer still require their own qualified commit-time fence. No cached/local
 * digest, caller generation or previous successful read substitutes for authority.
 */
export class PiRestoreGenerationEvidenceReader {
  constructor(
    private readonly authority: PiRestoreGenerationAuthorityPort = new UnavailablePiRestoreGenerationAuthority()
  ) {}

  async readCurrent(expected: PiRestoreGenerationExpected): Promise<PiRestoreGenerationSnapshot> {
    // Parse before awaiting, so caller mutation cannot change the expected pins in flight.
    const pins = ExpectedGenerationSchema.parse(expected)
    const result = PiRestoreGenerationSnapshotSchema.safeParse(
      await this.authority.readCurrent(pins.lineageId)
    )
    if (!result.success) throw new Error('PI_RESTORE_GENERATION_AUTHORITY_INVALID')
    const current = result.data
    if (
      current.lineageId !== pins.lineageId ||
      current.restoreGeneration !== pins.restoreGeneration ||
      current.revision !== pins.revision ||
      current.state !== 'open'
    )
      throw new Error('PI_RESTORE_GENERATION_EVIDENCE_CONFLICT')
    return current
  }
}

// --- Frozen receipt snapshot: issuer seam and reader (unwired) ---

const SnapshotReference = z.string().min(1).max(8192)
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Ids = z
  .array(z.number().int().positive().safe())
  .refine((ids) => new Set(ids).size === ids.length)

// The pins a caller holds for one historical cancellation request. They name evidence only.
export const PiFrozenReceiptIdentitySchema = z.strictObject({
  sessionId: SnapshotReference,
  requestId: SnapshotReference,
  requestDigest: Digest,
  targetDigest: Digest,
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  turnKey: SnapshotReference,
  inferenceId: SnapshotReference.nullable(),
})
export type PiFrozenReceiptIdentity = z.infer<typeof PiFrozenReceiptIdentitySchema>

const ReceiptSchema = z.strictObject({
  version: z.literal(1),
  requestId: SnapshotReference,
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
// The structural type of a parsed receipt. Declared explicitly so the emitted declaration file
// stays small; `entries.push(entry.data)` below fails to compile if the schema drifts from it.
export type PiFrozenReceipt = Readonly<{
  version: 1
  requestId: string
  requestDigest: string
  conversationId: number
  background: false
  taskIds: readonly number[]
  queuedInputIds: readonly number[]
  metadata: Readonly<{
    targetDigest: string
    expiresAt: string
    fenceRevision: number
    inferenceId: string | null
    turnKey: string
    scopeDigest: string
  }>
}>

// What an issuer must say about the snapshot it captured. It is a requirement on the issuer,
// not something a caller of the reader can supply: the reader only accepts these values from a
// handle that went through the issuer seam. They are assertions by the trusted issuer, not
// verified here and not SDK attestation.
export interface PiReceiptSnapshotProvenance {
  readonly sessionId: string
  readonly conversationId: number
  readonly restoreGeneration: string
  readonly ownerEpoch: number
  // The captured state is detached from any live store, WAL or sidecar.
  readonly detached: true
  // The capture is one coherent cut, not a file copied while a writer was active.
  readonly coherent: true
  // Reads of the snapshot are SELECT-only; the issuer opened nothing writable.
  readonly access: 'select_only'
}

export interface PiReceiptSnapshotSource {
  readonly provenance: PiReceiptSnapshotProvenance
  // The replayed `pi.guarded-abort-receipts` ledger as already read by the issuer.
  readonly ledger: unknown
}

declare const issuedBrand: unique symbol

// Opaque handle for one snapshot a trusted issuer says is detached, coherent and SELECT-only.
// It exposes no path, hash, store, statement or flag. Only {@link sealPiReceiptSnapshot} makes
// one. That function is not exported from the package index and nothing in the runtime calls it
// today, but this is encapsulation and the absence of wiring, not an enforced production
// boundary: any code that imports this module can call it. The provenance is the issuer's own
// assertion, not SDK attestation, and the brand is not cryptography. A real issuer must be
// trusted by construction.
export interface PiIssuedReceiptSnapshot {
  readonly [issuedBrand]: never
}

interface Sealed {
  readonly provenance: PiReceiptSnapshotProvenance
  readonly ledger: unknown
}
const sealed = new WeakMap<object, Sealed>()

function deepFreeze<T>(item: T): T {
  if (item !== null && typeof item === 'object') {
    for (const child of Object.values(item)) deepFreeze(child)
    Object.freeze(item)
  }
  return item
}

function detach(value: unknown): unknown {
  // canonicalJsonStringify rejects non-JSON values; parse gives a private, unshared copy.
  return deepFreeze(JSON.parse(canonicalJsonStringify(value)) as unknown)
}

// Issuer seam. A trusted issuer calls this once it holds a detached coherent cut it read with
// SELECT only, and asserts that as provenance; nothing here verifies the assertion. The ledger
// is copied and frozen here, so later mutation of the caller's value cannot change what the
// reader sees.
export function sealPiReceiptSnapshot(source: PiReceiptSnapshotSource): PiIssuedReceiptSnapshot {
  const { provenance } = source
  if (
    provenance.detached !== true ||
    provenance.coherent !== true ||
    provenance.access !== 'select_only' ||
    !SnapshotReference.safeParse(provenance.sessionId).success ||
    !SnapshotReference.safeParse(provenance.restoreGeneration).success ||
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

// Issuer port. The default refuses; no production issuer exists.
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
  // The snapshot holds a receipt matching every pin. Historical evidence, not authority.
  | { readonly outcome: 'found'; readonly receipt: PiFrozenReceipt }
  // No receipt for this request in this snapshot. Not proof the effect never happened live.
  | { readonly outcome: 'absent' }

// Looks up one historical native abort receipt in a sealed snapshot. It takes no path, hash or
// boolean, opens no store and cannot write. Anything that is not a handle sealed by the issuer
// seam, any binding mismatch and any malformed or ambiguous ledger fails closed with a coded
// error. A result describes a past committed effect and never authorizes a new one.
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
  // The parsed receipt is a fresh, mutable object; freeze it and everything under it, so a
  // caller cannot alter the evidence it was handed (a shallow freeze would leave it open).
  return Object.freeze({ outcome: 'found', receipt: deepFreeze(match) })
}
