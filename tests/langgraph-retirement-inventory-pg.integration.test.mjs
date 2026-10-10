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
import {
  runInventoryPgCli,
  dsnIdentity,
  observeReadOnly,
} from '../scripts/langgraph-retirement-inventory-pg.mjs'
import {
  stableJsonStringify,
  validateDispositions,
} from '../scripts/langgraph-retirement-inventory.mjs'
import {
  GraphDefinitionCatalog,
  InMemoryGraphDefinitionRepository,
} from '@control-plane/orchestration'
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
  { scope = 'deployed-dsn', now = OBSERVED_AT, limit, pageSize, maxPages } = {}
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
      ...(maxPages === undefined ? [] : ['--max-pages', String(maxPages)]),
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

/** Single-column scalar read helper for the snapshot-coherence probes. */
async function countOf(transaction, text) {
  const rows = await transaction.unsafe(text)
  return Number(rows[0]?.count)
}

async function stateOfExecution(transaction, executionId) {
  const rows = await transaction.unsafe('select state from executions where execution_id = $1', [
    executionId,
  ])
  return rows[0]?.state
}

/**
 * Canonical content for a test-seeded published definition; the concurrent
 * writer publishes it through the real catalog so the reference digest binds
 * the content exactly the way the deployed persistence path does.
 */
