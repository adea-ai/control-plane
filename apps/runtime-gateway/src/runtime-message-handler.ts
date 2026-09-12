import type { GatewayEnvelope } from '@control-plane/runtime-gateway-protocol'
import type { RuntimeCommandDeliveryService } from './runtime-command-delivery.js'
import type { ContextCommandDeliveryService } from './context-command-delivery.js'
import type { RuntimeEventIngestionService } from './runtime-event-ingestion.js'
import type { RuntimeInventoryMessageHandler } from './runtime-inventory-ingestion.js'
import type { ActiveRuntimeNodeChannelRecord } from './websocket-coordination.js'
import type { RuntimeGatewayMessageHandler } from './websocket-lifecycle.js'

export interface RuntimeGatewayMessageRouterOptions {
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

  constructor(options: RuntimeGatewayMessageRouterOptions) {
    this.#inventory = options.inventory
    this.#delivery = options.delivery
    this.#events = options.events
    this.#context = options.context
  }

  async handle(source: ActiveRuntimeNodeChannelRecord, envelope: GatewayEnvelope): Promise<void> {
    if (envelope.type === 'inventory') {
      await this.#inventory.handle(source, envelope)
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
      if (envelope.type === 'ack') await this.#context.acknowledge(source, envelope)
      else if (envelope.type === 'result') await this.#context.recordResult(source, envelope)
      else if (envelope.type === 'error') await this.#context.recordError(source, envelope)
      else throw new Error('CONTEXT_COMMAND_FRAME_UNSUPPORTED')
      return
    }
    if (envelope.type === 'ack') {
      await this.#delivery.acknowledge(envelope)
      return
    }
    if (envelope.type === 'progress') {
      await this.#events.ingestProgress(envelope, source)
      return
    }
    if (envelope.type === 'result') {
      await this.#events.ingestResult(envelope, source)
      const resultReference =
        'artifact' in envelope.result ? envelope.result.artifact.artifactId : undefined
      await this.#delivery.recordResult(envelope, resultReference)
      return
    }
    if (envelope.type === 'error') {
      await this.#events.ingestError(envelope, source)
      await this.#delivery.recordError(envelope)
      return
    }
    throw new Error('RUNTIME_GATEWAY_FRAME_UNSUPPORTED')
  }
}
