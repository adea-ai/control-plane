import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import {
  INTEGRATION_SHARDS,
  parseIntegrationShard,
  selectIntegrationShard,
} from '../scripts/integration-shards.mjs'

function integrationFilesUnder(directory) {
  return readdirSync(new URL(`../${directory}`, import.meta.url), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === 'integration.test.mjs' || entry.name.endsWith('.integration.test.mjs'))
    )
    .map((entry) => entry.name)
    .toSorted()
}

describe('integration shard partition', () => {
  test('every integration test file is assigned to exactly one shard', () => {
    const packages = [
      'packages/database/src',
      'packages/langgraph-adapter/src',
      'packages/profile-portability/src',
      'packages/testing/src',
      'apps/workflow-worker/src',
      'apps/control-api/src',
      'apps/hosted-control-plane/src',
    ]
    const assigned = new Map()
    for (const entry of INTEGRATION_SHARDS) {
      for (const group of entry.groups) {
        for (const file of group.files) {
          const key = `${group.package}/${file}`
          expect(assigned.has(key)).toBe(false)
          assigned.set(key, entry.shard)
        }
      }
    }
    const discovered = []
    for (const directory of packages) {
      for (const file of integrationFilesUnder(directory)) {
        discovered.push(`${directory}/${file}`)
      }
    }
    expect([...assigned.keys()].toSorted()).toEqual(discovered.toSorted())
    expect(assigned.size).toBeGreaterThan(20)
  })

  test('the packages/database monster suite anchors a shard on its own', () => {
    const shard1 = selectIntegrationShard(1)
    expect(shard1).toEqual([{ package: 'packages/database', files: ['src/integration.test.mjs'] }])
  })

  test('selectIntegrationShard rejects unknown shards and parser accepts run forms', () => {
    expect(() => selectIntegrationShard(99)).toThrow('Unknown integration shard 99')
    expect(selectIntegrationShard(2).length).toBeGreaterThan(0)
    expect(parseIntegrationShard(undefined)).toBeNull()
    expect(parseIntegrationShard('')).toBeNull()
    expect(parseIntegrationShard('2')).toBe(2)
    expect(parseIntegrationShard('3')).toBe(3)
    expect(() => parseIntegrationShard('4')).toThrow('valid shards')
    expect(() => parseIntegrationShard('one')).toThrow('valid shards')
  })
})
