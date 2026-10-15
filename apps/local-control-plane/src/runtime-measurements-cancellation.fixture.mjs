// Test-only Node process: observe real worker termination and a retained baseline across an abort.
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate as nextTurn } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const threads = require('node:worker_threads')
const NativeWorker = threads.Worker
const workers = []
let holdNext = false
let holdReadNext = false

class ObservedWorker extends NativeWorker {
  constructor(url, options) {
    const hold = holdNext
    holdNext = false
    const holdRead = holdReadNext
    holdReadNext = false
    const gate = new SharedArrayBuffer(4)
    // Execute the actual compiled measurement worker, then hold its completed result before exit.
    // This makes cancellation independent of machine speed and worker startup duration.
    const bootstrap = `
      import { workerData } from 'node:worker_threads';
      if (workerData.fixtureHoldRead) {
        const { createRequire, syncBuiltinESMExports } = await import('node:module');
        const sqlite = createRequire(workerData.fixtureEntrypoint)('node:sqlite');
        const NativeDatabase = sqlite.DatabaseSync;
        let held = false;
        sqlite.DatabaseSync = class extends NativeDatabase {
          prepare(query) {
            const statement = super.prepare(query);
            const all = statement.all.bind(statement);
            statement.all = (...parameters) => {
              const rows = all(...parameters);
              if (!held) {
                held = true;
                const gate = new Int32Array(workerData.fixtureGate);
                Atomics.store(gate, 0, 1);
                Atomics.notify(gate, 0);
                Atomics.wait(gate, 0, 1);
              }
              return rows;
            };
            return statement;
          }
        };
        syncBuiltinESMExports();
      }
      await import(workerData.fixtureEntrypoint);
      if (workerData.fixtureHold) Atomics.wait(new Int32Array(workerData.fixtureGate), 0, 0);
    `
    super(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
      ...options,
      workerData: {
        ...options.workerData,
        fixtureEntrypoint: url.href,
        fixtureHold: hold,
        fixtureHoldRead: holdRead,
        fixtureGate: gate,
      },
    })
    this.terminations = 0
    this.gate = gate
    this.result = Promise.withResolvers()
    this.exited = Promise.withResolvers()
    this.once('message', this.result.resolve)
    this.once('exit', this.exited.resolve)
    workers.push(this)
  }

  terminate() {
    this.terminations += 1
    return super.terminate()
  }
}

threads.Worker = ObservedWorker
syncBuiltinESMExports()
const { createLocalRuntimeMeasurements } = await import('../dist/runtime-measurements.js')
const database = new DatabaseSync(process.argv[2])
const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const at = '2026-10-13T00:00:00.000Z'
const seed = (letter) => {
  const executionId = `exe_01${letter}RZ3NDEKTSV4RRFFQ69G5FAV`
  const value = {
    executionId,
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
    acceptedAt: at,
    createdAt: at,
    updatedAt: at,
  }
  database
    .prepare('INSERT INTO control_plane_records VALUES (?, ?, ?, ?, ?)')
    .run('executions', executionId, 1, JSON.stringify(value), at)
}
const observed = []
const record = (name, value, labels) => observed.push({ name, value, labels })
const total = (points, name) =>
  points.find((point) => point.name === name && point.labels?.namespace === 'total')?.value
const lifecycle = createLocalRuntimeMeasurements({
  databasePath: process.argv[2],
  adapter: { add: record, record, recordGauge: record },
  intervalMs: 3_600_000,
  measurement: { workspaceId },
  now: () => new Date(at),
  passTimeoutMs: 2000,
  closeTimeoutMs: 50,
})

try {
  seed('A')
  lifecycle.start()
  await lifecycle.sample()
  const first = total(observed, 'storage.retained.bytes')
  assert.ok(first > 0)
  assert.equal(total(observed, 'storage.growth.bytes'), undefined)
  observed.length = 0

  seed('B')
  holdNext = true
  const pending = lifecycle.sample()
  await Promise.resolve()
  assert.equal(workers.length, 2)
  const held = workers.at(-1)
  const message = await held.result.promise
  assert.equal(message.ok, true)
  const abandoned = total(message.result.points, 'storage.retained.bytes')
  assert.ok(abandoned > first)
  assert.ok(held.threadId > 0)
  await pending
  assert.equal(held.terminations, 1)
  await held.exited.promise
  assert.equal(held.threadId, -1)
  await nextTurn()
  assert.deepEqual(observed, [])

  seed('C')
  await lifecycle.sample()
  assert.equal(workers.length, 3)
  const final = total(observed, 'storage.retained.bytes')
  const growth = total(observed, 'storage.growth.bytes')
  assert.ok(final > abandoned)
  assert.equal(growth, final - first)
  assert.notEqual(growth, final - abandoned)

  // Hold a real read transaction after its first SELECT, while the worker still owns SQLite.
  // A later writer prevents WAL truncation until abort terminates the worker and releases it.
  observed.length = 0
  holdReadNext = true
  const reading = lifecycle.sample()
  await Promise.resolve()
  const reader = workers.at(-1)
  const gate = new Int32Array(reader.gate)
  await Atomics.waitAsync(gate, 0, 0).value
  assert.equal(Atomics.load(gate, 0), 1)
  seed('D')
  database.exec('PRAGMA busy_timeout = 0')
  assert.equal(database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 1)
  await reading
  assert.equal(reader.terminations, 1)
  await reader.exited.promise
  await nextTurn()
  assert.equal(reader.threadId, -1)
  assert.equal(database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0)
  assert.deepEqual(observed, [])
  await lifecycle.close()
  process.stdout.write(
    JSON.stringify({
      terminations: held.terminations,
      readerTerminations: reader.terminations,
      first,
      abandoned,
      final,
      growth,
    })
  )
} finally {
  await lifecycle.close()
  // A mutation that removes production termination must still clean up its deliberately held worker.
  await Promise.all(
    workers
      .filter((worker) => worker.threadId !== -1)
      .map((worker) => NativeWorker.prototype.terminate.call(worker))
  )
  threads.Worker = NativeWorker
  syncBuiltinESMExports()
  database.close()
}
