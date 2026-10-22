import type { GatewayCommandEnvelope } from './protocol.js'

/**
 * The gateway channel that carries ONE opaque sealed ACP command.
 *
 * A sealed ACP command is HPKE ciphertext bound to the device recipient key. The gateway relays
 * it without being able to read it: it sees the route, the command identity and the timing, and
 * never the prompt. The channel therefore hands the carrier command to the gateway's ordinary
 * durable command path and resolves with the device's opaque sealed reply.
 *
 * Both sides of the seam depend on this package, so the contract is declared once and checked by
 * the compiler on both ends: the controller wire consumes it, and the gateway channel adapter
 * declares that it returns exactly this shape.
 */
export interface AcpRemoteSealedCarrierChannel {
  /**
   * The channel's CURRENT authenticated node/connection channel generation, or `undefined` when the
   * device is not reachable on an authenticated channel. A wire refuses to send without one.
   */
  readonly currentChannelGeneration: () => number | undefined
  /** Delivers one carrier command and resolves with the device's opaque sealed reply. */
  readonly dispatchSealed: (input: {
    readonly command: GatewayCommandEnvelope
    readonly signal?: AbortSignal
  }) => Promise<unknown>
  /**
   * The inventory the gateway pushed on the authenticated channel, together with the channel
   * generation it was pushed at. The controller compares that generation with the current one, so
   * a stale push is denied instead of published.
   */
  readonly pushedInventory: () => Promise<{
    readonly inventory: unknown
    readonly channelGeneration: number
  }>
}
