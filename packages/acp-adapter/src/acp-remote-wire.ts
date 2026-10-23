import {
  GatewayCommandEnvelopeSchema,
  GatewayProtocolManifest,
  type AcpRemoteSealedCarrierChannel,
  type GatewayCommandEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import { digest, gatewayIdempotencyKey } from './acp-gateway-protocol.ts'
import {
  ACP_REMOTE_CLOCK_SKEW_MS,
  ACP_REMOTE_MAX_COMMAND_LIFETIME_MS,
  AcpRemoteDeviceRouteSchema,
  evaluateCommandWindow,
  type AcpRemoteDeviceRoute,
} from './acp-remote-fence.ts'
import { buildSealedCarrierPayload, readSealedHeaderProjection } from './acp-remote-sealed-frame.ts'
import {
  AcpRemoteUndeliveredError,
  type AcpRemoteSealedCommand,
  type AcpRemoteWire,
} from './acp-remote-transport.ts'

/**
 * Production controller wire for the secure ACP remote route.
 *
 * This is the transport seam that `SecureAcpRemoteTransport` drives and that the repository
 * previously only had a disposable test double for. The wire carries ONE opaque sealed command
 * across the runtime gateway and brings back the device's opaque sealed reply:
 *
 * - The sealed command is HPKE-sealed to the device recipient key and signed by the controller key
 *   BEFORE the wire sees it, so the gateway relays ciphertext it cannot read.
 * - The carrier command is a `runtime.acp-remote-sealed` gateway command whose payload carries the
 *   sealed blob under one opaque key. The gateway learns the route, the command identity and the
 *   timing, and nothing about the prompt.
 * - The device answers with the sealed reply, which travels back as that command's single
 *   per-command result artifact. The gateway verifies the artifact against the attempt exactly as
 *   it does for any other runtime result.
 *
 * The wire never reroutes. An unreachable or revoked device is a typed denial that reaches the
 * caller as `device_offline`; it is never converted into "run this somewhere else".
 */

/** Gateway operation that carries one sealed ACP command. */
export const ACP_REMOTE_SEALED_OPERATION = 'runtime.acp-remote-sealed' as const

/**
 * The gateway channel the wire rides on. It is the ONLY seam to the gateway: the wire never opens
 * a socket, never reads a credential, and never selects a location.
 *
 * The contract is declared in the runtime-gateway protocol package, which both this package and
 * the runtime gateway depend on, so the controller side and the gateway side are checked against
 * ONE declaration.
 */
export type AcpRemoteGatewayChannel = AcpRemoteSealedCarrierChannel

export interface GatewayOwnedAcpRemoteWireOptions {
  readonly channel: AcpRemoteGatewayChannel
  readonly route: AcpRemoteDeviceRoute
  /** Allocates the carrier command identity. Stable for one inner command so a retry reuses it. */
  readonly commandId: (identity: string) => string
  /** Allocates the carrier attempt identity. One attempt per carrier command: the attempt's single
   * result-artifact slot IS the per-command reply artifact. */
  readonly attemptId: (identity: string) => string
  readonly executionId: string
  readonly traceId: string
  readonly requiredCapabilities?: readonly string[]
  readonly now?: () => Date
}

/** The most carriers kept for reuse, bounding a burst of live commands. */
const CARRIER_CACHE_CAPACITY = 1024
const DEFAULT_REQUIRED_CAPABILITIES = ['stream.output'] as const

/**
 * The DURABLE carrier identity: the identity the gateway records one carrier command under.
 *
 * The gateway's durable command repository identifies a command by its FULL envelope, so the
 * durable identity has to name the exact sealed command the carrier carries. A carrier that
 * carried one sealed command and then carried another -- because the command was re-sealed --
 * is a DIFFERENT durable command, and giving it the same durable identity would make the
 * repository refuse the second as a changed envelope of the first.
 *
 * This is deliberately NOT the device's semantic identity. The device deduplicates the EFFECT on
 * the inner command's semantic identity, so a repeated semantic request still runs one effect and
 * replays the recorded outcome, while each sealed command is its own durable carrier command.
 */
const carrierIdentity = (innerCommandId: string, sealedDigest: string): string =>
  `acp-remote-sealed:${innerCommandId}:${sealedDigest}`

export function createGatewayOwnedAcpRemoteWire(
  options: GatewayOwnedAcpRemoteWireOptions
): AcpRemoteWire {
  const route = AcpRemoteDeviceRouteSchema.parse(options.route)
  const now = options.now ?? (() => new Date())
  const requiredCapabilities = [
    ...new Set(options.requiredCapabilities ?? DEFAULT_REQUIRED_CAPABILITIES),
  ].toSorted()
  if (requiredCapabilities.length === 0) {
    throw new Error('ACP_REMOTE_REQUIRED_CAPABILITIES_INVALID')
  }
  let sequence = 1
  // The carrier command is stable for one inner command. The gateway's durable command
  // repository identifies a command by its FULL envelope, so a retry that rebuilt the
  // carrier -- a new sequence, new timestamps, a newly sealed payload -- would be refused
  // as a different command instead of being recognized as the same one.
  //
  // The DELIVERY stays per delivery: the gateway assigns the transport sequence, counts the
  // delivery attempts and owns the single reply artifact.
  const carriers = new Map<string, GatewayCommandEnvelope>()

  const currentGeneration = (): number | undefined => {
    const generation = options.channel.currentChannelGeneration()
    if (generation === undefined) return undefined
    if (!Number.isSafeInteger(generation) || generation < 1) return undefined
    return generation
  }

  /**
   * The carrier command for one inner command, built once and reused by every delivery
   * attempt of that command.
   *
   * The carrier IS the gateway's command identity: the repository compares the whole
   * envelope, so the sequence, the timestamps and the sealed payload have to be the same on
   * a retry. The sealed payload is stable because the controller seals the inner command
   * once, so this cache never has to choose between two different sealed frames.
   */
  const carrierFor = (
    identity: string,
    payload: unknown,
    generation: number,
    innerExpiresAt: string
  ): GatewayCommandEnvelope => {
    // The cache key is the carrier PAYLOAD, so one carrier command is one envelope: a retry
    // reuses the carrier it already built, and a different payload under the same command id
    // is a different command rather than a silently reused carrier.
    const key = digest(payload)
    const existing = carriers.get(key)
    if (existing !== undefined) return existing
    const issuedAt = now()
    const issuedAtMs = issuedAt.getTime()
    const innerExpiresAtMs = Date.parse(innerExpiresAt)
    if (!Number.isFinite(innerExpiresAtMs) || innerExpiresAtMs <= issuedAtMs) {
      throw new AcpRemoteUndeliveredError()
    }
    // Expired carriers may be discarded, but a live carrier is the durable gateway identity
    // for its sealed command and cannot be evicted and rebuilt with a changed envelope.
    for (const [cached, entry] of carriers) {
      if (Date.parse(entry.expiresAt) <= issuedAtMs) carriers.delete(cached)
    }
    if (carriers.size >= CARRIER_CACHE_CAPACITY) {
      // Keep the cache bounded without changing the durable identity of any live retry.
      throw new AcpRemoteUndeliveredError('state_unavailable')
    }
    const carrier = GatewayCommandEnvelopeSchema.parse({
      type: 'command',
      schemaVersion: 1,
      protocolVersion: GatewayProtocolManifest.current,
      sequence: sequence++,
      nodeId: route.nodeId,
      workspaceId: route.workspaceId,
      traceId: options.traceId,
      sentAt: issuedAt.toISOString(),
      channelGeneration: generation,
      commandId: options.commandId(identity),
      idempotencyKey: gatewayIdempotencyKey(identity),
      payloadHash: digest(payload),
      issuedAt: issuedAt.toISOString(),
      // The carrier must remain valid for exactly the authenticated command's supported window.
      // A shorter outer TTL can evict it while the sealed command is still retryable; a longer
      // one would outlive the inner authorization window.
      expiresAt: innerExpiresAt,
      family: 'runtime',
      operation: ACP_REMOTE_SEALED_OPERATION,
      driver: { family: 'acp', version: '1.0.0' },
      runtimeConnectionId: route.runtimeConnectionId,
      executionId: options.executionId,
      attemptId: options.attemptId(identity),
      requiredCapabilities,
      payload,
    })
    carriers.set(key, carrier)
    return carrier
  }

  return {
    inventoryMode: 'channel-authenticated',

    /**
     * The channel's current generation, or `0` when the device is not reachable. `0` is never a
     * valid channel generation (generations are positive), so the controller treats it as a stale
     * channel rather than as a generation to publish against.
     */
    currentChannelGeneration: () => currentGeneration() ?? 0,

    connectionState(): 'online' | 'offline' {
      return currentGeneration() === undefined ? 'offline' : 'online'
    },

    async requestInventory(): Promise<unknown> {
      // The pushed inventory is bound to the generation it was pushed at; the controller compares
      // it with the channel's current generation and denies a stale push.
      if (currentGeneration() === undefined) throw new AcpRemoteUndeliveredError()
      return await options.channel.pushedInventory()
    },

    async sendCommand(command: AcpRemoteSealedCommand, signal?: AbortSignal): Promise<unknown> {
      const header = readSealedHeaderProjection(command)
      // The wire only carries a command for the route it was built for. A sealed command for
      // another workspace, node or connection is refused here, before anything reaches the gateway.
      if (
        header.workspaceId !== route.workspaceId ||
        header.nodeId !== route.nodeId ||
        header.runtimeConnectionId !== route.runtimeConnectionId
      ) {
        throw new AcpRemoteUndeliveredError()
      }
      const generation = currentGeneration()
      if (generation === undefined) throw new AcpRemoteUndeliveredError()
      // A command sealed for an older channel generation cannot be delivered on this channel:
      // the device would fence it as a stale channel. Refuse instead of sending it.
      if (header.channelGeneration !== generation) throw new AcpRemoteUndeliveredError()
      const window = evaluateCommandWindow({
        issuedAt: header.issuedAt,
        expiresAt: header.expiresAt,
        now: now(),
        clockSkewMs: ACP_REMOTE_CLOCK_SKEW_MS,
        maxLifetimeMs: ACP_REMOTE_MAX_COMMAND_LIFETIME_MS,
      })
      if (window.outcome === 'denied') throw new AcpRemoteUndeliveredError()
      if (signal?.aborted === true) throw new AcpRemoteUndeliveredError()

      const payload = buildSealedCarrierPayload(command)
      // The durable carrier identity names the SEALED command, so a re-sealed command is its own
      // durable carrier command. The device still deduplicates the effect on the inner command's
      // semantic identity, so repeated semantic requests run one effect.
      const identity = carrierIdentity(header.commandId, digest(payload))
      // The carrier is stable for one SEALED command: a retry that re-dispatches the same seal
      // reuses the carrier it already built, so the gateway's durable command repository -- which
      // identifies a command by its FULL envelope -- recognizes the retry as the same command
      // instead of refusing a changed envelope.
      //
      // The DELIVERY stays per delivery: the gateway assigns the transport sequence and
      // counts the attempts, and the carrier attempt owns the single reply artifact.
      const carrier = carrierFor(identity, payload, generation, header.expiresAt)
      // The dispatch may have executed before it failed, and a channel that is gone
      // afterwards does not prove the command was never delivered. The original
      // error is preserved, so the caller reads an unknown outcome and retries the
      // SAME command identity instead of treating the command as never delivered.
      return await options.channel.dispatchSealed({
        command: carrier,
        ...(signal ? { signal } : {}),
      })
    },
  }
}
