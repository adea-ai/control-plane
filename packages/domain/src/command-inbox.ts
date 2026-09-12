import { IdentifierSchemas, type ErrorClass } from '@control-plane/contracts'
import { z } from 'zod'
import {
  ExecutionPlanPinSchema,
  ExecutionSchema,
  MarketplacePluginReferenceSchema,
  type Execution,
} from './execution-lifecycle.js'

const TimestampSchema = z.iso.datetime()
const PayloadHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const ServicePrincipalIdSchema = z
  .string()
  .min(5)
  .max(64)
  .regex(/^svc_[a-z][a-z0-9-]*$/)
const OperationSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/)
const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
const ExternalReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/)

export const CommandInboxStatusSchema = z.enum([
  'accepted',
  'processing',
  'completed',
  'failed',
  'reconciliation_required',
])

export const CommandInboxScopeSchema = z.object({
  callerPrincipalId: ServicePrincipalIdSchema,
  operation: OperationSchema,
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId,
  idempotencyKey: IdempotencyKeySchema,
})

export const CommandInboxRecordSchema = CommandInboxScopeSchema.extend({
  commandId: IdentifierSchemas.commandId,
  requestId: IdentifierSchemas.requestId,
  taskId: IdentifierSchemas.taskId,
  agentId: IdentifierSchemas.agentId,
  payloadHash: PayloadHashSchema,
  status: CommandInboxStatusSchema,
  executionId: IdentifierSchemas.executionId,
  executionPlan: ExecutionPlanPinSchema,
  version: z.number().int().positive(),
  conflictCount: z.number().int().nonnegative(),
  receivedAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  retentionExpiresAt: TimestampSchema,
  lastConflictAt: TimestampSchema.optional(),
  processingAt: TimestampSchema.optional(),
  reconciliationRequiredAt: TimestampSchema.optional(),
  terminalAt: TimestampSchema.optional(),
  resultReference: IdentifierSchemas.artifactId.optional(),
  errorReference: ExternalReferenceSchema.optional(),
}).superRefine((record, context) => {
  if (Date.parse(record.retentionExpiresAt) <= Date.parse(record.receivedAt)) {
    context.addIssue({ code: 'custom', message: 'Retention must extend beyond receipt' })
  }
  if (record.conflictCount === 0 && record.lastConflictAt !== undefined) {
    context.addIssue({ code: 'custom', message: 'Conflict timestamp requires a conflict' })
  }
  if (record.conflictCount > 0 && record.lastConflictAt === undefined) {
    context.addIssue({ code: 'custom', message: 'Conflict count requires a timestamp' })
  }
  validateStatusMetadata(record, context)
})

export type CommandInboxStatus = z.output<typeof CommandInboxStatusSchema>
export type CommandInboxScope = z.output<typeof CommandInboxScopeSchema>
export type CommandInboxRecord = z.output<typeof CommandInboxRecordSchema>

export interface CommandAcceptanceResult {
  readonly outcome: 'accepted' | 'duplicate' | 'conflict'
  readonly command: CommandInboxRecord
  readonly execution: Execution
}

export interface CommandAcceptanceRepository {
  accept(command: CommandInboxRecord, execution: Execution): Promise<CommandAcceptanceResult>
  get(scope: CommandInboxScope): Promise<CommandInboxRecord | undefined>
  getByExecutionId(executionId: string): Promise<CommandInboxRecord | undefined>
  getExecution(executionId: string): Promise<Execution | undefined>
  compareAndSet(expectedVersion: number, command: CommandInboxRecord): Promise<boolean>
}

export class InMemoryCommandAcceptanceRepository implements CommandAcceptanceRepository {
  readonly #commands = new Map<string, CommandInboxRecord>()
  readonly #executions = new Map<string, Execution>()

  get executionCount(): number {
    return this.#executions.size
  }

