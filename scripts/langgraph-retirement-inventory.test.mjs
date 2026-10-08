// Tests for the M16.01 (#938) read-only retirement inventory.
//
// Families covered: disposable persistence (temp-dir sqlite stores through the
// real catalog/plan/execution interfaces), bounding and pagination, mixed
// schema/workflow versions, unavailable sources (typed inaccessible, never a
// crash), inconsistent stores (typed incomplete/stale), the zero-vs-unknown
// epistemics rule, byte-stable deterministic output with an injectable
// observation clock, the pure disposition validator, and the CLI surface.
// No network, no production DSNs, no writes outside temp directories.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DISPOSITION_KINDS,
  OBSERVATION_SCOPES,
  OBSERVATION_STATUS,
  RetirementInventoryError,
  buildInventoryManifest,
  openReadOnlyStore,
  readStoreProfile,
  retainedWorkEpistemics,
  runInventoryCli,
  stableJsonStringify,
  validateDispositions,
} from './langgraph-retirement-inventory.mjs'
import { createInventoryFixtureStore } from './langgraph-retirement-inventory-fixture.mjs'

const OBSERVED_AT = '2026-10-08T00:00:00.000Z'

let temporaryDirectory

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'langgraph-retirement-inventory-test-'))
})

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true })
})

async function withFixtureStore(options, run) {
  const fixture = await createInventoryFixtureStore(options)
  try {
    const store = await openReadOnlyStore(fixture.path)
    try {
      return await run({ fixture, store })
    } finally {
      store.database.close()
    }
  } finally {
    await fixture.cleanup()
  }
}

function buildManifest(store, { observationScope = 'local-disposable-store', ...options } = {}) {
  return buildInventoryManifest({
    database: store.database,
    storeIdentity: store.identity,
    storeProfile: readStoreProfile(store.database),
    observationScope,
    observedAt: OBSERVED_AT,
    ...options,
  })
}

function collectStdout() {
  const chunks = []
  return {
    write(text) {
      chunks.push(text)
    },
    text: () => chunks.join(''),
  }
}

