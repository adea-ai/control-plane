// Governed publisher regression (#973 helper branch): shared.settleUsage must bind every
// child report to ITS OWN real ledger entry sequence, an OLD settle released after a NEWER
// one must never roll the publication watermark back, a replay of a genuinely older request
// with its original captured arguments must mint no second ledger entry and no projection
// rollback, and a missing sequence lookup must fail closed instead of silently omitting
// publicationSequence. Real composition only: the lead runs, the governed child settles
// through createPiDurableUsageAuthority over the durable usage ledger, and the fixture's
// canonical settleModelRequest wrapper (installed before the authority exists; the authority
// calls options.ledger.settleModelRequest dynamically) records each settle's sequence. No
// sequence-only fakes, no scheduler changes.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGovernedChildCompositionFixture } from './pi-durable-governed-child-composition.fixture.mjs'

async function fixture(run, options) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-governed-publisher-'))
  let f
  try {
    f = await createGovernedChildCompositionFixture(directory, options)
    await run(f)
  } finally {
    await f?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const FIRST_KEY = 'governed-publisher-regression-request-1'
const SECOND_KEY = 'governed-publisher-regression-request-2'
const FIRST_USAGE = { inputTokens: 3, outputTokens: 2, durationMs: 900 }
const SECOND_USAGE = { inputTokens: 1, outputTokens: 1, durationMs: 900 }

/** Highest observed publication watermark across the durable cost-state snapshot. */
function watermarkOf(childUsage) {
  let found = 0
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'highestPublication' && typeof value === 'number') {
        found = Math.max(found, value)
      } else {
        walk(value)
      }
    }
  }
  walk(JSON.parse(JSON.stringify(childUsage.snapshot())))
  return found
}

/** Bounded wait that fails loudly instead of hanging the fixture; no retries. */
function bounded(promise, label, ms = 15_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`BOUNDED_WAIT_TIMEOUT:${label}`)), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

