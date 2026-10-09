// Shared-store fence proofs for the secure ACP device route (#1023/#1040): two endpoints over one
// PersistenceProvider store, atomic durable claim enforcement, and per-route fence/ledger
// namespacing. Databases are disposable per-test temp SQLite files (the Local profile's real
// persistence composition); no shared container, server, or port is used, and only these fixtures
// write.
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  AcpRemoteDeviceRouteSchema,
  InMemoryAcpRemoteDeviceStateStore,
  PersistenceProviderAcpRemoteDeviceStateStore,
  ReferenceAcpDriver,
  ReferenceAcpGatewayTransport,
  SecureAcpDeviceEndpoint,
  SecureAcpRemoteTransport,
  acpRemoteDeviceStateScope,
  generateRecipientKeyPair,
  generateSigningKeyPair,
} from '@control-plane/acp-adapter'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'

const NOW = '2026-08-25T12:00:00.000Z'
const EXPIRES_AT = '2026-08-25T12:01:00.000Z'
const ATTEMPT_ID = 'att_01JABCDEF0123456789ABCDEFG'
const RUNTIME_SESSION = 'runtime.session'
const COMMAND_A = 'cmd_01JABCDEF0123456789ABCDEFG'
const COMMAND_B = 'cmd_01JBBCDEF0123456789ABCDEFG'
const COMMAND_C = 'cmd_01JDBCDEF0123456789ABCDEFG'

const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  runtimeOpaqueRef: 'nref_01JABCDEF0123456789ABCDEFG',
}

// Synthetic, per-process key material. Nothing here reads a live credential or enrollment.
const controllerKeys = generateSigningKeyPair()
const deviceKeys = generateSigningKeyPair()
const deviceRecipient = await generateRecipientKeyPair()
// A second, independent device route used to prove fence/ledger namespacing in a shared store.
const otherDeviceKeys = generateSigningKeyPair()
const otherDeviceRecipient = await generateRecipientKeyPair()
const routeB = AcpRemoteDeviceRouteSchema.parse({
  workspaceId: ids.workspaceId,
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFH',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFH',
  location: 'local_device',
  deviceKeyId: 'dev_sig_0000000002',
  deviceSigningPublicKey: otherDeviceKeys.publicKey,
  deviceEncryptionKeyId: 'dev_hpke_0000000002',
  deviceEncryptionPublicKey: otherDeviceRecipient.publicKey,
  controllerKeyId: 'ctl_sig_0000000001',
  controllerSigningPublicKey: controllerKeys.publicKey,
  status: 'active',
  validUntil: '2026-08-25T13:00:00.000Z',
})
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
  validUntil: '2026-08-25T13:00:00.000Z',
})

/** A schema-valid runtime.session envelope, sealed through a controller on dispatch. */
function buildCommand({
  commandId,
  channelGeneration = 1,
  issuedAt = NOW,
  expiresAt = EXPIRES_AT,
  sequence = 1,
}) {
  const payload = { version: 1, parameters: { action: 'list' } }
  return {
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 7 },
    sequence,
    nodeId: ids.nodeId,
    workspaceId: ids.workspaceId,
    traceId: ids.traceId,
    sentAt: issuedAt,
    channelGeneration,
    commandId,
    idempotencyKey: `acp:${createHash('sha256').update(commandId).digest('hex').slice(0, 48)}`,
    payloadHash: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
    issuedAt,
    expiresAt,
    family: 'runtime',
    operation: RUNTIME_SESSION,
    driver: { family: 'acp', version: '1.0.0' },
    runtimeConnectionId: ids.runtimeConnectionId,
    executionId: ids.executionId,
    attemptId: ATTEMPT_ID,
    requiredCapabilities: ['session.list'],
    payload,
  }
}

/** One "process": a real reference executor plus the endpoint over the supplied durable store. */
async function openDevice(store, clock) {
  const driver = new ReferenceAcpDriver({
    now: () => clock.current.toISOString(),
    scenario: 'complete',
    nativeSessions: [{ sessionId: 'native-session-1', title: 'Shared-store session' }],
    sessionReplay: true,
  })
  driver.setGrantState('grant:project-0001', 'granted')
  const executor = new ReferenceAcpGatewayTransport({
    driver,
    now: () => clock.current.toISOString(),
    nodeId: ids.nodeId,
    workspaceId: ids.workspaceId,
    runtimeConnectionId: ids.runtimeConnectionId,
    runtimeOpaqueRef: ids.runtimeOpaqueRef,
  })
  const device = new SecureAcpDeviceEndpoint({
    route,
    identity: { keyId: route.deviceKeyId, signingKey: deviceKeys.privateKey },
    encryption: {
      keyId: route.deviceEncryptionKeyId,
      privateKey: deviceRecipient.keyPair.privateKey,
      publicKey: deviceRecipient.publicKey,
    },
    executor,
    now: () => new Date(clock.current),
    stateStore: store,
  })
  return { driver, device }
}

