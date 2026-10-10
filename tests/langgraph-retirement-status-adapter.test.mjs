// Tests for the M16.03 (#940) legacy status adapter over the M16.01 (#938) inventory manifest.
//
// Disposable manifests only: one real repository-scan manifest from the collector (no store is contacted),
// and manifests built here from the reviewed script's epistemics. Nothing here is a deployed observation,
// so no test may expect deployed zero. No network, no DSNs, and writes only to temp directories.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'bun:test'
import {
  collectInventoryManifest,
  MANIFEST_NAME,
  MANIFEST_VERSION,
} from '../scripts/langgraph-retirement-inventory-pg.mjs'
import {
  OBSERVATION_STATUS,
  retainedWorkEpistemics,
} from '../scripts/langgraph-retirement-inventory.mjs'
import {
  buildLegacyInventoryStatus,
  runLegacyInventoryStatusCli,
} from '../scripts/langgraph-retirement-status-adapter.mjs'

const at = '2026-10-08T09:00:00.000Z'
const digest = `sha256:${'a'.repeat(64)}`
const { ZERO, OBSERVED, INCOMPLETE, INACCESSIBLE, STALE } = OBSERVATION_STATUS

function section(status, counts = {}, overrides = {}) {
  return {
    status,
    reasons: [],
    observedAt: at,
    source: { backend: 'postgres-dsn', identity: digest, tables: [] },
    counts,
    entries: [],
    truncated: false,
    boundReached: false,
    countsBounded: false,
    malformedRecords: 0,
    ...overrides,
  }
}

const cleanExecutions = () => section(ZERO, { total: 0, inFlight: 0, terminal: 0, byState: {} })
const cleanCheckpoints = () =>
  section(ZERO, {
    total: 0,
    checkpointRows: 0,
    blobRows: 0,
    writeRows: 0,
    distinctThreads: 0,
    unclassifiedThreads: 0,
    threadsOnInFlightExecutions: 0,
    threadsOnUnknownExecutions: 0,
  })

// A disposable manifest. Its epistemics come from the reviewed rule, so the collector's own claim is real.
function manifest({
  scope = 'local-disposable-store',
  executions,
  checkpoints,
  ...overrides
} = {}) {
  const sections = {
    definitions: section(ZERO, { total: 0, identityMismatches: 0 }),
    consumers: section(OBSERVED, {
      registered: 1,
      distinctCatalogCallers: 0,
      catalogCommandReceipts: 0,
    }),
    executions: executions ?? cleanExecutions(),
    checkpoints: checkpoints ?? cleanCheckpoints(),
  }
  return {
    manifest: MANIFEST_NAME,
    manifestVersion: MANIFEST_VERSION,
    observedAt: at,
    observationScope: scope,
    sourceRevision: 'test-fixture',
    store: {
      backend: 'postgres-dsn',
      identity: digest,
      status: OBSERVED,
      schemaVersion: 1,
      reasons: [],
    },
    sections,
    epistemics: retainedWorkEpistemics({
      observationScope: scope,
      executions: sections.executions,
      checkpoints: sections.checkpoints,
    }),
    ...overrides,
  }
}

function codeOf(action) {
  try {
    action()
  } catch (error) {
    return error.code
  }
  return undefined
}

test('a repository-scan manifest from the collector reports every source unknown and never zero', async () => {
  const collected = await collectInventoryManifest({
    dsn: undefined,
    identity: null,
    observationScope: 'repository-scan',
    observedAt: at,
  })
  const status = buildLegacyInventoryStatus(collected)
  expect(status.observation).toBe('unknown')
  expect(status.exact).toBe(false)
  expect(status.source.identity).toBeNull()
  expect(status.sections.executions.status).toBe('unknown')
  expect(status.remainder.executions).toBeNull()
  expect(status.remainder.threads).toBeNull()
  expect(status.zero).toEqual({
    established: false,
    attested: false,
    reasons: expect.arrayContaining([
      'REPOSITORY_SCOPE_CANNOT_ESTABLISH_ZERO',
      'CHECKPOINTS_UNKNOWN',
      'EXECUTIONS_UNKNOWN',
    ]),
  })
})

test('a clean deployed-dsn manifest is reported as un-attested and never as deployed zero', () => {
  const status = buildLegacyInventoryStatus(manifest({ scope: 'deployed-dsn' }))
  // The collector's own rule can call this none-observed-in-scope. That claim is un-attested here.
  expect(status.retainedWork).toEqual({
    classification: 'none-observed-in-scope',
    collectorClaim: 'none-observed-in-scope',
    attested: false,
  })
  expect(status.observation).toBe('observed')
  expect(status.exact).toBe(true)
  expect(status.remainder.checkpoints).toBe(0)
  expect(status.zero).toEqual({
    established: false,
    attested: false,
    reasons: ['DEPLOYED_ATTESTATION_MISSING'],
  })
  expect(status.removal.satisfied).toBe(false)
})

