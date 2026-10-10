// Read-only comparator for frozen BEFORE/AFTER migration snapshots
// (M18.01, issue #1181).
//
// This is comparison tooling for migration rehearsal, not migration
// acceptance: it consumes two bounded, structured snapshot documents and
// reports typed findings. It cannot backfill, delete, cut over or roll
// anything back — every function here is pure and every input is a frozen
// document, so the module is structurally incapable of touching a database.
//
// Epistemics are fail-closed. A family section absent from a document makes
// that domain unknown, never zero. A section flagged truncated yields a
// finding, so an incomplete scan can never read as a clean one; a section
// whose truncation evidence is missing, whose shape is malformed, or whose
// record count exceeds a documented bound is a typed structure error, never
// a silent claim of completeness. A malformed, misfiled, or
// audience-ambiguous record is quarantined and excluded from matching rather
// than guessed at, and conflicting duplicate records are quarantined
// deterministically — reordering input records or object keys cannot change
// the outcome, because quarantine identities and opaque references are
// derived from canonical (key-sorted) encodings. Every input record — of any
// shape, primitives and top-level arrays included — is bounded on total
// bytes, property slots and array width BEFORE canonicalization — bounds
// cover extra properties too, apply ahead of every quarantine path, and an
// oversized value's quarantine identity is a bounded descriptor, so
// oversized content is never canonicalized, hashed or echoed. Composite
// identities (record stable ids and finding ids) are built with a
// collision-safe tuple encoding, so distinct part tuples can never join to
// the same key. Identity mismatches between the two snapshots are a typed
// error, not a diff. Output is deterministic: sorted findings, sorted
// counts, no timestamps, and no message bodies or credentials — the record
// contract (see `@adea-ai/types` migration-snapshot) excludes those fields,
// findings only ever carry allow-listed detail keys, and every value a
// finding carries passes a well-formed reference check: anything else is
// replaced by an opaque reference (type plus short deterministic
// fingerprint) before it can surface. Workspace bindings of nested
// participants (channel participants, project members, execution attempts)
// are part of the compared binding, so a workspace-only remap can never read
// as identical.

import { createHash } from 'node:crypto'

import type {
  MigrationSnapshotComparison,
  MigrationSnapshotDocument,
  MigrationSnapshotFamily,
  MigrationSnapshotFamilyInventory,
  MigrationSnapshotFinding,
  MigrationSnapshotFindingClass,
  MigrationSnapshotFindingDetailKey,
  MigrationSnapshotRecord,
  MigrationSnapshotSection,
} from '@adea-ai/types'
import {
  isMigrationSnapshotFamily,
  migrationSnapshotFindingDetailKeys,
  MIGRATION_SNAPSHOT_MAX_FINDINGS,
  MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION,
  MIGRATION_SNAPSHOT_FORMAT_VERSION,
  migrationSnapshotFamilies,
  migrationSnapshotRecordIssue,
  migrationSnapshotRecordShapeIssue,
} from '@adea-ai/types'

/** The two snapshots do not describe the same rehearsal, format or source. */
export class MigrationSnapshotIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationSnapshotIdentityError'
  }
}

/**
 * A snapshot section is malformed or exceeds a documented bound: missing
 * truncation evidence, ill-typed shape, or a record count over the declared
 * limit, the per-section cap, or the comparison output bound. Fail-closed:
 * such input is rejected instead of compared, so it can never yield a
 * verdict — least of all a success verdict.
 */
export class MigrationSnapshotStructureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationSnapshotStructureError'
  }
}

// ─── Family comparison table ─────────────────────────────────────────────────

/**
 * How one family's matched records are compared.
 *
 * - `binding` fields are the record's identity binding: same stable id with a
 *   changed binding is a remap, not an attribute edit.
 * - `digests` are content-addressed fields: any drift is digest drift.
 * - `attributes` are compared for equality; `widened` marks the access-bearing
 *   fields whose growth is reported as widened access.
 */
type FamilyComparison = Readonly<{
  attributes: readonly Readonly<{ field: string; widened?: boolean }>[]
  binding: readonly string[]
  digests: readonly string[]
}>

const WORKSPACE_ROLE_RANK: Readonly<Record<string, number>> = { admin: 2, member: 1, owner: 3 }
const INVITATION_ROLE_RANK: Readonly<Record<string, number>> = { admin: 2, member: 1 }
const PROJECT_MEMBER_ROLE_RANK: Readonly<Record<string, number>> = { editor: 2, viewer: 1 }

