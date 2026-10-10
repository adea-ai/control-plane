import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CLIENT_BUNDLE_BUDGETS } from './client-bundle-budgets.mjs'
import {
  AXE_TAGS,
  INVENTORY_PATH,
  MEASUREMENTS_PATH,
  ROOT,
  buildMeasurements,
  bundleBudget,
  bundleStatus,
  evaluateBundle,
  headRevision,
  inventoryErrors,
  probeFiles,
  runUnit,
  summarizeAxe,
  unitVerdict,
} from './readiness-evidence.mjs'

const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const existsAll = () => true
const RECORDED_PATH = join(ROOT, 'docs/evidence/m18-1224-recorded-runs-2026-10-10.json')
const BUNDLE_PATH = join(ROOT, 'docs/evidence/m18-1224-client-bundle-main-2026-10-10.json')
const AUDIT_PATH = join(ROOT, 'scripts/audit-a11y-dev-view.mjs')
const VERDICT_STATUSES = ['pass', 'fail', 'partial', 'invalid', 'present', 'absent']
const CHECK_BUNDLE = 'bun run --cwd apps/web start:check-bundle'
const AUDIT = 'bun scripts/audit-a11y-dev-view.mjs --base-url http://127.0.0.1:3217 --strict'

type Json = Record<string, unknown>
type Impact = 'critical' | 'serious' | 'moderate' | 'minor'

