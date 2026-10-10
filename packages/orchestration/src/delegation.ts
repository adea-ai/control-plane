import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { compareCodePointOrder } from '@control-plane/contracts'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  ExecutionLifecycleError,
  ExecutionAttemptSchema,
  ExecutionSchema,
  previewLifecycleTransition,
  type Execution,
  type ExecutionAttempt,
  type ExecutionLifecycleService,
} from '@control-plane/domain'
import {
  ExecutionPlanSchema,
  deriveExecutionPlan,
  deriveExecutionPlanWithAuthority,
  currentExecutionScopeAllows,
  type ExecutionPlan,
  type ExecutionGraphAuthority,
  type ExecutionPlanRepository,
  type CurrentExecutionScopeAuthority,
} from '@control-plane/execution-plan'
import { z } from 'zod'
import {
  assertChildAdmissionReceiptMatches,
  ChildAdmissionRequestSchema,
  ChildAdmissionAllocationError,
  type ChildAdmissionAllocator,
  type ChildAdmissionAuthority,
} from './child-admission.js'

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const ReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)

export const DelegationPolicySchema = z
  .object({
    cancellation: z.enum(['cascade', 'independent']),
    deadline: z.enum(['bounded_by_parent', 'independent_within_plan']),
    failure: z.enum(['retry', 'fallback', 'allow_partial', 'manual', 'fail_parent']),
    maximumRetries: z.number().int().nonnegative().max(100),
  })
  .strict()

export const ChildProgressInputSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
    childAttemptId: IdentifierSchemas.attemptId,
    state: z.enum(['running', 'awaiting_input', 'completed', 'failed', 'cancelled']),
    observedAt: TimestampSchema,
    terminalResultRef: IdentifierSchemas.artifactId.optional(),
    failure: z
      .object({
        classification: z.enum([
          'validation',
          'policy',
          'runtime_unavailable',
          'runtime_error',
          'infrastructure',
          'timeout',
          'cancelled',
          'unknown',
        ]),
        code: ReferenceSchema,
        retryable: z.boolean(),
        fallbackAvailable: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.state === 'completed' && !input.terminalResultRef) {
      context.addIssue({ code: 'custom', message: 'Completed child requires a result artifact' })
    }
    if (input.state === 'failed' && !input.failure) {
      context.addIssue({ code: 'custom', message: 'Failed child requires failure metadata' })
    }
    if (input.state !== 'completed' && input.terminalResultRef) {
      context.addIssue({ code: 'custom', message: 'Only completed child may have a result' })
    }
    if (input.state !== 'failed' && input.failure) {
      context.addIssue({ code: 'custom', message: 'Only failed child may have failure metadata' })
    }
  })

export type ChildProgressInput = z.output<typeof ChildProgressInputSchema>

export const DispatchInputSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
    childAttemptId: IdentifierSchemas.attemptId,
    runtime: z
      .object({
        runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
        runtimeDefinitionId: IdentifierSchemas.runtimeDefinitionId.optional(),
        externalSessionId: IdentifierSchemas.externalSessionId.optional(),
        runtimeNodeRefId: IdentifierSchemas.runtimeNodeRefId.optional(),
      })
      .strict(),
    dispatchedAt: TimestampSchema,
  })
  .strict()

export const DelegationRecordSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
    delegationGroupId: IdentifierSchemas.delegationGroupId.optional(),
    parentExecutionId: IdentifierSchemas.executionId,
    parentAttemptId: IdentifierSchemas.attemptId.optional(),
    admittedToolCallId: IdentifierSchemas.toolCallId.optional(),
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId.optional(),
    parentExecutionPlanId: IdentifierSchemas.executionPlanId,
    parentExecutionPlanDigest: DigestSchema,
    childExecutionPlanId: IdentifierSchemas.executionPlanId,
    childExecutionPlanDigest: DigestSchema,
    contextPackageId: IdentifierSchemas.contextPackageId,
    contextPackageDigest: DigestSchema,
    role: ReferenceSchema,
    profileVersionId: IdentifierSchemas.profileVersionId,
    objective: z.string().min(1).max(8_192),
    policy: DelegationPolicySchema,
    state: z.enum([
      'requested',
      'dispatched',
      'running',
      'awaiting_input',
      'completed',
      'failed',
      'cancelled',
      'manual_intervention',
    ]),
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId.optional(),
    retryCount: z.number().int().nonnegative(),
    inputDigest: DigestSchema,
    revision: z.number().int().positive(),
    acceptedAt: TimestampSchema,
    deadlineAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema,
    terminalResultRef: IdentifierSchemas.artifactId.optional(),
    failureCode: ReferenceSchema.optional(),
    pendingProgress: ChildProgressInputSchema.optional(),
    pendingDispatch: DispatchInputSchema.optional(),
    pendingCancellationAt: TimestampSchema.optional(),
    terminalPublication: z
      .object({
        status: z.enum(['pending', 'published']),
        idempotencyKey: ReferenceSchema,
        resolution: z.enum(['continue_parent', 'manual_intervention', 'fail_parent']).optional(),
        reason: z.literal('parent_cancelled').optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.admittedToolCallId && !record.parentAttemptId)
      context.addIssue({
        code: 'custom',
        message: 'Governed child requires its admitted parent attempt',
      })
    if (record.parentExecutionId === record.childExecutionId) {
      context.addIssue({ code: 'custom', message: 'Delegation cannot target its parent execution' })
    }
    if (
      record.pendingProgress &&
      (record.pendingProgress.delegationId !== record.delegationId ||
        record.pendingProgress.childAttemptId !== record.childAttemptId ||
        !['completed', 'failed', 'cancelled'].includes(record.pendingProgress.state))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Pending outcome must bind the admitted child attempt',
      })
    }
    if (
      record.pendingDispatch &&
      (record.pendingDispatch.delegationId !== record.delegationId || record.state !== 'requested')
    )
      context.addIssue({
        code: 'custom',
        message: 'Dispatch intent must bind requested delegation',
      })
    const terminal = ['completed', 'failed', 'cancelled'].includes(record.state)
    if (
      record.terminalPublication &&
      (!terminal ||
        record.terminalPublication.idempotencyKey !== terminalPublicationKey(record) ||
        (record.terminalPublication.resolution && record.state !== 'failed') ||
        (record.terminalPublication.reason && record.state !== 'cancelled'))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Publication must bind the retained terminal outcome',
      })
    }
    if (record.terminalResultRef && record.state !== 'completed') {
      context.addIssue({ code: 'custom', message: 'Only completed delegation may have a result' })
    }
    if (record.failureCode && !['failed', 'manual_intervention'].includes(record.state)) {
      context.addIssue({ code: 'custom', message: 'Failure code requires failed delegation state' })
    }
    if (terminal && record.updatedAt < record.acceptedAt) {
      context.addIssue({ code: 'custom', message: 'Terminal delegation cannot predate acceptance' })
    }
  })

