// Read-only snapshot capture for migration rehearsal (M18.01, #1181).
//
// Capture is the WRITE side of nothing: it reads real product records and
// produces the frozen snapshot documents the comparator in
// `migration-snapshot-comparator.ts` consumes. It never backfills, deletes,
// cuts over or rolls anything back — every read below runs inside ONE
// REPEATABLE READ, READ ONLY transaction, so the database structurally
// refuses the capture a write and every family is observed at a single
// database snapshot (families and pages can never mix states).
//
// Design, mirroring the comparator's epistemics:
//
// - CONSISTENT SNAPSHOT: `captureMigrationSnapshot` opens one transaction
//   with `MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG`; the whole document
//   is read inside it. `captureMigrationSnapshotInTransaction` runs the same
//   read inside a caller-owned transaction that already holds the snapshot.
// - PAGINATION + EXPLICIT COMPLETENESS: every family read is offset-paginated
//   (the repo's search-paging convention) with a one-row probe per page, so
//   exhaustion is proven, not assumed. A scan that stops at the family bound
//   before exhausting the domain records `truncated: true` plus the applied
//   `limit` on the section; an exhausted scan records `truncated: false`.
//   Missing truncation evidence can never imply completeness — `truncated`
//   is always present, exactly what the comparator requires.
// - UNSUPPORTED DOMAINS STAY UNKNOWN: capture only inventories its supported
//   families. A requested domain outside the support set returns a domain
//   status of `unknown` with a typed reason and simply leaves the section
//   absent from the document — the comparator reads an absent section as
//   `unknown_domain`, never as an empty success.
// - DETERMINISM: output carries only the comparator's allow-listed record
//   fields; records are ordered by the comparator's stable identity (a plain
//   code-unit sort, independent of database collation and page size);
//   sections are emitted in contract-family order; the invitation lifecycle
//   state is derived from an injectable `capturedAt` instead of the wall
//   clock. The same database state with the same identity inputs yields
//   byte-identical documents. No credentials, DSNs, message bodies, emails,
//   token digests or timestamps travel — the record contract excludes them
//   and capture never selects them.
//
// Scope honesty: capture feeds comparison; neither is migration acceptance.
// The database handle (or DSN-derived connection) is always an explicit
// argument — nothing here reads `DATABASE_URL` or defaults to any
// environment. Rows whose values exceed the snapshot contract's documented
// bounds are carried verbatim and will be quarantined by the comparator as
// typed `limit` issues; capture never drops or repairs a row silently.

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { asc } from 'drizzle-orm'
import { sql } from 'drizzle-orm'

import type {
  MigrationSnapshotDocument,
  MigrationSnapshotFamily,
  MigrationSnapshotIdentity,
  MigrationSnapshotRecord,
  MigrationSnapshotRecordFor,
  MigrationSnapshotSection,
  MigrationSnapshotSections,
} from '@adea-ai/types'
import {
  isMigrationSnapshotFamily,
  migrationSnapshotFamilies,
  MIGRATION_SNAPSHOT_FORMAT_VERSION,
  MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION,
} from '@adea-ai/types'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  captureNativeSessionSection,
  type NativeSessionInventorySource,
} from './native-session-inventory'
import {
  agents,
  artifactReferenceGrants,
  authIdentities,
  channelParticipants,
  channels,
  channelReadStates,
  contentRefs,
  contentReplicas,
  leadTurnRuntime,
  messages,
  projectMembers,
  projects,
  runtimeNodes,
  taskExecutionAttempts,
  taskSubmissions,
  tasks,
  temporaryUserSessions,
  threadReadStates,
  workspaceEvents,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
} from './schema'

/**
 * The transaction configuration every whole-document capture runs under: one
 * REPEATABLE READ transaction, declared READ ONLY so the database rejects any
 * write the capture could ever attempt. Reused verbatim by tests that prove
 * the settings, and by callers that open the capture transaction themselves.
 */
export const MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG = Object.freeze({
  accessMode: 'read only',
  isolationLevel: 'repeatable read',
} as const)

/**
 * Families this capture can inventory, in contract order. Today every family
 * the snapshot contract knows is supported; the set exists so a future
 * contract family has a place to be declared unsupported — requested then, it
 * would stay unknown with reason `unsupported_family` instead of silently
 * reading as an empty capture.
 */
export const MIGRATION_SNAPSHOT_CAPTURE_SUPPORTED_FAMILIES: readonly MigrationSnapshotFamily[] =
  migrationSnapshotFamilies

/**
 * Domains a migration must account for that this capture cannot inventory from
 * the database alone: the canonical runtime owns native sessions and serves
 * them through `dev.session.list` (capability `dev.session.read`). Requesting
 * one without an injected `nativeSessionInventory` source stays unknown with
 * reason `unsupported_family` instead of reading as an empty capture.
 */
export const MIGRATION_SNAPSHOT_UNSUPPORTED_DOMAINS = ['nativeSessions'] as const

/**
 * Rows fetched per family page. Each page asks for one extra row (the probe)
 * so exhaustion is observed directly; the probe row is never captured.
 */
export const MIGRATION_SNAPSHOT_CAPTURE_PAGE_SIZE = 500

/** Why a requested domain was not captured. */
export const migrationSnapshotCaptureUnknownReasons = [
  'unrecognized_domain',
  'unsupported_family',
  'inventory_error',
] as const

export type MigrationSnapshotCaptureUnknownReason =
  (typeof migrationSnapshotCaptureUnknownReasons)[number]

/**
 * The capture outcome for one requested domain. `captured` domains have a
 * section in the document (possibly an empty one — a proven fact). `unknown`
 * domains have no section at all: the comparator will report that domain as
 * `unknown_domain`, never as zero.
 */
export type MigrationSnapshotDomainCaptureStatus = Readonly<{
  domain: string
  status: 'captured' | 'unknown'
  unknownReason: MigrationSnapshotCaptureUnknownReason | null
}>

/** Injectable capture identity and clock. Nothing here is derived at runtime. */
export type MigrationSnapshotCaptureIdentityInput = Readonly<{
  /** Derives time-observed record facts (invitation expiry). Never emitted. */
  capturedAt: Date
  rehearsalId: string
  snapshotId: string
  source: string
}>

