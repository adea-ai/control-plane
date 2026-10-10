// Frozen migration-snapshot documents for migration rehearsal (M18.01, #1181).
//
// A snapshot document is a bounded, structured inventory of real product and
// runtime records captured from one deployment at one point in time: stable
// ids, history digests, audience and grant identities, conversation links,
// read frontiers and execution-attempt ownership. The comparator in
// `@adea-ai/db` consumes two frozen documents (before / after) and reports
// typed findings; it never touches a live database.
//
// The record shapes below are derived from what `packages/db/src` persists
// today (workspaces, memberships, invitations, auth identities, temporary
// sessions, projects, project members, channels, participants, messages,
// tasks, agents, content refs, durable events, read state, execution
// attempts). They deliberately carry NO message bodies, NO email addresses,
// NO tokens or token digests, NO ciphertext and NO key material — the record
// contract excludes every field a leak would need, so comparator output is
// clean by construction.
//
// Epistemics (fail-closed): a family section that is absent from a document
// makes that domain `unknown` — never zero. A scan that hit its bound is
// flagged `truncated`; a section whose truncation evidence is missing is a
// structure error, never a silent claim of completeness. A record that is
// malformed, over a documented bound, or whose audience/ownership
// classification is ambiguous, is `quarantined` and excluded from matching.
// Identifier and digest fields are format- and length-bounded, and every
// record — of any shape, primitives and top-level arrays included — is
// bounded on total bytes, property slots and array width BEFORE any
// canonicalization — including fields destined to be ignored as extra
// properties and records already headed for a quarantine path — so a hostile
// or corrupt value can never be canonicalized first, and can never travel
// into comparator findings verbatim. Inconclusive input can never yield a
// success verdict.

/**
 * Format version of the snapshot document contract. Bump it when a record
 * shape changes; the comparator refuses to compare documents that disagree.
 */
export const MIGRATION_SNAPSHOT_FORMAT_VERSION = 1

/**
 * Maximum length of any single identifier field, in characters. Identifier
 * fields longer than this are a typed limit issue, not silently accepted —
 * bounds on record fields bound both the comparator's input and its output.
 */
export const MIGRATION_SNAPSHOT_MAX_IDENTIFIER_LENGTH = 512

/**
 * Maximum number of records one family section may carry. A section beyond
 * this bound is rejected by the comparator instead of compared unbounded.
 */
export const MIGRATION_SNAPSHOT_MAX_RECORDS_PER_SECTION = 10_000

/**
 * Maximum number of findings one comparison may report. The comparator
 * rejects an input whose findings could exceed this bound, keeping the
 * output size bounded by the documented input bounds.
 */
export const MIGRATION_SNAPSHOT_MAX_FINDINGS = 100_000

/**
 * Maximum serialized size of one record, in UTF-8 bytes, counting the
 * complete JSON encoding — string quotes, object braces, array brackets,
 * commas and colons included — and every key and value the record carries,
 * including extra properties the comparator would otherwise ignore. Enforced
 * by an early-exit structural walk BEFORE any canonicalization, hashing or
 * comparison, so oversized input is quarantined by limit instead of being
 * canonicalized first. Per-code-unit costs are conservative upper bounds of
 * the UTF-8 (or JSON-escaped) size, and a `bigint` value is rejected as
 * over-bound outright because its serialization length is unbounded.
 */
export const MIGRATION_SNAPSHOT_MAX_RECORD_BYTES = 8_192

/**
 * Maximum number of property slots on one record: object entries plus array
 * element slots, at any depth, including extra properties. Enforced before
 * canonicalization; the walk aborts as soon as the bound is crossed, which
 * also bounds the walk itself.
 */
export const MIGRATION_SNAPSHOT_MAX_RECORD_PROPERTIES = 64

/**
 * Maximum length of any array nested inside one record. Enforced before the
 * array is walked, so a wide hostile array is rejected in constant time.
 */
export const MIGRATION_SNAPSHOT_MAX_ARRAY_WIDTH = 64

/**
 * Every record family a snapshot document may carry, in sorted order.
 * An omitted section means the capture could not inventory that domain —
 * it is reported as unknown, not as empty.
 */
export const migrationSnapshotFamilies = [
  'agents',
  'artifactReferenceGrants',
  'channelParticipants',
  'channels',
  'contentRefs',
  'contentReplicas',
  'events',
  'executionAttempts',
  'identityBindings',
  'invitations',
  'leadTurnRuntime',
  'memberships',
  'messages',
  'nativeSessions',
  'projectMembers',
  'projects',
  'readState',
  'runtimeNodes',
  'taskSubmissions',
  'tasks',
  'temporarySessions',
  'workspaces',
] as const

export type MigrationSnapshotFamily = (typeof migrationSnapshotFamilies)[number]

export function isMigrationSnapshotFamily(value: unknown): value is MigrationSnapshotFamily {
  return (
    typeof value === 'string' && (migrationSnapshotFamilies as readonly string[]).includes(value)
  )
}

// ─── Enumerated values mirrored from the persisted schema ───────────────────

