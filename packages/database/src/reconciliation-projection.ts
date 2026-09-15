import { IdentifierSchemas } from '@control-plane/contracts'
import {
  CommandInboxError,
  CommandInboxService,
  ExecutionLifecycleService,
  ReconciliationReasonSchema,
  type CommandAcceptanceRepository,
  type CommandInboxRecord,
  type Execution,
  type ExecutionAttemptState,
  type ExecutionRepository,
  type ExecutionState,
  type ReconciliationEffects,
  type ReconciliationObservation,
  type ReconciliationSource,
  observeRuntime,
  isTerminalExecutionState as isTerminal,
  type ReconciliationOutcome,
} from '@control-plane/domain'

export { observeRuntime }
export type { ReconciliationOutcome }
import type { ExecutionCancellationReceipt } from '@control-plane/domain'
import type { ExecutionWorkflowInput } from '@control-plane/orchestration'
import type {
  PostgresExecutionEventRepository,
  PendingDeliverySummary,
} from './execution-event-repository.js'
import type { PostgresExecutionRepository } from './execution-repository.js'
import type { PostgresRuntimeCommandRepository } from './runtime-command-repository.js'
import type { PostgresRuntimeConnectionRepository } from './runtime-connection-repository.js'

/** Mirrors the domain decision reasons without widening the domain surface. */
type ReconciliationReason = ReturnType<typeof ReconciliationReasonSchema.parse>

/**
 * Production reconciliation projection over existing durable PostgreSQL rows.
 *
 * The source assembles a `ReconciliationObservation` exclusively from existing
 * repositories (executions/attempts, command inbox, runtime commands, runtime
 * connection rows, event publication state) and surfaces only stale or
 * undelivered candidates. Workflow execution state lives inside the workflow
 * runtime and is not durably readable here, so the observation reports the
 * workflow as `missing` and lets the domain decision fall through to the
 * attempt/runtime facts it can prove.
 *
 * The effects land decisions on the existing lifecycle states (the domain
 * service maps outcomes onto converged / reconciliation_required /
 * manual_intervention) and never perform an operation whose effect they cannot
 * prove idempotent:
 * - a lost-ACK style uncertainty (queued or expired runtime command, no
 *   recorded result) is observed as `unknown`, which parks the checkpoint as
 *   waiting — a potentially billable runtime command is never re-dispatched;
 * - runtime terminal results are only applied when the recorded lifecycle
 *   states can legally accept the outcome, and a conflicting recorded terminal
 *   state is never rewritten (a cancellation of the workflow wait is not proof
 *   the runtime effects were cancelled);
 * - recorded operator cancellation intent suppresses workflow resume;
 * - `replay_events` only re-arms already-recorded outbound events, it never
 *   re-issues runtime work.
 */

export interface PostgresReconciliationSourceOptions {
  readonly executions: Pick<
    PostgresExecutionRepository,
    'getExecution' | 'getAttempt' | 'listReconciliationCandidates'
  >
  readonly commands: Pick<CommandAcceptanceRepository, 'getByExecutionId'>
  readonly runtimeCommands: Pick<PostgresRuntimeCommandRepository, 'latestForAttempt'>
  readonly runtimeConnections: Pick<PostgresRuntimeConnectionRepository, 'get'>
  readonly events: Pick<PostgresExecutionEventRepository, 'summarizePendingDelivery'>
  /** Staleness bound for candidate scanning; milliseconds, positive integer. */
  readonly candidateStaleAfterMs?: number
  readonly now?: () => string
}

const DEFAULT_CANDIDATE_STALE_AFTER_MS = 60_000
const PENDING_DELIVERY_SCAN_LIMIT = 100

export class PostgresReconciliationSource implements ReconciliationSource {
  readonly #executions: PostgresReconciliationSourceOptions['executions']
  readonly #commands: PostgresReconciliationSourceOptions['commands']
  readonly #runtimeCommands: PostgresReconciliationSourceOptions['runtimeCommands']
  readonly #runtimeConnections: PostgresReconciliationSourceOptions['runtimeConnections']
  readonly #events: PostgresReconciliationSourceOptions['events']
  readonly #staleAfterMs: number
  readonly #now: () => string

  constructor(options: PostgresReconciliationSourceOptions) {
    this.#executions = options.executions
    this.#commands = options.commands
    this.#runtimeCommands = options.runtimeCommands
    this.#runtimeConnections = options.runtimeConnections
    this.#events = options.events
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
    return this.#executions.listReconciliationCandidates({
      staleBefore: new Date(Date.parse(this.#now()) - this.#staleAfterMs).toISOString(),
      limit,
    })
  }

  async load(executionId: string): Promise<ReconciliationObservation> {
    const execution = await this.#executions.getExecution(executionId)
    if (!execution) throw new Error('RECONCILIATION_EXECUTION_MISSING')
    const command = await this.#commands.getByExecutionId(execution.executionId)
    if (!command) throw new Error('RECONCILIATION_COMMAND_MISSING')
    const attempt =
      execution.latestAttemptId === undefined
        ? undefined
        : await this.#executions.getAttempt(execution.latestAttemptId)
    const runtimeCommand =
      attempt === undefined
        ? undefined
        : await this.#runtimeCommands.latestForAttempt(attempt.attemptId)
    const connection =
      attempt?.runtime?.runtimeConnectionId === undefined
        ? undefined
        : await this.#runtimeConnections.get(attempt.runtime.runtimeConnectionId)
    const delivery: PendingDeliverySummary = await this.#events.summarizePendingDelivery(
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
      runtime: observeRuntime(
        runtimeCommand,
        attempt,
        execution,
        // The domain rule is structural: the connection's own observation time
        // feeds the observation, and the lifecycle timestamp backs it up.
        connection === undefined
          ? undefined
          : { status: connection.status, observedAt: connection.updatedAt }
      ),
      delivery: {
        pendingCount: delivery.pendingCount,
        ...(delivery.oldestPendingAt === undefined
          ? {}
          : { oldestPendingAt: delivery.oldestPendingAt }),
      },
    }
  }
}

/** The workflow submission payload; re-driven verbatim on resume. */
export type WorkflowSubmitInput = ExecutionWorkflowInput

export interface PostgresReconciliationEffectsOptions {
  readonly executions: ExecutionRepository
  readonly commands: CommandAcceptanceRepository
  readonly events: Pick<PostgresExecutionEventRepository, 'rearmPendingDelivery'>
  /** Re-drives an accepted workflow into the workflow runtime (idempotent by execution id). */
  readonly workflowSubmitter: { readonly submit: (input: WorkflowSubmitInput) => Promise<void> }
  readonly cancellations?: {
    readonly listByExecution: (input: {
      readonly executionId: string
      readonly workspaceId: string
      readonly projectId: string
      readonly limit: number
    }) => Promise<readonly ExecutionCancellationReceipt[]>
  }
  readonly now?: () => string
}

const RETRY_LIMIT = 3
const REPLAY_EVENT_LIMIT = 100

export class PostgresReconciliationEffects implements ReconciliationEffects {
  readonly #lifecycle: ExecutionLifecycleService
  readonly #executions: ExecutionRepository
  readonly #commands: CommandAcceptanceRepository
  readonly #inbox: CommandInboxService
  readonly #options: PostgresReconciliationEffectsOptions
  readonly #now: () => string

  constructor(options: PostgresReconciliationEffectsOptions) {
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
