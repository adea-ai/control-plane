import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import {
  createLocalRuntimeMeasurements,
  runtimeMeasurementWorkerUrl,
} from './runtime-measurements.ts'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'

test('Bun source runs choose the source worker despite compiled output', () => {
  if (process.versions.bun !== undefined)
    assert.equal(
      runtimeMeasurementWorkerUrl().pathname,
      new URL('./runtime-measurements-worker.ts', import.meta.url).pathname
    )
})

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
      add() {
        assert.fail('observations are never counters')
      },
      record(name, value, attributes) {
        observed.push({ name, value, attributes })
      },
      recordGauge(name, value, attributes) {
        observed.push({ name, value, attributes })
      },
    },
    intervalMs: 1000,
    measurement: { workspaceId },
    now: () => new Date('2026-10-13T00:00:00.000Z'),
  })
  try {
    lifecycle.start()
    await lifecycle.sample()
    assert.equal(
      observed.some(({ name }) => name === 'storage.growth.bytes'),
      false
    )
    observed.length = 0
    await lifecycle.sample()
    assert.ok(observed.some(({ name, value }) => name === 'storage.growth.bytes' && value === 0))
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM control_plane_records').get().count,
      0
    )
    assert.equal(JSON.stringify(observed).includes(workspaceId), false)
  } finally {
    await lifecycle.close()
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects caller-provided runtime baseline and clock in measurement options', () => {
  const options = {
    databasePath: 'unused.sqlite',
    intervalMs: 1000,
    adapter: { add() {}, record() {}, recordGauge() {} },
  }
  assert.throws(() =>
    createLocalRuntimeMeasurements({
      ...options,
      measurement: { workspaceId, baselineReport: {} },
    })
  )
  assert.throws(() =>
    createLocalRuntimeMeasurements({
      ...options,
      measurement: { workspaceId, now: '2026-10-13T00:00:00.000Z' },
    })
  )
})

test('WAL sampling excludes uncommitted writes and drains an emission-triggered close before checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-measurements-wal-'))
  const databasePath = join(directory, 'control-plane.sqlite')
  const provider = new SqlitePersistenceProvider({ path: databasePath })
  const execution = (letter) => ({
    executionId: `exe_01${letter}RZ3NDEKTSV4RRFFQ69G5FAV`,
    state: 'running',
    version: 1,
    correlation: {
      workspaceId,
      projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    },
    executionPlan: {
      executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      contentDigest: `sha256:${'a'.repeat(64)}`,
      schemaVersion: 1,
    },
    attemptCount: 0,
    acceptedAt: '2026-10-12T23:00:00.000Z',
    createdAt: '2026-10-12T23:00:00.000Z',
    updatedAt: '2026-10-12T23:00:00.000Z',
  })
  const counts = []
  let closeFromEmission = false
  let closing
  let releaseWriter
  let writer
  const lifecycle = createLocalRuntimeMeasurements({
    databasePath,
    intervalMs: 1000,
    measurement: { workspaceId },
    now: () => new Date('2026-10-13T00:00:00.000Z'),
    adapter: {
      add() {
        assert.fail('observations are never counters')
      },
      record(name, value, labels) {
        if (name === 'runtime.active_object.count' && labels.object_kind === 'execution') {
          counts.push(value)
          if (closeFromEmission) closing = lifecycle.close()
        }
      },
      recordGauge() {},
    },
  })
  try {
    await provider.migrate()
    await provider.transaction((transaction) =>
      transaction.put({
        namespace: 'executions',
        id: execution('A').executionId,
        value: execution('A'),
      })
    )
    let writerReady
    const ready = new Promise((resolve) => {
      writerReady = resolve
    })
    const release = new Promise((resolve) => {
      releaseWriter = resolve
    })
    writer = provider.transaction(async (transaction) => {
      await transaction.put({
        namespace: 'executions',
        id: execution('B').executionId,
        value: execution('B'),
      })
      writerReady()
      await release
    })
    await ready
    lifecycle.start()
    await lifecycle.sample()
    assert.equal(counts.at(-1), 1)
    releaseWriter()
    await writer
    closeFromEmission = true
    await lifecycle.sample()
    assert.equal(counts.at(-1), 2)
    assert.ok(closing)
    await closing
    // Seed through the provider, avoiding the prepared-statement lifetime
    // dependency diagnosed in the already-prepared Bun checkpoint fixture fix.
    provider.close({ checkpoint: true })
    const reopened = new SqlitePersistenceProvider({ path: databasePath })
    try {
      await reopened.migrate()
      const records = await reopened.transaction((transaction) => transaction.list('executions'))
      assert.equal(records.length, 2)
    } finally {
      reopened.close()
    }
  } finally {
    releaseWriter?.()
    await writer
    await lifecycle.close()
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('built Node adapter uses its compiled worker and completes measurement before close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-measurements-node-'))
  const databasePath = join(directory, 'control-plane.sqlite')
  const provider = new SqlitePersistenceProvider({ path: databasePath })
  try {
    await provider.migrate()
    provider.close()
    const script = `
      const { pathToFileURL } = await import('node:url');
      const { createLocalRuntimeMeasurements, runtimeMeasurementWorkerUrl } = await import(pathToFileURL(process.argv[2]).href);
      if (!runtimeMeasurementWorkerUrl().pathname.endsWith('/runtime-measurements-worker.js')) throw new Error('COMPILED_WORKER_REQUIRED');
      let points = 0;
      const lifecycle = createLocalRuntimeMeasurements({ databasePath: process.argv[3], intervalMs: 1000,
        measurement: { workspaceId: '${workspaceId}' },
        adapter: { add() { throw new Error('COUNTER_FORBIDDEN'); }, record() { points++; }, recordGauge() { points++; } }
      });
      lifecycle.start(); await lifecycle.sample(); await lifecycle.close();
      if (points === 0) throw new Error('MEASUREMENT_REQUIRED');
      process.stdout.write('COMPILED_WORKER_OK');
    `
    const scriptPath = join(directory, 'compiled-worker-smoke.mjs')
    await writeFile(scriptPath, script)
    const result = await promisify(execFile)(
      'node',
      [
        scriptPath,
        fileURLToPath(new URL('../dist/runtime-measurements.js', import.meta.url)),
        databasePath,
      ],
      { timeout: 10000 }
    )
    assert.equal(result.stdout, 'COMPILED_WORKER_OK')
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