export const migrationWorkspaceRoles = ['admin', 'member', 'owner'] as const
export type MigrationWorkspaceRole = (typeof migrationWorkspaceRoles)[number]

export const migrationInvitationRoles = ['admin', 'member'] as const
export type MigrationInvitationRole = (typeof migrationInvitationRoles)[number]

/** Mirrors the derived invitation state in `packages/db/src/workspace-invitations.ts`. */
export const migrationInvitationStates = ['accepted', 'expired', 'pending', 'revoked'] as const
export type MigrationInvitationState = (typeof migrationInvitationStates)[number]

export const migrationProjectVisibilities = ['members', 'workspace'] as const
export type MigrationProjectVisibility = (typeof migrationProjectVisibilities)[number]

export const migrationProjectMemberRoles = ['editor', 'viewer'] as const
export type MigrationProjectMemberRole = (typeof migrationProjectMemberRoles)[number]

export const migrationChannelVisibilities = ['participants', 'workspace'] as const
export type MigrationChannelVisibility = (typeof migrationChannelVisibilities)[number]

/** Channel participants are user or agent principals. */
export const migrationParticipantKinds = ['agent', 'user'] as const
export type MigrationParticipantKind = (typeof migrationParticipantKinds)[number]

/** Mirrors `TaskLifecycleState` (kept local so this module stays dependency-free). */
export const migrationTaskLifecycleStates = [
  'archived',
  'cancelled',
  'completed',
  'created',
  'in_progress',
  'in_review',
  'queued',
] as const
export type MigrationTaskLifecycleState = (typeof migrationTaskLifecycleStates)[number]

/** Mirrors `AgentLifecycleState`. */
export const migrationAgentLifecycleStates = ['active', 'archived', 'configuration_error'] as const
export type MigrationAgentLifecycleState = (typeof migrationAgentLifecycleStates)[number]

/** Mirrors `ContentRefSummary['availability']`. */
export const migrationContentAvailabilities = [
  'available',
  'deleted',
  'missing',
  'offline',
] as const
export type MigrationContentAvailability = (typeof migrationContentAvailabilities)[number]

/** Mirrors `TaskExecutionLocation`. */
export const migrationExecutionLocationKinds = [
  'agent_hq_cloud',
  'local_device',
  'remote_host',
] as const
export type MigrationExecutionLocationKind = (typeof migrationExecutionLocationKinds)[number]

// ─── Records ─────────────────────────────────────────────────────────────────
//
// One record per persisted row that a migration must preserve. `family` is the
// discriminator; every other field is an identifier, an enum value, a digest,
// a monotonic number or a boolean — never free content.

/** A workspace: its stable id, control-plane scope and owner binding. */
export type WorkspaceSnapshotRecord = Readonly<{
  archived: boolean
  controlPlaneWorkspaceId: string
  family: 'workspaces'
  ownerUserId: string
  workspaceId: string
}>

/** A workspace membership: the workspace-level grant of one user. */
export type MembershipSnapshotRecord = Readonly<{
  family: 'memberships'
  role: MigrationWorkspaceRole
  userId: string
  workspaceId: string
}>

/** An invitation's lifecycle facts; the email and token never travel. */
export type InvitationSnapshotRecord = Readonly<{
  family: 'invitations'
  invitationId: string
  invitedByUserId: string
  role: MigrationInvitationRole
  state: MigrationInvitationState
  workspaceId: string
}>

/** An auth identity binding: one external identity resolves to one user. */
export type IdentityBindingSnapshotRecord = Readonly<{
  family: 'identityBindings'
  provider: string
  subject: string
  userId: string
}>

/** A temporary user session: ownership and claim state only. */
export type TemporarySessionSnapshotRecord = Readonly<{
  claimed: boolean
  family: 'temporarySessions'
  sessionId: string
  userId: string
}>

/** A project: its workspace and who may see it. */
export type ProjectSnapshotRecord = Readonly<{
  family: 'projects'
  projectId: string
  visibility: MigrationProjectVisibility
  workspaceId: string
}>

/** A members-project grant of one user. */
export type ProjectMemberSnapshotRecord = Readonly<{
  family: 'projectMembers'
  projectId: string
  role: MigrationProjectMemberRole
  userId: string
  workspaceId: string
}>

/** A channel: its workspace and project scope, and who can see it. */
export type ChannelSnapshotRecord = Readonly<{
  channelId: string
  family: 'channels'
  projectId: string | null
  visibility: MigrationChannelVisibility
  workspaceId: string
}>

/** One participant of a channel: the audience that can read it. */
export type ChannelParticipantSnapshotRecord = Readonly<{
  channelId: string
  family: 'channelParticipants'
  principalId: string
  principalKind: MigrationParticipantKind
  workspaceId: string
}>

/** A message's link facts only: channel, thread root, deletion. No body. */
export type MessageSnapshotRecord = Readonly<{
  channelId: string
  deleted: boolean
  family: 'messages'
  messageId: string
  threadRootMessageId: string | null
  workspaceId: string
}>

