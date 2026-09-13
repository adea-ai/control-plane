import { IdentifierSchemas } from '@control-plane/contracts'
import {
  CommandInboxError,
  CommandInboxService,
  ExecutionLifecycleService,
  ReconciliationReasonSchema,
  type CommandAcceptanceRepository,
  type CommandInboxRecord,
  type Execution,
  type ExecutionAttempt,
  type ExecutionAttemptState,
  type ExecutionRepository,
  type ExecutionState,
  type ReconciliationEffects,
  type ReconciliationObservation,
  type ReconciliationSource,
  type RuntimeCommandRecord,
} from '@control-plane/domain'
import type {
  SqliteExecutionRepository,
  SqliteReconciliationCandidateScan,
} from './repositories.js'
import type {
  PendingDeliverySummary,
  SqliteExecutionEventRepository,
  SqliteRuntimeCommandRepository,
} from './durability-repositories.js'
import type {
  SqliteRuntimeDiscoveryRepository,
  SqliteRuntimeDiscoveryScope,
} from './runtime-discovery-repository.js'
import type { SqliteExecutionCancellationRepository } from './execution-cancellation-repository.js'

/**
 * Production reconciliation projection over the local SQLite stores.
 *
 * Mirrors the PostgreSQL projection in `@control-plane/database`: the source
 * assembles a `ReconciliationObservation` exclusively from existing stores
 * (executions/attempts, command inbox, runtime commands, runtime connection
 * discovery, event publication state) and surfaces only stale or undelivered
 * candidates; the effects land decisions on the existing lifecycle states and
 * never perform an operation whose effect they cannot prove idempotent:
 * - a lost-ACK style uncertainty (queued or expired runtime command, no
 *   recorded result) is observed as `unknown`, which parks the checkpoint as
 *   waiting — a potentially billable runtime command is never re-dispatched;
 * - runtime terminal results are only applied when the recorded lifecycle
 *   states can legally accept the outcome, and a conflicting recorded terminal
 *   state is never rewritten;
 * - recorded operator cancellation intent suppresses workflow resume;
 * - `replay_events` only re-arms already-recorded outbound events.
 *
 * Workflow execution state lives inside the workflow runtime and is not
 * durably readable here, so the observation reports the workflow as `missing`.
 */

export type ReconciliationOutcome = 'completed' | 'failed' | 'cancelled'

/** Mirrors the domain decision reasons without widening the domain surface. */
type ReconciliationReason = ReturnType<typeof ReconciliationReasonSchema.parse>

export interface SqliteReconciliationSourceOptions {
  readonly executions: Pick<
    SqliteExecutionRepository,
    'getExecution' | 'getAttempt' | 'listReconciliationCandidates'
  >
  readonly commands: Pick<CommandAcceptanceRepository, 'getByExecutionId'>
  readonly runtimeCommands: Pick<SqliteRuntimeCommandRepository, 'latestForAttempt'>
  readonly runtimeConnections: Pick<SqliteRuntimeDiscoveryRepository, 'getRuntimeConnection'>
  readonly events: Pick<SqliteExecutionEventRepository, 'summarizePendingDelivery'>
  /** Staleness bound for candidate scanning; milliseconds, positive integer. */
  readonly candidateStaleAfterMs?: number
  readonly now?: () => string
}

const DEFAULT_CANDIDATE_STALE_AFTER_MS = 60_000
const PENDING_DELIVERY_SCAN_LIMIT = 100

export class SqliteReconciliationSource implements ReconciliationSource {
  readonly #options: SqliteReconciliationSourceOptions
  readonly #staleAfterMs: number
  readonly #now: () => string

