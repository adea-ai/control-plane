import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  assertPiNativeCancellationFenceReceiptBinding,
  PiNativeCancellationFenceRequestSchema,
  PiNativeCancellationFenceReceiptSchema,
  UnavailablePiNativeCancellationBoundary,
  type PiNativeCancellationBoundaryPort,
  type PiNativeCancellationFenceRequest,
  type PiNativeCancellationFenceReceipt,
} from './native-cancellation-boundary.js'
import {
  PiRestoreGenerationSnapshotSchema,
  PiRestoreGenerationEvidenceReader,
  UnavailablePiRestoreGenerationAuthority,
  type PiRestoreGenerationAuthorityPort,
} from './restore-generation-authority.js'

const Reference = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => value.trim() === value)
const Epoch = z.number().int().nonnegative().safe()
const Generation = PiRestoreGenerationSnapshotSchema.omit({ state: true })
const Scopes = z
  .array(Reference)
  .min(1)
  .max(4096)
  .transform((values) => [...new Set(values)].toSorted())
const Owner = z.strictObject({
  ownerId: Reference,
  processClaimId: Reference,
  ownerEpoch: Epoch,
  generation: Generation,
  scopes: Scopes,
})
const Mutation = z.strictObject({ mutationId: Reference, generation: Generation, scopes: Scopes })
export type PiCancellationRegisteredOwner = z.infer<typeof Owner>
export type PiCancellationRegistrationMutation = z.infer<typeof Mutation>

type Fence = {
  owner: PiCancellationRegisteredOwner
  request: PiNativeCancellationFenceRequest
  receipt: PiNativeCancellationFenceReceipt | null
}
type StoredMutation = { input: PiCancellationRegistrationMutation; owners: Fence[] }
export type PiCancellationRegisteredSetEvidence = {
  kind: 'registered-set-fence-evidence'
  qualifiedAuthorization: false
  mutationId: string
  scopeSetDigest: string
  status: 'pending' | 'fenced'
  owners: Fence[]
}
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
}
function encoded(value: unknown): string {
  return canonicalJsonStringify(value)
}
function decoded(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('PI_CANCELLATION_REGISTRY_CORRUPT')
  return JSON.parse(value) as unknown
}

/**
 * DORMANT protocol prototype covering only explicitly registered owners/scopes.
 * Permanent closures and ACKs are evidence, never canonical R authorization,
 * global writer completeness, native abort, drain, or an atomic independent-G permit.
 * The caller owns the database. A qualified native port must deduplicate identical
 * installFence requests after lost responses and serialize F with every native N.
 */