/** A task: its links (project, conversation, creator) and lifecycle facts. */
export type TaskSnapshotRecord = Readonly<{
  channelId: string | null
  creatorUserId: string
  family: 'tasks'
  lifecycleState: MigrationTaskLifecycleState
  messageId: string | null
  projectId: string | null
  taskId: string
  threadRootMessageId: string | null
  version: number
  workspaceId: string
}>

/** An agent: its workspace and project binding and lifecycle state. */
export type AgentSnapshotRecord = Readonly<{
  agentId: string
  family: 'agents'
  lifecycleState: MigrationAgentLifecycleState
  projectId: string | null
  workspaceId: string
}>

/** A content ref: digest, revision, key version, availability and links. */
export type ContentRefSnapshotRecord = Readonly<{
  availability: MigrationContentAvailability
  digestSha256: string
  family: 'contentRefs'
  keyVersion: number
  messageId: string | null
  contentRefId: string
  revision: number
  taskId: string | null
  workspaceId: string
}>

/**
 * One durable event: identity, replay anchor (workspace + sequence), contract
 * version and a caller-computed payload digest. The payload itself never
 * travels — the digest is what drift detection compares.
 */
export type EventSnapshotRecord = Readonly<{
  eventId: string
  eventType: string
  family: 'events'
  payloadDigest: string
  schemaVersion: number
  workspaceId: string
  workspaceSequence: number
}>

/**
 * One read frontier: channel-level when `threadRootMessageId` is null,
 * thread-level otherwise. The frontier is the read state a rollback must not
 * regress.
 */
export type ReadStateSnapshotRecord = Readonly<{
  channelId: string
  family: 'readState'
  lastReadSequence: number
  manuallyUnread: boolean
  threadRootMessageId: string | null
  userId: string
  workspaceId: string
}>

/** One recorded execution attempt: which owner (location, node) ran it. */
export type ExecutionAttemptSnapshotRecord = Readonly<{
  attempt: number
  family: 'executionAttempts'
  /** Null exactly for the reserved `agent_hq_cloud` location. */
  locationKind: MigrationExecutionLocationKind
  runtimeNodeId: string | null
  taskId: string
  workspaceId: string
}>

/** A durable artifact-reference grant binding one exact target to one audience. */
export type ArtifactReferenceGrantSnapshotRecord = Readonly<{
  family: 'artifactReferenceGrants'
  artifactId: string
  audienceWorkspaceId: string
  checksumSha256: string
  /** The persisted expiry, verbatim; `null` means the grant does not expire. */
  expiresAt: string | null
  grantId: string
  revision: number
  revoked: boolean
  sourceWorkspaceId: string
  version: number
}>

/** A retained content replica's metadata; ciphertext and nonce never travel. */
export type ContentReplicaSnapshotRecord = Readonly<{
  family: 'contentReplicas'
  availability: string
  contentRefId: string
  deleted: boolean
  digestSha256: string
  replicaId: string
  replicaKind: string
  revision: number
  schemaVersion: number
  workspaceId: string
}>

/**
 * The durable dispatch binding for one lead turn: the mapping from an intent
 * to its execution/attempt and the canonical runtime session it owns.
 */
export type LeadTurnRuntimeSnapshotRecord = Readonly<{
  family: 'leadTurnRuntime'
  attemptId: string
  cancelRequested: boolean
  executionId: string
  intentId: string
  publishedMessageId: string | null
  runtimeSessionId: string | null
  state: string
}>

/** The canonical lifecycle values reported by the runtime's session read. */
const nativeSessionLifecycles = [
  'preparing',
  'ready',
  'active',
  'disconnected',
  'completed',
  'failed',
  'cancelled',
] as const

/**
 * One canonical runtime session as reported by the execution host's
 * `dev.session.list` read (capability `dev.session.read`). The inventory is
 * runtime-owned: this record is only ever produced by composing that
 * authoritative page through an injected source, never by a local catalogue.
 */
export type NativeSessionSnapshotRecord = Readonly<{
  family: 'nativeSessions'
  accountId: string
  activeHarnessRunId: string | null
  agentProfileId: string | null
  agentProfileVersion: number | null
  archived: boolean
  generation: number
  harnessInstallationId: string | null
  lifecycle: string
  projectId: string
  runtimeNodeId: string
  sessionRef: string
  version: number
  workspaceId: string
  worktreeId: string
}>

/**
 * A paired runtime node's product-visible identity and health facts.
 */
export type RuntimeNodeSnapshotRecord = Readonly<{
  family: 'runtimeNodes'
  kind: string
  pairingState: string
  platform: string
  revoked: boolean
  runtimeNodeId: string
  softwareVersion: string
  workspaceId: string
}>

/** A durable task submission (job dispatch) and its relay cleanup state. */
export type TaskSubmissionSnapshotRecord = Readonly<{
  family: 'taskSubmissions'
  agentId: string
  ciphertextPurged: boolean
  locationKind: string
  profileId: string
  profileRevision: number
  profileVersion: string
  runtimeNodeId: string
  state: string
  submissionId: string
  taskId: string
  taskVersion: number
  workspaceId: string
}>

