import process from 'node:process'
import { bootstrapService, type ServiceStartOptions } from '@control-plane/bootstrap'
import type { RuntimeGatewayWebSocketServer } from './websocket-server.js'
import type { RuntimeHealthDeliveryWorker } from './runtime-health-delivery-worker.js'
import {
  composeRuntimeGateway,
  runtimeGatewayStoreConfigFromEnvironment,
  type RuntimeGatewayComposition,
  type RuntimeGatewayCompositionOptions,
} from './composition.js'

export * from './authentication.js'
export * from './runtime-command-delivery.js'
export * from './context-command-delivery.js'
export * from './context-command-recovery.js'
export * from './context-read-client.js'
export * from './context-read-binding.js'
export * from './context-provider-composition.js'
export * from './composition.js'
export * from './context-result-store.js'
export * from './context-result-integrity.js'
export * from './reconnect-reconciliation.js'
export * from './runtime-event-ingestion.js'
export * from './runtime-inventory-ingestion.js'
export * from './runtime-inventory-maintenance.js'
export * from './runtime-health-delivery-worker.js'
export * from './runtime-message-handler.js'
export * from './websocket-lifecycle.js'

export const serviceName = 'runtime-gateway'
export interface RuntimeGatewayStartOptions extends ServiceStartOptions {
  readonly webSocketServer?: RuntimeGatewayWebSocketServer
  readonly healthDeliveryWorker?: RuntimeHealthDeliveryWorker
  /** Explicit store authority; when absent it is parsed from the environment, failing closed. */
  readonly store?: RuntimeGatewayCompositionOptions['store']
  readonly objectStore?: RuntimeGatewayCompositionOptions['objectStore']
  readonly authenticateUpgrade?: RuntimeGatewayCompositionOptions['authenticateUpgrade']
  readonly metrics?: RuntimeGatewayCompositionOptions['metrics']
  readonly reachability?: RuntimeGatewayCompositionOptions['reachability']
  readonly traceId?: RuntimeGatewayCompositionOptions['traceId']
  /** Explicit metric adapter; when absent the gateway emits no consistency metrics. */
  readonly metricAdapter?: RuntimeGatewayCompositionOptions['metricAdapter']
  readonly instanceId?: RuntimeGatewayCompositionOptions['instanceId']
  readonly hostname?: RuntimeGatewayCompositionOptions['hostname']
}

export const start = ({
  webSocketServer,
  healthDeliveryWorker,
  store,
  ...options
}: RuntimeGatewayStartOptions = {}) =>
  bootstrapService({
    ...options,
    serviceName,
    start: async ({ markReady, config, registerResource }) => {
      let composed: RuntimeGatewayComposition | undefined
      let server = webSocketServer
      if (server === undefined) {
        const environment = options.environment ?? process.env
        composed = await composeRuntimeGateway({
          store: store ?? runtimeGatewayStoreConfigFromEnvironment(environment),
          port: config.values.port,
          // Blank env values stay fail-closed: the composition rejects them.
          instanceId: options.instanceId ?? environment['RUNTIME_GATEWAY_INSTANCE_ID'] ?? '',
          hostname: options.hostname ?? environment['RUNTIME_GATEWAY_HOST'] ?? '',
          objectStore: options.objectStore,
          authenticateUpgrade: options.authenticateUpgrade,
          metrics: options.metrics,
          reachability: options.reachability,
          traceId: options.traceId,
          metricAdapter: options.metricAdapter,
        })
        server = composed.webSocketServer
      }
      // Reverse-order cleanup drains channels before waiting on event delivery.
      if (healthDeliveryWorker !== undefined)
        registerResource('runtime-health-delivery', () => healthDeliveryWorker.close())
      if (composed !== undefined)
        registerResource('runtime-gateway-composition', () => composed.close())
      else if (server !== undefined)
        registerResource('runtime-gateway-websocket', () => server.close())
      server.start()
      healthDeliveryWorker?.start()
      markReady()
    },
  })
