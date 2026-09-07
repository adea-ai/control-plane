import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
function run(iterations, concurrency) {
  return spawnSync(process.execPath, ['scripts/run-m11-sqlite-benchmark.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      M11_SQLITE_ITERATIONS: String(iterations),
      M11_SQLITE_CONCURRENCY: String(concurrency),
    },
  })
}

test('SQLite benchmark emits raw measured samples and explicitly does not certify release budgets', () => {
  const result = run(8, 2)
  expect(result.status, result.stderr).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report.status).toBe('measurement_only')
  expect(report.cleanup).toBe('complete')
  expect(report.assertions).toEqual({ recordsVerified: 8, integrity: 'ok' })
  expect(report.candidate.commit).toMatch(/^[a-f0-9]{40}$/)
  expect(report.configuration.concurrency).toBe(2)
  for (const [sample, metric] of [
    ['writeMs', 'writeLatencyMs'],
    ['replayReadMs', 'replayReadLatencyMs'],
  ]) {
    expect(report.samples[sample]).toHaveLength(8)
    expect(report.samples[sample].every((value) => Number.isFinite(value) && value >= 0)).toBe(true)
    const sorted = [...report.samples[sample]].sort((a, b) => a - b)
    expect(report.measurements[metric].p50).toBe(sorted[3])
    expect(report.measurements[metric].max).toBe(sorted[7])
  }
  expect(report.measurements.backupBytes).toBeGreaterThan(0)
  expect(report.measurements.walBytes).toBeGreaterThan(0)
  expect(report.limitations).toContain('not execution/API/Restate capacity')
})

test('SQLite benchmark rejects unbounded or invalid configuration', () => {
  for (const [iterations, concurrency] of [
    [0, 1],
    [10001, 1],
    [2, 3],
    [100, 65],
    ['NaN', 1],
  ]) {
    const result = run(iterations, concurrency)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('M11_SQLITE_BENCHMARK_CONFIGURATION_INVALID')
    expect(result.stdout).toBe('')
  }
})