/** A frozen record of one family. */
export type MigrationSnapshotRecord =
  | AgentSnapshotRecord
  | ArtifactReferenceGrantSnapshotRecord
  | ChannelParticipantSnapshotRecord
  | ChannelSnapshotRecord
  | ContentRefSnapshotRecord
  | ContentReplicaSnapshotRecord
  | EventSnapshotRecord
  | ExecutionAttemptSnapshotRecord
  | IdentityBindingSnapshotRecord
  | InvitationSnapshotRecord
  | LeadTurnRuntimeSnapshotRecord
  | MembershipSnapshotRecord
  | MessageSnapshotRecord
  | NativeSessionSnapshotRecord
  | ProjectMemberSnapshotRecord
  | ProjectSnapshotRecord
  | ReadStateSnapshotRecord
  | RuntimeNodeSnapshotRecord
  | TaskSubmissionSnapshotRecord
  | TaskSnapshotRecord
  | TemporarySessionSnapshotRecord
  | WorkspaceSnapshotRecord

/** The record type a given family section holds. */
export type MigrationSnapshotRecordFor<F extends MigrationSnapshotFamily> = Extract<
  MigrationSnapshotRecord,
  { family: F }
>

// ─── Documents ───────────────────────────────────────────────────────────────

/**
 * Snapshot identity. `snapshotId` names this one capture; `rehearsalId`,
 * `formatVersion` and `source` must agree across the before/after pair —
 * a mismatch is a typed error, never a diff.
 */
export type MigrationSnapshotIdentity = Readonly<{
  formatVersion: number
  rehearsalId: string
  snapshotId: string
  source: string
}>

/**
 * One bounded family section. `records` may be empty — an empty array is a
 * proven fact ("this domain holds no records"), which is different from a
 * section that is absent (unknown). `truncated` must be true when the capture
 * stopped at `limit` before exhausting the domain.
 */
export type MigrationSnapshotSection<F extends MigrationSnapshotFamily = MigrationSnapshotFamily> =
  Readonly<{
    limit?: number
    records: readonly MigrationSnapshotRecordFor<F>[]
    truncated: boolean
  }>

/** The bounded inventory of one capture; absent sections are unknown domains. */
export type MigrationSnapshotSections = {
  readonly [F in MigrationSnapshotFamily]?: MigrationSnapshotSection<F>
}

/** A frozen snapshot document: identity plus bounded sections. */
export type MigrationSnapshotDocument = Readonly<{
  identity: MigrationSnapshotIdentity
  sections: MigrationSnapshotSections
}>

// ─── Findings and verdicts ───────────────────────────────────────────────────

/**
 * Every determinate violation class the comparator reports, followed by the
 * epistemic classes: input that cannot be compared never silently reads as
 * success.
 *
 * Determinate:
 * - `missing_record` — present before, absent after.
 * - `unexpected_record` — present after, absent before (non-grant families;
 *   a new grant row is `widened_access` instead).
 * - `duplicated_record` — the same stable id twice within one section.
 * - `remapped_record` — same stable id, changed identity binding.
 * - `digest_drift` — content digest, revision, key version or event payload
 *   digest changed for the same record.
 * - `widened_access` — a grant, audience or visibility grew.
 * - `lost_read_state` — a read frontier regressed.
 * - `conflicting_attempt_owner` — a task's active execution attempt is bound
 *   to a different owner after the migration.
 * - `changed_attribute` — any other determinate drift on a matched record.
 *
 * Epistemic:
 * - `unknown_domain` — a family section is absent; that domain is not proven.
 * - `quarantined_record` — a malformed or ambiguous record was excluded.
 * - `truncated_input` — a bounded section reports an incomplete scan.
 */
export const migrationSnapshotFindingClasses = [
  'changed_attribute',
  'conflicting_attempt_owner',
  'digest_drift',
  'duplicated_record',
  'lost_read_state',
  'missing_record',
  'quarantined_record',
  'remapped_record',
  'truncated_input',
  'unexpected_record',
  'unknown_domain',
  'widened_access',
] as const

export type MigrationSnapshotFindingClass = (typeof migrationSnapshotFindingClasses)[number]

/** Which snapshot a finding is about. */
export type MigrationSnapshotFindingSide = 'after' | 'before' | 'both'

/**
 * The only keys a finding's `detail` may carry. Values are identifiers, enum
 * values or counts the comparator itself derived — never echoed record
 * content, so a hostile extra property on an input record cannot surface.
 */
export const migrationSnapshotFindingDetailKeys = [
  'after',
  'before',
  'count',
  'field',
  'reason',
] as const

export type MigrationSnapshotFindingDetailKey = (typeof migrationSnapshotFindingDetailKeys)[number]

/** One typed finding: a stable, sanitizable, deterministically ordered fact. */
export type MigrationSnapshotFinding = Readonly<{
  detail: Readonly<Partial<Record<MigrationSnapshotFindingDetailKey, string>>>
  family: MigrationSnapshotFamily
  findingClass: MigrationSnapshotFindingClass
  /**
   * Deterministic: `<class>:<family>:<side>:<tuple(stableId, field)>`, where
   * `tuple` is the comparator's collision-safe composite-key encoding (parts
   * are escaped and joined; an absent field is a typed marker), so two
   * distinct `(stableId, field)` pairs can never join to the same id.
   */
  id: string
  side: MigrationSnapshotFindingSide
  stableId: string
}>

