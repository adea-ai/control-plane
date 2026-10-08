import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  ServicePrincipalSchema,
  type ServicePrincipal,
} from '@control-plane/contracts'
import {
  CommandInboxService,
  ExecutionLifecycleService,
  ExecutionPlanPinSchema,
  type CommandAcceptanceRepository,
  type ExecutionPlanAcceptanceValidator,
  type ExecutionRepository,
  type Execution,
} from '@control-plane/domain'
import { assertExecutionPlanIntegrity, type ExecutionPlan } from '@control-plane/execution-plan'
import {
  RuntimeAttemptBudgetAuthoritySchema,
  type RuntimeAttemptBudgetAuthority,
} from '@control-plane/runtime-sdk'
import {
  CanonicalPiDurableAuthority,
  ProviderSelectionReferenceSchema,
  type CanonicalLeadIntent,
  type CanonicalLeadIntentReader,
  type CanonicalPiDurableAdmission,
} from '@control-plane/pi-durable-adapter'
import {
  PiDurableLeadError,
  type PiDurableLeadAdmission,
  type PiDurableLeadAuthority,
} from './pi-durable-lead.service.js'

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
export interface PiLeadProductAuthorityPort {
  /** Signed, bounded product authority; checks current workspace/message/channel lead/audience. */
  readCurrent(input: {
    schemaVersion: 'pi-lead-intent/v1'
    intentId: string
    workspaceId: string
    principalId: string
  }): Promise<VerifiedPiLeadIntentEvidence | undefined>
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
  readonly state: 'pending' | 'ready'
}