export class PiCancellationRegistrationCoordinator {
  constructor(
    private readonly database: DatabaseSync,
    private readonly generationAuthority: PiRestoreGenerationAuthorityPort = new UnavailablePiRestoreGenerationAuthority(),
    private readonly nativeBoundary: PiNativeCancellationBoundaryPort = new UnavailablePiNativeCancellationBoundary()
  ) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS pi_cancel_proto_owners (
        owner_id TEXT PRIMARY KEY, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pi_cancel_proto_mutations (
        mutation_id TEXT PRIMARY KEY, body TEXT NOT NULL, request_digest TEXT NOT NULL,
        cut_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pi_cancel_proto_closures (
        mutation_id TEXT NOT NULL, lineage_id TEXT NOT NULL, scope TEXT NOT NULL,
        PRIMARY KEY (mutation_id, scope)
      );
      CREATE TABLE IF NOT EXISTS pi_cancel_proto_epochs (
        owner_key TEXT PRIMARY KEY, epoch INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pi_cancel_proto_fences (
        mutation_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_key TEXT NOT NULL,
        fence_epoch INTEGER NOT NULL, owner_body TEXT NOT NULL,
        request_body TEXT NOT NULL, receipt_body TEXT,
        PRIMARY KEY (mutation_id, owner_id), UNIQUE (owner_key, fence_epoch)
      );
    `)
  }

  async register(input: PiCancellationRegisteredOwner): Promise<void> {
    const owner = Owner.parse(input)
    await this.openGeneration(owner.generation)
    this.transaction(() => {
      const previous = this.owner(owner.ownerId)
      // Check both sets, so rebinding cannot remove an already closed membership.
      this.assertScopesOpen(owner.generation.lineageId, owner.scopes)
      if (previous) {
        this.assertScopesOpen(previous.generation.lineageId, previous.scopes)
        if (
          digest({ ...previous, scopes: [] }) !== digest({ ...owner, scopes: [] }) &&
          owner.ownerEpoch <= previous.ownerEpoch
        )
          throw new Error('PI_CANCELLATION_OWNER_CONFLICT')
      }
      for (const row of this.database.prepare('SELECT body FROM pi_cancel_proto_owners').all()) {
        const registered = Owner.parse(decoded(row['body']))
        if (
          registered.ownerId !== owner.ownerId &&
          this.ownerKey(registered) === this.ownerKey(owner)
        )
          throw new Error('PI_CANCELLATION_NATIVE_OWNER_ALIAS')
      }
      this.database
        .prepare(`INSERT INTO pi_cancel_proto_owners (owner_id, body) VALUES (?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET body = excluded.body`)
        .run(owner.ownerId, encoded(owner))
    })
  }

  async unregister(input: PiCancellationRegisteredOwner): Promise<void> {
    const owner = Owner.parse(input)
    await this.openGeneration(owner.generation)
    this.transaction(() => {
      const previous = this.owner(owner.ownerId)
      if (!previous || digest(previous) !== digest(owner))
        throw new Error('PI_CANCELLATION_OWNER_CONFLICT')
      this.assertScopesOpen(previous.generation.lineageId, previous.scopes)
      this.database
        .prepare('DELETE FROM pi_cancel_proto_owners WHERE owner_id = ?')
        .run(owner.ownerId)
    })
  }

  async beginMutation(
    input: PiCancellationRegistrationMutation
  ): Promise<PiCancellationRegisteredSetEvidence> {
    const mutation = Mutation.parse(input)
    await this.openGeneration(mutation.generation)
    this.transaction(() => {
      const previous = this.database
        .prepare('SELECT request_digest FROM pi_cancel_proto_mutations WHERE mutation_id = ?')
        .get(mutation.mutationId)
      if (previous) {
        if (previous['request_digest'] !== digest(mutation))
          throw new Error('PI_CANCELLATION_MUTATION_CONFLICT')
        this.load(mutation.mutationId)
        return
      }
      // BEGIN IMMEDIATE serializes registration and closure across connections.
      // Insert ALL closures before selecting the registered cut; never reopen them.
      for (const scope of mutation.scopes)
        this.database
          .prepare(
            'INSERT INTO pi_cancel_proto_closures (mutation_id, lineage_id, scope) VALUES (?, ?, ?)'
          )
          .run(mutation.mutationId, mutation.generation.lineageId, scope)
      const owners = this.database
        .prepare('SELECT body FROM pi_cancel_proto_owners ORDER BY owner_id')
        .all()
        .map((row) => Owner.parse(decoded(row['body'])))
        .filter(
          (owner) =>
            owner.generation.lineageId === mutation.generation.lineageId &&
            owner.scopes.some((scope) => mutation.scopes.includes(scope))
        )
      const fences: Fence[] = owners.map((owner) => {
        if (digest(owner.generation) !== digest(mutation.generation))
          throw new Error('PI_RESTORE_GENERATION_EVIDENCE_CONFLICT')
        const ownerKey = this.ownerKey(owner)
        const row = this.database
          .prepare('SELECT epoch FROM pi_cancel_proto_epochs WHERE owner_key = ?')
          .get(ownerKey)
        const previousEpoch = row ? Epoch.parse(row['epoch']) : 0
        const fenceEpoch = Epoch.parse(previousEpoch + 1)
        const request = PiNativeCancellationFenceRequestSchema.parse({
          mutationId: mutation.mutationId,
          scopeSetDigest: digest(mutation.scopes),
          closureGeneration: digest({ mutation, owners }),
          processClaimId: owner.processClaimId,
          restoreGeneration: owner.generation.restoreGeneration,
          ownerEpoch: owner.ownerEpoch,
          previousEpoch,
          fenceEpoch,
        })
        this.database
          .prepare(`INSERT INTO pi_cancel_proto_epochs (owner_key, epoch) VALUES (?, ?)
          ON CONFLICT(owner_key) DO UPDATE SET epoch = excluded.epoch`)
          .run(ownerKey, fenceEpoch)
        return { owner, request, receipt: null }
      })
      this.database
        .prepare(
          'INSERT INTO pi_cancel_proto_mutations (mutation_id, body, request_digest, cut_digest) VALUES (?, ?, ?, ?)'
        )
        .run(
          mutation.mutationId,
          encoded(mutation),
          digest(mutation),
          digest(fences.map(({ owner, request }) => ({ owner, request })))
        )
      for (const { owner, request } of fences)
        this.database
          .prepare(`INSERT INTO pi_cancel_proto_fences
          (mutation_id, owner_id, owner_key, fence_epoch, owner_body, request_body)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(
            mutation.mutationId,
            owner.ownerId,
            this.ownerKey(owner),
            request.fenceEpoch,
            encoded(owner),
            encoded(request)
          )
    })
    return this.readEvidence(mutation.mutationId)
  }

  async installFences(mutationId: string): Promise<PiCancellationRegisteredSetEvidence> {
    const id = Reference.parse(mutationId)
    const initial = this.load(id)
    // Closing G still permits a restrictive F, but never open-generation evidence.
    await this.sameGeneration(initial.input.generation)
    for (const fence of initial.owners) {
      if (fence.receipt) continue
      this.transaction(() => this.assertPredecessorAcknowledged(fence))
      // No SQLite transaction held across native work. Lost response retains this
      // immutable exact request; a later retry must not allocate another epoch.
      const receipt = PiNativeCancellationFenceReceiptSchema.parse(
        await this.nativeBoundary.installFence(
          PiNativeCancellationFenceRequestSchema.parse(fence.request)
        )
      )
      assertPiNativeCancellationFenceReceiptBinding(fence.request, receipt)
      await this.sameGeneration(initial.input.generation)
      this.transaction(() => {
        const current = this.load(id).owners.find(
          ({ owner }) => owner.ownerId === fence.owner.ownerId
        )
        if (!current || digest(current.request) !== digest(fence.request))
          throw new Error('PI_CANCELLATION_REGISTRY_CORRUPT')
        this.assertPredecessorAcknowledged(current)
        // Concurrent duplicate ACK cannot replace a previously persisted receipt.
        if (!current.receipt)
          this.database
            .prepare(`UPDATE pi_cancel_proto_fences SET receipt_body = ?
            WHERE mutation_id = ? AND owner_id = ? AND receipt_body IS NULL`)
            .run(encoded(receipt), id, fence.owner.ownerId)
      })
    }
    return this.readEvidence(id)
  }

  async readEvidence(mutationId: string): Promise<PiCancellationRegisteredSetEvidence> {
    const id = Reference.parse(mutationId)
    const before = this.load(id)
    await this.openGeneration(before.input.generation)
    const current = this.load(id)
    const immutableCut = (value: StoredMutation): string =>
      digest({
        input: value.input,
        owners: value.owners.map(({ owner, request }) => ({ owner, request })),
      })
    if (immutableCut(before) !== immutableCut(current))
      throw new Error('PI_CANCELLATION_REGISTRY_CONFLICT')
    return {
      kind: 'registered-set-fence-evidence',
      qualifiedAuthorization: false,
      mutationId: id,
      scopeSetDigest: digest(current.input.scopes),
      status: current.owners.every(({ receipt }) => receipt !== null) ? 'fenced' : 'pending',
      owners: current.owners,
    }
  }

  private ownerKey(owner: PiCancellationRegisteredOwner): string {
    // Native requests have no registry ownerId or lineageId. Use the identity
    // the native port actually sees; aliases must never allocate separate queues.
    return digest({
      processClaimId: owner.processClaimId,
      restoreGeneration: owner.generation.restoreGeneration,
      ownerEpoch: owner.ownerEpoch,
    })
  }
  private owner(ownerId: string): PiCancellationRegisteredOwner | undefined {
    const row = this.database
      .prepare('SELECT body FROM pi_cancel_proto_owners WHERE owner_id = ?')
      .get(ownerId)
    return row ? Owner.parse(decoded(row['body'])) : undefined
  }
  private assertScopesOpen(lineageId: string, scopes: string[]): void {
    for (const scope of scopes)
      if (
        this.database
          .prepare(
            'SELECT 1 FROM pi_cancel_proto_closures WHERE lineage_id = ? AND scope = ? LIMIT 1'
          )
          .get(lineageId, scope)
      )
        throw new Error('PI_CANCELLATION_SCOPE_CLOSED')
  }
  private assertPredecessorAcknowledged(fence: Fence): void {
    if (
      this.database
        .prepare(`SELECT 1 FROM pi_cancel_proto_fences
      WHERE owner_key = ? AND fence_epoch < ? AND receipt_body IS NULL LIMIT 1`)
        .get(this.ownerKey(fence.owner), fence.request.fenceEpoch)
    )
      throw new Error('PI_CANCELLATION_FENCE_PREDECESSOR_PENDING')
  }
  private load(mutationId: string): StoredMutation {
    const row = this.database
      .prepare('SELECT * FROM pi_cancel_proto_mutations WHERE mutation_id = ?')
      .get(mutationId)
    if (!row) throw new Error('PI_CANCELLATION_MUTATION_NOT_FOUND')
    const input = Mutation.parse(decoded(row['body']))
    const owners = this.database
      .prepare('SELECT * FROM pi_cancel_proto_fences WHERE mutation_id = ? ORDER BY owner_id')
      .all(mutationId)
      .map((entry): Fence => {
        const owner = Owner.parse(decoded(entry['owner_body']))
        const request = PiNativeCancellationFenceRequestSchema.parse(decoded(entry['request_body']))
        const receipt =
          entry['receipt_body'] === null
            ? null
            : PiNativeCancellationFenceReceiptSchema.parse(decoded(entry['receipt_body']))
        if (receipt) assertPiNativeCancellationFenceReceiptBinding(request, receipt)
        if (
          owner.ownerId !== entry['owner_id'] ||
          this.ownerKey(owner) !== entry['owner_key'] ||
          request.fenceEpoch !== entry['fence_epoch']
        )
          throw new Error('PI_CANCELLATION_REGISTRY_CORRUPT')
        return { owner, request, receipt }
      })
    if (
      input.mutationId !== mutationId ||
      digest(input) !== row['request_digest'] ||
      digest(owners.map(({ owner, request }) => ({ owner, request }))) !== row['cut_digest']
    )
      throw new Error('PI_CANCELLATION_REGISTRY_CORRUPT')
    const closures = this.database
      .prepare(
        'SELECT lineage_id, scope FROM pi_cancel_proto_closures WHERE mutation_id = ? ORDER BY scope'
      )
      .all(mutationId)
    const closureScopes = Scopes.safeParse(closures.map((closure) => closure['scope']))
    if (
      !closureScopes.success ||
      closures.some((closure) => closure['lineage_id'] !== input.generation.lineageId) ||
      digest(closureScopes.data) !== digest(input.scopes)
    )
      throw new Error('PI_CANCELLATION_REGISTRY_CORRUPT')
    const closureGeneration = digest({ mutation: input, owners: owners.map(({ owner }) => owner) })
    for (const { owner, request } of owners)
      if (
        request.mutationId !== mutationId ||
        request.scopeSetDigest !== digest(input.scopes) ||
        request.closureGeneration !== closureGeneration ||
        request.processClaimId !== owner.processClaimId ||
        request.ownerEpoch !== owner.ownerEpoch ||
        request.restoreGeneration !== owner.generation.restoreGeneration ||
        digest(owner.generation) !== digest(input.generation) ||
        !owner.scopes.some((scope) => input.scopes.includes(scope))
      )
        throw new Error('PI_CANCELLATION_REGISTRY_CORRUPT')
    return { input, owners }
  }
  private async openGeneration(expected: z.infer<typeof Generation>): Promise<void> {
    await new PiRestoreGenerationEvidenceReader(this.generationAuthority).readCurrent(expected)
  }
  private async sameGeneration(expected: z.infer<typeof Generation>): Promise<void> {
    const result = PiRestoreGenerationSnapshotSchema.safeParse(
      await this.generationAuthority.readCurrent(expected.lineageId)
    )
    if (!result.success) throw new Error('PI_RESTORE_GENERATION_AUTHORITY_INVALID')
    const { state: _state, ...pins } = result.data
    if (digest(pins) !== digest(expected))
      throw new Error('PI_RESTORE_GENERATION_EVIDENCE_CONFLICT')
  }
  private transaction<T>(body: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const value = body()
      this.database.exec('COMMIT')
      return value
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

// --- C4 closure receipt (candidate, unwired) ---
// Lives here only to fit the dist budget; this module is not re-exported from the package entry point.
// Receipt shape. Pure evidence: a parser cannot show that anything closed. It is what
// a candidate `closeWriters` would commit after sealing admission, settling in-flight commits and
// bumping the store fence epoch. Nothing here closes, checkpoints, acquires or authorizes.
const Instant = z.iso.datetime({ precision: 3 })
export const PiWriterClosureReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal('pi-writer-closure-receipt/v1'),
    mutationId: Reference,
    ownerKey: Reference,
    lineageId: Reference,
    generation: Reference,
    previousEpoch: Epoch,
    epoch: Epoch,
    lastSeq: Epoch,
    settledInFlight: z.literal(true),
    closedAt: Instant,
  })
  .superRefine((receipt, context) => {
    if (receipt.epoch !== receipt.previousEpoch + 1)
      context.addIssue({ code: 'custom', path: ['epoch'], message: 'epoch must advance by one' })
  })
export type PiWriterClosureReceipt = z.infer<typeof PiWriterClosureReceiptSchema>

// What the caller independently holds. A receipt is checked against it, never trusted alone.
export interface PiWriterClosureExpectation {
  readonly mutationId: string
  readonly lineageId: string
  readonly generation: string
  readonly previousEpoch: number
  // Highest commit sequence the caller already observed; a closure cannot precede it.
  readonly observedSeq: number
}

export type PiWriterClosureEvidence = {
  readonly kind: 'writer-closure-evidence'
  readonly qualifiedAuthorization: false
  readonly receipt: PiWriterClosureReceipt
}

// The expectation is checked as strictly as the receipt: a NaN or missing floor would make every
// `lastSeq < observedSeq` comparison false and accept evidence below the floor the caller holds.
const ExpectationSchema = z.strictObject({
  mutationId: Reference,
  lineageId: Reference,
  generation: Reference,
  previousEpoch: Epoch,
  observedSeq: Epoch,
})

// Fails closed with a stable code. The result is evidence only, never permission.
export function assertPiWriterClosureReceipt(
  receiptInput: unknown,
  expectedInput: PiWriterClosureExpectation
): PiWriterClosureEvidence {
  const checked = ExpectationSchema.safeParse(expectedInput)
  if (!checked.success) throw new Error('PI_WRITER_CLOSURE_EXPECTATION_INVALID')
  const expected = checked.data
  const parsed = PiWriterClosureReceiptSchema.safeParse(receiptInput)
  if (!parsed.success) throw new Error('PI_WRITER_CLOSURE_RECEIPT_INVALID')
  const receipt = parsed.data
  if (receipt.mutationId !== expected.mutationId) throw new Error('PI_WRITER_CLOSURE_MUTATION')
  if (receipt.lineageId !== expected.lineageId) throw new Error('PI_WRITER_CLOSURE_LINEAGE')
  if (receipt.generation !== expected.generation) throw new Error('PI_WRITER_CLOSURE_GENERATION')
  if (receipt.previousEpoch !== expected.previousEpoch) throw new Error('PI_WRITER_CLOSURE_EPOCH')
  if (receipt.lastSeq < expected.observedSeq) throw new Error('PI_WRITER_CLOSURE_SEQUENCE')
  return Object.freeze({
    kind: 'writer-closure-evidence',
    qualifiedAuthorization: false,
    receipt: Object.freeze(receipt),
  })
}
