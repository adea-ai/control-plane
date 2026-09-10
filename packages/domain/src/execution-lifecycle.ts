import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const ExecutionStateSchema = z.enum([
  'accepted',
  'queued',
  'starting',
  'running',
  'awaiting_input',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'reconciliation_required',
])

export const ExecutionAttemptStateSchema = ExecutionStateSchema.exclude(['accepted'])

export const ExecutionFailureClassificationSchema = z.enum([
  'validation',
  'policy',
  'runtime_unavailable',
  'runtime_error',
  'infrastructure',
  'timeout',
  'cancelled',
  'unknown',
])

export const ExecutionFailureSchema = z
  .object({
    classification: ExecutionFailureClassificationSchema,
    code: z.string().min(1).max(128),
  })
  .strict()

export const ExecutionPlanPinSchema = z
  .object({
    executionPlanId: IdentifierSchemas.executionPlanId,
    contentDigest: DigestSchema,
    schemaVersion: z.number().int().positive(),
  })
  .strict()

export const MarketplacePluginReferenceSchema = z
  .object({
    pluginId: z.string().regex(/^plugin:[a-z0-9-]+:[a-z0-9][a-z0-9-]{1,127}$/),
    releaseId: z.string().regex(/^release:[a-f0-9]{64}$/),
    canonicalContentDigest: DigestSchema,
  })
  .strict()

export const ExecutionCorrelationSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId,
    taskId: IdentifierSchemas.taskId,
    agentId: IdentifierSchemas.agentId,
    requestId: IdentifierSchemas.requestId,
  })
  .strict()

export const AttemptRoutingDecisionSchema = z
  .object({
    routingVersion: z.literal(1),
    policy: z
      .object({
        policyId: z.string().min(1).max(128),
        version: z.number().int().positive(),
        digest: DigestSchema,
      })
      .strict(),
    evaluatedAt: TimestampSchema,
    inputDigest: DigestSchema,
    decisionDigest: DigestSchema,
    selectedRank: z.number().int().positive(),
    candidateCount: z.number().int().positive(),
    reasonCodes: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
      .max(32)
      .refine((reasons) => new Set(reasons).size === reasons.length),
  })
  .strict()
  .refine(
    (decision) => decision.selectedRank <= decision.candidateCount,
    'Selected routing rank cannot exceed the candidate count'
  )

export const AttemptRuntimeSchema = z
  .object({
    runtimeDefinitionId: IdentifierSchemas.runtimeDefinitionId.optional(),
    runtimeNodeRefId: IdentifierSchemas.runtimeNodeRefId.optional(),
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId.optional(),
    externalSessionId: IdentifierSchemas.externalSessionId.optional(),
    routingDecision: AttemptRoutingDecisionSchema.optional(),
  })
  .strict()
  .refine((runtime) => Object.keys(runtime).length > 0, 'Runtime metadata cannot be empty')
  .refine(
    (runtime) => runtime.routingDecision === undefined || runtime.runtimeConnectionId !== undefined,
    'A routing decision requires the selected RuntimeConnection'
  )

const lifecycleTimestamps = {
  acceptedAt: TimestampSchema,
  queuedAt: TimestampSchema.optional(),
  startingAt: TimestampSchema.optional(),
  runningAt: TimestampSchema.optional(),
  awaitingInputAt: TimestampSchema.optional(),
  cancellingAt: TimestampSchema.optional(),
  reconciliationRequiredAt: TimestampSchema.optional(),
  terminalAt: TimestampSchema.optional(),
  deadlineAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}

export const ExecutionSchema = z
  .object({
    executionId: IdentifierSchemas.executionId,
    state: ExecutionStateSchema,
    version: z.number().int().positive(),
    correlation: ExecutionCorrelationSchema,
    executionPlan: ExecutionPlanPinSchema,
    marketplacePluginReferences: z.array(MarketplacePluginReferenceSchema).max(128).optional(),
    parentExecutionId: IdentifierSchemas.executionId.optional(),
    attemptCount: z.number().int().nonnegative(),
    latestAttemptId: IdentifierSchemas.attemptId.optional(),
    failure: ExecutionFailureSchema.optional(),
    terminalResultRef: IdentifierSchemas.artifactId.optional(),
    ...lifecycleTimestamps,
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.parentExecutionId === execution.executionId) {
      context.addIssue({ code: 'custom', message: 'Execution cannot be its own parent' })
    }
    if ((execution.attemptCount === 0) !== (execution.latestAttemptId === undefined)) {
      context.addIssue({ code: 'custom', message: 'Attempt count and latest attempt must agree' })
    }
    validateStateMetadata(execution, context)
  })