function roleGrew(rank: Readonly<Record<string, number>>) {
  return (before: string, after: string) => (rank[after] ?? 0) > (rank[before] ?? 0)
}

function visibilityGrew(before: string, after: string): boolean {
  return before !== 'workspace' && after === 'workspace'
}

// Field audit: every field the capture writes for a family is compared here.
// The only intentional exceptions are the stable identity fields named by
// `stableIdOf`, which define the match rather than describe it. A captured
// field missing from its family's entry would let drift report `identical`,
// so the families added by #1219 compare every non-identity captured field:
// artifactReferenceGrants, contentReplicas, leadTurnRuntime, nativeSessions,
// runtimeNodes and taskSubmissions. Bindings are links (a change is a remap),
// digests are content/profile/version facts (drift), attributes are the row's
// own state.
const FAMILY_COMPARISONS: Readonly<Record<MigrationSnapshotFamily, FamilyComparison>> = {
  agents: {
    attributes: [{ field: 'lifecycleState' }],
    binding: ['projectId', 'workspaceId'],
    digests: [],
  },
  // A channel participant's workspace binding is part of its identity
  // binding: the audience row belongs to exactly one workspace, so a
  // workspace-only change is a remap, never an identical match.
  channelParticipants: { attributes: [], binding: ['workspaceId'], digests: [] },
  channels: {
    attributes: [{ field: 'visibility', widened: true }],
    binding: ['projectId', 'workspaceId'],
    digests: [],
  },
  contentRefs: {
    attributes: [{ field: 'availability' }],
    binding: ['messageId', 'taskId', 'workspaceId'],
    digests: ['digestSha256', 'keyVersion', 'revision'],
  },
  events: {
    attributes: [],
    binding: ['eventType', 'workspaceId', 'workspaceSequence'],
    digests: ['payloadDigest', 'schemaVersion'],
  },
  executionAttempts: {
    // Owner binding: where (workspace, location, node) the attempt ran. The
    // finding class is chosen per row (only a row that is the active attempt
    // on BOTH sides reports a conflicting owner).
    attributes: [],
    binding: ['locationKind', 'runtimeNodeId', 'workspaceId'],
    digests: [],
  },
  identityBindings: { attributes: [], binding: ['userId'], digests: [] },
  invitations: {
    attributes: [
      { field: 'invitedByUserId' },
      { field: 'role', widened: true },
      { field: 'state' },
    ],
    binding: ['workspaceId'],
    digests: [],
  },
  memberships: {
    attributes: [{ field: 'role', widened: true }],
    binding: [],
    digests: [],
  },
  messages: {
    attributes: [{ field: 'deleted' }],
    binding: ['channelId', 'threadRootMessageId', 'workspaceId'],
    digests: [],
  },
  nativeSessions: {
    // The runtime owns the session; the record mirrors its identity, scope,
    // lifecycle and profile binding. Scope and profile identity are links, the
    // profile version is a digest, and the runtime's monotonic counters plus
    // lifecycle state are attributes.
    attributes: [
      { field: 'archived' },
      { field: 'generation' },
      { field: 'lifecycle' },
      { field: 'version' },
    ],
    binding: [
      'accountId',
      'activeHarnessRunId',
      'agentProfileId',
      'harnessInstallationId',
      'projectId',
      'runtimeNodeId',
      'workspaceId',
      'worktreeId',
    ],
    digests: ['agentProfileVersion'],
  },
  projectMembers: {
    // A project grant belongs to exactly one workspace: a workspace-only
    // change is a remap of the grant, never an identical match.
    attributes: [{ field: 'role', widened: true }],
    binding: ['workspaceId'],
    digests: [],
  },
  projects: {
    attributes: [{ field: 'visibility', widened: true }],
    binding: ['workspaceId'],
    digests: [],
  },
  readState: {
    // `lastReadSequence` is compared directionally (lost_read_state on
    // regression) outside this table; `manuallyUnread` here.
    attributes: [{ field: 'manuallyUnread' }],
    binding: [],
    digests: [],
  },
  tasks: {
    attributes: [{ field: 'lifecycleState' }, { field: 'version' }],
    binding: [
      'channelId',
      'creatorUserId',
      'messageId',
      'projectId',
      'threadRootMessageId',
      'workspaceId',
    ],
    digests: [],
  },
  temporarySessions: {
    attributes: [{ field: 'claimed' }],
    binding: ['userId'],
    digests: [],
  },
  workspaces: {
    attributes: [{ field: 'archived' }],
    binding: ['controlPlaneWorkspaceId', 'ownerUserId'],
    digests: [],
  },
  artifactReferenceGrants: {
    // Revocation and revision are the grant's own state; the exact target
    // binding is identity, so a moved grant is a remap, never a match. The
    // persisted expiry is compared verbatim as an attribute: clearing,
    // extending or shortening authorization is determinate drift even when
    // `grantId` and `revision` are unchanged. It is never inferred from
    // revocation, and the comparison uses the persisted string — never the
    // capture clock — so elapsed time alone cannot differ.
    attributes: [{ field: 'expiresAt' }, { field: 'revoked' }],
    binding: ['artifactId', 'audienceWorkspaceId', 'sourceWorkspaceId', 'version'],
    digests: ['checksumSha256', 'revision'],
  },
  contentReplicas: {
    attributes: [{ field: 'availability' }, { field: 'deleted' }],
    binding: ['contentRefId', 'replicaKind', 'workspaceId'],
    digests: ['digestSha256', 'revision', 'schemaVersion'],
  },
  leadTurnRuntime: {
    // `runtimeSessionId` and `publishedMessageId` are links to the runtime
    // session and published message this turn is bound to: a change is a
    // remap, never an identical match.
    attributes: [{ field: 'cancelRequested' }, { field: 'state' }],
    binding: ['attemptId', 'executionId', 'publishedMessageId', 'runtimeSessionId'],
    digests: [],
  },
  runtimeNodes: {
    // `platform` is the node's environment fact; `softwareVersion` is the
    // reported build, compared as a digest so a version change is drift.
    attributes: [{ field: 'pairingState' }, { field: 'platform' }, { field: 'revoked' }],
    binding: ['kind', 'workspaceId'],
    digests: ['softwareVersion'],
  },
  taskSubmissions: {
    // The profile pin identity and dispatch location are links; the profile
    // version and task version are content pins compared as digests.
    attributes: [{ field: 'ciphertextPurged' }, { field: 'state' }],
    binding: ['agentId', 'locationKind', 'profileId', 'runtimeNodeId', 'taskId', 'workspaceId'],
    digests: ['profileRevision', 'profileVersion', 'taskVersion'],
  },
}

