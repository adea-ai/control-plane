import type { GatewayEnvelope } from '@control-plane/runtime-gateway-protocol'
import type { RuntimeCommandDeliveryService } from './runtime-command-delivery.js'
import type { ContextCommandDeliveryService } from './context-command-delivery.js'
import type {
  RuntimeEventIngestionService,
  RuntimeNodeChannelAuthority,
} from './runtime-event-ingestion.js'
import type { RuntimeInventoryMessageHandler } from './runtime-inventory-ingestion.js'
import type { ActiveRuntimeNodeChannelRecord } from './websocket-coordination.js'
import type { RuntimeGatewayMessageHandler } from './websocket-lifecycle.js'
import type { RuntimeNodeCredentialFence } from './authentication.js'

export interface RuntimeGatewayMessageRouterOptions {
  readonly channelAuthority: RuntimeNodeChannelAuthority
  readonly context?: Pick<
    ContextCommandDeliveryService,
    'get' | 'acknowledge' | 'recordResult' | 'recordError'
  >
  readonly inventory: Pick<RuntimeInventoryMessageHandler, 'handle'>
  readonly delivery: Pick<
    RuntimeCommandDeliveryService,
    'acknowledge' | 'recordResult' | 'recordError'
  >
  readonly events: Pick<
    RuntimeEventIngestionService,
    'ingestProgress' | 'ingestResult' | 'ingestError'
  >
}

export class RuntimeGatewayMessageRouter implements RuntimeGatewayMessageHandler {
  readonly #delivery: RuntimeGatewayMessageRouterOptions['delivery']
  readonly #events: RuntimeGatewayMessageRouterOptions['events']
  readonly #inventory: RuntimeGatewayMessageRouterOptions['inventory']
  readonly #context: RuntimeGatewayMessageRouterOptions['context']
  readonly #channelAuthority: RuntimeGatewayMessageRouterOptions['channelAuthority']

  constructor(options: RuntimeGatewayMessageRouterOptions) {
    this.#channelAuthority = options.channelAuthority
    this.#inventory = options.inventory
    this.#delivery = options.delivery
    this.#events = options.events
    this.#context = options.context
  }

  async handle(
    source: ActiveRuntimeNodeChannelRecord,
    envelope: GatewayEnvelope,
    credentialFence?: RuntimeNodeCredentialFence
  ): Promise<void> {
    // Every inbound frame family must recheck durable channel authority. In
    // particular, ACKs and runtime events must not rely only on the in-memory
    // channel state when a credential has been revoked on another gateway.
    if (!(await this.#channelAuthority.isActive(source))) {
      throw new Error('RUNTIME_GATEWAY_CHANNEL_AUTHORIZATION_DENIED')
    }
    if (envelope.type === 'inventory') {
      await this.#inventory.handle(source, envelope, this.#channelAuthority, credentialFence)
      return
    }
    // Frame type alone does not identify the command family. Classify against the
    // trusted workspace's durable context ledger, never a caller-supplied family.
    if (
      'commandId' in envelope &&
      envelope.commandId &&
      this.#context &&
      (await this.#context.get(source.workspaceId, envelope.commandId))
    ) {
      if (envelope.type === 'ack')
        await this.#context.acknowledge(source, envelope, credentialFence)
      else if (envelope.type === 'result')
        await this.#context.recordResult(source, envelope, credentialFence)
      else if (envelope.type === 'error')
        await this.#context.recordError(source, envelope, credentialFence)
      else throw new Error('CONTEXT_COMMAND_FRAME_UNSUPPORTED')
      return
    }
    if (envelope.type === 'ack') {
      await this.#delivery.acknowledge(envelope, credentialFence)
      return
    }
    if (envelope.type === 'progress') {
      await this.#events.ingestProgress(envelope, source, credentialFence)
      return
    }
    if (envelope.type === 'result') {
      const effect = await this.#events.ingestResult(envelope, source, credentialFence)
      if (effect.outcome !== 'applied' && effect.outcome !== 'duplicate') return
      const resultReference =
        'artifact' in envelope.result ? envelope.result.artifact.artifactId : undefined
      await this.#delivery.recordResult(envelope, resultReference, credentialFence)
      return
    }
    if (envelope.type === 'error') {
      const effect = await this.#events.ingestError(envelope, source, credentialFence)
      if (effect.outcome !== 'applied' && effect.outcome !== 'duplicate') return
      await this.#delivery.recordError(envelope, credentialFence)
      return
    }
    throw new Error('RUNTIME_GATEWAY_FRAME_UNSUPPORTED')
  }
}