export type MigrationSnapshotCaptureInput = Readonly<{
  identity: MigrationSnapshotCaptureIdentityInput
  /**
   * Per-family scan bound. A family that reaches the bound before exhausting
   * the domain is flagged `truncated` with this limit recorded. Must be a
   * safe integer in `[1, MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION]`;
   * defaults to the contract maximum.
   */
  limitPerFamily?: number
  /**
   * Domains to capture, by snapshot-family name. Omit to capture every
   * supported family. A name outside the support set yields an `unknown`
   * domain status with a typed reason — never an empty success.
   */
  requestedDomains?: readonly string[]
  /**
   * Authoritative runtime session inventory source (the canonical
   * `dev.session.list` read). When absent, a requested `nativeSessions` domain
   * stays unknown with `unsupported_family`; when present, the composed read is
   * captured and a denied, unavailable or invalid read stays unknown with
   * `inventory_error` — never an empty section.
   */
  nativeSessionInventory?: NativeSessionInventorySource
}>

export type MigrationSnapshotCaptureResult = Readonly<{
  document: MigrationSnapshotDocument
  domains: readonly MigrationSnapshotDomainCaptureStatus[]
}>

/**
 * Capture input violates its contract: blank identity fields, an invalid
 * clock, an out-of-range bound, or a non-string domain name. Thrown before
 * any database work starts.
 */
export class MigrationSnapshotCaptureInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationSnapshotCaptureInputError'
  }
}

// ─── Input validation and domain resolution ──────────────────────────────────

function requireCaptureIdentity(
  identity: MigrationSnapshotCaptureIdentityInput
): MigrationSnapshotIdentity {
  if (typeof identity !== 'object' || identity === null) {
    throw new MigrationSnapshotCaptureInputError('Capture identity must be an object')
  }
  const { capturedAt, rehearsalId, snapshotId, source } = identity
  if (typeof rehearsalId !== 'string' || rehearsalId.length === 0) {
    throw new MigrationSnapshotCaptureInputError('Capture identity rehearsalId must be non-empty')
  }
  if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
    throw new MigrationSnapshotCaptureInputError('Capture identity snapshotId must be non-empty')
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new MigrationSnapshotCaptureInputError('Capture identity source must be non-empty')
  }
  if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) {
    throw new MigrationSnapshotCaptureInputError('Capture identity capturedAt must be a valid Date')
  }
  return Object.freeze({
    formatVersion: MIGRATION_SNAPSHOT_FORMAT_VERSION,
    rehearsalId,
    snapshotId,
    source,
  })
}

function requireCaptureBound(value: number | undefined): number {
  const bound = value ?? MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION
  if (
    !Number.isSafeInteger(bound) ||
    bound < 1 ||
    bound > MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION
  ) {
    throw new MigrationSnapshotCaptureInputError(
      `limitPerFamily must be a safe integer between 1 and ${MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION}`
    )
  }
  return bound
}

/**
 * Resolve the requested domains into deterministic capture statuses, sorted by
 * domain name. Without an explicit request every supported family is
 * captured; names outside the support set stay unknown with a typed reason.
 * Duplicate names collapse to one status.
 */
export function resolveMigrationSnapshotCaptureDomains(
  requestedDomains: readonly string[] | undefined,
  options?: Readonly<{ nativeSessionInventory?: NativeSessionInventorySource }>
): readonly MigrationSnapshotDomainCaptureStatus[] {
  const supported = new Set<string>(MIGRATION_SNAPSHOT_CAPTURE_SUPPORTED_FAMILIES)
  const unsupported = new Set<string>(MIGRATION_SNAPSHOT_UNSUPPORTED_DOMAINS)
  const hasNativeSessionInventory = options?.nativeSessionInventory !== undefined
  const names = requestedDomains ?? [...supported]
  const resolved = new Map<string, MigrationSnapshotDomainCaptureStatus>()
  for (const domain of names) {
    if (typeof domain !== 'string' || domain.length === 0) {
      throw new MigrationSnapshotCaptureInputError(
        'requestedDomains entries must be non-empty strings'
      )
    }
    if (resolved.has(domain)) continue
    if (supported.has(domain)) {
      if (domain === 'nativeSessions' && !hasNativeSessionInventory) {
        resolved.set(domain, { domain, status: 'unknown', unknownReason: 'unsupported_family' })
        continue
      }
      resolved.set(domain, { domain, status: 'captured', unknownReason: null })
      continue
    }
    resolved.set(domain, {
      domain,
      status: 'unknown',
      unknownReason:
        unsupported.has(domain) || isMigrationSnapshotFamily(domain)
          ? 'unsupported_family'
          : 'unrecognized_domain',
    })
  }
  return [...resolved.values()].toSorted((left, right) =>
    left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0
  )
}

// ─── Deterministic encodings ─────────────────────────────────────────────────

/**
 * How deep the canonical walk descends before folding the rest of the subtree
 * into a bounded digest marker. Exported so the tests can pin the exact
 * boundary the fold guarantees.
 */
export const PAYLOAD_CANONICAL_MAX_DEPTH = 64

/**
 * TOTAL emitted-bytes budget for one payload's whole canonical encoding:
 * shallow values, wide containers and every folded deep branch draw from this
 * one budget, so no combination of branches can buy more than a constant
 * amount of hashing, buffering or traversal. Exceeding it refuses the digest.
 */
export const PAYLOAD_CANONICAL_MAX_BYTES = 1_048_576

/**
 * TOTAL work budget for one payload's canonical encoding: the maximum number
 * of containers the walk may open across the whole payload — shallow, wide
 * and folded alike. Bounds the traversal independently of the byte budget, so
 * even a payload that emits almost nothing cannot make the walk grow without
 * end. Exceeding it refuses the digest.
 */
export const PAYLOAD_CANONICAL_MAX_WORK = 262_144

/** Shared, decreasing budgets for one digest operation. */
type CanonicalBudget = { bytesLeft: number; workLeft: number }

/** Why a deep fold produced no digest. */
export type MigrationSnapshotPayloadDigestInconclusiveReason = 'payload_too_large_to_digest'

/**
 * The record-field value capture emits when no payload digest exists: a
 * fixed, clearly-marked non-digest. It is deliberately NOT derived from the
 * payload — nothing has been proven about content the fold refused to read —
 * and it fails the contract's digest check, so the comparator quarantines
 * the record (`quarantined_record`, field `payloadDigest`) before any
 * comparison could mistake it for a digest.
 */