  constructor(options: SqliteReconciliationSourceOptions) {
    this.#options = options
    this.#staleAfterMs = options.candidateStaleAfterMs ?? DEFAULT_CANDIDATE_STALE_AFTER_MS
    if (!Number.isSafeInteger(this.#staleAfterMs) || this.#staleAfterMs < 1) {
      throw new Error('INVALID_RECONCILIATION_CANDIDATE_STALENESS')
    }
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async listCandidates(input: { readonly limit: number }): Promise<readonly string[]> {
    const { limit } = input
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('INVALID_RECONCILIATION_CANDIDATE_LIMIT')
    }
    const scan: SqliteReconciliationCandidateScan = {
      staleBefore: new Date(Date.parse(this.#now()) - this.#staleAfterMs).toISOString(),
      limit,
    }
    return this.#options.executions.listReconciliationCandidates(scan)
  }

  async load(executionId: string): Promise<ReconciliationObservation> {
    const execution = await this.#options.executions.getExecution(executionId)
    if (!execution) throw new Error('RECONCILIATION_EXECUTION_MISSING')
    const command = await this.#options.commands.getByExecutionId(execution.executionId)
    if (!command) throw new Error('RECONCILIATION_COMMAND_MISSING')
    const attempt =
      execution.latestAttemptId === undefined
        ? undefined
        : await this.#options.executions.getAttempt(execution.latestAttemptId)
    const runtimeCommand =
      attempt === undefined
        ? undefined
        : await this.#options.runtimeCommands.latestForAttempt(attempt.attemptId)
    const connection =
      attempt?.runtime?.runtimeConnectionId === undefined
        ? undefined
        : await this.#options.runtimeConnections.getRuntimeConnection(
            {
              workspaceId: execution.correlation.workspaceId,
            } satisfies SqliteRuntimeDiscoveryScope,
            attempt.runtime.runtimeConnectionId
          )
    const delivery: PendingDeliverySummary = await this.#options.events.summarizePendingDelivery(
      execution.executionId,
      PENDING_DELIVERY_SCAN_LIMIT
    )
    return {
      executionId: execution.executionId,
      checkedAt: this.#now(),
      command: { commandId: command.commandId, status: command.status },
      execution: {
        state: execution.state,
        updatedAt: execution.updatedAt,
        ...(execution.terminalResultRef === undefined
          ? {}
          : { terminalResultRef: execution.terminalResultRef }),
      },
      ...(attempt === undefined
        ? {}
        : {
            attempt: {
              attemptId: attempt.attemptId,
              sequence: attempt.sequence,
              state: attempt.state,
              updatedAt: attempt.updatedAt,
              ...(runtimeCommand === undefined
                ? {}
                : { runtimeCommandId: runtimeCommand.commandId }),
            },
          }),
      workflow: { status: 'missing' },
      runtime: observeRuntime(runtimeCommand, attempt, execution, connection),
      delivery: {
        pendingCount: delivery.pendingCount,
        ...(delivery.oldestPendingAt === undefined
          ? {}
          : { oldestPendingAt: delivery.oldestPendingAt }),
      },
    }
  }
}

/**
 * The workflow submission payload, shaped like the control API's
 * `ExecutionWorkflowInput` (same branded contracts identifiers) so the
 * composition can hand the production workflow dispatcher straight in.
 */
export interface WorkflowSubmitInput {
  readonly executionId: ReturnType<typeof IdentifierSchemas.executionId.parse>
  readonly workflowId: ReturnType<typeof IdentifierSchemas.workflowId.parse>
  readonly executionPlan: {
    readonly executionPlanId: ReturnType<typeof IdentifierSchemas.executionPlanId.parse>
    readonly contentDigest: string
    readonly schemaVersion: number
  }
  readonly deadlineAt: string
}

export interface SqliteReconciliationEffectsOptions {
  readonly executions: ExecutionRepository
  readonly commands: CommandAcceptanceRepository
  readonly events: Pick<SqliteExecutionEventRepository, 'rearmPendingDelivery'>
  /** Re-drives an accepted workflow into the workflow runtime (idempotent by execution id). */
  readonly workflowSubmitter: { readonly submit: (input: WorkflowSubmitInput) => Promise<void> }
  readonly cancellations?: Pick<SqliteExecutionCancellationRepository, 'listByExecution'>
  readonly now?: () => string
}

const RETRY_LIMIT = 3
const REPLAY_EVENT_LIMIT = 100

export class SqliteReconciliationEffects implements ReconciliationEffects {
  readonly #lifecycle: ExecutionLifecycleService
  readonly #executions: ExecutionRepository
  readonly #commands: CommandAcceptanceRepository
  readonly #inbox: CommandInboxService
  readonly #options: SqliteReconciliationEffectsOptions
  readonly #now: () => string

