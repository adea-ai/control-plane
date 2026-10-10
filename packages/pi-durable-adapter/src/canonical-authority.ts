import { createHash } from 'node:crypto'
import {
  IdentifierSchemas,
  executionScopeFields,
  executionScopesEqual,
  validateExecutionScopeFields,
} from '@control-plane/contracts'
import {
  ExecutionSchema,
  ExecutionAttemptSchema,
  type Execution,
  type ExecutionAttempt,
  type ExecutionRepository,
} from '@control-plane/domain'
import {
  assertExecutionPlanIntegrity,
  type ExecutionPlan,
  type ExecutionPlanRepository,
} from '@control-plane/execution-plan'
import {
  RuntimeAttemptBudgetAuthoritySchema,
  RuntimeStartRequestSchema,
  type RuntimeAttemptBudgetAuthority,
  type RuntimeStartRequest,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'
import {
  PiDurableAdmissionSchema,
  ProviderSelectionReferenceSchema,
  type PiDurableAdmission,
  type DurableExecutionAuthority,
} from './contracts.js'
import {
  authoritativeDenial,
  authorityOutcome,
  transientAuthorityFailure,
} from './authority-outcome.js'

const ReferenceSchema = z.string().min(1).max(256)
const AudienceSchema = z
  .array(ReferenceSchema)
  .min(1)
  .max(256)
  .refine((values) => new Set(values).size === values.length)
const CanonicalLeadIntentSchema = z
  .object({
    intentId: z.uuid(),
    ...executionScopeFields,
    canonicalActorPrincipalId: ReferenceSchema.optional(),
    messageRef: ReferenceSchema,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    authorityRevision: z.number().int().positive(),
    principalRef: ReferenceSchema,
    scopeRef: ReferenceSchema,
    expiresAt: z.iso.datetime(),
    ...ProviderSelectionReferenceSchema.shape,
    allowedPrincipalIds: AudienceSchema,
  })
  .strict()
  .superRefine(validateExecutionScopeFields)
  .superRefine((intent, context) => {
    if (intent.executionScope !== undefined && !intent.canonicalActorPrincipalId)
      context.addIssue({
        code: 'custom',
        message: 'Explicit scope requires canonical product actor',
      })
  })
const CanonicalLeadMessageAuthoritySchema = z
  .object({
    prompt: PiDurableAdmissionSchema.shape.prompt,
    authorityRevision: CanonicalLeadIntentSchema.shape.authorityRevision,
    principalRef: ReferenceSchema,
    scopeRef: ReferenceSchema,
    expiresAt: z.iso.datetime(),
    allowedPrincipalIds: AudienceSchema,
  })
  .strict()

export type CanonicalLeadIntent = z.output<typeof CanonicalLeadIntentSchema>
export type CanonicalLeadMessageAuthority = z.output<typeof CanonicalLeadMessageAuthoritySchema>

/** Server-verified product intent and the CP mapping persisted during admission. */
export interface CanonicalLeadIntentReader {
  get(intentId: string): Promise<CanonicalLeadIntent | undefined>
  getByAttempt(attemptId: string): Promise<CanonicalLeadIntent | undefined>
}

/**
 * Trusted versioned product port. It must bind the intent's workspace/project,
 * messageRef, channel lead and current audience before returning the prompt.
 * Deleted messages, revoked grants or a replaced lead return no authority.
 * Implementations must not accept client prompt/configuration as canonical data.
 */
export interface CanonicalLeadMessageReader {
  readCurrent(intent: CanonicalLeadIntent): Promise<CanonicalLeadMessageAuthority | undefined>
}

export type CanonicalPiDurableAuthorityPurpose = 'inference' | 'read'

export interface CanonicalPiDurableAuthorityOptions {
  readonly intents: CanonicalLeadIntentReader
  readonly executions: Pick<ExecutionRepository, 'getExecution' | 'getAttempt'>
  readonly plans: Pick<ExecutionPlanRepository, 'get'>
  readonly messages: CanonicalLeadMessageReader
  readonly budgets: {
    /** Reads the existing canonical accepted allowance/reservation, never caller ceilings. */
    resolve(input: {
      execution: Execution
      attempt: ExecutionAttempt
      plan: ExecutionPlan
      purpose: CanonicalPiDurableAuthorityPurpose
    }): Promise<RuntimeAttemptBudgetAuthority>
  }
  readonly now?: () => string
}

/** The admission digest the canonical derivation commits to. Exported so the lead fence can verify
 * a retained receipt from retained authority alone, without re-reading the withheld prompt. */
export function canonicalAdmissionDigest(input: {
  readonly startRequest: RuntimeStartRequest
  readonly admission: PiDurableAdmission
  readonly allowedPrincipalIds: readonly string[]
  readonly deadlineAt: string
}): string {
  return digest(input)
}

export interface CanonicalPiDurableAdmission {
  readonly startRequest: RuntimeStartRequest
  readonly admission: PiDurableAdmission
  readonly allowedPrincipalIds: readonly string[]
  readonly deadlineAt: string
  readonly admissionDigest: string
}

/** Re-derives authority at every boundary; contains no process-local intent map. */
export class CanonicalPiDurableAuthority {
  constructor(readonly options: CanonicalPiDurableAuthorityOptions) {}

  async get(
    intentId: string,
    workspaceId: string,
    principalId: string,
    purpose: CanonicalPiDurableAuthorityPurpose = 'inference'
  ): Promise<CanonicalPiDurableAdmission> {
    return this.#safe(async () => {
      z.uuid().parse(intentId)
      const intent = CanonicalLeadIntentSchema.parse(await this.options.intents.get(intentId))
      if (intent.intentId !== intentId || intent.workspaceId !== workspaceId) reject()
      const result = await this.#derive(intent, purpose)
      if (!result.allowedPrincipalIds.includes(principalId)) reject()
      return result
    })
  }

  async resolveAdmission(request: RuntimeStartRequest): Promise<PiDurableAdmission> {
    return this.#safe(async () => (await this.#fromRequest(request)).admission)
  }

  async assertAuthority(authority: DurableExecutionAuthority): Promise<void> {
    return this.#safe(async () => {
      const resolved = await this.#fromRequest(authority.request)
      const admission = PiDurableAdmissionSchema.parse(authority.admission)
      if (digest(resolved.admission) !== digest(admission)) reject()
    })
  }

  async #fromRequest(input: RuntimeStartRequest): Promise<CanonicalPiDurableAdmission> {
    const request = RuntimeStartRequestSchema.parse(input)
    const intent = CanonicalLeadIntentSchema.parse(
      await this.options.intents.getByAttempt(request.attemptId)
    )
    if (intent.attemptId !== request.attemptId) reject()
    const resolved = await this.#derive(intent)
    if (digest(resolved.startRequest) !== digest(request)) reject()
    return resolved
  }

  async #derive(
    intent: CanonicalLeadIntent,
    purpose: CanonicalPiDurableAuthorityPurpose = 'inference'
  ): Promise<CanonicalPiDurableAdmission> {
    const [executionInput, attemptInput] = await Promise.all([
      this.options.executions.getExecution(intent.executionId),
      this.options.executions.getAttempt(intent.attemptId),
    ])
    const execution = ExecutionSchema.parse(executionInput)
    const attempt = ExecutionAttemptSchema.parse(attemptInput)
    assertLifecycle(intent, execution, attempt, purpose)
    const plan = assertExecutionPlanIntegrity(
      await this.options.plans.get({
        executionPlanId: execution.executionPlan.executionPlanId,
        contentDigest: execution.executionPlan.contentDigest,
      })
    )
    if (
      plan.schemaVersion !== execution.executionPlan.schemaVersion ||
      plan.executionPlanId !== execution.executionPlan.executionPlanId ||
      plan.contentDigest !== execution.executionPlan.contentDigest ||
      digest(plan.correlation) !== digest(execution.correlation)
    )
      reject()
    const [messageInput, budgetInput] = await Promise.all([
      this.options.messages.readCurrent(structuredClone(intent)),
      this.options.budgets.resolve({
        execution: structuredClone(execution),
        attempt: structuredClone(attempt),
        plan: structuredClone(plan),
        purpose,
      }),
    ])
    const message = CanonicalLeadMessageAuthoritySchema.parse(messageInput)
    if (
      message.authorityRevision !== intent.authorityRevision ||
      message.principalRef !== intent.principalRef ||
      message.scopeRef !== intent.scopeRef ||
      message.expiresAt !== intent.expiresAt ||
      digest([...message.allowedPrincipalIds].toSorted()) !==
        digest([...intent.allowedPrincipalIds].toSorted())
    )
      reject()
    const budget = RuntimeAttemptBudgetAuthoritySchema.parse(budgetInput)
    const startRequest = RuntimeStartRequestSchema.parse({
      executionId: execution.executionId,
      attemptId: attempt.attemptId,
      idempotencyKey: `lead-turn:${intent.intentId}`,
      executionPlan: plan,
      attemptBudget: budget,
    })
    const admission = PiDurableAdmissionSchema.parse({
      schemaVersion: 'pi-durable-admission/v1',
      prompt: message.prompt,
      selection: { selectionRef: intent.selectionRef, selectionRevision: intent.selectionRevision },
      ...(intent.executionScope !== undefined
        ? { canonicalActorPrincipalId: intent.canonicalActorPrincipalId }
        : {}),
      authority: {
        revision: intent.authorityRevision,
        principalRef: intent.principalRef,
        scopeRef: intent.scopeRef,
        expiresAt: intent.expiresAt,
      },
    })
    // Catch a superseding attempt or cancellation while trusted ports were awaited.
    const [latestExecution, latestAttempt] = await Promise.all([
      this.options.executions.getExecution(intent.executionId),
      this.options.executions.getAttempt(intent.attemptId),
    ])
    const currentExecution = ExecutionSchema.parse(latestExecution)
    const currentAttempt = ExecutionAttemptSchema.parse(latestAttempt)
    assertLifecycle(intent, currentExecution, currentAttempt, purpose)
    if (digest(currentExecution.executionPlan) !== digest(execution.executionPlan)) reject()
    const deadlineAt = [intent.expiresAt, currentExecution.deadlineAt, currentAttempt.deadlineAt]
      .filter((value): value is string => value !== undefined)
      .toSorted((left, right) => Date.parse(left) - Date.parse(right))[0]!
    const now = Date.parse(z.iso.datetime().parse(this.options.now?.() ?? new Date().toISOString()))
    if (now >= Date.parse(purpose === 'read' ? intent.expiresAt : deadlineAt)) reject()
    const allowedPrincipalIds = [...message.allowedPrincipalIds].toSorted()
    return freeze({
      startRequest,
      admission,
      allowedPrincipalIds,
      deadlineAt,
      admissionDigest: canonicalAdmissionDigest({
        startRequest,
        admission,
        allowedPrincipalIds,
        deadlineAt,
      }),
    })
  }

  async #safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      // Only this module's own policy decisions keep the denial classification.
      if (error instanceof Error && policyDenials.has(error)) throw error
      throw publicFailure(error)
    }
  }
}