test('a disposable store with the same clean sections never establishes zero', () => {
  const status = buildLegacyInventoryStatus(manifest({ scope: 'local-disposable-store' }))
  expect(status.retainedWork.collectorClaim).toBe('not-claimable')
  expect(status.zero).toEqual({
    established: false,
    attested: false,
    reasons: ['DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO'],
  })
})

test('incomplete reads keep lower-bound counts, are never exact, and block zero', () => {
  const status = buildLegacyInventoryStatus(
    manifest({
      scope: 'deployed-dsn',
      executions: section(
        OBSERVED,
        { total: 128, inFlight: 1, terminal: 127, byState: { running: 1, completed: 127 } },
        { truncated: true, boundReached: true, countsBounded: true }
      ),
    })
  )
  expect(status.sections.executions.status).toBe(INCOMPLETE)
  expect(status.observation).toBe(INCOMPLETE)
  expect(status.exact).toBe(false)
  expect(status.remainder.executions).toBe(128)
  expect(status.blockers.IN_FLIGHT_WORK).toBe(1)
  expect(status.zero.reasons).toEqual(
    expect.arrayContaining(['EXECUTIONS_INCOMPLETE', 'READ_INCOMPLETE'])
  )
  expect(status.zero.established).toBe(false)
})

test('inaccessible sources report unknown counts, not zero', () => {
  const status = buildLegacyInventoryStatus(
    manifest({
      scope: 'deployed-dsn',
      checkpoints: section(INACCESSIBLE, {}, { reasons: ['CONNECTION_FAILED'] }),
    })
  )
  expect(status.observation).toBe(INACCESSIBLE)
  expect(status.remainder.threads).toBeNull()
  expect(status.remainder.checkpoints).toBeNull()
  expect(status.remainder.writes).toBeNull()
  expect(status.remainder.malformedCheckpointRecords).toBeNull()
  expect(status.zero.reasons).toContain('CHECKPOINTS_INACCESSIBLE')
  expect(status.zero.established).toBe(false)
})

test('unrecognized statuses and unverifiable flags become unknown, never observed', () => {
  const status = buildLegacyInventoryStatus(
    manifest({
      scope: 'deployed-dsn',
      checkpoints: section('healthy', cleanCheckpoints().counts),
      executions: section(
        OBSERVED,
        { total: 2, inFlight: 0, byState: {} },
        { malformedRecords: 'none' }
      ),
    })
  )
  expect(status.sections.checkpoints).toEqual({
    status: 'unknown',
    reasons: ['STATUS_UNRECOGNIZED'],
    requiredCounts: 'not-read',
  })
  expect(status.sections.executions).toEqual({
    status: 'unknown',
    reasons: ['FLAGS_UNVERIFIED'],
    requiredCounts: 'not-read',
  })
  expect(status.remainder.threads).toBeNull()
  expect(status.remainder.executions).toBeNull()
  expect(status.exact).toBe(false)
  expect(status.zero.established).toBe(false)
})

test('an observed section with missing or invalid required counts is non-exact, keeps those counts unknown, and never establishes zero', () => {
  const missing = buildLegacyInventoryStatus(
    manifest({
      scope: 'deployed-dsn',
      executions: section(OBSERVED, { total: 2, byState: { running: 1, completed: 1 } }),
    })
  )
  expect(missing.sections.executions).toEqual({
    status: INCOMPLETE,
    reasons: ['EXECUTIONS_REQUIRED_COUNTS_MISSING'],
    requiredCounts: 'missing',
  })
  expect(missing.exact).toBe(false)
  expect(missing.exactReasons).toEqual(['EXECUTIONS_REQUIRED_COUNTS_MISSING'])
  expect(missing.remainder.inFlightExecutions).toBeNull()
  expect(missing.blockers).toEqual({})
  expect(missing.zero.established).toBe(false)
  expect(missing.zero.reasons).toEqual(
    expect.arrayContaining(['EXECUTIONS_REQUIRED_COUNTS_MISSING', 'READ_INCOMPLETE'])
  )

  const invalid = buildLegacyInventoryStatus(
    manifest({
      scope: 'deployed-dsn',
      checkpoints: section(OBSERVED, { ...cleanCheckpoints().counts, writeRows: '4' }),
    })
  )
  expect(invalid.sections.checkpoints).toEqual({
    status: INCOMPLETE,
    reasons: ['CHECKPOINTS_REQUIRED_COUNTS_INVALID'],
    requiredCounts: 'invalid',
  })
  expect(invalid.exact).toBe(false)
  expect(invalid.exactReasons).toEqual(['CHECKPOINTS_REQUIRED_COUNTS_INVALID'])
  expect(invalid.remainder.writes).toBeNull()
  expect(invalid.remainder.checkpoints).toBe(0)
  expect(invalid.zero.established).toBe(false)
})

