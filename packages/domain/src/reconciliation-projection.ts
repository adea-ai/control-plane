import { IdentifierSchemas } from '@control-plane/contracts'
import { CommandInboxService, type CommandAcceptanceRepository } from './command-inbox.js'
import type { ExecutionCancellationReceipt } from './execution-cancellation-command.js'
import {
  ExecutionLifecycleService,
  type Execution,
  type ExecutionAttemptState,
  type ExecutionRepository,
  type ExecutionState,
} from './execution-lifecycle.js'
import {
  advanceCommandToProcessingWithRetry,
  isTerminalExecutionState as isTerminal,
  markCommandReconciliationRequiredWithRetry,
  observeRuntime,
  transitionAttemptWithRetry,
  transitionExecutionWithRetry,
  type ReconciliationCommandPort,
  type ReconciliationConnectionView,
  type ReconciliationEffects,
  type ReconciliationObservation,
  type ReconciliationSource,
} from './execution-reconciliation.js'
import type { RuntimeCommandRecord } from './runtime-command.js'

/**
 * Shared reconciliation projection (#522 pattern, consolidated for the #192
 * follow-up): the PostgreSQL and SQLite adapters previously carried two
 * structurally identical copies of the source/effects logic — identical class
 * bodies differing only in repository types, plus a duplicated workflow
 * submit-input twin that could drift. The storage-neutral logic lives here
 * behind structural ports; each adapter keeps its public class names and
 * option types as thin wrappers that map its repositories onto these ports.
 */

/** Structural view of a pending-delivery summary (the adapters' own shape). */
export interface PendingDeliverySummaryView {
  readonly pendingCount: number
  readonly oldestPendingAt?: string | undefined
}

/**
 * The workflow submission payload; structurally the control API's
 * `ExecutionWorkflowInput` (same branded contracts identifiers), so the
 * composition can hand the production workflow dispatcher straight in.
 */
export interface ReconciliationWorkflowSubmitInput {
  readonly executionId: ReturnType<typeof IdentifierSchemas.executionId.parse>
  readonly workflowId: ReturnType<typeof IdentifierSchemas.workflowId.parse>
  readonly executionPlan: {
    readonly executionPlanId: ReturnType<typeof IdentifierSchemas.executionPlanId.parse>
    readonly contentDigest: string
    readonly schemaVersion: number
  }
  readonly deadlineAt: string
  readonly marketplacePluginReferences?: Execution['marketplacePluginReferences']
}

export interface ReconciliationSourcePorts {
  readonly executions: Pick<ExecutionRepository, 'getExecution' | 'getAttempt'> & {
    listReconciliationCandidates(input: {
      readonly staleBefore: string
      readonly limit: number
    }): Promise<readonly string[]>
  }
  readonly commands: Pick<CommandAcceptanceRepository, 'getByExecutionId'>
  readonly runtimeCommands: {
    latestForAttempt(attemptId: string): Promise<RuntimeCommandRecord | undefined>
  }
  /**
   * Normalized connection observation: adapters map their own connection
   * records onto the domain view so the shared source stays storage-neutral.
   */
  readonly runtimeConnections: {
    observe(input: {
      readonly execution: Execution
      readonly runtimeConnectionId: string
    }): Promise<ReconciliationConnectionView | undefined>
  }
  readonly events: {
    summarizePendingDelivery(
      executionId: string,
      limit: number
    ): Promise<PendingDeliverySummaryView>
  }
}

export interface ReconciliationSourceOptions {
  /** Staleness bound for candidate scanning; milliseconds, positive integer. */
  readonly candidateStaleAfterMs?: number | undefined
  readonly now?: (() => string) | undefined
}

const DEFAULT_CANDIDATE_STALE_AFTER_MS = 60_000
const PENDING_DELIVERY_SCAN_LIMIT = 100
const REPLAY_EVENT_LIMIT = 100

export function createReconciliationSource(
  ports: ReconciliationSourcePorts,
  options: ReconciliationSourceOptions = {}
): ReconciliationSource {
  const staleAfterMs = options.candidateStaleAfterMs ?? DEFAULT_CANDIDATE_STALE_AFTER_MS
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new Error('INVALID_RECONCILIATION_CANDIDATE_STALENESS')
  }
  const now = options.now ?? (() => new Date().toISOString())

  return {
    async listCandidates(input): Promise<readonly string[]> {
      const { limit } = input
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error('INVALID_RECONCILIATION_CANDIDATE_LIMIT')
      }
      return ports.executions.listReconciliationCandidates({
        staleBefore: new Date(Date.parse(now()) - staleAfterMs).toISOString(),
        limit,
      })
    },

    async load(executionId): Promise<ReconciliationObservation> {
      const execution = await ports.executions.getExecution(executionId)
      if (!execution) throw new Error('RECONCILIATION_EXECUTION_MISSING')
      const command = await ports.commands.getByExecutionId(execution.executionId)
      if (!command) throw new Error('RECONCILIATION_COMMAND_MISSING')
      const attempt =
        execution.latestAttemptId === undefined
          ? undefined
          : await ports.executions.getAttempt(execution.latestAttemptId)
      const runtimeCommand =
        attempt === undefined
          ? undefined
          : await ports.runtimeCommands.latestForAttempt(attempt.attemptId)
      const connection =
        attempt?.runtime?.runtimeConnectionId === undefined
          ? undefined
          : await ports.runtimeConnections.observe({
              execution,
              runtimeConnectionId: attempt.runtime.runtimeConnectionId,
            })
      const delivery = await ports.events.summarizePendingDelivery(
        execution.executionId,
        PENDING_DELIVERY_SCAN_LIMIT
      )
      return {
        executionId: execution.executionId,
        checkedAt: now(),
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
    },
  }
}