export type DelegationRecord = z.output<typeof DelegationRecordSchema>

export interface DelegationRepository {
  insert(record: DelegationRecord): Promise<boolean>
  get(delegationId: string): Promise<DelegationRecord | undefined>
  findByChild(childExecutionId: string): Promise<DelegationRecord | undefined>
  listByParent(parentExecutionId: string): Promise<readonly DelegationRecord[]>
  compareAndSet(expectedRevision: number, record: DelegationRecord): Promise<boolean>
}

export class InMemoryDelegationRepository implements DelegationRepository {
  readonly #records = new Map<string, DelegationRecord>()

  async insert(record: DelegationRecord): Promise<boolean> {
    if (
      this.#records.has(record.delegationId) ||
      [...this.#records.values()].some(
        ({ childExecutionId }) => childExecutionId === record.childExecutionId
      )
    ) {
      return false
    }
    this.#records.set(record.delegationId, structuredClone(record))
    return true
  }

  async get(delegationId: string): Promise<DelegationRecord | undefined> {
    const record = this.#records.get(delegationId)
    return record ? structuredClone(record) : undefined
  }

  async findByChild(childExecutionId: string): Promise<DelegationRecord | undefined> {
    const record = [...this.#records.values()].find(
      (candidate) => candidate.childExecutionId === childExecutionId
    )
    return record ? structuredClone(record) : undefined
  }

  async listByParent(parentExecutionId: string): Promise<readonly DelegationRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.parentExecutionId === parentExecutionId)
      .toSorted((left, right) => compareCodePointOrder(left.delegationId, right.delegationId))
      .map((record) => structuredClone(record))
  }

  async compareAndSet(expectedRevision: number, record: DelegationRecord): Promise<boolean> {
    const current = this.#records.get(record.delegationId)
    if (
      current?.revision !== expectedRevision ||
      current.parentExecutionId !== record.parentExecutionId ||
      current.childExecutionId !== record.childExecutionId ||
      current.inputDigest !== record.inputDigest
    ) {
      return false
    }
    this.#records.set(record.delegationId, structuredClone(record))
    return true
  }
}

export interface DelegationEvent {
  readonly type:
    | 'delegation.requested'
    | 'delegation.dispatched'
    | 'delegation.progress'
    | 'delegation.completed'
    | 'delegation.failed'
    | 'delegation.cancelled'
  readonly delegationId: string
  readonly parentExecutionId: string
  readonly childExecutionId: string
  readonly occurredAt: string
  readonly details: Readonly<Record<string, unknown>>
}

/** Composition binds one canonical parent. Reads never acknowledge or remove evidence. */
export interface DelegationParentInbox {
  list(): Promise<readonly DelegationEvent[]>
}

export interface DelegationEventPublisher {
  /** Atomically retain/deduplicate terminal events by this key before acknowledging them. */
  publish(event: DelegationEvent, idempotencyKey: string): Promise<void>
}

/** Public delegation evidence contains identifiers and bounded state, never prompt/auth payloads. */
export const DelegationEventSchema = z
  .object({
    type: z.enum([
      'delegation.requested',
      'delegation.dispatched',
      'delegation.progress',
      'delegation.completed',
      'delegation.failed',
      'delegation.cancelled',
    ]),
    delegationId: IdentifierSchemas.delegationId,
    parentExecutionId: IdentifierSchemas.executionId,
    childExecutionId: IdentifierSchemas.executionId,
    occurredAt: TimestampSchema,
    details: z
      .object({
        state: DelegationRecordSchema.shape.state.optional(),
        runtimeConnectionId: IdentifierSchemas.runtimeConnectionId.optional(),
        childAttemptId: IdentifierSchemas.attemptId.optional(),
        terminalResultRef: IdentifierSchemas.artifactId.optional(),
        failureCode: ReferenceSchema.optional(),
        reason: z.literal('parent_cancelled').optional(),
        resolution: z
          .enum(['retry', 'fallback', 'continue_parent', 'manual_intervention', 'fail_parent'])
          .optional(),
      })
      .strict(),
  })
  .strict()

export type DelegationErrorCode =
  | 'DELEGATION_NOT_FOUND'
  | 'DELEGATION_CONFLICT'
  | 'DELEGATION_LIMIT_EXCEEDED'
  | 'DELEGATION_DEPTH_EXCEEDED'
  | 'PARENT_PLAN_MISMATCH'
  | 'PROFILE_EXPANSION'
  | 'CHILD_DEADLINE_EXPANSION'
  | 'DELEGATION_STATE_CONFLICT'
  | 'DELEGATION_ATTEMPT_MISMATCH'
  | 'GRAPH_ADMISSION_DENIED'
  | 'SCOPE_ADMISSION_DENIED'
  | 'CHILD_ADMISSION_UNAVAILABLE'
  | 'CHILD_ADMISSION_DENIED'
  | 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED'

export class DelegationError extends Error {
  constructor(readonly code: DelegationErrorCode) {
    super(code)
    this.name = 'DelegationError'
  }
}

export const DelegateInputSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
    delegationGroupId: IdentifierSchemas.delegationGroupId.optional(),
    parentIntentId: ReferenceSchema.optional(),
    parentExecutionId: IdentifierSchemas.executionId,
    parentAttemptId: IdentifierSchemas.attemptId.optional(),
    admittedToolCallId: IdentifierSchemas.toolCallId.optional(),
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId.optional(),
    initialDispatch: DispatchInputSchema.optional(),
    role: ReferenceSchema,
    profileVersionId: IdentifierSchemas.profileVersionId,
    objective: z.string().min(1).max(8_192),
    parentPlan: ExecutionPlanSchema,
    childPlan: z.unknown(),
    policy: DelegationPolicySchema,
    acceptedAt: TimestampSchema,
    deadlineAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.admittedToolCallId && !input.parentAttemptId)
      context.addIssue({
        code: 'custom',
        message: 'Governed child requires its admitted parent attempt',
      })
    if (input.admittedToolCallId && !input.parentIntentId)
      context.addIssue({
        code: 'custom',
        message: 'Governed child requires its server-bound parent product intent',
      })
    if (input.admittedToolCallId && !input.childAttemptId)
      context.addIssue({
        code: 'custom',
        message: 'Governed child requires a stable child attempt ID',
      })
  })