function git(cwd: string, args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid', ...args],
    { cwd, encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function commit(cwd: string, files: Record<string, string>, message: string) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-q', '-m', message])
  return git(cwd, ['rev-parse', 'HEAD'])
}

function bundleReport(overrides: Json = {}): Json {
  const total = CLIENT_BUNDLE_BUDGETS.total
  const startup = CLIENT_BUNDLE_BUDGETS.startup
  const chat = CLIENT_BUNDLE_BUDGETS.views.chat
  return {
    clientJavaScriptBytes: total.rawBytes,
    clientJavaScriptGzipBytes: total.gzipBytes,
    clientJavaScriptFiles: total.fileCount,
    startup: { rawBytes: startup.rawBytes, gzipBytes: startup.gzipBytes, fileCount: 1 },
    views: { chat: { rawBytes: chat.rawBytes, gzipBytes: chat.gzipBytes, fileCount: 1 } },
    ...overrides,
  }
}

const AUDIT_SURFACES = [
  'chat',
  'dev-view-terminal',
  'dev-view-narrow-320',
  'settings/account-and-app',
]
const zero = () => ({ critical: 0, serious: 0, moderate: 0, minor: 0 })
const surfaceEntries = (names: string[], counts = zero(), violations: Json[] = []) =>
  names.map((surface) => ({
    surface,
    url: 'http://127.0.0.1:3217/?view=chat',
    counts,
    violations,
  }))

/** A complete strict audit artifact with no violations, shaped as scripts/audit-a11y-dev-view.mjs writes it. */
function auditArtifact(overrides: Json = {}): Json {
  return {
    schemaVersion: 1,
    lane: 'audit-a11y-dev-view',
    issue: '#426/#541',
    standard:
      'WCAG 2.2 AA (automated axe-core coverage; manual assistive-technology audit out of scope)',
    tags: [...AXE_TAGS],
    axeVersion: '4.11.0',
    baseUrl: 'http://127.0.0.1:3217',
    startedAt: '2026-10-10T10:00:00.000Z',
    completedAt: '2026-10-10T10:02:00.000Z',
    surfaces: surfaceEntries(AUDIT_SURFACES),
    totals: zero(),
    violationClasses: [],
    strict: true,
    blockingViolations: 0,
    ...overrides,
  }
}

/** A complete artifact with one violation of `nodeCount` nodes at `impact` on the chat surface. */
function withViolation(impact: Impact, nodeCount: number): Json {
  const counts = { ...zero(), [impact]: nodeCount }
  const violation = {
    id: 'color-contrast',
    impact,
    help: 'Elements must meet minimum color contrast',
    wcag: ['wcag2aa'],
    nodes: [{ target: ['.label'], html: '<span class="label">x</span>' }],
    nodeCount,
  }
  const surfaces = AUDIT_SURFACES.map((surface) =>
    surface === 'chat'
      ? { surface, url: 'http://127.0.0.1:3217/?view=chat', counts, violations: [violation] }
      : { surface, url: 'http://127.0.0.1:3217/?view=chat', counts: zero(), violations: [] }
  )
  const blocking = impact === 'critical' || impact === 'serious' ? nodeCount : 0
  return auditArtifact({ surfaces, totals: counts, blockingViolations: blocking })
}

const tinyCriterion = (id: string, category: string, method: Json) => ({
  id,
  category,
  source: 'test',
  criterion: 'test',
  method,
})

function tinyInventory() {
  return {
    schemaVersion: 1,
    issue: '#1224',
    probes: {},
    criteria: [
      tinyCriterion('PERF-01', 'performance', { kind: 'bundle', keys: ['total'] }),
      tinyCriterion('ACC-01', 'accessibility', { kind: 'axe' }),
      tinyCriterion('ACC-02', 'accessibility', { kind: 'e2e' }),
      tinyCriterion('ACC-05', 'accessibility', {
        kind: 'unit',
        files: ['packages/ui/tests/a.test.ts'],
      }),
      tinyCriterion('OPS-10', 'operations', { kind: 'recorded-run' }),
    ],
  }
}

const at = (status: string) => ({ key: 'total', status })

describe('readiness inventory', () => {
  test('the committed inventory is valid and names every criterion once', () => {
    expect(inventoryErrors(inventory)).toEqual([])
    const ids = inventory.criteria.map((criterion: { id: string }) => criterion.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThan(30)
  })

  test('validation refuses duplicate ids, mismatched categories and gaps without a reason', () => {
    const duplicate = clone(inventory)
    duplicate.criteria.push(clone(duplicate.criteria[0]))
    expect(inventoryErrors(duplicate).join('\n')).toContain('duplicate id')

    const mismatched = clone(inventory)
    mismatched.criteria[0].category = 'cost'
    expect(inventoryErrors(mismatched).join('\n')).toContain('category must match its id prefix')

    const unexplained = clone(inventory)
    const gap = unexplained.criteria.find(
      (criterion: { method: { kind: string } }) => criterion.method.kind === 'unavailable'
    )
    delete gap.method.reason
    expect(inventoryErrors(unexplained).join('\n')).toContain('unavailable needs a reason')
  })

  test('validation refuses unknown probes, bundle keys, unit files and method kinds', () => {
    const broken = clone(inventory)
    broken.criteria[0].method = { kind: 'presence', probes: ['no-such-probe'] }
    broken.criteria[1].method = { kind: 'bundle', keys: ['views.no-such-route'] }
    broken.criteria[2].method = { kind: 'certified', reason: 'x' }
    const errors = inventoryErrors(broken).join('\n')
    expect(errors).toContain('unknown probe no-such-probe')
    expect(errors).toContain('unknown bundle key views.no-such-route')
    expect(errors).toContain('unknown method kind certified')

    const missingFile = inventoryErrors(inventory, { fileExists: () => false }).join('\n')
    expect(missingFile).toContain('does not exist')
    expect(inventoryErrors(inventory, { fileExists: existsAll })).toEqual([])
  })

  test('the committed measurements carry the same inventory hash and never certify a gap', () => {
    const measurements = JSON.parse(readFileSync(MEASUREMENTS_PATH, 'utf8'))
    const hash = createHash('sha256').update(readFileSync(INVENTORY_PATH)).digest('hex')
    expect(measurements.inventorySha256).toBe(hash)
    expect(measurements.results.map((entry: { id: string }) => entry.id)).toEqual(
      inventory.criteria.map((criterion: { id: string }) => criterion.id)
    )
    for (const entry of measurements.results) {
      if (['not-measured', 'unavailable', 'not-claimed'].includes(entry.kind)) {
        expect(entry.status).toBe(entry.kind)
        expect(entry.status).not.toBe('pass')
      }
    }
    expect(JSON.stringify(measurements)).not.toContain('"certified"')
  })
})

describe('bundle budgets', () => {
  test('bundle keys resolve to the ceilings in the client budget module', () => {
    expect(bundleBudget('total')).toBe(CLIENT_BUNDLE_BUDGETS.total)
    expect(bundleBudget('startup')).toBe(CLIENT_BUNDLE_BUDGETS.startup)
    expect(bundleBudget('views.chat')).toBe(CLIENT_BUNDLE_BUDGETS.views.chat)
    expect(bundleBudget('views.missing')).toBeUndefined()
  })

  test('a report at the ceiling passes and one raw byte over fails with that check named', () => {
    const atLimit = evaluateBundle(bundleReport(), ['total', 'startup', 'views.chat'])
    expect(atLimit.map((entry) => entry.status)).toEqual(['pass', 'pass', 'pass'])
    expect(atLimit[0].headroom.rawBytes).toBe(0)

    const over = evaluateBundle(
      bundleReport({ clientJavaScriptBytes: CLIENT_BUNDLE_BUDGETS.total.rawBytes + 1 }),
      ['total']
    )
    expect(over[0].status).toBe('fail')
    expect(over[0].failing).toEqual(['rawBytes'])
  })

  test('a metric the report does not carry is not-run, and a malformed one is invalid', () => {
    const missing = bundleReport()
    delete missing.clientJavaScriptGzipBytes
    expect(evaluateBundle(missing, ['total'])[0]).toMatchObject({
      status: 'not-run',
      missing: ['gzipBytes'],
    })
    for (const bad of [Number.NaN, -1, '3051665', 1.5, Number.POSITIVE_INFINITY, null]) {
      const [entry] = evaluateBundle(bundleReport({ clientJavaScriptBytes: bad }), ['total'])
      expect(entry.status).toBe('invalid')
    }
    expect(evaluateBundle({ ...bundleReport(), startup: undefined }, ['startup'])[0].status).toBe(
      'not-run'
    )
  })

  test('overall bundle status: invalid beats not-run, which beats fail, which beats pass', () => {
    expect(bundleStatus([at('pass'), at('pass')])).toBe('pass')
    expect(bundleStatus([at('pass'), at('fail')])).toBe('fail')
    expect(bundleStatus([at('fail'), at('not-run')])).toBe('not-run')
    expect(bundleStatus([at('not-run'), at('invalid')])).toBe('invalid')
  })
})

describe('axe contract', () => {
  test('a complete strict scan passes when no serious or critical finding remains', () => {
    expect(summarizeAxe(auditArtifact(), { exitCode: 0 }).status).toBe('pass')
    // Moderate and minor findings are reported, not blocking.
    expect(summarizeAxe(withViolation('moderate', 3), { exitCode: 0 }).status).toBe('pass')
  })

  test('a serious or critical finding fails, and only with the exit code the audit gives', () => {
    expect(summarizeAxe(withViolation('serious', 2), { exitCode: 2 })).toMatchObject({
      status: 'fail',
      totals: { serious: 2 },
    })
    expect(summarizeAxe(withViolation('critical', 1), { exitCode: 2 }).status).toBe('fail')
    expect(summarizeAxe(withViolation('serious', 2), { exitCode: 0 }).status).toBe('invalid')
    expect(summarizeAxe(auditArtifact(), { exitCode: 2 }).status).toBe('invalid')
  })

  test('an empty shell, a failed scan or a missing scope is invalid and never passes', () => {
    expect(summarizeAxe({ surfaces: [{}] }, { exitCode: 0 }).status).toBe('invalid')
    expect(summarizeAxe(undefined, { exitCode: 0 }).status).toBe('invalid')
    expect(summarizeAxe(auditArtifact({ surfaces: [] }), { exitCode: 0 }).problems).toContain(
      'no surface was scanned'
    )
    const failed = auditArtifact({
      surfaces: [
        {
          surface: 'chat',
          url: 'http://127.0.0.1:3217/',
          error: 'scope not found: [role="dialog"]',
        },
      ],
    })
    expect(summarizeAxe(failed, { exitCode: 0 }).problems.join('\n')).toContain('chat failed')
    expect(summarizeAxe(auditArtifact({ strict: false }), { exitCode: 0 }).problems).toContain(
      'the audit must run with --strict'
    )
    expect(
      summarizeAxe(auditArtifact({ tags: ['wcag2a', 'wcag2aa'] }), { exitCode: 0 }).problems
    ).toContain('tags must be the WCAG 2.2 AA axe tag set')
    expect(
      summarizeAxe(auditArtifact({ standard: 'Automated scan' }), { exitCode: 0 }).status
    ).toBe('invalid')
  })

  test('every fixed surface and at least one Settings tab must be scanned', () => {
    const narrowMissing = auditArtifact({
      surfaces: surfaceEntries(AUDIT_SURFACES.filter((name) => name !== 'dev-view-narrow-320')),
    })
    expect(summarizeAxe(narrowMissing, { exitCode: 0 }).problems).toContain(
      'dev-view-narrow-320 was not scanned'
    )
    const noSettings = auditArtifact({
      surfaces: surfaceEntries(['chat', 'dev-view-terminal', 'dev-view-narrow-320']),
    })
    expect(summarizeAxe(noSettings, { exitCode: 0 }).problems).toContain(
      'no Settings tab was scanned'
    )
    const unknown = auditArtifact({ surfaces: surfaceEntries([...AUDIT_SURFACES, 'admin']) })
    expect(summarizeAxe(unknown, { exitCode: 0 }).problems).toContain(
      'admin is not an audited surface'
    )
  })

  test('counts and totals must agree with the recorded violations', () => {
    // A serious count with no violation behind it.
    const orphan = auditArtifact({
      surfaces: AUDIT_SURFACES.map((surface) =>
        surface === 'chat'
          ? {
              surface,
              url: 'http://127.0.0.1:3217/',
              counts: { ...zero(), serious: 1 },
              violations: [],
            }
          : { surface, url: 'http://127.0.0.1:3217/', counts: zero(), violations: [] }
      ),
      totals: { ...zero(), serious: 1 },
      blockingViolations: 1,
    })
    expect(summarizeAxe(orphan, { exitCode: 2 }).problems.join('\n')).toContain(
      'chat counts.serious disagrees with its violations'
    )
    expect(
      summarizeAxe(auditArtifact({ totals: { ...zero(), serious: 1 } }), { exitCode: 0 }).problems
    ).toContain('totals disagree with the scanned surfaces')
    expect(
      summarizeAxe(auditArtifact({ blockingViolations: 4 }), { exitCode: 0 }).problems
    ).toContain('blockingViolations disagrees with the scanned surfaces')
    const malformed = auditArtifact({
      surfaces: AUDIT_SURFACES.map((surface) =>
        surface === 'chat'
          ? {
              surface,
              url: 'http://127.0.0.1:3217/',
              counts: zero(),
              violations: [{ id: 'color-contrast', impact: 'serious' }],
            }
          : { surface, url: 'http://127.0.0.1:3217/', counts: zero(), violations: [] }
      ),
    })
    expect(summarizeAxe(malformed, { exitCode: 0 }).problems.join('\n')).toContain(
      'chat has a malformed violation'
    )
  })

  test('an exit code the lane does not produce is a lane failure', () => {
    expect(summarizeAxe(auditArtifact(), { exitCode: 1 }).problems).toContain(
      'exit 1 is a lane failure, not a completed scan'
    )
    expect(summarizeAxe(auditArtifact(), { exitCode: 124 }).status).toBe('invalid')
    expect(summarizeAxe(auditArtifact()).problems).toContain('exitCode is required')
  })

  test('the scan contract matches scripts/audit-a11y-dev-view.mjs', () => {
    const audit = readFileSync(AUDIT_PATH, 'utf8')
    expect(audit).toContain(`const WCAG_TAGS = [${AXE_TAGS.map((tag) => `'${tag}'`).join(', ')}]`)
    for (const line of [
      'schemaVersion: 1,',
      "lane: 'audit-a11y-dev-view',",
      "issue: '#426/#541',",
      'axeVersion,',
      'strict,',
      'surfaces: results.map((entry) => ({',
      'counts: entry.counts,',
      'violations: entry.violations,',
      'totals,',
      'blockingViolations: blocking,',
    ])
      expect(audit).toContain(line)
  })
})

describe('presence probes on git revisions', () => {
  test('counts files per revision and keeps test-only probes to test files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readiness-probe-'))
    try {
      git(dir, ['init', '-q'])
      const first = commit(
        dir,
        {
          'src/feature.ts': 'export const needle = 1\n',
          'test/feature.test.ts': "test('needle', () => {})\n",
        },
        'add needle'
      )
      const second = commit(dir, { 'src/feature.ts': 'export const other = 1\n' }, 'remove needle')
      const probe = { pattern: 'needle', paths: ['.'] }
      expect(probeFiles(first, probe, dir)).toEqual(['src/feature.ts', 'test/feature.test.ts'])
      expect(probeFiles(first, { ...probe, testFilesOnly: true }, dir)).toEqual([
        'test/feature.test.ts',
      ])
      expect(probeFiles(second, probe, dir)).toEqual(['test/feature.test.ts'])
      expect(() => probeFiles('0'.repeat(40), probe, dir)).toThrow('not in the local object store')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('path-pattern probes list tracked files by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readiness-paths-'))
    try {
      git(dir, ['init', '-q'])
      const sha = commit(
        dir,
        { 'docs/rollback-runbook.md': '# runbook\n', 'docs/index.md': '# index\n' },
        'docs'
      )
      expect(
        probeFiles(sha, { pathPattern: 'rollback|rollout|runbook', paths: ['docs'] }, dir)
      ).toEqual(['docs/rollback-runbook.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

const byId = (measurements: { results: Json[] }, id: string) =>
  measurements.results.find((entry) => entry.id === id) as Json
const passingBundle = (revision: string) => ({
  revision,
  command: CHECK_BUNDLE,
  exitCode: 0,
  report: bundleReport(),
})
const axe = (revision: string, exitCode: number, artifact: Json) => ({
  revision,
  command: AUDIT,
  exitCode,
  artifact,
})
const unitFor = (revision: string, fields: Json = {}) => ({
  'ACC-05': {
    revision,
    command: 'bun test packages/ui/tests/a.test.ts',
    exitCode: 0,
    pass: 67,
    fail: 0,
    seconds: 1,
    ...fields,
  },
})

describe('measurement provenance', () => {
  let repo: { dir: string; first: string; second: string }
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'readiness-provenance-'))
    git(dir, ['init', '-q'])
    const first = commit(dir, { 'README.md': 'first\n' }, 'first')
    const second = commit(dir, { 'README.md': 'second\n' }, 'second')
    repo = { dir, first, second }
  })
  afterAll(() => {
    rmSync(repo.dir, { recursive: true, force: true })
  })

  const build = (options: Json) =>
    buildMeasurements(tinyInventory(), { cwd: repo.dir, mainRevision: repo.second, ...options })

  test('evidence counts for --main only; other revisions are observed, not passed', () => {
    expect(byId(build({ bundle: passingBundle(repo.first) }), 'PERF-01')).toMatchObject({
      status: 'not-run',
      revision: repo.first,
      atMain: false,
      observed: { status: 'pass' },
    })
    expect(byId(build({ bundle: passingBundle(repo.second) }), 'PERF-01')).toMatchObject({
      status: 'pass',
      revision: repo.second,
      atMain: true,
    })
  })

  test('each evidence input names an exact commit, its command and its exit code', () => {
    const bundle = passingBundle(repo.second)
    expect(() => build({ bundle: { ...bundle, revision: 'HEAD' } })).toThrow(
      '40-character commit SHA'
    )
    expect(() => build({ bundle: { ...bundle, revision: repo.second.slice(0, 12) } })).toThrow(
      '40-character commit SHA'
    )
    expect(() => build({ bundle: passingBundle('0'.repeat(40)) })).toThrow(
      'not in the local object store'
    )
    expect(() => build({ bundle: { ...bundle, command: '' } })).toThrow('needs the command')
    expect(() => build({ bundle: { ...bundle, exitCode: '0' } })).toThrow('integer exitCode')
    expect(() => build({ bundle: { ...bundle, command: 'bun test' } })).toThrow('check-client run')
    expect(() =>
      build({
        axe: { revision: repo.second, command: 'bun test', exitCode: 0, artifact: auditArtifact() },
      })
    ).toThrow('audit-a11y-dev-view run')
  })

  test('an axe artifact counts only at --main and only with its own exit code', () => {
    expect(byId(build({ axe: axe(repo.second, 0, auditArtifact()) }), 'ACC-01')).toMatchObject({
      status: 'pass',
      atMain: true,
    })
    expect(byId(build({ axe: axe(repo.first, 0, auditArtifact()) }), 'ACC-01')).toMatchObject({
      status: 'not-run',
      atMain: false,
      observed: { status: 'pass' },
    })
    expect(
      byId(build({ axe: axe(repo.second, 0, withViolation('serious', 1)) }), 'ACC-01')
    ).toMatchObject({ status: 'invalid' })
  })

  test('a check-client run that exited nonzero is invalid, whatever its fields say', () => {
    expect(
      byId(build({ bundle: { ...passingBundle(repo.second), exitCode: 1 } }), 'PERF-01')
    ).toMatchObject({ status: 'invalid', exitCode: 1 })
    expect(byId(build({ bundle: passingBundle(repo.second) }), 'PERF-01').status).toBe('pass')
  })

  test('an axe pass recorded without its validated artifact is never certified', () => {
    const recordedAxe = (status: string, exitCode: number) => ({
      'ACC-01': { status, reason: 'no server', revision: repo.second, command: AUDIT, exitCode },
    })
    expect(byId(build({ recorded: recordedAxe('pass', 0) }), 'ACC-01')).toMatchObject({
      status: 'invalid',
      observed: { status: 'pass' },
    })
    expect(byId(build({ recorded: recordedAxe('partial', 0) }), 'ACC-01').status).toBe('invalid')
    expect(byId(build({ recorded: recordedAxe('blocked', 1) }), 'ACC-01').status).toBe('blocked')
    expect(byId(build({ recorded: recordedAxe('fail', 2) }), 'ACC-01').status).toBe('fail')
    // A validated artifact decides. The recorded pass is only context.
    expect(
      byId(
        build({ axe: axe(repo.second, 0, auditArtifact()), recorded: recordedAxe('pass', 0) }),
        'ACC-01'
      )
    ).toMatchObject({ status: 'pass', recorded: { status: 'pass' } })
  })

  test('a recorded run cannot overwrite the identity of its criterion', () => {
    const run = (id: string, fields: Json) => ({
      [id]: {
        revision: repo.second,
        command: AUDIT,
        exitCode: 1,
        status: 'blocked',
        reason: 'no server',
        ...fields,
      },
    })
    expect(() => build({ recorded: run('OPS-10', { id: 'PERF-05' }) })).toThrow(
      'recorded id "PERF-05" does not match "OPS-10"'
    )
    expect(() => build({ recorded: run('ACC-02', { kind: 'unit' }) })).toThrow(
      'recorded kind "unit" does not match "e2e"'
    )
    expect(() => build({ recorded: run('ACC-02', { category: 'cost' }) })).toThrow(
      'recorded category "cost" does not match "accessibility"'
    )
    expect(() => build({ recorded: run('ACC-99', {}) })).toThrow('unknown criterion ACC-99')
    expect(() => build({ recorded: run('PERF-01', {}) })).toThrow('does not accept recorded runs')
    expect(() => build({ recorded: run('ACC-02', { status: 'pass', exitCode: 1 }) })).toThrow(
      'a pass run needs exit 0, got 1'
    )
    expect(() => build({ recorded: run('ACC-02', { reason: '' }) })).toThrow(
      'a blocked run needs a reason'
    )

    const accepted = build({
      recorded: {
        'ACC-02': {
          id: 'ACC-02',
          category: 'accessibility',
          kind: 'e2e',
          status: 'blocked',
          reason: 'no server',
          revision: repo.second,
          command: 'bunx playwright test',
          exitCode: 1,
        },
      },
    })
    expect(byId(accepted, 'ACC-02')).toMatchObject({
      id: 'ACC-02',
      category: 'accessibility',
      kind: 'e2e',
      status: 'blocked',
      revision: repo.second,
      atMain: true,
    })
  })

  test('a recorded fact at another revision keeps its status; a verdict there becomes not-run', () => {
    const measured = build({
      recorded: {
        'OPS-10': {
          status: 'measured',
          seconds: 12,
          revision: repo.first,
          command: 'node scripts/check-docs.mjs',
          exitCode: 0,
        },
      },
    })
    expect(byId(measured, 'OPS-10')).toMatchObject({
      status: 'measured',
      atMain: false,
      revision: repo.first,
    })
    const verdict = build({
      recorded: {
        'ACC-02': {
          status: 'pass',
          revision: repo.first,
          command: 'bunx playwright test',
          exitCode: 0,
        },
      },
    })
    expect(byId(verdict, 'ACC-02')).toMatchObject({
      status: 'not-run',
      atMain: false,
      observed: { status: 'pass' },
    })
  })

  test('unit runs name their revision and count only at --main', () => {
    expect(byId(build({ unitRuns: unitFor(repo.first) }), 'ACC-05')).toMatchObject({
      status: 'not-run',
      atMain: false,
      observed: { status: 'pass', pass: 67 },
    })
    expect(byId(build({ unitRuns: unitFor(repo.second) }), 'ACC-05')).toMatchObject({
      status: 'pass',
      atMain: true,
      pass: 67,
    })
    expect(byId(build({ unitRuns: unitFor(repo.second, { pass: 0 }) }), 'ACC-05').status).toBe(
      'invalid'
    )
    expect(
      byId(build({ unitRuns: unitFor(repo.second, { exitCode: 1, fail: 2 }) }), 'ACC-05').status
    ).toBe('fail')
  })

  test('a unit run must name its criterion files and report integer counts', () => {
    expect(() =>
      build({ unitRuns: unitFor(repo.second, { command: 'bun test other.test.ts' }) })
    ).toThrow('does not name every criterion file')
    expect(() =>
      build({
        unitRuns: unitFor(repo.second, {
          command: 'bun test packages/ui/tests/a.test.ts',
          pass: '67',
        }),
      })
    ).toThrow('pass and fail counts')
    expect(() =>
      build({
        unitRuns: {
          'ACC-02': { revision: repo.second, command: 'x', exitCode: 0, pass: 1, fail: 0 },
        },
      })
    ).toThrow('not a unit criterion')
  })

  test('--run-unit names one clean HEAD: a dirty tracked tree is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readiness-head-'))
    try {
      git(dir, ['init', '-q'])
      const head = commit(dir, { 'a.txt': 'one\n' }, 'one')
      expect(headRevision(dir)).toBe(head)
      writeFileSync(join(dir, 'a.txt'), 'two\n')
      expect(() => headRevision(dir)).toThrow('clean tracked tree')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('unit runs', () => {
  test('runUnit reports the command, exit code and counts of a real bun test run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readiness-unit-'))
    try {
      writeFileSync(
        join(dir, 'ok.test.ts'),
        "import { expect, test } from 'bun:test'\ntest('ok', () => expect(1).toBe(1))\n"
      )
      writeFileSync(
        join(dir, 'bad.test.ts'),
        "import { expect, test } from 'bun:test'\ntest('bad', () => expect(1).toBe(2))\n"
      )
      const passing = runUnit(['ok.test.ts'], dir)
      expect(passing).toMatchObject({
        command: 'bun test ok.test.ts',
        exitCode: 0,
        pass: 1,
        fail: 0,
      })
      expect(unitVerdict(passing)).toBe('pass')
      const failing = runUnit(['bad.test.ts'], dir)
      expect(failing).toMatchObject({ exitCode: 1, fail: 1 })
      expect(unitVerdict(failing)).toBe('fail')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a unit run that reports no tests is invalid, not a pass', () => {
    expect(unitVerdict({ exitCode: 0, pass: 0, fail: 0 })).toBe('invalid')
    expect(unitVerdict({ exitCode: 0, pass: 3, fail: 1 })).toBe('fail')
    expect(unitVerdict({ exitCode: 0, pass: 3, fail: 0 })).toBe('pass')
  })
})

describe('committed evidence records', () => {
  test('the committed evidence inputs name an exact revision, command and exit code', () => {
    const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'))
    expect(bundle.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(bundle.command).toMatch(/check-(client|bundle)/)
    expect(bundle.exitCode).toBe(0)
    expect(typeof bundle.report.clientJavaScriptBytes).toBe('number')

    const recorded = JSON.parse(readFileSync(RECORDED_PATH, 'utf8'))
    for (const run of Object.values(recorded) as Json[]) {
      expect(run.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(typeof run.command).toBe('string')
      expect(Number.isInteger(run.exitCode)).toBe(true)
    }
  })

  test('the committed measurements count a verdict only at --main', () => {
    const measurements = JSON.parse(readFileSync(MEASUREMENTS_PATH, 'utf8'))
    expect(measurements.evidenceRevisions).toContain(measurements.revisions.main)
    for (const entry of measurements.results) {
      if (VERDICT_STATUSES.includes(entry.status)) expect(entry.atMain).toBe(true)
      if (entry.observed) expect(entry.atMain).toBe(false)
    }
  })
})
