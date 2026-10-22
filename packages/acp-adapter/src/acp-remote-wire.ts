import {
  GatewayCommandEnvelopeSchema,
  GatewayProtocolManifest,
  type AcpRemoteSealedCarrierChannel,
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
  readonly commandTtlMs?: number
}

const DEFAULT_COMMAND_TTL_MS = 60_000
const DEFAULT_REQUIRED_CAPABILITIES = ['stream.output'] as const

/** Identity of one carrier command: the inner ACP command it carries. */
const carrierIdentity = (innerCommandId: string): string => `acp-remote-sealed:${innerCommandId}`

export function createGatewayOwnedAcpRemoteWire(
  options: GatewayOwnedAcpRemoteWireOptions
): AcpRemoteWire {
  const route = AcpRemoteDeviceRouteSchema.parse(options.route)
  const now = options.now ?? (() => new Date())
  const ttlMs = options.commandTtlMs ?? DEFAULT_COMMAND_TTL_MS
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > ACP_REMOTE_MAX_COMMAND_LIFETIME_MS) {
    throw new Error('ACP_REMOTE_COMMAND_TTL_INVALID')
  }
  const requiredCapabilities = [
    ...new Set(options.requiredCapabilities ?? DEFAULT_REQUIRED_CAPABILITIES),
  ].toSorted()
  if (requiredCapabilities.length === 0) {
    throw new Error('ACP_REMOTE_REQUIRED_CAPABILITIES_INVALID')
  }
  let sequence = 1

  const currentGeneration = (): number | undefined => {
    const generation = options.channel.currentChannelGeneration()
    if (generation === undefined) return undefined
    if (!Number.isSafeInteger(generation) || generation < 1) return undefined
    return generation
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
      const identity = carrierIdentity(header.commandId)
      const issuedAt = now()
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
        expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
        family: 'runtime',
        operation: ACP_REMOTE_SEALED_OPERATION,
        driver: { family: 'acp', version: '1.0.0' },
        runtimeConnectionId: route.runtimeConnectionId,
        executionId: options.executionId,
        attemptId: options.attemptId(identity),
        requiredCapabilities,
        payload,
      })
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