function graphDefinitionRow(graphDefinitionId, graphVersion) {
  return {
    graphDefinitionId,
    graphVersion,
    schemaVersion: 1,
    nodes: [{ node: 'prepare', operation: { kind: 'runtime', name: 'prepare' } }],
    edges: [
      { from: '__start__', to: 'prepare' },
      { from: 'prepare', to: '__end__' },
    ],
    schemas: { input: 'schema:json', state: 'schema:json', output: 'schema:json' },
    requiredCapabilities: [],
    compatibility: {
      contractMajorVersions: [1],
      compilerVersions: ['1.0.0'],
      adapterVersions: ['1.0.0'],
    },
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
          identityMismatches: 0,
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
          incompleteUsageSources: [],
          inFlightExecutions: 1,
          retainedExecutions: 1,
          usageComplete: true,
        })
        const alphaNext = definitions.entries.find(
          (entry) =>
            entry.workspaceId === fixture.ids.workspaceOne && entry.graphVersion === '1.1.0'
        )
        expect(alphaNext.lifecycle).toBe('deprecated')
        // Lifecycle reasons are operator free text: only the presence
        // indicator is emitted, never the text itself.
        expect(alphaNext.reasonPresent).toBe(true)
        expect(alphaNext).not.toHaveProperty('reason')
        expect(alpha.reasonPresent).toBe(false)

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
    'orphan checkpoint_blobs threads are classified and block no-live-work conclusions',
    async () => {
      // The purest form of the orphan-blob finding: no executions, no
      // checkpoint or write rows at all — the store's only resume-state
      // evidence is two checkpoint_blobs rows whose threads nothing else
      // explains. Counting the rows without classifying their threads would
      // let this store read as fully-observed zero live work.
      await withFixture(
        { seedRunningExecution: false, injectOrphanBlob: true, injectUnclassifiedBlob: true },
        async (fixture) => {
          const { manifest } = await collectFromFixture(fixture)
          expect(manifest.sections.executions.status).toBe('zero')

          const checkpoints = manifest.sections.checkpoints
          expect(checkpoints.counts).toEqual({
            total: 2,
            checkpointRows: 0,
            blobRows: 2,
            writeRows: 0,
            distinctThreads: 2,
            unclassifiedThreads: 1,
            threadsOnInFlightExecutions: 0,
            threadsOnUnknownExecutions: 1,
          })
          expect(checkpoints.status).toBe('incomplete')
          expect(checkpoints.reasons).toEqual([
            'CHECKPOINT_THREADS_UNCLASSIFIED',
            'CHECKPOINT_THREADS_WITH_UNKNOWN_EXECUTION_STATE',
          ])
          expect(checkpoints.entries).toHaveLength(2)
          for (const entry of checkpoints.entries) {
            expect(entry.blobRows).toBe(1)
            expect(entry.checkpointRows).toBe(0)
            expect(entry.writeRows).toBe(0)
            expect(entry.graphWorkflow).toBe(false)
          }

          expect(manifest.epistemics.retainedWorkClassification).toBe('unknown')
          expect(manifest.epistemics.zeroLiveWorkClaim.claimAllowed).toBe(false)
          expect(manifest.epistemics.zeroLiveWorkClaim.claim).toBe('not-claimable')
          expect(manifest.epistemics.zeroLiveWorkClaim.reasons).toEqual([
            'CHECKPOINT_THREADS_UNCLASSIFIED',
            'CHECKPOINT_THREADS_WITH_UNKNOWN_EXECUTION_STATE',
            'CHECKPOINTS_SECTION_NOT_FULLY_READ',
          ])

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
          // the counts, and the section downgrades to incomplete. The volume
          // threads name executions no executions row carries, so the
          // checkpoint feed's usage attribution is incomplete as well.
          const bounded = await collectFromFixture(fixture)
          expect(bounded.manifest.sections.definitions.counts.total).toBe(154)
          expect(bounded.manifest.sections.definitions.truncated).toBe(true)
          expect(bounded.manifest.sections.definitions.status).toBe('incomplete')
          expect(bounded.manifest.sections.definitions.reasons).toEqual([
            'CHECKPOINTS_USAGE_INCOMPLETE',
            'ENTRY_LIMIT_REACHED',
          ])
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
    'a pagination bound flags every affected section, bounds its counts, and blocks zero claims',
    async () => {
      // Retained work with zero in-flight evidence (both executions terminal):
      // only the pagination bound may stand between this store and the
      // none-observed-in-scope classification. One page of one row per table
      // guarantees every scanned table hits the bound.
      await withFixture({ settleRunningExecution: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture, {
          pageSize: 1,
          maxPages: 1,
          limit: 1000,
        })

        const definitions = manifest.sections.definitions
        expect(definitions.status).toBe('incomplete')
        expect(definitions.reasons).toEqual([
          'CATALOG_COMMAND_INDEX_PAGINATION_BOUND_REACHED',
          'CHECKPOINTS_USAGE_INCOMPLETE',
          'EXECUTIONS_USAGE_INCOMPLETE',
          'PAGINATION_BOUND_REACHED',
        ])
        expect(definitions.counts.total).toBe(1)
        expect(definitions.boundReached).toBe(true)
        expect(definitions.countsBounded).toBe(true)
        expect(definitions.truncated).toBe(false)

        const consumers = manifest.sections.consumers
        expect(consumers.status).toBe('incomplete')
        expect(consumers.reasons).toEqual(['PAGINATION_BOUND_REACHED'])
        expect(consumers.counts.catalogCommandReceipts).toBe(1)
        expect(consumers.counts.distinctCatalogCallers).toBe(1)
        expect(consumers.boundReached).toBe(true)
        expect(consumers.countsBounded).toBe(true)

        // Both the executions scan and the plan-attribution index scan hit
        // the bound, so the section carries both typed reasons.
        const executions = manifest.sections.executions
        expect(executions.status).toBe('incomplete')
        expect(executions.reasons).toEqual([
          'PAGINATION_BOUND_REACHED',
          'PLAN_INDEX_PAGINATION_BOUND_REACHED',
        ])
        expect(executions.counts.total).toBe(1)
        expect(executions.counts.inFlight).toBe(0)
        expect(executions.boundReached).toBe(true)
        expect(executions.countsBounded).toBe(true)

        const checkpoints = manifest.sections.checkpoints
        expect(checkpoints.status).toBe('incomplete')
        expect(checkpoints.reasons).toEqual(['PAGINATION_BOUND_REACHED'])
        expect(checkpoints.counts.total).toBe(2)
        expect(checkpoints.boundReached).toBe(true)
        expect(checkpoints.countsBounded).toBe(true)

        // No in-flight work anywhere — but the bounded reads make the
        // zero-claim unavailable with the section-level typed reasons. The
        // reviewed epistemics encoding lists the reasons in section order.
        expect(manifest.epistemics.retainedWorkClassification).toBe('unknown')
        expect(manifest.epistemics.zeroLiveWorkClaim.claimAllowed).toBe(false)
        expect(manifest.epistemics.zeroLiveWorkClaim.claim).toBe('not-claimable')
        expect(manifest.epistemics.zeroLiveWorkClaim.reasons).toEqual([
          'EXECUTIONS_SECTION_NOT_FULLY_READ',
          'CHECKPOINTS_SECTION_NOT_FULLY_READ',
        ])
      })
    },
    integrationTestTimeout()
  )

  test(
    'definition-level usage counts carry the incompleteness of their feeding scans',
    async () => {
      // 1. Attribution is incomplete without any pagination bound: the running
      // execution's plan content is corrupted, so its rows never reach the
      // per-graph usage maps. The definition's usage then reads exact zero
      // from a partial feed — it must be flagged instead.
      await withFixture({ corruptRunningPlanContent: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        expect(manifest.sections.executions.status).toBe('incomplete')
        const definitions = manifest.sections.definitions
        expect(definitions.status).toBe('incomplete')
        expect(definitions.reasons).toEqual(['EXECUTIONS_USAGE_INCOMPLETE'])
        expect(definitions.boundReached).toBe(false)
        expect(definitions.countsBounded).toBe(false)
        const alpha = definitions.entries.find(
          (entry) =>
            entry.workspaceId === fixture.ids.workspaceOne &&
            entry.graphDefinitionId === 'graph:inventory-alpha' &&
            entry.graphVersion === '1.0.0'
        )
        expect(alpha.consumersObserved.inFlightExecutions).toBe(0)
        expect(alpha.consumersObserved.usageComplete).toBe(false)
        expect(alpha.consumersObserved.incompleteUsageSources).toEqual(['executions'])
      })

      // 2. Every feed bounded by the pagination limit: each emitted entry
      // names all three incomplete sources rather than presenting its lower
      // bounds as exact usage.
      await withFixture({ settleRunningExecution: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture, {
          pageSize: 1,
          maxPages: 1,
          limit: 1000,
        })
        const definitions = manifest.sections.definitions
        expect(definitions.status).toBe('incomplete')
        expect(definitions.reasons).toEqual([
          'CATALOG_COMMAND_INDEX_PAGINATION_BOUND_REACHED',
          'CHECKPOINTS_USAGE_INCOMPLETE',
          'EXECUTIONS_USAGE_INCOMPLETE',
          'PAGINATION_BOUND_REACHED',
        ])
        expect(definitions.entries.length).toBeGreaterThan(0)
        for (const entry of definitions.entries) {
          expect(entry.consumersObserved.usageComplete).toBe(false)
          expect(entry.consumersObserved.incompleteUsageSources).toEqual([
            'catalogCommands',
            'checkpoints',
            'executions',
          ])
        }
      })
    },
    integrationTestTimeout()
  )

  test(
    'malformed or unattributable catalog receipts block exact per-definition usage claims',
    async () => {
      await withFixture({ injectMalformedCatalogReceipt: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        const definitions = manifest.sections.definitions
        expect(definitions.status).toBe('incomplete')
        expect(definitions.reasons).toEqual(['CATALOG_COMMAND_RECEIPTS_MALFORMED'])
        expect(definitions.boundReached).toBe(false)
        expect(definitions.countsBounded).toBe(false)
        // The definition rows themselves are intact; the malformed evidence is
        // in the catalog-command receipt feed.
        expect(definitions.malformedRecords).toBe(0)
        // Only canonical, identity-matching receipts attribute: the three
        // injected rows (null receipt, missing canonical envelope, foreign
        // workspace identity) are counted as malformed — never silently
        // skipped, never attributed to a graph.
        const alpha = definitions.entries.find(
          (entry) =>
            entry.workspaceId === fixture.ids.workspaceOne &&
            entry.graphDefinitionId === 'graph:inventory-alpha' &&
            entry.graphVersion === '1.0.0'
        )
        expect(alpha.consumersObserved.catalogCommands).toBe(1)
        expect(alpha.consumersObserved.usageComplete).toBe(false)
        expect(alpha.consumersObserved.incompleteUsageSources).toEqual(['catalogCommands'])
        for (const entry of definitions.entries) {
          expect(entry.consumersObserved.usageComplete).toBe(false)
          expect(entry.consumersObserved.incompleteUsageSources).toEqual(['catalogCommands'])
        }
        // The consumers section reads the same rows by caller identity and
        // stays intact: three injected rows join callerOne, adding counts but
        // no new caller.
        const consumers = manifest.sections.consumers
        expect(consumers.status).toBe('observed')
        expect(consumers.counts.catalogCommandReceipts).toBe(5)
        expect(consumers.counts.distinctCatalogCallers).toBe(2)
      })
    },
    integrationTestTimeout()
  )

  test(
    'malformed definition jsonb is typed incomplete evidence, never observed metadata',
    async () => {
      await withFixture({ injectMalformedDefinition: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        const definitions = manifest.sections.definitions
        expect(definitions.status).toBe('incomplete')
        expect(definitions.reasons).toContain('MALFORMED_RECORDS_PRESENT')
        // Six rows read: the four intact definitions plus the two injections.
        expect(definitions.counts.total).toBe(6)
        expect(definitions.malformedRecords).toBe(2)
        expect(definitions.counts.identityMismatches).toBe(0)
        // Neither malformed record surfaces as an entry with guessed or
        // fallback metadata: the lifecycle-outside-enum row and the
        // digest-unbound row are both rejected by the canonical schema.
        for (const graphDefinitionId of ['graph:malformed-lifecycle', 'graph:malformed-digest']) {
          expect(
            definitions.entries.find((entry) => entry.graphDefinitionId === graphDefinitionId)
          ).toBeUndefined()
        }
        // The intact definitions are unaffected.
        expect(
          definitions.entries.find(
            (entry) =>
              entry.workspaceId === fixture.ids.workspaceOne &&
              entry.graphDefinitionId === 'graph:inventory-alpha' &&
              entry.graphVersion === '1.0.0'
          )
        ).toBeDefined()
      })
    },
    integrationTestTimeout()
  )

  test(
    'a canonical definition stored under a foreign row identity is rejected explicitly',
    async () => {
      await withFixture({ injectMismatchedDefinitionIdentity: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        const definitions = manifest.sections.definitions
        // The jsonb itself is canonically valid, so this is not malformed
        // evidence — it is an explicit identity/revision binding failure.
        expect(definitions.malformedRecords).toBe(0)
        expect(definitions.counts.identityMismatches).toBe(1)
        expect(definitions.status).toBe('incomplete')
        expect(definitions.reasons).toEqual(['DEFINITION_IDENTITY_MISMATCH'])
        // Neither the row's identity nor the canonical record's identity
        // surfaces as an inventory entry.
        for (const graphDefinitionId of ['graph:mismatched-row', 'graph:mismatched-content']) {
          expect(
            definitions.entries.find((entry) => entry.graphDefinitionId === graphDefinitionId)
          ).toBeUndefined()
        }
        // Canonical records that do bind their rows keep their evidence.
        expect(
          definitions.entries.find(
            (entry) =>
              entry.workspaceId === fixture.ids.workspaceOne &&
              entry.graphDefinitionId === 'graph:inventory-alpha' &&
              entry.graphVersion === '1.0.0'
          )
        ).toBeDefined()
      })
    },
    integrationTestTimeout()
  )

  test(
    'lifecycle reason free text never reaches the manifest, only its presence indicator',
    async () => {
      const canaryReason =
        'revoke after credential rotation postgresql://ops:canary-password@inventory-db.internal:5432/control_plane?token=canary-token-123'
      await withFixture({ canaryLifecycleReason: canaryReason }, async (fixture) => {
        const { manifest, text } = await collectFromFixture(fixture)
        // The canary DSN/credential fragments seeded as the revocation reason
        // are absent from the byte-exact output…
        for (const secret of ['canary-password', 'inventory-db.internal', 'canary-token-123']) {
          expect(text.includes(secret)).toBe(false)
        }
        // …as is the reviewed fixture's deprecation reason, which every
        // seeded store carries on the deprecated alphaNext row.
        expect(text.includes('superseded by the workflow migration candidate')).toBe(false)

        const definitions = manifest.sections.definitions
        const revoked = definitions.entries.find(
          (entry) =>
            entry.workspaceId === fixture.ids.workspaceOne &&
            entry.graphDefinitionId === 'graph:inventory-beta' &&
            entry.graphVersion === '1.0.0'
        )
        expect(revoked.lifecycle).toBe('revoked')
        // Only the bounded, non-sensitive presence indicator is emitted.
        expect(revoked.reasonPresent).toBe(true)
        expect(revoked).not.toHaveProperty('reason')
        expect(definitions.counts.byLifecycle).toEqual({ deprecated: 1, published: 2, revoked: 1 })
      })
    },
    integrationTestTimeout()
  )

  test(
    'a failed catalog-command index scan is typed, never read back as an empty exact index',
    async () => {
      await withFixture({ revokeCatalogCommandsRead: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        // The consumers scan touches the revoked table first and fails, so the
        // single snapshot is already aborted when the attribution index and
        // the definitions scan run: every later section reports a typed
        // TABLE_SCAN_FAILED. The failure never resurrects as an empty exact
        // index or as usageComplete zeros.
        const definitions = manifest.sections.definitions
        expect(definitions.status).toBe('inaccessible')
        expect(definitions.reasons).toEqual(['TABLE_SCAN_FAILED'])
        expect(definitions.counts.total).toBe(0)
        expect(definitions.entries).toEqual([])
        expect(definitions.boundReached).toBe(false)
        const consumers = manifest.sections.consumers
        expect(consumers.status).toBe('inaccessible')
        expect(consumers.reasons).toEqual(['TABLE_SCAN_FAILED'])
        // Sections observed before the first failure keep their evidence.
        expect(manifest.sections.executions.status).toBe('observed')
      })
    },
    integrationTestTimeout()
  )

  test(
    'a failed catalog-command attribution index downgrades per-definition usage with a typed reason',
    async () => {
      await withFixture({ restrictCatalogCommandsColumns: true }, async (fixture) => {
        const { manifest } = await collectFromFixture(fixture)
        // The column restriction leaves the consumers scan readable (it never
        // selects payload_hash) but fails the attribution index, which must
        // validate receipt/row identity through payload_hash. The savepoint
        // keeps the rest of the snapshot usable, so the definitions section
        // survives and carries the failure into every entry's usage state.
        const definitions = manifest.sections.definitions
        expect(definitions.status).toBe('incomplete')
        expect(definitions.reasons).toEqual(['CATALOG_COMMAND_INDEX_SCAN_FAILED'])
        expect(definitions.boundReached).toBe(false)
        expect(definitions.countsBounded).toBe(false)
        expect(definitions.counts.total).toBeGreaterThan(0)
        for (const entry of definitions.entries) {
          expect(entry.consumersObserved.catalogCommands).toBe(0)
          expect(entry.consumersObserved.usageComplete).toBe(false)
          expect(entry.consumersObserved.incompleteUsageSources).toEqual(['catalogCommands'])
        }
        const consumers = manifest.sections.consumers
        expect(consumers.status).toBe('observed')
        expect(consumers.counts.catalogCommandReceipts).toBe(2)
      })
    },
    integrationTestTimeout()
  )

  test(
    'the whole observation reads one snapshot: a concurrent mutation mid-capture is invisible',
    async () => {
      await withFixture({}, async (fixture) => {
        // The fixture's own application pool is a second database connection,
        // independent of the collector's single-connection observation.
        const secondConnection = fixture.database.application.$client
        // Published through the real catalog so the retained jsonb is
        // canonical — a concurrent writer must surface as one observed
        // definition, not as malformed evidence.
        const concurrentDefinition = await new GraphDefinitionCatalog(
          new InMemoryGraphDefinitionRepository()
        ).publish({
          definition: graphDefinitionRow('graph:concurrent', '9.9.9'),
          publishedAt: OBSERVED_AT,
        })
        const reads = []
        await observeReadOnly(fixture.dsn, async (transaction) => {
          const firstDefinitions = await countOf(
            transaction,
            'select count(*) as count from graph_definition_versions'
          )
          const firstState = await stateOfExecution(transaction, fixture.ids.executionRunning)
          const firstCheckpoints = await countOf(
            transaction,
            "select count(*) as count from checkpoints where checkpoint_id like 'ck-inventory-pg-%'"
          )

          // The interleaved writer commits between the collector's reads:
          // insert a definition, terminate the running execution, delete a
          // checkpoint. Awaited sequencing — no sleeps, no polling.
          await secondConnection.unsafe(
            `insert into graph_definition_versions (workspace_id, graph_definition_id, graph_version, revision, definition)
             values ($1, 'graph:concurrent', '9.9.9', 1, $2::jsonb)`,
            [fixture.ids.workspaceTwo, JSON.stringify(concurrentDefinition)]
          )
          await secondConnection.unsafe(
            'update executions set state = $2 where execution_id = $1',
            [fixture.ids.executionRunning, 'completed']
          )
          await secondConnection.unsafe(
            "delete from checkpoints where checkpoint_id = 'ck-inventory-pg-0003'"
          )

          // Every later read in the same capture must observe the same
          // snapshot: the committed mutations stay invisible.
          const lastDefinitions = await countOf(
            transaction,
            'select count(*) as count from graph_definition_versions'
          )
          const lastState = await stateOfExecution(transaction, fixture.ids.executionRunning)
          const lastCheckpoints = await countOf(
            transaction,
            "select count(*) as count from checkpoints where checkpoint_id like 'ck-inventory-pg-%'"
          )
          reads.push({
            firstDefinitions,
            lastDefinitions,
            firstState,
            lastState,
            firstCheckpoints,
            lastCheckpoints,
          })
        })
        expect(reads).toEqual([
          {
            firstDefinitions: 4,
            lastDefinitions: 4,
            firstState: 'running',
            lastState: 'running',
            firstCheckpoints: 3,
            lastCheckpoints: 3,
          },
        ])

        // The concurrent writes were real: a capture started after them sees
        // the mutated store coherently.
        const after = await collectFromFixture(fixture)
        expect(after.manifest.sections.definitions.counts.total).toBe(5)
        expect(after.manifest.sections.executions.counts.inFlight).toBe(0)
        expect(after.manifest.sections.checkpoints.counts.checkpointRows).toBe(2)
      })
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
          // Operator lifecycle-reason free text never leaks either: every
          // seeded store carries this deprecation reason on alphaNext.
          'superseded by the workflow migration candidate',
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
