import { bootstrapService, type ServiceStartOptions } from '@control-plane/bootstrap'
import type { RuntimeGatewayWebSocketServer } from './websocket-server.js'
import type { RuntimeHealthDeliveryWorker } from './runtime-health-delivery-worker.js'

export * from './authentication.js'
export * from './runtime-command-delivery.js'
export * from './context-command-delivery.js'
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
}

export const start = ({
  webSocketServer,
  healthDeliveryWorker,
  ...options
}: RuntimeGatewayStartOptions = {}) =>
  bootstrapService({
    ...options,
    serviceName,
    start: ({ markReady, metadata, registerResource }) => {
      if (
        webSocketServer === undefined &&
        (metadata.environment === 'staging' || metadata.environment === 'production')
      ) {
        throw new Error('Runtime Gateway WebSocket server is required outside local environments')
      }
      // Reverse-order cleanup drains channels before waiting on event delivery.
      if (healthDeliveryWorker !== undefined)
        registerResource('runtime-health-delivery', () => healthDeliveryWorker.close())
      if (webSocketServer !== undefined) {
        webSocketServer.start()
        registerResource('runtime-gateway-websocket', () => webSocketServer.close())
      }
      healthDeliveryWorker?.start()
      markReady()
    },
  })
