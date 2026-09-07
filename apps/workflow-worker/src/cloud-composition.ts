import type { ManagedCloudConfiguration } from '@control-plane/config'
import {
  createPostgresConnection,
  PostgresCommandAcceptanceRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  PostgresContextPackageRepository,
  PostgresInteractionRepository,
  PostgresRuntimeCommandRepository,
  PostgresRuntimeDiscoveryRepository,
  PostgresExecutionEventRepository,
  type PostgresConnection,
} from '@control-plane/database'
import { CommandInboxService, ExecutionLifecycleService } from '@control-plane/domain'
import { ExecutionPlanAcceptanceValidator } from '@control-plane/execution-plan'
import {
  DurableExecutionLifecycleActivities,
  type WorkflowRuntimeActivityPort,
} from './cloud-execution-activities.js'
import type { GraphSegmentActivityPort } from './graph-segment-activity.js'
import { DurableRemoteWorkflowRuntime } from './remote-workflow-runtime.js'
import { ManagedPiRemoteCommandFactory } from './managed-pi-remote-command.js'
import { PollingRemoteRuntimeOutcomeWaiter } from './remote-runtime-waiter.js'
import { RuntimeDiscoveryAttemptRouter } from './runtime-attempt-router.js'

export type PostgresConnectionFactory = typeof createPostgresConnection

export interface ManagedCloudWorkflowWorkerComposition {
  readonly connection: PostgresConnection
  readonly activities: DurableExecutionLifecycleActivities
  readonly runtime: WorkflowRuntimeActivityPort
  readonly runtimeRouter?: RuntimeDiscoveryAttemptRouter
}

export class WorkflowWorkerCloudCompositionError extends Error {
  constructor() {
    super('Managed Cloud workflow worker composition is invalid')
    this.name = 'WorkflowWorkerCloudCompositionError'
  }
}

export class DisabledGraphSegmentActivities implements GraphSegmentActivityPort {
  async runGraphSegment(): Promise<never> {
    throw new Error('GRAPH_EXECUTION_DISABLED')
  }

  async resumeGraphSegment(): Promise<never> {
    throw new Error('GRAPH_EXECUTION_DISABLED')
  }

  async continueGraphSegment(): Promise<never> {
    throw new Error('GRAPH_EXECUTION_DISABLED')
  }

  async cancelGraphSegment(): Promise<void> {}
}

export function createManagedCloudWorkflowWorkerComposition(
  configuration: ManagedCloudConfiguration,
  runtime: WorkflowRuntimeActivityPort | undefined,
  graph: GraphSegmentActivityPort = new DisabledGraphSegmentActivities(),
  connectionFactory: PostgresConnectionFactory = createPostgresConnection
): ManagedCloudWorkflowWorkerComposition {
  if (
    configuration.service !== 'workflow-worker' ||
    configuration.database === undefined ||
    configuration.restate?.role !== 'endpoint'
  ) {
    throw new WorkflowWorkerCloudCompositionError()
  }
  if (runtime === undefined && configuration.runtime?.mode !== 'remote')
    throw new Error('MANAGED_CLOUD_RUNTIME_NOT_CONFIGURED')
  const connection = connectionFactory(configuration.database)
  const plans = new PostgresExecutionPlanRepository(connection.database)
  const executions = new PostgresExecutionRepository(connection.database)
  const discovery = new PostgresRuntimeDiscoveryRepository(connection.database)
  const runtimeRouter =
    configuration.runtime?.mode === 'remote'
      ? new RuntimeDiscoveryAttemptRouter({ discovery })
      : undefined
  const commands = new PostgresRuntimeCommandRepository(connection.database)
  const selectedRuntime =
    runtime ??
    new DurableRemoteWorkflowRuntime({
      attempts: executions,
      commands,
      factory: new ManagedPiRemoteCommandFactory({
        contextPackages: new PostgresContextPackageRepository(connection.database),
        executions,
        interactions: new PostgresInteractionRepository(connection.database),
        runtimeDiscovery: {
          getRuntimeConnection: ({ runtimeConnectionId, ...scope }) =>
            discovery.getRuntimeConnection(scope, runtimeConnectionId),
        },
      }),
      waiter: new PollingRemoteRuntimeOutcomeWaiter({
        executions,
        commands,
        events: new PostgresExecutionEventRepository(connection.database),
      }),
    })
  return {
    connection,
    runtime: selectedRuntime,
    ...(runtimeRouter === undefined ? {} : { runtimeRouter }),
    activities: new DurableExecutionLifecycleActivities({
      lifecycle: new ExecutionLifecycleService(executions),
      plans,
      runtime: selectedRuntime,
      ...(runtimeRouter === undefined ? {} : { runtimeRouter }),
      graph,
      commands: new CommandInboxService({
        repository: new PostgresCommandAcceptanceRepository(connection.database),
        executionIdFactory: unavailableExecutionIdFactory,
        executionPlanValidator: new ExecutionPlanAcceptanceValidator(plans),
      }),
    }),
  }
}

function unavailableExecutionIdFactory(): never {
  throw new Error('WORKFLOW_WORKER_CANNOT_ACCEPT_EXECUTIONS')
}