export type ChildProgressOutcome = {
  readonly record: DelegationRecord
  readonly resolution?: ReturnType<typeof decideDelegationFailure>
}

/** Trusted server composition. Resolve the original actor from canonical admission;
 * neither the model's input nor a transport service principal supplies authority. */
export interface DelegationScopeAdmission {
  readonly authority: CurrentExecutionScopeAuthority
  readonly resolveCallerPrincipalId: (
    input: z.output<typeof DelegateInputSchema>
  ) => Promise<string>
  readonly now: () => string
}

export class DelegationService {
  readonly #delegations: DelegationRepository
  readonly #lifecycle: ExecutionLifecycleService
  readonly #plans: ExecutionPlanRepository
  readonly #events: DelegationEventPublisher
  readonly #graphs: ExecutionGraphAuthority | undefined
  readonly #scopeAdmission: DelegationScopeAdmission | undefined
  readonly #childAdmission: ChildAdmissionAuthority | undefined
  readonly #childAllocator: ChildAdmissionAllocator | undefined
  readonly #onEventRetained: ((event: DelegationEvent) => Promise<void>) | undefined

  constructor(options: {
    readonly delegations: DelegationRepository
    readonly lifecycle: ExecutionLifecycleService
    readonly plans: ExecutionPlanRepository
    readonly events: DelegationEventPublisher
    readonly graphs?: ExecutionGraphAuthority
    readonly scopeAdmission?: DelegationScopeAdmission
    readonly childAdmission?: ChildAdmissionAuthority
    readonly childAllocator?: ChildAdmissionAllocator
    /** Advisory wake after the parent inbox has durably retained the event. */
    readonly onEventRetained?: (event: DelegationEvent) => Promise<void>
  }) {
    this.#delegations = options.delegations
    this.#lifecycle = options.lifecycle
    this.#plans = options.plans
    this.#events = options.events
    this.#graphs = options.graphs
    this.#scopeAdmission = options.scopeAdmission
    this.#childAdmission = options.childAdmission
    this.#childAllocator = options.childAllocator
    this.#onEventRetained = options.onEventRetained
  }

  deriveChildPlan(parentPlan: unknown, childPlan: unknown): ExecutionPlan {
    return deriveExecutionPlan(ExecutionPlanSchema.parse(parentPlan), childPlan)
  }

  async delegate(input: unknown): Promise<{
    readonly record: DelegationRecord
    readonly execution: Execution
    readonly plan: ExecutionPlan
  }> {
    const parsed = DelegateInputSchema.parse(input)
    // initialDispatch is transport routing attached at delegate() time, not
    // delegation identity: the child-continuation repository recomputes the
    // input digest over the stored admission command's plain delegation, and
    // idempotent replay compares records across that same shape.
    const { initialDispatch: _, ...delegationInput } = parsed
    // Dual-accept (#612): records persisted before the code-point cutover
    // carry the legacy locale-dependent digest of the same delegation.
    const inputDigest = digestV2(delegationInput)
    const legacyInputDigest = digest(delegationInput)
    const existing = await this.#delegations.get(parsed.delegationId)
    if (existing) {
      if (existing.inputDigest !== inputDigest && existing.inputDigest !== legacyInputDigest)
        throw new DelegationError('DELEGATION_CONFLICT')
      const execution = await this.#lifecycle.getExecution(existing.childExecutionId)
      const plan = await this.#plans.get({
        executionPlanId: existing.childExecutionPlanId,
        contentDigest: existing.childExecutionPlanDigest,
      })
      if (!plan) throw new DelegationError('DELEGATION_CONFLICT')
      await this.#assertCurrentScope(parsed, plan)
      if (
        plan.graph &&
        !(await this.#graphs?.authorize(plan.correlation.workspaceId, plan.graph.reference))
      ) {
        throw new DelegationError('GRAPH_ADMISSION_DENIED')
      }
      if (plan.graph) await this.#assertCurrentScope(parsed, plan)
      return { record: existing, execution, plan }
    }

