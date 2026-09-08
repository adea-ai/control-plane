import { expect, test } from 'bun:test'
import { InMemoryRuntimeInventoryCheckpointRepository } from './inventory.ts'

test('inventory scan pages by stable node identity and does not expose mutable state', async () => {
  const repository = new InMemoryRuntimeInventoryCheckpointRepository()
  const records = [3, 1, 2].map((index) => ({
    runtimeNodeRefId: `rnr_01ZRZ3NDEKTSV4RRFFQ69G5FA${index}`,
    workspaceId: 'wsp_01ZRZ3NDEKTSV4RRFFQ69G5FAV',
    snapshotVersion: 1,
    snapshotDigest: `sha256:${'a'.repeat(64)}`,
    observedAt: '2026-09-08T10:00:00.000Z',
    activeRuntimeRefs: [],
    revision: 1,
  }))
  for (const record of records) await repository.compareAndSet(undefined, record)
  const first = await repository.scan({ limit: 2 })
  expect(first.map((record) => record.runtimeNodeRefId)).toEqual([
    records[1].runtimeNodeRefId,
    records[2].runtimeNodeRefId,
  ])
  first[0].revision = 999
  expect((await repository.get(first[0].runtimeNodeRefId)).revision).toBe(1)
  const last = await repository.scan({ limit: 2, afterNodeId: first[1].runtimeNodeRefId })
  expect(last).toEqual([records[0]])
  expect(await repository.scan({ limit: 2, afterNodeId: last[0].runtimeNodeRefId })).toEqual([])
})

test.each([
  { limit: 0 },
  { limit: 129 },
  { limit: 1.5 },
  { limit: 1, afterNodeId: 'bad' },
  { limit: 1, workspaceId: 'unexpected' },
])('inventory scan rejects invalid bounds and cursor: %j', async (input) => {
  await expect(new InMemoryRuntimeInventoryCheckpointRepository().scan(input)).rejects.toThrow()
})