/** Families whose rows ARE grants or audience membership: a new row in the
 *  after snapshot is widened access, not merely an unexpected record. */
const GRANT_FAMILIES: ReadonlySet<MigrationSnapshotFamily> = new Set([
  'artifactReferenceGrants',
  'channelParticipants',
  'memberships',
  'projectMembers',
])

const DETERMINATE_CLASSES: ReadonlySet<MigrationSnapshotFindingClass> = new Set([
  'changed_attribute',
  'conflicting_attempt_owner',
  'digest_drift',
  'duplicated_record',
  'lost_read_state',
  'missing_record',
  'remapped_record',
  'unexpected_record',
  'widened_access',
])

// ─── Helpers ─────────────────────────────────────────────────────────────────

function asText(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  return String(value)
}

/**
 * Escape one composite-key part: the escape character and the separator lose
 * their special meaning, so decoding is exact. Parts without `\` or `:`
 * pass through unchanged, keeping ordinary identifiers readable.
 */
function escapeKeyPart(part: string): string {
  return part.replaceAll('\\', '\\\\').replaceAll(':', '\\:')
}

/**
 * Collision-safe tuple encoding for composite keys. Every part is escaped
 * and joined with `:`, and an absent (null) part is encoded as the two
 * fields `0:` — a flag plus an empty value. Because the field sequence can
 * be decoded exactly, no two distinct part tuples share an encoding: unlike
 * naive colon joining, `['a', 'b:c']` encodes as `a:b\:c` and `['a:b', 'c']`
 * as `a\:b:c` — the two collide when joined naively, and a collision would
 * make two different records read as one identical identity. All composite
 * keys (record stable ids and finding ids) are built through this encoding.
 */
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

const CANONICAL_JSON_MAX_DEPTH = 64

