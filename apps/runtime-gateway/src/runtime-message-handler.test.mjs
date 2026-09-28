import { describe, expect, test } from 'bun:test'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
import { RuntimeGatewayMessageRouter } from './runtime-message-handler.js'

const source = {
  nodeId: golden.command.nodeId,
  workspaceId: golden.command.workspaceId,
  gatewayInstanceId: 'gateway-a',
  connectionId: 'gwc-a',
  channelGeneration: 1,
  protocolVersion: { major: 1, minor: 5 },
  connectedAt: '2026-08-25T12:00:00.000Z',
  lastHeartbeatAt: '2026-08-25T12:00:00.000Z',
}

describe('Runtime Gateway production message routing', () => {
  test.each(['terminal_conflict', 'out_of_order', 'conflict'])(
    'does not settle the command ledger for %s terminal effects',
    async (outcome) => {
      const calls = []
      const router = new RuntimeGatewayMessageRouter({
        channelAuthority: { isActive: async () => true },
        inventory: { handle: async () => undefined },
        delivery: {
          acknowledge: async () => undefined,
          recordResult: async () => calls.push('result'),
          recordError: async () => calls.push('error'),
        },
        events: {
          ingestProgress: async () => ({ outcome }),
          ingestResult: async () => ({ outcome }),
          ingestError: async () => ({ outcome }),
        },
      })
      await router.handle(source, golden.result)
      await router.handle(source, golden.error)
      expect(calls).toEqual([])
    }
  )
  test('routes inventory, acknowledgement, progress, result, and error frames in durable order', async () => {
    const calls = []
    const router = new RuntimeGatewayMessageRouter({
      channelAuthority: { isActive: async () => true },
      inventory: { handle: async () => calls.push('inventory') },
      delivery: {
        acknowledge: async () => calls.push('ack'),
        recordResult: async (_frame, reference) => calls.push(`record:${reference ?? 'inline'}`),
        recordError: async () => calls.push('record:error'),
      },
      events: {
        ingestProgress: async () => calls.push('progress'),
        ingestResult: async () => {
          calls.push('result')
          return { outcome: 'applied' }
        },
        ingestError: async () => {
          calls.push('error')
          return { outcome: 'applied' }
        },
      },
    })
    const artifactResult = {
      ...golden.result,
      result: {
        artifact: {
          artifactId: 'art_01JABCDEF0123456789ABCDEFG',
          digest: `sha256:${'a'.repeat(64)}`,
          mediaType: 'application/json',
          sizeBytes: 10,
        },
      },
    }

    await router.handle(source, golden.inventory)
    await router.handle(source, golden.ack)
    await router.handle(source, golden.progress)
    await router.handle(source, golden.result)
    await router.handle(source, artifactResult)
    await router.handle(source, golden.error)

    expect(calls).toEqual([
      'inventory',
      'ack',
      'progress',
      'result',
      'record:inline',
      'result',
      'record:art_01JABCDEF0123456789ABCDEFG',
      'error',
      'record:error',
    ])
  })

  test('rejects inventory frames when durable channel authority is revoked', async () => {
    const calls = []
    const router = new RuntimeGatewayMessageRouter({
      channelAuthority: { isActive: async () => false },
      inventory: { handle: async () => calls.push('inventory') },
      delivery: {
        acknowledge: async () => undefined,
        recordResult: async () => undefined,
        recordError: async () => undefined,
      },
      events: {
        ingestProgress: async () => undefined,
        ingestResult: async () => undefined,
        ingestError: async () => undefined,
      },
    })

    await expect(router.handle(source, golden.inventory)).rejects.toThrow(
      'RUNTIME_GATEWAY_INVENTORY_AUTHORIZATION_DENIED'
    )
    expect(calls).toEqual([])
  })

  test('rejects frame families owned by lifecycle or the server side', async () => {
    const router = new RuntimeGatewayMessageRouter({
      channelAuthority: { isActive: async () => true },
      inventory: { handle: async () => undefined },
      delivery: {
        acknowledge: async () => undefined,
        recordResult: async () => undefined,
        recordError: async () => undefined,
      },
      events: {
        ingestProgress: async () => undefined,
        ingestResult: async () => undefined,
        ingestError: async () => undefined,
      },
    })

    await expect(router.handle(source, golden.command)).rejects.toThrow(
      'RUNTIME_GATEWAY_FRAME_UNSUPPORTED'
    )
    await expect(router.handle(source, golden.heartbeat)).rejects.toThrow(
      'RUNTIME_GATEWAY_FRAME_UNSUPPORTED'
    )
  })
})