  constructor(options: SqliteReconciliationEffectsOptions) {
    this.#options = options
    this.#executions = options.executions
    this.#commands = options.commands
    this.#lifecycle = new ExecutionLifecycleService(options.executions)
    // Transition-only usage: acceptance and plan validation are never invoked.
    this.#inbox = new CommandInboxService({
      repository: options.commands,
      executionIdFactory: (): never => {
        throw new Error('RECONCILIATION_EFFECTS_CANNOT_ACCEPT_EXECUTIONS')
      },
      executionPlanValidator: { validate: async () => true },
    })
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async markReconciliationRequired(input: {
    readonly executionId: string
    readonly attemptId?: string
    readonly reason: ReconciliationReason
    readonly checkpointId: string
    readonly observedAt: string
  }): Promise<void> {
    const errorReference = `reconciliation://checkpoint/${input.checkpointId}`
    await this.#markCommandReconciliationRequired(
      input.executionId,
      input.observedAt,
      errorReference
    )
    await this.#transitionExecution(input.executionId, 'reconciliation_required', input.observedAt)
    if (input.attemptId !== undefined) {
      await this.#transitionAttempt(
        input.attemptId,
        'reconciliation_required',
        input.observedAt,
        {}
      )
    }
  }

  async resumeWorkflow(input: {
    readonly executionId: string
    readonly checkpointId: string
  }): Promise<void> {
    const execution = await this.#executions.getExecution(input.executionId)
    if (!execution) throw new Error('RECONCILIATION_EXECUTION_MISSING')
    // Terminal or already-started executions have nothing left to resume.
    if (isTerminal(execution.state) || execution.attemptCount > 0) return
    const command = await this.#commands.getByExecutionId(execution.executionId)
    if (!command) throw new Error('RECONCILIATION_COMMAND_MISSING')
    if (['processing', 'completed', 'failed'].includes(command.status)) return
    if (this.#options.cancellations !== undefined) {
      // A recorded operator cancel intent suppresses resume: reconciliation
      // must not fight an in-flight cancellation it cannot prove completed.
      const cancellations = await this.#options.cancellations.listByExecution({
        executionId: execution.executionId,
        workspaceId: execution.correlation.workspaceId,
        projectId: execution.correlation.projectId,
        limit: 1,
      })
      if (cancellations.length > 0) return
    }
    await this.#options.workflowSubmitter.submit({
      executionId: execution.executionId,
      workflowId: workflowIdFromExecutionId(execution.executionId),
      executionPlan: execution.executionPlan,
      deadlineAt: execution.deadlineAt ?? command.retentionExpiresAt,
    })
    await this.#advanceCommandToProcessing(command, this.#now())
  }

  async applyRuntimeTerminal(input: {
    readonly executionId: string
    readonly attemptId: string
    readonly checkpointId: string
    readonly outcome: ReconciliationOutcome
    readonly resultReference?: string
    readonly errorReference?: string
    readonly observedAt: string
  }): Promise<void> {
    const attempt = await this.#executions.getAttempt(input.attemptId)
    if (!attempt) throw new Error('RECONCILIATION_ATTEMPT_MISSING')
    if (isTerminal(attempt.state)) {
      if (attempt.state === input.outcome) return
      throw new Error('RECONCILIATION_TERMINAL_CONFLICT')
    }
    const failure =
      input.outcome === 'failed'
        ? ({ classification: 'runtime_error', code: 'RUNTIME_COMMAND_FAILED' } as const)
        : undefined
    const terminalResultRef =
      input.outcome === 'completed'
        ? (input.resultReference ?? throwMissingResultReference())
        : undefined
    const metadata = {
      ...(failure === undefined ? {} : { failure }),
      ...(terminalResultRef === undefined ? {} : { terminalResultRef }),
    }
    await this.#transitionAttempt(input.attemptId, input.outcome, input.observedAt, metadata)
    const execution = await this.#executions.getExecution(input.executionId)
    if (!execution) throw new Error('RECONCILIATION_EXECUTION_MISSING')
    if (isTerminal(execution.state)) {
      if (execution.state === input.outcome) return
      throw new Error('RECONCILIATION_TERMINAL_CONFLICT')
    }
    await this.#transitionExecution(input.executionId, input.outcome, input.observedAt, metadata)
  }

  async replayEvents(input: {
    readonly executionId: string
    readonly checkpointId: string
  }): Promise<void> {
    // Re-arms already-recorded outbound events only; nothing is re-issued to a
    // runtime and no delivery is attempted from inside reconciliation.
    await this.#options.events.rearmPendingDelivery(
      input.executionId,
      this.#now(),
      REPLAY_EVENT_LIMIT
    )
  }

  async #markCommandReconciliationRequired(
    executionId: string,
    observedAt: string,
    errorReference: string
  ): Promise<void> {
    for (let pass = 0; pass < RETRY_LIMIT; pass += 1) {
      const current = await this.#commands.getByExecutionId(executionId)
      if (!current) throw new Error('RECONCILIATION_COMMAND_MISSING')
      if (current.status === 'reconciliation_required') return
      // A settled inbox record cannot take reconciliation_required; the
      // execution-level parking below still records the required state.
      if (current.status === 'completed' || current.status === 'failed') return
      try {
        await this.#inbox.transitionCommand({
          callerPrincipalId: current.callerPrincipalId,
          operation: current.operation,
          workspaceId: current.workspaceId,
          projectId: current.projectId,
          idempotencyKey: current.idempotencyKey,
          expectedVersion: current.version,
          to: 'reconciliation_required',
          transitionedAt: maxTimestamp(observedAt, current.lastSeenAt),
          errorReference,
        })
        return
      } catch (error) {
        if (!(error instanceof CommandInboxError && error.code === 'STALE_COMMAND_VERSION')) {
          throw error
        }
      }
    }
    throw new Error('RECONCILIATION_COMMAND_STALE')
  }

  async #advanceCommandToProcessing(command: CommandInboxRecord, at: string): Promise<void> {
    for (let pass = 0; pass < RETRY_LIMIT; pass += 1) {
      const current = await this.#commands.getByExecutionId(command.executionId)
      if (!current) throw new Error('RECONCILIATION_COMMAND_MISSING')
      if (['processing', 'completed', 'failed'].includes(current.status)) return
      try {
        await this.#inbox.transitionCommand({
          callerPrincipalId: current.callerPrincipalId,
          operation: current.operation,
          workspaceId: current.workspaceId,
          projectId: current.projectId,
          idempotencyKey: current.idempotencyKey,
          expectedVersion: current.version,
          to: 'processing',
          transitionedAt: maxTimestamp(at, current.lastSeenAt),
        })
        return
      } catch (error) {
        if (!(error instanceof CommandInboxError && error.code === 'STALE_COMMAND_VERSION')) {
          throw error
        }
      }
    }
    throw new Error('RECONCILIATION_COMMAND_STALE')
  }

  async #transitionExecution(
    executionId: string,
    to: ExecutionState,
    observedAt: string,
    metadata: { readonly failure?: Execution['failure']; readonly terminalResultRef?: string } = {}
  ): Promise<void> {
    for (let pass = 0; pass < RETRY_LIMIT; pass += 1) {
      const current = await this.#executions.getExecution(executionId)
      if (!current) throw new Error('RECONCILIATION_EXECUTION_MISSING')
      if (current.state === to || isTerminal(current.state)) return
      try {
        await this.#lifecycle.transitionExecution({
          executionId: current.executionId,
          expectedVersion: current.version,
          to,
          transitionedAt: maxTimestamp(observedAt, current.updatedAt),
          ...metadata,
        })
        return
      } catch (error) {
        if (!isStaleLifecycleError(error)) throw error
      }
    }
    throw new Error('RECONCILIATION_EXECUTION_STALE')
  }

  async #transitionAttempt(
    attemptId: string,
    to: ExecutionAttemptState,
    observedAt: string,
    metadata: { readonly failure?: Execution['failure']; readonly terminalResultRef?: string }
  ): Promise<void> {
    for (let pass = 0; pass < RETRY_LIMIT; pass += 1) {
      const current = await this.#executions.getAttempt(attemptId)
      if (!current) throw new Error('RECONCILIATION_ATTEMPT_MISSING')
      if (current.state === to || isTerminal(current.state)) return
      try {
        await this.#lifecycle.transitionAttempt({
          attemptId: current.attemptId,
          expectedVersion: current.version,
          to,
          transitionedAt: maxTimestamp(observedAt, current.updatedAt),
          ...metadata,
        })
        return
      } catch (error) {
        if (!isStaleLifecycleError(error)) throw error
      }
    }
    throw new Error('RECONCILIATION_ATTEMPT_STALE')
  }
}

