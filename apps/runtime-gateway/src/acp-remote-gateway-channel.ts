import type { RuntimeCommandRecord } from '@control-plane/domain'
import type {
  AcpRemoteSealedCarrierChannel,
  GatewayCommandEnvelope,
  GatewayProtocolVersion,
} from '@control-plane/runtime-gateway-protocol'

/**
 * Gateway-owned channel for the secure ACP remote route.
 *
 * This adapter is the runtime-gateway side of the production wire. It carries ONE opaque sealed
 * ACP command through the gateway's ordinary durable command path — the same ledger, the same
 * authorization, the same channel-generation and sequence fences every other runtime command
 * uses — and brings back the device's sealed reply.
 *
 * The reply travels as the carrier command's SINGLE per-command result artifact
 * (`runtime-results/<attemptId>/result.json`). The gateway's existing
 * `RuntimeCommandArtifactVerifier` verifies it against the attempt with no protocol change, and
 * the one-artifact-per-attempt invariant keeps holding: one carrier command owns one attempt, so
 * one attempt owns one reply artifact.
 *
 * Nothing here opens a socket, reads a credential, or chooses a location. The channel reports the
 * generation the authenticated node connection currently holds, and the wire refuses to send
 * without one.
 */

/** Error message the channel throws when the node channel is gone. */
export const ACP_REMOTE_GATEWAY_CHANNEL_OFFLINE = 'ACP_REMOTE_GATEWAY_CHANNEL_OFFLINE'

/** Narrow view of the gateway's durable command delivery service. */
export interface AcpRemoteGatewayDeliveryPort {
  enqueue(command: unknown): Promise<{
    readonly record: RuntimeCommandRecord
    readonly replayed: boolean
  }>
  deliver(
    commandId: string,
    transport: {
      readonly channelGeneration: number
      readonly sequence: number
      readonly protocolVersion?: GatewayProtocolVersion
    }
  ): Promise<{
    readonly record: RuntimeCommandRecord
    readonly sent: boolean
    readonly terminalResultReference?: string
  }>
  get(commandId: string): Promise<RuntimeCommandRecord | undefined>
}

/** The node channel facts the adapter needs. */
export interface AcpRemoteGatewayNodePort {
  /** The CURRENT authenticated node/connection channel generation, or undefined when offline. */
  currentChannelGeneration(): number | undefined
  /** The next channel sequence number for this node connection. */
  nextSequence(): Promise<number>
  /** The negotiated protocol version for this node connection. */
  protocolVersion(): GatewayProtocolVersion
}

/** Narrow artifact reader: the reply artifact under its attempt-scoped key. */
export interface AcpRemoteGatewayArtifactReader {
  get(key: string): Promise<{ readonly body: Uint8Array }>
}

export interface AcpRemoteGatewayChannelOptions {
  readonly delivery: AcpRemoteGatewayDeliveryPort
  readonly node: AcpRemoteGatewayNodePort
  readonly artifacts: AcpRemoteGatewayArtifactReader
  /** The inventory the gateway pushed on the authenticated channel, with its push generation. */
  readonly pushedInventory: () => Promise<{
    readonly inventory: unknown
    readonly channelGeneration: number
  }>
  readonly now?: () => Date
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly pollIntervalMs?: number
  readonly replyTimeoutMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 50
const DEFAULT_REPLY_TIMEOUT_MS = 30_000

/** Attempt-scoped reply artifact key. Matches the gateway's result-artifact verifier exactly. */
export function acpRemoteReplyArtifactKey(attemptId: string): string {
  return `runtime-results/${attemptId}/result.json`
}

export function createAcpRemoteGatewayChannel(
  options: AcpRemoteGatewayChannelOptions
): AcpRemoteSealedCarrierChannel {
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? defaultSleep
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10_000) {
    throw new Error('ACP_REMOTE_GATEWAY_POLL_INTERVAL_INVALID')
  }
  if (!Number.isSafeInteger(replyTimeoutMs) || replyTimeoutMs < 1 || replyTimeoutMs > 600_000) {
    throw new Error('ACP_REMOTE_GATEWAY_REPLY_TIMEOUT_INVALID')
  }

  const generation = (): number | undefined => {
    const value = options.node.currentChannelGeneration()
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value) || value < 1) return undefined
    return value
  }

  return {
    currentChannelGeneration: generation,

    pushedInventory: () => options.pushedInventory(),

    async dispatchSealed(input: {
      readonly command: GatewayCommandEnvelope
      readonly signal?: AbortSignal
    }): Promise<unknown> {
      const channelGeneration = generation()
      if (channelGeneration === undefined) throw new Error(ACP_REMOTE_GATEWAY_CHANNEL_OFFLINE)
      const { record } = await options.delivery.enqueue(input.command)
      if (record.attemptId === undefined) throw new Error('ACP_REMOTE_GATEWAY_ATTEMPT_MISSING')
      const delivered = await options.delivery.deliver(record.commandId, {
        channelGeneration,
        sequence: await options.node.nextSequence(),
        protocolVersion: options.node.protocolVersion(),
      })
      // A command that is already terminal (a retry of a delivered command) never needs a new
      // send; the reply artifact is read below.
      void delivered
      const deadline = now().getTime() + replyTimeoutMs
      for (;;) {
        const current = await options.delivery.get(record.commandId)
        if (current === undefined) throw new Error('ACP_REMOTE_GATEWAY_COMMAND_MISSING')
        if (current.status === 'succeeded') break
        if (current.status === 'failed') throw new Error('ACP_REMOTE_GATEWAY_COMMAND_FAILED')
        if (current.status === 'cancelled') throw new Error('ACP_REMOTE_GATEWAY_COMMAND_CANCELLED')
        if (current.status === 'expired') throw new Error('ACP_REMOTE_GATEWAY_COMMAND_EXPIRED')
        if (now().getTime() >= deadline) throw new Error('ACP_REMOTE_GATEWAY_REPLY_TIMEOUT')
        if (input.signal?.aborted === true) throw new Error('ACP_REMOTE_GATEWAY_ABORTED')
        await sleep(pollIntervalMs)
      }
      const stored = await options.artifacts.get(acpRemoteReplyArtifactKey(record.attemptId))
      return JSON.parse(new TextDecoder().decode(stored.body)) as unknown
    },
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
