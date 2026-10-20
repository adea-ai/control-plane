import { describe, expect, test } from 'bun:test'

import {
  discoverTestFiles,
  e2eMeasuredSeconds,
  e2eShardCount,
  selectE2eShard,
  selectLaneFiles,
} from '../scripts/run-bun-test-group.mjs'

describe('the E2E lane shards', () => {
  test('every E2E file has a measured cost, so no file joins a shard blind', async () => {
    const files = await discoverTestFiles('e2e')
    const missing = files.filter((file) => !e2eMeasuredSeconds.has(file))
    expect(missing).toEqual([])
    // The table and the lane list are the same inventory, in both directions.
    const stale = [...e2eMeasuredSeconds.keys()].filter((file) => !files.includes(file))
    expect(stale).toEqual([])
  })

  test('the shards are disjoint and cover every E2E file exactly once', async () => {
    const files = await discoverTestFiles('e2e')
    const { shards } = selectE2eShard(files, 1)
    const assigned = shards.flat()
    expect(assigned.toSorted()).toEqual(files.toSorted())
    expect(new Set(assigned).size).toBe(assigned.length)
    expect(shards).toHaveLength(e2eShardCount)
  })

  test('the shards are balanced within a tenth of the measured total', async () => {
    const files = await discoverTestFiles('e2e')
    const { loads } = selectE2eShard(files, 1)
    const total = loads.reduce((sum, load) => sum + load, 0)
    // The shards must finish at about the same time, and neither may be empty.
    expect(Math.abs(loads[0] - loads[1])).toBeLessThan(total * 0.1)
    expect(Math.min(...loads)).toBeGreaterThan(0)
  })

  test('an unsharded run keeps every file and a sharded run keeps its own', async () => {
    const files = await discoverTestFiles('e2e')
    expect(selectLaneFiles('e2e', files, {})).toEqual(files)
    const first = selectLaneFiles('e2e', files, { E2E_TOTAL_SHARDS: '2', E2E_SHARD_INDEX: '1' })
    const second = selectLaneFiles('e2e', files, { E2E_TOTAL_SHARDS: '2', E2E_SHARD_INDEX: '2' })
    expect(first).not.toEqual(second)
    expect([...first, ...second].toSorted()).toEqual(files.toSorted())
  })

  test('a shard count the lane does not have fails closed', async () => {
    const files = await discoverTestFiles('e2e')
    expect(() =>
      selectLaneFiles('e2e', files, { E2E_TOTAL_SHARDS: '3', E2E_SHARD_INDEX: '1' })
    ).toThrow()
    expect(() =>
      selectLaneFiles('e2e', files, { E2E_TOTAL_SHARDS: '2', E2E_SHARD_INDEX: '3' })
    ).toThrow()
    expect(() =>
      selectLaneFiles('e2e', files, { E2E_TOTAL_SHARDS: '0', E2E_SHARD_INDEX: '1' })
    ).toThrow()
  })

  test('other lanes are never sharded', async () => {
    const files = await discoverTestFiles('unit')
    expect(selectLaneFiles('unit', files, { E2E_TOTAL_SHARDS: '2', E2E_SHARD_INDEX: '1' })).toEqual(
      files
    )
  })
})