export const MIGRATION_SNAPSHOT_PAYLOAD_DIGEST_INCONCLUSIVE_MARKER =
  '~inconclusive:payload_too_large_to_digest'

/**
 * Non-string scalar half of the canonical encoding, emitted verbatim by the
 * streaming walk so its bytes can never drift from the documented markers.
 */
function canonicalScalar(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : `"~${String(value)}"`
    case 'boolean':
      return value ? 'true' : 'false'
    default:
      return `"~${typeof value}"`
  }
}

/** One container open along the canonical walk, with its cursor. */
type CanonicalFrame =
  | { depth: number; index: number; kind: 'array'; source: readonly unknown[] }
  | {
      depth: number
      index: number
      kind: 'object'
      keys: readonly string[]
      source: Record<string, unknown>
    }

/**
 * Stream `JSON.stringify(value)`'s bytes into the sink without ever
 * materializing the escaped whole: code units are escaped one at a time into
 * a small chunk buffer flushed through `emit`, so a leaf string or object key
 * of any length costs O(chunk) memory and O(min(bytes, budget)) work.
 * Byte-for-byte identical to JSON.stringify — control characters and lone
 * surrogates escape, every valid non-surrogate code unit (the printable-ASCII
 * range, U+0080–U+D7FF and U+E000–U+FFFF alike) is emitted raw — and the
 * test suite pins that equivalence across all of those classes, shallow and
 * deep.
 */
function emitQuotedJsonString(emit: (text: string) => boolean, value: string): boolean {
  if (!emit('"')) return false
  let chunk = ''
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    let piece: string
    if (unit === 0x22) {
      piece = '\\"'
    } else if (unit === 0x5c) {
      piece = '\\\\'
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
        piece = value.slice(index - 1, index + 1)
      } else {
        piece = `\\u${unit.toString(16).padStart(4, '0')}`
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      piece = `\\u${unit.toString(16).padStart(4, '0')}`
    } else if (unit >= 0x20) {
      // Every remaining valid code unit — the printable-ASCII range,
      // U+0080–U+D7FF and U+E000–U+FFFF alike — is emitted raw, exactly as
      // JSON.stringify does. Escaping any of them (e.g. reading U+E000 as
      // its \uXXXX spelling) would diverge from the canonical encoding.
      piece = value[index]
    } else {
      switch (unit) {
        case 0x08:
          piece = '\\b'
          break
        case 0x09:
          piece = '\\t'
          break
        case 0x0a:
          piece = '\\n'
          break
        case 0x0c:
          piece = '\\f'
          break
        case 0x0d:
          piece = '\\r'
          break
        default:
          piece = `\\u${unit.toString(16).padStart(4, '0')}`
          break
      }
    }
    chunk += piece
    if (chunk.length >= 4096) {
      if (!emit(chunk)) return false
      chunk = ''
    }
  }
  return (chunk.length === 0 || emit(chunk)) && emit('"')
}

/**
 * Canonical encoding of a subtree, streamed STRAIGHT INTO a sink — nothing
 * like the full encoded subtree is ever materialized. Containers are walked
 * with an explicit cursor stack, so depth lives on the heap and width never
 * enlarges the stack; strings and object keys are escaped chunk-by-chunk on
 * their way out. The emitted bytes are exactly what a plain recursive walk
 * would produce (keys sorted, arrays positional, the same scalar markers).
 * Values deeper than `PAYLOAD_CANONICAL_MAX_DEPTH` (when `allowFolds`) fold
 * into a bounded `"~deep:len:hex"` marker whose hex is the SHA-256 of the
 * subtree's own streamed canonical form. EVERY byte emitted and EVERY
 * container opened — shallow or folded, whatever the branch — charges the
 * one shared payload budget; tripping either bound stops the walk
 * immediately with `false`, and the caller refuses the digest.
 */
function walkCanonical(
  root: unknown,
  startDepth: number,
  allowFolds: boolean,
  budget: CanonicalBudget,
  emit: (text: string) => boolean
): boolean {
  const frames: CanonicalFrame[] = []
  let current: unknown = root
  let depth = startDepth
  let foldNext = false
  for (;;) {
    if (foldNext) {
      if (!emitFoldMarker(current, budget, emit)) return false
    } else if (Array.isArray(current)) {
      budget.workLeft -= 1
      if (budget.workLeft < 0 || !emit('[')) return false
      frames.push({ depth, index: 0, kind: 'array', source: current })
    } else if (current !== null && typeof current === 'object') {
      budget.workLeft -= 1
      if (budget.workLeft < 0 || !emit('{')) return false
      const source = current as Record<string, unknown>
      frames.push({ depth, index: 0, keys: Object.keys(source).toSorted(), kind: 'object', source })
    } else if (typeof current === 'string') {
      if (!emitQuotedJsonString(emit, current)) return false
    } else if (!emit(canonicalScalar(current))) {
      return false
    }
    // Advance: finish every exhausted container (emitting its closer), then
    // step the deepest open one to its next element — or finish the walk.
    for (;;) {
      const frame = frames.at(-1)
      if (frame === undefined) return true
      if (frame.kind === 'array') {
        if (frame.index >= frame.source.length) {
          frames.pop()
          if (!emit(']')) return false
          continue
        }
        if (frame.index > 0 && !emit(',')) return false
        current = frame.source[frame.index]
        depth = frame.depth + 1
        foldNext = allowFolds && depth > PAYLOAD_CANONICAL_MAX_DEPTH
        frame.index += 1
        break
      }
      if (frame.index >= frame.keys.length) {
        frames.pop()
        if (!emit('}')) return false
        continue
      }
      if (frame.index > 0 && !emit(',')) return false
      const key = frame.keys[frame.index]
      if (!emitQuotedJsonString(emit, key) || !emit(':')) return false
      current = frame.source[key]
      depth = frame.depth + 1
      foldNext = allowFolds && depth > PAYLOAD_CANONICAL_MAX_DEPTH
      frame.index += 1
      break
    }
  }
}