describe('governed publisher report ordering', () => {
  test(
    'an old settle released after a newer one keeps the newer watermark, each report uses its own ledger sequence, replay mints no entry, and a missing lookup fails closed',
    () =>
      fixture(
        async (f) => {
          const usageIdentity = {
            parentExecutionId: f.ids.parentExecutionId,
            delegationId: f.ids.delegationId,
            childExecutionId: f.ids.childExecutionId,
            childAttemptId: f.ids.childAttemptId,
          }
          // Real composition run: lead then governed child; the child's settlement flows
          // through shared.settleUsage with its real request/source identity.
          const leadHandle = await f.leadRuntime.adapter.start(f.leadRequest)
          await f.leadRuntime.adapter.drain()
          expect((await f.leadRuntime.adapter.status(leadHandle)).state).toBe('completed')
          const childRequest = f.host.starts[0]
          await f.childRuntime.adapter.drain()
          const childHandle = await f.childRuntime.adapter.start(childRequest)
          expect((await f.childRuntime.adapter.status(childHandle)).state).toBe('completed')

          const first = f.childUsage.status(usageIdentity)
          expect(first.costState).toBe('settled')
          const bridgeSource = first.reported.accounting.sourceId

          // The REAL authority the governed bridge settled with (captured by the fixture).
          const authority = f.shared.lastSettle.authority
          const sequencesOf = async () => {
            const entries = await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)
            const bySource = new Map()
            for (const entry of entries) {
              if (entry.kind === 'model_usage') {
                bySource.set(entry.source.sourceId, entry)
              }
            }
            return bySource
          }

          // --- Hold the FIRST real settle after its ledger record, before its sequence
          // --- lookup, then let a SECOND real settle complete, then release the first.
          await f.shared.authorizeInference(authority, FIRST_KEY)
          await f.shared.authorizeInference(authority, SECOND_KEY)

          let reachedFirst
          const parked = new Promise((resolve) => {
            reachedFirst = resolve
          })
          let releaseFirst
          const released = new Promise((resolve) => {
            releaseFirst = resolve
          })
          let holding = true
          f.shared.beforeSequenceLookup = async () => {
            if (!holding) return
            holding = false
            reachedFirst()
            await released
          }
          const firstPending = f.shared.settleUsage(authority, FIRST_KEY, FIRST_USAGE, {})
          // Attach rejection handling immediately so an early rejection of the parked
          // request is never an unhandled failure while later work runs.
          firstPending.catch(() => {})

          let settled2
          let primaryError
          let cleanupFailure
          try {
            // The first settle has recorded its ledger entry (settleModelRequest returned
            // and the wrapper captured its sequence) and parks before its lookup/report —
            // a timeout here still falls through to the releasing finally.
            await bounded(parked, 'first-settle-parked')
            settled2 = await f.shared.settleUsage(authority, SECOND_KEY, SECOND_USAGE, {})
            // Before releasing the older first settle: the NEWER request's actual ledger
            // sequence IS the publication watermark.
            const seq2BeforeRelease = f.settleSequenceByIdempotency.get(
              `${settled2.accounting.sourceId}:settle`
            )
            expect(seq2BeforeRelease).toBeDefined()
            expect(watermarkOf(f.childUsage)).toBe(seq2BeforeRelease)
          } catch (error) {
            primaryError = error
          } finally {
            // Always release and settle the owned parked request — even when the parked
            // wait, the newer settle, or an assertion throws — so fixture.close never
            // meets a permanently parked request.
            releaseFirst()
            try {
              await bounded(firstPending, 'first-settle-cleanup')
            } catch (cleanupError) {
              if (primaryError === undefined) {
                // No primary failure: surface the cleanup failure after the finally block.
                cleanupFailure = cleanupError
              } else {
                // The primary failure wins; the cleanup failure stays attached as evidence.
                primaryError.cleanupError = cleanupError
              }
            }
          }
          if (primaryError !== undefined) throw primaryError
          if (cleanupFailure !== undefined) throw cleanupFailure
          const settled1 = await firstPending

          // Both real sources are distinct and each map sequence equals its OWN actual
          // ledger entry sequence (the ledger canonicalizes entry idempotency keys, so the
          // entry is matched by its preserved sourceId).
          const entriesBySource = await sequencesOf()
          const source2 = settled2.accounting.sourceId
          const seq1 = f.settleSequenceByIdempotency.get(`${settled1.accounting.sourceId}:settle`)
          const seq2 = f.settleSequenceByIdempotency.get(`${source2}:settle`)
          expect(settled1.accounting.sourceId).not.toBe(source2)
          expect(seq1).toBe(entriesBySource.get(settled1.accounting.sourceId)?.sequence)
          expect(seq2).toBe(entriesBySource.get(source2)?.sequence)
          expect(seq2).toBeGreaterThan(seq1)

          // Watermark: the NEWER (second) publication set it while the first was parked,
          // and releasing the older first settle afterwards must NOT roll it back.
          expect(watermarkOf(f.childUsage)).toBe(seq2)

          // --- Replay the genuinely older request with its ORIGINAL captured arguments
          // --- after the newer request: retained entry (no second ledger entry) and no
          // --- projection rollback.
          const replayed1 = await f.shared.settleUsage(authority, FIRST_KEY, FIRST_USAGE, {})
          expect(replayed1.accounting.sourceId).toBe(settled1.accounting.sourceId)
          expect(f.settleSequenceByIdempotency.get(`${settled1.accounting.sourceId}:settle`)).toBe(
            seq1
          )
          const entriesAfterReplay = await sequencesOf()
          expect(entriesAfterReplay.get(settled1.accounting.sourceId)?.sequence).toBe(seq1)
          expect(
            (await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)).filter(
              (entry) =>
                entry.kind === 'model_usage' &&
                entry.source.sourceId === settled1.accounting.sourceId
            )
          ).toHaveLength(1)
          expect(watermarkOf(f.childUsage)).toBe(seq2)
          // The bridge's own earlier report also kept its distinct actual sequence.
          expect(seq1).not.toBe(f.settleSequenceByIdempotency.get(`${bridgeSource}:settle`))
          expect(entriesBySource.get(bridgeSource)).toBeDefined()

          // --- Missing lookup fails closed: drop this process's observed sequence (a cold
          // --- publisher map — the settle itself already happened) and redeliver. The
          // --- report must refuse instead of silently omitting publicationSequence.
          f.shared.beforeSequenceLookup = () => {
            f.settleSequenceByIdempotency.delete(`${source2}:settle`)
          }
          try {
            await expect(
              f.shared.settleUsage(authority, SECOND_KEY, SECOND_USAGE, {})
            ).rejects.toThrow(`PUBLICATION_SEQUENCE_MISSING:${source2}:settle`)
          } finally {
            f.shared.beforeSequenceLookup = undefined
          }
          expect(f.childUsage.status(usageIdentity).costState).toBe('settled')
          expect(watermarkOf(f.childUsage)).toBe(seq2)
          // Restore the observed sequence so the fixture closes cleanly with real state.
          f.settleSequenceByIdempotency.set(`${source2}:settle`, seq2)
        },
        {
          transactionalChildAdmission: true,
          canonicalActorPrincipalId: 'user:11111111-1111-4111-8111-111111111111',
        }
      ),
    30000
  )
})
