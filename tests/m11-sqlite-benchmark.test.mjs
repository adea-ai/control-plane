import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
function run(iterations, concurrency, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'm11-benchmark-test-'))
  let result
  try {
    result = spawnSync(process.execPath, options.args ?? ['scripts/run-m11-sqlite-benchmark.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: options.timeout ?? 15000,
      detached: true,
      env: {
        ...process.env,
        TMPDIR: directory,
        TMP: directory,
        TEMP: directory,
        M11_SQLITE_ITERATIONS: String(iterations),
        M11_SQLITE_CONCURRENCY: String(concurrency),
      },
    })
    return { ...result, fixtureDirectory: directory }
  } finally {
    try {
      if (result?.pid > 0) killGroup(result.pid)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

test('benchmark test runner removes its owned temporary tree after a child timeout', () => {
  const result = run(8, 2, {
    timeout: 1000,
    args: [
      '-e',
      "require('node:fs').mkdirSync(require('node:path').join(require('node:os').tmpdir(), 'partial-database')); console.log('fixture-created'); setInterval(() => {}, 1000)",
    ],
  })
  expect(result.error?.code).toBe('ETIMEDOUT')
  expect(result.stdout).toContain('fixture-created')
  expect(existsSync(result.fixtureDirectory)).toBe(false)
})

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
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
    const sorted = [...report.samples[sample]].toSorted((a, b) => a - b)
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