/**
 * Fold a subtree that starts deeper than the depth cap: its canonical form is
 * streamed into a SHA-256 of its own — charging the SAME shared budget, so
 * two deep branches cannot double-spend it — and the parent receives only the
 * bounded `"~deep:len:hex"` marker. The hex is the digest of the subtree's
 * exact canonical bytes, so two payloads identical above the cap but
 * different below it can never share a marker. Returns false when the
 * subtree trips the shared budget.
 */
function emitFoldMarker(
  value: unknown,
  budget: CanonicalBudget,
  emit: (text: string) => boolean
): boolean {
  const fold = createHash('sha256')
  let foldBytes = 0
  const ok = walkCanonical(value, PAYLOAD_CANONICAL_MAX_DEPTH + 1, false, budget, (text) => {
    const emitted = Buffer.byteLength(text, 'utf8')
    if (emitted > budget.bytesLeft) return false
    budget.bytesLeft -= emitted
    foldBytes += emitted
    fold.update(text, 'utf8')
    return true
  })
  if (!ok) return false
  return emit(`"~deep:${foldBytes}:${fold.digest('hex')}"`)
}

/**
 * The digest outcome for one durable event payload.
 *
 * - `ok: true`: `digest` is the SHA-256 of the payload's canonical encoding —
 *   64 lowercase hex, deterministic for the payload.
 * - `ok: false`: the payload tripped a documented encoding bound — the total
 *   emitted-byte budget or the total container-work budget, shared across
 *   shallow values, wide containers and every folded deep branch (see
 *   `PAYLOAD_CANONICAL_MAX_BYTES` and `PAYLOAD_CANONICAL_MAX_WORK`). Nothing
 *   about the content is claimed or hashed; `marker` is the fixed,
 *   clearly-marked non-digest the record carries instead, and the comparator
 *   quarantines it before comparing.
 */
export type MigrationSnapshotEventPayloadDigestResult = Readonly<
  | { digest: string; ok: true }
  | {
      marker: typeof MIGRATION_SNAPSHOT_PAYLOAD_DIGEST_INCONCLUSIVE_MARKER
      ok: false
      reason: MigrationSnapshotPayloadDigestInconclusiveReason
    }
>

/**
 * Caller-computed payload digest for one durable event: SHA-256 over the
 * canonical encoding of the event payload, streamed under one total
 * byte/work budget. The payload itself never travels — this digest is what
 * drift detection compares. A payload over the budget gets a typed
 * inconclusive result instead of a digest; callers must never synthesize one
 * for it.
 */
export function migrationSnapshotEventPayloadDigest(
  payload: unknown
): MigrationSnapshotEventPayloadDigestResult {
  const hash = createHash('sha256')
  const budget: CanonicalBudget = {
    bytesLeft: PAYLOAD_CANONICAL_MAX_BYTES,
    workLeft: PAYLOAD_CANONICAL_MAX_WORK,
  }
  const encoded = walkCanonical(payload, 0, true, budget, (text) => {
    const emitted = Buffer.byteLength(text, 'utf8')
    if (emitted > budget.bytesLeft) return false
    budget.bytesLeft -= emitted
    hash.update(text, 'utf8')
    return true
  })
  if (!encoded) {
    return {
      marker: MIGRATION_SNAPSHOT_PAYLOAD_DIGEST_INCONCLUSIVE_MARKER,
      ok: false,
      reason: 'payload_too_large_to_digest',
    }
  }
  return { digest: hash.digest('hex'), ok: true }
}

/**
 * The `payloadDigest` field value for one event record: the digest when one
 * exists, otherwise `MIGRATION_SNAPSHOT_PAYLOAD_DIGEST_INCONCLUSIVE_MARKER`.
 * The marker fails the contract's digest check, so the comparator
 * quarantines the record as `quarantined_record` (field `payloadDigest`)
 * instead of ever comparing an unknown as if it were a digest.
 */
export function migrationSnapshotEventPayloadDigestField(payload: unknown): string {
  const result = migrationSnapshotEventPayloadDigest(payload)
  return result.ok ? result.digest : result.marker
}

// ─── Stable record identity (order only) ─────────────────────────────────────

/**
 * Escape one composite-key part. Mirrors the comparator's collision-safe
 * tuple encoding so capture orders records by exactly the identity the
 * comparator will use.
 */
function escapeKeyPart(part: string): string {
  return part.replaceAll('\\', '\\\\').replaceAll(':', '\\:')
}

function tupleKey(...parts: readonly (string | null)[]): string {
  const fields: string[] = []
  for (const part of parts) {
    if (part === null) {
      fields.push('0', '')
      continue
    }
    fields.push(escapeKeyPart(part))
  }
  return fields.join(':')
}

/** The comparator's stable identity for one record, per family. */
function stableIdOf(record: MigrationSnapshotRecord): string {
  switch (record.family) {
    case 'agents':
      return record.agentId
    case 'channelParticipants':
      return tupleKey(record.channelId, record.principalKind, record.principalId)
    case 'channels':
      return record.channelId
    case 'contentRefs':
      return record.contentRefId
    case 'events':
      return record.eventId
    case 'executionAttempts':
      return tupleKey(record.taskId, String(record.attempt))
    case 'identityBindings':
      return tupleKey(record.provider, record.subject)
    case 'invitations':
      return record.invitationId
    case 'memberships':
      return tupleKey(record.workspaceId, record.userId)
    case 'messages':
      return record.messageId
    case 'projectMembers':
      return tupleKey(record.projectId, record.userId)
    case 'projects':
      return record.projectId
    case 'readState':
      return tupleKey(
        record.workspaceId,
        record.userId,
        record.channelId,
        record.threadRootMessageId
      )
    case 'tasks':
      return record.taskId
    case 'temporarySessions':
      return record.sessionId
    case 'workspaces':
      return record.workspaceId
    case 'artifactReferenceGrants':
      return record.grantId
    case 'contentReplicas':
      return record.replicaId
    case 'leadTurnRuntime':
      return record.intentId
    case 'nativeSessions':
      return record.sessionRef
    case 'runtimeNodes':
      return record.runtimeNodeId
    case 'taskSubmissions':
      return record.submissionId
  }
}

/**
 * Plain code-unit sort over the comparator's stable identity: unique per
 * family, independent of database collation and page boundaries, so the same
 * rows always serialize in the same order.
 */