export interface ReconciliationEffectsPorts {
  readonly executions: ExecutionRepository
  readonly commands: CommandAcceptanceRepository
  readonly events: {
    rearmPendingDelivery(executionId: string, dueAt: string, limit: number): Promise<number>
  }
  /** Re-drives an accepted workflow into the workflow runtime (idempotent by execution id). */
  readonly workflowSubmitter: {
    submit(input: ReconciliationWorkflowSubmitInput): Promise<void>
  }
  readonly cancellations?: {
    listByExecution(input: {
      readonly executionId: string
      readonly workspaceId: string
      readonly projectId: string
      readonly limit: number
    }): Promise<readonly ExecutionCancellationReceipt[]>
  }
  readonly now?: (() => string) | undefined
}

/**
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
export function createReconciliationEffects(
  ports: ReconciliationEffectsPorts
): ReconciliationEffects {
  const lifecycle = new ExecutionLifecycleService(ports.executions)
  // Transition-only usage: acceptance and plan validation are never invoked.
  const inbox = new CommandInboxService({
    repository: ports.commands,
    executionIdFactory: (): never => {
      throw new Error('RECONCILIATION_EFFECTS_CANNOT_ACCEPT_EXECUTIONS')
    },
    executionPlanValidator: { validate: async () => true },
  })
  const now = ports.now ?? (() => new Date().toISOString())

  const commandPort = (): ReconciliationCommandPort => ({
    getByExecutionId: (executionId) => ports.commands.getByExecutionId(executionId),
    transitionCommand: (input) => inbox.transitionCommand(input),
  })

  const transitionExecution = async (
    executionId: string,
    to: ExecutionState,
    observedAt: string,
    metadata: { readonly failure?: Execution['failure']; readonly terminalResultRef?: string } = {}
  ): Promise<void> => {
    await transitionExecutionWithRetry(
      {
        getExecution: (id) => ports.executions.getExecution(id),
        transitionExecution: (input) => lifecycle.transitionExecution(input),
      },
      { executionId, to, observedAt, metadata }
    )
  }

  const transitionAttempt = async (
    attemptId: string,
    to: ExecutionAttemptState,
    observedAt: string,
    metadata: { readonly failure?: Execution['failure']; readonly terminalResultRef?: string } = {}
  ): Promise<void> => {
    await transitionAttemptWithRetry(
      {
        getAttempt: (id) => ports.executions.getAttempt(id),
        transitionAttempt: (input) => lifecycle.transitionAttempt(input),
      },
      { attemptId, to, observedAt, metadata }
    )
  }

  return {
    async markReconciliationRequired(input): Promise<void> {
      const errorReference = `reconciliation://checkpoint/${input.checkpointId}`
      await markCommandReconciliationRequiredWithRetry(commandPort(), {
        executionId: input.executionId,
        observedAt: input.observedAt,
        errorReference,
      })
      await transitionExecution(input.executionId, 'reconciliation_required', input.observedAt)
      if (input.attemptId !== undefined) {
        await transitionAttempt(input.attemptId, 'reconciliation_required', input.observedAt, {})
      }
    },

    async resumeWorkflow(input): Promise<void> {
      const execution = await ports.executions.getExecution(input.executionId)
      if (!execution) throw new Error('RECONCILIATION_EXECUTION_MISSING')
      // Terminal or already-started executions have nothing left to resume.
      if (isTerminal(execution.state) || execution.attemptCount > 0) return
      const command = await ports.commands.getByExecutionId(execution.executionId)
      if (!command) throw new Error('RECONCILIATION_COMMAND_MISSING')
      if (['processing', 'completed', 'failed'].includes(command.status)) return
      if (ports.cancellations !== undefined) {
        // A recorded operator cancel intent suppresses resume: reconciliation
        // must not fight an in-flight cancellation it cannot prove completed.
        const cancellations = await ports.cancellations.listByExecution({
          executionId: execution.executionId,
          workspaceId: execution.correlation.workspaceId,
          projectId: execution.correlation.projectId,
          limit: 1,
        })
        if (cancellations.length > 0) return
      }
      await ports.workflowSubmitter.submit({
        executionId: execution.executionId,
        workflowId: workflowIdFromExecutionId(execution.executionId),
        executionPlan: execution.executionPlan,
        ...(execution.marketplacePluginReferences === undefined
          ? {}
          : { marketplacePluginReferences: execution.marketplacePluginReferences }),
        deadlineAt: execution.deadlineAt ?? command.retentionExpiresAt,
      })
      await advanceCommandToProcessingWithRetry(commandPort(), { command, at: now() })
    },

    async applyRuntimeTerminal(input): Promise<void> {
      const attempt = await ports.executions.getAttempt(input.attemptId)
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
      await transitionAttempt(input.attemptId, input.outcome, input.observedAt, metadata)
      const execution = await ports.executions.getExecution(input.executionId)
      if (!execution) throw new Error('RECONCILIATION_EXECUTION_MISSING')
      if (isTerminal(execution.state)) {
        if (execution.state === input.outcome) return
        throw new Error('RECONCILIATION_TERMINAL_CONFLICT')
      }
      await transitionExecution(input.executionId, input.outcome, input.observedAt, metadata)
    },

    async replayEvents(input): Promise<void> {
      // Re-arms already-recorded outbound events only; nothing is re-issued to
      // a runtime and no delivery is attempted from inside reconciliation.
      await ports.events.rearmPendingDelivery(input.executionId, now(), REPLAY_EVENT_LIMIT)
    },
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
