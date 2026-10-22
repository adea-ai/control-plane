import { expect, test } from 'bun:test'
import {
  GatewayCommandEnvelopeSchema,
  GatewayProtocolManifest,
} from '@control-plane/runtime-gateway-protocol'
import {
  ACP_REMOTE_GATEWAY_CHANNEL_OFFLINE,
  acpRemoteReplyArtifactKey,
  createAcpRemoteGatewayChannel,
} from './acp-remote-gateway-channel.ts'

/**
 * The gateway-owned channel that carries one opaque sealed ACP command through the gateway's
 * ordinary durable command path and brings back the device's sealed reply.
 *
 * The delivery port is faked here; everything the adapter adds — the generation fence, the
 * attempt-scoped reply artifact read, the terminal-state mapping and the bounded wait — is the
 * real implementation. No socket, no device, no credential is involved.
 */

const carrier = (overrides = {}) =>
  GatewayCommandEnvelopeSchema.parse({
    type: 'command',
    schemaVersion: 1,
    protocolVersion: GatewayProtocolManifest.current,
    sequence: 1,
    nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    sentAt: '2026-10-21T00:00:00.000Z',
    channelGeneration: 3,
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    idempotencyKey: 'acp:0123456789abcdef0123456789abcdef0123456789abcdef',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    issuedAt: '2026-10-21T00:00:00.000Z',
    expiresAt: '2026-10-21T00:01:00.000Z',
    family: 'runtime',
    operation: 'runtime.acp-remote-sealed',
    driver: { family: 'acp', version: '1.0.0' },
    runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    requiredCapabilities: ['stream.output'],
    payload: { version: 1, parameters: { acpRemoteSealed: 'b3BhcXVl' } },
    ...overrides,
  })

const replyBytes = (value) => new TextEncoder().encode(JSON.stringify(value))

const deliveryFake = ({ terminal = 'succeeded', onDeliver } = {}) => {
  const records = new Map()
  const enqueued = []
  return {
    records,
    enqueued,
    port: {
      enqueue: async (command) => {
        enqueued.push(command)
        const record = {
          commandId: command.commandId,
          attemptId: command.attemptId,
          status: 'queued',
        }
        records.set(command.commandId, record)
        return { record, replayed: false }
      },
      deliver: async (commandId, transport) => {
        onDeliver?.(commandId, transport)
        const record = records.get(commandId)
        records.set(commandId, { ...record, status: terminal })
        return { record: records.get(commandId), sent: true }
      },
      get: async (commandId) => records.get(commandId),
    },
  }
}

test('delivers the carrier on the current channel generation and reads the reply artifact', async () => {
  const reply = { kind: 'exchange', header: { commandId: 'cmd_01JABCDEF0123456789ABCDEFG' } }
  const artifacts = new Map()
  const deliveries = []
  const delivery = deliveryFake({ onDeliver: (commandId, transport) => deliveries.push(transport) })
  const channel = createAcpRemoteGatewayChannel({
    delivery: delivery.port,
    node: {
      currentChannelGeneration: () => 3,
      nextSequence: async () => 42,
      protocolVersion: () => GatewayProtocolManifest.current,
    },
    artifacts: {
      get: async (key) => {
        const body = artifacts.get(key)
        if (body === undefined) throw new Error('ARTIFACT_MISSING')
        return { body }
      },
    },
    pushedInventory: async () => ({ inventory: {}, channelGeneration: 3 }),
  })

  const command = carrier()
  artifacts.set(acpRemoteReplyArtifactKey(command.attemptId), replyBytes(reply))

  const result = await channel.dispatchSealed({ command })
  expect(result).toEqual(reply)
  expect(deliveries).toEqual([
    {
      channelGeneration: 3,
      sequence: 42,
      protocolVersion: GatewayProtocolManifest.current,
    },
  ])
  expect(delivery.enqueued).toHaveLength(1)
  expect(delivery.enqueued[0].operation).toBe('runtime.acp-remote-sealed')
})

test('refuses to deliver without an authenticated channel generation', async () => {
  const delivery = deliveryFake()
  const channel = createAcpRemoteGatewayChannel({
    delivery: delivery.port,
    node: {
      currentChannelGeneration: () => undefined,
      nextSequence: async () => 1,
      protocolVersion: () => GatewayProtocolManifest.current,
    },
    artifacts: { get: async () => ({ body: new Uint8Array() }) },
    pushedInventory: async () => ({ inventory: {}, channelGeneration: 1 }),
  })
  await expect(channel.dispatchSealed({ command: carrier() })).rejects.toThrow(
    ACP_REMOTE_GATEWAY_CHANNEL_OFFLINE
  )
  expect(delivery.enqueued).toHaveLength(0)
})

test('maps a failed command to a typed failure instead of a reply', async () => {
  const delivery = deliveryFake({ terminal: 'failed' })
  const channel = createAcpRemoteGatewayChannel({
    delivery: delivery.port,
    node: {
      currentChannelGeneration: () => 3,
      nextSequence: async () => 1,
      protocolVersion: () => GatewayProtocolManifest.current,
    },
    artifacts: { get: async () => ({ body: new Uint8Array() }) },
    pushedInventory: async () => ({ inventory: {}, channelGeneration: 3 }),
  })
  await expect(channel.dispatchSealed({ command: carrier() })).rejects.toThrow(
    'ACP_REMOTE_GATEWAY_COMMAND_FAILED'
  )
})

test('gives up on a command that never reaches a terminal state', async () => {
  const delivery = deliveryFake()
  // The command stays queued: the bounded wait must end, not hang. The clock advances on every
  // read so the deadline is reached.
  let tick = 0
  const now = () => new Date(Date.parse('2026-10-21T00:00:00.000Z') + tick++ * 10)
  const stuck = {
    ...delivery.port,
    deliver: async (commandId) => ({
      record: { commandId, attemptId: 'att_01JABCDEF0123456789ABCDEFG', status: 'queued' },
      sent: true,
    }),
  }
  const timedOut = createAcpRemoteGatewayChannel({
    delivery: stuck,
    node: {
      currentChannelGeneration: () => 3,
      nextSequence: async () => 1,
      protocolVersion: () => GatewayProtocolManifest.current,
    },
    artifacts: { get: async () => ({ body: new Uint8Array() }) },
    pushedInventory: async () => ({ inventory: {}, channelGeneration: 3 }),
    now,
    sleep: async () => {},
    replyTimeoutMs: 5,
    pollIntervalMs: 1,
  })
  await expect(timedOut.dispatchSealed({ command: carrier() })).rejects.toThrow(
    'ACP_REMOTE_GATEWAY_REPLY_TIMEOUT'
  )
})

test('surfaces the inventory the gateway pushed with the generation it was pushed at', async () => {
  const pushed = { inventory: { nodeId: 'rnr_01JABCDEF0123456789ABCDEFG' }, channelGeneration: 2 }
  const channel = createAcpRemoteGatewayChannel({
    delivery: deliveryFake().port,
    node: {
      currentChannelGeneration: () => 3,
      nextSequence: async () => 1,
      protocolVersion: () => GatewayProtocolManifest.current,
    },
    artifacts: { get: async () => ({ body: new Uint8Array() }) },
    pushedInventory: async () => pushed,
  })
  expect(await channel.pushedInventory()).toEqual(pushed)
  expect(channel.currentChannelGeneration()).toBe(3)
})
