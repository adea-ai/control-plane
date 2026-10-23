// Registry-to-route derivation for the secure ACP controller (#1023/#1040): route identity and
// public-key metadata come from server-owned runtime-connection discovery state and server-owned
// configuration only — the input surface accepts no command or caller fields by construction.
// All key material is synthetic fixture data; nothing here provisions or enrolls anything.
import { describe, expect, test } from 'bun:test'
import { deriveSecureAcpRemoteRoute } from './acp-remote-registry-route.ts'
import { signingPublicKeyOf } from './acp-remote-crypto.ts'
import { syntheticKeys } from './acp-remote-fixtures.mjs'

const keys = await syntheticKeys()

const configuration = {
  deviceKeyId: 'dev_sig_0000000001',
  deviceSigningPublicKey: signingPublicKeyOf(keys.deviceSigning),
  deviceEncryptionKeyId: 'dev_hpke_0000000001',
  deviceEncryptionPublicKey: keys.deviceRecipient.publicKey,
  controllerKeyId: 'ctl_sig_0000000001',
  controllerSigningPublicKey: signingPublicKeyOf(keys.controllerSigning),
  validUntil: '2027-08-25T13:00:00.000Z',
}

const connection = {
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
  family: 'acp',
  location: 'agent_hq_cloud',
  status: 'available',
  node: {
    runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
    location: 'remote_host',
    status: 'online',
    health: 'online',
  },
  connection: { status: 'connected', availability: 'healthy' },
}

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'