/**
 * Deterministic JSON encoding: object keys sorted, arrays positional,
 * non-JSON values replaced with typed markers, recursion depth-capped.
 * Malformed objects with equal content must fingerprint identically no
 * matter how their keys were inserted, so quarantine identities, opaque
 * references and duplicate detection never depend on input ordering.
 */
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > CANONICAL_JSON_MAX_DEPTH) return '"~depth"'
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : `"~${String(value)}"`
    case 'boolean':
      return value ? 'true' : 'false'
    case 'bigint':
      return `"~${value.toString()}n"`
    case 'undefined':
      return '"~undefined"'
    case 'function':
    case 'symbol':
      return `"~${typeof value}"`
    default: {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`
      }
      const source = value as Record<string, unknown>
      const entries = Object.keys(source)
        .toSorted()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key], depth + 1)}`)
      return `{${entries.join(',')}}`
    }
  }
}

/** Stable identity of a valid record, per family, as a collision-safe tuple. */
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
 * Deterministic content identity for a record that failed validation, whose
 * real stable id cannot be trusted. The fingerprint is taken over the
 * canonical encoding, so reordering an object's keys cannot change it, and
 * hashing keeps the finding referable without echoing whatever the malformed
 * field held. Only values that already passed the size bounds reach this
 * function — of any shape, objects and primitives alike — so the canonical
 * encoding is bounded by construction.
 */
function quarantinedId(record: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex')
  return `unverifiable:${digest}`
}

/**
 * Deterministic identity for a record over the documented size bounds. Such
 * a record must NEVER be canonicalized — that is the point of the bound — so
 * its fingerprint is taken over a tiny bounded descriptor, never over its
 * content. Records over a size bound in the same section therefore share one
 * quarantine finding: the output stays bounded and the content is never
 * echoed.
 */
function oversizedRecordId(): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ bound: 'record-size' }), 'utf8')
    .digest('hex')
  return `unverifiable:${digest}`
}

/**
 * A reference the comparator may echo verbatim: bounded in length and built
 * only from identifier-safe characters. Anything else — arbitrary text in a
 * nominal identifier or digest, hostile extras — must never surface in a
 * finding.
 */
const WELL_FORMED_REFERENCE = /^[\w.*:-]{1,512}$/

const OPAQUE_REFERENCE_FINGERPRINT_LENGTH = 16

/**
 * An opaque, sanitized reference: the value's type plus a short deterministic
 * fingerprint over its canonical encoding. It proves two occurrences of the
 * same value are the same value without ever carrying the value itself.
 */
function opaqueReference(kind: string, value: unknown): string {
  const fingerprint = createHash('sha256')
    .update(canonicalJson(value), 'utf8')
    .digest('hex')
    .slice(0, OPAQUE_REFERENCE_FINGERPRINT_LENGTH)
  return `opaque:${kind}:${fingerprint}`
}

/**
 * The only values a finding may carry. A value that is not a well-formed
 * reference is replaced by its opaque reference before it can appear in the
 * output, so the comparator structurally cannot leak supplied content.
 */
function sanitizeReference(value: unknown): string {
  const text = typeof value === 'string' ? value : asText(value)
  if (WELL_FORMED_REFERENCE.test(text)) return text
  return opaqueReference(typeof value, value)
}

function sanitizeDetail(detail: Detail): Detail {
  const sanitized: { -readonly [K in MigrationSnapshotFindingDetailKey]?: string } = {}
  for (const key of migrationSnapshotFindingDetailKeys) {
    const value = detail[key]
    if (value !== undefined) sanitized[key] = sanitizeReference(value)
  }
  return sanitized
}

type Detail = MigrationSnapshotFinding['detail']

function findingId(
  findingClass: MigrationSnapshotFindingClass,
  family: MigrationSnapshotFamily,
  side: MigrationSnapshotFinding['side'],
  stableId: string,
  field?: string
): string {
  // `findingClass`, `family` and `side` are separator-free contract literals;
  // the (stableId, field) pair is encoded as a collision-safe tuple so two
  // distinct pairs can never join to the same finding id (a collided id would
  // silently deduplicate one of the two findings away).
  return [findingClass, family, side, tupleKey(stableId, field ?? null)].join(':')
}

class FindingCollector {
  private readonly ids = new Set<string>()
  readonly findings: MigrationSnapshotFinding[] = []