/**
 * - `identical` — zero findings: every known domain compared clean.
 * - `divergent` — at least one determinate violation.
 * - `inconclusive` — no determinate violation, but at least one unknown
 *   domain, quarantined record or truncated scan. Equality was not proven;
 *   inconclusive is never reported as success.
 */
export type MigrationSnapshotVerdict = 'divergent' | 'identical' | 'inconclusive'

/** Raw per-family record counts; `null` means the section was absent (unknown). */
export type MigrationSnapshotFamilyInventory = Readonly<{
  after: number | null
  before: number | null
  family: MigrationSnapshotFamily
}>

/** The complete, deterministic result of one comparison. */
export type MigrationSnapshotComparison = Readonly<{
  counts: Readonly<{
    byClass: Readonly<Partial<Record<MigrationSnapshotFindingClass, number>>>
    byFamily: Readonly<Partial<Record<MigrationSnapshotFamily, number>>>
  }>
  findings: readonly MigrationSnapshotFinding[]
  inventory: readonly MigrationSnapshotFamilyInventory[]
  verdict: MigrationSnapshotVerdict
}>

// ─── Record validation ───────────────────────────────────────────────────────

/**
 * Why a record was quarantined. `malformed`: a required field is missing or
 * of the wrong shape. `ambiguous`: the record is shaped but its audience or
 * ownership classification is not one of the known values, so the comparator
 * refuses to guess which side of an access comparison it belongs to.
 * `limit`: the record is well-formed enough to compare but exceeds a
 * documented bound — an identifier over its length bound, a record over the
 * byte, property-slot or array-width bounds, or text carrying surrounding
 * whitespace — so accepting it would break the comparator's bounded input
 * and output guarantees. Size bounds are decided before canonicalization,
 * and the issue names a contract field (or `record`), never supplied text.
 */
export type MigrationSnapshotRecordIssue =
  | Readonly<{ field: string; kind: 'ambiguous' }>
  | Readonly<{ field: string; kind: 'limit' }>
  | Readonly<{ field: string; kind: 'malformed' }>

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isInList<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value)
}

type FieldCheck = Readonly<{ field: string; ok: boolean; kind?: 'ambiguous' | 'limit' }>

function check(field: string, ok: boolean): FieldCheck {
  return { field, ok }
}

/**
 * An enumerated audience/ownership field: absent is malformed (the record is
 * incomplete), present but not a known value is ambiguous (the record is
 * whole, but the comparator refuses to guess its classification).
 */
function enumField(field: string, value: unknown, values: readonly string[]): FieldCheck {
  if (value === undefined) return check(field, false)
  return { field, kind: 'ambiguous', ok: isInList(value, values) }
}

/**
 * An identifier field: absent or wrongly typed is malformed; present but
 * over `MIGRATION_SNAPSHOT_MAX_IDENTIFIER_LENGTH` or carrying surrounding
 * whitespace is a typed limit issue.
 */
function identifierField(field: string, value: unknown): FieldCheck {
  if (value === undefined) return check(field, false)
  if (typeof value !== 'string' || value.length === 0) return check(field, false)
  if (value.length > MIGRATION_SNAPSHOT_MAX_IDENTIFIER_LENGTH || value.trim() !== value) {
    return { field, kind: 'limit', ok: false }
  }
  return check(field, true)
}

function nullableIdentifierField(field: string, value: unknown): FieldCheck {
  if (value === null) return check(field, true)
  return identifierField(field, value)
}

/**
 * Serialized JSON byte length of `text` WITHOUT its surrounding quotes,
 * capped: returns a value greater than `remaining` as soon as the remaining
 * budget is exceeded, so oversized text is detected without scanning the
 * rest. Per-code-unit costs are conservative upper bounds of the serialized
 * form: ASCII control characters cost their longest escape (`\u00XX`, 6),
 * the quote and backslash cost their two-byte escape, plain ASCII costs 1,
 * and each non-ASCII code unit costs 6 — enough for its `\uXXXX` escape (a
 * surrogate pair therefore costs 12) and for raw UTF-8, which never exceeds
 * 4 bytes per code unit.
 */
function utf8LengthCapped(text: string, remaining: number): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const codeUnit = text.charCodeAt(index)
    bytes += codeUnit < 0x20 || codeUnit > 0x7e ? 6 : codeUnit === 0x22 || codeUnit === 0x5c ? 2 : 1
    if (bytes > remaining) return bytes
  }
  return bytes
}

/**
 * Mutable measurement budget for the shape walk: both counters only ever
 * decrease, and every descent consumes at least one property slot, so the
 * walk itself is bounded by `MIGRATION_SNAPSHOT_MAX_RECORD_PROPERTIES` steps
 * and can never recurse unboundedly.
 */
type ShapeBudget = { bytes: number; properties: number }

type ShapeViolation = 'array_width' | 'bytes' | 'properties'

