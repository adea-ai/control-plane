import {
  ContextProviderRequestSchema,
  ContextProviderResolver,
  type ContextProviderRequest,
} from '@control-plane/context'
import {
  CortanaContextProviderAdapter,
  type CortanaAdapterOptions,
} from '@control-plane/cortana-context-adapter'
import {
  ContextCommandGrantAuthority,
  type ContextCommandGrantRepository,
} from '@control-plane/domain'
import {
  ContextGatewayReadClient,
  type ContextGatewayReadClientOptions,
} from './context-read-client.js'
import { ContextRuntimeNodeReadBinder } from './context-read-binding.js'

export type GatewayContextProviderBinding = Pick<
  CortanaAdapterOptions,
  | 'readModel'
  | 'providerRef'
  | 'mappedProjectRef'
  | 'maximumOutputBytes'
  | 'expectedCorpusRevision'
  | 'expectedMemoryRevision'
  | 'expectedEmbeddingVersion'
  | 'expectedRetrievalVersion'
> & {
  readonly authorizationRef: string
}

export interface GatewayContextProviderCompositionOptions extends Pick<
  ContextGatewayReadClientOptions,
  'delivery' | 'artifacts' | 'coordination' | 'nextSequence'
> {
  readonly grants: Pick<ContextCommandGrantRepository, 'get'>
  readonly traceId: () => string
  /** Trusted, current registry snapshots; never refresh stale health timestamps here. */
  readonly readBindings: (
    scope: { workspaceId: string; principalRef: string },
    signal: AbortSignal
  ) => Promise<readonly GatewayContextProviderBinding[]>
}

/** Implements the existing authoring providerResolver port, including no-provider operation. */
export class GatewayContextProviderResolver {
  constructor(readonly options: GatewayContextProviderCompositionOptions) {}

  async resolve(input: unknown) {
    const request = ContextProviderRequestSchema.parse(input)
    if (request.policy.mode === 'disabled') return new ContextProviderResolver([]).resolve(request)
    const timeout = request.policy.maximumLatencyMs
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000)
      throw new Error('CONTEXT_PROVIDER_DEADLINE_INVALID')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.#resolve(request, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('CONTEXT_PROVIDER_RESOLUTION_TIMEOUT'))
          }, timeout)
        }),
      ])
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  async #resolve(request: ContextProviderRequest, signal: AbortSignal) {
    const bindings = structuredClone(
      await this.options.readBindings(
        { workspaceId: request.workspaceId, principalRef: request.principalRef },
        signal
      )
    )
    signal.throwIfAborted()
    if (!Array.isArray(bindings) || bindings.length > 32)
      throw new Error('CONTEXT_PROVIDER_REGISTRY_INVALID')
    const authority = new ContextCommandGrantAuthority(this.options.grants)
    const client = new ContextGatewayReadClient({
      ...this.options,
      authorize: (record) => authority.authorize(record),
    })
    const identities = new Set<string>()
    const providers = bindings.map((binding) => {
      const connection = binding.readModel.connection
      const identity = `${connection.workspaceId}:${connection.connectionId}`
      if (
        connection.workspaceId !== request.workspaceId ||
        connection.principalRef !== request.principalRef ||
        identities.has(identity)
      )
        throw new Error('CONTEXT_PROVIDER_REGISTRY_SCOPE_MISMATCH')
      identities.add(identity)
      const binder = new ContextRuntimeNodeReadBinder({
        ...this.options,
        workspaceId: request.workspaceId,
        providerRef: binding.providerRef,
        mappedProjectRef: binding.mappedProjectRef,
        authorizationRef: binding.authorizationRef,
      })
      return new CortanaContextProviderAdapter({
        ...binding,
        transport: 'runtime_node',
        maximumRetries: 0,
        client: { read: (value, caller) => client.read(value, AbortSignal.any([caller, signal])) },
        bindRuntimeNodeRead: (value, caller) =>
          binder.bind(value, AbortSignal.any([caller, signal])),
      })
    })
    const result = await new ContextProviderResolver(providers).resolve(request)
    signal.throwIfAborted()
    return result
  }
}
