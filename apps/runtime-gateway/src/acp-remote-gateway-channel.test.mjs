import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GatewayCommandEnvelopeSchema,
  GatewayProtocolManifest,
} from '@control-plane/runtime-gateway-protocol'
import { InMemoryRuntimeCommandRepository } from '@control-plane/domain'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import {
  ACP_REMOTE_GATEWAY_CHANNEL_OFFLINE,
  acpRemoteReplyArtifactKey,
  createAcpRemoteGatewayChannel,
} from './acp-remote-gateway-channel.ts'
import { RuntimeCommandDeliveryService } from './runtime-command-delivery.ts'
import { RecordingGatewayMetrics } from './websocket-lifecycle.ts'

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

test('the durable command repository identifies one carrier command by its full envelope', async () => {
  const repository = new InMemoryRuntimeCommandRepository()
  const sent = []
  const delivery = new RuntimeCommandDeliveryService({
    repository,
    sender: {
      async send(envelope) {
        sent.push(envelope)
      },
    },
    metrics: new RecordingGatewayMetrics(),
    now: () => new Date('2026-10-21T00:00:00.000Z'),
  })
  const command = carrier({ commandId: 'cmd_01JABCDEF0123456789ABCDEFG' })

  // The same carrier enqueued twice is ONE durable command: the repository
  // identifies a command by its full envelope, so an identical envelope is a
  // replay of the same command and not a second one.
  await delivery.enqueue(command)
  const replay = await delivery.enqueue(command)
  expect(replay.replayed).toBe(true)
  expect(await delivery.get(command.commandId)).toMatchObject({
    commandId: command.commandId,
    deliveryAttempts: 0,
  })

  // A carrier REBUILT under the same command id differs in its sequence, so it
  // is a different command and the repository refuses it. This is the identity
  // the controller side has to hold: a retry that rebuilds the envelope is not a
  // retry, and the gateway answers it with a payload mismatch.
  await expect(
    delivery.enqueue(carrier({ commandId: command.commandId, sequence: command.sequence + 1 }))
  ).rejects.toMatchObject({ code: 'RUNTIME_COMMAND_PAYLOAD_MISMATCH' })
})

test('a retried carrier is ONE durable command in the real SQLite command repository', async () => {
  // The production repository, not a double: the durable command identity is
  // what the gateway enforces, so the retry has to hold against the real store.
  const directory = await mkdtemp(join(tmpdir(), 'acp-remote-carrier-retry-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'gateway.sqlite') })
  try {
    await provider.migrate()
    const { SqliteRuntimeCommandRepository } = await import('@control-plane/sqlite-persistence')
    const repository = new SqliteRuntimeCommandRepository(provider)
    const sent = []
    const delivery = new RuntimeCommandDeliveryService({
      repository,
      sender: {
        async send(envelope) {
          sent.push(envelope)
        },
      },
      metrics: new RecordingGatewayMetrics(),
      now: () => new Date('2026-10-21T00:00:00.000Z'),
    })
    const command = carrier({ commandId: 'cmd_01JABCDEF0123456789ABCDEFG' })

    // The controller side retries the same inner command with the SAME carrier
    // envelope, because the gateway identifies a command by its full envelope.
    await delivery.enqueue(command)
    const replay = await delivery.enqueue(command)
    expect(replay.replayed).toBe(true)

    // The redelivery is per delivery: the attempt counter advances and the
    // command stays ONE durable command.
    await delivery.deliver(command.commandId, { channelGeneration: 3, sequence: 7 })
    await delivery.deliver(command.commandId, { channelGeneration: 3, sequence: 8 })
    const record = await delivery.get(command.commandId)
    expect(record).toMatchObject({
      commandId: command.commandId,
      deliveryAttempts: 2,
      lastSequence: 8,
    })

    // A carrier REBUILT under the same command id is a DIFFERENT command, and
    // the real repository refuses it as a payload mismatch.
    await expect(
      delivery.enqueue(carrier({ commandId: command.commandId, sequence: command.sequence + 1 }))
    ).rejects.toMatchObject({ code: 'RUNTIME_COMMAND_PAYLOAD_MISMATCH' })
  } finally {
    // The provider holds the open database handle: it is closed BEFORE the directory is
    // removed, so the store is not deleted from under a live connection and the WAL
    // sidecars are not recreated after the cleanup. A close failure must not skip the
    // directory removal.
    try {
      provider.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})
