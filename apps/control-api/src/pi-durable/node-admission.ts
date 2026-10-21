import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  ServicePrincipalSchema,
  type ServicePrincipal,
  executionScopeOf,
  executionScopesEqual,
  executionScopeFields,
  validateExecutionScopeFields,
} from '@control-plane/contracts'
import {
  CommandInboxService,
  ExecutionLifecycleService,
  ExecutionSchema,
  ExecutionAttemptSchema,
  ExecutionPlanPinSchema,
  type CommandAcceptanceRepository,
  type ExecutionPlanAcceptanceValidator,
  type ExecutionRepository,
  type Execution,
} from '@control-plane/domain'
import {
  assertExecutionPlanIntegrity,
  currentExecutionScopeAllows,
  type CurrentExecutionScopeAuthority,
  type ExecutionPlan,
} from '@control-plane/execution-plan'
import {
  RuntimeAttemptBudgetAuthoritySchema,
  RuntimeStartRequestSchema,
  type RuntimeAttemptBudgetAuthority,
  type RuntimeAdapter,
  type RuntimeStartRequest,
} from '@control-plane/runtime-sdk'
import {
  CanonicalPiDurableAuthority,
  ProviderSelectionReferenceSchema,
  canonicalAdmissionDigest,
  type CanonicalLeadIntent,
  type CanonicalLeadIntentReader,
  type CanonicalPiDurableAdmission,
  type PiDurableAdmission,
} from '@control-plane/pi-durable-adapter'
import {
  asModelNotReady,
  PiDurableLeadError,
  type PiDurableLeadAdmission,
  type PiDurableLeadAuthority,
  type PiDurableLeadFencedResult,
} from './pi-durable-lead.service.js'
import {
  fencedOperationPolicy,
  parseLeadProductFence,
  type LeadFenceVariant,
  type LeadIntentFenceFacts,
  type LeadIntentFenceFactsV2,
  type LeadOperation,
} from '../models/lead-product-fence.js'

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Ref = z.string().min(1).max(256)
export const VerifiedPiLeadIntentEvidenceSchema = z
  .object({
    schemaVersion: z.literal('pi-lead-intent/v1'),
    intentId: z.uuid(),
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId.nullable().optional(),
    messageRef: Ref,
    authorityRevision: z.number().int().positive(),
    principalRef: Ref,
    canonicalActorPrincipalId: Ref.optional(),
    scopeRef: Ref,
    expiresAt: z.iso.datetime(),
    allowedPrincipalIds: z
      .array(ServicePrincipalSchema.shape.principalId)
      .min(1)
      .max(64)
      .refine((values) => new Set(values).size === values.length),
    ...ProviderSelectionReferenceSchema.shape,
    prompt: z.string().min(1).max(1_000_000),
    profileVersionId: IdentifierSchemas.profileVersionId,
    profileContentDigest: Digest,
  })
  .strict()
export type VerifiedPiLeadIntentEvidence = z.output<typeof VerifiedPiLeadIntentEvidenceSchema>
/** Why product authority is read. Only `inference` (prepare, dispatch and an absent context, the
 * conservative default) starts or funds inference; `observe` is status, progress, children, lookup and cancel. */
export interface PiLeadProductReadContext {
  readonly purpose: 'inference' | 'observe'
}
type LeadOperationName = 'prepare' | 'dispatch' | 'status' | 'progress' | 'cancel' | 'children'
function productPurpose(operation: LeadOperationName | undefined): 'inference' | 'observe' {
  return operation === 'status' ||
    operation === 'progress' ||
    operation === 'cancel' ||
    operation === 'children'
    ? 'observe'
    : 'inference'
}
export interface PiLeadProductAuthorityPort {
  /** Signed, bounded product authority; checks current workspace/message/channel lead/audience.
   * An implementation that gates on model readiness MUST do so only for the `inference` purpose:
   * observing or cancelling stays available when a model becomes not ready.
   */
  readCurrent(
    input: {
      schemaVersion: 'pi-lead-intent/v1'
      intentId: string
      workspaceId: string
      principalId: string
    },
    context?: PiLeadProductReadContext
  ): Promise<VerifiedPiLeadIntentEvidence | LeadIntentFenceFacts | undefined>
}
export interface PiLeadIntentIds {
  readonly executionId: z.output<typeof IdentifierSchemas.executionId>
  readonly attemptId: z.output<typeof IdentifierSchemas.attemptId>
  readonly commandId: z.output<typeof IdentifierSchemas.commandId>
  readonly requestId: z.output<typeof IdentifierSchemas.requestId>
}
export function deterministicPiLeadIntentIds(
  workspaceId: string,
  intentId: string
): PiLeadIntentIds {
  IdentifierSchemas.workspaceId.parse(workspaceId)
  z.uuid().parse(intentId)
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let value = BigInt(`0x${hash([workspaceId, intentId]).slice(7, 39)}`)
  let suffix = ''
  for (let index = 0; index < 26; index++) {
    suffix = alphabet[Number(value & 31n)] + suffix
    value >>= 5n
  }
  return {
    executionId: IdentifierSchemas.executionId.parse(`exe_${suffix}`),
    attemptId: IdentifierSchemas.attemptId.parse(`att_${suffix}`),
    commandId: IdentifierSchemas.commandId.parse(`cmd_${suffix}`),
    requestId: IdentifierSchemas.requestId.parse(`req_${suffix}`),
  }
}
interface LeadIntentMarker {
  readonly intentId: string
  readonly workspaceId: string
  readonly actorPrincipalId: string
  readonly evidenceDigest: string
  readonly planPin: z.output<typeof ExecutionPlanPinSchema>
  readonly intent: CanonicalLeadIntent
  readonly receivedAt: string
  readonly preparationDeadlineAt?: string
  readonly state: 'pending' | 'ready' | 'releasing' | 'released'
}
const RetainedLeadIntentSchema = VerifiedPiLeadIntentEvidenceSchema.omit({
  schemaVersion: true,
  prompt: true,
  profileVersionId: true,
  profileContentDigest: true,
  projectId: true,
})
  .extend({
    ...executionScopeFields,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
  })
  .superRefine(validateExecutionScopeFields)
  .superRefine((intent, context) => {
    if (intent.executionScope !== undefined && !intent.canonicalActorPrincipalId)
      context.addIssue({ code: 'custom', message: 'Explicit scope requires canonical actor' })
  })
const LeadIntentMarkerSchema = z
  .object({
    intentId: z.uuid(),
    workspaceId: IdentifierSchemas.workspaceId,
    actorPrincipalId: ServicePrincipalSchema.shape.principalId,
    evidenceDigest: Digest,
    planPin: ExecutionPlanPinSchema,
    intent: RetainedLeadIntentSchema,
    receivedAt: z.iso.datetime(),
    preparationDeadlineAt: z.iso.datetime().optional(),
    state: z.enum(['pending', 'ready', 'releasing', 'released']),
  })
  .strict()
function validatedMarker(input: unknown): LeadIntentMarker {
  const result = LeadIntentMarkerSchema.safeParse(input)
  if (!result.success) conflict()
  const marker = result.data
  const ids = deterministicPiLeadIntentIds(marker.workspaceId, marker.intentId)
  if (
    marker.intent.intentId !== marker.intentId ||
    marker.intent.workspaceId !== marker.workspaceId ||
    marker.intent.executionId !== ids.executionId ||
    marker.intent.attemptId !== ids.attemptId ||
    (marker.planPin.schemaVersion === 2) !== (marker.intent.executionScope !== undefined) ||
    Date.parse(marker.receivedAt) >= Date.parse(marker.intent.expiresAt) ||
    (marker.preparationDeadlineAt !== undefined &&
      (Date.parse(marker.preparationDeadlineAt) < Date.parse(marker.receivedAt) ||
        Date.parse(marker.preparationDeadlineAt) > Date.parse(marker.receivedAt) + 300_000 ||
        Date.parse(marker.preparationDeadlineAt) > Date.parse(marker.intent.expiresAt)))
  )
    conflict()
  const { preparationDeadlineAt, ...required } = marker
  return {
    ...required,
    ...(preparationDeadlineAt !== undefined ? { preparationDeadlineAt } : {}),
  }
}

/**
 * Write-once record of the admission an ordinary, successfully authorized canonical admission
 * produced for one marker: the exact projected admissionDigest, the canonical startRequest hash
 * and the projected deadline, bound to marker, execution, attempt, plan pin, authority revision,
 * scope and audience. `bindingDigest` self-digests the record so raw edits are refused on read.
 */
