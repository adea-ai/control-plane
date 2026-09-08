import { bootstrapService, type ServiceStartOptions } from '@control-plane/bootstrap'
import type { RuntimeGatewayWebSocketServer } from './websocket-server.js'

export * from './authentication.js'
export * from './runtime-command-delivery.js'
export * from './reconnect-reconciliation.js'
export * from './runtime-event-ingestion.js'
export * from './runtime-inventory-ingestion.js'
export * from './runtime-inventory-maintenance.js'
export * from './runtime-message-handler.js'
export * from './websocket-lifecycle.js'

export const serviceName = 'runtime-gateway'
export interface RuntimeGatewayStartOptions extends ServiceStartOptions {
  readonly webSocketServer?: RuntimeGatewayWebSocketServer
}

export const start = ({ webSocketServer, ...options }: RuntimeGatewayStartOptions = {}) =>
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
      if (webSocketServer !== undefined) {
        webSocketServer.start()
        registerResource('runtime-gateway-websocket', () => webSocketServer.close())
      }
      markReady()
    },
  })
