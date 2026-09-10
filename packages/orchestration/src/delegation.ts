import { createHash } from 'node:crypto'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  ExecutionLifecycleError,
  type Execution,
  type ExecutionAttempt,
  type ExecutionLifecycleService,
} from '@control-plane/domain'
import {
  ExecutionPlanSchema,
  deriveExecutionPlan,
  type ExecutionPlan,
  type ExecutionPlanRepository,
} from '@control-plane/execution-plan'
import { z } from 'zod'

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

export const DelegationRecordSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
    delegationGroupId: IdentifierSchemas.delegationGroupId.optional(),
    parentExecutionId: IdentifierSchemas.executionId,
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
  })
  .strict()
  .superRefine((record, context) => {
    if (record.parentExecutionId === record.childExecutionId) {
      context.addIssue({ code: 'custom', message: 'Delegation cannot target its parent execution' })
    }
    const terminal = ['completed', 'failed', 'cancelled'].includes(record.state)
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
      .toSorted((left, right) => left.delegationId.localeCompare(right.delegationId))
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

export interface DelegationEventPublisher {
  publish(event: DelegationEvent): Promise<void>
}

export type DelegationErrorCode =
  | 'DELEGATION_NOT_FOUND'
  | 'DELEGATION_CONFLICT'
  | 'DELEGATION_LIMIT_EXCEEDED'
  | 'DELEGATION_DEPTH_EXCEEDED'
  | 'PARENT_PLAN_MISMATCH'
  | 'PROFILE_EXPANSION'
  | 'CHILD_DEADLINE_EXPANSION'
  | 'DELEGATION_STATE_CONFLICT'

export class DelegationError extends Error {
  constructor(readonly code: DelegationErrorCode) {
    super(code)
    this.name = 'DelegationError'
  }
}

const DelegateInputSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
    delegationGroupId: IdentifierSchemas.delegationGroupId.optional(),
    parentExecutionId: IdentifierSchemas.executionId,
    childExecutionId: IdentifierSchemas.executionId,
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

const DispatchInputSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
    childAttemptId: IdentifierSchemas.attemptId,
    runtime: z
      .object({
        runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
        runtimeDefinitionId: IdentifierSchemas.runtimeDefinitionId.optional(),
        runtimeNodeRefId: IdentifierSchemas.runtimeNodeRefId.optional(),
      })
      .strict(),
    dispatchedAt: TimestampSchema,
  })
  .strict()

const ChildProgressInputSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
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

export type ChildProgressOutcome = {
  readonly record: DelegationRecord
  readonly resolution?: ReturnType<typeof decideDelegationFailure>
}

export class DelegationService {
  readonly #delegations: DelegationRepository
  readonly #lifecycle: ExecutionLifecycleService
  readonly #plans: ExecutionPlanRepository
  readonly #events: DelegationEventPublisher