  add(
    findingClass: MigrationSnapshotFindingClass,
    family: MigrationSnapshotFamily,
    side: MigrationSnapshotFinding['side'],
    stableId: string,
    detail: Detail = {}
  ): void {
    const safeStableId = sanitizeReference(stableId)
    const safeDetail = sanitizeDetail(detail)
    const field = typeof safeDetail.field === 'string' ? safeDetail.field : undefined
    const id = findingId(findingClass, family, side, safeStableId, field)
    if (this.ids.has(id)) return
    this.ids.add(id)
    this.findings.push({
      detail: safeDetail,
      family,
      findingClass,
      id,
      side,
      stableId: safeStableId,
    })
  }
}

// ─── Per-family record diff ──────────────────────────────────────────────────

type FieldDelta = Readonly<{
  detail: Detail
  findingClass: MigrationSnapshotFindingClass
}>

function delta(
  findingClass: MigrationSnapshotFindingClass,
  field: string,
  before: string,
  after: string
): FieldDelta {
  return { detail: { after, before, field }, findingClass }
}

function compareMatchedRecords(
  family: MigrationSnapshotFamily,
  before: MigrationSnapshotRecord,
  after: MigrationSnapshotRecord,
  activeAttemptBoth: boolean
): FieldDelta[] {
  const comparison = FAMILY_COMPARISONS[family]
  const deltas: FieldDelta[] = []
  const beforeFields = before as Readonly<Record<string, unknown>>
  const afterFields = after as Readonly<Record<string, unknown>>

  for (const field of comparison.binding) {
    if (beforeFields[field] !== afterFields[field]) {
      deltas.push(
        delta('remapped_record', field, asText(beforeFields[field]), asText(afterFields[field]))
      )
    }
  }
  for (const field of comparison.digests) {
    if (beforeFields[field] !== afterFields[field]) {
      deltas.push(
        delta('digest_drift', field, asText(beforeFields[field]), asText(afterFields[field]))
      )
    }
  }
  for (const attribute of comparison.attributes) {
    const { field } = attribute
    if (beforeFields[field] === afterFields[field]) continue
    if (attribute.widened && field === 'role') {
      const grew =
        family === 'memberships'
          ? roleGrew(WORKSPACE_ROLE_RANK)
          : family === 'projectMembers'
            ? roleGrew(PROJECT_MEMBER_ROLE_RANK)
            : roleGrew(INVITATION_ROLE_RANK)
      deltas.push(
        delta(
          grew(asText(beforeFields[field]), asText(afterFields[field]))
            ? 'widened_access'
            : 'changed_attribute',
          field,
          asText(beforeFields[field]),
          asText(afterFields[field])
        )
      )
      continue
    }
    if (attribute.widened && field === 'visibility') {
      const grew = visibilityGrew(asText(beforeFields[field]), asText(afterFields[field]))
      deltas.push(
        delta(
          grew ? 'widened_access' : 'changed_attribute',
          field,
          asText(beforeFields[field]),
          asText(afterFields[field])
        )
      )
      continue
    }
    deltas.push(
      delta('changed_attribute', field, asText(beforeFields[field]), asText(afterFields[field]))
    )
  }

  // Directional comparisons the table cannot express.
  if (family === 'readState') {
    const beforeFrontier = (before as { lastReadSequence: number }).lastReadSequence
    const afterFrontier = (after as { lastReadSequence: number }).lastReadSequence
    if (afterFrontier < beforeFrontier) {
      deltas.push(
        delta('lost_read_state', 'lastReadSequence', String(beforeFrontier), String(afterFrontier))
      )
    } else if (afterFrontier > beforeFrontier) {
      deltas.push(
        delta(
          'changed_attribute',
          'lastReadSequence',
          String(beforeFrontier),
          String(afterFrontier)
        )
      )
    }
  }
  if (family === 'executionAttempts') {
    // Only a row that is the active attempt on BOTH sides reports a
    // conflicting owner; any other owner drift on a matched row is an
    // attribute change.
    return deltas.map((item) =>
      item.findingClass === 'remapped_record'
        ? {
            detail: item.detail,
            findingClass: activeAttemptBoth ? 'conflicting_attempt_owner' : 'changed_attribute',
          }
        : item
    )
  }
  return deltas
}

// ─── Section intake ──────────────────────────────────────────────────────────

type Side = MigrationSnapshotFinding['side']

type IntakeResult = Readonly<{
  activeAttempts: ReadonlyMap<string, number>
  byStableId: ReadonlyMap<string, MigrationSnapshotRecord>
  /** Records excluded before matching (malformed, null, or misfiled). */
  quarantined: number
}>