/** Controller over a direct wire that records every sealed command it sends. */
function openController(device, clock) {
  const wire = {
    log: [],
    connectionState: () => 'online',
    async sendCommand(command) {
      this.log.push(structuredClone(command))
      return device.handleCommand(command)
    },
    async requestInventory(requestId) {
      return device.handleInventory(requestId)
    },
  }
  const controller = new SecureAcpRemoteTransport({
    route,
    wire,
    controller: { keyId: route.controllerKeyId, signingKey: controllerKeys.privateKey },
    grantState: () => 'granted',
    now: () => new Date(clock.current),
  })
  return { wire, controller }
}

const INVOCATION_ID = 'inv_000000000000000000000000000000ab'

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-acp-remote-fence-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'fence.sqlite') })
  try {
    await provider.migrate()
    await run(provider)
    await provider.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('the durable claim rejects revoked and superseded deliveries without writing', async () => {
  await withStore(async (provider) => {
    const store = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(route)
    )
    expect(
      await store.claim({ commandId: COMMAND_A, identity: 'identity-a', channelGeneration: 2 })
    ).toBe('claimed')
    expect(
      await store.claim({ commandId: COMMAND_A, identity: 'identity-a', channelGeneration: 2 })
    ).toBe('already_claimed')
    expect(
      await store.claim({ commandId: COMMAND_B, identity: 'identity-b', channelGeneration: 1 })
    ).toBe('stale_channel_generation')
    expect(await store.readLedger(COMMAND_B)).toBeUndefined()
    expect(await store.countLedger()).toBe(1)

    await store.applyRevocation('2026-08-25T12:00:10.000Z')
    expect(
      await store.claim({ commandId: COMMAND_C, identity: 'identity-c', channelGeneration: 3 })
    ).toBe('device_revoked')
    expect(await store.readLedger(COMMAND_C)).toBeUndefined()
    expect(await store.countLedger()).toBe(1)
    expect(await store.loadFence()).toMatchObject({
      highestGeneration: 2,
      revokedAt: '2026-08-25T12:00:10.000Z',
    })

    // The in-memory seam enforces the same atomic fence semantics.
    const memory = new InMemoryAcpRemoteDeviceStateStore()
    expect(
      await memory.claim({ commandId: COMMAND_A, identity: 'identity-a', channelGeneration: 2 })
    ).toBe('claimed')
    expect(
      await memory.claim({ commandId: COMMAND_B, identity: 'identity-b', channelGeneration: 1 })
    ).toBe('stale_channel_generation')
    await memory.applyRevocation('2026-08-25T12:00:11.000Z')
    expect(
      await memory.claim({ commandId: COMMAND_C, identity: 'identity-c', channelGeneration: 2 })
    ).toBe('device_revoked')
    expect(await memory.readLedger(COMMAND_B)).toBeUndefined()
    expect(await memory.readLedger(COMMAND_C)).toBeUndefined()
  })
})

test('two endpoints over one shared store: revocation through one fences the other atomically', async () => {
  await withStore(async (provider) => {
    const clock = { current: new Date(NOW) }
    const store = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(route)
    )
    const first = await openDevice(store, clock)
    const second = await openDevice(store, clock)
    const channelA = openController(first.device, clock)
    const channelB = openController(second.device, clock)
    // The second endpoint loads its in-process mirror once, while the route is still clean, and
    // never reloads it afterwards — the exact load-once staleness the durable fence must cover.
    await second.device.handleInventory(INVOCATION_ID)

    await first.device.applyRevocation(channelA.controller.revoke('2026-08-25T12:00:10.000Z'))

    await expect(
      channelB.controller.dispatch(buildCommand({ commandId: COMMAND_B }))
    ).rejects.toMatchObject({ code: 'RUNTIME_NODE_REVOKED', retryable: false })
    expect(second.driver.effectCount(ATTEMPT_ID, RUNTIME_SESSION)).toBe(0)
    expect(first.driver.effectCount(ATTEMPT_ID, RUNTIME_SESSION)).toBe(0)
    expect(await store.countLedger()).toBe(0)
  })
})

