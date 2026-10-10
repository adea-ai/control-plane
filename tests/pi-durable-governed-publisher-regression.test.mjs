// Governed publisher regression (#973 helper branch): shared.settleUsage must bind every
// child report to ITS OWN real ledger entry sequence, redeliveries must reuse the original
// sequence (never ordering an old report as new), and a missing sequence lookup must fail
// closed instead of silently omitting publicationSequence. Real composition only: the lead
// runs, the governed child settles through createPiDurableUsageAuthority over the durable
// usage ledger, and the fixture's canonical settleModelRequest wrapper (installed before the
// authority exists; the authority calls options.ledger.settleModelRequest dynamically) records
// each settle's sequence. No sequence-only fakes, no scheduler changes.
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

const SECOND_KEY = 'governed-publisher-regression-request-2'

describe('governed publisher report ordering', () => {
  test(
    'two distinct real request/source ids each order by their own ledger entry, redelivery keeps the original sequence, and a missing lookup fails closed',
    () =>
      fixture(
        async (f) => {
          const usageIdentity = {
            parentExecutionId: f.ids.parentExecutionId,
            delegationId: f.ids.delegationId,
            childExecutionId: f.ids.childExecutionId,
            childAttemptId: f.ids.childAttemptId,
          }
          // Real composition run: lead then governed child; the child's first settlement
          // flows through shared.settleUsage with its real request/source identity.
          const leadHandle = await f.leadRuntime.adapter.start(f.leadRequest)
          await f.leadRuntime.adapter.drain()
          expect((await f.leadRuntime.adapter.status(leadHandle)).state).toBe('completed')
          const childRequest = f.host.starts[0]
          await f.childRuntime.adapter.drain()
          const childHandle = await f.childRuntime.adapter.start(childRequest)
          expect((await f.childRuntime.adapter.status(childHandle)).state).toBe('completed')

          const first = f.childUsage.status(usageIdentity)
          expect(first.costState).toBe('settled')
          const source1 = first.reported.accounting.sourceId

          // A SECOND real request/source id: scope() hashes (budget, admission, key), so a
          // distinct key on the same real child authority is a distinct real source.
          // The REAL authority the governed bridge settled with (captured by the fixture),
          // plus a real authorize/reserve for the second distinct request key.
          const authority = f.shared.lastSettle.authority
          await f.shared.authorizeInference(authority, SECOND_KEY)
          const settled2 = await f.shared.settleUsage(
            authority,
            SECOND_KEY,
            { inputTokens: 1, outputTokens: 1, durationMs: 900 },
            {}
          )
          expect(settled2.accounting.costExact).toBe(true)
          const source2 = settled2.accounting.sourceId
          expect(source2).not.toBe(source1)
          expect(f.childUsage.status(usageIdentity).costState).toBe('settled')

          // (a) Each report is bound to ITS OWN actual ledger entry sequence.
          const ledgerEntries = await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)
          const realSequences = new Map()
          for (const entry of ledgerEntries) {
            if (entry.kind === 'model_usage') {
              // The ledger canonicalizes entry.source.idempotencyKey (`usage:<digest>`),
              // so the real entry is matched by its preserved sourceId identity.
              realSequences.set(`${entry.source.sourceId}:settle`, entry.sequence)
            }
          }
          const sequence1 = f.settleSequenceByIdempotency.get(`${source1}:settle`)
          const sequence2 = f.settleSequenceByIdempotency.get(`${source2}:settle`)
          expect(sequence1).toBe(realSequences.get(`${source1}:settle`))
          expect(sequence2).toBe(realSequences.get(`${source2}:settle`))
          expect(sequence1).toBeDefined()
          expect(sequence2).toBeDefined()
          expect(sequence2).not.toBe(sequence1)

          // (b) Old redelivery must not order as new: redelivering the second request
          // returns the retained canonical entry, keeps the ORIGINAL sequence, and mints
          // no second ledger entry for that identity.
          const redelivered = await f.shared.settleUsage(
            authority,
            SECOND_KEY,
            { inputTokens: 1, outputTokens: 1, durationMs: 900 },
            {}
          )
          expect(redelivered.accounting.sourceId).toBe(source2)
          expect(f.settleSequenceByIdempotency.get(`${source2}:settle`)).toBe(sequence2)
          const settleEntriesForSecond = (
            await f.ledger.entries(f.ids.workspaceId, f.ids.childExecutionId)
          ).filter((entry) => entry.kind === 'model_usage' && entry.source.sourceId === source2)
          expect(settleEntriesForSecond).toHaveLength(1)
          expect(settleEntriesForSecond[0].sequence).toBe(sequence2)

          // (c) Missing lookup fails closed: drop this process's observed sequence (a cold
          // publisher map — the settle itself already happened) and redeliver. The report
          // must refuse with the fail-closed error instead of silently omitting
          // publicationSequence.
          f.shared.beforeSequenceLookup = () => {
            f.settleSequenceByIdempotency.delete(`${source2}:settle`)
          }
          try {
            await expect(
              f.shared.settleUsage(
                authority,
                SECOND_KEY,
                { inputTokens: 1, outputTokens: 1, durationMs: 900 },
                {}
              )
            ).rejects.toThrow(`PUBLICATION_SEQUENCE_MISSING:${source2}:settle`)
          } finally {
            f.shared.beforeSequenceLookup = undefined
          }
          // Fail closed leaves the projection where it stood: still settled, not republished.
          expect(f.childUsage.status(usageIdentity).costState).toBe('settled')
          // Restore the observed sequence so the fixture closes cleanly with real state.
          f.settleSequenceByIdempotency.set(`${source2}:settle`, sequence2)
        },
        {
          transactionalChildAdmission: true,
          canonicalActorPrincipalId: 'user:11111111-1111-4111-8111-111111111111',
        }
      ),
    30000
  )
})
