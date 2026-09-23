import type {
  CommandAcceptanceRepository,
  ExecutionRepository,
  ReconciliationEffects,
  ReconciliationObservation,
  ReconciliationSource,
  ReconciliationWorkflowSubmitInput as WorkflowSubmitInput,
} from '@control-plane/domain'
import { createReconciliationEffects, createReconciliationSource } from '@control-plane/domain'
export { observeRuntime } from '@control-plane/domain'
export type { ReconciliationOutcome } from '@control-plane/domain'
import type { SqliteExecutionRepository } from './repositories.js'
import type {
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
 * never perform an operation whose effect they cannot prove idempotent — see
 * createReconciliationEffects for the full contract. Workflow execution state
 * lives inside the workflow runtime and is not durably readable here, so the
 * observation reports the workflow as `missing`.
 *
 * The storage-neutral logic lives in `@control-plane/domain`
 * (createReconciliationSource / createReconciliationEffects); this adapter maps
 * its repositories onto those structural ports.
 */

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

export class SqliteReconciliationSource implements ReconciliationSource {
  readonly #source: ReconciliationSource

  constructor(options: SqliteReconciliationSourceOptions) {
    this.#source = createReconciliationSource(
      {
        executions: options.executions,
        commands: options.commands,
        runtimeCommands: options.runtimeCommands,
        runtimeConnections: {
          observe: async ({ execution, runtimeConnectionId }) => {
            const connection = await options.runtimeConnections.getRuntimeConnection(
              {
                workspaceId: execution.correlation.workspaceId,
              } satisfies SqliteRuntimeDiscoveryScope,
              runtimeConnectionId
            )
            return connection === undefined
              ? undefined
              : { status: connection.status, observedAt: connection.observedAt }
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

/**
 * The workflow submission payload — re-exported from the shared domain
 * projection (#192 consolidation) so the local twin can no longer drift from
 * the control API's `ExecutionWorkflowInput` shape.
 */
export type { WorkflowSubmitInput }

export interface SqliteReconciliationEffectsOptions {
  readonly executions: ExecutionRepository
  readonly commands: CommandAcceptanceRepository
  readonly events: Pick<SqliteExecutionEventRepository, 'rearmPendingDelivery'>
  /** Re-drives an accepted workflow into the workflow runtime (idempotent by execution id). */
  readonly workflowSubmitter: { readonly submit: (input: WorkflowSubmitInput) => Promise<void> }
  readonly cancellations?: Pick<SqliteExecutionCancellationRepository, 'listByExecution'>
  readonly now?: () => string
}

export class SqliteReconciliationEffects implements ReconciliationEffects {
  readonly #effects: ReconciliationEffects

  constructor(options: SqliteReconciliationEffectsOptions) {
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
