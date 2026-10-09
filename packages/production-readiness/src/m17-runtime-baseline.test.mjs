import { beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))

const REQUIRED_ISSUE_LAYERS = [
  'custom-runtime',
  'restate',
  'transports',
  'auth',
  'policy',
  'billing',
  'artifacts',
  'device-supervision',
]

let evidenceDirectory
let report
let summary

beforeAll(async () => {
  evidenceDirectory = await mkdtemp(join(tmpdir(), 'm17-baseline-evidence-'))
  const outPath = join(evidenceDirectory, 'report.json')
  const result = spawnSync(
    process.execPath,
    ['scripts/m17-runtime-baseline.mjs', '--out', outPath],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 180_000,
      env: {
        ...process.env,
        M17_QUEUE_ITERATIONS: '2',
        M17_OBJECT_ITERATIONS: '2',
        M17_LEDGER_ITERATIONS: '2',
        M17_POLICY_ITERATIONS: '2',
        M17_IMPORT_PROBES: '0',
      },
    }
  )
  if (result.status !== 0) {
    throw new Error(
      `m17-runtime-baseline.mjs failed (${result.status}): ${result.stderr?.slice(0, 2000)}`
    )
  }
  summary = JSON.parse(result.stdout)
  report = JSON.parse(await readFile(outPath, 'utf8'))
})

afterAll(async () => {
  if (evidenceDirectory) await rm(evidenceDirectory, { recursive: true, force: true })
})

describe('M17 runtime ownership baseline tooling (#941)', () => {
  test('measures every #941 keep/replace/retire area plus both Pi adapter surfaces', () => {
    const ids = report.layers.map((layer) => layer.id)
    for (const required of REQUIRED_ISSUE_LAYERS) {
      expect(ids).toContain(required)
    }
    expect(ids).toContain('pi-durable-node-adapter')
    expect(ids).toContain('pi-cloudflare-host')
    expect(new Set(ids).size).toBe(ids.length)
    expect(report.layers.length).toBe(10)
    expect(summary.status).toBe('candidate-baseline-unaccepted')
    expect(summary.layers).toBe(10)
    expect(summary.out).toBe(join(evidenceDirectory, 'report.json'))

    for (const layer of report.layers) {
      expect(layer.fileCount).toBeGreaterThan(0)
      expect(layer.complexity.sourceFiles).toBeGreaterThan(0)
      expect(layer.complexity.sourceLines).toBeGreaterThan(0)
      expect(layer.importProbe.status).toBe('skipped')
      expect(layer.importProbe.reason).toContain('M17_IMPORT_PROBES=0')
    }
  })

  test('emits a candidate report that states no accepted/published #941 baseline exists', () => {
    expect(report.schemaVersion).toBe(1)
    expect(report.issue).toBe(941)
    expect(report.status).toBe('candidate-baseline-unaccepted')
    expect(report.acceptedPublishedBaseline).toBeNull()
    expect(report.baselineStatement).toContain(
      'No adea-ai/control-plane#941 accepted or published baseline exists yet'
    )
    expect(report.candidate.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(report.configuration.writePolicy).toContain('temp-only')
    expect(report.tool).toBe('scripts/m17-runtime-baseline.mjs')

    // Disjointness is enforced inside the tool (overlap throws M17_LAYER_OVERLAP);
    // coupling records only cross-layer edges.
    for (const [id, edge] of Object.entries(report.coupling)) {
      expect(edge.targets[id]).toBeUndefined()
      expect(edge.total).toBe(Object.values(edge.targets).reduce((sum, count) => sum + count, 0))
    }
  })

  test('measures all four local probes on disposable state', () => {
    expect(report.probes.length).toBe(4)
    expect(summary.probes.map((probe) => probe.status)).toEqual([
      'measured',
      'measured',
      'measured',
      'measured',
    ])
    expect(report.probes.map((probe) => probe.id)).toEqual([
      'local-embedded-sqlite-queue-round-trip',
      'local-filesystem-object-put-get',
      'local-durable-usage-ledger-reserve',
      'in-process-policy-authorize',
    ])
    for (const probe of report.probes) {
      expect(probe.status).toBe('measured')
      const summaries = Object.values(probe.latencyMs)
      expect(summaries.length).toBeGreaterThan(0)
      for (const stats of summaries) {
        expect(stats.samples).toBeGreaterThanOrEqual(1)
        expect(stats.p50Ms).toBeGreaterThanOrEqual(0)
        expect(stats.p95Ms).toBeGreaterThanOrEqual(0)
      }
      expect(probe.notes.length).toBeGreaterThan(0)
    }
  })

  test('labels every unmeasured cost as unavailable with an explicit reason', () => {
    const costs = report.unavailableCosts.map((entry) => entry.cost)
    expect(report.unavailableCosts.length).toBeGreaterThanOrEqual(5)
    expect(costs.some((cost) => cost.includes('Restate'))).toBe(true)
    expect(costs.some((cost) => cost.includes('Managed-cloud operational cost'))).toBe(true)
    expect(costs.some((cost) => cost.includes('Cloudflare'))).toBe(true)
    expect(costs.some((cost) => cost.includes('model-provider'))).toBe(true)
    expect(costs.some((cost) => cost.includes('Physical RuntimeNode device'))).toBe(true)
    for (const entry of report.unavailableCosts) {
      expect(entry.status).toBe('unavailable')
      expect(entry.reason.length).toBeGreaterThan(20)
    }
    expect(report.limitations.length).toBeGreaterThan(0)
  })
})