describe('langgraph retirement inventory', () => {
  describe('disposable fixture store inventory', () => {
    test('inventories definitions, consumers, executions and checkpoints with counts', async () => {
      await withFixtureStore({}, async ({ store }) => {
        const manifest = buildManifest(store)

        expect(manifest.manifest).toBe('langgraph-retirement-inventory')
        expect(manifest.observedAt).toBe(OBSERVED_AT)
        expect(manifest.observationScope).toBe('local-disposable-store')
        expect(manifest.tool.readMode).toBe('read-only')
        expect(manifest.tool.migration).toBe('never')
        expect(manifest.tool.checkpointTransplant).toBe('never')
        expect(manifest.store.status).toBe(OBSERVATION_STATUS.OBSERVED)

        const definitions = manifest.sections.definitions
        expect(definitions.status).toBe(OBSERVATION_STATUS.OBSERVED)
        expect(definitions.counts).toEqual({
          total: 4,
          workspaces: 2,
          distinctGraphs: 3,
          byLifecycle: { deprecated: 1, published: 3 },
        })
        const alpha = definitions.entries.find(
          (entry) =>
            entry.graphDefinitionId === 'graph:inventory-alpha' &&
            entry.graphVersion === '1.0.0' &&
            entry.workspaceId === 'wsp_01JABCDEF0123456789ABCDEFG'
        )
        expect(alpha.runtimeProfile.nodeCount).toBe(2)
        expect(alpha.runtimeProfile.operationKinds).toEqual(['runtime', 'tool'])
        expect(alpha.lifecycle).toBe('published')
        expect(alpha.durableOwner).toBe('control-plane-graph-catalog')
        // The running execution, its plans, and its checkpoint rows attribute
        // back to this definition version.
        expect(alpha.consumersObserved).toEqual({
          catalogCommands: 1,
          checkpointRows: 3,
          inFlightExecutions: 1,
          retainedExecutions: 1,
        })

        const executions = manifest.sections.executions
        expect(executions.status).toBe(OBSERVATION_STATUS.OBSERVED)
        expect(executions.counts.total).toBe(2)
        expect(executions.counts.inFlight).toBe(1)
        expect(executions.counts.terminal).toBe(1)
        expect(executions.counts.inFlightAttributed).toBe(1)
        expect(executions.counts.byState).toEqual({ cancelled: 1, running: 1 })
        expect(executions.entries.length).toBe(1)
        const running = executions.entries[0]
        expect(running.state).toBe('running')
        expect(running.graphWorkflow).toBe(true)
        expect(running.graphReference.graphDefinitionId).toBe('graph:inventory-alpha')
        expect(running.durableOwner).toBe('control-plane-execution-history')
        const checkpoints = manifest.sections.checkpoints
        expect(checkpoints.counts.total).toBe(4)
        expect(checkpoints.counts.checkpointRows).toBe(3)
        expect(checkpoints.counts.writeRows).toBe(1)
        expect(checkpoints.counts.distinctThreads).toBe(2)
        expect(checkpoints.counts.threadsOnInFlightExecutions).toBe(1)
        const runningThread = checkpoints.entries.find(
          (entry) => entry.executionId === running.executionId
        )
        expect(runningThread.graphWorkflow).toBe(true)
        expect(runningThread.historyResponsibility).toContain('never transplants')

        const consumers = manifest.sections.consumers
        expect(consumers.counts.registered).toBe(4)
        expect(consumers.counts.catalogCommandReceipts).toBe(2)
        const callerIds = consumers.entries
          .filter((entry) => entry.kind === 'catalog-command-caller')
          .map((entry) => entry.profile.callerId)
          .toSorted()
        expect(callerIds).toEqual(['svc_inventory-beta-caller', 'svc_inventory-fixture'])

        expect(manifest.epistemics.retainedWorkClassification).toBe('present')
        expect(manifest.epistemics.zeroLiveWorkClaim.claimAllowed).toBe(false)
        expect(manifest.historicalDecisionReconciliation.status).toBe(OBSERVATION_STATUS.UNKNOWN)
        expect(manifest.historyOwnership.cancellationReceipts.count).toBe(0)
      })
    })

    test('handles mixed schema and workflow versions side by side', async () => {
      await withFixtureStore({}, async ({ store }) => {
        const manifest = buildManifest(store)
        const versions = manifest.sections.definitions.entries
          .filter((entry) => entry.graphDefinitionId === 'graph:inventory-alpha')
          .map((entry) => [entry.workspaceId, entry.graphVersion, entry.lifecycle])
          .toSorted()
        expect(versions).toEqual([
          ['wsp_01JABCDEF0123456789ABCDEFG', '1.0.0', 'published'],
          ['wsp_01JABCDEF0123456789ABCDEFG', '1.1.0', 'deprecated'],
          ['wsp_01JBBBBBBBBBBBBBBBBBBBBBB2', '1.0.0', 'published'],
        ])
        const deprecated = manifest.sections.definitions.entries.find(
          (entry) => entry.graphVersion === '1.1.0'
        )
        expect(deprecated.reason).toBe('superseded by the workflow migration candidate')
        // Only the pinned 1.0.0 version carries in-flight work.
        expect(deprecated.consumersObserved.inFlightExecutions).toBe(0)
      })
    })

    test('in-flight executions whose plan vanished are typed incomplete, never silent', async () => {
      await withFixtureStore({}, async ({ fixture }) => {
        // Delete the running execution's plan row on a COPY of the store so
        // the fixture itself stays untouched; the copy is disposable.
        const copyPath = join(temporaryDirectory, 'planless.sqlite')
        await rm(copyPath, { force: true })
        const { Database } = await import('bun:sqlite')
        const source = new Database(fixture.path, { readonly: true })
        source.exec(`VACUUM INTO '${copyPath}'`)
        source.close()
        const writer = new Database(copyPath)
        writer.run('begin')
        writer.run('delete from control_plane_records where namespace = ?1', 'execution-plans')
        writer.run('commit')
        writer.close()
        const copiedStore = await openReadOnlyStore(copyPath)
        try {
          const manifest = buildManifest(copiedStore)
          const executions = manifest.sections.executions
          expect(executions.counts.inFlightPlansMissing).toBe(1)
          const unattributed = executions.entries[0]
          expect(unattributed.graphWorkflow).toBe(false)
          expect(unattributed.graphReference).toBeUndefined()
          expect(unattributed.executionPlan).toBeDefined()
          // The global classification still reflects the in-flight work.
          expect(manifest.epistemics.retainedWorkClassification).toBe('present')
        } finally {
          copiedStore.database.close()
          await rm(copyPath, { force: true })
        }
      })
    })
  })

  describe('bounding and pagination', () => {
    test('truncates entries but keeps counts exact and flags incompleteness', async () => {
      await withFixtureStore({}, async ({ store }) => {
        const manifest = buildManifest(store, { limits: { entriesPerSection: 2, pageSize: 1 } })
        const definitions = manifest.sections.definitions
        expect(definitions.truncated).toBe(true)
        expect(definitions.entries.length).toBe(2)
        expect(definitions.counts.total).toBe(4)
        expect(definitions.status).toBe(OBSERVATION_STATUS.INCOMPLETE)
        expect(definitions.reasons).toContain('ENTRY_LIMIT_REACHED')
        // Deterministic page walk: page size 1 must still visit every record.
        expect(definitions.counts.workspaces).toBe(2)
        expect(manifest.sections.executions.counts.total).toBe(2)
      })
    })

    test('rejects out-of-range entry limits with a typed error', async () => {
      await withFixtureStore({}, async ({ store }) => {
        expect(() => buildManifest(store, { limits: { entriesPerSection: 1001 } })).toThrow(
          RetirementInventoryError
        )
        expect(() => buildManifest(store, { limits: { entriesPerSection: 0 } })).toThrow(
          RetirementInventoryError
        )
      })
    })
  })

  describe('unavailable and inconsistent sources', () => {
    test('missing store file yields a typed inaccessible manifest, not a crash', async () => {
      const missingPath = join(temporaryDirectory, 'absent.sqlite')
      const stdout = collectStdout()
      const outcome = await runInventoryCli({
        argv: ['--observation-scope', 'deployed-dsn', '--store', missingPath, '--now', OBSERVED_AT],
        stdout,
      })
      expect(outcome.exitCode).toBe(0)
      const manifest = JSON.parse(stdout.text())
      expect(manifest.store.status).toBe(OBSERVATION_STATUS.INACCESSIBLE)
      expect(manifest.store.reasons).toEqual(['STORE_FILE_MISSING'])
      expect(manifest.sections.definitions.status).toBe(OBSERVATION_STATUS.UNKNOWN)
      expect(manifest.sections.executions.status).toBe(OBSERVATION_STATUS.UNKNOWN)
      expect(manifest.epistemics.retainedWorkClassification).toBe('unknown')
    })

    test('a non-sqlite store file is typed inaccessible via the profile preflight', async () => {
      const garbagePath = join(temporaryDirectory, 'garbage.sqlite')
      await writeFile(garbagePath, 'this is not a sqlite database', { mode: 0o600 })
      const store = await openReadOnlyStore(garbagePath)
      try {
        const profile = readStoreProfile(store.database)
        expect(profile.status).toBe(OBSERVATION_STATUS.INACCESSIBLE)
        expect(profile.reasons).toEqual(['NOT_A_SQLITE_STORE'])
        const manifest = buildManifest(store)
        expect(manifest.store.status).toBe(OBSERVATION_STATUS.INACCESSIBLE)
        expect(manifest.sections.definitions.status).toBe(OBSERVATION_STATUS.UNKNOWN)
      } finally {
        store.database.close()
      }
    })

    test('store target discipline: sloppy targets are rejected, absent stores are reported', async () => {
      await expect(
        runInventoryCli({
          argv: ['--observation-scope', 'deployed-dsn', '--store', 'relative.sqlite'],
        })
      ).rejects.toMatchObject({ code: 'STORE_PATH_NOT_ABSOLUTE' })
      const absentPath = join(temporaryDirectory, 'absent-target.sqlite')
      await expect(
        runInventoryCli({ argv: ['--observation-scope', 'deployed-dsn', '--store', absentPath] })
      ).resolves.toMatchObject({ action: 'manifest' })
      const directoryPath = join(temporaryDirectory, 'a-directory')
      await mkdir(directoryPath, { recursive: true })
      await expect(
        runInventoryCli({ argv: ['--observation-scope', 'deployed-dsn', '--store', directoryPath] })
      ).rejects.toMatchObject({ code: 'STORE_NOT_A_FILE' })
    })

    test('malformed records are typed incomplete while valid entries survive', async () => {
      await withFixtureStore({ injectMalformedDefinition: true }, async ({ store }) => {
        const definitions = buildManifest(store).sections.definitions
        expect(definitions.status).toBe(OBSERVATION_STATUS.INCOMPLETE)
        expect(definitions.reasons).toContain('MALFORMED_RECORDS_PRESENT')
        expect(definitions.malformedRecords).toBe(1)
        expect(definitions.counts.total).toBe(5)
        expect(definitions.entries.length).toBe(4)
      })
    })

    test('an old provider clock is reported stale against the observation time', async () => {
      await withFixtureStore(
        { now: () => new Date('2026-01-01T00:00:00.000Z') },
        async ({ store }) => {
          const manifest = buildManifest(store, { limits: { maxAgeDays: 30 } })
          expect(manifest.sections.definitions.status).toBe(OBSERVATION_STATUS.STALE)
          expect(manifest.sections.definitions.reasons).toContain('FRESHNESS_THRESHOLD_EXCEEDED')
          // A generous threshold keeps the same store fresh.
          const fresh = buildManifest(store, { limits: { maxAgeDays: 3650 } })
          expect(fresh.sections.definitions.status).toBe(OBSERVATION_STATUS.OBSERVED)
        }
      )
    })

    test('malformed checkpoint rows keep the section incomplete with exact counts', async () => {
      await withFixtureStore({ injectMalformedCheckpoint: true }, async ({ store }) => {
        const checkpoints = buildManifest(store).sections.checkpoints
        expect(checkpoints.status).toBe(OBSERVATION_STATUS.INCOMPLETE)
        expect(checkpoints.malformedRecords).toBe(1)
        expect(checkpoints.counts.total).toBe(5)
        expect(checkpoints.counts.checkpointRows).toBe(3)
      })
    })
  })

  describe('zero-vs-unknown epistemics', () => {
    test('an empty disposable store reports section zero but never a global zero claim', async () => {
      const { SqlitePersistenceProvider } = await import('@control-plane/sqlite-persistence')
      const path = join(temporaryDirectory, 'empty.sqlite')
      const provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const store = await openReadOnlyStore(path)
      try {
        for (const scope of ['local-disposable-store', 'repository-scan']) {
          const manifest = buildManifest(store, { observationScope: scope })
          expect(manifest.sections.definitions.status).toBe(OBSERVATION_STATUS.ZERO)
          expect(manifest.sections.executions.status).toBe(OBSERVATION_STATUS.ZERO)
          expect(manifest.epistemics.retainedWorkClassification).toBe('unknown')
          expect(manifest.epistemics.zeroLiveWorkClaim.claim).toBe('not-claimable')
          expect(manifest.epistemics.zeroLiveWorkClaim.reasons).toContain(
            `OBSERVATION_SCOPE_${scope.toUpperCase()}_CANNOT_ESTABLISH_ZERO_LIVE_WORK`
          )
        }
      } finally {
        store.database.close()
        await provider.close()
        await rm(path, { force: true })
      }
    })

    test('only a fully-read deployed-dsn observation may classify none-observed-in-scope', async () => {
      await withFixtureStore({}, async ({ store }) => {
        const manifest = buildManifest(store, { observationScope: 'deployed-dsn' })
        expect(manifest.epistemics.retainedWorkClassification).toBe('present')
        expect(manifest.epistemics.zeroLiveWorkClaim.claimAllowed).toBe(false)
        expect(manifest.epistemics.zeroLiveWorkClaim.reasons).toContain('IN_FLIGHT_WORK_OBSERVED')
      })
      // Empty store, deployed attestation, full read: the strong claim is allowed.
      const { SqlitePersistenceProvider } = await import('@control-plane/sqlite-persistence')
      const path = join(temporaryDirectory, 'empty-deployed.sqlite')
      const provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const store = await openReadOnlyStore(path)
      try {
        const manifest = buildManifest(store, { observationScope: 'deployed-dsn' })
        expect(manifest.epistemics.retainedWorkClassification).toBe('none-observed-in-scope')
        expect(manifest.epistemics.zeroLiveWorkClaim.claimAllowed).toBe(true)
        expect(manifest.epistemics.zeroLiveWorkClaim.claim).toBe('none-observed-in-scope')
        expect(manifest.epistemics.zeroLiveWorkClaim.reasons).toEqual([])
      } finally {
        store.database.close()
        await provider.close()
        await rm(path, { force: true })
      }
    })

    test('a truncated deployed observation cannot carry the strong claim', async () => {
      await withFixtureStore({}, async ({ store }) => {
        const manifest = buildManifest(store, {
          observationScope: 'deployed-dsn',
          limits: { entriesPerSection: 1 },
        })
        // In-flight work is present, and the checkpoint section was truncated
        // (two threads, one emitted): both reasons block the strong claim.
        expect(manifest.sections.checkpoints.truncated).toBe(true)
        expect(manifest.epistemics.retainedWorkClassification).toBe('present')
        expect(manifest.epistemics.zeroLiveWorkClaim.claimAllowed).toBe(false)
        expect(manifest.epistemics.zeroLiveWorkClaim.reasons).toContain('IN_FLIGHT_WORK_OBSERVED')
        expect(manifest.epistemics.zeroLiveWorkClaim.reasons).toContain(
          'CHECKPOINTS_SECTION_NOT_FULLY_READ'
        )
      })
    })

    test('the epistemics helper is a pure function over section outcomes', () => {
      const unknown = retainedWorkEpistemics({
        observationScope: 'repository-scan',
        executions: {
          status: 'unknown',
          truncated: false,
          malformedRecords: 0,
          counts: { inFlight: 0 },
        },
        checkpoints: { status: 'unknown', truncated: false, malformedRecords: 0, counts: {} },
      })
      expect(unknown.retainedWorkClassification).toBe('unknown')
      expect(Object.keys(OBSERVATION_STATUS).length).toBe(6)
      expect(OBSERVATION_SCOPES.length).toBe(3)
      expect(DISPOSITION_KINDS).toEqual(['keep', 'replace', 'drain', 'retire'])
    })
  })

  describe('deterministic output', () => {
    test('byte-stable manifests for identical store state and injected clock', async () => {
      await withFixtureStore({}, async ({ fixture }) => {
        const render = async () => {
          const store = await openReadOnlyStore(fixture.path)
          try {
            const manifest = buildManifest(store)
            return `${stableJsonStringify(manifest)}\n`
          } finally {
            store.database.close()
          }
        }
        const first = await render()
        const second = await render()
        expect(second).toBe(first)
        const parsed = JSON.parse(first)
        expect(parsed.manifest).toBe('langgraph-retirement-inventory')
        // Sorted keys, not insertion order: the first key is alphabetically first.
        expect(Object.keys(parsed)[0]).toBe('epistemics')
        expect(first).not.toContain(fixture.directory)
        expect(first).not.toContain(fixture.path)
      })
    })

    test('the injected observation time is reflected everywhere', async () => {
      await withFixtureStore({}, async ({ fixture }) => {
        const renderWithClock = async (clock) => {
          const stdout = collectStdout()
          const outcome = await runInventoryCli({
            argv: [
              '--observation-scope',
              'local-disposable-store',
              '--store',
              fixture.path,
              '--now',
              clock,
            ],
            stdout,
          })
          expect(outcome.exitCode).toBe(0)
          return stdout.text()
        }
        const first = await renderWithClock('2026-03-04T05:06:07.890Z')
        const second = await renderWithClock('2026-04-05T06:07:08.890Z')
        expect(first).toContain('"observedAt": "2026-03-04T05:06:07.890Z"')
        expect(second).toContain('"observedAt": "2026-04-05T06:07:08.890Z"')
        // Re-running with the same injected clock reproduces the same bytes.
        expect(await renderWithClock('2026-03-04T05:06:07.890Z')).toBe(first)
      })
    })
  })

  describe('disposition validator', () => {
    const workspaceOne = 'wsp_01JABCDEF0123456789ABCDEFG'
    const workspaceTwo = 'wsp_01JBBBBBBBBBBBBBBBBBBBBBB2'
    const alphaKey = {
      workspaceId: workspaceOne,
      graphDefinitionId: 'graph:inventory-alpha',
      graphVersion: '1.0.0',
    }

    function fullProposal(disposition, overrides = {}) {
      return {
        ...alphaKey,
        disposition,
        durableOwner: 'control-plane-graph-catalog',
        historyReceiptResponsibility: 'graph-definition-commands receipts remain authoritative',
        requiredBehavior: 'identical segment semantics and receipts',
        replacementEvidence: 'parity run evidence',
        rollbackEvidence: 'catalog republish procedure',
        inFlightAcknowledged: true,
        ...overrides,
      }
    }

    test('approves complete proposals and reports typed missing evidence otherwise', async () => {
      await withFixtureStore({}, async ({ store }) => {
        const manifest = buildManifest(store)
        const report = validateDispositions(
          {
            dispositions: [
              // One disposition per workflow: four distinct workflows.
              fullProposal('keep', {
                graphDefinitionId: 'graph:inventory-beta',
                graphVersion: '1.0.0',
              }),
              fullProposal('replace', { workspaceId: workspaceTwo }),
              fullProposal('drain'),
              fullProposal('retire', {
                graphVersion: '1.1.0',
                requiredBehavior: undefined,
                replacementEvidence: undefined,
                inFlightAcknowledged: undefined,
              }),
            ],
          },
          manifest
        )
        expect(report.summary).toEqual({ total: 4, approved: 4, rejected: 0, blocked: 0 })
        expect(report.verdicts.map((verdict) => verdict.verdict)).toEqual([
          'approved',
          'approved',
          'approved',
          'approved',
        ])

        const incomplete = validateDispositions(
          { dispositions: [{ ...alphaKey, disposition: 'replace', durableOwner: 'owner' }] },
          manifest
        )
        expect(incomplete.summary.rejected).toBe(1)
        expect(incomplete.verdicts[0].missingEvidence).toEqual([
          'historyReceiptResponsibility',
          'replacementEvidence',
          'requiredBehavior',
          'rollbackEvidence',
        ])
        expect(incomplete.verdicts[0].reasons).toEqual(['MISSING_REQUIRED_EVIDENCE'])
      })
    })

    test('drain must acknowledge in-flight work and retire cannot carry it', async () => {
      await withFixtureStore({}, async ({ store }) => {
        const manifest = buildManifest(store)
        const drain = validateDispositions(
          { dispositions: [fullProposal('drain', { inFlightAcknowledged: false })] },
          manifest
        )
        expect(drain.verdicts[0].verdict).toBe('rejected')
        expect(drain.verdicts[0].missingEvidence).toEqual(['inFlightAcknowledged'])
        expect(drain.verdicts[0].inventoryCounts.inFlightExecutions).toBe(1)

        const retire = validateDispositions({ dispositions: [fullProposal('retire')] }, manifest)
        expect(retire.verdicts[0].verdict).toBe('rejected')
        expect(retire.verdicts[0].reasons).toEqual(['IN_FLIGHT_WORK_PRESENT'])

        // Workspace scoping: the same graph id in another workspace has no
        // in-flight work, so its disposition is judged on its own counts.
        const otherWorkspace = validateDispositions(
          {
            dispositions: [
              fullProposal('drain', {
                workspaceId: workspaceTwo,
                inFlightAcknowledged: false,
              }),
            ],
          },
          manifest
        )
        expect(otherWorkspace.verdicts[0].verdict).toBe('approved')

        // The workflow with no in-flight work can retire cleanly.
        const betaRetire = validateDispositions(
          {
            dispositions: [
              fullProposal('retire', {
                graphDefinitionId: 'graph:inventory-beta',
                graphVersion: '1.0.0',
                requiredBehavior: undefined,
                replacementEvidence: undefined,
                inFlightAcknowledged: undefined,
              }),
            ],
          },
          manifest
        )
        expect(betaRetire.verdicts[0].verdict).toBe('approved')
        expect(betaRetire.verdicts[0].inventoryCounts.inFlightExecutions).toBe(0)
      })
    })

    test('unknown workflows, duplicates, invalid kinds, and blockers are typed', async () => {
      await withFixtureStore({}, async ({ store }) => {
        const manifest = buildManifest(store)
        const report = validateDispositions(
          {
            dispositions: [
              fullProposal('keep', { graphDefinitionId: 'graph:does-not-exist' }),
              fullProposal('keep', { workspaceId: workspaceTwo }),
              fullProposal('keep', { workspaceId: workspaceTwo }),
              fullProposal('demolish'),
              { disposition: 'keep' },
              fullProposal('keep', { unresolvedBlockers: ['waiting-for-migration-review'] }),
              'not-an-object',
            ],
          },
          manifest
        )
        const byIndex = report.verdicts
        expect(byIndex[0].reasons).toContain('WORKFLOW_NOT_IN_INVENTORY')
        expect(byIndex[1].verdict).toBe('approved')
        expect(byIndex[2].reasons).toContain('DUPLICATE_DISPOSITION')
        expect(byIndex[3].reasons).toContain('INVALID_DISPOSITION')
        expect(byIndex[4].reasons).toContain('MALFORMED_PROPOSAL')
        expect(byIndex[5].verdict).toBe('blocked')
        expect(byIndex[5].reasons).toContain('UNRESOLVED_BLOCKERS_DECLARED')
        expect(byIndex[6].reasons).toEqual(['MALFORMED_PROPOSAL'])
        expect(report.summary).toEqual({ total: 7, approved: 1, rejected: 5, blocked: 1 })
      })
    })

    test('a truncated inventory flags validation against possibly-missing workflows', async () => {
      await withFixtureStore({}, async ({ store }) => {
        const manifest = buildManifest(store, { limits: { entriesPerSection: 1 } })
        const report = validateDispositions(
          {
            dispositions: [
              fullProposal('keep', {
                workspaceId: workspaceTwo,
                graphDefinitionId: 'graph:inventory-alpha',
                graphVersion: '1.0.0',
              }),
            ],
          },
          manifest
        )
        expect(manifest.sections.definitions.truncated).toBe(true)
        expect(report.verdicts[0].reasons).toContain('WORKFLOW_NOT_IN_INVENTORY')
        expect(report.verdicts[0].reasons).toContain('INVENTORY_ENTRIES_TRUNCATED')
      })
    })

    test('malformed documents throw a typed error', () => {
      expect(() =>
        validateDispositions({ nope: true }, { sections: { definitions: { entries: [] } } })
      ).toThrow(RetirementInventoryError)
    })
  })

  describe('cli surface', () => {
    test('--help exits cleanly and documents the safety contract', async () => {
      const stdout = collectStdout()
      const outcome = await runInventoryCli({ argv: ['--help'], stdout })
      expect(outcome.action).toBe('help')
      expect(outcome.exitCode).toBe(0)
      const text = stdout.text()
      expect(text).toContain('--observation-scope')
      expect(text).toContain('read-only')
      expect(text).toContain('--validate-dispositions')
    })

    test('argument errors are typed and never touch a store', async () => {
      await expect(runInventoryCli({ argv: [] })).rejects.toMatchObject({
        code: 'INVALID_OBSERVATION_SCOPE',
      })
      await expect(
        runInventoryCli({ argv: ['--observation-scope', 'local-disposable-store'] })
      ).rejects.toMatchObject({ code: 'STORE_REQUIRED' })
      await expect(
        runInventoryCli({
          argv: ['--observation-scope', 'repository-scan', '--store', '/tmp/unused.sqlite'],
        })
      ).rejects.toMatchObject({ code: 'STORE_NOT_ALLOWED_FOR_REPOSITORY_SCAN' })
      await expect(
        runInventoryCli({
          argv: ['--observation-scope', 'deployed-dsn', '--store', '/tmp/x.sqlite', '--limit', '0'],
        })
      ).rejects.toMatchObject({ code: 'INVALID_ENTRY_LIMIT' })
    })

    test('invalid clocks and unreadable disposition files are typed', async () => {
      await expect(
        runInventoryCli({
          argv: ['--observation-scope', 'repository-scan', '--now', 'not-a-timestamp'],
        })
      ).rejects.toMatchObject({ code: 'INVALID_OBSERVED_AT' })
      await expect(
        runInventoryCli({
          argv: [
            '--observation-scope',
            'repository-scan',
            '--validate-dispositions',
            join(temporaryDirectory, 'absent.json'),
          ],
        })
      ).rejects.toMatchObject({ code: 'DISPOSITIONS_FILE_UNREADABLE' })
    })

    test('validation mode reports verdicts and exits nonzero on rejections', async () => {
      await withFixtureStore({}, async ({ fixture }) => {
        const proposalsPath = join(temporaryDirectory, 'dispositions.json')
        await writeFile(
          proposalsPath,
          JSON.stringify({
            dispositions: [
              {
                workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
                graphDefinitionId: 'graph:inventory-alpha',
                graphVersion: '1.0.0',
                disposition: 'drain',
                durableOwner: 'control-plane-graph-catalog',
                historyReceiptResponsibility: 'receipts stay authoritative',
                requiredBehavior: 'same segment semantics',
                rollbackEvidence: 'republish procedure',
              },
            ],
          }),
          { mode: 0o600 }
        )
        const stdout = collectStdout()
        const outcome = await runInventoryCli({
          argv: [
            '--observation-scope',
            'local-disposable-store',
            '--store',
            fixture.path,
            '--now',
            OBSERVED_AT,
            '--validate-dispositions',
            proposalsPath,
          ],
          stdout,
        })
        expect(outcome.exitCode).toBe(1)
        const report = JSON.parse(stdout.text())
        expect(report.validation).toBe('langgraph-retirement-dispositions')
        expect(report.verdicts[0].missingEvidence).toEqual(['inFlightAcknowledged'])
        expect(stdout.text()).not.toContain(fixture.path)
      })
    })

    test('repository-scan scope emits the curated registry without a store', async () => {
      const stdout = collectStdout()
      const outcome = await runInventoryCli({
        argv: ['--observation-scope', 'repository-scan', '--now', OBSERVED_AT],
        stdout,
      })
      expect(outcome.exitCode).toBe(0)
      const manifest = JSON.parse(stdout.text())
      expect(manifest.observationScope).toBe('repository-scan')
      expect(manifest.sections.consumers.counts.registered).toBe(4)
      expect(manifest.sections.consumers.status).toBe(OBSERVATION_STATUS.UNKNOWN)
      expect(manifest.sections.definitions.status).toBe(OBSERVATION_STATUS.UNKNOWN)
      expect(manifest.epistemics.retainedWorkClassification).toBe('unknown')
    })
  })
})