    const parent = await this.#lifecycle.getExecution(parsed.parentExecutionId)
    assertParentPlan(parent, parsed.parentPlan)
    if (parsed.parentAttemptId && parent.latestAttemptId !== parsed.parentAttemptId)
      throw new DelegationError('DELEGATION_ATTEMPT_MISMATCH')
    if (parsed.profileVersionId !== parsed.parentPlan.profile.profileVersionId) {
      throw new DelegationError('PROFILE_EXPANSION')
    }
    const siblings = await this.#delegations.listByParent(parsed.parentExecutionId)
    if (siblings.length >= parsed.parentPlan.constraints.limits.childExecutions.maximumTotal) {
      throw new DelegationError('DELEGATION_LIMIT_EXCEEDED')
    }
    if (
      (await this.#parentDepth(parsed.parentExecutionId)) >=
      parsed.parentPlan.constraints.limits.childExecutions.maximumDepth
    ) {
      throw new DelegationError('DELEGATION_DEPTH_EXCEEDED')
    }

    const plan = await this.#deriveChildPlan(parsed)
    assertDeadline(parent, plan, parsed.acceptedAt, parsed.deadlineAt, parsed.policy.deadline)
    if (plan.graph && !(await this.#graphs?.validate(plan.correlation.workspaceId, plan.graph))) {
      throw new DelegationError('GRAPH_ADMISSION_DENIED')
    }
    // Graph resolution can await external work; re-read current scope before writes.
    await this.#assertCurrentScope(parsed, plan)
    const currentParent = await this.#lifecycle.getExecution(parsed.parentExecutionId)
    assertParentPlan(currentParent, parsed.parentPlan)
    if (parsed.parentAttemptId && currentParent.latestAttemptId !== parsed.parentAttemptId)
      throw new DelegationError('DELEGATION_ATTEMPT_MISMATCH')
    if (
      parsed.parentPlan.schemaVersion === 2 &&
      ['completed', 'failed', 'cancelled', 'timed_out'].includes(currentParent.state)
    )
      throw new DelegationError('DELEGATION_STATE_CONFLICT')

    // Governed child calls must pass the product's current actor/audience,
    // selection, and readiness checks before any durable child allocation.
    // This is deliberately before plan retention, execution creation, budget
    // opening, and delegation insertion. The repository transaction performs
    // its own canonical lineage and limit checks before committing allocation.
    let childAdmission:
      | {
          readonly request: z.output<typeof ChildAdmissionRequestSchema>
          readonly receipt: import('./child-admission.js').ChildAdmissionReceipt
        }
      | undefined
    if (parsed.admittedToolCallId) {
      if (
        !this.#childAdmission ||
        !this.#childAllocator ||
        !this.#scopeAdmission ||
        !parsed.parentAttemptId ||
        !parsed.parentIntentId ||
        !parsed.childAttemptId ||
        !parsed.initialDispatch ||
        parsed.initialDispatch.delegationId !== parsed.delegationId ||
        parsed.initialDispatch.childAttemptId !== parsed.childAttemptId
      ) {
        throw new DelegationError('CHILD_ADMISSION_UNAVAILABLE')
      }
      try {
        const callerPrincipalId = z
          .string()
          .min(1)
          .max(256)
          .parse(await this.#scopeAdmission.resolveCallerPrincipalId(structuredClone(parsed)))
        const request = ChildAdmissionRequestSchema.parse({
          workspaceId: plan.correlation.workspaceId,
          parentIntentId: parsed.parentIntentId,
          parentExecutionId: parsed.parentExecutionId,
          parentAttemptId: parsed.parentAttemptId,
          parentExecutionVersion: currentParent.version,
          parentPlan: {
            executionPlanId: parsed.parentPlan.executionPlanId,
            contentDigest: parsed.parentPlan.contentDigest,
            schemaVersion: parsed.parentPlan.schemaVersion,
          },
          admittedToolCallId: parsed.admittedToolCallId,
          delegationId: parsed.delegationId,
          childRequestId: plan.correlation.requestId,
          childExecutionId: parsed.childExecutionId,
          childAttemptId: parsed.childAttemptId,
          childDispatch: parsed.initialDispatch,
          childPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            schemaVersion: plan.schemaVersion,
          },
          role: parsed.role,
          profileVersionId: parsed.profileVersionId,
          originalActorPrincipalId: callerPrincipalId,
          childRequestDigest: inputDigest,
          acceptedAt: parsed.acceptedAt,
        })
        const receipt = assertChildAdmissionReceiptMatches(
          request,
          await this.#childAdmission.prepare(structuredClone(request)),
          this.#scopeAdmission.now()
        )
        await this.#childAdmission.assertCurrent(structuredClone(request), receipt)
        // Close the asynchronous authority window against the canonical parent
        // attempt/version before the first write. Storage adapters repeat this
        // fence while holding their allocation transaction.
        const latestParent = await this.#lifecycle.getExecution(parsed.parentExecutionId)
        assertParentPlan(latestParent, parsed.parentPlan)
        if (
          latestParent.version !== request.parentExecutionVersion ||
          latestParent.latestAttemptId !== request.parentAttemptId
        ) {
          throw new Error('CHILD_ADMISSION_PARENT_CHANGED')
        }
        const checkedAt = TimestampSchema.parse(this.#scopeAdmission.now())
        if (Date.parse(receipt.expiresAt) <= Date.parse(checkedAt)) {
          throw new Error('CHILD_ADMISSION_RECEIPT_EXPIRED')
        }
        childAdmission = { request, receipt }
      } catch {
        throw new DelegationError('CHILD_ADMISSION_DENIED')
      }
    }
    await this.#plans.put(plan)
    const record = DelegationRecordSchema.parse({
      delegationId: parsed.delegationId,
      ...(parsed.delegationGroupId ? { delegationGroupId: parsed.delegationGroupId } : {}),
      parentExecutionId: parsed.parentExecutionId,
      ...(parsed.parentAttemptId ? { parentAttemptId: parsed.parentAttemptId } : {}),
      ...(parsed.admittedToolCallId ? { admittedToolCallId: parsed.admittedToolCallId } : {}),
      childExecutionId: parsed.childExecutionId,
      ...(parsed.childAttemptId && !childAdmission
        ? { childAttemptId: parsed.childAttemptId }
        : {}),
      ...(childAdmission ? { pendingDispatch: childAdmission.request.childDispatch } : {}),
      parentExecutionPlanId: parsed.parentPlan.executionPlanId,
      parentExecutionPlanDigest: parsed.parentPlan.contentDigest,
      childExecutionPlanId: plan.executionPlanId,
      childExecutionPlanDigest: plan.contentDigest,
      contextPackageId: plan.contextPackage.contextPackageId,
      contextPackageDigest: plan.contextPackage.contentDigest,
      role: parsed.role,
      profileVersionId: parsed.profileVersionId,
      objective: parsed.objective,
      policy: parsed.policy,
      state: 'requested',
      retryCount: 0,
      inputDigest,
      revision: 1,
      acceptedAt: parsed.acceptedAt,
      ...(parsed.deadlineAt ? { deadlineAt: parsed.deadlineAt } : {}),
      updatedAt: parsed.acceptedAt,
    })

    if (childAdmission) {
      const acceptedExecution = ExecutionSchema.parse({
        executionId: parsed.childExecutionId,
        correlation: plan.correlation,
        executionPlan: {
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
          schemaVersion: plan.schemaVersion,
        },
        parentExecutionId: parsed.parentExecutionId,
        acceptedAt: parsed.acceptedAt,
        ...(parsed.deadlineAt ? { deadlineAt: parsed.deadlineAt } : {}),
        state: 'accepted',
        version: 1,
        attemptCount: 0,
        createdAt: parsed.acceptedAt,
        updatedAt: parsed.acceptedAt,
      })
      const childDispatch = childAdmission.request.childDispatch
      const attempt = ExecutionAttemptSchema.parse({
        attemptId: parsed.childAttemptId,
        executionId: parsed.childExecutionId,
        sequence: 1,
        state: 'queued',
        version: 1,
        acceptedAt: parsed.acceptedAt,
        queuedAt: childDispatch.dispatchedAt,
        runtime: childDispatch.runtime,
        ...(parsed.deadlineAt ? { deadlineAt: parsed.deadlineAt } : {}),
        createdAt: parsed.acceptedAt,
        updatedAt: parsed.acceptedAt,
      })
      const queuedExecution = ExecutionSchema.parse({
        ...previewLifecycleTransition(acceptedExecution, {
          to: 'queued',
          transitionedAt: childDispatch.dispatchedAt,
        }),
        attemptCount: attempt.sequence,
        latestAttemptId: attempt.attemptId,
      })
      let allocated: boolean
      try {
        allocated = await this.#childAllocator!.allocate({
          request: structuredClone(childAdmission.request),
          receipt: structuredClone(childAdmission.receipt),
          execution: queuedExecution,
          attempt,
          delegation: record,
          assertCurrent: () =>
            this.#childAdmission!.assertCurrent(
              structuredClone(childAdmission!.request),
              structuredClone(childAdmission!.receipt)
            ),
        })
      } catch (error) {
        if (error instanceof ChildAdmissionAllocationError) {
          throw new DelegationError(error.code)
        }
        // Canonical admission validation failures raised inside the
        // allocation transaction (context ancestry, plan references) carry
        // their own failure code; preserve them so real composition errors
        // (e.g. CHILD_SCOPE_EXPANSION) keep their identity instead of
        // collapsing into CHILD_ADMISSION_DENIED. Errors without a code
        // remain fail-closed as CHILD_ADMISSION_DENIED.
        const coded = error as { code?: unknown }
        if (error instanceof Error && typeof coded.code === 'string') {
          throw error
        }
        throw new DelegationError('CHILD_ADMISSION_DENIED')
      }
      if (!allocated) {
        const replay = await this.#delegations.get(parsed.delegationId)
        if (
          !replay ||
          (replay.inputDigest !== inputDigest && replay.inputDigest !== legacyInputDigest) ||
          replay.childExecutionPlanId !== plan.executionPlanId ||
          replay.childExecutionPlanDigest !== plan.contentDigest
        ) {
          throw new DelegationError('DELEGATION_CONFLICT')
        }
        const existingExecution = await this.#lifecycle.getExecution(replay.childExecutionId)
        await this.#assertCurrentScope(parsed, plan)
        return { record: replay, execution: existingExecution, plan }
      }
      await this.#publish(record, 'delegation.requested', parsed.acceptedAt)
      return { record, execution: queuedExecution, plan }
    }

