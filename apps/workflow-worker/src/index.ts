import {
  bootstrapService,
  jsonLogger,
  type ProcessAdapter,
  type StructuredLogger,
} from '@control-plane/bootstrap'
import type { ManagedCloudConfiguration, RawEnvironment } from '@control-plane/config'
import { managedCloudOperationalPolicy } from '@control-plane/config'
import { createR2ObjectStore, type ObjectStore } from '@control-plane/object-store'
import {
  createOpenTelemetryMetricAdapter,
  createOpenTelemetryTraceAdapter,
} from '@control-plane/telemetry/opentelemetry'
import {
  createConsoleTraceAdapter,
  createTelemetry,
  type TraceAdapter,
} from '@control-plane/telemetry'
import { createRestateEndpointFactory, type RestateEndpointFactory } from './restate-worker.js'
import {
  createManagedCloudWorkflowWorkerComposition,
  type PostgresConnectionFactory,
} from './cloud-composition.js'
import type { WorkflowRuntimeActivityPort } from './cloud-execution-activities.js'
import type { GraphSegmentActivityPort } from './graph-segment-activity.js'
import { CloudCertificationRuntime } from './cloud-certification-runtime.js'
import { DisabledCloudRuntime } from './cloud-disabled-runtime.js'

export { RuntimeDiscoveryAttemptRouter } from './runtime-attempt-router.js'
export type {
  RuntimeDiscoveryAttemptRouterOptions,
  RuntimeDiscoveryReadPort,
} from './runtime-attempt-router.js'
export { DurableRemoteWorkflowRuntime } from './remote-workflow-runtime.js'
export type {
  DurableRemoteWorkflowRuntimeOptions,
  RemoteRuntimeAttemptReader,
  RemoteRuntimeCommandFactory,
  RemoteRuntimeOutcomeWaiter,
} from './remote-workflow-runtime.js'
export { PollingRemoteRuntimeOutcomeWaiter } from './remote-runtime-waiter.js'
export type {
  PollingRemoteRuntimeOutcomeWaiterOptions,
  RemoteRuntimeCommandReader,
  RemoteRuntimeEventReader,
  RemoteRuntimeExecutionReader,
} from './remote-runtime-waiter.js'
export { ManagedPiRemoteCommandFactory } from './managed-pi-remote-command.js'
export type {
  ManagedPiExecutionReader,
  ManagedPiRemoteCommandFactoryOptions,
  ManagedPiRuntimeDiscoveryReader,
} from './managed-pi-remote-command.js'

export const serviceName = 'workflow-worker'

export interface WorkflowWorkerStartOptions {
  readonly environment?: RawEnvironment
  readonly logger?: StructuredLogger
  readonly processAdapter?: ProcessAdapter
  readonly traceAdapter?: TraceAdapter
  readonly restateEndpointFactory?: RestateEndpointFactory
  readonly workflowRuntime?: WorkflowRuntimeActivityPort
  readonly graphActivities?: GraphSegmentActivityPort
  readonly postgresConnectionFactory?: PostgresConnectionFactory
  readonly objectStoreFactory?: typeof createR2ObjectStore
}

export const start = (options: WorkflowWorkerStartOptions = {}) => {
  const logger = options.logger ?? jsonLogger
  return bootstrapService({
    serviceName,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.processAdapter === undefined ? {} : { processAdapter: options.processAdapter }),
    start: async ({ managedCloud, markReady, metadata, registerResource }) => {
      const traceAdapter =
        options.traceAdapter ??
        (metadata.environment === 'development'
          ? createConsoleTraceAdapter(logger)
          : createOpenTelemetryTraceAdapter(serviceName))
      const telemetry = createTelemetry({
        serviceName,
        logger,
        traceAdapter,
        metricAdapter: createOpenTelemetryMetricAdapter(serviceName),
      })
      await telemetry.withServiceSpan(
        'worker.initialize',
        { correlationId: metadata.instanceId },
        async () => {
          const cloudRuntime =
            managedCloud === undefined || options.workflowRuntime !== undefined
              ? options.workflowRuntime
              : createCloudRuntime(managedCloud, metadata.environment, options.objectStoreFactory)
          if (cloudRuntime instanceof CloudCertificationRuntime) {
            registerResource('workflow-worker-r2', () => cloudRuntime.objectStore.close())
          }
          const cloudComposition =
            managedCloud === undefined
              ? undefined
              : createManagedCloudWorkflowWorkerComposition(
                  managedCloud,
                  cloudRuntime,
                  options.graphActivities,
                  options.postgresConnectionFactory
                )
          if (cloudComposition !== undefined) {
            registerResource('workflow-worker-postgres', () => cloudComposition.connection.close())
            await cloudComposition.connection.check()
          }
          const factory =
            options.restateEndpointFactory ??
            (metadata.environment === 'test'
              ? {
                  create: async () => ({
                    run: async () => undefined,
                    shutdown: async () => undefined,
                  }),
                }
              : createRestateEndpointFactory({
                  ...(managedCloud?.restate?.role !== 'endpoint'
                    ? {}
                    : {
                        requestIdentityPublicKey: managedCloud.restate.requestIdentityPublicKey,
                      }),
                  ...(cloudComposition === undefined
                    ? {}
                    : { activities: cloudComposition.activities }),
                }))
          const endpoint = await factory.create()
          registerResource('restate-endpoint', () => endpoint.shutdown())
          await endpoint.run()
          markReady()
        }
      )
    },
  })
}

function createCloudRuntime(
  configuration: ManagedCloudConfiguration,
  environment: string,
  objectStoreFactory: typeof createR2ObjectStore = createR2ObjectStore
): WorkflowRuntimeActivityPort | undefined {
  if (configuration.runtime?.mode === 'remote') return undefined
  if (configuration.runtime?.mode === 'disabled') return new DisabledCloudRuntime()
  if (configuration.runtime?.mode !== 'certification')
    throw new Error('MANAGED_CLOUD_RUNTIME_NOT_CONFIGURED')
  if (environment !== 'staging') throw new Error('CLOUD_CERTIFICATION_RUNTIME_STAGING_ONLY')
  if (configuration.objectStore === undefined) throw new Error('MANAGED_CLOUD_R2_NOT_CONFIGURED')
  const objectStore: ObjectStore = objectStoreFactory(configuration.objectStore, {
    maxObjectBytes: managedCloudOperationalPolicy.payload.encryptedContentBytes,
  })
  return new CloudCertificationRuntime(objectStore)
}

export {
  DisabledGraphSegmentActivities,
  createManagedCloudWorkflowWorkerComposition,
} from './cloud-composition.js'
export {
  DurableExecutionLifecycleActivities,
  type WorkflowRuntimeActivityPort,
} from './cloud-execution-activities.js'
