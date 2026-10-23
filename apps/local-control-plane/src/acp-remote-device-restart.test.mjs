// Restart proofs for the secure ACP device route through the Local profile's real SQLite
// production composition: a fresh `SqlitePersistenceProvider`, store, and endpoint over the same
// database file stand in for a process restart. Database files live in per-test temp directories
// that are removed afterwards; no shared container, server, or port is used.
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  AcpRemoteDeviceRouteSchema,
  acpRemoteDeviceStateScope,
  PersistenceProviderAcpRemoteDeviceStateStore,
  ReferenceAcpDriver,
  ReferenceAcpGatewayTransport,
  SecureAcpDeviceEndpoint,
  SecureAcpRemoteTransport,
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
const COMMAND_D = 'cmd_01JEBCDEF0123456789ABCDEFG'

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

/** A schema-valid runtime.session envelope, sealed through the controller on dispatch. */
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
async function openDevice(store, clock, wrapExecutor = (executor) => executor) {
  const driver = new ReferenceAcpDriver({
    now: () => clock.current.toISOString(),
    scenario: 'complete',
    nativeSessions: [{ sessionId: 'native-session-1', title: 'Restart session' }],
    sessionReplay: true,
  })
  driver.setGrantState('grant:project-0001', 'granted')
  const reference = new ReferenceAcpGatewayTransport({
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
    executor: wrapExecutor(reference),
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

test('restart preserves recorded replay outcomes and the channel-generation fence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-acp-remote-restart-'))
  const path = join(directory, 'device-state.sqlite')
  const clock = { current: new Date(NOW) }
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let store = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(route)
    )
    const first = await openDevice(store, clock)
    const channel = openController(first.device, clock)
    await channel.controller.dispatch(buildCommand({ commandId: COMMAND_A, channelGeneration: 2 }))
    expect(first.driver.effectCount(ATTEMPT_ID, RUNTIME_SESSION)).toBe(1)
    const sealed = structuredClone(channel.wire.log[0])
    // Simulated crash: the durable state closes while recorded effects remain.
    await provider.close()

    // Restart: fresh provider, store, driver, and endpoint over the same durable state.
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    store = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(route)
    )
    const second = await openDevice(store, clock)

    const replay = await second.device.handleCommand(structuredClone(sealed))
    expect(replay).toMatchObject({ kind: 'exchange' })
    expect(second.driver.effectCount(ATTEMPT_ID, RUNTIME_SESSION)).toBe(0)

    const reopened = openController(second.device, clock)
    await expect(
      reopened.controller.dispatch(buildCommand({ commandId: COMMAND_B, channelGeneration: 1 }))
    ).rejects.toMatchObject({ code: 'RUNTIME_GATEWAY_STALE_CHANNEL', retryable: false })
    expect(second.driver.effectCount(ATTEMPT_ID, RUNTIME_SESSION)).toBe(0)
    await provider.close()
    provider = undefined
  } finally {
    if (provider !== undefined) await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a revocation applied before a restart still fences the device after it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-acp-remote-revocation-'))
  const path = join(directory, 'device-state.sqlite')
  const clock = { current: new Date(NOW) }
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const store = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(route)
    )
    const first = await openDevice(store, clock)
    const channel = openController(first.device, clock)
    await first.device.applyRevocation(channel.controller.revoke('2026-08-25T12:00:10.000Z'))
    await provider.close()

    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    const reopenedStore = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(route)
    )
    expect(await reopenedStore.loadFence()).toMatchObject({
      revokedAt: '2026-08-25T12:00:10.000Z',
    })
    const second = await openDevice(reopenedStore, clock)
    const reopened = openController(second.device, clock)

    await expect(
      reopened.controller.dispatch(buildCommand({ commandId: COMMAND_C }))
    ).rejects.toMatchObject({ code: 'RUNTIME_NODE_REVOKED', retryable: false })
    expect(second.driver.effectCount(ATTEMPT_ID, RUNTIME_SESSION)).toBe(0)
    await provider.close()
    provider = undefined
  } finally {
    if (provider !== undefined) await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a crash after the durable claim never re-executes the effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-acp-remote-pending-'))
  const path = join(directory, 'device-state.sqlite')
  const clock = { current: new Date(NOW) }
  let provider = new SqlitePersistenceProvider({ path })
  let sealed
  try {
    await provider.migrate()
    const store = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(route)
    )
    const crashed = await openDevice(store, clock, (reference) => ({
      inventory: (signal) => reference.inventory(signal),
      // The effect starts and never completes: the crash window between claim and outcome.
      dispatch: () => new Promise(() => {}),
    }))
    const channel = openController(crashed.device, clock)
    void channel.controller.dispatch(buildCommand({ commandId: COMMAND_D }))
    const deadline = Date.now() + 5_000
    while ((await store.countLedger()) < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(await store.countLedger()).toBe(1)
    sealed = structuredClone(channel.wire.log[0])
    // Simulated crash while the claimed effect is still in flight.
    await provider.close()

    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    const reopenedStore = new PersistenceProviderAcpRemoteDeviceStateStore(
      provider,
      acpRemoteDeviceStateScope(route)
    )
    const second = await openDevice(reopenedStore, clock)
    const response = await second.device.handleCommand(structuredClone(sealed))
    expect(response).toMatchObject({ kind: 'denial', reason: 'outcome_uncertain' })
    expect(second.driver.effectCount(ATTEMPT_ID, RUNTIME_SESSION)).toBe(0)
    await provider.close()
    provider = undefined
  } finally {
    if (provider !== undefined) await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
