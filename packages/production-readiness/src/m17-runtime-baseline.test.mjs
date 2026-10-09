import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyImportProbeChild,
  measureCoupling,
  safeFailureReason,
} from './runtime-baseline-analysis.ts'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const CONTROLLER_CANARY = 'm17-controller-canary-9f3a2b'

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

function runCli(env) {
  return spawnSync(process.execPath, ['scripts/m17-runtime-baseline.mjs'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...env },
  })
}

const boundedReason = /^[A-Z][A-Z0-9_]{1,63}$/

let evidenceDirectory
let report
let summary
let failureReport
let failureStdout

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
        CONTROLLER: CONTROLLER_CANARY,
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

  // Forced failure boundary: an unusable TMPDIR makes every temp-directory
  // probe fail, so the export itself must carry only bounded reason codes.
  const failure = runCli({
    CONTROLLER: CONTROLLER_CANARY,
    TMPDIR: join(evidenceDirectory, 'missing-tmp'),
    M17_QUEUE_ITERATIONS: '1',
    M17_OBJECT_ITERATIONS: '1',
    M17_LEDGER_ITERATIONS: '1',
    M17_POLICY_ITERATIONS: '1',
    M17_IMPORT_PROBES: '0',
  })
  failureStdout = failure.stdout ?? ''
  failureReport = failureStdout.length > 0 ? JSON.parse(failureStdout) : null
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

  test('scopes the candidate statement to this run and documents the real write policy', () => {
    expect(report.schemaVersion).toBe(1)
    expect(report.issue).toBe(941)
    expect(report.status).toBe('candidate-baseline-unaccepted')
    // Run-scoped only: the tool must not assert repository-wide baseline absence.
    expect(report.acceptedPublishedBaseline).toBeUndefined()
    expect(report.baselineStatement).toContain('This run is a candidate measurement')
    expect(report.baselineStatement).toContain('asserts nothing about baselines elsewhere')
    expect(report.baselineStatement).not.toContain('exists yet')

    expect(report.configuration.writePolicy).toContain('probe state: disposable os.tmpdir()')
    expect(report.configuration.writePolicy).toContain('--out')
    expect(report.candidate.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(report.tool).toBe('scripts/m17-runtime-baseline.mjs')

    // Ambient environment values must not be copied into the export.
    expect(report.environment).not.toHaveProperty('controller')
    expect(JSON.stringify(report)).not.toContain(CONTROLLER_CANARY)

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

  test('resolves exact coupling edges: package subpaths, .js->.ts, test exclusion', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'm17-coupling-fixture-'))
    try {
      const files = {
        'packages/tool-sdk/src/emitter.ts': 'export const emitter = 1\n',
        'packages/alpha/src/a.ts': [
          "import '@control-plane/tool-sdk/emitter'",
          "import '@control-plane/tool-sdk'",
          "import './b.js'",
          "import '../shared/notes.js'",
          '',
        ].join('\n'),
        'packages/alpha/src/a.test.mjs': "import '@control-plane/tool-sdk'\n",
        'packages/alpha/src/b.ts': 'export const b = 1\n',
        'packages/alpha/shared/notes.ts': 'export const notes = 1\n',
      }
      for (const [relative, contents] of Object.entries(files)) {
        const path = join(fixtureRoot, relative)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, contents, 'utf8')
      }
      const edges = await measureCoupling(
        [
          { id: 'alpha', files: ['packages/alpha/src/a.ts', 'packages/alpha/src/a.test.mjs'] },
          { id: 'beta', files: ['packages/alpha/src/b.ts', 'packages/alpha/shared/notes.ts'] },
          { id: 'sdk', files: ['packages/tool-sdk/src/emitter.ts'] },
        ],
        fixtureRoot
      )
      // exact edges: 2 package edges (plain + subpath) and 2 .js->.ts edges;
      // the .test.mjs import is excluded (sdk would be 3 if it were counted).
      expect(edges.alpha).toEqual({ targets: { sdk: 2, beta: 2 }, total: 4 })
      expect(edges.sdk).toEqual({ targets: {}, total: 0 })
      expect(edges.beta).toEqual({ targets: {}, total: 0 })
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  test('bounds failure reasons and classifies import-probe children without raw content', () => {
    expect(safeFailureReason(new Error('USAGE_LEDGER_SCOPE_MISMATCH'))).toBe(
      'USAGE_LEDGER_SCOPE_MISMATCH'
    )
    expect(safeFailureReason(new Error('M17_QUEUE_CLAIM_EMPTY'))).toBe('M17_QUEUE_CLAIM_EMPTY')
    expect(
      safeFailureReason(new Error("ENOENT: no such file or directory, open '/tmp/secret-path'"))
    ).toBe('UNCLASSIFIED_ERROR')
    expect(safeFailureReason('controller token m17-canary-9f3a2b')).toBe('UNCLASSIFIED_ERROR')
    expect(safeFailureReason(undefined)).toBe('UNCLASSIFIED_ERROR')
    expect(safeFailureReason({ message: 'object shaped error' })).toBe('UNCLASSIFIED_ERROR')

    expect(
      classifyImportProbeChild({ error: new Error('spawn ENOENT /Users/someone/secret') })
    ).toEqual({ status: 'unavailable', reason: 'IMPORT_CHILD_SPAWN_FAILED' })
    expect(classifyImportProbeChild({ status: 1, stdout: '' })).toEqual({
      status: 'unavailable',
      reason: 'IMPORT_CHILD_EXITED',
    })
    expect(
      classifyImportProbeChild({ status: 0, stdout: 'bun: raw stack /Users/someone/secret' })
    ).toEqual({ status: 'unavailable', reason: 'IMPORT_OUTPUT_UNPARSEABLE' })
    expect(
      classifyImportProbeChild({
        status: 0,
        stdout: JSON.stringify({
          status: 'unavailable',
          reason: "Cannot find module '/Users/someone/leak.js'",
        }),
      })
    ).toEqual({ status: 'unavailable', reason: 'UNCLASSIFIED_ERROR' })
    expect(
      classifyImportProbeChild({
        status: 0,
        stdout: JSON.stringify({ status: 'measured', importMs: 'not-a-number' }),
      })
    ).toEqual({ status: 'unavailable', reason: 'IMPORT_OUTPUT_INVALID' })
    expect(
      classifyImportProbeChild({
        status: 0,
        stdout: JSON.stringify({
          status: 'measured',
          importMs: 1.5,
          rssBeforeBytes: 100,
          rssAfterBytes: 200,
        }),
      })
    ).toEqual({
      status: 'measured',
      importMs: 1.5,
      rssBeforeBytes: 100,
      rssAfterBytes: 200,
    })
  })

  test('exports only bounded reason codes when probes fail end to end', () => {
    expect(failureReport).not.toBeNull()
    expect(failureReport.probes.length).toBe(4)
    const unavailable = failureReport.probes.filter((probe) => probe.status === 'unavailable')
    expect(unavailable.length).toBeGreaterThanOrEqual(3)
    for (const probe of unavailable) {
      expect(probe.reason).toMatch(boundedReason)
    }
    expect(failureStdout).not.toContain('ENOENT')
    expect(failureStdout).not.toContain('no such file')
    expect(failureStdout).not.toContain(CONTROLLER_CANARY)
    expect(failureReport.environment).not.toHaveProperty('controller')
  })
})
