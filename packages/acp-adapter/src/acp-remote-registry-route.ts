import { AcpRemoteDeviceRouteSchema, type AcpRemoteDeviceRoute } from './acp-remote-fence.ts'

/**
 * Derives the secure ACP device route from TRUSTED SERVER-OWNED state only.
 *
 * Route identity (workspace, node, runtime connection, location, status) comes from the server's
 * runtime-connection discovery read — the same registry read the production remote-command factory
 * uses — plus the server's own execution scope; public-key metadata and validity come from
 * server-owned enrollment/configuration. NOTHING here accepts caller-supplied or command-envelope
 * fields: the input surface has no command, payload, or request context by construction, so a
 * routed command can never mint or widen its own route.
 *
 * This is a pure derivation used by controller composition; it performs no I/O, provisions no
 * keys, and enrolls nothing. Key material must already exist in server-owned configuration.
 */

/** Public-key metadata held by server-owned configuration/enrollment (never command fields). */
export interface ServerOwnedSecureAcpRouteConfiguration {
  readonly deviceKeyId: string
  readonly deviceSigningPublicKey: string
  readonly deviceEncryptionKeyId: string
  readonly deviceEncryptionPublicKey: string
  readonly controllerKeyId: string
  readonly controllerSigningPublicKey: string
  readonly validUntil: string
  /** Required when the registry connection is revoked: the server-observed revocation time. */
  readonly revokedAt?: string
}

/**
 * Structural subset of the server-owned runtime-connection discovery read model
 * (contracts `RuntimeConnectionDiscoveryReadModelSchema`): acp-adapter does not depend on
 * contracts, and a real read model satisfies this shape structurally.
 */
export interface ServerOwnedRuntimeConnectionView {
  readonly runtimeConnectionId: string
  readonly family: string
  readonly location: 'local_device' | 'agent_hq_cloud'
  readonly status: 'available' | 'degraded' | 'unavailable' | 'revoked'
  readonly node?: {
    readonly runtimeNodeRefId: string
    readonly location: 'local_device' | 'remote_host' | 'agent_hq_cloud'
    readonly status: 'online' | 'offline' | 'revoked'
    readonly health: 'online' | 'offline' | 'unknown' | 'revoked'
  }
  readonly connection: {
    readonly status:
      | 'connected'
      | 'degraded'
      | 'unavailable'
      | 'disconnected'
      | 'expired'
      | 'revoked'
    readonly availability: string
  }
}

export interface DeriveSecureAcpRemoteRouteInput {
  /** Server-side execution/workspace scope; never read from a command envelope. */
  readonly workspaceId: string
  readonly connection: ServerOwnedRuntimeConnectionView
  readonly configuration: ServerOwnedSecureAcpRouteConfiguration
}

/** Families eligible for the sealed ACP route; anything else fails closed. */
const ROUTE_FAMILIES = new Set(['acp'])

/**
 * Positively-usable requirements, evaluated in order after revocation: only a CURRENT online node
 * on a connected, healthy, available connection derives an `active` route. Everything else is a
 * TYPED denial — an unusable state is never relabeled `revoked` (the schema admits only
 * `active | revoked`), and a route that is never derived means zero transport dispatch.
 */
const USABILITY_REQUIREMENTS: readonly {
  readonly code: string
  readonly check: (connection: ServerOwnedRuntimeConnectionView) => boolean
}[] = [
  { code: 'ACP_REMOTE_ROUTE_NODE_OFFLINE', check: (c) => c.node?.status === 'offline' },
  { code: 'ACP_REMOTE_ROUTE_NODE_OFFLINE', check: (c) => c.node?.health === 'offline' },
  {
    code: 'ACP_REMOTE_ROUTE_NODE_UNAVAILABLE',
    check: (c) => c.node?.health === 'unknown',
  },
  {
    code: 'ACP_REMOTE_ROUTE_CONNECTION_DISCONNECTED',
    check: (c) => c.connection.status === 'disconnected',
  },
  {
    code: 'ACP_REMOTE_ROUTE_CONNECTION_EXPIRED',
    check: (c) => c.connection.status === 'expired',
  },
  {
    code: 'ACP_REMOTE_ROUTE_CONNECTION_UNAVAILABLE',
    check: (c) =>
      c.status !== 'available' ||
      c.connection.status !== 'connected' ||
      c.connection.availability !== 'healthy' ||
      c.node?.status !== 'online' ||
      c.node.health !== 'online',
  },
]

export function deriveSecureAcpRemoteRoute(
  input: DeriveSecureAcpRemoteRouteInput
): AcpRemoteDeviceRoute {
  const { workspaceId, connection, configuration } = input
  if (!ROUTE_FAMILIES.has(connection.family)) throw new Error('ACP_REMOTE_ROUTE_FAMILY_MISMATCH')
  if (connection.node === undefined) throw new Error('ACP_REMOTE_ROUTE_NODE_MISSING')
  if (connection.node.location !== 'local_device' && connection.node.location !== 'remote_host') {
    throw new Error('ACP_REMOTE_ROUTE_LOCATION_UNSUPPORTED')
  }
  const revoked =
    connection.status === 'revoked' ||
    connection.connection.status === 'revoked' ||
    connection.connection.availability === 'revoked' ||
    connection.node.status === 'revoked' ||
    connection.node.health === 'revoked'
  if (revoked && configuration.revokedAt === undefined) {
    // A revoked connection must carry the server-observed revocation time; never invent one.
    throw new Error('ACP_REMOTE_ROUTE_REVOKED_AT_MISSING')
  }
  if (!revoked) {
    for (const requirement of USABILITY_REQUIREMENTS) {
      if (requirement.check(connection)) throw new Error(requirement.code)
    }
  }
  return AcpRemoteDeviceRouteSchema.parse({
    workspaceId,
    nodeId: connection.node.runtimeNodeRefId,
    runtimeConnectionId: connection.runtimeConnectionId,
    location: connection.node.location,
    deviceKeyId: configuration.deviceKeyId,
    deviceSigningPublicKey: configuration.deviceSigningPublicKey,
    deviceEncryptionKeyId: configuration.deviceEncryptionKeyId,
    deviceEncryptionPublicKey: configuration.deviceEncryptionPublicKey,
    controllerKeyId: configuration.controllerKeyId,
    controllerSigningPublicKey: configuration.controllerSigningPublicKey,
    status: revoked ? 'revoked' : 'active',
    ...(revoked ? { revokedAt: configuration.revokedAt } : {}),
    validUntil: configuration.validUntil,
  })
}
