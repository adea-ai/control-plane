// Production construction proofs for the secure remote ACP device route (#1023/#1040): the Local
// composition builds the device endpoint over its OWN persistence provider through
// createPersistentSecureAcpDeviceEndpoint, and a revocation applied in one composition instance is
// read back from durable state by a restarted composition. Uses a disposable temp data directory
// only — no shared container, server, or port.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  AcpRemoteDeviceRouteSchema,
  SecureAcpRemoteTransport,
  generateRecipientKeyPair,
  generateSigningKeyPair,
} from '@control-plane/acp-adapter'
import { LocalControlPlaneComposition } from './composition.ts'

const VALID_UNTIL = '2027-08-25T13:00:00.000Z'
const INVOCATION_ID = 'inv_000000000000000000000000000000ab'

const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
}

const controllerKeys = generateSigningKeyPair()
const deviceKeys = generateSigningKeyPair()
const deviceRecipient = await generateRecipientKeyPair()

const route = AcpRemoteDeviceRouteSchema.parse({
  workspaceId: ids.workspaceId,
  nodeId: ids.nodeId,
  runtimeConnectionId: ids.runtimeConnectionId,
  location: 'local_device',
  deviceKeyId: 'dev_sig_0000000001',
  deviceSigningPublicKey: deviceKeys.publicKey,
  deviceEncryptionKeyId: 'dev_hpke_0000000001',
  deviceEncryptionPublicKey: deviceRecipient.publicKey,
  controllerKeyId: 'ctl_sig_0000000001',
  controllerSigningPublicKey: controllerKeys.publicKey,
  status: 'active',
  validUntil: VALID_UNTIL,
})

const neverReached = async () => {
  throw new Error('EXECUTOR_NOT_EXPECTED')
}

const routeOptions = {
  secureAcpRemoteRoute: {
    route,
    identity: { keyId: route.deviceKeyId, signingKey: deviceKeys.privateKey },
    encryption: {
      keyId: route.deviceEncryptionKeyId,
      privateKey: deviceRecipient.keyPair.privateKey,
      publicKey: deviceRecipient.publicKey,
    },
    executor: { dispatch: neverReached, inventory: neverReached },
  },
}

describe('Local composition constructs the secure route over its own persistence', () => {
  test('the endpoint is built from the composition persistence and never uses the in-memory seam', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-acp-secure-route-'))
    try {
      const composition = new LocalControlPlaneComposition({
        dataDirectory: directory,
        ...routeOptions,
      })
      try {
        await composition.persistence.migrate()
        expect(composition.secureAcpDevice).toBeDefined()
        expect(composition.secureAcpDevice?.isRevoked()).toBe(false)
        // Without the option no secure route is constructed (behavior unchanged).
        const without = new LocalControlPlaneComposition({ dataDirectory: directory })
        try {
          expect(without.secureAcpDevice).toBeUndefined()
        } finally {
          await without.close()
        }
      } finally {
        await composition.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a revocation applied in one composition fences a restarted composition through durable state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-acp-secure-restart-'))
    try {
      const first = new LocalControlPlaneComposition({
        dataDirectory: directory,
        ...routeOptions,
      })
      await first.persistence.migrate()
      expect(first.secureAcpDevice).toBeDefined()

      const controller = new SecureAcpRemoteTransport({
        route,
        wire: {
          connectionState: () => 'online',
          sendCommand: neverReached,
          requestInventory: neverReached,
        },
        controller: { keyId: route.controllerKeyId, signingKey: controllerKeys.privateKey },
        grantState: () => 'granted',
      })
      await first.secureAcpDevice?.applyRevocation(controller.revoke('2026-08-25T12:00:10.000Z'))
      await first.close()

      // Restart: a fresh composition over the same data directory reads the persisted fence before
      // anything can be served — the endpoint answers from durable state, not process memory.
      const second = new LocalControlPlaneComposition({
        dataDirectory: directory,
        ...routeOptions,
      })
      try {
        await second.persistence.migrate()
        const reply = await second.secureAcpDevice?.handleInventory(INVOCATION_ID)
        expect(reply).toMatchObject({ kind: 'denial', reason: 'device_revoked' })
      } finally {
        await second.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
