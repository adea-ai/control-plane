import type { NodePiDurableLeadCompositionOptions } from '../pi-durable/node-composition.js'

/** Binds the same real adapter before startup can schedule any retained work. */
export function createProductionRuntimeBinding() {
  let adapter:
    | Parameters<NonNullable<NodePiDurableLeadCompositionOptions['onAdapterReady']>>[0]
    | undefined
  return {
    onAdapterReady: (ready: NonNullable<typeof adapter>) => {
      if (adapter && adapter !== ready) throw new Error('PI_RUNTIME_BINDING_CHANGED')
      adapter = ready
    },
    async assertSupported() {
      if (!adapter) throw new Error('PI_RUNTIME_NOT_INITIALIZED')
      const inspection = await adapter.inspect()
      if (
        inspection.health !== 'healthy' ||
        !inspection.capabilities.some(
          (capability) =>
            capability.name === 'execution.scope.workspace.v1' && capability.support === 'supported'
        )
      )
        throw new Error('PI_LEAD_WORKSPACE_SCOPE_UNSUPPORTED')
    },
  }
}