test('stale sources stay stale, keep their counts, and are never exact', () => {
  const status = buildLegacyInventoryStatus(
    manifest({
      scope: 'deployed-dsn',
      executions: section(STALE, { total: 3, inFlight: 0, byState: { completed: 3 } }),
    })
  )
  expect(status.observation).toBe(STALE)
  expect(status.exact).toBe(false)
  expect(status.remainder.executions).toBe(3)
  expect(status.zero.reasons).toContain('EXECUTIONS_STALE')
})

test('blockers tally in-flight work, uncertain effects, and retained threads', () => {
  const status = buildLegacyInventoryStatus(
    manifest({
      scope: 'deployed-dsn',
      executions: section(OBSERVED, {
        total: 3,
        inFlight: 2,
        terminal: 1,
        byState: { running: 1, reconciliation_required: 1, completed: 1 },
      }),
      checkpoints: section(OBSERVED, {
        total: 5,
        checkpointRows: 5,
        blobRows: 0,
        writeRows: 4,
        distinctThreads: 2,
        unclassifiedThreads: 0,
        threadsOnInFlightExecutions: 1,
        threadsOnUnknownExecutions: 0,
      }),
    })
  )
  expect(status.blockers).toEqual({
    IN_FLIGHT_WORK: 2,
    UNCERTAIN_EFFECT_UNRECONCILED: 1,
    RETAINED_THREADS_PRESENT: 2,
  })
  expect(status.zero.reasons).toEqual(
    expect.arrayContaining([
      'IN_FLIGHT_WORK',
      'UNCERTAIN_EFFECT_UNRECONCILED',
      'RETAINED_THREADS_PRESENT',
    ])
  )
  expect(status.zero.established).toBe(false)
})

test('a misnamed, misversioned, out-of-scope, or DSN-bearing manifest is refused before any status is built', () => {
  expect(codeOf(() => buildLegacyInventoryStatus({ ...manifest(), manifest: 'other' }))).toBe(
    'INVALID_MANIFEST'
  )
  expect(codeOf(() => buildLegacyInventoryStatus({ ...manifest(), manifestVersion: 2 }))).toBe(
    'UNSUPPORTED_MANIFEST_VERSION'
  )
  expect(
    codeOf(() => buildLegacyInventoryStatus({ ...manifest(), observationScope: 'production' }))
  ).toBe('INVALID_MANIFEST')
  expect(
    codeOf(() => buildLegacyInventoryStatus({ ...manifest(), observedAt: 'not-a-date' }))
  ).toBe('INVALID_MANIFEST')
  expect(
    codeOf(() =>
      buildLegacyInventoryStatus({
        ...manifest(),
        store: { identity: 'postgres://app:secret@db.internal/prod' },
      })
    )
  ).toBe('INVALID_MANIFEST')
})

test('the status carries no entries, connection strings, or free-text reasons', () => {
  const leaky = manifest({
    scope: 'deployed-dsn',
    executions: section(
      OBSERVED,
      { total: 1, inFlight: 0, byState: { completed: 1 } },
      {
        reasons: ['postgres://app:secret@db.internal/prod free text'],
        entries: [{ executionId: 'exe_01JABCDEF0123456789ABCDEFG', note: 'secret' }],
      }
    ),
  })
  const text = JSON.stringify(buildLegacyInventoryStatus(leaky))
  expect(text).not.toContain('secret')
  expect(text).not.toContain('postgres://')
  expect(text).not.toContain('entries')
  expect(buildLegacyInventoryStatus(leaky).sections.executions.reasons).toEqual([
    'REASON_UNRECOGNIZED',
  ])
})

test('the CLI reads a manifest file and prints exactly the library status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-status-adapter-'))
  try {
    const file = join(directory, 'manifest.json')
    const input = manifest({ scope: 'deployed-dsn' })
    await writeFile(file, JSON.stringify(input))
    let printed = ''
    await runLegacyInventoryStatusCli({
      argv: ['--manifest', file],
      stdout: { write: (chunk) => (printed += chunk) },
    })
    expect(JSON.parse(printed)).toEqual(buildLegacyInventoryStatus(input))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the CLI refuses a call without a manifest and prints help without reading any file', async () => {
  let reads = 0
  const readManifest = async () => {
    reads += 1
    return '{}'
  }
  await expect(runLegacyInventoryStatusCli({ argv: [], readManifest })).rejects.toMatchObject({
    code: 'INVALID_ARGUMENTS',
  })
  let help = ''
  const result = await runLegacyInventoryStatusCli({
    argv: ['--help'],
    readManifest,
    stdout: { write: (chunk) => (help += chunk) },
  })
  expect(result.action).toBe('help')
  expect(help).toContain('--manifest')
  expect(reads).toBe(0)
})