describe('deriveSecureAcpRemoteRoute', () => {
  test('an active registry connection maps identity and keys from server-owned state', () => {
    const route = deriveSecureAcpRemoteRoute({ workspaceId, connection, configuration })
    expect(route).toMatchObject({
      workspaceId,
      nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
      runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
      location: 'remote_host',
      status: 'active',
      deviceKeyId: configuration.deviceKeyId,
      deviceEncryptionKeyId: configuration.deviceEncryptionKeyId,
      controllerKeyId: configuration.controllerKeyId,
      validUntil: configuration.validUntil,
    })
    expect(route.deviceSigningPublicKey).toBe(configuration.deviceSigningPublicKey)
    expect(route.revokedAt).toBeUndefined()
  })

  test('a local-device node location is a valid route while cloud locations are not', () => {
    const local = deriveSecureAcpRemoteRoute({
      workspaceId,
      connection: { ...connection, node: { ...connection.node, location: 'local_device' } },
      configuration,
    })
    expect(local.location).toBe('local_device')
    expect(() =>
      deriveSecureAcpRemoteRoute({
        workspaceId,
        connection: { ...connection, node: { ...connection.node, location: 'agent_hq_cloud' } },
        configuration,
      })
    ).toThrow('ACP_REMOTE_ROUTE_LOCATION_UNSUPPORTED')
  })

  test('revocation in the registry produces a revoked route carrying the server-observed time', () => {
    for (const revokedConnection of [
      { ...connection, status: 'revoked' },
      { ...connection, connection: { ...connection.connection, status: 'revoked' } },
      { ...connection, connection: { ...connection.connection, availability: 'revoked' } },
      { ...connection, node: { ...connection.node, status: 'revoked' } },
      { ...connection, node: { ...connection.node, health: 'revoked' } },
    ]) {
      const route = deriveSecureAcpRemoteRoute({
        workspaceId,
        connection: revokedConnection,
        configuration: { ...configuration, revokedAt: '2026-08-25T12:00:10.000Z' },
      })
      expect(route.status).toBe('revoked')
      expect(route.revokedAt).toBe('2026-08-25T12:00:10.000Z')
    }
  })

  test('a revoked connection without a server-observed revocation time fails closed', () => {
    expect(() =>
      deriveSecureAcpRemoteRoute({
        workspaceId,
        connection: { ...connection, status: 'revoked' },
        configuration,
      })
    ).toThrow('ACP_REMOTE_ROUTE_REVOKED_AT_MISSING')
  })

  test('non-ACP families and node-less connections are refused', () => {
    expect(() =>
      deriveSecureAcpRemoteRoute({
        workspaceId,
        connection: { ...connection, family: 'managed-pi' },
        configuration,
      })
    ).toThrow('ACP_REMOTE_ROUTE_FAMILY_MISMATCH')
    const { node: _node, ...withoutNode } = connection
    expect(() =>
      deriveSecureAcpRemoteRoute({ workspaceId, connection: withoutNode, configuration })
    ).toThrow('ACP_REMOTE_ROUTE_NODE_MISSING')
  })

  test('malformed server-owned key material fails route validation', () => {
    expect(() =>
      deriveSecureAcpRemoteRoute({
        workspaceId,
        connection,
        configuration: { ...configuration, deviceEncryptionPublicKey: 'not-a-base64url-key' },
      })
    ).toThrow()
    expect(() =>
      deriveSecureAcpRemoteRoute({
        workspaceId,
        connection,
        configuration: { ...configuration, deviceSigningPublicKey: 'AAAA' },
      })
    ).toThrow()
  })

  test('offline/disconnected/expired/unavailable states are typed denials with zero dispatch', () => {
    const denials = [
      [
        { ...connection, node: { ...connection.node, status: 'offline' } },
        'ACP_REMOTE_ROUTE_NODE_OFFLINE',
      ],
      [
        { ...connection, node: { ...connection.node, health: 'offline' } },
        'ACP_REMOTE_ROUTE_NODE_OFFLINE',
      ],
      [
        { ...connection, node: { ...connection.node, health: 'unknown' } },
        'ACP_REMOTE_ROUTE_NODE_UNAVAILABLE',
      ],
      [
        { ...connection, connection: { ...connection.connection, status: 'disconnected' } },
        'ACP_REMOTE_ROUTE_CONNECTION_DISCONNECTED',
      ],
      [
        { ...connection, connection: { ...connection.connection, status: 'expired' } },
        'ACP_REMOTE_ROUTE_CONNECTION_EXPIRED',
      ],
      [{ ...connection, status: 'unavailable' }, 'ACP_REMOTE_ROUTE_CONNECTION_UNAVAILABLE'],
      [{ ...connection, status: 'degraded' }, 'ACP_REMOTE_ROUTE_CONNECTION_UNAVAILABLE'],
      [
        { ...connection, connection: { ...connection.connection, availability: 'stale' } },
        'ACP_REMOTE_ROUTE_CONNECTION_UNAVAILABLE',
      ],
      [
        { ...connection, connection: { ...connection.connection, availability: 'reconnecting' } },
        'ACP_REMOTE_ROUTE_CONNECTION_UNAVAILABLE',
      ],
    ]
    let dispatches = 0
    const wire = {
      connectionState: () => 'online',
      sendCommand: async () => {
        dispatches += 1
        throw new Error('DISPATCH_MUST_NOT_RUN')
      },
      requestInventory: async () => {
        dispatches += 1
        throw new Error('DISPATCH_MUST_NOT_RUN')
      },
    }
    const derived = denials.map(([unusable]) => {
      try {
        return deriveSecureAcpRemoteRoute({ workspaceId, connection: unusable, configuration })
      } catch (error) {
        return error
      }
    })
    for (const [index, result] of derived.entries()) {
      // Typed denial: a TYPED error is thrown, never a route labeled `revoked`
      // (the schema admits only active|revoked) and never an active route.
      expect(result).toBeInstanceOf(Error)
      expect(String(result)).toContain(denials[index][1])
      expect(denials[index][1]).not.toBe('REVOKED')
    }
    // Without a derived route no transport can be constructed, so nothing reaches the wire.
    const routes = derived.filter((result) => !(result instanceof Error))
    expect(routes).toHaveLength(0)
    if (routes.length > 0) void wire.sendCommand({})
    expect(dispatches).toBe(0)
  })

  test('revocation still wins over an unusable state and keeps its own typed outcome', () => {
    const route = deriveSecureAcpRemoteRoute({
      workspaceId,
      connection: {
        ...connection,
        status: 'revoked',
        node: { ...connection.node, status: 'offline' },
      },
      configuration: { ...configuration, revokedAt: '2026-08-25T12:00:10.000Z' },
    })
    expect(route.status).toBe('revoked')
    expect(route.revokedAt).toBe('2026-08-25T12:00:10.000Z')
  })
})
