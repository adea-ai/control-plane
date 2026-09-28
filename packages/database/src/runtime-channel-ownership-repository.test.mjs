import { expect, test } from 'bun:test'
import { PostgresRuntimeChannelOwnershipRepository } from './runtime-channel-ownership-repository.ts'

const record = {
  nodeId: 'rnr_01DRZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceId: 'wsp_01DRZ3NDEKTSV4RRFFQ69G5FAV',
  gatewayInstanceId: 'gateway-test',
  connectionId: 'connection-test',
  channelGeneration: 1,
  protocolVersion: { major: 1, minor: 6 },
  connectedAt: '2026-09-28T10:00:00.000Z',
  lastHeartbeatAt: '2026-09-28T10:00:00.000Z',
}

const credentialFence = {
  credentialId: 'rgc_01DRZ3NDEKTSV4RRFFQ69G5FAV',
  revocationVersion: 1,
}

function createDatabase(current) {
  const writes = []
  const transaction = {
    execute: async () => [{ valid: false }],
    select: () => ({
      from() {
        return this
      },
      where() {
        return this
      },
      async limit() {
        return current === undefined ? [] : [current]
      },
    }),
    insert: () => ({
      values(value) {
        writes.push({ kind: 'insert', value })
        return {
          async onConflictDoUpdate() {},
        }
      },
    }),
    update: () => ({
      set(value) {
        writes.push({ kind: 'update', value })
        return {
          async where() {},
        }
      },
    }),
  }
  return {
    writes,
    database: {
      transaction: (operation) => operation(transaction),
    },
  }
}

test('PostgreSQL channel ownership rejects invalid credential fences before Hello or heartbeat writes', async () => {
  const hello = createDatabase(undefined)
  const repository = new PostgresRuntimeChannelOwnershipRepository(hello.database)
  expect(await repository.claim(record, credentialFence)).toEqual({ accepted: false })
  expect(await repository.claim(record)).toEqual({ accepted: false })
  expect(hello.writes).toEqual([])

  const heartbeat = createDatabase({
    nodeId: record.nodeId,
    workspaceId: record.workspaceId,
    generation: record.channelGeneration,
    active: true,
    record,
  })
  const heartbeatRepository = new PostgresRuntimeChannelOwnershipRepository(heartbeat.database)
  expect(
    await heartbeatRepository.heartbeat(
      { ...record, lastHeartbeatAt: '2026-09-28T10:00:01.000Z' },
      credentialFence
    )
  ).toBe(false)
  expect(
    await heartbeatRepository.heartbeat({
      ...record,
      lastHeartbeatAt: '2026-09-28T10:00:02.000Z',
    })
  ).toBe(false)
  expect(heartbeat.writes).toEqual([])
})