const AdmissionBindingRecordSchema = z
  .object({
    schemaVersion: z.literal('pi-lead-admission-binding/v1'),
    intentId: z.uuid(),
    workspaceId: IdentifierSchemas.workspaceId,
    evidenceDigest: Digest,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    planPin: ExecutionPlanPinSchema,
    authorityRevision: z.number().int().positive(),
    scopeRef: Ref,
    allowedPrincipalIds: z.array(ServicePrincipalSchema.shape.principalId).min(1).max(64),
    admissionDigest: Digest,
    startDigest: Digest,
    deadlineAt: z.iso.datetime(),
    bindingDigest: Digest,
  })
  .strict()
export type LeadAdmissionBinding = z.output<typeof AdmissionBindingRecordSchema>

function validatedAdmissionBinding(input: unknown): LeadAdmissionBinding {
  const result = AdmissionBindingRecordSchema.safeParse(input)
  if (!result.success) conflict()
  const { bindingDigest, ...record } = result.data
  const audience = record.allowedPrincipalIds
  if (
    bindingDigest !== hash(record) ||
    hash(audience) !== hash(audience.toSorted()) ||
    new Set(audience).size !== audience.length
  )
    conflict()
  return result.data
}

/** Builds the binding from the admission this call just authorized; refuses any mismatch. */
function admissionBindingFor(
  marker: LeadIntentMarker,
  admission: PiDurableLeadAdmission
): LeadAdmissionBinding {
  const audience = [...marker.intent.allowedPrincipalIds].toSorted()
  if (
    admission.intentId !== marker.intentId ||
    admission.workspaceId !== marker.workspaceId ||
    admission.admittedAttempt.executionId !== marker.intent.executionId ||
    admission.admittedAttempt.attemptId !== marker.intent.attemptId ||
    hash([...admission.allowedPrincipalIds].toSorted()) !== hash(audience)
  )
    conflict()
  const record = {
    schemaVersion: 'pi-lead-admission-binding/v1' as const,
    intentId: marker.intentId,
    workspaceId: marker.workspaceId,
    evidenceDigest: marker.evidenceDigest,
    executionId: marker.intent.executionId,
    attemptId: marker.intent.attemptId,
    planPin: marker.planPin,
    authorityRevision: marker.intent.authorityRevision,
    scopeRef: marker.intent.scopeRef,
    allowedPrincipalIds: audience,
    admissionDigest: admission.admissionDigest,
    startDigest: hash(admission.startRequest),
    deadlineAt: admission.deadlineAt,
  }
  return validatedAdmissionBinding({ ...record, bindingDigest: hash(record) })
}

function admissionBindingMatchesMarker(
  binding: LeadAdmissionBinding,
  marker: LeadIntentMarker
): boolean {
  return (
    binding.intentId === marker.intentId &&
    binding.workspaceId === marker.workspaceId &&
    binding.evidenceDigest === marker.evidenceDigest &&
    binding.executionId === marker.intent.executionId &&
    binding.attemptId === marker.intent.attemptId &&
    hash(binding.planPin) === hash(marker.planPin) &&
    binding.authorityRevision === marker.intent.authorityRevision &&
    binding.scopeRef === marker.intent.scopeRef &&
    hash(binding.allowedPrincipalIds) === hash([...marker.intent.allowedPrincipalIds].toSorted())
  )
}