function byStableId(left: MigrationSnapshotRecord, right: MigrationSnapshotRecord): number {
  const leftId = stableIdOf(left)
  const rightId = stableIdOf(right)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

// ─── Bounded pagination ──────────────────────────────────────────────────────

export type BoundedCollection = Readonly<{
  records: MigrationSnapshotRecord[]
  truncated: boolean
}>

/**
 * Read one family through offset pagination until the domain is exhausted or
 * `limit` records are captured — whichever happens first — and report which.
 * Each page asks for `MIGRATION_SNAPSHOT_CAPTURE_PAGE_SIZE + 1` rows; the
 * extra row proves more data follows without a second query. Truncation is
 * reported as `true` exactly when the scan stopped at the bound while rows
 * remained (in the page's tail or beyond it); an exhausted scan is `false`
 * even when it filled the bound exactly. Records are ordered by stable id so
 * page size and collation cannot change the output.
 */
export async function collectBoundedRecords<R>(input: {
  fetchPage: (offset: number, rowsBound: number) => Promise<readonly R[]>
  limit: number
  toRecord: (row: R) => MigrationSnapshotRecord
}): Promise<BoundedCollection> {
  const { fetchPage, toRecord } = input
  const limit = requireCaptureBound(input.limit)
  const records: MigrationSnapshotRecord[] = []
  let offset = 0
  for (;;) {
    const probed = await fetchPage(offset, MIGRATION_SNAPSHOT_CAPTURE_PAGE_SIZE + 1)
    const hasMore = probed.length > MIGRATION_SNAPSHOT_CAPTURE_PAGE_SIZE
    const page = hasMore ? probed.slice(0, MIGRATION_SNAPSHOT_CAPTURE_PAGE_SIZE) : probed
    let consumed = 0
    for (; consumed < page.length; consumed++) {
      if (records.length >= limit) break
      records.push(toRecord(page[consumed]))
    }
    if (records.length >= limit) {
      const stoppedMidPage = consumed < page.length
      return { records: records.toSorted(byStableId), truncated: stoppedMidPage || hasMore }
    }
    if (!hasMore) return { records: records.toSorted(byStableId), truncated: false }
    offset += page.length
  }
}

async function captureFamilySection<R>(
  transaction: AgentHqTransaction,
  bound: number,
  reader: Readonly<{
    fetchPage: (offset: number, rowsBound: number) => Promise<readonly R[]>
    toRecord: (row: R) => MigrationSnapshotRecord
  }>
): Promise<MigrationSnapshotSection> {
  const { records, truncated } = await collectBoundedRecords({
    fetchPage: reader.fetchPage,
    limit: bound,
    toRecord: reader.toRecord,
  })
  return Object.freeze({
    limit: bound,
    records: Object.freeze(records),
    truncated,
  })
}

// ─── Per-family readers ──────────────────────────────────────────────────────

/**
 * The invitation lifecycle state, derived exactly as
 * `workspace-invitations.ts` derives it — from the row's settled timestamps
 * and the injectable capture clock, never the wall clock, so the same rows
 * and the same `capturedAt` derive the same state.
 */
function invitationState(
  row: Readonly<{
    acceptedAt: Date | null
    expiresAt: Date
    revokedAt: Date | null
  }>,
  now: Date
): 'accepted' | 'expired' | 'pending' | 'revoked' {
  if (row.acceptedAt) return 'accepted'
  if (row.revokedAt) return 'revoked'
  return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending'
}

/**
 * A bigint that reached the capture through a raw query (the read-frontier
 * union) as a driver string. Safe integers become numbers; anything else
 * stays a string so the record serializes deterministically and the
 * comparator quarantines it as a typed limit issue — never rounded silently.
 */
function countFromDriver(value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
    return value
  }
  return String(value)
}

type RawRow = Record<string, unknown>

async function rawRows(
  transaction: AgentHqTransaction,
  query: ReturnType<typeof sql>
): Promise<readonly RawRow[]> {
  return (await transaction.execute(query)) as unknown as readonly RawRow[]
}

/**
 * Channel-level and thread-level read frontiers as one paginated stream: the
 * union of both tables with a null thread root for channel rows, ordered by
 * the comparator's read-state identity (nulls last, deterministic).
 */
function readStateSection(
  transaction: AgentHqTransaction,
  bound: number
): Promise<MigrationSnapshotSection> {
  return captureFamilySection(transaction, bound, {
    fetchPage: async (offset, rowsBound) =>
      rawRows(
        transaction,
        sql`
          select
            frontiers.workspace_id as workspace_id,
            frontiers.user_id as user_id,
            frontiers.channel_id as channel_id,
            frontiers.thread_root_message_id as thread_root_message_id,
            frontiers.last_read_sequence as last_read_sequence,
            frontiers.manually_unread as manually_unread
          from (
            select
              ${channelReadStates.workspaceId},
              ${channelReadStates.userId},
              ${channelReadStates.channelId},
              null::uuid as thread_root_message_id,
              ${channelReadStates.lastReadSequence},
              ${channelReadStates.manuallyUnread}
            from ${channelReadStates}
            union all
            select
              ${threadReadStates.workspaceId},
              ${threadReadStates.userId},
              ${threadReadStates.channelId},
              ${threadReadStates.threadRootMessageId},
              ${threadReadStates.lastReadSequence},
              ${threadReadStates.manuallyUnread}
            from ${threadReadStates}
          ) frontiers
          order by
            frontiers.workspace_id,
            frontiers.user_id,
            frontiers.channel_id,
            frontiers.thread_root_message_id
          limit ${rowsBound} offset ${offset}
        `
      ),
    toRecord: (row) =>
      // `lastReadSequence` arrives through a raw query as a driver string; a
      // value that is not a safe non-negative integer stays a string so the
      // record serializes deterministically and the comparator quarantines it
      // as a typed limit issue — never rounded silently.
      ({
        channelId: row.channel_id as string,
        family: 'readState',
        lastReadSequence: countFromDriver(row.last_read_sequence),
        manuallyUnread: row.manually_unread === true,
        threadRootMessageId: (row.thread_root_message_id as string | null) ?? null,
        userId: row.user_id as string,
        workspaceId: row.workspace_id as string,
      }) as MigrationSnapshotRecordFor<'readState'>,
  })
}

