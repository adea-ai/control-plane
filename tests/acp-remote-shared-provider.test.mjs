// Shared-provider proof for the secure ACP device route (#1023/#1040): two device endpoints over ONE
// scoped durable store on the real SQLite PersistenceProvider, the persistence the Local profile runs
// in production. Each endpoint loads persisted fence state once, so a peer endpoint's durable
// revocation or generation advance must still fence replay, publication, and inventory on the
// endpoint whose in-process mirror has not seen it.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '../packages/sqlite-persistence/src/provider.ts'
import {
  PersistenceProviderAcpRemoteDeviceStateStore,
  acpRemoteDeviceStateScope,
} from '../packages/acp-adapter/src/acp-remote-device-state.ts'
import { SecureAcpDeviceEndpoint } from '../packages/acp-adapter/src/acp-remote-transport.ts'
import {
  ACP_REMOTE_SUITE,
  canonicalJson,
  utf8,
} from '../packages/acp-adapter/src/acp-remote-crypto.ts'
import {
  commandIds,
  createSecureFixture,
  ids,
  runtimeCommand,
  sealRawCommand,
} from '../packages/acp-adapter/src/acp-remote-fixtures.mjs'

const RUNTIME_SESSION = 'runtime.session'
const REVOKED_AT = '2026-08-25T12:00:10.000Z'
const RETURN_KEY_ID = 'ret_000000000000000000000000000000f1'
const INVENTORY_WARM = 'inv_0123456789abcdef0123456789abcdef'
const INVENTORY_LATER = 'inv_fedcba9876543210fedcba9876543210'

/** Seals a runtime command as the controller does for one delivery under a fixed return key. */
function sealFor(fixture, command) {
  return sealRawCommand({
    route: fixture.route,
    signingKey: fixture.keys.controllerSigning,
    header: {
      suite: ACP_REMOTE_SUITE,
      workspaceId: ids.workspaceId,
      nodeId: ids.nodeId,
      runtimeConnectionId: ids.runtimeConnectionId,
      commandId: command.commandId,
      payloadHash: command.payloadHash,
      issuedAt: command.issuedAt,
      expiresAt: command.expiresAt,
      channelGeneration: command.channelGeneration,
      controllerKeyId: fixture.route.controllerKeyId,
      recipientKeyId: fixture.route.deviceEncryptionKeyId,
      returnKeyId: RETURN_KEY_ID,
      returnPublicKey: fixture.keys.otherRecipient.publicKey,
    },
    plaintext: utf8(canonicalJson(command)),
  })
}

/** A device endpoint over the fixture's keys and executor, persisting its fence state to `stateStore`. */
function endpointOver(fixture, stateStore) {
  return new SecureAcpDeviceEndpoint({
    route: fixture.route,
    identity: { keyId: fixture.route.deviceKeyId, signingKey: fixture.keys.deviceSigning },
    encryption: {
      keyId: fixture.route.deviceEncryptionKeyId,
      privateKey: fixture.keys.deviceRecipient.keyPair.privateKey,
      publicKey: fixture.keys.deviceRecipient.publicKey,
    },
    executor: fixture.executor,
    now: fixture.now,
    stateStore,
  })
}

/** Two endpoints over one SQLite provider file, both scoped to the same authenticated route. */
async function withSharedProvider(run) {
  const directory = await mkdtemp(join(tmpdir(), 'acp-shared-provider-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    const fixture = await createSecureFixture()
    const scope = acpRemoteDeviceStateScope(fixture.route)
    const endpointA = endpointOver(
      fixture,
      new PersistenceProviderAcpRemoteDeviceStateStore(provider, scope)
    )
    const endpointB = endpointOver(
      fixture,
      new PersistenceProviderAcpRemoteDeviceStateStore(provider, scope)
    )
    await run({ fixture, endpointA, endpointB, provider })
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('two endpoints over one shared SQLite provider fence each other', () => {
  test('a new command after a peer revocation is refused by the durable claim before any effect', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      expect(await endpointA.handleInventory(INVENTORY_WARM)).toMatchObject({ kind: 'inventory' })
      await endpointB.applyRevocation(fixture.controller.revoke(REVOKED_AT))

      const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
      expect(await endpointA.handleCommand(sealed)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(0)
    })
  })

  test('a peer revocation fences replay of a recorded command on the endpoint with a stale mirror', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
      expect(await endpointA.handleCommand(sealed)).toMatchObject({ kind: 'exchange' })

      await endpointB.applyRevocation(fixture.controller.revoke(REVOKED_AT))
      expect(endpointA.isRevoked()).toBe(false)

      expect(await endpointA.handleCommand(sealed)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    })
  })

  test('a peer generation advance fences replay of an older recorded command on the stale endpoint', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      const older = await sealFor(
        fixture,
        runtimeCommand({ commandId: commandIds.first, channelGeneration: 1 })
      )
      expect(await endpointA.handleCommand(older)).toMatchObject({ kind: 'exchange' })

      const newer = await sealFor(
        fixture,
        runtimeCommand({ commandId: commandIds.second, channelGeneration: 2 })
      )
      expect(await endpointB.handleCommand(newer)).toMatchObject({ kind: 'exchange' })

      expect(await endpointA.handleCommand(older)).toMatchObject({
        kind: 'denial',
        reason: 'stale_channel_generation',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(2)
    })
  })

  test('a peer revocation landing during execution refuses publication and keeps the effect recorded once', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      const originalDispatch = fixture.executor.dispatch.bind(fixture.executor)
      fixture.executor.dispatch = async (command) => {
        const exchange = await originalDispatch(command)
        // The peer revokes durably while this endpoint's effect is in flight; its mirror stays active.
        await endpointB.applyRevocation(fixture.controller.revoke(REVOKED_AT))
        return exchange
      }
      const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))

      expect(await endpointA.handleCommand(sealed)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
      // The redelivery replays nothing and repeats no effect.
      expect(await endpointA.handleCommand(sealed)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    })
  })

  test('a peer revocation fences inventory on an endpoint that already loaded its mirror', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      expect(await endpointA.handleInventory(INVENTORY_WARM)).toMatchObject({ kind: 'inventory' })
      await endpointB.applyRevocation(fixture.controller.revoke(REVOKED_AT))

      expect(await endpointA.handleInventory(INVENTORY_LATER)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
    })
  })

  test('a peer revocation landing while inventory is produced stops the signed reply', async () => {
    await withSharedProvider(async ({ fixture, endpointA, endpointB }) => {
      expect(await endpointA.handleInventory(INVENTORY_WARM)).toMatchObject({ kind: 'inventory' })
      const originalInventory = fixture.executor.inventory.bind(fixture.executor)
      fixture.executor.inventory = async () => {
        const envelope = await originalInventory()
        await endpointB.applyRevocation(fixture.controller.revoke(REVOKED_AT))
        return envelope
      }

      expect(await endpointA.handleInventory(INVENTORY_LATER)).toMatchObject({
        kind: 'denial',
        reason: 'device_revoked',
      })
    })
  })

  test('a cached publication fails closed as state_unavailable when the shared store is closed', async () => {
    await withSharedProvider(async ({ fixture, endpointA, provider }) => {
      const sealed = await sealFor(fixture, runtimeCommand({ commandId: commandIds.first }))
      expect(await endpointA.handleCommand(sealed)).toMatchObject({ kind: 'exchange' })

      provider.close()
      expect(await endpointA.handleCommand(sealed)).toMatchObject({
        kind: 'denial',
        reason: 'state_unavailable',
      })
      expect(fixture.driver.effectCount(ids.attemptId, RUNTIME_SESSION)).toBe(1)
    })
  })
})
