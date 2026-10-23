// Production construction proofs for the secure remote ACP device route (#1023/#1040): the Local
// composition builds the device endpoint over its OWN persistence provider through
// createPersistentSecureAcpDeviceEndpoint, and a revocation applied in one composition instance is
// read back from durable state by a restarted composition. Uses a disposable temp data directory
// only — no shared container, server, or port.
import { createHash } from 'node:crypto'
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

const ORIGINAL_EXECUTOR = routeOptions.secureAcpRemoteRoute.executor

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

const TRACE_ID = 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const digestOf = (value) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

function secureCommand(commandId, channelGeneration = 1) {
  const issuedAt = new Date().toISOString()
  const payload = { version: 1, parameters: { action: 'list' } }
  return {
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 7 },
    sequence: 1,
    nodeId: ids.nodeId,
    workspaceId: ids.workspaceId,
    traceId: TRACE_ID,
    sentAt: issuedAt,
    channelGeneration,
    commandId,
    idempotencyKey: `acp:${commandId}`,
    payloadHash: digestOf(payload),
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
    family: 'runtime',
    operation: 'runtime.session',
    driver: { family: 'acp', version: '1.0.0' },
    runtimeConnectionId: ids.runtimeConnectionId,
    executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    requiredCapabilities: ['session.list'],
    payload,
  }
}

/** Executor that counts effects and acknowledges; unsupported inventory fails honestly. */
function countingExecutor(counter) {
  return {
    dispatch: async (command) => {
      counter.effects += 1
      return {
        ack: {
          schemaVersion: 1,
          protocolVersion: { major: 1, minor: 7 },
          sequence: counter.effects,
          nodeId: ids.nodeId,
          workspaceId: ids.workspaceId,
          traceId: TRACE_ID,
          sentAt: new Date().toISOString(),
          channelGeneration: 1,
          type: 'ack',
          commandId: command.commandId,
          payloadHash: command.payloadHash,
          disposition: 'accepted',
        },
        progress: [],
      }
    },
    inventory: async () => {
      throw new Error('INVENTORY_NOT_EXERCISED')
    },
  }
}

function controllerFor(device, connectionState = () => 'online') {
  return new SecureAcpRemoteTransport({
    route,
    wire: {
      connectionState,
      sendCommand: async (command) => device.handleCommand(command),
      requestInventory: async (requestId) => device.handleInventory(requestId),
    },
    controller: { keyId: route.controllerKeyId, signingKey: controllerKeys.privateKey },
    grantState: () => 'granted',
  })
}

/** Swaps the route executor around a composition construction (single-threaded; restored after). */
function swapExecutor(counter) {
  const original = routeOptions.secureAcpRemoteRoute.executor
  routeOptions.secureAcpRemoteRoute.executor = countingExecutor(counter)
  return () => {
    routeOptions.secureAcpRemoteRoute.executor = original
  }
}

async function withSecureComposition(run) {
  const directory = await mkdtemp(join(tmpdir(), 'acp-secure-lifecycle-'))
  const counter = { effects: 0 }
  const restore = swapExecutor(counter)
  let composition
  try {
    composition = new LocalControlPlaneComposition({ dataDirectory: directory, ...routeOptions })
    await composition.persistence.migrate()
    await run({ composition, counter, controller: controllerFor(composition.secureAcpDevice) })
  } finally {
    restore()
    if (composition) await composition.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('real composition secure-route runtime lifecycle', () => {
  test('restart replays a recorded command without a second effect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'acp-secure-restart-'))
    try {
      const firstCounter = { effects: 0 }
      routeOptions.secureAcpRemoteRoute.executor = countingExecutor(firstCounter)
      const first = new LocalControlPlaneComposition({ dataDirectory: directory, ...routeOptions })
      await first.persistence.migrate()
      const accepted = await controllerFor(first.secureAcpDevice).dispatch(
        secureCommand('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAA')
      )
      expect(accepted.ack).toMatchObject({ disposition: 'accepted' })
      expect(firstCounter.effects).toBe(1)
      await first.close()

      const secondCounter = { effects: 0 }
      routeOptions.secureAcpRemoteRoute.executor = countingExecutor(secondCounter)
      const second = new LocalControlPlaneComposition({ dataDirectory: directory, ...routeOptions })
      try {
        await second.persistence.migrate()
        const replay = await controllerFor(second.secureAcpDevice).dispatch(
          secureCommand('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAA')
        )
        expect(replay.ack).toBeDefined()
        expect(secondCounter.effects).toBe(0)
      } finally {
        routeOptions.secureAcpRemoteRoute.executor = ORIGINAL_EXECUTOR
        await second.close()
      }
    } finally {
      routeOptions.secureAcpRemoteRoute.executor = ORIGINAL_EXECUTOR
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('an offline wire denies without dispatch and recovers after reconnect', async () => {
    await withSecureComposition(async ({ composition, counter }) => {
      const state = { online: false }
      const controller = controllerFor(composition.secureAcpDevice, () =>
        state.online ? 'online' : 'offline'
      )
      await expect(
        controller.dispatch(secureCommand('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAB'))
      ).rejects.toMatchObject({ code: 'RUNTIME_NODE_OFFLINE' })
      expect(counter.effects).toBe(0)
      state.online = true
      const accepted = await controller.dispatch(secureCommand('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAB'))
      expect(accepted.ack).toMatchObject({ disposition: 'accepted' })
      expect(counter.effects).toBe(1)
    })
  })

  test('a stale channel generation is denied at the composition endpoint', async () => {
    await withSecureComposition(async ({ controller, counter }) => {
      const accepted = await controller.dispatch(secureCommand('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAC', 2))
      expect(accepted.ack).toMatchObject({ disposition: 'accepted' })
      expect(counter.effects).toBe(1)
      await expect(
        controller.dispatch(secureCommand('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAD', 1))
      ).rejects.toMatchObject({ code: 'RUNTIME_GATEWAY_STALE_CHANNEL' })
      expect(counter.effects).toBe(1)
    })
  })

  test('revocation denies dispatch and never re-executes', async () => {
    await withSecureComposition(async ({ composition, controller, counter }) => {
      const accepted = await controller.dispatch(secureCommand('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAE'))
      expect(accepted.ack).toMatchObject({ disposition: 'accepted' })
      expect(counter.effects).toBe(1)
      await composition.secureAcpDevice.applyRevocation(controller.revoke(new Date().toISOString()))
      await expect(
        controller.dispatch(secureCommand('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAF'))
      ).rejects.toMatchObject({ code: 'RUNTIME_NODE_REVOKED' })
      expect(counter.effects).toBe(1)
    })
  })

  test('a duplicate completion replays the recorded outcome without a second effect', async () => {
    await withSecureComposition(async ({ controller, counter }) => {
      const first = await controller.dispatch(secureCommand('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAG'))
      const second = await controller.dispatch(secureCommand('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAG'))
      expect(first.ack).toMatchObject({ disposition: 'accepted' })
      expect(second.ack).toBeDefined()
      expect(counter.effects).toBe(1)
    })
  })
})