function assertLifecycle(
  intent: CanonicalLeadIntent,
  execution: Execution,
  attempt: ExecutionAttempt,
  purpose: CanonicalPiDurableAuthorityPurpose
): void {
  const active = [
    'accepted',
    'queued',
    'starting',
    'running',
    'awaiting_input',
    'reconciliation_required',
  ]
  if (purpose === 'read') active.push('completed', 'failed', 'cancelled', 'timed_out', 'cancelling')
  if (
    execution.executionId !== intent.executionId ||
    execution.latestAttemptId !== intent.attemptId ||
    !executionScopesEqual(execution.correlation, intent) ||
    attempt.attemptId !== intent.attemptId ||
    attempt.executionId !== execution.executionId ||
    attempt.sequence !== execution.attemptCount ||
    !active.includes(execution.state) ||
    !active.includes(attempt.state)
  )
    reject()
}
// Denials decided by this module's own policy checks. A port or transport failure never enters.
const policyDenials = new WeakSet<Error>()

function reject(): never {
  const error = authoritativeDenial(new Error('PI_CANONICAL_AUTHORITY_REJECTED'))
  policyDenials.add(error)
  throw error
}

// Sanitized public rejection for every failure that is not an explicit local decision. The public
// message is unchanged. Only the internal outcome separates a transient port failure from a denial.
function publicFailure(error: unknown): Error {
  const failure = new Error('PI_CANONICAL_AUTHORITY_REJECTED')
  return authorityOutcome(error) === 'unavailable' ? transientAuthorityFailure(failure) : failure
}
function digest(input: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(input)).digest('hex')}`
}
function canonical(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`
  if (input !== null && typeof input === 'object')
    return `{${Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
      .join(',')}}`
  return JSON.stringify(input)
}
function freeze<T>(input: T): T {
  if (input !== null && typeof input === 'object') {
    for (const value of Object.values(input)) freeze(value)
    Object.freeze(input)
  }
  return input
}
