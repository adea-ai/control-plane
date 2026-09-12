import { bootstrapService, type ServiceStartOptions } from '@control-plane/bootstrap'
import type { HostedManagedPiWorker } from './hosted-managed-pi.js'
import { composeContextNode, type ContextNodeCompositionOptions } from './composition.js'

export * from './hosted-managed-pi.js'
export * from './context-node-handler.js'
export * from './context-http-driver.js'
export * from './context-node-channel.js'
export * from './composition.js'

export const serviceName = 'runtime-worker'
export interface RuntimeWorkerStartOptions extends ServiceStartOptions {
  readonly hostedManagedPiWorker?: HostedManagedPiWorker
  /** Explicit node composition config; absent config composes no context node. */
  readonly contextNode?: ContextNodeCompositionOptions
}

export const start = (options: RuntimeWorkerStartOptions = {}) => {
  const { hostedManagedPiWorker, contextNode, ...serviceOptions } = options
  return bootstrapService({
    ...serviceOptions,
    serviceName,
    start: async ({ markReady, metadata, registerResource }) => {
      if (
        hostedManagedPiWorker === undefined &&
        (metadata.environment === 'staging' || metadata.environment === 'production')
      ) {
        throw new Error('HOSTED_MANAGED_PI_WORKER_REQUIRED')
      }
      if (contextNode !== undefined) {
        // Invalid or partial node config fails closed before the worker reports ready.
        const composition = await composeContextNode(contextNode)
        registerResource('context-node-composition', () => composition.close())
      }
      if (hostedManagedPiWorker) {
        registerResource('hosted-managed-pi-worker', () => hostedManagedPiWorker.close())
        const readiness = await hostedManagedPiWorker.readiness()
        if (!readiness.ready) throw new Error(`HOSTED_MANAGED_PI_${readiness.reason}`)
      }
      markReady()
    },
  })
}