test('two endpoints over one shared store: a stale generation denied only by the atomic fence', async () => {
  await withStore(async (provider) => {
    const clock = { current: new Date(NOW) }
    const store = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(route)
    )
    const first = await openDevice(store, clock)
    const second = await openDevice(store, clock)
    const channelA = openController(first.device, clock)
    const channelB = openController(second.device, clock)
    // Endpoint two loads its mirror before any generation is accepted, so its in-process
    // highest-generation stays 0 and only the persisted fence can reject the stale delivery.
    await second.device.handleInventory(INVOCATION_ID)

    await channelA.controller.dispatch(buildCommand({ commandId: COMMAND_A, channelGeneration: 2 }))
    expect(first.driver.effectCount(ATTEMPT_ID, RUNTIME_SESSION)).toBe(1)
    expect(await store.loadFence()).toMatchObject({ highestGeneration: 2 })

    await expect(
      channelB.controller.dispatch(
        buildCommand({ commandId: COMMAND_B, channelGeneration: 1, sequence: 2 })
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_GATEWAY_STALE_CHANNEL', retryable: false })
    expect(second.driver.effectCount(ATTEMPT_ID, RUNTIME_SESSION)).toBe(0)
  })
})

test('two endpoints racing one command through a shared store execute it exactly once', async () => {
  await withStore(async (provider) => {
    const clock = { current: new Date(NOW) }
    const store = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(route)
    )
    const first = await openDevice(store, clock)
    const second = await openDevice(store, clock)
    const channelA = openController(first.device, clock)
    const channelB = openController(second.device, clock)

    const captured = (promise) =>
      promise.then(
        (value) => ({ value }),
        (error) => ({ error })
      )
    const [resultA, resultB] = await Promise.all([
      captured(channelA.controller.dispatch(buildCommand({ commandId: COMMAND_A }))),
      captured(
        channelB.controller.dispatch(
          buildCommand({ commandId: COMMAND_A, issuedAt: NOW, expiresAt: EXPIRES_AT })
        )
      ),
    ])

    // Exactly one endpoint may claim and execute; the loser replays the durable record instead of
    // running the effect, whether it read a pending claim or the finished outcome.
    const effects =
      first.driver.effectCount(ATTEMPT_ID, RUNTIME_SESSION) +
      second.driver.effectCount(ATTEMPT_ID, RUNTIME_SESSION)
    expect(effects).toBe(1)
    for (const result of [resultA, resultB]) {
      if (result.error !== undefined) {
        expect(result.error.code).toBe('RUNTIME_NODE_OUTCOME_UNCERTAIN')
      } else {
        expect(result.value.ack).toBeDefined()
      }
    }
    expect(await store.countLedger()).toBe(1)
  })
})

test('fence and ledger records are namespaced by the authenticated route identity', async () => {
  await withStore(async (provider) => {
    const storeA = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(route)
    )
    const storeB = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(routeB)
    )
    // One store instance per authenticated route over one provider: the second scope derives from
    // a different route record (node, connection, and device key), so the two never conflate.
    expect(
      await storeA.claim({ commandId: COMMAND_B, identity: 'route-a', channelGeneration: 4 })
    ).toBe('claimed')
    // Route A's generation-4 fence is invisible to the other scope.
    expect(await storeB.loadFence()).toEqual({ highestGeneration: 0 })
    // The same command id is claimable independently: command-only keys would conflate the routes.
    expect(
      await storeB.claim({ commandId: COMMAND_B, identity: 'route-b', channelGeneration: 1 })
    ).toBe('claimed')
    expect(
      await storeB.claim({ commandId: COMMAND_B, identity: 'route-b', channelGeneration: 1 })
    ).toBe('already_claimed')
    await storeA.recordOutcome(COMMAND_B, { kind: 'denial', reason: 'executor_failed' })
    // Route B keeps its own pending entry; route A's recorded outcome never leaks across.
    expect(await storeB.readLedger(COMMAND_B)).toEqual({ identity: 'route-b' })
    expect(await storeA.countLedger()).toBe(1)
    expect(await storeB.countLedger()).toBe(1)

    // Revocation of one scope stays terminal for that scope only; the other scope keeps its own
    // fence (generation 1 from its own earlier claim) with no revokedAt.
    await storeA.applyRevocation('2026-08-25T12:00:10.000Z')
    expect(await storeB.loadFence()).toEqual({ highestGeneration: 1 })
    expect(
      await storeB.claim({ commandId: COMMAND_C, identity: 'route-b', channelGeneration: 2 })
    ).toBe('claimed')
    expect(
      await storeA.claim({ commandId: COMMAND_C, identity: 'route-a', channelGeneration: 2 })
    ).toBe('device_revoked')
  })
})