  constructor(options: {
    readonly delegations: DelegationRepository
    readonly lifecycle: ExecutionLifecycleService
    readonly plans: ExecutionPlanRepository
    readonly events: DelegationEventPublisher
  }) {
    this.#delegations = options.delegations
    this.#lifecycle = options.lifecycle
    this.#plans = options.plans
    this.#events = options.events
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
    const inputDigest = digest(parsed)
    const existing = await this.#delegations.get(parsed.delegationId)
    if (existing) {
      if (existing.inputDigest !== inputDigest) throw new DelegationError('DELEGATION_CONFLICT')
      const execution = await this.#lifecycle.getExecution(existing.childExecutionId)
      const plan = await this.#plans.get({
        executionPlanId: existing.childExecutionPlanId,
        contentDigest: existing.childExecutionPlanDigest,
      })
      if (!plan) throw new DelegationError('DELEGATION_CONFLICT')
      return { record: existing, execution, plan }
    }

    const parent = await this.#lifecycle.getExecution(parsed.parentExecutionId)
    assertParentPlan(parent, parsed.parentPlan)
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

    const plan = this.deriveChildPlan(parsed.parentPlan, parsed.childPlan)
    assertDeadline(parent, plan, parsed.acceptedAt, parsed.deadlineAt, parsed.policy.deadline)
    await this.#plans.put(plan)
    const execution = await this.#createOrRecoverChild(parsed, plan)
    const record = DelegationRecordSchema.parse({
      delegationId: parsed.delegationId,
      ...(parsed.delegationGroupId ? { delegationGroupId: parsed.delegationGroupId } : {}),
      parentExecutionId: parsed.parentExecutionId,
      childExecutionId: parsed.childExecutionId,
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
    if (!(await this.#delegations.insert(record))) {
      const replay = await this.#delegations.get(parsed.delegationId)
      if (!replay || replay.inputDigest !== inputDigest) {
        throw new DelegationError('DELEGATION_CONFLICT')
      }
      return { record: replay, execution, plan }
    }
    await this.#publish(record, 'delegation.requested', parsed.acceptedAt)
    return { record, execution, plan }
  }

  async dispatchChild(input: unknown): Promise<{
    readonly record: DelegationRecord
    readonly attempt: ExecutionAttempt
  }> {
    const parsed = DispatchInputSchema.parse(input)
    const record = await this.#required(parsed.delegationId)
    if (record.childAttemptId === parsed.childAttemptId) {
      const [attempt] = await this.#lifecycle.repository.listAttempts(record.childExecutionId)
      if (!attempt) throw new DelegationError('DELEGATION_STATE_CONFLICT')
      return { record, attempt }
    }
    if (record.state !== 'requested') throw new DelegationError('DELEGATION_STATE_CONFLICT')
    const execution = await this.#lifecycle.getExecution(record.childExecutionId)
    const attempt = await this.#lifecycle.createAttempt({
      executionId: record.childExecutionId,
      attemptId: parsed.childAttemptId,
      expectedExecutionVersion: execution.version,
      queuedAt: parsed.dispatchedAt,
      ...(record.deadlineAt ? { deadlineAt: record.deadlineAt } : {}),
      runtime: parsed.runtime,
    })
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
    const record = await this.#required(parsed.delegationId)
    if (!record.childAttemptId) throw new DelegationError('DELEGATION_STATE_CONFLICT')

    if (['completed', 'failed', 'cancelled'].includes(record.state)) {
      if (
        record.state === parsed.state &&
        record.terminalResultRef === parsed.terminalResultRef &&
        record.failureCode === parsed.failure?.code
      ) {
        return { record }
      }
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
    }

    const attempt = await this.#lifecycle.repository.getAttempt(record.childAttemptId)
    if (!attempt) throw new DelegationError('DELEGATION_STATE_CONFLICT')
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
    if (attempt.state !== lifecycleState) {
      await this.#lifecycle.transitionAttempt({
        attemptId: attempt.attemptId,
        expectedVersion: attempt.version,
        to: lifecycleState,
        transitionedAt: parsed.observedAt,
        ...transitionMetadata,
      })
    }

    const retrying = resolution === 'retry' || resolution === 'fallback'
    const manual = resolution === 'manual_intervention'
    if (!retrying && execution.state !== lifecycleState) {
      await this.#lifecycle.transitionExecution({
        executionId: execution.executionId,
        expectedVersion: execution.version,
        to: manual ? 'reconciliation_required' : lifecycleState,
        transitionedAt: parsed.observedAt,
        ...transitionMetadata,
      })
    }

    const state = retrying ? 'requested' : manual ? 'manual_intervention' : parsed.state
    const next = DelegationRecordSchema.parse({
      ...record,
      state,
      revision: record.revision + 1,
      updatedAt: parsed.observedAt,
      retryCount: retrying ? record.retryCount + 1 : record.retryCount,
      ...(retrying
        ? { childAttemptId: undefined, runtimeConnectionId: undefined, failureCode: undefined }
        : {}),
      ...(parsed.terminalResultRef ? { terminalResultRef: parsed.terminalResultRef } : {}),
      ...(parsed.failure && !retrying ? { failureCode: parsed.failure.code } : {}),
    })
    if (!(await this.#delegations.compareAndSet(record.revision, next))) {
      const replay = await this.#required(parsed.delegationId)
      if (
        replay.state === state &&
        replay.updatedAt === parsed.observedAt &&
        replay.terminalResultRef === parsed.terminalResultRef &&
        replay.failureCode === (parsed.failure && !retrying ? parsed.failure.code : undefined)
      ) {
        return { record: replay, ...(resolution ? { resolution } : {}) }
      }
      throw new DelegationError('DELEGATION_STATE_CONFLICT')
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

  async cancelChildren(input: {
    readonly parentExecutionId: string
    readonly cancelledAt: string
  }): Promise<readonly Execution[]> {
    const parentExecutionId = IdentifierSchemas.executionId.parse(input.parentExecutionId)
    const cancelledAt = TimestampSchema.parse(input.cancelledAt)
    const cancelled: Execution[] = []
    for (const record of await this.#delegations.listByParent(parentExecutionId)) {
      if (
        record.policy.cancellation !== 'cascade' ||
        ['completed', 'failed', 'cancelled'].includes(record.state)
      ) {
        continue
      }
      const execution = await this.#lifecycle.getExecution(record.childExecutionId)
      const attempts = await this.#lifecycle.repository.listAttempts(record.childExecutionId)
      const latest = attempts.at(-1)
      if (latest && !['completed', 'failed', 'cancelled', 'timed_out'].includes(latest.state)) {
        await this.#lifecycle.transitionAttempt({
          attemptId: latest.attemptId,
          expectedVersion: latest.version,
          to: 'cancelled',
          transitionedAt: cancelledAt,
        })
      }
      const child = await this.#lifecycle.transitionExecution({
        executionId: execution.executionId,
        expectedVersion: execution.version,
        to: 'cancelled',
        transitionedAt: cancelledAt,
      })
      const next = DelegationRecordSchema.parse({
        ...record,
        state: 'cancelled',
        revision: record.revision + 1,
        updatedAt: cancelledAt,
      })
      if (!(await this.#delegations.compareAndSet(record.revision, next))) {
        throw new DelegationError('DELEGATION_STATE_CONFLICT')
      }
      await this.#publish(next, 'delegation.cancelled', cancelledAt, {
        reason: 'parent_cancelled',
      })
      cancelled.push(child)
    }
    return cancelled
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

  #publish(
    record: DelegationRecord,
    type: DelegationEvent['type'],
    occurredAt: string,
    details: Readonly<Record<string, unknown>> = {}
  ): Promise<void> {
    return this.#events.publish({
      type,
      delegationId: record.delegationId,
      parentExecutionId: record.parentExecutionId,
      childExecutionId: record.childExecutionId,
      occurredAt,
      details,
    })
  }
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

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

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