const terminalStates = new Set<ExecutionState>(['completed', 'failed', 'cancelled', 'timed_out'])

/** States from which the lifecycle accepts a `completed` outcome. */
const completableStates = new Set<ExecutionState>([
  'starting',
  'running',
  'awaiting_input',
  'cancelling',
  'reconciliation_required',
])

/** Discovery connection statuses that mean the runtime cannot be reached. */
const disconnectedConnectionStates = new Set<string>([
  'disconnected',
  'unavailable',
  'expired',
  'revoked',
])

/**
 * Maps durable runtime facts onto the observation's runtime status. Terminal
 * results are only surfaced when the recorded lifecycle states can legally
 * accept the outcome; anything ambiguous (no recorded result, lost ACK,
 * expired command, illegal rewrite) parks as `unknown` or `not_found`.
 */
export function observeRuntime(
  record: RuntimeCommandRecord | undefined,
  attempt: Pick<ExecutionAttempt, 'state' | 'updatedAt'> | undefined,
  execution: Pick<Execution, 'state' | 'updatedAt'>,
  connection:
    | {
        readonly status: string
        readonly observedAt: string | undefined
      }
    | undefined
): ReconciliationObservation['runtime'] {
  if (record !== undefined) {
    if (record.resultStatus !== undefined) {
      const outcome = record.resultStatus === 'succeeded' ? 'completed' : record.resultStatus
      if (outcome === 'completed' && record.resultReference === undefined) {
        return unknownRuntime(record)
      }
      if (
        !isTerminal(execution.state) &&
        !outcomeIsLegal(outcome, execution.state, attempt?.state)
      ) {
        return unknownRuntime(record)
      }
      return {
        status: outcome,
        observedAt: record.resultRecordedAt ?? record.updatedAt,
        ...(record.resultReference === undefined
          ? {}
          : { resultReference: record.resultReference }),
      }
    }
    if (connection !== undefined && disconnectedConnectionStates.has(connection.status)) {
      return {
        status: 'disconnected',
        observedAt: connection.observedAt ?? execution.updatedAt,
      }
    }
    if (record.status === 'dispatched' || record.status === 'acknowledged') {
      return {
        status: 'running',
        observedAt: record.acknowledgedAt ?? record.lastDispatchedAt ?? record.updatedAt,
      }
    }
    // queued or expired: whether the runtime started the work is unknowable
    // from durable facts, so the checkpoint parks instead of retrying.
    return unknownRuntime(record)
  }
  if (attempt !== undefined) return { status: 'not_found', observedAt: attempt.updatedAt }
  return { status: 'unknown', observedAt: execution.updatedAt }
}