function intakeSection(
  section: MigrationSnapshotSection,
  family: MigrationSnapshotFamily,
  side: Exclude<Side, 'both'>,
  collector: FindingCollector
): IntakeResult {
  const canonicalById = new Map<string, string>()
  const firstById = new Map<string, MigrationSnapshotRecord>()
  const byStableId = new Map<string, MigrationSnapshotRecord>()
  const occurrences = new Map<string, number>()
  const activeByTask = new Map<string, number>()
  const conflicting = new Set<string>()
  let quarantined = 0

  for (const record of section.records) {
    // Size bounds run BEFORE anything else, on input of ANY shape — before
    // the object check, before the family check, before validation, before
    // the ignore decision on extra properties, and before any
    // canonicalization. A value over the byte, property-slot or array-width
    // bound — an oversized object, primitive or top-level array alike — is
    // quarantined by limit with a bounded descriptor as its only identity:
    // its content is never canonicalized, hashed or echoed, even when it was
    // already headed for another quarantine path.
    const shapeIssue = migrationSnapshotRecordShapeIssue(record)
    if (shapeIssue) {
      quarantined += 1
      collector.add('quarantined_record', family, side, oversizedRecordId(), {
        field: 'record',
        reason: 'limit',
      })
      continue
    }
    if (typeof record !== 'object' || record === null) {
      quarantined += 1
      collector.add('quarantined_record', family, side, quarantinedId(record), {
        field: 'record',
        reason: 'malformed',
      })
      continue
    }
    // A record whose family does not name this section's family is misfiled:
    // it is quarantined BEFORE comparison, never silently compared under the
    // wrong family (which could mask a real diff).
    if (!isMigrationSnapshotFamily(record.family) || record.family !== family) {
      quarantined += 1
      collector.add('quarantined_record', family, side, quarantinedId(record), {
        field: 'family',
        reason: 'family_mismatch',
      })
      continue
    }
    const issue = migrationSnapshotRecordIssue(record)
    if (issue) {
      quarantined += 1
      collector.add('quarantined_record', family, side, quarantinedId(record), {
        field: issue.field,
        reason: issue.kind,
      })
      continue
    }
    const stableId = stableIdOf(record)
    occurrences.set(stableId, (occurrences.get(stableId) ?? 0) + 1)
    const canonical = canonicalJson(record)
    const seenCanonical = canonicalById.get(stableId)
    if (seenCanonical === undefined) {
      canonicalById.set(stableId, canonical)
      firstById.set(stableId, record)
    } else if (seenCanonical !== canonical) {
      // Same stable id, different content. Which copy "wins" must never
      // depend on input order, so every conflicting id is quarantined as a
      // whole: none of its copies is compared.
      conflicting.add(stableId)
    }
  }
  for (const [stableId, count] of occurrences) {
    if (count > 1) {
      collector.add('duplicated_record', family, side, stableId, { count: String(count) })
    }
    if (conflicting.has(stableId)) {
      collector.add('quarantined_record', family, side, stableId, {
        field: 'stableId',
        reason: 'conflicting_duplicate',
      })
    }
  }
  for (const [stableId, record] of firstById) {
    if (conflicting.has(stableId)) continue
    byStableId.set(stableId, record)
    if (record.family === 'executionAttempts') {
      const current = activeByTask.get(record.taskId)
      if (current === undefined || record.attempt > current) {
        activeByTask.set(record.taskId, record.attempt)
      }
    }
  }
  if (section.truncated) {
    collector.add('truncated_input', family, side, '*', { reason: 'truncated' })
  }
  return { activeAttempts: activeByTask, byStableId, quarantined }
}

// ─── Structure and bounds ────────────────────────────────────────────────────

/**
 * Validate one present section's shape and bounds before any comparison.
 * Missing truncation evidence is never read as completeness; a section whose
 * record count exceeds its declared limit or the documented cap is rejected.
 */