async function captureFamilySectionByName(
  transaction: AgentHqTransaction,
  family: MigrationSnapshotFamily,
  bound: number,
  capturedAt: Date
): Promise<MigrationSnapshotSection> {
  switch (family) {
    case 'agents':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              id: agents.id,
              lifecycleState: agents.lifecycleState,
              projectId: agents.projectId,
              workspaceId: agents.workspaceId,
            })
            .from(agents)
            .orderBy(asc(agents.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          agentId: row.id,
          family: 'agents',
          lifecycleState: row.lifecycleState,
          projectId: row.projectId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'channelParticipants':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              agentId: channelParticipants.agentId,
              channelId: channelParticipants.channelId,
              principalKind: channelParticipants.principalKind,
              userId: channelParticipants.userId,
              workspaceId: channelParticipants.workspaceId,
            })
            .from(channelParticipants)
            .orderBy(
              asc(channelParticipants.channelId),
              asc(channelParticipants.principalKind),
              asc(channelParticipants.userId),
              asc(channelParticipants.agentId)
            )
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) =>
          // A principal id can only be null on a row that already violates the
          // schema's principal-consistency check; the record is carried verbatim
          // so the comparator quarantines it as a typed issue instead of capture
          // guessing or dropping it.
          ({
            channelId: row.channelId,
            family: 'channelParticipants',
            principalId: row.userId ?? row.agentId,
            principalKind: row.principalKind,
            workspaceId: row.workspaceId,
          }) as MigrationSnapshotRecordFor<'channelParticipants'>,
      })
    case 'channels':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              id: channels.id,
              projectId: channels.projectId,
              visibility: channels.visibility,
              workspaceId: channels.workspaceId,
            })
            .from(channels)
            .orderBy(asc(channels.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          channelId: row.id,
          family: 'channels',
          projectId: row.projectId,
          visibility: row.visibility,
          workspaceId: row.workspaceId,
        }),
      })
    case 'contentRefs':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              availability: contentRefs.availability,
              digestSha256: contentRefs.digestSha256,
              id: contentRefs.id,
              keyVersion: contentRefs.keyVersion,
              messageId: contentRefs.messageId,
              revision: contentRefs.revision,
              taskId: contentRefs.taskId,
              workspaceId: contentRefs.workspaceId,
            })
            .from(contentRefs)
            .orderBy(asc(contentRefs.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          availability: row.availability,
          contentRefId: row.id,
          digestSha256: row.digestSha256,
          family: 'contentRefs',
          keyVersion: row.keyVersion,
          messageId: row.messageId,
          revision: row.revision,
          taskId: row.taskId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'events':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              eventType: workspaceEvents.eventType,
              id: workspaceEvents.id,
              payload: workspaceEvents.payload,
              schemaVersion: workspaceEvents.schemaVersion,
              workspaceId: workspaceEvents.workspaceId,
              workspaceSequence: workspaceEvents.workspaceSequence,
            })
            .from(workspaceEvents)
            .orderBy(asc(workspaceEvents.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          eventId: row.id,
          eventType: row.eventType,
          family: 'events',
          // An over-limit deep payload digests to nothing: the field carries
          // the clearly-marked inconclusive marker, which the comparator
          // quarantines before comparison — never a synthesized digest.
          payloadDigest: migrationSnapshotEventPayloadDigestField(row.payload),
          schemaVersion: row.schemaVersion,
          workspaceId: row.workspaceId,
          workspaceSequence: row.workspaceSequence,
        }),
      })
    case 'executionAttempts':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              attempt: taskExecutionAttempts.attempt,
              locationKind: taskExecutionAttempts.locationKind,
              runtimeNodeId: taskExecutionAttempts.runtimeNodeId,
              taskId: taskExecutionAttempts.taskId,
              workspaceId: taskExecutionAttempts.workspaceId,
            })
            .from(taskExecutionAttempts)
            .orderBy(asc(taskExecutionAttempts.taskId), asc(taskExecutionAttempts.attempt))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          attempt: row.attempt,
          family: 'executionAttempts',
          locationKind: row.locationKind,
          runtimeNodeId: row.runtimeNodeId,
          taskId: row.taskId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'identityBindings':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              provider: authIdentities.provider,
              subject: authIdentities.subject,
              userId: authIdentities.userId,
            })
            .from(authIdentities)
            .orderBy(asc(authIdentities.provider), asc(authIdentities.subject))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          family: 'identityBindings',
          provider: row.provider,
          subject: row.subject,
          userId: row.userId,
        }),
      })
    case 'invitations':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              acceptedAt: workspaceInvitations.acceptedAt,
              expiresAt: workspaceInvitations.expiresAt,
              id: workspaceInvitations.id,
              invitedByUserId: workspaceInvitations.invitedByUserId,
              revokedAt: workspaceInvitations.revokedAt,
              role: workspaceInvitations.role,
              workspaceId: workspaceInvitations.workspaceId,
            })
            .from(workspaceInvitations)
            .orderBy(asc(workspaceInvitations.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          family: 'invitations',
          invitationId: row.id,
          invitedByUserId: row.invitedByUserId,
          role: row.role,
          state: invitationState(row, capturedAt),
          workspaceId: row.workspaceId,
        }),
      })
    case 'memberships':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              role: workspaceMemberships.role,
              userId: workspaceMemberships.userId,
              workspaceId: workspaceMemberships.workspaceId,
            })
            .from(workspaceMemberships)
            .orderBy(asc(workspaceMemberships.workspaceId), asc(workspaceMemberships.userId))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          family: 'memberships',
          role: row.role,
          userId: row.userId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'messages':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              channelId: messages.channelId,
              deletedAt: messages.deletedAt,
              id: messages.id,
              threadRootMessageId: messages.threadRootMessageId,
              workspaceId: messages.workspaceId,
            })
            .from(messages)
            .orderBy(asc(messages.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          channelId: row.channelId,
          deleted: row.deletedAt !== null,
          family: 'messages',
          messageId: row.id,
          threadRootMessageId: row.threadRootMessageId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'projectMembers':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              projectId: projectMembers.projectId,
              role: projectMembers.role,
              userId: projectMembers.userId,
              workspaceId: projectMembers.workspaceId,
            })
            .from(projectMembers)
            .orderBy(asc(projectMembers.projectId), asc(projectMembers.userId))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          family: 'projectMembers',
          projectId: row.projectId,
          role: row.role,
          userId: row.userId,
          workspaceId: row.workspaceId,
        }),
      })
    case 'projects':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              id: projects.id,
              visibility: projects.visibility,
              workspaceId: projects.workspaceId,
            })
            .from(projects)
            .orderBy(asc(projects.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          family: 'projects',
          projectId: row.id,
          visibility: row.visibility,
          workspaceId: row.workspaceId,
        }),
      })
    case 'readState':
      return readStateSection(transaction, bound)
    case 'tasks':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              channelId: tasks.channelId,
              creatorUserId: tasks.creatorUserId,
              id: tasks.id,
              lifecycleState: tasks.lifecycleState,
              messageId: tasks.messageId,
              projectId: tasks.projectId,
              threadRootMessageId: tasks.threadRootMessageId,
              version: tasks.version,
              workspaceId: tasks.workspaceId,
            })
            .from(tasks)
            .orderBy(asc(tasks.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          channelId: row.channelId,
          creatorUserId: row.creatorUserId,
          family: 'tasks',
          lifecycleState: row.lifecycleState,
          messageId: row.messageId,
          projectId: row.projectId,
          taskId: row.id,
          threadRootMessageId: row.threadRootMessageId,
          version: row.version,
          workspaceId: row.workspaceId,
        }),
      })
    case 'temporarySessions':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              claimedAt: temporaryUserSessions.claimedAt,
              id: temporaryUserSessions.id,
              userId: temporaryUserSessions.userId,
            })
            .from(temporaryUserSessions)
            .orderBy(asc(temporaryUserSessions.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          claimed: row.claimedAt !== null,
          family: 'temporarySessions',
          sessionId: row.id,
          userId: row.userId,
        }),
      })
    case 'workspaces':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              controlPlaneWorkspaceId: workspaces.controlPlaneWorkspaceId,
              deletedAt: workspaces.deletedAt,
              id: workspaces.id,
              ownerUserId: workspaces.ownerUserId,
            })
            .from(workspaces)
            .orderBy(asc(workspaces.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          archived: row.deletedAt !== null,
          controlPlaneWorkspaceId: row.controlPlaneWorkspaceId,
          family: 'workspaces',
          ownerUserId: row.ownerUserId,
          workspaceId: row.id,
        }),
      })
    case 'artifactReferenceGrants':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              artifactId: artifactReferenceGrants.artifactId,
              audienceWorkspaceId: artifactReferenceGrants.audienceWorkspaceId,
              checksumSha256: artifactReferenceGrants.checksumSha256,
              expiresAt: artifactReferenceGrants.expiresAt,
              grantId: artifactReferenceGrants.grantId,
              revokedAt: artifactReferenceGrants.revokedAt,
              revision: artifactReferenceGrants.revision,
              sourceWorkspaceId: artifactReferenceGrants.sourceWorkspaceId,
              version: artifactReferenceGrants.version,
            })
            .from(artifactReferenceGrants)
            .orderBy(asc(artifactReferenceGrants.grantId))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          artifactId: row.artifactId,
          audienceWorkspaceId: row.audienceWorkspaceId,
          checksumSha256: row.checksumSha256,
          expiresAt: row.expiresAt,
          family: 'artifactReferenceGrants',
          grantId: row.grantId,
          revoked: row.revokedAt !== null,
          revision: row.revision,
          sourceWorkspaceId: row.sourceWorkspaceId,
          version: row.version,
        }),
      })
    case 'contentReplicas':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              availability: contentReplicas.availability,
              contentRefId: contentReplicas.contentRefId,
              deletedAt: contentReplicas.deletedAt,
              digestSha256: contentReplicas.digestSha256,
              id: contentReplicas.id,
              replicaKind: contentReplicas.replicaKind,
              revision: contentReplicas.revision,
              schemaVersion: contentReplicas.schemaVersion,
              workspaceId: contentReplicas.workspaceId,
            })
            .from(contentReplicas)
            .orderBy(asc(contentReplicas.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          availability: row.availability,
          contentRefId: row.contentRefId,
          deleted: row.deletedAt !== null,
          digestSha256: row.digestSha256,
          family: 'contentReplicas',
          replicaId: row.id,
          replicaKind: row.replicaKind,
          revision: row.revision,
          schemaVersion: row.schemaVersion,
          workspaceId: row.workspaceId,
        }),
      })
    case 'leadTurnRuntime':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              attemptId: leadTurnRuntime.attemptId,
              cancelRequestedAt: leadTurnRuntime.cancelRequestedAt,
              executionId: leadTurnRuntime.executionId,
              intentId: leadTurnRuntime.intentId,
              publishedMessageId: leadTurnRuntime.publishedMessageId,
              runtimeSessionId: leadTurnRuntime.runtimeSessionId,
              state: leadTurnRuntime.state,
            })
            .from(leadTurnRuntime)
            .orderBy(asc(leadTurnRuntime.intentId))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          attemptId: row.attemptId,
          cancelRequested: row.cancelRequestedAt !== null,
          executionId: row.executionId,
          family: 'leadTurnRuntime',
          intentId: row.intentId,
          publishedMessageId: row.publishedMessageId,
          runtimeSessionId: row.runtimeSessionId,
          state: row.state,
        }),
      })
    case 'nativeSessions':
      // Composed by `captureNativeSessionSection` outside the database
      // transaction; `captureDocument` assigns the precomputed section and
      // never routes this family through the database switch.
      throw new Error(
        'nativeSessions is composed from the runtime inventory, not captured from this database'
      )
    case 'runtimeNodes':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              id: runtimeNodes.id,
              kind: runtimeNodes.kind,
              pairingState: runtimeNodes.pairingState,
              platform: runtimeNodes.platform,
              revokedAt: runtimeNodes.revokedAt,
              softwareVersion: runtimeNodes.softwareVersion,
              workspaceId: runtimeNodes.workspaceId,
            })
            .from(runtimeNodes)
            .orderBy(asc(runtimeNodes.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          family: 'runtimeNodes',
          kind: row.kind,
          pairingState: row.pairingState,
          platform: row.platform,
          revoked: row.revokedAt !== null,
          runtimeNodeId: row.id,
          softwareVersion: row.softwareVersion,
          workspaceId: row.workspaceId,
        }),
      })
    case 'taskSubmissions':
      return captureFamilySection(transaction, bound, {
        fetchPage: (offset, rowsBound) =>
          transaction
            .select({
              agentId: taskSubmissions.agentId,
              ciphertextPurgedAt: taskSubmissions.ciphertextPurgedAt,
              id: taskSubmissions.id,
              locationKind: taskSubmissions.locationKind,
              profileId: taskSubmissions.profileId,
              profileRevision: taskSubmissions.profileRevision,
              profileVersion: taskSubmissions.profileVersion,
              runtimeNodeId: taskSubmissions.runtimeNodeId,
              state: taskSubmissions.state,
              taskId: taskSubmissions.taskId,
              taskVersion: taskSubmissions.taskVersion,
              workspaceId: taskSubmissions.workspaceId,
            })
            .from(taskSubmissions)
            .orderBy(asc(taskSubmissions.id))
            .limit(rowsBound)
            .offset(offset),
        toRecord: (row) => ({
          agentId: row.agentId,
          ciphertextPurged: row.ciphertextPurgedAt !== null,
          family: 'taskSubmissions',
          locationKind: row.locationKind,
          profileId: row.profileId,
          profileRevision: row.profileRevision,
          profileVersion: row.profileVersion,
          runtimeNodeId: row.runtimeNodeId,
          state: row.state,
          submissionId: row.id,
          taskId: row.taskId,
          taskVersion: row.taskVersion,
          workspaceId: row.workspaceId,
        }),
      })
  }
}