/** Immutable intent/plan marker precedes acceptance; only completion state may advance. */
export class SqlitePiDurableLeadIntentStore implements CanonicalLeadIntentReader {
  #preparationCursor = ''
  constructor(readonly database: DatabaseSync) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS pi_lead_intent_admissions (intent_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL, execution_id TEXT); CREATE TABLE IF NOT EXISTS pi_lead_intent_budgets (intent_id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pi_lead_intent_admission_bindings (intent_id TEXT PRIMARY KEY, record TEXT NOT NULL)'
    )
    this.#migrateExecutionLookup()
  }

  /**
   * Add the execution lookup to existing stores and backfill only from fully validated markers.
   * The transaction and unique index make partial or ambiguous mappings unavailable after restart.
   */
  #migrateExecutionLookup(): void {
    if (this.#hasExecutionLookupSchema()) return
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const columns = this.database.prepare('PRAGMA table_info(pi_lead_intent_admissions)').all()
      const indexes = this.database.prepare('PRAGMA index_list(pi_lead_intent_admissions)').all()
      if (
        columns.some((column) => column['name'] === 'execution_id') &&
        indexes.some(
          (index) =>
            index['name'] === 'pi_lead_intent_admissions_execution_id_idx' &&
            Number(index['unique']) === 1
        )
      ) {
        this.database.exec('COMMIT')
        return
      }
      if (!columns.some((column) => column['name'] === 'execution_id'))
        this.database.exec('ALTER TABLE pi_lead_intent_admissions ADD COLUMN execution_id TEXT')

      const rows = this.database
        .prepare('SELECT intent_id, execution_id FROM pi_lead_intent_admissions ORDER BY intent_id')
        .all()
      const executions = new Set<string>()
      for (const row of rows) {
        const intentId = String(row['intent_id'])
        let marker: LeadIntentMarker | undefined
        try {
          marker = this.marker(intentId)
        } catch (error) {
          // A bad legacy record is not authority for a new index entry. Leave it unindexed so
          // unrelated valid admissions remain available; any direct read of that record still
          // fails closed through marker validation.
          if (!(error instanceof PiDurableLeadError)) throw error
          if (row['execution_id'] !== null && row['execution_id'] !== undefined)
            this.database
              .prepare(
                'UPDATE pi_lead_intent_admissions SET execution_id = NULL WHERE intent_id = ?'
              )
              .run(intentId)
          continue
        }
        if (!marker) conflict()
        const executionId = IdentifierSchemas.executionId.parse(marker.intent.executionId)
        const existing = row['execution_id']
        if (executions.has(executionId)) conflict()
        executions.add(executionId)
        if (existing !== executionId) {
          const changed = this.database
            .prepare('UPDATE pi_lead_intent_admissions SET execution_id = ? WHERE intent_id = ?')
            .run(executionId, intentId).changes
          if (changed !== 1) conflict()
        }
      }
      this.database.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS pi_lead_intent_admissions_execution_id_idx ON pi_lead_intent_admissions (execution_id)'
      )
      this.database.exec('COMMIT')
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // The original migration failure remains authoritative.
      }
      if (error instanceof PiDurableLeadError) throw error
      conflict()
    }
  }

  #hasExecutionLookupSchema(): boolean {
    const columns = this.database.prepare('PRAGMA table_info(pi_lead_intent_admissions)').all()
    if (!columns.some((column) => column['name'] === 'execution_id')) return false
    return this.database
      .prepare('PRAGMA index_list(pi_lead_intent_admissions)')
      .all()
      .some(
        (index) =>
          index['name'] === 'pi_lead_intent_admissions_execution_id_idx' &&
          Number(index['unique']) === 1
      )
  }

  marker(intentId: string): LeadIntentMarker | undefined {
    const row = this.database
      .prepare(
        'SELECT intent_id, workspace_id, attempt_id, digest, record, state FROM pi_lead_intent_admissions WHERE intent_id = ?'
      )
      .get(intentId)
    if (!row) return undefined
    const raw = row['record']
    if (typeof raw !== 'string' || raw.length > 65536) conflict()
    let input: unknown
    try {
      input = JSON.parse(raw)
    } catch {
      conflict()
    }
    const stored = validatedMarker(input)
    if (
      stored.intentId !== intentId ||
      stored.intentId !== row['intent_id'] ||
      stored.workspaceId !== row['workspace_id'] ||
      stored.intent.attemptId !== row['attempt_id'] ||
      stored.evidenceDigest !== row['digest']
    )
      conflict()
    return validatedMarker({ ...stored, state: row['state'] })
  }

  markerByExecutionId(executionId: string): LeadIntentMarker | undefined {
    const parsedExecutionId = IdentifierSchemas.executionId.parse(executionId)
    const rows = this.database
      .prepare('SELECT intent_id FROM pi_lead_intent_admissions WHERE execution_id = ? LIMIT 2')
      .all(parsedExecutionId)
    if (rows.length > 1) conflict()
    if (rows.length === 0) return undefined
    const marker = this.marker(String(rows[0]!['intent_id']))
    if (!marker || marker.intent.executionId !== parsedExecutionId) conflict()
    return marker
  }

  bind(marker: LeadIntentMarker): LeadIntentMarker {
    validatedMarker(marker)
    this.database
      .prepare(
        'INSERT OR IGNORE INTO pi_lead_intent_admissions (intent_id, workspace_id, attempt_id, digest, state, record, execution_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        marker.intentId,
        marker.workspaceId,
        marker.intent.attemptId,
        marker.evidenceDigest,
        marker.state,
        JSON.stringify(marker),
        marker.intent.executionId
      )
    const existing = this.marker(marker.intentId)
    if (
      !existing ||
      existing.workspaceId !== marker.workspaceId ||
      existing.evidenceDigest !== marker.evidenceDigest ||
      hash(existing.planPin) !== hash(marker.planPin) ||
      hash(existing.intent) !== hash(marker.intent)
    )
      conflict()
    return existing
  }
  bindBudget(intentId: string, budget: RuntimeAttemptBudgetAuthority): void {
    const value = RuntimeAttemptBudgetAuthoritySchema.parse(budget)
    this.database
      .prepare('INSERT OR IGNORE INTO pi_lead_intent_budgets VALUES (?, ?)')
      .run(intentId, JSON.stringify(value))
    if (hash(this.budget(intentId)) !== hash(value)) conflict()
  }
  /** Historical committed allocation pin for read-only terminal status; never new spend authority. */
  budget(intentId: string): RuntimeAttemptBudgetAuthority {
    const value = this.findBudget(intentId)
    if (!value) conflict()
    return value
  }
  findBudget(intentId: string): RuntimeAttemptBudgetAuthority | undefined {
    const row = this.database
      .prepare('SELECT record FROM pi_lead_intent_budgets WHERE intent_id = ?')
      .get(intentId)
    return row
      ? RuntimeAttemptBudgetAuthoritySchema.parse(JSON.parse(String(row['record'])))
      : undefined
  }
  /**
   * Write-once admission binding. An identical replay is a no-op; any other record for the same
   * intent conflicts and nothing is overwritten.
   */
  bindAdmission(binding: LeadAdmissionBinding): void {
    const value = validatedAdmissionBinding(binding)
    this.database
      .prepare('INSERT OR IGNORE INTO pi_lead_intent_admission_bindings VALUES (?, ?)')
      .run(value.intentId, JSON.stringify(value))
    if (hash(this.admissionBinding(value.intentId)) !== hash(value)) conflict()
  }
  /** Retained admission binding, self-digest checked. Absent for legacy or unbound records. */
  admissionBinding(intentId: string): LeadAdmissionBinding | undefined {
    const row = this.database
      .prepare(
        'SELECT intent_id, record FROM pi_lead_intent_admission_bindings WHERE intent_id = ?'
      )
      .get(intentId)
    if (!row) return undefined
    const raw = row['record']
    if (typeof raw !== 'string' || raw.length > 65536) conflict()
    let input: unknown
    try {
      input = JSON.parse(raw)
    } catch {
      conflict()
    }
    const stored = validatedAdmissionBinding(input)
    if (stored.intentId !== intentId || stored.intentId !== row['intent_id']) conflict()
    return stored
  }
  expiredPreparations(at: string): readonly LeadIntentMarker[] {
    const rows = this.database
      .prepare(
        "SELECT intent_id FROM pi_lead_intent_admissions AS admission WHERE (state IN ('pending', 'ready', 'releasing') OR (state = 'released' AND NOT EXISTS (SELECT 1 FROM pi_lead_intent_budgets AS budget WHERE budget.intent_id = admission.intent_id))) AND json_extract(record, '$.preparationDeadlineAt') <= ? AND intent_id > ? ORDER BY intent_id LIMIT 100"
      )
      .all(at, this.#preparationCursor)
    this.#preparationCursor = rows.length === 100 ? String(rows[rows.length - 1]!['intent_id']) : ''
    return rows.map((row) => this.marker(String(row['intent_id']))!).filter(Boolean)
  }
  claimPreparationRelease(marker: LeadIntentMarker): boolean {
    return (
      this.database
        .prepare(
          "UPDATE pi_lead_intent_admissions SET state = 'releasing' WHERE intent_id = ? AND digest = ? AND state = ?"
        )
        .run(marker.intentId, marker.evidenceDigest, marker.state).changes === 1
    )
  }
  completePreparationRelease(marker: LeadIntentMarker): void {
    const changed = this.database
      .prepare(
        "UPDATE pi_lead_intent_admissions SET state = 'released' WHERE intent_id = ? AND digest = ? AND state = 'releasing'"
      )
      .run(marker.intentId, marker.evidenceDigest).changes
    if (changed !== 1 && this.marker(marker.intentId)?.state !== 'released') conflict()
  }
  /**
   * Ready transition and exact binding publication in one SQLite transaction: the pending marker
   * becomes ready only together with its binding. A failure rolls both back. Ready markers without a
   * binding row are therefore legacy records only, never the product of an interrupted admission.
   */
  publishReady(marker: LeadIntentMarker, binding: LeadAdmissionBinding): void {
    this.budget(marker.intentId)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.database
        .prepare(
          "UPDATE pi_lead_intent_admissions SET state = 'ready' WHERE intent_id = ? AND digest = ? AND state = 'pending'"
        )
        .run(marker.intentId, marker.evidenceDigest).changes
      if (changed !== 1) {
        // Replay: the same admission already published. Its binding must already be durable, so a
        // ready marker without one (a legacy record) is refused, never backfilled here.
        if (this.marker(marker.intentId)?.state !== 'ready') conflict()
        if (this.admissionBinding(marker.intentId) === undefined) conflict()
      }
      this.bindAdmission(binding)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
  async get(intentId: string): Promise<CanonicalLeadIntent | undefined> {
    const marker = this.marker(intentId)
    return marker?.state === 'ready' ? structuredClone(marker.intent) : undefined
  }
  async getByAttempt(attemptId: string): Promise<CanonicalLeadIntent | undefined> {
    const row = this.database
      .prepare(
        "SELECT intent_id FROM pi_lead_intent_admissions WHERE attempt_id = ? AND state = 'ready'"
      )
      .get(attemptId)
    return row ? this.get(String(row['intent_id'])) : undefined
  }
}

export interface NodePiDurableLeadAdmissionOptions {
  readonly database: DatabaseSync
  readonly product: PiLeadProductAuthorityPort
  /** Trusted resolver persists an immutable compiled plan, never accepts a client plan. */
  readonly resolvePlan: (
    evidence: VerifiedPiLeadIntentEvidence,
    ids: PiLeadIntentIds
  ) => Promise<ExecutionPlan>
  readonly plans: {
    get(pin: { executionPlanId: string; contentDigest: string }): Promise<ExecutionPlan | undefined>
  }
  /** Budget-enabled repository must atomically open the canonical accepted allowance. */
  readonly commandRepository: CommandAcceptanceRepository
  readonly planValidator: ExecutionPlanAcceptanceValidator
  readonly executions: ExecutionRepository
  readonly budgetAdmission: {
    reserve(input: {
      execution: Execution
      executionPlan: ExecutionPlan
      attemptId: string
    }): Promise<RuntimeAttemptBudgetAuthority>
  }
  readonly admissionPrincipalId: string
  /** Server-owned live scope source, required for explicit workspace admission. */
  readonly scopeAuthority?: CurrentExecutionScopeAuthority
  /** Inspect the actual configured adapter before creating a workspace marker or budget. */
  readonly inspectRuntime?: RuntimeAdapter['inspect']
  /** Metadata-only provider readiness; never leases credentials or invokes a model. */
  readonly assertProviderReady?: (input: {
    readonly evidence: VerifiedPiLeadIntentEvidence
    readonly plan: ExecutionPlan
    readonly ids: PiLeadIntentIds
    readonly actorPrincipalId: string
  }) => Promise<void>
  readonly now?: () => string
  readonly checkpoint?: (
    boundary:
      | 'after_marker'
      | 'after_accept'
      | 'after_attempt'
      | 'after_budget'
      | 'before_publish'
      | 'after_mapping'
  ) => void | Promise<void>
}

/** Opt-in mint bridge. New work requires verified product intent AND canonical CP admission. */
export class NodePiDurableLeadAdmission implements PiDurableLeadAuthority {
  readonly store: SqlitePiDurableLeadIntentStore
  readonly canonicalAuthority: CanonicalPiDurableAuthority
  readonly #now: () => string
  constructor(readonly options: NodePiDurableLeadAdmissionOptions) {
    this.#now = options.now ?? (() => new Date().toISOString())
    ServicePrincipalSchema.shape.principalId.parse(options.admissionPrincipalId)
    this.store = new SqlitePiDurableLeadIntentStore(options.database)
    this.canonicalAuthority = this.#canonicalAuthority()
  }

  /**
   * Canonical authority over the shared store. Public reads see ready intents only. An admission's own
   * projection gets a private authority that can also read exactly its one pending marker.
   */
  #canonicalAuthority(pending?: LeadIntentMarker): CanonicalPiDurableAuthority {
    const options = this.options
    return new CanonicalPiDurableAuthority({
      intents: pending ? this.#pendingReader(pending) : this.store,
      executions: options.executions,
      plans: options.plans,
      now: this.#now,
      messages: {
        readCurrent: async (intent, purpose) => {
          const marker = this.store.marker(intent.intentId)
          const ownPending =
            pending !== undefined &&
            marker?.state === 'pending' &&
            marker.intentId === pending.intentId
          if (!marker || (marker.state !== 'ready' && !ownPending)) conflict()
          await this.#validateCurrentPlan(marker)
          const evidence = await this.#evidence(
            intent.workspaceId,
            intent.intentId,
            marker.actorPrincipalId,
            purpose === 'read' ? 'observe' : 'inference'
          )
          if (hash({ evidence, planPin: marker.planPin }) !== marker.evidenceDigest) conflict()
          return {
            prompt: evidence.prompt,
            authorityRevision: evidence.authorityRevision,
            principalRef: evidence.principalRef,
            scopeRef: evidence.scopeRef,
            expiresAt: evidence.expiresAt,
            allowedPrincipalIds: evidence.allowedPrincipalIds,
          }
        },
      },
      budgets: {
        resolve: async ({ execution, attempt, plan, purpose }) => {
          if (purpose === 'read' || purpose === 'recovery') {
            const intent = await this.store.getByAttempt(attempt.attemptId)
            if (!intent) conflict()
            return this.store.budget(intent.intentId)
          }
          return options.budgetAdmission.reserve({
            execution,
            executionPlan: plan,
            attemptId: attempt.attemptId,
          })
        },
      },
    })
  }

  /** Reads one admission's own pending marker. The shared store never hands it out. */
  #pendingReader(pending: LeadIntentMarker): CanonicalLeadIntentReader {
    return {
      get: async (intentId) =>
        intentId === pending.intentId ? structuredClone(pending.intent) : this.store.get(intentId),
      getByAttempt: async (attemptId) =>
        attemptId === pending.intent.attemptId
          ? structuredClone(pending.intent)
          : this.store.getByAttempt(attemptId),
    }
  }

  async resolveIntent(input: {
    workspaceId: string
    intentId: string
    principal: ServicePrincipal
    operation?: 'prepare' | 'dispatch' | 'status' | 'progress' | 'children' | 'cancel'
  }): Promise<PiDurableLeadAdmission | PiDurableLeadFencedResult> {
    return this.#safe(async () => {
      const principal = ServicePrincipalSchema.parse(input.principal)
      const requiredScope =
        input.operation === undefined ||
        input.operation === 'prepare' ||
        input.operation === 'dispatch'
          ? 'execution:accept'
          : input.operation === 'cancel'
            ? 'execution:cancel'
            : 'execution:read'
      if (!principal.scopes.includes(requiredScope)) denied()
      if (!principal.workspaceIds.includes(IdentifierSchemas.workspaceId.parse(input.workspaceId)))
        denied()
      const current = await this.#readUnion(
        input.workspaceId,
        input.intentId,
        principal.principalId,
        productPurpose(input.operation)
      )
      if (current === undefined) VerifiedPiLeadIntentEvidenceSchema.parse(undefined)
      if (current === undefined) throw new Error('unreachable')
      if (current.kind === 'fenced')
        return this.#fencedResolve(input, current.variant, current.facts, principal)
      const evidence = current.evidence
      const workspaceScope = evidence.projectId === undefined || evidence.projectId === null
      if (workspaceScope) {
        if (!this.options.scopeAuthority || !this.options.inspectRuntime)
          throw new PiDurableLeadError('PI_LEAD_PROJECT_SCOPE_REQUIRED')
        const inspection = await this.options.inspectRuntime()
        if (
          inspection.health !== 'healthy' ||
          !inspection.capabilities.some(
            (capability) =>
              capability.name === 'execution.scope.workspace.v1' &&
              capability.support === 'supported'
          )
        )
          throw new PiDurableLeadError('PI_LEAD_WORKSPACE_SCOPE_UNSUPPORTED')
      } else if (!principal.projectIds.includes(evidence.projectId!)) denied()
      let marker = this.store.marker(input.intentId)
      // Set only when this call authorizes the admission itself (marker becomes ready here).
      let authorized: PiDurableLeadAdmission | undefined
      if (
        marker &&
        (input.operation === undefined ||
          input.operation === 'prepare' ||
          input.operation === 'dispatch')
      )
        this.#assertPreparationLive(marker)
      if (marker?.state !== 'ready') {
        if (
          input.operation !== undefined &&
          input.operation !== 'prepare' &&
          input.operation !== 'dispatch'
        )
          throw new PiDurableLeadError('PI_LEAD_MISSING')
        if (!principal.scopes.includes('execution:accept')) denied()
        const ids = deterministicPiLeadIntentIds(input.workspaceId, input.intentId)
        const plan = assertExecutionPlanIntegrity(
          await this.options.resolvePlan(structuredClone(evidence), ids)
        )
        if (
          plan.correlation.workspaceId !== evidence.workspaceId ||
          (workspaceScope
            ? executionScopeOf(plan.correlation).kind !== 'workspace' || plan.schemaVersion !== 2
            : plan.correlation.projectId !== evidence.projectId) ||
          plan.correlation.requestId !== ids.requestId ||
          plan.profile.profileVersionId !== evidence.profileVersionId ||
          plan.profile.contentDigest !== evidence.profileContentDigest
        )
          conflict()
        const planPin = {
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
          schemaVersion: plan.schemaVersion,
        }
        const persisted = assertExecutionPlanIntegrity(await this.options.plans.get(planPin))
        if (hash(persisted) !== hash(plan)) conflict()
        if (plan.schemaVersion === 2 && !evidence.canonicalActorPrincipalId) denied()
        if (plan.schemaVersion === 2 && !this.options.assertProviderReady)
          throw new PiDurableLeadError('PI_LEAD_PROVIDER_READINESS_REQUIRED')
        const canonicalActorPrincipalId =
          evidence.canonicalActorPrincipalId ?? principal.principalId
        await this.#assertScope(plan, canonicalActorPrincipalId)
        await this.options.assertProviderReady?.({
          evidence: structuredClone(evidence),
          plan: structuredClone(plan),
          ids,
          actorPrincipalId: canonicalActorPrincipalId,
        })
        // A metadata readiness read may await external authority. Recheck the
        // canonical product and scope before creating the first admission marker.
        await this.#assertScope(plan, canonicalActorPrincipalId)
        if (
          hash(await this.#evidence(input.workspaceId, input.intentId, principal.principalId)) !==
          hash(evidence)
        )
          conflict()
        const {
          schemaVersion: _schemaVersion,
          prompt: _prompt,
          profileVersionId: _profileVersionId,
          profileContentDigest: _profileContentDigest,
          projectId: _projectId,
          canonicalActorPrincipalId: _canonicalActorPrincipalId,
          ...intentEvidence
        } = evidence
        const receivedAt = this.#now()
        marker = this.store.bind({
          intentId: evidence.intentId,
          workspaceId: evidence.workspaceId,
          actorPrincipalId: principal.principalId,
          evidenceDigest: hash({ evidence, planPin }),
          planPin,
          intent: {
            ...intentEvidence,
            ...(!workspaceScope ? { projectId: evidence.projectId! } : {}),
            ...(plan.correlation.executionScope
              ? { executionScope: plan.correlation.executionScope }
              : {}),
            // A v2 fence pins the canonical actor, so an admitted actor is retained even without an
            // explicit scope. Scoped plans keep the fallback actor they were always pinned to.
            ...(plan.correlation.executionScope
              ? { canonicalActorPrincipalId }
              : evidence.canonicalActorPrincipalId !== undefined
                ? { canonicalActorPrincipalId: evidence.canonicalActorPrincipalId }
                : {}),
            executionId: ids.executionId,
            attemptId: ids.attemptId,
          },
          receivedAt,
          ...(input.operation === 'prepare'
            ? {
                preparationDeadlineAt: new Date(
                  Math.min(Date.parse(receivedAt) + 300_000, Date.parse(evidence.expiresAt))
                ).toISOString(),
              }
            : {}),
          state: 'pending',
        })
        await this.options.checkpoint?.('after_marker')
        this.#assertPreparationLive(marker)
        const inbox = new CommandInboxService({
          repository: this.options.commandRepository,
          executionPlanValidator: this.options.planValidator,
          executionIdFactory: () => ids.executionId,
          now: this.#now,
        })
        const accepted = await inbox.acceptExecution({
          callerPrincipalId: this.options.admissionPrincipalId,
          operation: 'execution.accept',
          commandId: ids.commandId,
          requestId: ids.requestId,
          idempotencyKey: `lead-turn:${evidence.intentId}`,
          payloadHash: marker.evidenceDigest.slice(7),
          correlation: {
            workspaceId: plan.correlation.workspaceId,
            projectId: plan.correlation.projectId,
            ...(plan.correlation.executionScope
              ? { executionScope: plan.correlation.executionScope }
              : {}),
            taskId: plan.correlation.taskId,
            agentId: plan.correlation.agentId,
          },
          executionPlan: marker.planPin,
          receivedAt: marker.receivedAt,
          retentionExpiresAt: new Date(
            Date.parse(marker.receivedAt) + 31 * 86_400_000
          ).toISOString(),
          deadlineAt: evidence.expiresAt,
        })
        if (accepted.execution.executionId !== ids.executionId) conflict()
        await this.options.checkpoint?.('after_accept')
        this.#assertPreparationLive(marker)
        let execution = await this.options.executions.getExecution(ids.executionId)
        if (!execution) conflict()
        if (execution.latestAttemptId === undefined) {
          try {
            await new ExecutionLifecycleService(this.options.executions).createAttempt({
              executionId: ids.executionId,
              attemptId: ids.attemptId,
              expectedExecutionVersion: execution.version,
              queuedAt: this.#now(),
            })
          } catch {
            const winner = await this.options.executions.getExecution(ids.executionId)
            if (winner?.latestAttemptId !== ids.attemptId) conflict()
          }
        }
        execution = await this.options.executions.getExecution(ids.executionId)
        const attempt = await this.options.executions.getAttempt(ids.attemptId)
        if (
          !execution ||
          execution.latestAttemptId !== ids.attemptId ||
          execution.attemptCount !== 1 ||
          attempt?.executionId !== ids.executionId ||
          attempt.sequence !== 1
        )
          conflict()
        await this.options.checkpoint?.('after_attempt')
        this.#assertPreparationLive(marker)
        const budget = RuntimeAttemptBudgetAuthoritySchema.parse(
          await this.options.budgetAdmission.reserve({
            execution,
            executionPlan: plan,
            attemptId: ids.attemptId,
          })
        )
        if (
          budget.executionId !== ids.executionId ||
          budget.attemptId !== ids.attemptId ||
          budget.executionPlanDigest !== plan.contentDigest
        )
          conflict()
        this.store.bindBudget(evidence.intentId, budget)
        await this.options.checkpoint?.('after_budget')
        this.#assertPreparationLive(marker)
        // Projection reads this still-pending marker through this call's private authority only. Ready
        // and its exact binding then commit in one transaction, so a crash can leave only a pending
        // marker (no binding) or both.
        authorized = project(
          await this.#canonicalAuthority(marker).get(
            input.intentId,
            input.workspaceId,
            principal.principalId,
            'inference'
          ),
          marker.intent,
          marker.preparationDeadlineAt
        )
        await this.options.checkpoint?.('before_publish')
        this.#assertPreparationLive(marker)
        this.store.publishReady(marker, admissionBindingFor(marker, authorized))
        await this.options.checkpoint?.('after_mapping')
        this.#assertPreparationLive(marker)
      }
      marker = this.store.marker(input.intentId)
      if (!marker || hash({ evidence, planPin: marker.planPin }) !== marker.evidenceDigest)
        conflict()
      if (authorized) return authorized
      return project(
        await this.canonicalAuthority.get(
          input.intentId,
          input.workspaceId,
          principal.principalId,
          input.operation === undefined ||
            input.operation === 'prepare' ||
            input.operation === 'dispatch'
            ? 'inference'
            : 'read'
        ),
        marker.intent,
        marker.preparationDeadlineAt
      )
    })
  }

  async assertCurrent(
    admission: PiDurableLeadAdmission,
    principal: ServicePrincipal,
    operation: 'prepare' | 'dispatch' | 'status' | 'progress' | 'children' | 'cancel'
  ): Promise<void> {
    return this.#safe(async () => {
      const checked = ServicePrincipalSchema.parse(principal)
      const scope =
        operation === 'prepare' || operation === 'dispatch'
          ? 'execution:accept'
          : operation === 'cancel'
            ? 'execution:cancel'
            : 'execution:read'
      if (
        !checked.scopes.includes(scope) ||
        !checked.workspaceIds.includes(IdentifierSchemas.workspaceId.parse(admission.workspaceId))
      )
        denied()
      const marker = this.store.marker(admission.intentId)
      if (
        !marker ||
        (marker.intent.projectId !== undefined &&
          !checked.projectIds.includes(marker.intent.projectId))
      )
        denied()
      if (operation === 'prepare' || operation === 'dispatch') this.#assertPreparationLive(marker)
      const product = await this.#readUnion(
        admission.workspaceId,
        admission.intentId,
        checked.principalId,
        productPurpose(operation)
      )
      if (product === undefined) VerifiedPiLeadIntentEvidenceSchema.parse(undefined)
      if (product === undefined) throw new Error('unreachable')
      if (product.kind === 'fenced') {
        this.#assertFencedCurrent(
          admission,
          product.variant,
          product.facts,
          checked.principalId,
          operation,
          marker
        )
        return
      }
      const evidence = product.evidence
      if (hash({ evidence, planPin: marker.planPin }) !== marker.evidenceDigest) conflict()
      const current = project(
        await this.canonicalAuthority.get(
          admission.intentId,
          admission.workspaceId,
          checked.principalId,
          operation === 'prepare' || operation === 'dispatch' ? 'inference' : 'read'
        ),
        marker.intent,
        marker.preparationDeadlineAt
      )
      if (hash(current) !== hash(admission)) conflict()
    })
  }

  /**
   * Resolves an existing execution back to its retained admission for read/recovery paths. The
   * lookup is only an index: current product evidence, the canonical product actor, live scope,
   * execution, attempt and immutable plan pin are all revalidated before an admission is returned.
   */
  async resolveRetainedAdmissionByExecutionId(input: {
    readonly executionId: string
    readonly workspaceId: string
    readonly principal: ServicePrincipal
  }): Promise<PiDurableLeadAdmission | undefined> {
    return this.#safe(async () => {
      const executionId = IdentifierSchemas.executionId.parse(input.executionId)
      const workspaceId = IdentifierSchemas.workspaceId.parse(input.workspaceId)
      const principal = ServicePrincipalSchema.parse(input.principal)
      if (
        !principal.scopes.includes('execution:read') ||
        !principal.workspaceIds.includes(workspaceId)
      )
        denied()

      const marker = this.store.markerByExecutionId(executionId)
      if (!marker) return undefined
      if (marker.workspaceId !== workspaceId || marker.intent.executionId !== executionId)
        conflict()
      if (marker.state !== 'ready') throw new PiDurableLeadError('PI_LEAD_MISSING')
      if (
        marker.intent.projectId !== undefined &&
        !principal.projectIds.includes(marker.intent.projectId)
      )
        denied()

      // actorPrincipalId is the service audience that created the row. It is never the product
      // actor: the canonical actor must come from current product evidence and authorize scope.
      const canonicalActorPrincipalId = marker.intent.canonicalActorPrincipalId
      if (
        !canonicalActorPrincipalId ||
        ServicePrincipalSchema.shape.principalId.safeParse(canonicalActorPrincipalId).success
      )
        conflict()
      const currentEvidence = await this.#evidence(
        workspaceId,
        marker.intentId,
        principal.principalId
      )
      if (currentEvidence.canonicalActorPrincipalId !== canonicalActorPrincipalId) conflict()
      if (hash({ evidence: currentEvidence, planPin: marker.planPin }) !== marker.evidenceDigest)
        conflict()

      const plan = await this.#validateCurrentPlan(marker, { requireCurrentActorScope: true })
      const executionInput = await this.options.executions.getExecution(executionId)
      const execution = ExecutionSchema.parse(executionInput)
      const attemptInput = await this.options.executions.getAttempt(marker.intent.attemptId)
      const attempt = ExecutionAttemptSchema.parse(attemptInput)
      if (
        execution.executionId !== executionId ||
        execution.correlation.workspaceId !== workspaceId ||
        hash(execution.executionPlan) !== hash(marker.planPin) ||
        hash(execution.correlation) !== hash(plan.correlation) ||
        attempt.attemptId !== marker.intent.attemptId ||
        attempt.executionId !== executionId ||
        execution.latestAttemptId !== attempt.attemptId
      )
        conflict()

      const resolved = await this.canonicalAuthority.get(
        marker.intentId,
        workspaceId,
        principal.principalId,
        'read'
      )
      if (
        resolved.startRequest.executionId !== executionId ||
        resolved.startRequest.attemptId !== marker.intent.attemptId ||
        hash({
          executionPlanId: resolved.startRequest.executionPlan.executionPlanId,
          contentDigest: resolved.startRequest.executionPlan.contentDigest,
          schemaVersion: resolved.startRequest.executionPlan.schemaVersion,
        }) !== hash(marker.planPin)
      )
        conflict()

      // Re-sample both independent authorities after awaited repository and product reads. This
      // narrows stale-read windows without claiming a cross-store atomic snapshot.
      const [finalEvidence, finalPlan, finalExecution, finalAttempt] = await Promise.all([
        this.#evidence(workspaceId, marker.intentId, principal.principalId),
        this.#validateCurrentPlan(marker, { requireCurrentActorScope: true }),
        this.options.executions.getExecution(executionId),
        this.options.executions.getAttempt(marker.intent.attemptId),
      ])
      if (
        finalEvidence.canonicalActorPrincipalId !== canonicalActorPrincipalId ||
        hash(finalEvidence) !== hash(currentEvidence) ||
        hash(finalPlan) !== hash(plan) ||
        hash(ExecutionSchema.parse(finalExecution)) !== hash(execution) ||
        hash(ExecutionAttemptSchema.parse(finalAttempt)) !== hash(attempt) ||
        hash(this.store.markerByExecutionId(executionId)) !== hash(marker)
      )
        conflict()

      const admission = project(resolved, marker.intent, marker.preparationDeadlineAt)
      if (Date.parse(admission.deadlineAt) <= Date.parse(this.#now()))
        throw new PiDurableLeadError('PI_LEAD_DEADLINE_EXPIRED')
      return admission
    })
  }

  /** Host startup/periodic cleanup for minting interrupted before the preparation
   * store could claim an allocation. It uses retained authority only; no current
   * provider grant, product message lookup or inference is needed to release it.
   */
  async recoverUnclaimedPreparations(
    releaseExpired: (admission: PiDurableLeadAdmission) => Promise<void>,
    isClaimed: (intentId: string) => Promise<boolean>
  ): Promise<{ released: number; pending: number }> {
    let released = 0,
      pending = 0
    for (const snapshot of this.store.expiredPreparations(this.#now())) {
      try {
        if (await isClaimed(snapshot.intentId)) continue
        if (!this.store.claimPreparationRelease(snapshot)) continue
        const marker = this.store.marker(snapshot.intentId)!
        let executionInput = await this.options.executions.getExecution(marker.intent.executionId)
        if (executionInput === undefined) {
          this.store.completePreparationRelease(marker)
          released++
          continue
        }
        let execution = ExecutionSchema.parse(executionInput)
        const plan = assertExecutionPlanIntegrity(await this.options.plans.get(marker.planPin))
        if (
          hash(execution.executionPlan) !== hash(marker.planPin) ||
          hash(execution.correlation) !== hash(plan.correlation) ||
          !executionScopesEqual(plan.correlation, marker.intent) ||
          execution.executionId !== marker.intent.executionId ||
          plan.correlation.requestId !==
            deterministicPiLeadIntentIds(marker.workspaceId, marker.intentId).requestId
        )
          conflict()
        if (execution.latestAttemptId === undefined) {
          if (execution.state !== 'accepted' || execution.attemptCount !== 0) conflict()
          await new ExecutionLifecycleService(this.options.executions).createAttempt({
            executionId: execution.executionId,
            attemptId: marker.intent.attemptId,
            expectedExecutionVersion: execution.version,
            queuedAt: this.#now(),
          })
          executionInput = await this.options.executions.getExecution(execution.executionId)
          execution = ExecutionSchema.parse(executionInput)
        }
        const attempt = ExecutionAttemptSchema.parse(
          await this.options.executions.getAttempt(marker.intent.attemptId)
        )
        if (
          execution.latestAttemptId !== marker.intent.attemptId ||
          execution.attemptCount !== 1 ||
          attempt.sequence !== 1 ||
          attempt.executionId !== execution.executionId
        )
          conflict()
        let budget = this.store.findBudget(marker.intentId)
        if (!budget) {
          if (
            !['accepted', 'queued'].includes(execution.state) ||
            attempt.state !== 'queued' ||
            attempt.runtime?.externalSessionId ||
            execution.startingAt ||
            execution.runningAt ||
            attempt.startingAt ||
            attempt.runningAt ||
            attempt.reconciliationRequiredAt
          )
            conflict()
          // This replays the allowance opened atomically by canonical acceptance;
          // it can only reserve its remaining admitted allocation, never purchase funds.
          budget = RuntimeAttemptBudgetAuthoritySchema.parse(
            await this.options.budgetAdmission.reserve({
              execution,
              executionPlan: plan,
              attemptId: attempt.attemptId,
            })
          )
          this.store.bindBudget(marker.intentId, budget)
        }
        const startRequest = RuntimeStartRequestSchema.parse({
          executionId: execution.executionId,
          attemptId: attempt.attemptId,
          idempotencyKey: `lead-turn:${marker.intentId}`,
          executionPlan: plan,
          attemptBudget: budget,
        })
        if (await isClaimed(marker.intentId)) continue
        await releaseExpired({
          schemaVersion: 'pi-lead-authority/v1',
          intentId: marker.intentId,
          workspaceId: marker.workspaceId,
          allowedPrincipalIds: marker.intent.allowedPrincipalIds,
          admissionDigest: marker.evidenceDigest,
          deadlineAt: marker.preparationDeadlineAt!,
          admittedAttempt: {
            executionId: execution.executionId,
            attemptId: attempt.attemptId,
            executionPlanId: plan.executionPlanId,
            executionPlanDigest: plan.contentDigest,
          },
          startRequest,
        })
        this.store.completePreparationRelease(marker)
        released++
      } catch {
        // Retain releasing for a safe retry; never persist private diagnostics.
        pending++
      }
    }
    return { released, pending }
  }

  #assertPreparationLive(marker: LeadIntentMarker): void {
    const current = this.store.marker(marker.intentId)
    if (
      !current ||
      current.state === 'releasing' ||
      current.state === 'released' ||
      (current.preparationDeadlineAt !== undefined &&
        Date.parse(current.preparationDeadlineAt) <= Date.parse(this.#now()))
    )
      throw new PiDurableLeadError('PI_LEAD_DEADLINE_EXPIRED')
  }

  async #validateCurrentPlan(
    marker: LeadIntentMarker,
    options: { readonly requireCurrentActorScope?: boolean } = {}
  ): Promise<ExecutionPlan> {
    const plan = assertExecutionPlanIntegrity(await this.options.plans.get(marker.planPin))
    if (
      plan.executionPlanId !== marker.planPin.executionPlanId ||
      plan.contentDigest !== marker.planPin.contentDigest ||
      plan.schemaVersion !== marker.planPin.schemaVersion ||
      plan.correlation.workspaceId !== marker.workspaceId ||
      !executionScopesEqual(plan.correlation, marker.intent)
    )
      conflict()
    if (
      options.requireCurrentActorScope &&
      (plan.schemaVersion !== 2 || plan.correlation.executionScope === undefined)
    )
      throw new PiDurableLeadError('PI_LEAD_SCOPE_REJECTED')
    if (plan.schemaVersion === 2 && !marker.intent.canonicalActorPrincipalId) denied()
    await this.#assertScope(
      plan,
      marker.intent.canonicalActorPrincipalId ?? marker.actorPrincipalId
    )
    const allowed = await this.options.planValidator.validate({
      executionPlan: marker.planPin,
      workspaceId: marker.intent.workspaceId,
      projectId: marker.intent.projectId,
      ...(marker.intent.executionScope ? { executionScope: marker.intent.executionScope } : {}),
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
      callerPrincipalId: this.options.admissionPrincipalId,
    })
    if (!allowed) conflict()
    return plan
  }
  async #assertScope(plan: ExecutionPlan, actorPrincipalId: string): Promise<void> {
    if (plan.correlation.executionScope === undefined) return
    if (
      !this.options.scopeAuthority ||
      !(await currentExecutionScopeAllows(
        this.options.scopeAuthority,
        {
          ...plan.correlation,
          callerPrincipalId: actorPrincipalId,
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            schemaVersion: plan.schemaVersion,
          },
        },
        this.#now()
      ))
    )
      throw new PiDurableLeadError('PI_LEAD_SCOPE_REJECTED')
  }
  async #readUnion(
    workspaceId: string,
    intentId: string,
    principalId: string,
    purpose: 'inference' | 'observe' = 'inference'
  ): Promise<
    | { readonly kind: 'evidence'; readonly evidence: VerifiedPiLeadIntentEvidence }
    | {
        readonly kind: 'fenced'
        readonly variant: LeadFenceVariant
        readonly facts: LeadIntentFenceFacts
      }
    | undefined
  > {
    z.uuid().parse(intentId)
    const raw = await this.options.product.readCurrent(
      {
        schemaVersion: 'pi-lead-intent/v1',
        intentId,
        workspaceId,
        principalId,
      },
      { purpose }
    )
    if (raw === undefined) return undefined
    const fenced = parseLeadProductFence(raw, { workspaceId, intentId }, () =>
      Date.parse(this.#now())
    )
    if (fenced) return fenced
    const evidence = VerifiedPiLeadIntentEvidenceSchema.parse(raw)
    if (
      evidence.intentId !== intentId ||
      evidence.workspaceId !== workspaceId ||
      !evidence.allowedPrincipalIds.includes(principalId)
    )
      denied()
    if (Date.parse(evidence.expiresAt) <= Date.parse(this.#now()))
      throw new PiDurableLeadError('PI_LEAD_DEADLINE_EXPIRED')
    return { kind: 'evidence', evidence }
  }
  /**
   * Root-approved M18.01.3 fence routing for an observation or cancel. Minimal v1 refuses every
   * operation. Pinned v2 needs a ready retained marker whose authority revision, scope, allowed
   * principals and canonical actor equal the fence pins, and cancel is limited to the original
   * actor. Prepare, dispatch, resume and publication are refused before any marker, attempt, budget
   * or model path runs.
   */
  #fencedResolve(
    input: {
      workspaceId: string
      intentId: string
      operation?: 'prepare' | 'dispatch' | 'status' | 'progress' | 'children' | 'cancel'
    },
    variant: LeadFenceVariant,
    facts: LeadIntentFenceFacts,
    principal: ServicePrincipal
  ): PiDurableLeadFencedResult {
    const operation = (input.operation ?? 'prepare') as LeadOperation
    const decision = fencedOperationPolicy(variant)[operation]
    if (decision === 'refuse') throw new PiDurableLeadError('PI_LEAD_UNAVAILABLE')
    if (variant !== 'v2' || facts.schemaVersion !== 'pi-lead-intent-fence/v2')
      throw new PiDurableLeadError('PI_LEAD_UNAVAILABLE')
    if (!facts.allowedPrincipalIds.includes(principal.principalId)) denied()
    const marker = this.store.marker(input.intentId)
    if (marker) this.#assertFencePins(marker, facts)
    if (decision === 'cancel-as-actor') {
      if (!marker) denied()
      // Original actor = the CP principal that originally admitted the retained intent;
      // the fence's canonical actor must be the retained one (actor continuity).
      if (marker.actorPrincipalId !== principal.principalId) denied()
      if (
        marker.intent.authorityRevision !== facts.authorityRevision ||
        marker.intent.scopeRef !== facts.scopeRef ||
        hash([...marker.intent.allowedPrincipalIds].toSorted()) !==
          hash([...facts.allowedPrincipalIds].toSorted()) ||
        (marker.intent.canonicalActorPrincipalId ?? null) !== facts.canonicalActorPrincipalId
      )
        conflict()
    } else if (
      marker &&
      (marker.intent.authorityRevision !== facts.authorityRevision ||
        marker.intent.scopeRef !== facts.scopeRef ||
        hash([...marker.intent.allowedPrincipalIds].toSorted()) !==
          hash([...facts.allowedPrincipalIds].toSorted()) ||
        marker.intent.canonicalActorPrincipalId !== facts.canonicalActorPrincipalId)
    )
      conflict()
    // Read only after the current marker/revision/scope/actor checks above. A binding that
    // disagrees with the retained marker is a conflict; a missing binding stays absent (legacy).
    const binding = marker ? this.store.admissionBinding(marker.intentId) : undefined
    if (marker && binding && !admissionBindingMatchesMarker(binding, marker)) conflict()
    return Object.freeze({
      schemaVersion: 'pi-lead-fenced/v1',
      kind: 'fenced',
      operation: operation as 'status' | 'progress' | 'cancel',
      fenceVariant: variant,
      retainedMatch: marker !== undefined,
      fence: Object.freeze({
        intentId: facts.intentId,
        workspaceId: facts.workspaceId,
        fencedAt: facts.rollbackFence.fencedAt,
        reason: facts.rollbackFence.reason,
        actor: facts.rollbackFence.actor,
        authorityRevision: facts.authorityRevision,
        canonicalActorPrincipalId: facts.canonicalActorPrincipalId,
        scopeRef: facts.scopeRef,
        allowedPrincipalIds: [...facts.allowedPrincipalIds],
      }),
      // Execution/plan bindings come from the marker. Admission facts come only from the
      // retained binding (absent for legacy records, which the service then fails closed on).
      retained: marker
        ? Object.freeze({
            intentId: marker.intentId,
            workspaceId: marker.workspaceId,
            executionId: marker.intent.executionId,
            attemptId: marker.intent.attemptId,
            allowedPrincipalIds: Object.freeze([...marker.intent.allowedPrincipalIds]),
            executionPlanId: marker.planPin.executionPlanId,
            executionPlanDigest: marker.planPin.contentDigest,
            ...(binding
              ? {
                  admissionDigest: binding.admissionDigest,
                  startDigest: binding.startDigest,
                  deadlineAt: binding.deadlineAt,
                }
              : {}),
          })
        : undefined,
    })
  }
  /** Fenced counterpart of `assertCurrent`: retained revision/scope must match the facts. */
  #assertFencedCurrent(
    admission: PiDurableLeadAdmission,
    variant: LeadFenceVariant,
    facts: LeadIntentFenceFacts,
    principalId: string,
    operation: 'prepare' | 'dispatch' | 'status' | 'progress' | 'children' | 'cancel',
    marker: LeadIntentMarker
  ): void {
    const decision = fencedOperationPolicy(variant)[operation as LeadOperation]
    if (decision === 'refuse') throw new PiDurableLeadError('PI_LEAD_UNAVAILABLE')
    if (variant !== 'v2' || facts.schemaVersion !== 'pi-lead-intent-fence/v2')
      throw new PiDurableLeadError('PI_LEAD_UNAVAILABLE')
    if (!facts.allowedPrincipalIds.includes(principalId)) denied()
    if (decision === 'cancel-as-actor') {
      if (marker.actorPrincipalId !== principalId) denied()
      if ((marker.intent.canonicalActorPrincipalId ?? null) !== facts.canonicalActorPrincipalId)
        denied()
    }
    if (
      marker.intent.authorityRevision !== facts.authorityRevision ||
      marker.intent.scopeRef !== facts.scopeRef ||
      hash([...marker.intent.allowedPrincipalIds].toSorted()) !==
        hash([...facts.allowedPrincipalIds].toSorted()) ||
      marker.intent.canonicalActorPrincipalId !== facts.canonicalActorPrincipalId
    )
      conflict()
    if (
      admission.admittedAttempt.executionId !== marker.intent.executionId ||
      admission.admittedAttempt.attemptId !== marker.intent.attemptId
    )
      conflict()
  }
  /**
   * Retained pins must equal the fence. A legacy marker without a canonical actor is an
   * insufficient pin, so it fails the canonical actor comparison and is refused.
   */
  #assertFencePins(marker: LeadIntentMarker, facts: LeadIntentFenceFactsV2): void {
    if (
      marker.intent.authorityRevision !== facts.authorityRevision ||
      marker.intent.scopeRef !== facts.scopeRef ||
      hash([...marker.intent.allowedPrincipalIds].toSorted()) !==
        hash([...facts.allowedPrincipalIds].toSorted()) ||
      marker.intent.canonicalActorPrincipalId === undefined ||
      marker.intent.canonicalActorPrincipalId !== facts.canonicalActorPrincipalId
    )
      conflict()
  }

  /**
   * Re-verifies a retained fenced run. It runs before and after every awaited effect. The fence and
   * the marker pins are checked again, and the receipt is verified against the retained request and
   * admission. The admission digest is re-derived with the canonical function, so the withheld prompt
   * is never re-read, and no attempt, budget or model path runs.
   */
  async assertFencedBinding(input: {
    readonly workspaceId: string
    readonly intentId: string
    readonly principal: ServicePrincipal
    readonly operation: 'status' | 'progress' | 'cancel'
    readonly receipt: FencedReceiptBinding
    readonly retained: {
      readonly request: RuntimeStartRequest
      readonly admission: PiDurableAdmission
    }
  }): Promise<void> {
    return this.#safe(async () => {
      const principal = ServicePrincipalSchema.parse(input.principal)
      const scope = input.operation === 'cancel' ? 'execution:cancel' : 'execution:read'
      if (!principal.scopes.includes(scope)) denied()
      if (!principal.workspaceIds.includes(IdentifierSchemas.workspaceId.parse(input.workspaceId)))
        denied()
      const product = await this.#readUnion(
        input.workspaceId,
        input.intentId,
        principal.principalId
      )
      if (product?.kind !== 'fenced') conflict()
      this.#fencedResolve(
        { workspaceId: input.workspaceId, intentId: input.intentId, operation: input.operation },
        product.variant,
        product.facts,
        principal
      )
      const marker = this.store.marker(input.intentId)
      if (marker?.state !== 'ready') throw new PiDurableLeadError('PI_LEAD_MISSING')
      const binding = this.store.admissionBinding(input.intentId)
      if (!binding) throw new PiDurableLeadError('PI_LEAD_UNAVAILABLE')
      if (!admissionBindingMatchesMarker(binding, marker)) conflict()
      const request = RuntimeStartRequestSchema.parse(input.retained.request)
      const admission = input.retained.admission
      const plan = assertExecutionPlanIntegrity(request.executionPlan)
      if (plan.correlation.workspaceId !== input.workspaceId) conflict()
      if (
        plan.correlation.projectId !== undefined &&
        !principal.projectIds.includes(plan.correlation.projectId)
      )
        denied()
      const ids = deterministicPiLeadIntentIds(input.workspaceId, input.intentId)
      if (
        request.executionId !== ids.executionId ||
        request.attemptId !== ids.attemptId ||
        input.receipt.executionId !== ids.executionId ||
        input.receipt.attemptId !== ids.attemptId
      )
        conflict()
      if (
        admission.authority.revision !== marker.intent.authorityRevision ||
        admission.authority.scopeRef !== marker.intent.scopeRef ||
        admission.authority.principalRef !== marker.intent.principalRef ||
        admission.authority.expiresAt !== marker.intent.expiresAt ||
        admission.selection.selectionRef !== marker.intent.selectionRef ||
        admission.selection.selectionRevision !== marker.intent.selectionRevision
      )
        conflict()
      if (input.receipt.startDigest !== hash(request)) conflict()
      const allowed = [...marker.intent.allowedPrincipalIds].toSorted()
      if (hash(allowed) !== hash([...input.receipt.allowedPrincipalIds].toSorted())) conflict()
      // The dispatch-time deadline is the canonical minimum of the same retained records. These
      // two CP samples must match: the first sample detects changes that overlap the second, and
      // the second sample supplies the values used below. Product authority and CP records remain
      // separate stores, so this is an optimistic consistency check, not a cross-store snapshot.
      const [initialExecution, initialAttempt] = await Promise.all([
        this.options.executions.getExecution(marker.intent.executionId),
        this.options.executions.getAttempt(marker.intent.attemptId),
      ])
      const [execution, attempt] = await Promise.all([
        this.options.executions.getExecution(marker.intent.executionId),
        this.options.executions.getAttempt(marker.intent.attemptId),
      ])
      if (hash(initialExecution) !== hash(execution) || hash(initialAttempt) !== hash(attempt))
        conflict()
      const currentProduct = await this.#readUnion(
        input.workspaceId,
        input.intentId,
        principal.principalId
      )
      if (currentProduct?.kind !== 'fenced') conflict()
      this.#fencedResolve(
        { workspaceId: input.workspaceId, intentId: input.intentId, operation: input.operation },
        currentProduct.variant,
        currentProduct.facts,
        principal
      )
      const currentMarker = this.store.marker(input.intentId)
      if (!currentMarker || hash(currentMarker) !== hash(marker)) conflict()
      const currentBinding = this.store.admissionBinding(input.intentId)
      if (!currentBinding || hash(currentBinding) !== hash(binding)) conflict()
      const executionView = ExecutionSchema.parse(execution)
      const attemptView = ExecutionAttemptSchema.parse(attempt)
      const base = earliestDeadline([
        marker.intent.expiresAt,
        executionView.deadlineAt,
        attemptView.deadlineAt,
      ])
      const baseDigest = canonicalAdmissionDigest({
        startRequest: request,
        admission,
        allowedPrincipalIds: allowed,
        deadlineAt: base,
      })
      const expectedDeadline =
        marker.preparationDeadlineAt === undefined
          ? base
          : new Date(
              Math.min(Date.parse(base), Date.parse(marker.preparationDeadlineAt))
            ).toISOString()
      const expectedDigest =
        marker.preparationDeadlineAt === undefined
          ? baseDigest
          : hash({
              canonicalAdmissionDigest: baseDigest,
              preparationDeadlineAt: marker.preparationDeadlineAt,
            })
      if (
        binding.admissionDigest !== expectedDigest ||
        binding.startDigest !== hash(request) ||
        binding.deadlineAt !== expectedDeadline ||
        input.receipt.deadlineAt !== expectedDeadline ||
        input.receipt.admissionDigest !== expectedDigest
      )
        conflict()
      if (Date.parse(expectedDeadline) <= Date.parse(this.#now()))
        throw new PiDurableLeadError('PI_LEAD_DEADLINE_EXPIRED')
    })
  }

  async #evidence(
    workspaceId: string,
    intentId: string,
    principalId: string,
    purpose: 'inference' | 'observe' = 'inference'
  ): Promise<VerifiedPiLeadIntentEvidence> {
    const current = await this.#readUnion(workspaceId, intentId, principalId, purpose)
    if (current === undefined) VerifiedPiLeadIntentEvidenceSchema.parse(undefined)
    if (current === undefined) throw new Error('unreachable')
    if (current.kind === 'fenced') throw new PiDurableLeadError('PI_LEAD_UNAVAILABLE')
    return current.evidence
  }
  async #safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof PiDurableLeadError) throw error
      throw asModelNotReady(error) ?? new PiDurableLeadError('PI_LEAD_UNAVAILABLE')
    }
  }
}
function project(
  current: CanonicalPiDurableAdmission,
  intent: CanonicalLeadIntent,
  preparationDeadlineAt?: string
): PiDurableLeadAdmission {
  return Object.freeze({
    schemaVersion: 'pi-lead-authority/v1',
    intentId: intent.intentId,
    workspaceId: intent.workspaceId,
    allowedPrincipalIds: current.allowedPrincipalIds,
    admissionDigest: preparationDeadlineAt
      ? hash({ canonicalAdmissionDigest: current.admissionDigest, preparationDeadlineAt })
      : current.admissionDigest,
    deadlineAt: preparationDeadlineAt
      ? new Date(
          Math.min(Date.parse(current.deadlineAt), Date.parse(preparationDeadlineAt))
        ).toISOString()
      : current.deadlineAt,
    admittedAttempt: Object.freeze({
      executionId: intent.executionId,
      attemptId: intent.attemptId,
      executionPlanId: current.startRequest.executionPlan.executionPlanId,
      executionPlanDigest: current.startRequest.executionPlan.contentDigest,
    }),
    startRequest: current.startRequest,
  })
}
/** The receipt fields that bind a dispatch to its retained admission. */
export interface FencedReceiptBinding {
  readonly executionId: string
  readonly attemptId: string
  readonly startDigest: string
  readonly admissionDigest: string
  readonly deadlineAt: string
  readonly allowedPrincipalIds: readonly string[]
}

function earliestDeadline(values: readonly (string | undefined)[]): string {
  const present = values.filter((value): value is string => value !== undefined)
  return present.toSorted((left, right) => Date.parse(left) - Date.parse(right))[0]!
}

function hash(input: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(input) ?? 'null')
    .digest('hex')}`
}
function conflict(): never {
  throw new PiDurableLeadError('PI_LEAD_AUTHORITY_CONFLICT')
}
function denied(): never {
  throw new PiDurableLeadError('PI_LEAD_SCOPE_REJECTED')
}