function unknownRuntime(record: RuntimeCommandRecord): ReconciliationObservation['runtime'] {
  return { status: 'unknown', observedAt: record.updatedAt }
}

function outcomeIsLegal(
  outcome: ReconciliationOutcome,
  executionState: ExecutionState,
  attemptState: ExecutionAttemptState | undefined
): boolean {
  if (outcome === 'completed') {
    return (
      completableStates.has(executionState) &&
      (attemptState === undefined || completableStates.has(attemptState))
    )
  }
  return !isTerminal(executionState) && (attemptState === undefined || !isTerminal(attemptState))
}

function isTerminal(state: ExecutionState): boolean {
  return terminalStates.has(state)
}

function throwMissingResultReference(): string {
  throw new Error('RECONCILIATION_RUNTIME_RESULT_REFERENCE_MISSING')
}

function workflowIdFromExecutionId(
  executionId: string
): ReturnType<typeof IdentifierSchemas.workflowId.parse> {
  return IdentifierSchemas.workflowId.parse(`wfl_${executionId.slice(4)}`)
}

function maxTimestamp(left: string, right: string): string {
  return new Date(Math.max(Date.parse(left), Date.parse(right))).toISOString()
}

function isStaleLifecycleError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ['STALE_EXECUTION_VERSION', 'STALE_ATTEMPT_VERSION'].includes(error.message)
  )
}