async function captureDocument(
  transaction: AgentHqTransaction,
  identity: MigrationSnapshotIdentity,
  domains: readonly MigrationSnapshotDomainCaptureStatus[],
  bound: number,
  capturedAt: Date,
  nativeSessionSection?: MigrationSnapshotSection
): Promise<MigrationSnapshotDocument> {
  const captured = new Set(
    domains.filter((domain) => domain.status === 'captured').map((domain) => domain.domain)
  )
  // Sections are emitted in contract-family order regardless of the order
  // domains were requested in, so the serialized document is byte-stable.
  const sections: Partial<Record<MigrationSnapshotFamily, MigrationSnapshotSection>> = {}
  for (const family of migrationSnapshotFamilies) {
    if (!captured.has(family)) continue
    if (family === 'nativeSessions') {
      if (nativeSessionSection) sections[family] = nativeSessionSection
      continue
    }
    sections[family] = await captureFamilySectionByName(transaction, family, bound, capturedAt)
  }
  return Object.freeze({
    identity,
    sections: Object.freeze(sections) as MigrationSnapshotSections,
  })
}

/**
 * Capture one consistent snapshot document inside the caller's transaction.
 * The caller owns the transaction's isolation and access mode — wrap it in
 * `MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG` (or open it with
 * `captureMigrationSnapshot`) so every family is read at one database
 * snapshot and the read stays read-only.
 */