function requireValidSectionShape(
  section: MigrationSnapshotSection,
  family: MigrationSnapshotFamily,
  label: 'before' | 'after'
): void {
  const where = `${label} snapshot, family ${family}`
  if (typeof section !== 'object' || section === null) {
    throw new MigrationSnapshotStructureError(
      `Malformed section in the ${where}: the section must be an object`
    )
  }
  if (!Array.isArray(section.records)) {
    throw new MigrationSnapshotStructureError(
      `Malformed section in the ${where}: records must be an array`
    )
  }
  if (typeof section.truncated !== 'boolean') {
    throw new MigrationSnapshotStructureError(
      `Missing truncation evidence in the ${where}: truncated must be a boolean; missing evidence is never read as completeness`
    )
  }
  if (section.limit !== undefined && (!Number.isSafeInteger(section.limit) || section.limit < 0)) {
    throw new MigrationSnapshotStructureError(
      `Malformed section in the ${where}: limit must be a non-negative safe integer when present`
    )
  }
  if (section.limit !== undefined && section.records.length > section.limit) {
    throw new MigrationSnapshotStructureError(
      `Section bound violated in the ${where}: ${section.records.length} records exceed the declared limit of ${section.limit}`
    )
  }
  if (section.records.length > MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION) {
    throw new MigrationSnapshotStructureError(
      `Section bound violated in the ${where}: ${section.records.length} records exceed the maximum of ${MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION}`
    )
  }
}

/**
 * Generous per-record share of the output bound: at most one quarantine or
 * duplicate finding plus the largest per-pair delta count (bindings, digests,
 * attributes and directional comparisons) of any family, with slack for
 * unexpected/missing findings on the after side.
 */
const FINDINGS_PER_RECORD_BOUND = 24

// ─── Identity ────────────────────────────────────────────────────────────────