export const ExecutionAttemptSchema = z
  .object({
    attemptId: IdentifierSchemas.attemptId,
    executionId: IdentifierSchemas.executionId,
    sequence: z.number().int().positive(),
    state: ExecutionAttemptStateSchema,
    version: z.number().int().positive(),
    runtime: AttemptRuntimeSchema.optional(),
    failure: ExecutionFailureSchema.optional(),
    terminalResultRef: IdentifierSchemas.artifactId.optional(),
    ...lifecycleTimestamps,
  })
  .strict()
  .superRefine((attempt, context) => {
    validateStateMetadata(attempt, context)
    if (
      attempt.runtime?.routingDecision !== undefined &&
      Date.parse(attempt.runtime.routingDecision.evaluatedAt) > Date.parse(attempt.queuedAt ?? '')
    ) {
      context.addIssue({ code: 'custom', message: 'Routing cannot occur after attempt queueing' })
    }
  })

export type ExecutionState = z.output<typeof ExecutionStateSchema>
export type ExecutionAttemptState = z.output<typeof ExecutionAttemptStateSchema>
export type Execution = z.output<typeof ExecutionSchema>
export type MarketplacePluginReference = z.output<typeof MarketplacePluginReferenceSchema>
export type ExecutionAttempt = z.output<typeof ExecutionAttemptSchema>
export type AttemptRoutingDecision = z.output<typeof AttemptRoutingDecisionSchema>

export interface ExecutionRepository {
  insertExecution(execution: Execution): Promise<boolean>
  getExecution(executionId: string): Promise<Execution | undefined>
  compareAndSetExecution(expectedVersion: number, execution: Execution): Promise<boolean>
  insertAttempt(
    expectedExecutionVersion: number,
    execution: Execution,
    attempt: ExecutionAttempt
  ): Promise<boolean>
  getAttempt(attemptId: string): Promise<ExecutionAttempt | undefined>
  listAttempts(executionId: string): Promise<readonly ExecutionAttempt[]>
  compareAndSetAttempt(expectedVersion: number, attempt: ExecutionAttempt): Promise<boolean>
}

export class InMemoryExecutionRepository implements ExecutionRepository {
  readonly #executions = new Map<string, Execution>()
  readonly #attempts = new Map<string, ExecutionAttempt>()

