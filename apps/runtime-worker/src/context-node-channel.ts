import {
  GatewayCommandEnvelopeSchema,
  GatewayAcknowledgementEnvelopeSchema,
  GatewayResultEnvelopeSchema,
  type GatewayCommandEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import type { ContextNodeHandler } from './context-node-handler.js'

export interface ContextNodeChannelOptions {
  readonly handler: ContextNodeHandler
  /** Recheck current channel ownership AND scoped permission to disclose this command's frames before each write. */
  readonly assertCurrent: (command: GatewayCommandEnvelope) => Promise<void>
  readonly send: (serialized: string) => Promise<void>
  readonly nextSequence: () => Promise<number>
  readonly now?: () => Date
}

/** Command/result framing for an authenticated node socket; owns neither socket nor handler. */
export class ContextNodeChannel {
  readonly #running = new Map<string, Promise<void>>()
  #calls = 0
  constructor(readonly options: ContextNodeChannelOptions) {}

  async receive(serialized: string): Promise<void> {
    if (this.#calls >= 128) throw new Error('CONTEXT_NODE_CHANNEL_BUSY')
    this.#calls++
    try {
      if (Buffer.byteLength(serialized) > 262144) throw new Error('CONTEXT_NODE_FRAME_TOO_LARGE')
      const command = GatewayCommandEnvelopeSchema.parse(JSON.parse(serialized))
      const key = `${command.workspaceId}:${command.commandId}`
      // A live local call is not evidence of a crashed call. Serialize its redelivery
      // before deciding whether durable executing state requires reconciliation.
      const previous = this.#running.get(key)
      const operation = (async () => {
        await previous?.catch(() => undefined)
        await this.#receive(command)
      })()
      this.#running.set(key, operation)
      try {
        await operation
      } finally {
        if (this.#running.get(key) === operation) this.#running.delete(key)
      }
    } finally {
      this.#calls--
    }
  }

  async #receive(command: GatewayCommandEnvelope): Promise<void> {
    await this.options.assertCurrent(structuredClone(command))
    const admitted = await this.options.handler.accept(command)
    const common = {
      schemaVersion: command.schemaVersion,
      protocolVersion: command.protocolVersion,
      nodeId: command.nodeId,
      workspaceId: command.workspaceId,
      traceId: command.traceId,
      channelGeneration: command.channelGeneration,
      commandId: command.commandId,
      payloadHash: command.payloadHash,
    }
    await this.#send(
      command,
      GatewayAcknowledgementEnvelopeSchema.parse({
        ...common,
        type: 'ack',
        sequence: command.sequence,
        sentAt: this.#now(),
        disposition:
          admitted.status === 'expired'
            ? 'expired'
            : admitted.status === 'accepted'
              ? 'accepted'
              : 'replayed',
      })
    )
    const completed =
      admitted.status === 'accepted'
        ? await this.options.handler.execute(command)
        : admitted.status === 'executing' || admitted.status === 'reconciliation_required'
          ? await this.options.handler.reconcile(command)
          : admitted
    // Unknown provider effects are not a failed result. Keep the gateway ledger pending.
    if (completed.status !== 'succeeded' && completed.status !== 'failed') return
    await this.#send(
      command,
      GatewayResultEnvelopeSchema.parse({
        ...common,
        type: 'result',
        sequence: await this.options.nextSequence(),
        sentAt: this.#now(),
        status: completed.status,
        completedAt: completed.terminalAt,
        result: {
          data:
            completed.status === 'succeeded'
              ? completed.result
              : { errorCode: completed.errorCode },
        },
      })
    )
  }

  async #send(command: GatewayCommandEnvelope, frame: unknown) {
    const serialized = JSON.stringify(frame)
    if (Buffer.byteLength(serialized) > 262144) throw new Error('CONTEXT_NODE_FRAME_TOO_LARGE')
    await this.options.assertCurrent(structuredClone(command))
    await this.options.send(serialized)
  }
  #now() {
    return (this.options.now?.() ?? new Date()).toISOString()
  }
}
