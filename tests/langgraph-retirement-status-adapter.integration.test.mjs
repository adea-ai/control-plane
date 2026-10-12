// Collector-to-adapter proof on disposable PostgreSQL (M16.01 #938 collector, M16.03 #940 adapter).
//
// Each scenario derives its own isolated database through the existing fixture
// (tests/fixtures/langgraph-retirement-pg-fixture.mjs), runs the real collector CLI against that DSN,
// and feeds the collector's stdout text straight into the adapter CLI. The pipeline therefore runs
// exactly as an operator would run it. The fixture connects with the application role, which has no
// DDL, and the collector only reads. The DSN is always the fixture's own disposable database, never a
// deployed one. The `deployed-dsn` label is an operator scope flag, so those scenarios assert that the
// adapter still never establishes zero.

import { describe, expect, test } from 'bun:test'
import process from 'node:process'
import { integrationTestTimeout } from '@control-plane/database/testing'
import { runInventoryPgCli } from '../scripts/langgraph-retirement-inventory-pg.mjs'
import { runLegacyInventoryStatusCli } from '../scripts/langgraph-retirement-status-adapter.mjs'
import { createInventoryPgFixture } from './fixtures/langgraph-retirement-pg-fixture.mjs'

const OBSERVED_AT = '2026-10-08T00:00:00.000Z'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'

/** Runs the collector CLI on one fixture DSN, then the adapter CLI on the collector's stdout text. */
async function collectThenReport(fixture, scope) {
  const collectorOutput = []
  const collected = await runInventoryPgCli({
    argv: ['--observation-scope', scope, '--dsn', fixture.dsn, '--now', OBSERVED_AT],
    stdout: { write: (text) => (collectorOutput.push(text), true) },
  })
  const text = collectorOutput.join('')
  const reported = []
  await runLegacyInventoryStatusCli({
    argv: ['--manifest', '/dev/stdin'],
    readManifest: async () => text,
    stdout: { write: (chunk) => (reported.push(chunk), true) },
  })
  return { manifest: collected.manifest, status: JSON.parse(reported.join('')) }
}

async function withFixture(options, run) {
  const fixture = await createInventoryPgFixture(options)
  try {
    return await run(fixture)
  } finally {
    await fixture.cleanup()
  }
}

describe.skipIf(!enabled)('LangGraph retirement status adapter over the PG collector', () => {
  test(
    'a seeded disposable store reports the collector counts exactly and never establishes zero',
    async () => {
      await withFixture({}, async (fixture) => {
        const { manifest, status } = await collectThenReport(fixture, 'local-disposable-store')
        const executions = manifest.sections.executions.counts
        const checkpoints = manifest.sections.checkpoints.counts
        // The default fixture seeds a running execution, so in-flight work must be visible.
        expect(executions.inFlight).toBeGreaterThan(0)
        expect(status.exact).toBe(true)
        expect(status.exactReasons).toEqual([])
        expect(status.remainder).toMatchObject({
          executions: executions.total,
          inFlightExecutions: executions.inFlight,
          threads: checkpoints.distinctThreads,
          checkpoints: checkpoints.checkpointRows,
          writes: checkpoints.writeRows,
        })
        expect(status.blockers.IN_FLIGHT_WORK).toBe(executions.inFlight)
        expect(status.retainedWork.collectorClaim).toBe('not-claimable')
        expect(status.zero.established).toBe(false)
        expect(status.zero.attested).toBe(false)
        expect(status.zero.reasons).toContain('DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO')
      })
    },
    integrationTestTimeout()
  )

  test(
    'the same seeded store under the deployed label still never establishes zero',
    async () => {
      await withFixture({}, async (fixture) => {
        const { status } = await collectThenReport(fixture, 'deployed-dsn')
        expect(status.source.legacyScope).toBe('deployed-dsn')
        expect(status.zero.established).toBe(false)
        expect(status.zero.attested).toBe(false)
        expect(status.zero.reasons).toEqual(
          expect.arrayContaining(['DEPLOYED_ATTESTATION_MISSING', 'IN_FLIGHT_WORK'])
        )
      })
    },
    integrationTestTimeout()
  )

  test(
    'a clean store under the deployed label is un-attested: the collector claims none observed, the adapter keeps zero unestablished',
    async () => {
      await withFixture({ seedRunningExecution: false }, async (fixture) => {
        const { manifest, status } = await collectThenReport(fixture, 'deployed-dsn')
        expect(manifest.epistemics.zeroLiveWorkClaim.claim).toBe('none-observed-in-scope')
        expect(status.retainedWork).toEqual({
          classification: 'none-observed-in-scope',
          collectorClaim: 'none-observed-in-scope',
          attested: false,
        })
        expect(status.exact).toBe(true)
        expect(status.remainder).toMatchObject({
          executions: 0,
          inFlightExecutions: 0,
          threads: 0,
          checkpoints: 0,
          writes: 0,
        })
        expect(status.zero).toEqual({
          established: false,
          attested: false,
          reasons: ['DEPLOYED_ATTESTATION_MISSING'],
        })
      })
    },
    integrationTestTimeout()
  )
})
