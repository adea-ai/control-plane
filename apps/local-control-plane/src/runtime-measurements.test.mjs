import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createLocalRuntimeMeasurements } from './runtime-measurements.ts'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'

test('SQLite runtime observations preserve the store and retain a true storage baseline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-measurements-'))
  const databasePath = join(directory, 'control-plane.sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec(`CREATE TABLE control_plane_records (
    namespace TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
    value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (namespace, id)
  ) STRICT`)
  const observed = []
  const lifecycle = createLocalRuntimeMeasurements({
    databasePath,
    adapter: {
      add() { assert.fail('observations are never counters') },
      record(name, value, attributes) { observed.push({ name, value, attributes }) },
      recordGauge(name, value, attributes) { observed.push({ name, value, attributes }) },
    },
    intervalMs: 1000,
    measurement: { workspaceId },
    now: () => new Date('2026-10-13T00:00:00.000Z'),
  })
  try {
    lifecycle.start()
    await lifecycle.sample()
    assert.equal(observed.some(({ name }) => name === 'storage.growth.bytes'), false)
    observed.length = 0
    await lifecycle.sample()
    assert.ok(observed.some(({ name, value }) => name === 'storage.growth.bytes' && value === 0))
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM control_plane_records').get().count, 0)
    assert.equal(JSON.stringify(observed).includes(workspaceId), false)
  } finally {
    await lifecycle.close()
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects caller-provided runtime baseline and clock in measurement options', () => {
  const options = {
    databasePath: 'unused.sqlite', intervalMs: 1000,
    adapter: { add() {}, record() {}, recordGauge() {} },
  }
  assert.throws(() => createLocalRuntimeMeasurements({
    ...options, measurement: { workspaceId, baselineReport: {} },
  }))
  assert.throws(() => createLocalRuntimeMeasurements({
    ...options, measurement: { workspaceId, now: '2026-10-13T00:00:00.000Z' },
  }))
})