    const execution = await this.#createOrRecoverChild(parsed, plan)
    if (!(await this.#delegations.insert(record))) {
      const replay = await this.#delegations.get(parsed.delegationId)
      if (
        !replay ||
        (replay.inputDigest !== inputDigest && replay.inputDigest !== legacyInputDigest) ||
        replay.childExecutionPlanId !== plan.executionPlanId ||
        replay.childExecutionPlanDigest !== plan.contentDigest
      ) {
        throw new DelegationError('DELEGATION_CONFLICT')
      }
      await this.#assertCurrentScope(parsed, plan)
      return { record: replay, execution, plan }
    }
    await this.#publish(record, 'delegation.requested', parsed.acceptedAt)
    return { record, execution, plan }
  }

  async #scopeOptions(input: z.output<typeof DelegateInputSchema>) {
    if (!this.#scopeAdmission) throw new DelegationError('SCOPE_ADMISSION_DENIED')
    const callerPrincipalId = z
      .string()
      .min(1)
      .max(256)
      .parse(await this.#scopeAdmission.resolveCallerPrincipalId(structuredClone(input)))
    return {
      callerPrincipalId,
      authority: this.#scopeAdmission.authority,
      now: TimestampSchema.parse(this.#scopeAdmission.now()),
    }
  }

  async #deriveChildPlan(input: z.output<typeof DelegateInputSchema>): Promise<ExecutionPlan> {
    if (input.parentPlan.schemaVersion === 1) {
      const legacy = this.deriveChildPlan(input.parentPlan, input.childPlan)
      if (legacy.schemaVersion === 1) return legacy
    }
    return deriveExecutionPlanWithAuthority(
      input.parentPlan,
      input.childPlan,
      await this.#scopeOptions(input)
    )
  }

  async #assertCurrentScope(
    input: z.output<typeof DelegateInputSchema>,
    child: ExecutionPlan
  ): Promise<void> {
    if (input.parentPlan.schemaVersion === 1 && child.schemaVersion === 1) return
    const options = await this.#scopeOptions(input)
    for (const plan of [input.parentPlan, child]) {
      if (
        !(await currentExecutionScopeAllows(
          options.authority,
          {
            ...plan.correlation,
            callerPrincipalId: options.callerPrincipalId,
            executionPlan: {
              executionPlanId: plan.executionPlanId,
              contentDigest: plan.contentDigest,
              schemaVersion: plan.schemaVersion,
            },
          },
          options.now
        ))
      )
        throw new DelegationError('SCOPE_ADMISSION_DENIED')
    }
  }

