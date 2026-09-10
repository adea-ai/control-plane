import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqlitePersistenceProvider } from '../packages/sqlite-persistence/src/index.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const iterations = Number(process.env.M11_SQLITE_ITERATIONS ?? 1000)
const concurrency = Number(process.env.M11_SQLITE_CONCURRENCY ?? 8)
if (
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  iterations > 10000 ||
  !Number.isSafeInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 64 ||
  concurrency > iterations
) {
  throw new Error('M11_SQLITE_BENCHMARK_CONFIGURATION_INVALID')
}

const directory = await mkdtemp(join(tmpdir(), 'm11-sqlite-benchmark-'))
const path = join(directory, 'benchmark.sqlite')
const database = new SqlitePersistenceProvider({ path })
const samples = { writeMs: [], replayReadMs: [] }
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const percentile = (values, fraction) =>
  [...values].toSorted((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]
const summarize = (values) => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: Math.max(...values),
})
const bytes = async (file) => {
  try {
    return (await stat(file)).size
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
}

let report
try {
  const startedAt = new Date().toISOString()
  const cpuBefore = process.cpuUsage()
  const rssBefore = process.memoryUsage().rss
  const migrationStarted = performance.now()
  await database.migrate()
  const migrationMs = performance.now() - migrationStarted
  const workloadStarted = performance.now()
  let next = 0
  const workers = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (next < iterations) {
        const sequence = next++
        const value = { sequence, payload: 'x'.repeat(256) }
        const writeStarted = performance.now()
        const created = await database.transaction((tx) =>
          tx.put({ namespace: 'benchmark', id: `record-${sequence}`, value })
        )
        samples.writeMs.push(performance.now() - writeStarted)
        if (created.revision !== 1) throw new Error('M11_SQLITE_BENCHMARK_REVISION_INVALID')
        const readStarted = performance.now()
        const replay = await database.transaction((tx) => tx.get('benchmark', `record-${sequence}`))
        samples.replayReadMs.push(performance.now() - readStarted)
        if (JSON.stringify(replay?.value) !== JSON.stringify(value) || replay?.revision !== 1) {
          throw new Error('M11_SQLITE_BENCHMARK_DATA_MISMATCH')
        }
      }
    })
  )
  const failure = workers.find((worker) => worker.status === 'rejected')
  if (failure) throw failure.reason
  const workloadMs = performance.now() - workloadStarted
  const walBytes = await bytes(`${path}-wal`)
  const databaseBytes = await bytes(path)
  const backupStarted = performance.now()
  const snapshot = await database.backup()
  const backupMs = performance.now() - backupStarted
  const health = await database.health()
  if (!health.ready) throw new Error('M11_SQLITE_BENCHMARK_INTEGRITY_FAILED')
  report = {
    schemaVersion: 1,
    status: 'measurement_only',
    workload: 'sqlite-durable-record-write-and-replay-read-v1',
    candidate: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0 },
    environment: {
      runtime: process.version,
      bun: process.versions.bun ?? null,
      sqlite: process.versions.sqlite ?? null,
      platform: platform(),
      release: release(),
      architecture: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
    },
    configuration: {
      iterations,
      concurrency,
      payloadBytes: 256,
      schemaVersion: health.version,
      durability: 'WAL/FULL',
      provider: 'node:sqlite',
      workloadDigest: `sha256:${createHash('sha256')
        .update(
          JSON.stringify({ iterations, payload: 'x'.repeat(256), sequence: '0..iterations-1' })
        )
        .digest('hex')}`,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    measurements: {
      migrationMs,
      workloadMs,
      logicalRecordsPerSecond: (iterations * 1000) / workloadMs,
      writeLatencyMs: summarize(samples.writeMs),
      replayReadLatencyMs: summarize(samples.replayReadMs),
      backupMs,
      backupBytes: snapshot.bytes.byteLength,
      databaseBytes,
      walBytes,
      rssBefore,
      rssAfter: process.memoryUsage().rss,
      cpuMicroseconds: process.cpuUsage(cpuBefore),
    },
    assertions: { recordsVerified: iterations, integrity: 'ok' },
    samples,
    limitations: [
      'single-process developer host',
      'not execution/API/Restate capacity',
      'no baseline comparison or approved release budgets',
      'RSS snapshots are not peak memory',
      'no live provider or infrastructure cost measurement',
    ],
  }
} finally {
  database.close()
  await rm(directory, { recursive: true, force: true })
}
console.log(JSON.stringify({ ...report, cleanup: 'complete' }))