/** Immutable intent/plan marker precedes acceptance; only completion state may advance. */
export class SqlitePiDurableLeadIntentStore implements CanonicalLeadIntentReader {
  constructor(readonly database: DatabaseSync) {
    database.exec(
      'CREATE TABLE IF NOT EXISTS pi_lead_intent_admissions (intent_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pi_lead_intent_budgets (intent_id TEXT PRIMARY KEY, record TEXT NOT NULL)'
    )
  }
  marker(intentId: string): LeadIntentMarker | undefined {
    const row = this.database
      .prepare('SELECT record, state FROM pi_lead_intent_admissions WHERE intent_id = ?')
      .get(intentId)
    return row
      ? ({ ...JSON.parse(String(row['record'])), state: String(row['state']) } as LeadIntentMarker)
      : undefined
  }
  bind(marker: LeadIntentMarker): LeadIntentMarker {
    this.database
      .prepare('INSERT OR IGNORE INTO pi_lead_intent_admissions VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        marker.intentId,
        marker.workspaceId,
        marker.intent.attemptId,
        marker.evidenceDigest,
        marker.state,
        JSON.stringify(marker)
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
    const row = this.database
      .prepare('SELECT record FROM pi_lead_intent_budgets WHERE intent_id = ?')
      .get(intentId)
    if (!row) conflict()
    return RuntimeAttemptBudgetAuthoritySchema.parse(JSON.parse(String(row['record'])))
  }
  complete(marker: LeadIntentMarker): void {
    this.budget(marker.intentId)
    this.database
      .prepare(
        "UPDATE pi_lead_intent_admissions SET state = 'ready' WHERE intent_id = ? AND digest = ? AND state = 'pending'"
      )
      .run(marker.intentId, marker.evidenceDigest)
    if (this.marker(marker.intentId)?.state !== 'ready') conflict()
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
  readonly now?: () => string
  readonly checkpoint?: (
    boundary: 'after_marker' | 'after_accept' | 'after_attempt' | 'after_budget' | 'after_mapping'
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
    this.canonicalAuthority = new CanonicalPiDurableAuthority({
      intents: this.store,
      executions: options.executions,
      plans: options.plans,
      now: this.#now,
      messages: {
        readCurrent: async (intent) => {
          const marker = this.store.marker(intent.intentId)
          if (!marker || marker.state !== 'ready') conflict()
          await this.#validateCurrentPlan(marker)
          const evidence = await this.#evidence(
            intent.workspaceId,
            intent.intentId,
            marker.actorPrincipalId
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
          if (purpose === 'read') {
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

  async resolveIntent(input: {
    workspaceId: string
    intentId: string
    principal: ServicePrincipal
    operation?: 'dispatch' | 'status' | 'progress' | 'cancel'
  }): Promise<PiDurableLeadAdmission> {
    return this.#safe(async () => {
      const principal = ServicePrincipalSchema.parse(input.principal)
      const requiredScope =
        input.operation === undefined || input.operation === 'dispatch'
          ? 'execution:accept'
          : input.operation === 'cancel'
            ? 'execution:cancel'
            : 'execution:read'
      if (!principal.scopes.includes(requiredScope)) denied()
      if (!principal.workspaceIds.includes(IdentifierSchemas.workspaceId.parse(input.workspaceId)))
        denied()
      const evidence = await this.#evidence(
        input.workspaceId,
        input.intentId,
        principal.principalId
      )
      if (evidence.projectId === undefined || evidence.projectId === null)
        throw new PiDurableLeadError('PI_LEAD_PROJECT_SCOPE_REQUIRED')
      if (!principal.projectIds.includes(evidence.projectId)) denied()
      let marker = this.store.marker(input.intentId)
      if (marker?.state !== 'ready') {
        if (input.operation !== undefined && input.operation !== 'dispatch')
          throw new PiDurableLeadError('PI_LEAD_MISSING')
        if (!principal.scopes.includes('execution:accept')) denied()
        const ids = deterministicPiLeadIntentIds(input.workspaceId, input.intentId)
        const plan = assertExecutionPlanIntegrity(
          await this.options.resolvePlan(structuredClone(evidence), ids)
        )
        if (
          plan.correlation.workspaceId !== evidence.workspaceId ||
          plan.correlation.projectId !== evidence.projectId ||
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
        const {
          schemaVersion: _schemaVersion,
          prompt: _prompt,
          profileVersionId: _profileVersionId,
          profileContentDigest: _profileContentDigest,
          ...intentEvidence
        } = evidence
        marker = this.store.bind({
          intentId: evidence.intentId,
          workspaceId: evidence.workspaceId,
          actorPrincipalId: principal.principalId,
          evidenceDigest: hash({ evidence, planPin }),
          planPin,
          intent: {
            ...intentEvidence,
            projectId: evidence.projectId,
            executionId: ids.executionId,
            attemptId: ids.attemptId,
          },
          receivedAt: this.#now(),
          state: 'pending',
        })
        await this.options.checkpoint?.('after_marker')
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
        this.store.complete(marker)
        await this.options.checkpoint?.('after_mapping')
      }
      marker = this.store.marker(input.intentId)
      if (!marker || hash({ evidence, planPin: marker.planPin }) !== marker.evidenceDigest)
        conflict()
      return project(
        await this.canonicalAuthority.get(
          input.intentId,
          input.workspaceId,
          principal.principalId,
          input.operation === undefined || input.operation === 'dispatch' ? 'inference' : 'read'
        ),
        marker.intent
      )
    })
  }

  async assertCurrent(
    admission: PiDurableLeadAdmission,
    principal: ServicePrincipal,
    operation: 'dispatch' | 'status' | 'progress' | 'cancel'
  ): Promise<void> {
    return this.#safe(async () => {
      const checked = ServicePrincipalSchema.parse(principal)
      const scope =
        operation === 'dispatch'
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
      if (!marker || !checked.projectIds.includes(marker.intent.projectId)) denied()
      const evidence = await this.#evidence(
        admission.workspaceId,
        admission.intentId,
        checked.principalId
      )
      if (hash({ evidence, planPin: marker.planPin }) !== marker.evidenceDigest) conflict()
      const current = project(
        await this.canonicalAuthority.get(
          admission.intentId,
          admission.workspaceId,
          checked.principalId,
          operation === 'dispatch' ? 'inference' : 'read'
        ),
        marker.intent
      )
      if (hash(current) !== hash(admission)) conflict()
    })
  }

  async #validateCurrentPlan(marker: LeadIntentMarker): Promise<void> {
    const plan = assertExecutionPlanIntegrity(await this.options.plans.get(marker.planPin))
    const allowed = await this.options.planValidator.validate({
      executionPlan: marker.planPin,
      workspaceId: marker.intent.workspaceId,
      projectId: marker.intent.projectId,
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
      callerPrincipalId: this.options.admissionPrincipalId,
    })
    if (!allowed) conflict()
  }
  async #evidence(
    workspaceId: string,
    intentId: string,
    principalId: string
  ): Promise<VerifiedPiLeadIntentEvidence> {
    z.uuid().parse(intentId)
    const evidence = VerifiedPiLeadIntentEvidenceSchema.parse(
      await this.options.product.readCurrent({
        schemaVersion: 'pi-lead-intent/v1',
        intentId,
        workspaceId,
        principalId,
      })
    )
    if (
      evidence.intentId !== intentId ||
      evidence.workspaceId !== workspaceId ||
      !evidence.allowedPrincipalIds.includes(principalId)
    )
      denied()
    if (Date.parse(evidence.expiresAt) <= Date.parse(this.#now()))
      throw new PiDurableLeadError('PI_LEAD_DEADLINE_EXPIRED')
    return evidence
  }
  async #safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof PiDurableLeadError) throw error
      throw new PiDurableLeadError('PI_LEAD_UNAVAILABLE')
    }
  }
}
function project(
  current: CanonicalPiDurableAdmission,
  intent: CanonicalLeadIntent
): PiDurableLeadAdmission {
  return Object.freeze({
    schemaVersion: 'pi-lead-authority/v1',
    intentId: intent.intentId,
    workspaceId: intent.workspaceId,
    allowedPrincipalIds: current.allowedPrincipalIds,
    admissionDigest: current.admissionDigest,
    deadlineAt: current.deadlineAt,
    admittedAttempt: Object.freeze({
      executionId: intent.executionId,
      attemptId: intent.attemptId,
      executionPlanId: current.startRequest.executionPlan.executionPlanId,
      executionPlanDigest: current.startRequest.executionPlan.contentDigest,
    }),
    startRequest: current.startRequest,
  })
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