  async dispatchChild(input: unknown): Promise<{
    readonly record: DelegationRecord
    readonly attempt: ExecutionAttempt
  }> {
    const parsed = DispatchInputSchema.parse(input)
    let record = await this.#required(parsed.delegationId)
    if (record.childAttemptId === parsed.childAttemptId) {
      const attempt = await this.#lifecycle.repository.getAttempt(parsed.childAttemptId)
      if (!attempt) throw new DelegationError('DELEGATION_STATE_CONFLICT')
      if (
        canonicalJsonStringify(attempt.runtime) !== canonicalJsonStringify(parsed.runtime) ||
        attempt.queuedAt !== parsed.dispatchedAt
      )
        throw new DelegationError('DELEGATION_STATE_CONFLICT')
      return { record, attempt }
    }
    if (record.state !== 'requested') throw new DelegationError('DELEGATION_STATE_CONFLICT')
    if (record.pendingProgress || record.pendingCancellationAt)
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
    if (
      record.pendingDispatch &&
      canonicalJsonStringify(record.pendingDispatch) !== canonicalJsonStringify(parsed)
    )
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
    const execution = await this.#lifecycle.getExecution(record.childExecutionId)
    const retainedAttempt = await this.#lifecycle.repository.getAttempt(parsed.childAttemptId)
    if (
      retainedAttempt &&
      (retainedAttempt.executionId !== record.childExecutionId ||
        canonicalJsonStringify(retainedAttempt.runtime) !==
          canonicalJsonStringify(parsed.runtime) ||
        retainedAttempt.queuedAt !== parsed.dispatchedAt ||
        retainedAttempt.state !== 'queued' ||
        execution.latestAttemptId !== retainedAttempt.attemptId)
    )
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
    if (
      !retainedAttempt &&
      (['completed', 'failed', 'cancelled', 'timed_out'].includes(execution.state) ||
        Date.parse(parsed.dispatchedAt) < Date.parse(execution.updatedAt))
    )
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
    if (execution.state === 'accepted')
      previewLifecycleTransition(execution, { to: 'queued', transitionedAt: parsed.dispatchedAt })
    if (!record.pendingDispatch) {
      const pending = DelegationRecordSchema.parse({
        ...record,
        pendingDispatch: parsed,
        revision: record.revision + 1,
      })
      if (!(await this.#delegations.compareAndSet(record.revision, pending)))
        throw new DelegationError('DELEGATION_STATE_CONFLICT')
      record = pending
    }
    const attempt =
      retainedAttempt ??
      (await this.#lifecycle.createAttempt({
        executionId: record.childExecutionId,
        attemptId: parsed.childAttemptId,
        expectedExecutionVersion: execution.version,
        queuedAt: parsed.dispatchedAt,
        ...(record.deadlineAt ? { deadlineAt: record.deadlineAt } : {}),
        runtime: parsed.runtime,
      }))
    const queuedExecution = await this.#lifecycle.getExecution(record.childExecutionId)
    if (queuedExecution.state === 'accepted') {
      await this.#lifecycle.transitionExecution({
        executionId: queuedExecution.executionId,
        expectedVersion: queuedExecution.version,
        to: 'queued',
        transitionedAt: parsed.dispatchedAt,
      })
    }
    const next = DelegationRecordSchema.parse({
      ...record,
      childAttemptId: attempt.attemptId,
      pendingDispatch: undefined,
      runtimeConnectionId: parsed.runtime.runtimeConnectionId,
      state: 'dispatched',
      revision: record.revision + 1,
      updatedAt: parsed.dispatchedAt,
    })
    if (!(await this.#delegations.compareAndSet(record.revision, next))) {
      const replay = await this.#required(parsed.delegationId)
      if (replay.childAttemptId !== parsed.childAttemptId) {
        throw new DelegationError('DELEGATION_STATE_CONFLICT')
      }
      return { record: replay, attempt }
    }
    await this.#publish(next, 'delegation.dispatched', parsed.dispatchedAt, {
      runtimeConnectionId: parsed.runtime.runtimeConnectionId,
      childAttemptId: attempt.attemptId,
    })
    return { record: next, attempt }
  }

  async recordChildProgress(input: unknown): Promise<ChildProgressOutcome> {
    const parsed = ChildProgressInputSchema.parse(input)
    let record = await this.#required(parsed.delegationId)
    if (record.pendingCancellationAt) throw new DelegationError('DELEGATION_STATE_CONFLICT')
    if (record.childAttemptId !== parsed.childAttemptId)
      throw new DelegationError('DELEGATION_ATTEMPT_MISMATCH')
    if (!record.childAttemptId) throw new DelegationError('DELEGATION_STATE_CONFLICT')

    if (['completed', 'failed', 'cancelled'].includes(record.state)) {
      if (
        record.state === parsed.state &&
        record.terminalResultRef === parsed.terminalResultRef &&
        record.failureCode === parsed.failure?.code
      ) {
        const published = await this.#publishTerminal(record)
        return { record: published }
      }
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
    }

    const attempt = await this.#lifecycle.repository.getAttempt(record.childAttemptId)
    if (!attempt || attempt.executionId !== record.childExecutionId)
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
    const execution = await this.#lifecycle.getExecution(record.childExecutionId)
    const resolution = parsed.failure
      ? decideDelegationFailure({
          policy: record.policy.failure,
          retryCount: record.retryCount,
          maximumRetries: record.policy.maximumRetries,
          retryable: parsed.failure.retryable,
          ...(parsed.failure.fallbackAvailable === undefined
            ? {}
            : { fallbackAvailable: parsed.failure.fallbackAvailable }),
        })
      : undefined

    const lifecycleState = parsed.state === 'failed' ? 'failed' : parsed.state
    const transitionMetadata = {
      ...(parsed.failure
        ? {
            failure: {
              classification: parsed.failure.classification,
              code: parsed.failure.code,
            },
          }
        : {}),
      ...(parsed.terminalResultRef ? { terminalResultRef: parsed.terminalResultRef } : {}),
    }
    const retrying = resolution === 'retry' || resolution === 'fallback'
    const manual = resolution === 'manual_intervention'
    const executionState = manual ? 'reconciliation_required' : lifecycleState
    if (attempt.state !== lifecycleState)
      previewLifecycleTransition(attempt, {
        to: lifecycleState,
        transitionedAt: parsed.observedAt,
        ...transitionMetadata,
      })
    if (!retrying && execution.state !== executionState)
      previewLifecycleTransition(execution, {
        to: executionState,
        transitionedAt: parsed.observedAt,
        ...transitionMetadata,
      })
    if (
      record.pendingProgress &&
      canonicalJsonStringify(record.pendingProgress) !== canonicalJsonStringify(parsed)
    )
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
    if (['completed', 'failed', 'cancelled'].includes(parsed.state) && !record.pendingProgress) {
      const pending = DelegationRecordSchema.parse({
        ...record,
        pendingProgress: parsed,
        revision: record.revision + 1,
      })
      if (!(await this.#delegations.compareAndSet(record.revision, pending)))
        throw new DelegationError('DELEGATION_STATE_CONFLICT')
      record = pending
    }
    if (attempt.state !== lifecycleState) {
      await this.#lifecycle.transitionAttempt({
        attemptId: attempt.attemptId,
        expectedVersion: attempt.version,
        to: lifecycleState,
        transitionedAt: parsed.observedAt,
        ...transitionMetadata,
      })
    }

    if (!retrying && execution.state !== executionState) {
      await this.#lifecycle.transitionExecution({
        executionId: execution.executionId,
        expectedVersion: execution.version,
        to: executionState,
        transitionedAt: parsed.observedAt,
        ...transitionMetadata,
      })
    }

    const state = retrying ? 'requested' : manual ? 'manual_intervention' : parsed.state
    const next = DelegationRecordSchema.parse({
      ...record,
      pendingProgress: undefined,
      state,
      revision: record.revision + 1,
      updatedAt: parsed.observedAt,
      retryCount: retrying ? record.retryCount + 1 : record.retryCount,
      ...(retrying
        ? { childAttemptId: undefined, runtimeConnectionId: undefined, failureCode: undefined }
        : {}),
      ...(parsed.terminalResultRef ? { terminalResultRef: parsed.terminalResultRef } : {}),
      ...(parsed.failure && !retrying ? { failureCode: parsed.failure.code } : {}),
      ...(['completed', 'failed', 'cancelled'].includes(state)
        ? {
            terminalPublication: {
              status: 'pending',
              idempotencyKey: terminalPublicationKey(record),
              ...(resolution ? { resolution } : {}),
            },
          }
        : {}),
    })
    if (!(await this.#delegations.compareAndSet(record.revision, next))) {
      const replay = await this.#required(parsed.delegationId)
      if (
        replay.state === state &&
        replay.updatedAt === parsed.observedAt &&
        replay.terminalResultRef === parsed.terminalResultRef &&
        replay.failureCode === (parsed.failure && !retrying ? parsed.failure.code : undefined)
      ) {
        const published = await this.#publishTerminal(replay)
        return { record: published, ...(resolution ? { resolution } : {}) }
      }
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
    }
    if (next.terminalPublication) {
      const published = await this.#publishTerminal(next)
      return { record: published, ...(resolution ? { resolution } : {}) }
    }
    const eventType = parsed.failure
      ? 'delegation.failed'
      : state === 'completed'
        ? 'delegation.completed'
        : state === 'cancelled'
          ? 'delegation.cancelled'
          : state === 'failed' || state === 'manual_intervention'
            ? 'delegation.failed'
            : 'delegation.progress'
    await this.#publish(next, eventType, parsed.observedAt, {
      state,
      ...(resolution ? { resolution } : {}),
      ...(parsed.terminalResultRef ? { terminalResultRef: parsed.terminalResultRef } : {}),
      ...(parsed.failure ? { failureCode: parsed.failure.code } : {}),
    })
    return { record: next, ...(resolution ? { resolution } : {}) }
  }

  listChildren(parentExecutionId: string): Promise<readonly DelegationRecord[]> {
    return this.#delegations.listByParent(IdentifierSchemas.executionId.parse(parentExecutionId))
  }

  /** Recovery can drain retained outcomes without invoking a parent model turn. */
  async reconcileChildPublications(
    parentExecutionId: string
  ): Promise<readonly DelegationRecord[]> {
    const records = await this.listChildren(parentExecutionId)
    const reconciled: DelegationRecord[] = []
    for (let record of records) {
      if (record.pendingDispatch) record = (await this.dispatchChild(record.pendingDispatch)).record
      if (record.pendingCancellationAt) {
        await this.#cancelChild(record, record.pendingCancellationAt)
        reconciled.push(await this.#required(record.delegationId))
        continue
      }
      reconciled.push(
        record.pendingProgress
          ? (await this.recordChildProgress(record.pendingProgress)).record
          : await this.#publishTerminal(record)
      )
    }
    return reconciled
  }

  async cancelChildren(input: {
    readonly parentExecutionId: string
    readonly cancelledAt: string
  }): Promise<readonly Execution[]> {
    const parentExecutionId = IdentifierSchemas.executionId.parse(input.parentExecutionId)
    const cancelledAt = TimestampSchema.parse(input.cancelledAt)
    const cancelled: Execution[] = []
    for (const record of await this.#delegations.listByParent(parentExecutionId)) {
      if (record.policy.cancellation !== 'cascade') continue
      if (['completed', 'failed', 'cancelled'].includes(record.state)) {
        // A crash may leave the canonical terminal state committed while its
        // parent-inbox publication is still pending. A repeated stop repairs
        // that receipt idempotently without cancelling or restarting the child.
        await this.#publishTerminal(record)
        continue
      }
      if (record.pendingProgress || record.pendingDispatch) {
        await this.reconcileChildPublications(parentExecutionId)
        const current = await this.#required(record.delegationId)
        if (['completed', 'failed', 'cancelled'].includes(current.state)) continue
        cancelled.push(
          await this.#cancelChild(current, current.pendingCancellationAt ?? cancelledAt)
        )
      } else
        cancelled.push(await this.#cancelChild(record, record.pendingCancellationAt ?? cancelledAt))
    }
    return cancelled
  }

  async #cancelChild(record: DelegationRecord, cancelledAt: string): Promise<Execution> {
    const execution = await this.#lifecycle.getExecution(record.childExecutionId)
    const attempts = await this.#lifecycle.repository.listAttempts(record.childExecutionId)
    const latest = attempts.at(-1)
    if (!record.pendingCancellationAt) {
      if (latest && !['completed', 'failed', 'cancelled', 'timed_out'].includes(latest.state))
        previewLifecycleTransition(latest, { to: 'cancelled', transitionedAt: cancelledAt })
      if (execution.state !== 'cancelled')
        previewLifecycleTransition(execution, { to: 'cancelled', transitionedAt: cancelledAt })
      const pending = DelegationRecordSchema.parse({
        ...record,
        pendingCancellationAt: cancelledAt,
        revision: record.revision + 1,
      })
      if (!(await this.#delegations.compareAndSet(record.revision, pending)))
        throw new DelegationError('DELEGATION_STATE_CONFLICT')
      record = pending
    }
    if (latest && !['completed', 'failed', 'cancelled', 'timed_out'].includes(latest.state)) {
      await this.#lifecycle.transitionAttempt({
        attemptId: latest.attemptId,
        expectedVersion: latest.version,
        to: 'cancelled',
        transitionedAt: cancelledAt,
      })
    }
    const child =
      execution.state === 'cancelled'
        ? execution
        : await this.#lifecycle.transitionExecution({
            executionId: execution.executionId,
            expectedVersion: execution.version,
            to: 'cancelled',
            transitionedAt: cancelledAt,
          })
    const next = DelegationRecordSchema.parse({
      ...record,
      state: 'cancelled',
      pendingCancellationAt: undefined,
      failureCode: undefined,
      revision: record.revision + 1,
      updatedAt: cancelledAt,
      terminalPublication: {
        status: 'pending',
        idempotencyKey: terminalPublicationKey(record),
        reason: 'parent_cancelled',
      },
    })
    if (!(await this.#delegations.compareAndSet(record.revision, next))) {
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
    }
    await this.#publishTerminal(next)
    return child
  }

  async #createOrRecoverChild(
    input: z.output<typeof DelegateInputSchema>,
    plan: ExecutionPlan
  ): Promise<Execution> {
    try {
      const existing = await this.#lifecycle.getExecution(input.childExecutionId)
      if (
        existing.parentExecutionId !== input.parentExecutionId ||
        existing.executionPlan.executionPlanId !== plan.executionPlanId ||
        existing.executionPlan.contentDigest !== plan.contentDigest
      ) {
        throw new DelegationError('DELEGATION_CONFLICT')
      }
      return existing
    } catch (error) {
      if (!(error instanceof ExecutionLifecycleError) || error.code !== 'EXECUTION_MISSING') {
        throw error
      }
    }
    return this.#lifecycle.createExecution({
      executionId: input.childExecutionId,
      correlation: plan.correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      parentExecutionId: input.parentExecutionId,
      acceptedAt: input.acceptedAt,
      ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
    })
  }

  async #parentDepth(parentExecutionId: string): Promise<number> {
    let depth = 0
    let cursor = await this.#delegations.findByChild(parentExecutionId)
    while (cursor) {
      depth += 1
      cursor = await this.#delegations.findByChild(cursor.parentExecutionId)
    }
    return depth
  }

  async #required(delegationId: string): Promise<DelegationRecord> {
    const record = await this.#delegations.get(delegationId)
    if (!record) throw new DelegationError('DELEGATION_NOT_FOUND')
    return record
  }

  async #publishTerminal(record: DelegationRecord): Promise<DelegationRecord> {
    const publication = record.terminalPublication
    // Legacy terminal records have no reliable publication receipt. Do not invent one.
    if (!publication || publication.status === 'published') return record
    const type =
      record.state === 'completed'
        ? 'delegation.completed'
        : record.state === 'cancelled'
          ? 'delegation.cancelled'
          : 'delegation.failed'
    await this.#publishRetained(
      {
        type,
        delegationId: record.delegationId,
        parentExecutionId: record.parentExecutionId,
        childExecutionId: record.childExecutionId,
        occurredAt: record.updatedAt,
        details: {
          state: record.state,
          ...(record.childAttemptId ? { childAttemptId: record.childAttemptId } : {}),
          ...(publication.resolution ? { resolution: publication.resolution } : {}),
          ...(record.terminalResultRef ? { terminalResultRef: record.terminalResultRef } : {}),
          ...(record.failureCode ? { failureCode: record.failureCode } : {}),
          ...(publication.reason ? { reason: publication.reason } : {}),
        },
      },
      publication.idempotencyKey
    )
    const acknowledged = DelegationRecordSchema.parse({
      ...record,
      revision: record.revision + 1,
      terminalPublication: { ...publication, status: 'published' },
    })
    if (await this.#delegations.compareAndSet(record.revision, acknowledged)) return acknowledged
    const current = await this.#required(record.delegationId)
    if (
      current.terminalPublication?.idempotencyKey !== publication.idempotencyKey ||
      current.terminalPublication.status !== 'published'
    ) {
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
    }
    return current
  }

  #publish(
    record: DelegationRecord,
    type: DelegationEvent['type'],
    occurredAt: string,
    details: Readonly<Record<string, unknown>> = {}
  ): Promise<void> {
    const event: DelegationEvent = {
      type,
      delegationId: record.delegationId,
      parentExecutionId: record.parentExecutionId,
      childExecutionId: record.childExecutionId,
      occurredAt,
      details,
    }
    return this.#publishRetained(
      event,
      `delegation:${record.delegationId}:${record.revision}:${type}`
    )
  }

  async #publishRetained(event: DelegationEvent, idempotencyKey: string): Promise<void> {
    await this.#events.publish(event, idempotencyKey)
    try {
      await this.#onEventRetained?.(structuredClone(event))
    } catch {
      // The event is durable; a failed wake is advisory and recovery can read the inbox.
    }
  }
}

