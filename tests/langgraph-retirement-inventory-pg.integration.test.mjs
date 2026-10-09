// Integration lane coverage for the deployed-PostgreSQL retirement inventory
// collector (M16.01, #938): scripts/langgraph-retirement-inventory-pg.mjs.
//
// Every scenario derives its own disposable database exactly the way the
// repository's existing PostgreSQL integration suites do (see
// tests/fixtures/langgraph-retirement-pg-fixture.mjs — no global harness) and
// runs the collector CLI end to end against it. Covered here: exact counts and
// attribution on an intact deployed-shaped store, genuine graphless plans,
// corrupted plan digests, pin mismatches, malformed plan graph identity,
// orphan/unclassified checkpoint evidence, pagination exactness across page
// sizes, typed inaccessible sources, the deployed-dsn zero-claim rule, and the
// deterministic sanitized output contract. The reviewed SQLite inventory
// script's disposition validator is run against this collector's manifest to
// prove section-shape alignment.

import { describe, expect, test } from 'bun:test'
import process from 'node:process'
import { integrationTestTimeout } from '@control-plane/database/testing'
import { runInventoryPgCli, dsnIdentity } from '../scripts/langgraph-retirement-inventory-pg.mjs'
import {
  stableJsonStringify,
  validateDispositions,
} from '../scripts/langgraph-retirement-inventory.mjs'
import { createInventoryPgFixture } from './fixtures/langgraph-retirement-pg-fixture.mjs'

const OBSERVED_AT = '2026-10-08T00:00:00.000Z'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'

/**
 * Runs the real CLI against the fixture DSN and returns both the parsed
 * manifest and the raw stdout text (for the determinism and redaction
 * assertions). The DSN is always explicit; no environment fallback is in
 * play, so the suite never touches a shared database.
 */
async function collectFromFixture(
  fixture,
  { scope = 'deployed-dsn', now = OBSERVED_AT, limit, pageSize } = {}
) {
  const chunks = []
  const stdout = { write: (text) => (chunks.push(text), true) }
  const outcome = await runInventoryPgCli({
    argv: [
      '--observation-scope',
      scope,
      '--dsn',
      fixture.dsn,
      '--now',
      now,
      ...(limit === undefined ? [] : ['--limit', String(limit)]),
      ...(pageSize === undefined ? [] : ['--page-size', String(pageSize)]),
    ],
    now: () => now,
    stdout,
  })
  expect(outcome.exitCode).toBe(0)
  const text = chunks.join('')
  return { manifest: JSON.parse(text), text }
}

async function withFixture(options, run) {
  const fixture = await createInventoryPgFixture(options)
  try {
    return await run(fixture)
  } finally {
    await fixture.cleanup()
  }
}