/**
 * Early-exit structural walk over a record's own properties — including the
 * extra properties comparison would ignore. Returns the first bound crossed,
 * or null when the record fits every documented size bound. Nothing is
 * canonicalized, hashed or copied: the byte budget is charged with the
 * COMPLETE serialized form, so the bound covers the JSON encoding itself and
 * not just its content — string quotes (2 per string, values and object
 * keys alike), the colon after each key, object braces and array brackets
 * (2 per container), and the comma between consecutive members or items.
 * Fixed-cost leaves use conservative bounds of their serialization: numbers
 * cost 24 (`-1.7976931348623157e+308`), booleans 5, and `null`/`undefined`/
 * functions/symbols 12 (`"~undefined"` is the longest encoding); `bigint` is
 * rejected outright (its serialization length is unbounded). Every charge is
 * checked before descending and text measurement stops once the budget is
 * exceeded, so a crossing is detected without scanning the remainder.
 */
function recordShapeViolation(value: unknown, budget: ShapeBudget): ShapeViolation | null {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      budget.bytes -= 2
      if (budget.bytes < 0) return 'bytes'
      budget.bytes -= utf8LengthCapped(value, budget.bytes)
      return budget.bytes < 0 ? 'bytes' : null
    }
    if (typeof value === 'bigint') return 'bytes'
    budget.bytes -= typeof value === 'number' ? 24 : typeof value === 'boolean' ? 5 : 12
    return budget.bytes < 0 ? 'bytes' : null
  }
  if (Array.isArray(value)) {
    if (value.length > MIGRATION_SNAPSHOT_MAX_ARRAY_WIDTH) return 'array_width'
    budget.bytes -= 2
    if (budget.bytes < 0) return 'bytes'
    let first = true
    for (const item of value) {
      if (first) first = false
      else {
        budget.bytes -= 1
        if (budget.bytes < 0) return 'bytes'
      }
      budget.properties -= 1
      if (budget.properties < 0) return 'properties'
      const violation = recordShapeViolation(item, budget)
      if (violation) return violation
    }
    return null
  }
  budget.bytes -= 2
  if (budget.bytes < 0) return 'bytes'
  let first = true
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    if (first) first = false
    else {
      budget.bytes -= 1
      if (budget.bytes < 0) return 'bytes'
    }
    budget.properties -= 1
    if (budget.properties < 0) return 'properties'
    budget.bytes -= 1
    if (budget.bytes < 0) return 'bytes'
    budget.bytes -= 2
    if (budget.bytes < 0) return 'bytes'
    budget.bytes -= utf8LengthCapped(key, budget.bytes)
    if (budget.bytes < 0) return 'bytes'
    const violation = recordShapeViolation((value as Record<string, unknown>)[key], budget)
    if (violation) return violation
  }
  return null
}

/**
 * Check any intake value — of any shape — against the documented size bounds
 * — total serialized JSON bytes (structure included: quotes, delimiters,
 * separators), property slots and array width — BEFORE any canonicalization.
 * The walk measures non-object input directly: a string by its quotes plus
 * capped content length, a `bigint` over-bound outright (its serialization
 * length is unbounded), and other primitives or null by fixed upper bounds;
 * a top-level array is width-, slot- and byte-bounded like any nested one.
 * Returns a typed `limit` issue on the first bound crossed, or null when the
 * value fits. The issue never names or echoes supplied content: the field is
 * the contract literal `record`. Accepts `unknown` because real snapshot
 * intake is untrusted — no value may bypass the bounds by not being an
 * object. Exported so consumers can quarantine an oversized value without
 * canonicalizing it (bounded descriptor instead of a content fingerprint).
 */
export function migrationSnapshotRecordShapeIssue(
  record: unknown
): MigrationSnapshotRecordIssue | null {
  const violation = recordShapeViolation(record, {
    bytes: MIGRATION_SNAPSHOT_MAX_RECORD_BYTES,
    properties: MIGRATION_SNAPSHOT_MAX_RECORD_PROPERTIES,
  })
  return violation ? { field: 'record', kind: 'limit' } : null
}

function firstIssue(checks: readonly FieldCheck[]): MigrationSnapshotRecordIssue | null {
  for (const item of checks) {
    if (!item.ok) return { field: item.field, kind: item.kind ?? 'malformed' }
  }
  return null
}

/**
 * Validate one record against the snapshot contract. Returns the first issue
 * found, or null when the record is well-formed and unambiguous. Size bounds
 * (record bytes, property slots, array width — extra properties included)
 * are decided first, before canonicalization; the issue names the offending
 * field and never echoes the offending value. A null or non-object input is
 * a structural rejection on the `record` field itself, never a runtime error.
 */