  async accept(
    command: CommandInboxRecord,
    execution: Execution
  ): Promise<CommandAcceptanceResult> {
    const key = scopeKey(command)
    const existing = this.#commands.get(key)
    if (existing) {
      const existingExecution = this.#executions.get(existing.executionId)
      if (!existingExecution) throw new Error('COMMAND_EXECUTION_INVARIANT_VIOLATION')
      if (existing.payloadHash === command.payloadHash) {
        return {
          outcome: 'duplicate',
          command: clone(existing),
          execution: clone(existingExecution),
        }
      }
      const conflicted = CommandInboxRecordSchema.parse({
        ...existing,
        version: existing.version + 1,
        conflictCount: existing.conflictCount + 1,
        lastConflictAt: command.lastSeenAt,
        lastSeenAt: command.lastSeenAt,
      })
      this.#commands.set(key, clone(conflicted))
      return { outcome: 'conflict', command: conflicted, execution: clone(existingExecution) }
    }
    if (this.#executions.has(execution.executionId)) throw new Error('EXECUTION_ID_CONFLICT')
    this.#commands.set(key, clone(command))
    this.#executions.set(execution.executionId, clone(execution))
    return { outcome: 'accepted', command: clone(command), execution: clone(execution) }
  }

  async get(scope: CommandInboxScope): Promise<CommandInboxRecord | undefined> {
    return cloneOptional(this.#commands.get(scopeKey(CommandInboxScopeSchema.parse(scope))))
  }

  async getByExecutionId(executionId: string): Promise<CommandInboxRecord | undefined> {
    const parsedId = IdentifierSchemas.executionId.parse(executionId)
    return cloneOptional(
      [...this.#commands.values()].find((command) => command.executionId === parsedId)
    )
  }

  async getExecution(executionId: string): Promise<Execution | undefined> {
    return cloneOptional(this.#executions.get(executionId))
  }

  async compareAndSet(expectedVersion: number, command: CommandInboxRecord): Promise<boolean> {
    const parsed = CommandInboxRecordSchema.parse(command)
    const key = scopeKey(parsed)
    const current = this.#commands.get(key)
    if (current?.version !== expectedVersion || !sameImmutableCommand(current, parsed)) return false
    this.#commands.set(key, clone(parsed))
    return true
  }
}

export interface ExecutionPlanAcceptanceValidator {
  validate(input: {
    readonly executionPlan: z.output<typeof ExecutionPlanPinSchema>
    readonly workspaceId: string
    readonly projectId: string
    readonly taskId: string
    readonly agentId: string
  }): Promise<boolean>
}

/**
 * Observability port for inbox acceptance outcomes. Implementations must isolate
 * exporter failures; the service additionally isolates every hook call so a
 * throwing metrics sink can never change an acceptance result.
 */
export interface CommandInboxMetrics {
  recordAcceptanceOutcome(outcome: CommandAcceptanceResult['outcome']): void
}

export interface CommandInboxServiceOptions {
  readonly repository: CommandAcceptanceRepository
  readonly executionIdFactory: () => string
  readonly executionPlanValidator: ExecutionPlanAcceptanceValidator
  readonly now?: () => string
  readonly metrics?: CommandInboxMetrics
  readonly failureInjector?: {
    checkpoint(scenario: 'control_api.after_accept' | 'control_api.before_accept'): void
  }
}

const AcceptExecutionSchema = z
  .object({
    callerPrincipalId: ServicePrincipalIdSchema,
    operation: z.literal('execution.accept'),
    commandId: IdentifierSchemas.commandId,
    requestId: IdentifierSchemas.requestId,
    idempotencyKey: IdempotencyKeySchema,
    payloadHash: PayloadHashSchema,
    correlation: z
      .object({
        workspaceId: IdentifierSchemas.workspaceId,
        projectId: IdentifierSchemas.projectId,
        taskId: IdentifierSchemas.taskId,
        agentId: IdentifierSchemas.agentId,
      })
      .strict(),
    executionPlan: ExecutionPlanPinSchema,
    marketplacePluginReferences: z.array(MarketplacePluginReferenceSchema).max(128).optional(),
    parentExecutionId: IdentifierSchemas.executionId.optional(),
    receivedAt: TimestampSchema,
    retentionExpiresAt: TimestampSchema,
    deadlineAt: TimestampSchema.optional(),
  })
  .strict()
  .refine((input) => Date.parse(input.retentionExpiresAt) > Date.parse(input.receivedAt), {
    message: 'Retention must extend beyond receipt',
    path: ['retentionExpiresAt'],
  })

const NewExecutionAcceptanceSchema = AcceptExecutionSchema.refine(
  (input) =>
    Date.parse(input.retentionExpiresAt) - Date.parse(input.receivedAt) >=
    30 * 24 * 60 * 60 * 1_000,
  {
    message: 'Command retention must cover at least 30 days after receipt',
    path: ['retentionExpiresAt'],
  }
)

const TransitionCommandSchema = z.object({
  callerPrincipalId: ServicePrincipalIdSchema,
  operation: z.literal('execution.accept'),
  workspaceId: IdentifierSchemas.workspaceId.optional(),
  projectId: IdentifierSchemas.projectId.optional(),
  idempotencyKey: IdempotencyKeySchema,
  correlation: z
    .object({
      workspaceId: IdentifierSchemas.workspaceId,
      projectId: IdentifierSchemas.projectId,
    })
    .optional(),
  expectedVersion: z.number().int().positive(),
  to: CommandInboxStatusSchema,
  transitionedAt: TimestampSchema,
  resultReference: IdentifierSchemas.artifactId.optional(),
  errorReference: ExternalReferenceSchema.optional(),
})

const TransitionExecutionCommandSchema = z
  .object({
    executionId: IdentifierSchemas.executionId,
    to: z.enum(['completed', 'failed']),
    transitionedAt: TimestampSchema,
    resultReference: IdentifierSchemas.artifactId.optional(),
    errorReference: ExternalReferenceSchema.optional(),
  })
  .strict()

export type CommandInboxErrorCode =
  | 'IDEMPOTENCY_PAYLOAD_CONFLICT'
  | 'INVALID_EXECUTION_PLAN_REFERENCE'
  | 'INVALID_COMMAND_RETENTION'
  | 'COMMAND_RETENTION_EXPIRED'
  | 'COMMAND_MISSING'
  | 'STALE_COMMAND_VERSION'
  | 'INVALID_COMMAND_TRANSITION'
  | 'TERMINAL_COMMAND'
  | 'INVALID_COMMAND_METADATA'
  | 'TIMESTAMP_REGRESSION'

export class CommandInboxError extends Error {
  readonly errorClass: ErrorClass
  readonly retryable: boolean

  constructor(
    readonly code: CommandInboxErrorCode,
    readonly currentVersion?: number
  ) {
    super(code)
    this.name = 'CommandInboxError'
    this.errorClass = commandErrorClass(code)
    this.retryable = code === 'STALE_COMMAND_VERSION'
  }
}

export class CommandInboxService {
  repository: CommandAcceptanceRepository
  readonly #executionIdFactory: () => string
  readonly #executionPlanValidator: ExecutionPlanAcceptanceValidator
  readonly #now: () => string
  readonly #metrics: CommandInboxMetrics | undefined
  readonly #failureInjector: CommandInboxServiceOptions['failureInjector']

  constructor(options: CommandInboxServiceOptions) {
    this.repository = options.repository
    this.#executionIdFactory = options.executionIdFactory
    this.#executionPlanValidator = options.executionPlanValidator
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#metrics = options.metrics
    this.#failureInjector = options.failureInjector
  }

  /** Emission is isolated per outcome and can never change an acceptance result. */
  #emitAcceptanceOutcome(outcome: CommandAcceptanceResult['outcome']): void {
    if (this.#metrics === undefined) return
    try {
      this.#metrics.recordAcceptanceOutcome(outcome)
    } catch {
      // Observability is deliberately non-authoritative and fail-open.
    }
  }

  async acceptExecution(input: unknown): Promise<{
    readonly replayed: boolean
    readonly command: CommandInboxRecord
    readonly execution: Execution
  }> {
    const parsed = AcceptExecutionSchema.parse(input)
    const scope = scopeFromInput(parsed)
    const existing = await this.repository.get(scope)
    if (existing) return this.#replay(existing, parsed.payloadHash)
    if (!NewExecutionAcceptanceSchema.safeParse(parsed).success) fail('INVALID_COMMAND_RETENTION')
    if (
      !(await this.#executionPlanValidator.validate({
        executionPlan: parsed.executionPlan,
        workspaceId: parsed.correlation.workspaceId,
        projectId: parsed.correlation.projectId,
        taskId: parsed.correlation.taskId,
        agentId: parsed.correlation.agentId,
      }))
    ) {
      fail('INVALID_EXECUTION_PLAN_REFERENCE')
    }
    const acceptedAt = Date.parse(TimestampSchema.parse(this.#now()))
    const requestedRetention = Date.parse(parsed.retentionExpiresAt)
    if (requestedRetention < acceptedAt) fail('COMMAND_RETENTION_EXPIRED')
    const retentionExpiresAt = new Date(
      Math.max(requestedRetention, acceptedAt + 30 * 24 * 60 * 60 * 1_000)
    ).toISOString()
    const executionId = IdentifierSchemas.executionId.parse(this.#executionIdFactory())
    const execution = ExecutionSchema.parse({
      executionId,
      state: 'accepted',
      version: 1,
      correlation: { ...parsed.correlation, requestId: parsed.requestId },
      executionPlan: parsed.executionPlan,
      ...(parsed.marketplacePluginReferences === undefined
        ? {}
        : { marketplacePluginReferences: parsed.marketplacePluginReferences }),
      parentExecutionId: parsed.parentExecutionId,
      attemptCount: 0,
      acceptedAt: parsed.receivedAt,
      deadlineAt: parsed.deadlineAt,
      createdAt: parsed.receivedAt,
      updatedAt: parsed.receivedAt,
    })
    const command = CommandInboxRecordSchema.parse({
      ...scope,
      commandId: parsed.commandId,
      requestId: parsed.requestId,
      taskId: parsed.correlation.taskId,
      agentId: parsed.correlation.agentId,
      payloadHash: parsed.payloadHash,
      status: 'accepted',
      executionId,
      executionPlan: parsed.executionPlan,
      version: 1,
      conflictCount: 0,
      receivedAt: parsed.receivedAt,
      lastSeenAt: parsed.receivedAt,
      retentionExpiresAt,
    })
    this.#failureInjector?.checkpoint('control_api.before_accept')
    const result = await this.repository.accept(command, execution)
    this.#emitAcceptanceOutcome(result.outcome)
    this.#failureInjector?.checkpoint('control_api.after_accept')
    this.#assertRetained(result.command)
    if (result.outcome === 'conflict') fail('IDEMPOTENCY_PAYLOAD_CONFLICT')
    return {
      replayed: result.outcome === 'duplicate',
      command: result.command,
      execution: result.execution,
    }
  }

  async transitionCommand(input: unknown): Promise<CommandInboxRecord> {
    const parsed = TransitionCommandSchema.parse(input)
    const scope = CommandInboxScopeSchema.parse({
      callerPrincipalId: parsed.callerPrincipalId,
      operation: parsed.operation,
      workspaceId: parsed.workspaceId ?? parsed.correlation?.workspaceId,
      projectId: parsed.projectId ?? parsed.correlation?.projectId,
      idempotencyKey: parsed.idempotencyKey,
    })
    const current = await this.repository.get(scope)
    if (!current) fail('COMMAND_MISSING')
    if (current.version !== parsed.expectedVersion) {
      fail('STALE_COMMAND_VERSION', current.version)
    }
    if (terminalStatuses.has(current.status)) fail('TERMINAL_COMMAND')
    if (!statusTransitions[current.status].includes(parsed.to)) fail('INVALID_COMMAND_TRANSITION')
    if (Date.parse(parsed.transitionedAt) < Date.parse(current.lastSeenAt)) {
      fail('TIMESTAMP_REGRESSION')
    }
    assertTransitionMetadata(parsed)
    const next = CommandInboxRecordSchema.parse({
      ...current,
      status: parsed.to,
      version: current.version + 1,
      lastSeenAt: parsed.transitionedAt,
      ...(parsed.to === 'processing' ? { processingAt: parsed.transitionedAt } : {}),
      ...(parsed.to === 'reconciliation_required'
        ? { reconciliationRequiredAt: parsed.transitionedAt }
        : {}),
      ...(terminalStatuses.has(parsed.to) ? { terminalAt: parsed.transitionedAt } : {}),
      resultReference: undefined,
      errorReference: undefined,
      ...(parsed.resultReference ? { resultReference: parsed.resultReference } : {}),
      ...(parsed.errorReference ? { errorReference: parsed.errorReference } : {}),
    })
    if (!(await this.repository.compareAndSet(parsed.expectedVersion, next))) {
      const latest = await this.repository.get(scope)
      fail('STALE_COMMAND_VERSION', latest?.version)
    }
    return next
  }

  async transitionExecutionCommand(input: unknown): Promise<CommandInboxRecord> {
    const parsed = TransitionExecutionCommandSchema.parse(input)
    for (let update = 0; update < 3; update += 1) {
      const current = await this.repository.getByExecutionId(parsed.executionId)
      if (!current) fail('COMMAND_MISSING')
      if (current.status === parsed.to) {
        if (
          current.resultReference !== parsed.resultReference ||
          current.errorReference !== parsed.errorReference
        ) {
          fail('INVALID_COMMAND_METADATA')
        }
        return current
      }
      try {
        return await this.transitionCommand({
          callerPrincipalId: current.callerPrincipalId,
          operation: current.operation,
          workspaceId: current.workspaceId,
          projectId: current.projectId,
          idempotencyKey: current.idempotencyKey,
          expectedVersion: current.version,
          to: parsed.to,
          transitionedAt: new Date(
            Math.max(Date.parse(parsed.transitionedAt), Date.parse(current.lastSeenAt))
          ).toISOString(),
          ...(parsed.resultReference === undefined
            ? {}
            : { resultReference: parsed.resultReference }),
          ...(parsed.errorReference === undefined ? {} : { errorReference: parsed.errorReference }),
        })
      } catch (error) {
        if (!(error instanceof CommandInboxError && error.code === 'STALE_COMMAND_VERSION')) {
          throw error
        }
      }
    }
    fail('STALE_COMMAND_VERSION')
  }

  async #replay(
    existing: CommandInboxRecord,
    payloadHash: string
  ): Promise<{ replayed: true; command: CommandInboxRecord; execution: Execution }> {
    this.#assertRetained(existing)
    if (existing.payloadHash !== payloadHash) {
      const execution = await this.#execution(existing.executionId)
      const conflict = CommandInboxRecordSchema.parse({
        ...existing,
        payloadHash,
        lastSeenAt: this.#now(),
      })
      const accepted = await this.repository.accept(conflict, execution)
      this.#emitAcceptanceOutcome(accepted.outcome)
      fail('IDEMPOTENCY_PAYLOAD_CONFLICT')
    }
    this.#emitAcceptanceOutcome('duplicate')
    return {
      replayed: true,
      command: existing,
      execution: await this.#execution(existing.executionId),
    }
  }

  async #execution(executionId: string): Promise<Execution> {
    const execution = await this.repository.getExecution(executionId)
    if (!execution) throw new Error('COMMAND_EXECUTION_INVARIANT_VIOLATION')
    return execution
  }

  #assertRetained(command: CommandInboxRecord): void {
    if (Date.parse(this.#now()) > Date.parse(command.retentionExpiresAt)) {
      fail('COMMAND_RETENTION_EXPIRED')
    }
  }
}

const terminalStatuses = new Set<CommandInboxStatus>(['completed', 'failed'])
const statusTransitions: Record<CommandInboxStatus, readonly CommandInboxStatus[]> = {
  accepted: ['processing', 'completed', 'failed', 'reconciliation_required'],
  processing: ['completed', 'failed', 'reconciliation_required'],
  reconciliation_required: ['processing', 'completed', 'failed'],
  completed: [],
  failed: [],
}

function assertTransitionMetadata(input: {
  to: CommandInboxStatus
  resultReference?: string | undefined
  errorReference?: string | undefined
}): void {
  if ((input.to === 'failed' || input.to === 'reconciliation_required') && !input.errorReference) {
    fail('INVALID_COMMAND_METADATA')
  }
  if (input.to === 'completed' && !input.resultReference) fail('INVALID_COMMAND_METADATA')
  if (input.to !== 'completed' && input.resultReference) fail('INVALID_COMMAND_METADATA')
  if (!['failed', 'reconciliation_required'].includes(input.to) && input.errorReference) {
    fail('INVALID_COMMAND_METADATA')
  }
}

function validateStatusMetadata(
  record: {
    status: CommandInboxStatus
    processingAt?: string | undefined
    reconciliationRequiredAt?: string | undefined
    terminalAt?: string | undefined
    resultReference?: string | undefined
    errorReference?: string | undefined
  },
  context: z.RefinementCtx
): void {
  if (record.status === 'processing' && !record.processingAt) {
    context.addIssue({ code: 'custom', message: 'Processing status requires a timestamp' })
  }
  if (record.status === 'reconciliation_required' && !record.reconciliationRequiredAt) {
    context.addIssue({ code: 'custom', message: 'Reconciliation status requires a timestamp' })
  }
  if (terminalStatuses.has(record.status) !== (record.terminalAt !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Terminal status and timestamp must agree' })
  }
  if (record.status === 'completed' && !record.resultReference) {
    context.addIssue({ code: 'custom', message: 'Completed status requires a result reference' })
  }
  if (record.status !== 'completed' && record.resultReference) {
    context.addIssue({ code: 'custom', message: 'Only completed status may reference a result' })
  }
  if (
    (record.status === 'failed' || record.status === 'reconciliation_required') &&
    !record.errorReference
  ) {
    context.addIssue({ code: 'custom', message: 'Failure status requires an error reference' })
  }
  if (!['failed', 'reconciliation_required'].includes(record.status) && record.errorReference) {
    context.addIssue({ code: 'custom', message: 'Only failure status may reference an error' })
  }
}

function scopeFromInput(input: z.output<typeof AcceptExecutionSchema>): CommandInboxScope {
  return CommandInboxScopeSchema.parse({
    callerPrincipalId: input.callerPrincipalId,
    operation: input.operation,
    workspaceId: input.correlation.workspaceId,
    projectId: input.correlation.projectId,
    idempotencyKey: input.idempotencyKey,
  })
}

function scopeKey(scope: CommandInboxScope): string {
  return [
    scope.callerPrincipalId,
    scope.operation,
    scope.workspaceId,
    scope.projectId,
    scope.idempotencyKey,
  ].join('\u001f')
}

function sameImmutableCommand(left: CommandInboxRecord, right: CommandInboxRecord): boolean {
  return (
    scopeKey(left) === scopeKey(right) &&
    left.commandId === right.commandId &&
    left.requestId === right.requestId &&
    left.taskId === right.taskId &&
    left.agentId === right.agentId &&
    left.payloadHash === right.payloadHash &&
    left.executionId === right.executionId &&
    JSON.stringify(left.executionPlan) === JSON.stringify(right.executionPlan) &&
    left.receivedAt === right.receivedAt &&
    left.retentionExpiresAt === right.retentionExpiresAt
  )
}

function commandErrorClass(code: CommandInboxErrorCode): ErrorClass {
  if (code === 'INVALID_EXECUTION_PLAN_REFERENCE' || code === 'COMMAND_MISSING') {
    return 'stale_reference'
  }
  if (
    code === 'IDEMPOTENCY_PAYLOAD_CONFLICT' ||
    code === 'COMMAND_RETENTION_EXPIRED' ||
    code === 'STALE_COMMAND_VERSION' ||
    code === 'TERMINAL_COMMAND'
  ) {
    return 'conflict'
  }
  return 'validation'
}

function fail(code: CommandInboxErrorCode, currentVersion?: number): never {
  throw new CommandInboxError(code, currentVersion)
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : clone(value)
}