export async function captureMigrationSnapshotInTransaction(
  transaction: AgentHqTransaction,
  input: MigrationSnapshotCaptureInput,
  composition?: Readonly<{ nativeSessionSection?: MigrationSnapshotSection }>
): Promise<MigrationSnapshotCaptureResult> {
  const identity = requireCaptureIdentity(input.identity)
  const bound = requireCaptureBound(input.limitPerFamily)
  let domains = resolveMigrationSnapshotCaptureDomains(input.requestedDomains, {
    nativeSessionInventory: input.nativeSessionInventory,
  })
  const nativeSessionSection = composition?.nativeSessionSection
  if (
    nativeSessionSection === undefined &&
    domains.some((domain) => domain.domain === 'nativeSessions' && domain.status === 'captured')
  ) {
    // A declared source with no composed read stays an explicit unknown; the
    // caller must compose the runtime read outside its own transaction.
    domains = domains.map((domain) =>
      domain.domain === 'nativeSessions'
        ? {
            domain: 'nativeSessions',
            status: 'unknown' as const,
            unknownReason: 'inventory_error' as const,
          }
        : domain
    )
  }
  const document = await captureDocument(
    transaction,
    identity,
    domains,
    bound,
    input.identity.capturedAt,
    nativeSessionSection
  )
  return Object.freeze({ document, domains })
}

/**
 * Capture one consistent, read-only snapshot document from the database.
 *
 * Opens exactly one REPEATABLE READ, READ ONLY transaction (see
 * `MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG`) and reads every requested
 * family inside it, offset-paginated to exhaustion or the per-family bound.
 * The database handle is an explicit argument; nothing here resolves a DSN,
 * writes a row, or derives any output value from the wall clock — identity
 * and the capture time arrive in `input`, and the same database state with
 * the same inputs produces byte-identical documents.
 */
export async function captureMigrationSnapshot(
  database: AgentHqDatabase,
  input: MigrationSnapshotCaptureInput
): Promise<MigrationSnapshotCaptureResult> {
  const identity = requireCaptureIdentity(input.identity)
  const bound = requireCaptureBound(input.limitPerFamily)
  let domains = resolveMigrationSnapshotCaptureDomains(input.requestedDomains, {
    nativeSessionInventory: input.nativeSessionInventory,
  })
  // The runtime read is composed before the database transaction opens: the
  // read-only snapshot transaction must not be held open across bridge I/O.
  let nativeSessionSection: MigrationSnapshotSection | undefined
  if (
    domains.some((domain) => domain.domain === 'nativeSessions' && domain.status === 'captured')
  ) {
    try {
      nativeSessionSection = await captureNativeSessionSection(input.nativeSessionInventory!, bound)
    } catch {
      // Denied, unavailable or invalid runtime inventory stays an explicit
      // unknown with no section — never an empty capture.
      domains = domains.map((domain) =>
        domain.domain === 'nativeSessions'
          ? {
              domain: 'nativeSessions',
              status: 'unknown' as const,
              unknownReason: 'inventory_error' as const,
            }
          : domain
      )
    }
  }
  const document = await database.transaction(
    (transaction) =>
      captureDocument(
        transaction,
        identity,
        domains,
        bound,
        input.identity.capturedAt,
        nativeSessionSection
      ),
    MIGRATION_SNAPSHOT_CAPTURE_TRANSACTION_CONFIG
  )
  return Object.freeze({ document, domains })
}