export function migrationSnapshotRecordIssue(
  record: MigrationSnapshotRecord
): MigrationSnapshotRecordIssue | null {
  if (typeof record !== 'object' || record === null) {
    return { field: 'record', kind: 'malformed' }
  }
  const shapeIssue = migrationSnapshotRecordShapeIssue(record)
  if (shapeIssue) return shapeIssue
  if (!isMigrationSnapshotFamily(record.family)) return { field: 'family', kind: 'malformed' }

  switch (record.family) {
    case 'agents':
      return firstIssue([
        identifierField('agentId', record.agentId),
        identifierField('workspaceId', record.workspaceId),
        nullableIdentifierField('projectId', record.projectId),
        enumField('lifecycleState', record.lifecycleState, migrationAgentLifecycleStates),
      ])
    case 'channelParticipants':
      return firstIssue([
        identifierField('channelId', record.channelId),
        identifierField('workspaceId', record.workspaceId),
        identifierField('principalId', record.principalId),
        enumField('principalKind', record.principalKind, migrationParticipantKinds),
      ])
    case 'channels':
      return firstIssue([
        identifierField('channelId', record.channelId),
        identifierField('workspaceId', record.workspaceId),
        nullableIdentifierField('projectId', record.projectId),
        enumField('visibility', record.visibility, migrationChannelVisibilities),
      ])
    case 'contentRefs':
      return firstIssue([
        identifierField('contentRefId', record.contentRefId),
        identifierField('workspaceId', record.workspaceId),
        check('digestSha256', isDigest(record.digestSha256)),
        check('revision', isNonNegativeSafeInteger(record.revision)),
        check('keyVersion', isNonNegativeSafeInteger(record.keyVersion)),
        nullableIdentifierField('messageId', record.messageId),
        nullableIdentifierField('taskId', record.taskId),
        enumField('availability', record.availability, migrationContentAvailabilities),
      ])
    case 'events':
      return firstIssue([
        identifierField('eventId', record.eventId),
        identifierField('workspaceId', record.workspaceId),
        check('workspaceSequence', isNonNegativeSafeInteger(record.workspaceSequence)),
        identifierField('eventType', record.eventType),
        check('schemaVersion', isNonNegativeSafeInteger(record.schemaVersion)),
        check('payloadDigest', isDigest(record.payloadDigest)),
      ])
    case 'executionAttempts': {
      const base = firstIssue([
        identifierField('taskId', record.taskId),
        identifierField('workspaceId', record.workspaceId),
        check('attempt', isNonNegativeSafeInteger(record.attempt) && record.attempt > 0),
        enumField('locationKind', record.locationKind, migrationExecutionLocationKinds),
        nullableIdentifierField('runtimeNodeId', record.runtimeNodeId),
      ])
      if (base) return base
      // Ownership is ambiguous when the location and node contradict each
      // other: the reserved cloud location owns no node, every other
      // location is owned by exactly one.
      const paired =
        record.locationKind === 'agent_hq_cloud'
          ? record.runtimeNodeId === null
          : record.runtimeNodeId !== null
      return paired ? null : { field: 'runtimeNodeId', kind: 'ambiguous' }
    }
    case 'identityBindings':
      return firstIssue([
        identifierField('provider', record.provider),
        identifierField('subject', record.subject),
        identifierField('userId', record.userId),
      ])
    case 'invitations':
      return firstIssue([
        identifierField('invitationId', record.invitationId),
        identifierField('workspaceId', record.workspaceId),
        identifierField('invitedByUserId', record.invitedByUserId),
        enumField('role', record.role, migrationInvitationRoles),
        enumField('state', record.state, migrationInvitationStates),
      ])
    case 'memberships':
      return firstIssue([
        identifierField('workspaceId', record.workspaceId),
        identifierField('userId', record.userId),
        enumField('role', record.role, migrationWorkspaceRoles),
      ])
    case 'messages':
      return firstIssue([
        identifierField('messageId', record.messageId),
        identifierField('workspaceId', record.workspaceId),
        identifierField('channelId', record.channelId),
        nullableIdentifierField('threadRootMessageId', record.threadRootMessageId),
        check('deleted', isBoolean(record.deleted)),
      ])
    case 'projectMembers':
      return firstIssue([
        identifierField('projectId', record.projectId),
        identifierField('workspaceId', record.workspaceId),
        identifierField('userId', record.userId),
        enumField('role', record.role, migrationProjectMemberRoles),
      ])
    case 'projects':
      return firstIssue([
        identifierField('projectId', record.projectId),
        identifierField('workspaceId', record.workspaceId),
        enumField('visibility', record.visibility, migrationProjectVisibilities),
      ])
    case 'readState':
      return firstIssue([
        identifierField('workspaceId', record.workspaceId),
        identifierField('userId', record.userId),
        identifierField('channelId', record.channelId),
        nullableIdentifierField('threadRootMessageId', record.threadRootMessageId),
        check('lastReadSequence', isNonNegativeSafeInteger(record.lastReadSequence)),
        check('manuallyUnread', isBoolean(record.manuallyUnread)),
      ])
    case 'tasks':
      return firstIssue([
        identifierField('taskId', record.taskId),
        identifierField('workspaceId', record.workspaceId),
        nullableIdentifierField('projectId', record.projectId),
        nullableIdentifierField('channelId', record.channelId),
        nullableIdentifierField('messageId', record.messageId),
        nullableIdentifierField('threadRootMessageId', record.threadRootMessageId),
        identifierField('creatorUserId', record.creatorUserId),
        enumField('lifecycleState', record.lifecycleState, migrationTaskLifecycleStates),
        check('version', isNonNegativeSafeInteger(record.version) && record.version > 0),
      ])
    case 'temporarySessions':
      return firstIssue([
        identifierField('sessionId', record.sessionId),
        identifierField('userId', record.userId),
        check('claimed', isBoolean(record.claimed)),
      ])
    case 'workspaces':
      return firstIssue([
        identifierField('workspaceId', record.workspaceId),
        identifierField('controlPlaneWorkspaceId', record.controlPlaneWorkspaceId),
        identifierField('ownerUserId', record.ownerUserId),
        check('archived', isBoolean(record.archived)),
      ])
    case 'artifactReferenceGrants':
      return firstIssue([
        identifierField('grantId', record.grantId),
        identifierField('sourceWorkspaceId', record.sourceWorkspaceId),
        identifierField('audienceWorkspaceId', record.audienceWorkspaceId),
        identifierField('artifactId', record.artifactId),
        check('checksumSha256', isDigest(record.checksumSha256)),
        check(
          'expiresAt',
          record.expiresAt === null ||
            (typeof record.expiresAt === 'string' &&
              record.expiresAt.length > 0 &&
              Number.isFinite(Date.parse(record.expiresAt)))
        ),
        check('version', isNonNegativeSafeInteger(record.version) && record.version > 0),
        check('revision', isNonNegativeSafeInteger(record.revision) && record.revision > 0),
        check('revoked', isBoolean(record.revoked)),
      ])
    case 'contentReplicas':
      return firstIssue([
        identifierField('replicaId', record.replicaId),
        identifierField('workspaceId', record.workspaceId),
        identifierField('contentRefId', record.contentRefId),
        check(
          'replicaKind',
          typeof record.replicaKind === 'string' && record.replicaKind.length > 0
        ),
        check(
          'availability',
          typeof record.availability === 'string' && record.availability.length > 0
        ),
        check('digestSha256', isDigest(record.digestSha256)),
        check('revision', isNonNegativeSafeInteger(record.revision)),
        check('schemaVersion', isNonNegativeSafeInteger(record.schemaVersion)),
        check('deleted', isBoolean(record.deleted)),
      ])
    case 'leadTurnRuntime':
      return firstIssue([
        identifierField('intentId', record.intentId),
        identifierField('executionId', record.executionId),
        identifierField('attemptId', record.attemptId),
        check('state', typeof record.state === 'string' && record.state.length > 0),
        nullableIdentifierField('runtimeSessionId', record.runtimeSessionId),
        nullableIdentifierField('publishedMessageId', record.publishedMessageId),
        check('cancelRequested', isBoolean(record.cancelRequested)),
      ])
    case 'nativeSessions':
      return firstIssue([
        identifierField('sessionRef', record.sessionRef),
        identifierField('accountId', record.accountId),
        identifierField('workspaceId', record.workspaceId),
        identifierField('runtimeNodeId', record.runtimeNodeId),
        identifierField('projectId', record.projectId),
        identifierField('worktreeId', record.worktreeId),
        enumField('lifecycle', record.lifecycle, nativeSessionLifecycles),
        check('archived', isBoolean(record.archived)),
        check('generation', isNonNegativeSafeInteger(record.generation)),
        check('version', isNonNegativeSafeInteger(record.version)),
        nullableIdentifierField('agentProfileId', record.agentProfileId),
        check(
          'agentProfileVersion',
          record.agentProfileVersion === null ||
            isNonNegativeSafeInteger(record.agentProfileVersion)
        ),
        nullableIdentifierField('harnessInstallationId', record.harnessInstallationId),
        nullableIdentifierField('activeHarnessRunId', record.activeHarnessRunId),
      ])
    case 'runtimeNodes':
      return firstIssue([
        identifierField('runtimeNodeId', record.runtimeNodeId),
        identifierField('workspaceId', record.workspaceId),
        check('kind', typeof record.kind === 'string' && record.kind.length > 0),
        check(
          'pairingState',
          typeof record.pairingState === 'string' && record.pairingState.length > 0
        ),
        check('platform', typeof record.platform === 'string' && record.platform.length > 0),
        check(
          'softwareVersion',
          typeof record.softwareVersion === 'string' && record.softwareVersion.length > 0
        ),
        check('revoked', isBoolean(record.revoked)),
      ])
    case 'taskSubmissions':
      return firstIssue([
        identifierField('submissionId', record.submissionId),
        identifierField('workspaceId', record.workspaceId),
        identifierField('taskId', record.taskId),
        identifierField('agentId', record.agentId),
        identifierField('runtimeNodeId', record.runtimeNodeId),
        check('state', typeof record.state === 'string' && record.state.length > 0),
        check(
          'locationKind',
          typeof record.locationKind === 'string' && record.locationKind.length > 0
        ),
        check('profileId', typeof record.profileId === 'string' && record.profileId.length > 0),
        check(
          'profileVersion',
          typeof record.profileVersion === 'string' && record.profileVersion.length > 0
        ),
        check('profileRevision', isNonNegativeSafeInteger(record.profileRevision)),
        check('taskVersion', isNonNegativeSafeInteger(record.taskVersion)),
        check('ciphertextPurged', isBoolean(record.ciphertextPurged)),
      ])
  }
}