  async insertExecution(execution: Execution): Promise<boolean> {
    if (this.#executions.has(execution.executionId)) return false
    this.#executions.set(execution.executionId, clone(execution))
    return true
  }

  async getExecution(executionId: string): Promise<Execution | undefined> {
    return cloneOptional(this.#executions.get(executionId))
  }

  async compareAndSetExecution(expectedVersion: number, execution: Execution): Promise<boolean> {
    const current = this.#executions.get(execution.executionId)
    if (
      current?.version !== expectedVersion ||
      !hasSameImmutableExecutionIdentity(current, execution)
    ) {
      return false
    }
    this.#executions.set(execution.executionId, clone(execution))
    return true
  }

  async insertAttempt(
    expectedExecutionVersion: number,
    execution: Execution,
    attempt: ExecutionAttempt
  ): Promise<boolean> {
    const current = this.#executions.get(execution.executionId)
    if (
      current?.version !== expectedExecutionVersion ||
      !hasSameImmutableExecutionIdentity(current, execution) ||
      this.#attempts.has(attempt.attemptId) ||
      [...this.#attempts.values()].some(
        (candidate) =>
          candidate.executionId === attempt.executionId && candidate.sequence === attempt.sequence
      )
    ) {
      return false
    }
    this.#executions.set(execution.executionId, clone(execution))
    this.#attempts.set(attempt.attemptId, clone(attempt))
    return true
  }

  async getAttempt(attemptId: string): Promise<ExecutionAttempt | undefined> {
    return cloneOptional(this.#attempts.get(attemptId))
  }

  async listAttempts(executionId: string): Promise<readonly ExecutionAttempt[]> {
    return [...this.#attempts.values()]
      .filter((attempt) => attempt.executionId === executionId)
      .toSorted((left, right) => left.sequence - right.sequence)
      .map(clone)
  }

  async compareAndSetAttempt(expectedVersion: number, attempt: ExecutionAttempt): Promise<boolean> {
    const current = this.#attempts.get(attempt.attemptId)
    if (
      current?.version !== expectedVersion ||
      !hasSameImmutableAttemptIdentity(current, attempt)
    ) {
      return false
    }
    this.#attempts.set(attempt.attemptId, clone(attempt))
    return true
  }
}

export type ExecutionLifecycleErrorCode =
  | 'EXECUTION_EXISTS'
  | 'EXECUTION_MISSING'
  | 'ATTEMPT_EXISTS_OR_STALE_EXECUTION'
  | 'ATTEMPT_MISSING'
  | 'INVALID_TRANSITION'
  | 'TERMINAL_STATE'
  | 'STALE_EXECUTION_VERSION'
  | 'STALE_ATTEMPT_VERSION'
  | 'TIMESTAMP_REGRESSION'
  | 'INVALID_TERMINAL_METADATA'

export class ExecutionLifecycleError extends Error {
  constructor(
    readonly code: ExecutionLifecycleErrorCode,
    readonly currentVersion?: number
  ) {
    super(code)
    this.name = 'ExecutionLifecycleError'
  }
}

const CreateExecutionSchema = z
  .object({
    executionId: IdentifierSchemas.executionId,
    correlation: ExecutionCorrelationSchema,
    executionPlan: ExecutionPlanPinSchema,
    marketplacePluginReferences: z.array(MarketplacePluginReferenceSchema).max(128).optional(),
    parentExecutionId: IdentifierSchemas.executionId.optional(),
    acceptedAt: TimestampSchema,
    deadlineAt: TimestampSchema.optional(),
  })
  .strict()

const CreateAttemptSchema = z
  .object({
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    expectedExecutionVersion: z.number().int().positive(),
    queuedAt: TimestampSchema,
    deadlineAt: TimestampSchema.optional(),
    runtime: AttemptRuntimeSchema.optional(),
  })
  .strict()

const ExecutionTransitionSchema = z
  .object({
    executionId: IdentifierSchemas.executionId,
    expectedVersion: z.number().int().positive(),
    to: ExecutionStateSchema,
    transitionedAt: TimestampSchema,
    failure: ExecutionFailureSchema.optional(),
    terminalResultRef: IdentifierSchemas.artifactId.optional(),
  })
  .strict()

const AttemptTransitionSchema = z
  .object({
    attemptId: IdentifierSchemas.attemptId,
    expectedVersion: z.number().int().positive(),
    to: ExecutionAttemptStateSchema,
    transitionedAt: TimestampSchema,
    failure: ExecutionFailureSchema.optional(),
    terminalResultRef: IdentifierSchemas.artifactId.optional(),
  })
  .strict()

export class ExecutionLifecycleService {
  constructor(readonly repository: ExecutionRepository) {}

  async createExecution(input: unknown): Promise<Execution> {
    const parsed = CreateExecutionSchema.parse(input)
    const execution = ExecutionSchema.parse({
      ...parsed,
      state: 'accepted',
      version: 1,
      attemptCount: 0,
      ...(parsed.marketplacePluginReferences === undefined
        ? {}
        : { marketplacePluginReferences: parsed.marketplacePluginReferences }),
      createdAt: parsed.acceptedAt,
      updatedAt: parsed.acceptedAt,
    })
    if (!(await this.repository.insertExecution(execution))) fail('EXECUTION_EXISTS')
    return execution
  }

  async getExecution(executionId: string): Promise<Execution> {
    const parsedId = IdentifierSchemas.executionId.parse(executionId)
    const execution = await this.repository.getExecution(parsedId)
    if (!execution) fail('EXECUTION_MISSING')
    return ExecutionSchema.parse(execution)
  }

  async createAttempt(input: unknown): Promise<ExecutionAttempt> {
    const parsed = CreateAttemptSchema.parse(input)
    const execution = await this.getExecution(parsed.executionId)
    assertExpectedVersion(execution.version, parsed.expectedExecutionVersion, 'execution')
    if (terminalStates.has(execution.state)) fail('TERMINAL_STATE')
    assertTimestamp(execution.updatedAt, parsed.queuedAt)
    const attempt = ExecutionAttemptSchema.parse({
      attemptId: parsed.attemptId,
      executionId: parsed.executionId,
      sequence: execution.attemptCount + 1,
      state: 'queued',
      version: 1,
      runtime: parsed.runtime,
      acceptedAt: execution.acceptedAt,
      queuedAt: parsed.queuedAt,
      deadlineAt: parsed.deadlineAt ?? execution.deadlineAt,
      createdAt: parsed.queuedAt,
      updatedAt: parsed.queuedAt,
    })
    const nextExecution = ExecutionSchema.parse({
      ...execution,
      version: execution.version + 1,
      attemptCount: attempt.sequence,
      latestAttemptId: attempt.attemptId,
      updatedAt: parsed.queuedAt,
    })
    if (
      !(await this.repository.insertAttempt(
        parsed.expectedExecutionVersion,
        nextExecution,
        attempt
      ))
    ) {
      const current = await this.repository.getExecution(parsed.executionId)
      if (current?.version !== parsed.expectedExecutionVersion) {
        fail('STALE_EXECUTION_VERSION', current?.version)
      }
      fail('ATTEMPT_EXISTS_OR_STALE_EXECUTION')
    }
    return attempt
  }

  async transitionExecution(input: unknown): Promise<Execution> {
    const parsed = ExecutionTransitionSchema.parse(input)
    const current = await this.getExecution(parsed.executionId)
    assertExpectedVersion(current.version, parsed.expectedVersion, 'execution')
    const next = transition(current, parsed)
    if (!(await this.repository.compareAndSetExecution(parsed.expectedVersion, next))) {
      const latest = await this.repository.getExecution(parsed.executionId)
      fail('STALE_EXECUTION_VERSION', latest?.version)
    }
    return next
  }

  async transitionAttempt(input: unknown): Promise<ExecutionAttempt> {
    const parsed = AttemptTransitionSchema.parse(input)
    const current = await this.repository.getAttempt(parsed.attemptId)
    if (!current) fail('ATTEMPT_MISSING')
    assertExpectedVersion(current.version, parsed.expectedVersion, 'attempt')
    const next = transition(current, parsed)
    if (!(await this.repository.compareAndSetAttempt(parsed.expectedVersion, next))) {
      const latest = await this.repository.getAttempt(parsed.attemptId)
      fail('STALE_ATTEMPT_VERSION', latest?.version)
    }
    return next
  }
}

const terminalStates = new Set<ExecutionState>(['completed', 'failed', 'cancelled', 'timed_out'])

const transitions: Record<ExecutionState, readonly ExecutionState[]> = {
  accepted: ['queued', 'cancelling', 'cancelled', 'failed', 'timed_out', 'reconciliation_required'],
  queued: [
    'starting',
    'running',
    'cancelling',
    'failed',
    'cancelled',
    'timed_out',
    'reconciliation_required',
  ],
  starting: [
    'running',
    'awaiting_input',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'timed_out',
    'reconciliation_required',
  ],
  running: [
    'awaiting_input',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'timed_out',
    'reconciliation_required',
  ],
  awaiting_input: [
    'running',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'timed_out',
    'reconciliation_required',
  ],
  cancelling: ['completed', 'failed', 'cancelled', 'timed_out', 'reconciliation_required'],
  reconciliation_required: [
    'queued',
    'starting',
    'running',
    'awaiting_input',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'timed_out',
  ],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
}

const timestampFields: Partial<Record<ExecutionState, string>> = {
  queued: 'queuedAt',
  starting: 'startingAt',
  running: 'runningAt',
  awaiting_input: 'awaitingInputAt',
  cancelling: 'cancellingAt',
  reconciliation_required: 'reconciliationRequiredAt',
}

function transition<Lifecycle extends Execution | ExecutionAttempt>(
  current: Lifecycle,
  input: {
    to: ExecutionState
    transitionedAt: string
    failure?: z.output<typeof ExecutionFailureSchema> | undefined
    terminalResultRef?: string | undefined
  }
): Lifecycle {
  if (terminalStates.has(current.state)) fail('TERMINAL_STATE')
  if (!transitions[current.state].includes(input.to)) fail('INVALID_TRANSITION')
  assertTimestamp(current.updatedAt, input.transitionedAt)
  assertTransitionMetadata(input)
  const timestampField = timestampFields[input.to]
  return ('attemptId' in current ? ExecutionAttemptSchema : ExecutionSchema).parse({
    ...current,
    state: input.to,
    version: current.version + 1,
    updatedAt: input.transitionedAt,
    ...(timestampField ? { [timestampField]: input.transitionedAt } : {}),
    ...(terminalStates.has(input.to) ? { terminalAt: input.transitionedAt } : {}),
    failure: undefined,
    terminalResultRef: undefined,
    ...(input.failure ? { failure: input.failure } : {}),
    ...(input.terminalResultRef ? { terminalResultRef: input.terminalResultRef } : {}),
  }) as Lifecycle
}

function assertTransitionMetadata(input: {
  to: ExecutionState
  failure?: z.output<typeof ExecutionFailureSchema> | undefined
  terminalResultRef?: string | undefined
}): void {
  if (input.to === 'failed' && !input.failure) fail('INVALID_TERMINAL_METADATA')
  if (input.to === 'completed' && input.failure) fail('INVALID_TERMINAL_METADATA')
  if (input.to !== 'completed' && input.terminalResultRef) fail('INVALID_TERMINAL_METADATA')
  if (!['failed', 'timed_out', 'reconciliation_required'].includes(input.to) && input.failure) {
    fail('INVALID_TERMINAL_METADATA')
  }
}

function validateStateMetadata(
  lifecycle: {
    state: ExecutionState
    failure?: unknown | undefined
    terminalResultRef?: unknown | undefined
    terminalAt?: string | undefined
  },
  context: z.RefinementCtx
): void {
  const terminal = terminalStates.has(lifecycle.state)
  if (terminal !== (lifecycle.terminalAt !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Terminal state and timestamp must agree' })
  }
  if (lifecycle.state === 'failed' && !lifecycle.failure) {
    context.addIssue({ code: 'custom', message: 'Failed lifecycle requires classification' })
  }
  if (
    lifecycle.failure &&
    !['failed', 'timed_out', 'reconciliation_required'].includes(lifecycle.state)
  ) {
    context.addIssue({ code: 'custom', message: 'Only failure states may retain classification' })
  }
  if (lifecycle.state !== 'completed' && lifecycle.terminalResultRef) {
    context.addIssue({ code: 'custom', message: 'Only completed lifecycle may reference a result' })
  }
}

function assertExpectedVersion(
  current: number,
  expected: number,
  aggregate: 'execution' | 'attempt'
): void {
  if (current === expected) return
  fail(aggregate === 'execution' ? 'STALE_EXECUTION_VERSION' : 'STALE_ATTEMPT_VERSION', current)
}

function assertTimestamp(current: string, next: string): void {
  if (Date.parse(next) < Date.parse(current)) fail('TIMESTAMP_REGRESSION')
}

function fail(code: ExecutionLifecycleErrorCode, currentVersion?: number): never {
  throw new ExecutionLifecycleError(code, currentVersion)
}

function hasSameImmutableExecutionIdentity(left: Execution, right: Execution): boolean {
  return (
    left.executionId === right.executionId &&
    left.parentExecutionId === right.parentExecutionId &&
    JSON.stringify(left.correlation) === JSON.stringify(right.correlation) &&
    JSON.stringify(left.executionPlan) === JSON.stringify(right.executionPlan) &&
    JSON.stringify(left.marketplacePluginReferences) ===
      JSON.stringify(right.marketplacePluginReferences) &&
    left.acceptedAt === right.acceptedAt &&
    left.createdAt === right.createdAt
  )
}

function hasSameImmutableAttemptIdentity(left: ExecutionAttempt, right: ExecutionAttempt): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.executionId === right.executionId &&
    left.sequence === right.sequence &&
    JSON.stringify(left.runtime) === JSON.stringify(right.runtime) &&
    left.acceptedAt === right.acceptedAt &&
    left.createdAt === right.createdAt
  )
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : clone(value)
}