function terminalPublicationKey(record: Pick<DelegationRecord, 'delegationId'>): string {
  return `delegation:${record.delegationId}:terminal`
}

export function decideDelegationFailure(input: {
  readonly policy: DelegationRecord['policy']['failure']
  readonly retryCount: number
  readonly maximumRetries: number
  readonly retryable: boolean
  readonly fallbackAvailable?: boolean
}): 'retry' | 'fallback' | 'continue_parent' | 'manual_intervention' | 'fail_parent' {
  if (input.retryable && input.retryCount < input.maximumRetries) return 'retry'
  if (input.policy === 'fallback' && input.fallbackAvailable) return 'fallback'
  if (input.policy === 'allow_partial') return 'continue_parent'
  if (input.policy === 'manual') return 'manual_intervention'
  return 'fail_parent'
}

function assertParentPlan(parent: Execution, plan: ExecutionPlan): void {
  if (
    parent.executionPlan.executionPlanId !== plan.executionPlanId ||
    parent.executionPlan.contentDigest !== plan.contentDigest ||
    parent.executionPlan.schemaVersion !== plan.schemaVersion
  ) {
    throw new DelegationError('PARENT_PLAN_MISMATCH')
  }
}

function assertDeadline(
  parent: Execution,
  plan: ExecutionPlan,
  acceptedAt: string,
  deadlineAt: string | undefined,
  policy: DelegationRecord['policy']['deadline']
): void {
  if (!deadlineAt) return
  if (
    Date.parse(deadlineAt) <= Date.parse(acceptedAt) ||
    Date.parse(deadlineAt) - Date.parse(acceptedAt) > plan.constraints.limits.duration.maximumMs ||
    (policy === 'bounded_by_parent' &&
      parent.deadlineAt !== undefined &&
      Date.parse(deadlineAt) > Date.parse(parent.deadlineAt))
  ) {
    throw new DelegationError('CHILD_DEADLINE_EXPANSION')
  }
}

function digestV2(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(value) ?? 'null')
    .digest('hex')}`
}

/**
 * Legacy-form digest of a parsed delegation input (#612 transition helper):
 * lets senders and tests reproduce the bytes stored before the code-point
 * cutover. Drops together with the dual-accept in delegate().
 */
export function delegationInputLegacyDigest(input: unknown): string {
  return digest(DelegateInputSchema.parse(input))
}

export function delegationInputDigestV2(input: unknown): string {
  return digestV2(DelegateInputSchema.parse(input))
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

// CANONICAL-JSON: verification-only legacy form (#612 transition). delegate()
// stores the V2 code-point digest and dual-accepts the legacy locale-dependent
// form for records persisted before the cutover; childPlan is z.unknown().
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