function requireMatchingIdentity(
  before: MigrationSnapshotDocument,
  after: MigrationSnapshotDocument
): void {
  const fields: readonly (keyof MigrationSnapshotDocument['identity'])[] = [
    'rehearsalId',
    'formatVersion',
    'source',
  ]
  for (const field of fields) {
    const beforeValue = before.identity[field]
    const afterValue = after.identity[field]
    if (beforeValue === afterValue) continue
    throw new MigrationSnapshotIdentityError(
      `Snapshot identity mismatch on ${field}: the before and after snapshots must describe the same rehearsal, format and source`
    )
  }
  for (const [label, identity] of [
    ['before', before.identity],
    ['after', after.identity],
  ] as const) {
    if (
      typeof identity.rehearsalId !== 'string' ||
      identity.rehearsalId.length === 0 ||
      typeof identity.source !== 'string' ||
      identity.source.length === 0 ||
      typeof identity.snapshotId !== 'string' ||
      identity.snapshotId.length === 0 ||
      identity.formatVersion !== MIGRATION_SNAPSHOT_FORMAT_VERSION
    ) {
      throw new MigrationSnapshotIdentityError(
        `Snapshot identity malformed on the ${label} document: rehearsalId, snapshotId, source and formatVersion must be present and the format must be version ${MIGRATION_SNAPSHOT_FORMAT_VERSION}`
      )
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Compare a frozen BEFORE snapshot against a frozen AFTER snapshot and return
 * the complete, deterministic finding set. Throws
 * `MigrationSnapshotIdentityError` when the two documents do not carry the
 * same rehearsal id, format version and source, or when either identity is
 * malformed — a mismatch is an input error, never a diff. Throws
 * `MigrationSnapshotStructureError` when a present section is malformed or
 * exceeds a documented bound (missing truncation evidence, ill-typed shape,
 * record count over the declared limit or per-section cap), or when the
 * input could produce an output beyond the findings bound — such input is
 * rejected instead of compared, so it can never yield a success verdict.
 *
 * Pure and read-only: no database, no mutation, no side effects.
 */
export function compareMigrationSnapshots(
  input: Readonly<{
    after: MigrationSnapshotDocument
    before: MigrationSnapshotDocument
  }>
): MigrationSnapshotComparison {
  requireMatchingIdentity(input.before, input.after)

  for (const family of migrationSnapshotFamilies) {
    const beforeSection = input.before.sections[family]
    const afterSection = input.after.sections[family]
    if (beforeSection) requireValidSectionShape(beforeSection, family, 'before')
    if (afterSection) requireValidSectionShape(afterSection, family, 'after')
  }
  let totalRecords = 0
  for (const family of migrationSnapshotFamilies) {
    totalRecords += input.before.sections[family]?.records.length ?? 0
    totalRecords += input.after.sections[family]?.records.length ?? 0
  }
  const outputBound =
    totalRecords * FINDINGS_PER_RECORD_BOUND + migrationSnapshotFamilies.length * 4
  if (outputBound > MIGRATION_SNAPSHOT_MAX_FINDINGS) {
    throw new MigrationSnapshotStructureError(
      `Comparison output bound of ${outputBound} findings exceeds the maximum of ${MIGRATION_SNAPSHOT_MAX_FINDINGS}; split the snapshots into smaller sections`
    )
  }

  const collector = new FindingCollector()
  const inventory: MigrationSnapshotFamilyInventory[] = []

  for (const family of migrationSnapshotFamilies) {
    const beforeSection = input.before.sections[family]
    const afterSection = input.after.sections[family]

    if (!beforeSection && !afterSection) {
      collector.add('unknown_domain', family, 'both', '*', { reason: 'section_absent' })
      inventory.push({ after: null, before: null, family })
      continue
    }
    if (!beforeSection || !afterSection) {
      const side: Side = beforeSection ? 'after' : 'before'
      collector.add('unknown_domain', family, side, '*', { reason: 'section_absent' })
      inventory.push({
        after: afterSection ? afterSection.records.length : null,
        before: beforeSection ? beforeSection.records.length : null,
        family,
      })
      continue
    }

    const beforeIntake = intakeSection(beforeSection, family, 'before', collector)
    const afterIntake = intakeSection(afterSection, family, 'after', collector)

    for (const [stableId, beforeRecord] of beforeIntake.byStableId) {
      const afterRecord = afterIntake.byStableId.get(stableId)
      if (!afterRecord) {
        collector.add('missing_record', family, 'after', stableId)
        continue
      }
      // Only a row that is its task's active attempt (highest attempt number)
      // on BOTH sides can report a conflicting attempt owner — and only when
      // no attempt row on either side was quarantined: a quarantined row may
      // be the real active attempt, so active-attempt attribution is then
      // unproven and drift falls back to remap/attribute findings.
      const activeAttemptBoth =
        beforeRecord.family === 'executionAttempts' &&
        afterRecord.family === 'executionAttempts' &&
        beforeIntake.quarantined === 0 &&
        afterIntake.quarantined === 0 &&
        beforeIntake.activeAttempts.get(beforeRecord.taskId) === beforeRecord.attempt &&
        afterIntake.activeAttempts.get(afterRecord.taskId) === afterRecord.attempt
      for (const item of compareMatchedRecords(
        family,
        beforeRecord,
        afterRecord,
        activeAttemptBoth
      )) {
        collector.add(item.findingClass, family, 'both', stableId, item.detail)
      }
    }
    for (const [stableId] of afterIntake.byStableId) {
      if (beforeIntake.byStableId.has(stableId)) continue
      if (GRANT_FAMILIES.has(family)) {
        collector.add('widened_access', family, 'after', stableId, { field: 'grant' })
        continue
      }
      collector.add('unexpected_record', family, 'after', stableId)
    }

    inventory.push({
      after: afterSection.records.length,
      before: beforeSection.records.length,
      family,
    })
  }

  const findings = [...collector.findings].toSorted((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  )

  const byClass = new Map<MigrationSnapshotFindingClass, number>()
  const byFamily = new Map<MigrationSnapshotFamily, number>()
  let determinate = 0
  let epistemic = 0
  for (const finding of findings) {
    byClass.set(finding.findingClass, (byClass.get(finding.findingClass) ?? 0) + 1)
    byFamily.set(finding.family, (byFamily.get(finding.family) ?? 0) + 1)
    if (DETERMINATE_CLASSES.has(finding.findingClass)) determinate += 1
    else epistemic += 1
  }

  const countsByClass: Partial<Record<MigrationSnapshotFindingClass, number>> = {}
  for (const findingClass of [...byClass.keys()].toSorted()) {
    countsByClass[findingClass] = byClass.get(findingClass)
  }
  const countsByFamily: Partial<Record<MigrationSnapshotFamily, number>> = {}
  for (const family of [...byFamily.keys()].toSorted()) {
    countsByFamily[family] = byFamily.get(family)
  }

  return Object.freeze({
    counts: Object.freeze({ byClass: countsByClass, byFamily: countsByFamily }),
    findings: Object.freeze(findings),
    inventory: Object.freeze(inventory),
    verdict: determinate > 0 ? 'divergent' : epistemic > 0 ? 'inconclusive' : 'identical',
  })
}