describe.skipIf(!enabled)('LangGraph retirement inventory PG collector', () => {
  test(
    'observes the deployed catalog with exact attributed counts',
    async () => {
      await withFixture({}, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        expect(manifest.manifest).toBe('langgraph-retirement-inventory-pg')
        expect(manifest.observationScope).toBe('deployed-dsn')
        expect(manifest.observedAt).toBe(OBSERVED_AT)
        expect(manifest.store.backend).toBe('postgres-dsn')
        expect(manifest.store.status).toBe('observed')
        expect(manifest.store.identity).toBe(dsnIdentity(fixture.dsn))
        expect(manifest.tool.mutations).toBe('none')

        const definitions = manifest.sections.definitions
        expect(definitions.status).toBe('observed')
        expect(definitions.counts).toEqual({
          total: 4,
          workspaces: 2,
          distinctGraphs: 3,
          byLifecycle: { deprecated: 1, published: 3 },
        })
        expect(definitions.truncated).toBe(false)
        expect(definitions.malformedRecords).toBe(0)
        const alpha = definitions.entries.find(
          (entry) =>
            entry.workspaceId === fixture.ids.workspaceOne &&
            entry.graphDefinitionId === 'graph:inventory-alpha' &&
            entry.graphVersion === '1.0.0'
        )
        expect(alpha.consumersObserved).toEqual({
          catalogCommands: 1,
          checkpointRows: 3,
          inFlightExecutions: 1,
          retainedExecutions: 1,
        })
        const alphaNext = definitions.entries.find(
          (entry) =>
            entry.workspaceId === fixture.ids.workspaceOne && entry.graphVersion === '1.1.0'
        )
        expect(alphaNext.lifecycle).toBe('deprecated')
        expect(typeof alphaNext.reason).toBe('string')

        const consumers = manifest.sections.consumers
        expect(consumers.status).toBe('observed')
        expect(consumers.counts).toEqual({
          registered: 4,
          catalogCommandReceipts: 2,
          distinctCatalogCallers: 2,
        })
        expect(
          consumers.entries.filter((entry) => entry.kind === 'catalog-command-caller')
        ).toHaveLength(2)
        expect(
          consumers.entries.filter((entry) => entry.observation?.evidence === 'curated-registry')
        ).toHaveLength(4)

        const executions = manifest.sections.executions
        expect(executions.status).toBe('observed')
        expect(executions.counts).toEqual({
          total: 2,
          inFlight: 1,
          terminal: 1,
          inFlightAttributed: 1,
          inFlightPlansWithMalformedGraphIdentity: 0,
          inFlightNonGraph: 0,
          inFlightPlansMissing: 0,
          byState: { cancelled: 1, running: 1 },
        })
        expect(executions.entries).toHaveLength(1)
        expect(executions.entries[0]).toMatchObject({
          executionId: fixture.ids.executionRunning,
          state: 'running',
          graphWorkflow: true,
          graphReference: {
            graphDefinitionId: 'graph:inventory-alpha',
            graphVersion: '1.0.0',
          },
        })

        const checkpoints = manifest.sections.checkpoints
        expect(checkpoints.status).toBe('observed')
        expect(checkpoints.counts).toEqual({
          total: 4,
          checkpointRows: 3,
          blobRows: 0,
          writeRows: 1,
          distinctThreads: 2,
          unclassifiedThreads: 0,
          threadsOnInFlightExecutions: 1,
          threadsOnUnknownExecutions: 0,
        })
        expect(manifest.historyOwnership.cancellationReceipts.count).toBe(0)

        expect(manifest.epistemics.retainedWorkClassification).toBe('present')
        expect(manifest.epistemics.zeroLiveWorkClaim.claimAllowed).toBe(false)
        expect(manifest.epistemics.zeroLiveWorkClaim.reasons).toEqual(['IN_FLIGHT_WORK_OBSERVED'])
      })
    },
    integrationTestTimeout()
  )

  test(
    'the reviewed disposition validator consumes the manifest unchanged',
    async () => {
      await withFixture({}, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        const evidence = {
          durableOwner: 'control-plane-graph-catalog',
          historyReceiptResponsibility: 'receipts retained in the store',
          rollbackEvidence: 'catalog restore point recorded',
        }
        const report = validateDispositions(
          {
            dispositions: [
              {
                workspaceId: fixture.ids.workspaceOne,
                graphDefinitionId: 'graph:inventory-alpha',
                graphVersion: '1.0.0',
                disposition: 'retire',
                ...evidence,
              },
              {
                workspaceId: fixture.ids.workspaceOne,
                graphDefinitionId: 'graph:inventory-beta',
                graphVersion: '1.0.0',
                disposition: 'retire',
                ...evidence,
              },
            ],
          },
          manifest
        )
        expect(report.summary).toEqual({ total: 2, approved: 1, rejected: 1, blocked: 0 })
        const alpha = report.verdicts[0]
        expect(alpha.verdict).toBe('rejected')
        expect(alpha.reasons).toContain('IN_FLIGHT_WORK_PRESENT')
        expect(alpha.inventoryCounts.inFlightExecutions).toBe(1)
        const beta = report.verdicts[1]
        expect(beta.verdict).toBe('approved')
      })
    },
    integrationTestTimeout()
  )

  test(
    'a genuine graphless plan classifies non-graph and never blocks attribution',
    async () => {
      await withFixture({ compileRunningPlanGraphless: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        const executions = manifest.sections.executions
        expect(executions.status).toBe('observed')
        expect(executions.counts.inFlightNonGraph).toBe(1)
        expect(executions.counts.inFlightAttributed).toBe(0)
        expect(executions.counts.inFlightPlansWithMalformedGraphIdentity).toBe(0)
        expect(executions.reasons).toEqual([])
        expect(executions.entries[0].graphWorkflow).toBe(false)
        expect(manifest.epistemics.retainedWorkClassification).toBe('present')
      })
    },
    integrationTestTimeout()
  )

  test(
    'corrupted plan content blocks attribution and every zero claim',
    async () => {
      await withFixture({ corruptRunningPlanContent: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        const executions = manifest.sections.executions
        expect(executions.status).toBe('incomplete')
        expect(executions.reasons).toEqual(['PLAN_GRAPH_IDENTITY_MALFORMED'])
        expect(executions.counts.inFlightPlansWithMalformedGraphIdentity).toBe(1)
        expect(executions.entries[0].graphWorkflow).toBe(false)
        expect(manifest.epistemics.zeroLiveWorkClaim.reasons).toContain(
          'EXECUTIONS_SECTION_NOT_FULLY_READ'
        )

        const report = validateDispositions(
          {
            dispositions: [
              {
                workspaceId: fixture.ids.workspaceOne,
                graphDefinitionId: 'graph:inventory-beta',
                graphVersion: '1.0.0',
                disposition: 'retire',
                durableOwner: 'control-plane-graph-catalog',
                historyReceiptResponsibility: 'receipts retained in the store',
                rollbackEvidence: 'catalog restore point recorded',
              },
            ],
          },
          manifest
        )
        expect(report.verdicts[0].verdict).toBe('blocked')
        expect(report.verdicts[0].reasons).toContain('PLAN_GRAPH_IDENTITY_MALFORMED')
      })
    },
    integrationTestTimeout()
  )

  test(
    'a pin naming a foreign plan digest leaves the execution unattributable',
    async () => {
      await withFixture({ mutateRunningExecutionPin: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        const executions = manifest.sections.executions
        expect(executions.status).toBe('incomplete')
        expect(executions.reasons).toEqual(['PLAN_GRAPH_IDENTITY_MALFORMED'])
        expect(executions.counts.inFlightPlansWithMalformedGraphIdentity).toBe(1)
        expect(executions.counts.inFlightAttributed).toBe(0)
        expect(executions.entries[0].graphReference).toBeUndefined()
      })
    },
    integrationTestTimeout()
  )

  test(
    'malformed plan graph identity is never benignly bucketed as graphless',
    async () => {
      await withFixture({ mutateRunningPlanGraphIdentity: 'missing-graph-id' }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        const executions = manifest.sections.executions
        expect(executions.counts.inFlightPlansWithMalformedGraphIdentity).toBe(1)
        expect(executions.counts.inFlightNonGraph).toBe(0)
        expect(executions.counts.inFlightAttributed).toBe(0)
      })
      await withFixture(
        { mutateRunningPlanGraphIdentity: 'invalid-graph-version' },
        async (fixture) => {
          const { manifest } = await collectFromFixture(fixture)
          expect(manifest.sections.executions.counts.inFlightPlansWithMalformedGraphIdentity).toBe(
            1
          )
        }
      )
    },
    integrationTestTimeout()
  )

  test(
    'orphan and unclassified checkpoint threads block zero claims and retirement',
    async () => {
      await withFixture(
        { injectOrphanCheckpoint: true, injectUnclassifiedCheckpoint: true },
        async (fixture) => {
          const { manifest } = await collectFromFixture(fixture)
          const checkpoints = manifest.sections.checkpoints
          expect(checkpoints.status).toBe('incomplete')
          expect(checkpoints.reasons).toEqual([
            'CHECKPOINT_THREADS_UNCLASSIFIED',
            'CHECKPOINT_THREADS_WITH_UNKNOWN_EXECUTION_STATE',
          ])
          expect(checkpoints.counts.unclassifiedThreads).toBe(1)
          expect(checkpoints.counts.threadsOnUnknownExecutions).toBe(1)

          const report = validateDispositions(
            {
              dispositions: [
                {
                  workspaceId: fixture.ids.workspaceOne,
                  graphDefinitionId: 'graph:inventory-beta',
                  graphVersion: '1.0.0',
                  disposition: 'retire',
                  durableOwner: 'control-plane-graph-catalog',
                  historyReceiptResponsibility: 'receipts retained in the store',
                  rollbackEvidence: 'catalog restore point recorded',
                },
              ],
            },
            manifest
          )
          expect(report.verdicts[0].verdict).toBe('blocked')
          expect(report.verdicts[0].reasons).toContain('CHECKPOINT_EVIDENCE_UNKNOWN')
        }
      )
    },
    integrationTestTimeout()
  )

  test(
    'exact counts survive pagination and stay independent of the page size',
    async () => {
      await withFixture(
        { volume: { definitionRows: 150, checkpointThreads: 20 } },
        async (fixture) => {
          const small = await collectFromFixture(fixture, { pageSize: 7, limit: 1000 })
          const large = await collectFromFixture(fixture, { pageSize: 64, limit: 1000 })
          for (const { manifest } of [small, large]) {
            expect(manifest.sections.definitions.counts.total).toBe(154)
            expect(manifest.sections.definitions.truncated).toBe(false)
            const checkpoints = manifest.sections.checkpoints
            expect(checkpoints.counts.total).toBe(44)
            expect(checkpoints.counts.checkpointRows).toBe(23)
            expect(checkpoints.counts.writeRows).toBe(21)
            expect(checkpoints.counts.distinctThreads).toBe(22)
            expect(checkpoints.counts.threadsOnUnknownExecutions).toBe(20)
          }
          expect(JSON.stringify(small.manifest.sections.definitions.counts)).toEqual(
            JSON.stringify(large.manifest.sections.definitions.counts)
          )
          // The default entry bound truncates the emitted entries but never
          // the counts, and the section downgrades to incomplete.
          const bounded = await collectFromFixture(fixture)
          expect(bounded.manifest.sections.definitions.counts.total).toBe(154)
          expect(bounded.manifest.sections.definitions.truncated).toBe(true)
          expect(bounded.manifest.sections.definitions.status).toBe('incomplete')
          expect(bounded.manifest.sections.definitions.reasons).toEqual(['ENTRY_LIMIT_REACHED'])
          // Entries stay in a deterministic workspace-scoped order.
          const order = bounded.manifest.sections.definitions.entries.map(
            (entry) =>
              `${entry.workspaceId}\u0000${entry.graphDefinitionId}\u0000${entry.graphVersion}`
          )
          expect(order).toEqual([...order].toSorted())
        }
      )
    },
    integrationTestTimeout()
  )

  test(
    'an unreachable source is typed inaccessible, never zero and never a crash',
    async () => {
      const chunks = []
      const outcome = await runInventoryPgCli({
        argv: [
          '--observation-scope',
          'deployed-dsn',
          '--dsn',
          'postgresql://control_plane_app:local-application-only@127.0.0.1:59999/control_plane',
          '--now',
          OBSERVED_AT,
        ],
        now: () => OBSERVED_AT,
        stdout: { write: (text) => (chunks.push(text), true) },
      })
      expect(outcome.exitCode).toBe(0)
      const manifest = JSON.parse(chunks.join(''))
      expect(manifest.store.status).toBe('inaccessible')
      expect(manifest.store.reasons).toEqual(['CONNECTION_FAILED'])
      for (const section of Object.values(manifest.sections)) {
        expect(section.status).toBe('unknown')
        expect(section.status).not.toBe('zero')
        // The consumers section carries the extra CURATED_REGISTRY_ONLY
        // reason; every section reports the observation as out of scope.
        expect(section.reasons).toContain('SOURCE_NOT_IN_OBSERVATION_SCOPE')
      }
      expect(manifest.epistemics.zeroLiveWorkClaim.claimAllowed).toBe(false)
      expect(manifest.epistemics.retainedWorkClassification).toBe('unknown')
    },
    integrationTestTimeout()
  )

  test(
    'only a fully-read attested deployed-dsn observation may conclude zero in scope',
    async () => {
      await withFixture({ seedRunningExecution: false }, async (fixture) => {
        const attested = await collectFromFixture(fixture, { scope: 'deployed-dsn' })
        expect(attested.manifest.sections.executions.status).toBe('zero')
        expect(attested.manifest.sections.checkpoints.status).toBe('zero')
        expect(attested.manifest.epistemics.retainedWorkClassification).toBe(
          'none-observed-in-scope'
        )
        expect(attested.manifest.epistemics.zeroLiveWorkClaim).toEqual({
          claimAllowed: true,
          claim: 'none-observed-in-scope',
          reasons: [],
        })

        const unattested = await collectFromFixture(fixture, {
          scope: 'local-disposable-store',
        })
        expect(unattested.manifest.epistemics.retainedWorkClassification).toBe('unknown')
        expect(unattested.manifest.epistemics.zeroLiveWorkClaim.claimAllowed).toBe(false)
        expect(unattested.manifest.epistemics.zeroLiveWorkClaim.reasons).toContain(
          // The reviewed epistemics encoding uppercases the scope verbatim.
          'OBSERVATION_SCOPE_LOCAL-DISPOSABLE-STORE_CANNOT_ESTABLISH_ZERO_LIVE_WORK'
        )
      })
    },
    integrationTestTimeout()
  )

  test(
    'evidence older than the freshness threshold is stale and blocks zero claims',
    async () => {
      await withFixture({ backdateExecutions: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        const executions = manifest.sections.executions
        expect(executions.status).toBe('stale')
        expect(executions.reasons).toEqual(['FRESHNESS_THRESHOLD_EXCEEDED'])
        // Stale evidence is not fully-read evidence: the zero claim stays
        // unavailable even with no in-flight work besides the seeded one.
        expect(manifest.epistemics.zeroLiveWorkClaim.claimAllowed).toBe(false)
        expect(manifest.epistemics.zeroLiveWorkClaim.reasons).toContain('IN_FLIGHT_WORK_OBSERVED')
      })
    },
    integrationTestTimeout()
  )

  test(
    'output is byte-deterministic and sanitized',
    async () => {
      await withFixture({}, async (fixture) => {
        const first = await collectFromFixture(fixture)
        const second = await collectFromFixture(fixture)
        expect(first.text).toEqual(second.text)
        expect(first.text.trim()).toEqual(`${stableJsonStringify(first.manifest)}`.trim())

        const databaseName = new URL(fixture.dsn).pathname.slice(1)
        for (const secret of [
          'postgresql://',
          'postgres://',
          '127.0.0.1',
          'local-application-only',
          'control_plane_app',
          databaseName,
          fixture.dsn,
          '@',
          // Record payloads and plan internals never leak: identifiers only.
          'channel_values',
          'roleInstructions',
          'fixture-write-ck',
          'store-json',
        ]) {
          expect(first.text.includes(secret)).toBe(false)
        }
        expect(first.manifest.store.identity).toMatch(/^sha256:[0-9a-f]{64}$/)
      })
    },
    integrationTestTimeout()
  )

  test(
    'the CLI refuses to guess a target, scope, or malformed DSN',
    async () => {
      await expect(
        runInventoryPgCli({
          argv: ['--observation-scope', 'deployed-dsn', '--now', OBSERVED_AT],
          now: () => OBSERVED_AT,
          environment: {},
          stdout: { write: () => true },
        })
      ).rejects.toMatchObject({ code: 'DSN_REQUIRED' })
      await expect(
        runInventoryPgCli({
          argv: ['--observation-scope', 'bogus'],
          now: () => OBSERVED_AT,
          stdout: { write: () => true },
        })
      ).rejects.toMatchObject({ code: 'INVALID_OBSERVATION_SCOPE' })
      await expect(
        runInventoryPgCli({
          argv: [
            '--observation-scope',
            'repository-scan',
            '--dsn',
            'postgresql://control_plane_app:local-application-only@127.0.0.1:54329/control_plane',
          ],
          now: () => OBSERVED_AT,
          stdout: { write: () => true },
        })
      ).rejects.toMatchObject({ code: 'DSN_NOT_ALLOWED_FOR_REPOSITORY_SCAN' })
      await expect(
        runInventoryPgCli({
          argv: ['--observation-scope', 'deployed-dsn', '--dsn', 'not-a-dsn'],
          now: () => OBSERVED_AT,
          stdout: { write: () => true },
        })
      ).rejects.toMatchObject({ code: 'INVALID_DSN' })
    },
    integrationTestTimeout()
  )
})
