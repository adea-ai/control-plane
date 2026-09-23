import type {
  CommandAcceptanceRepository,
  ExecutionCancellationReceipt,
  ExecutionRepository,
  ReconciliationEffects,
  ReconciliationObservation,
  ReconciliationSource,
} from '@control-plane/domain'
import { createReconciliationEffects, createReconciliationSource } from '@control-plane/domain'
export { observeRuntime } from '@control-plane/domain'
export type { ReconciliationOutcome } from '@control-plane/domain'
import type { ExecutionWorkflowInput } from '@control-plane/orchestration'
import type { PostgresExecutionEventRepository } from './execution-event-repository.js'
import type { PostgresExecutionRepository } from './execution-repository.js'
import type { PostgresRuntimeCommandRepository } from './runtime-command-repository.js'
import type { PostgresRuntimeConnectionRepository } from './runtime-connection-repository.js'

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
 * prove idempotent — see createReconciliationEffects for the full contract.
 *
 * The storage-neutral logic lives in `@control-plane/domain`
 * (createReconciliationSource / createReconciliationEffects); this adapter maps
 * its repositories onto those structural ports.
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

export class PostgresReconciliationSource implements ReconciliationSource {
  readonly #source: ReconciliationSource

  constructor(options: PostgresReconciliationSourceOptions) {
    this.#source = createReconciliationSource(
      {
        executions: options.executions,
        commands: options.commands,
        runtimeCommands: options.runtimeCommands,
        runtimeConnections: {
          observe: async ({ runtimeConnectionId }) => {
            const connection = await options.runtimeConnections.get(runtimeConnectionId)
            // The domain rule is structural: the connection's own observation
            // time feeds the observation, backed by the lifecycle timestamp.
            return connection === undefined
              ? undefined
              : { status: connection.status, observedAt: connection.updatedAt }
          },
        },
        events: options.events,
      },
      { candidateStaleAfterMs: options.candidateStaleAfterMs, now: options.now }
    )
  }

  listCandidates(input: { readonly limit: number }): Promise<readonly string[]> {
    return this.#source.listCandidates(input)
  }

  load(executionId: string): Promise<ReconciliationObservation> {
    return this.#source.load(executionId)
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

export class PostgresReconciliationEffects implements ReconciliationEffects {
  readonly #effects: ReconciliationEffects

  constructor(options: PostgresReconciliationEffectsOptions) {
    this.#effects = createReconciliationEffects({
      executions: options.executions,
      commands: options.commands,
      events: options.events,
      workflowSubmitter: options.workflowSubmitter,
      ...(options.cancellations === undefined ? {} : { cancellations: options.cancellations }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  }

  markReconciliationRequired(
    input: Parameters<ReconciliationEffects['markReconciliationRequired']>[0]
  ): Promise<void> {
    return this.#effects.markReconciliationRequired(input)
  }

  resumeWorkflow(input: Parameters<ReconciliationEffects['resumeWorkflow']>[0]): Promise<void> {
    return this.#effects.resumeWorkflow(input)
  }

  applyRuntimeTerminal(
    input: Parameters<ReconciliationEffects['applyRuntimeTerminal']>[0]
  ): Promise<void> {
    return this.#effects.applyRuntimeTerminal(input)
  }

  replayEvents(input: Parameters<ReconciliationEffects['replayEvents']>[0]): Promise<void> {
    return this.#effects.replayEvents(input)
  }
}
