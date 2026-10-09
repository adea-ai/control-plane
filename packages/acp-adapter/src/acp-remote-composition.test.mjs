// Production factory proof for the secure device route (#1023/#1040): the persistent factory wires
// the durable store through the caller's real provider, so fence state can never silently fall
// back to the non-durable in-memory seam.
import { describe, expect, test } from 'bun:test'
import {
  AcpRemoteDeviceRouteSchema,
  SecureAcpDeviceEndpoint,
  createPersistentSecureAcpDeviceEndpoint,
  generateRecipientKeyPair,
  generateSigningKeyPair,
} from './gateway.ts'

const INVOCATION_ID = 'inv_000000000000000000000000000000ab'

const controllerKeys = generateSigningKeyPair()
const deviceKeys = generateSigningKeyPair()
const deviceRecipient = await generateRecipientKeyPair()

const route = AcpRemoteDeviceRouteSchema.parse({
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
  location: 'local_device',
  deviceKeyId: 'dev_sig_0000000001',
  deviceSigningPublicKey: deviceKeys.publicKey,
  deviceEncryptionKeyId: 'dev_hpke_0000000001',
  deviceEncryptionPublicKey: deviceRecipient.publicKey,
  controllerKeyId: 'ctl_sig_0000000001',
  controllerSigningPublicKey: controllerKeys.publicKey,
  status: 'active',
  validUntil: '2027-08-25T13:00:00.000Z',
})

const neverReached = async () => {
  throw new Error('EXECUTOR_NOT_EXPECTED')
}

describe('createPersistentSecureAcpDeviceEndpoint', () => {
  test('consults the supplied provider for fence state instead of the in-memory seam', async () => {
    const calls = []
    const provider = {
      profile: 'local',
      dialect: 'sqlite',
      migrate: async () => calls.push('migrate'),
      health: async () => ({
        ready: true,
        component: 'fixture',
        version: '0',
        details: {},
      }),
      close: () => {},
      transaction: async () => {
        calls.push('transaction')
        throw new Error('PROVIDER_DOWN')
      },
    }
    const endpoint = createPersistentSecureAcpDeviceEndpoint({
      provider,
      route,
      identity: { keyId: route.deviceKeyId, signingKey: deviceKeys.privateKey },
      encryption: {
        keyId: route.deviceEncryptionKeyId,
        privateKey: deviceRecipient.keyPair.privateKey,
        publicKey: deviceRecipient.publicKey,
      },
      executor: { dispatch: neverReached, inventory: neverReached },
    })

    expect(endpoint).toBeInstanceOf(SecureAcpDeviceEndpoint)
    // The durable store is consulted through the provider; a provider failure fails closed as
    // state_unavailable. The in-memory default would have answered from process memory instead.
    const reply = await endpoint.handleInventory(INVOCATION_ID)
    expect(reply).toMatchObject({ kind: 'denial', reason: 'state_unavailable' })
    expect(calls).toContain('transaction')
    expect(endpoint.isRevoked()).toBe(false)
  })
})
