import { describe, expect, test } from 'bun:test'
import { ChildUsageLedger, ChildUsageLedgerError } from './child-usage-outcomes.ts'

const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  foreignExecutionId: 'exe_01JDBCDEF0123456789ABCDEFG',
  childExecutionIdA: 'exe_01JBBCDEF0123456789ABCDEFG',
  childExecutionIdB: 'exe_01JCBCDEF0123456789ABCDEFG',
  delegationIdA: 'dlg_01JBBCDEF0123456789ABCDEFG',
  delegationIdB: 'dlg_01JCBCDEF0123456789ABCDEFG',
  attemptIdA: 'att_01JBBCDEF0123456789ABCDEFG',
  attemptIdB: 'att_01JCBCDEF0123456789ABCDEFG',
  attemptIdC: 'att_01JDBCDEF0123456789ABCDEFG',
  executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
}

const BASE_TIME = Date.parse('2026-08-25T18:05:00.000Z')
const at = (offsetMs) => new Date(BASE_TIME + offsetMs).toISOString()
const digest = (character) => `sha256:${character.repeat(64)}`

const identityA = () => ({
  parentExecutionId: ids.parentExecutionId,
  delegationId: ids.delegationIdA,
  childExecutionId: ids.childExecutionIdA,
  childAttemptId: ids.attemptIdA,
})

const reservationFor = (identity, overrides = {}) => ({
  schemaVersion: 1,
  workspaceId: ids.workspaceId,
  executionId: identity.childExecutionId,
  attemptId: identity.childAttemptId,
  executionPlanId: ids.executionPlanId,
  executionPlanDigest: digest('a'),
  reservationKey: `runtime-attempt:${identity.childAttemptId}`,
  currency: 'USD',
  maximumMicrounits: 100_000,
  maximumTokens: 5_000,
  ...overrides,
})

const reportedUsage = (chargedMicrounits, overrides = {}) => ({
  inputTokens: 120,
  outputTokens: 340,
  durationMs: 1_500,
  accounting: {
    schemaVersion: 1,
    sourceId: 'usage-source:managed-pi',
    fundingSource: 'hq_managed',
    currency: 'USD',
    chargedMicrounits,
    costExact: true,
  },
  ...overrides,
})

describe('correlated child usage outcomes', () => {
  test('surfaces an unrecorded attempt as explicitly unknown, never blank or zero', () => {
    const ledger = new ChildUsageLedger()
    const status = ledger.status(identityA())
    expect(status).toStrictEqual({ identity: identityA(), costState: 'unknown' })
    expect(status.reported).toBeUndefined()
    expect(status.reserved).toBeUndefined()
    expect(status.estimated).toBeUndefined()
    expect(status.reconciled).toBeUndefined()
    expect(status.settled).toBeUndefined()
    expect(ledger.listByDelegation(ids.delegationIdA)).toStrictEqual([])
    expect(Object.keys(status).toSorted()).toStrictEqual(['costState', 'identity'])
  })

  test('advances estimated → reserved → reported → reconciled → settled on explicit evidence', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()

    const estimated = ledger.recordEstimate(identity, {
      currency: 'USD',
      maximumMicrounits: 250_000,
      source: 'plan-compiler:v1',
    })
    expect(estimated.costState).toBe('estimated')
    expect(estimated.estimated).toMatchObject({ currency: 'USD', maximumMicrounits: 250_000 })
    // No stage is fabricated from the estimate alone: nothing is reserved,
    // reported, reconciled or settled yet.
    expect(estimated.reserved).toBeUndefined()
    expect(estimated.reported).toBeUndefined()

    const reserved = ledger.recordReservation(identity, reservationFor(identity))
    expect(reserved.costState).toBe('reserved')
    expect(reserved.reserved).toMatchObject({
      attemptId: identity.childAttemptId,
      maximumMicrounits: 100_000,
    })

    const reported = ledger.recordReportedUsage(identity, reportedUsage(42_000), {
      reportId: 'usage:report:1',
    })
    expect(reported.outcome).toBe('recorded')
    expect(reported.costState).toBe('reported')
    expect(reported.usageReportCount).toBe(1)

    const reconciled = ledger.reconcile(identity, { reconciledAt: at(1_000) })
    expect(reconciled.costState).toBe('reconciled')
    expect(reconciled.reconciled).toStrictEqual({
      result: 'within_reservation',
      reconciledAt: at(1_000),
      reportedChargedMicrounits: 42_000,
      reservedMaximumMicrounits: 100_000,
    })

    const settled = ledger.settle(identity, {
      currency: 'USD',
      settledMicrounits: 42_000,
      settledAt: at(2_000),
      settlementRef: 'settlement:run:1',
    })
    expect(settled.costState).toBe('settled')
    expect(settled.settled).toStrictEqual({
      currency: 'USD',
      settledMicrounits: 42_000,
      settledAt: at(2_000),
      settlementRef: 'settlement:run:1',
    })
    // Every stage's evidence is retained alongside the terminal state.
    expect(settled.estimated).toBeDefined()
    expect(settled.reserved).toBeDefined()
    expect(settled.reported).toBeDefined()
    expect(settled.reconciled).toBeDefined()
    expect(ledger.status(identity)).toStrictEqual(settled)
  })

  test('records an exceeded reservation explicitly instead of absorbing it', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    ledger.recordReservation(identity, reservationFor(identity, { maximumMicrounits: 100 }))
    ledger.recordReportedUsage(identity, reportedUsage(150), { reportId: 'usage:report:1' })
    const reconciled = ledger.reconcile(identity, { reconciledAt: at(0) })
    expect(reconciled.reconciled).toStrictEqual({
      result: 'exceeded_reservation',
      reconciledAt: at(0),
      reportedChargedMicrounits: 150,
      reservedMaximumMicrounits: 100,
    })
    expect(reconciled.costState).toBe('reconciled')
  })

  test('reconciliation without a reservation records that fact instead of inventing a bound', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    ledger.recordReportedUsage(identity, reportedUsage(7_500), { reportId: 'usage:report:1' })
    const reconciled = ledger.reconcile(identity, { reconciledAt: at(0) })
    expect(reconciled.reconciled).toStrictEqual({
      result: 'without_reservation',
      reconciledAt: at(0),
      reportedChargedMicrounits: 7_500,
    })
    expect(reconciled.reconciled.reservedMaximumMicrounits).toBeUndefined()
    expect(reconciled.costState).toBe('reconciled')
  })

  test('missing states stay explicit: reconciliation without reported evidence fails', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    // Estimated only: reported usage was never delivered, so the attempt is
    // missing that state — reconciliation must not fabricate a comparison.
    ledger.recordEstimate(identity, {
      currency: 'USD',
      maximumMicrounits: 1_000,
      source: 'plan-compiler:v1',
    })
    expect(() => ledger.reconcile(identity, { reconciledAt: at(0) })).toThrow(ChildUsageLedgerError)
    try {
      ledger.reconcile(identity, { reconciledAt: at(0) })
    } catch (error) {
      expect(error.code).toBe('EVIDENCE_MISSING')
    }
    // The attempt keeps its explicit recorded state; the missing report is
    // surfaced as an absent stage, never as a blank or inferred zero.
    const status = ledger.status(identity)
    expect(status.costState).toBe('estimated')
    expect(status.reported).toBeUndefined()
    expect(status.reconciled).toBeUndefined()
  })

  test('reported usage without an accounting charge cannot be reconciled', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    // A runtime that reports tokens but no accounting charge: the charge is
    // unknown, not zero.
    ledger.recordReportedUsage(
      identity,
      { inputTokens: 10, outputTokens: 20, durationMs: 30 },
      { reportId: 'usage:report:no-accounting' }
    )
    expect(() => ledger.reconcile(identity, { reconciledAt: at(0) })).toThrow(ChildUsageLedgerError)
    const status = ledger.status(identity)
    expect(status.costState).toBe('reported')
    expect(status.reported.accounting).toBeUndefined()
  })

  test('redelivered reports dedupe by reportId and conflicting reuse is explicit', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    const first = ledger.recordReportedUsage(identity, reportedUsage(42_000), {
      reportId: 'usage:report:1',
    })
    expect(first.outcome).toBe('recorded')
    expect(first.usageReportCount).toBe(1)
    // At-least-once redelivery of the same report: answered, never refolded.
    const redelivered = ledger.recordReportedUsage(identity, reportedUsage(42_000), {
      reportId: 'usage:report:1',
    })
    expect(redelivered).toStrictEqual({ outcome: 'duplicate_report', reportId: 'usage:report:1' })
    expect(ledger.status(identity).usageReportCount).toBe(1)
    // Same delivery identity with different content: one of them is lying.
    const conflicting = ledger.recordReportedUsage(identity, reportedUsage(43_000), {
      reportId: 'usage:report:1',
    })
    expect(conflicting).toStrictEqual({
      outcome: 'conflicting_report',
      reportId: 'usage:report:1',
    })
    expect(ledger.status(identity).usageReportCount).toBe(1)
    // A genuinely newer report supersedes `reported` and is counted.
    const second = ledger.recordReportedUsage(identity, reportedUsage(50_000), {
      reportId: 'usage:report:2',
    })
    expect(second.outcome).toBe('recorded')
    expect(ledger.status(identity).usageReportCount).toBe(2)
    expect(ledger.status(identity).reported.accounting.chargedMicrounits).toBe(50_000)
  })

  test('a newer report supersedes a reconciliation instead of presenting stale evidence', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    ledger.recordReservation(identity, reservationFor(identity))
    ledger.recordReportedUsage(identity, reportedUsage(42_000), { reportId: 'usage:report:1' })
    expect(ledger.reconcile(identity, { reconciledAt: at(0) }).costState).toBe('reconciled')
    // The reconciliation compared report 1; a new report invalidates it
    // explicitly — the state returns to `reported` with the reconciliation
    // cleared, so nothing stale is presented as reconciled.
    const afterNewReport = ledger.recordReportedUsage(identity, reportedUsage(500_000), {
      reportId: 'usage:report:2',
    })
    expect(afterNewReport.outcome).toBe('recorded')
    expect(afterNewReport.costState).toBe('reported')
    expect(afterNewReport.reconciled).toBeUndefined()
    // Re-reconciling the new report surfaces the exceeded reservation.
    const reconciled = ledger.reconcile(identity, { reconciledAt: at(1_000) })
    expect(reconciled.reconciled.result).toBe('exceeded_reservation')
    expect(reconciled.reconciled.reportedChargedMicrounits).toBe(500_000)
  })

  test('correlates reservation and identity conflicts explicitly', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    // A reservation binding a different attempt is a conflict, not a retarget.
    expect(() =>
      ledger.recordReservation(
        identity,
        reservationFor({ ...identity, childAttemptId: ids.attemptIdB })
      )
    ).toThrow(ChildUsageLedgerError)
    try {
      ledger.recordReservation(
        identity,
        reservationFor({ ...identity, childAttemptId: ids.attemptIdB })
      )
    } catch (error) {
      expect(error.code).toBe('IDENTITY_CONFLICT')
    }
    // The same delegation/attempt key reporting a different parent or child
    // execution is a correlation conflict.
    ledger.recordEstimate(identity, {
      currency: 'USD',
      maximumMicrounits: 1_000,
      source: 'plan-compiler:v1',
    })
    expect(() =>
      ledger.recordEstimate(
        { ...identity, childExecutionId: ids.childExecutionIdB },
        { currency: 'USD', maximumMicrounits: 1_000, source: 'plan-compiler:v1' }
      )
    ).toThrow(ChildUsageLedgerError)
    expect(() =>
      ledger.recordEstimate(
        { ...identity, parentExecutionId: ids.foreignExecutionId },
        { currency: 'USD', maximumMicrounits: 1_000, source: 'plan-compiler:v1' }
      )
    ).toThrow(ChildUsageLedgerError)
    expect(ledger.status(identity).costState).toBe('estimated')
  })

  test('settling without reported usage keeps the settled amount explicit and usage unknown', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    const settled = ledger.settle(identity, {
      currency: 'USD',
      settledMicrounits: 12_000,
      settledAt: at(0),
      settlementRef: 'settlement:manual:1',
    })
    expect(settled.costState).toBe('settled')
    expect(settled.settled).toMatchObject({ settledMicrounits: 12_000 })
    // The unreported usage stays an absent stage — explicitly unknown — and
    // the ledger synthesizes no charge from the settlement or the void.
    expect(settled.reported).toBeUndefined()
    expect(settled.reconciled).toBeUndefined()
    expect(settled.usageReportCount).toBeUndefined()
  })

  test('tracks retry attempts per delegation separately and lists them sorted', () => {
    const ledger = new ChildUsageLedger()
    const firstAttempt = identityA()
    const retryAttempt = {
      ...firstAttempt,
      childAttemptId: ids.attemptIdC,
    }
    ledger.recordReportedUsage(firstAttempt, reportedUsage(1_000), { reportId: 'a:1' })
    ledger.recordReportedUsage(retryAttempt, reportedUsage(2_000), { reportId: 'c:1' })
    const outcomes = ledger.listByDelegation(ids.delegationIdA)
    expect(outcomes.map((outcome) => outcome.identity.childAttemptId)).toStrictEqual([
      ids.attemptIdA,
      ids.attemptIdC,
    ])
    expect(outcomes.map((outcome) => outcome.costState)).toStrictEqual(['reported', 'reported'])
    // A different delegation is a separate correlation scope.
    expect(ledger.listByDelegation(ids.delegationIdB)).toStrictEqual([])
  })

  test('a redelivered old report can never overwrite a newer one after dedup eviction', () => {
    const ledger = new ChildUsageLedger({ maximumTrackedReportIds: 16 })
    const identity = identityA()
    // Fill the bounded dedup horizon so the first report's id is evicted.
    for (let index = 1; index <= 17; index += 1) {
      const receipt = ledger.recordReportedUsage(identity, reportedUsage(index * 1_000), {
        reportId: `usage:report:${index}`,
      })
      expect(receipt.outcome).toBe('recorded')
    }
    // Redelivery of the ORIGINAL report after its id was evicted: its content
    // was already superseded, so it answers stale_report and the newest
    // report stays retained — an old report can never overwrite a newer one.
    const stale = ledger.recordReportedUsage(identity, reportedUsage(1_000), {
      reportId: 'usage:report:1',
    })
    expect(stale.outcome).toBe('stale_report')
    const current = ledger.status(identity)
    expect(current.reported.accounting.chargedMicrounits).toBe(17_000)
    expect(current.usageReportCount).toBe(17)
    // A redelivery identical to the retained report is still a duplicate and
    // must not fold or inflate the retained-report count.
    const duplicate = ledger.recordReportedUsage(identity, reportedUsage(17_000), {
      reportId: 'usage:report:17-redelivered',
    })
    expect(duplicate.outcome).toBe('duplicate_report')
    expect(ledger.status(identity).usageReportCount).toBe(17)
  })

  test('a newer report supersedes the settlement recorded against its predecessor', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    ledger.recordReservation(identity, reservationFor(identity))
    ledger.recordReportedUsage(identity, reportedUsage(42_000), { reportId: 'r:1' })
    ledger.reconcile(identity, { reconciledAt: at(1_000) })
    const settled = ledger.settle(identity, {
      currency: 'USD',
      settledMicrounits: 42_000,
      settledAt: at(2_000),
      settlementRef: 'settle:1',
    })
    expect(settled.costState).toBe('settled')

    const newer = ledger.recordReportedUsage(identity, reportedUsage(43_000), {
      reportId: 'r:2',
    })
    expect(newer.outcome).toBe('recorded')
    // Both stages belonged to the superseded report: neither its flag nor its
    // amount may survive into the outcome for the newer report.
    expect(newer.settled).toBeUndefined()
    expect(newer.reconciled).toBeUndefined()
    expect(newer.costState).toBe('reported')
    expect(newer.reported.accounting.chargedMicrounits).toBe(43_000)
  })

  test('a new reservation supersedes the reconciliation made against the old bound', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    ledger.recordReservation(identity, reservationFor(identity))
    ledger.recordReportedUsage(identity, reportedUsage(90_000), { reportId: 'r:1' })
    const reconciled = ledger.reconcile(identity, { reconciledAt: at(1_000) })
    expect(reconciled.reconciled.result).toBe('within_reservation')

    const renewed = ledger.recordReservation(
      identity,
      reservationFor(identity, { maximumMicrounits: 80_000 })
    )
    // The frozen comparison was made against the previous bound and must not
    // survive into an outcome for the new reservation.
    expect(renewed.reconciled).toBeUndefined()
    expect(renewed.reserved.maximumMicrounits).toBe(80_000)
    expect(renewed.reported.accounting.chargedMicrounits).toBe(90_000)
    expect(renewed.costState).toBe('reported')
    // Reconciling again compares against the NEW bound.
    const again = ledger.reconcile(identity, { reconciledAt: at(2_000) })
    expect(again.reconciled).toMatchObject({
      result: 'exceeded_reservation',
      reservedMaximumMicrounits: 80_000,
    })
  })

  test('status verifies parent and child execution identity, never delegation/attempt alone', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    ledger.recordEstimate(identity, {
      currency: 'USD',
      maximumMicrounits: 5_000,
      source: 'plan-compiler:v1',
    })
    expect(() => ledger.status({ ...identity, parentExecutionId: ids.foreignExecutionId })).toThrow(
      ChildUsageLedgerError
    )
    expect(() => ledger.status({ ...identity, childExecutionId: ids.childExecutionIdB })).toThrow(
      ChildUsageLedgerError
    )
    try {
      ledger.status({ ...identity, parentExecutionId: ids.foreignExecutionId })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ChildUsageLedgerError)
      expect(error.code).toBe('IDENTITY_CONFLICT')
    }
    // The true identity still resolves, and a foreign read never created or
    // retargeted a record.
    expect(ledger.status(identity).costState).toBe('estimated')
    const absent = { ...identity, childAttemptId: ids.attemptIdB }
    expect(ledger.status(absent).costState).toBe('unknown')
    expect(ledger.listByDelegation(ids.delegationIdA)).toHaveLength(1)
  })

  test('validates ledger configuration', () => {
    expect(() => new ChildUsageLedger({ maximumTrackedReportIds: 8 })).toThrow(
      ChildUsageLedgerError
    )
    const ledger = new ChildUsageLedger()
    expect(() => ledger.recordEstimate({ delegationId: 'dlg_broken' }, {})).toThrow()
    expect(() => ledger.settle(identityA(), { currency: 'EUR', settledMicrounits: 1 })).toThrow()
  })
})

describe('child usage ledger durable snapshot', () => {
  test('snapshot/restore carries cost states and dedup horizons across a restart', () => {
    const running = new ChildUsageLedger()
    const identity = identityA()
    running.recordEstimate(identity, {
      currency: 'USD',
      maximumMicrounits: 250_000,
      source: 'plan-compiler:v1',
    })
    running.recordReservation(identity, reservationFor(identity))
    running.recordReportedUsage(identity, reportedUsage(42_000), { reportId: 'r:1' })
    running.reconcile(identity, { reconciledAt: at(1_000) })
    running.settle(identity, {
      currency: 'USD',
      settledMicrounits: 42_000,
      settledAt: at(2_000),
      settlementRef: 'settle:1',
    })

    // The owner persists the snapshot through the canonical durable path;
    // it carries evidence, identities and content hashes — never payloads.
    const persisted = JSON.stringify(running.snapshot())
    expect(persisted).toContain(`"reportFingerprints":[["r:1","sha256:`)
    expect(persisted).not.toContain('prompt')

    const restarted = new ChildUsageLedger()
    restarted.restore(JSON.parse(persisted))
    expect(restarted.status(identity)).toStrictEqual(running.status(identity))
    expect(restarted.status(identity).costState).toBe('settled')

    // Dedup horizons survive the restart: the redelivered report answers
    // duplicate instead of folding and inflating the retained-report count.
    const redelivered = restarted.recordReportedUsage(identity, reportedUsage(42_000), {
      reportId: 'r:1',
    })
    expect(redelivered.outcome).toBe('duplicate_report')
    expect(restarted.status(identity).usageReportCount).toBe(1)

    // And the staleness guarantees survive too: a newer report still clears
    // the restored settlement and reconciliation.
    const newer = restarted.recordReportedUsage(identity, reportedUsage(43_000), {
      reportId: 'r:2',
    })
    expect(newer.outcome).toBe('recorded')
    expect(newer.settled).toBeUndefined()
    expect(newer.reconciled).toBeUndefined()
    expect(newer.costState).toBe('reported')
  })

  test('restore is two-phase: conflicting or inconsistent snapshots restore nothing', () => {
    const source = new ChildUsageLedger()
    source.recordEstimate(identityA(), {
      currency: 'USD',
      maximumMicrounits: 1_000,
      source: 'plan-compiler:v1',
    })
    const snapshot = source.snapshot()

    const target = new ChildUsageLedger()
    target.recordEstimate(identityA(), {
      currency: 'USD',
      maximumMicrounits: 2_000,
      source: 'plan-compiler:v1',
    })
    expect(() => target.restore(snapshot)).toThrow(ChildUsageLedgerError)
    // The conflict aborted the whole restore: the target kept its own state.
    expect(target.status(identityA()).estimated.maximumMicrounits).toBe(2_000)

    // A snapshot whose cost state does not rederive from its evidence is
    // rejected before anything is applied.
    const tampered = structuredClone(source.snapshot())
    tampered.entries[0].outcome.costState = 'settled'
    const fresh = new ChildUsageLedger()
    expect(() => fresh.restore(tampered)).toThrow(ChildUsageLedgerError)
    expect(fresh.listByDelegation(ids.delegationIdA)).toStrictEqual([])

    // Duplicated identities inside one snapshot are a conflict too.
    const duplicated = structuredClone(source.snapshot())
    duplicated.entries.push(structuredClone(duplicated.entries[0]))
    expect(() => new ChildUsageLedger().restore(duplicated)).toThrow(ChildUsageLedgerError)
  })
})

describe('bounded report-horizon ordering', () => {
  const reportIdFor = (index) => `usage:report:${index}`
  // The canonical publisher passes the durable usage ledger's monotonic entry
  // sequence with every report; a redelivery of the same entry reuses it.
  const publish = (ledger, identity, index) =>
    ledger.recordReportedUsage(identity, reportedUsage(index * 1_000), {
      reportId: reportIdFor(index),
      publicationSequence: index,
    })
  const settleLatest = (ledger, identity) => {
    ledger.reconcile(identity, { reconciledAt: at(1_000) })
    ledger.settle(identity, {
      currency: 'USD',
      settledMicrounits: 18_000,
      settledAt: at(2_000),
      settlementRef: 'settlement:run:latest',
    })
  }

  test('an evicted report id cannot replay over newer reconciliation and settlement', () => {
    const ledger = new ChildUsageLedger({ maximumTrackedReportIds: 16 })
    const identity = identityA()
    for (let index = 1; index <= 18; index += 1) publish(ledger, identity, index)
    settleLatest(ledger, identity)
    expect(ledger.status(identity).costState).toBe('settled')

    // Replaying the evicted report 1 with its ORIGINAL canonical sequence must
    // be stale — never a fresh recording that clears newer evidence.
    const replay = ledger.recordReportedUsage(identity, reportedUsage(1_000), {
      reportId: reportIdFor(1),
      publicationSequence: 1,
    })
    expect(replay.outcome).toBe('stale_report')
    const after = ledger.status(identity)
    expect(after.costState).toBe('settled')
    expect(after.reconciled).toBeDefined()
    expect(after.settled?.settlementRef).toBe('settlement:run:latest')
  })

  test('the eviction horizon stays ordered across a snapshot restore', () => {
    const ledger = new ChildUsageLedger({ maximumTrackedReportIds: 16 })
    const identity = identityA()
    for (let index = 1; index <= 18; index += 1) publish(ledger, identity, index)
    settleLatest(ledger, identity)

    const restored = new ChildUsageLedger({ maximumTrackedReportIds: 16 })
    restored.restore(ledger.snapshot())
    const replay = restored.recordReportedUsage(identity, reportedUsage(1_000), {
      reportId: reportIdFor(1),
      publicationSequence: 1,
    })
    expect(replay.outcome).toBe('stale_report')
    const after = restored.status(identity)
    expect(after.reconciled).toBeDefined()
    expect(after.settled?.settlementRef).toBe('settlement:run:latest')
  })

  test('a redelivered canonical entry converges, a changed one conflicts, and a sequence-free report fails closed', () => {
    const ledger = new ChildUsageLedger({ maximumTrackedReportIds: 16 })
    const identity = identityA()
    for (let index = 1; index <= 18; index += 1) publish(ledger, identity, index)
    settleLatest(ledger, identity)

    // Redelivery of the retained entry at its ORIGINAL sequence with identical
    // content converges instead of recording again.
    const duplicate = ledger.recordReportedUsage(identity, reportedUsage(18_000), {
      reportId: reportIdFor(18),
      publicationSequence: 18,
    })
    expect(duplicate.outcome).toBe('duplicate_report')
    // A changed body at the retained sequence is a conflict, not a new report.
    const changed = ledger.recordReportedUsage(identity, reportedUsage(18_500), {
      reportId: 'usage:report:18-altered',
      publicationSequence: 18,
    })
    expect(changed.outcome).toBe('conflicting_report')
    // A sequence-free report after ordering history exists fails closed rather
    // than overwriting the newer reconciled/settled truth.
    const legacy = ledger.recordReportedUsage(identity, reportedUsage(99_000), {
      reportId: 'usage:report:legacy',
    })
    expect(legacy.outcome).toBe('conflicting_report')
    const after = ledger.status(identity)
    expect(after.reconciled).toBeDefined()
    expect(after.settled?.settlementRef).toBe('settlement:run:latest')
  })
})

describe('canonical publication sequence validation and identity binding', () => {
  const reportIdFor = (index) => `usage:report:${index}`
  const publish = (ledger, identity, index) =>
    ledger.recordReportedUsage(identity, reportedUsage(index * 1_000), {
      reportId: reportIdFor(index),
      publicationSequence: index,
    })

  test('a malformed publication sequence fails closed before any mutation', () => {
    const malformed = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      -1,
      0,
      Number.MAX_SAFE_INTEGER + 1,
    ]
    for (const bad of malformed) {
      const ledger = new ChildUsageLedger()
      const identity = identityA()
      expect(() =>
        ledger.recordReportedUsage(identity, reportedUsage(1_000), {
          reportId: 'usage:report:malformed',
          publicationSequence: bad,
        })
      ).toThrow(ChildUsageLedgerError)
      // Fail closed before mutation: nothing was recorded or superseded.
      expect(ledger.status(identity).reported).toBeUndefined()
      expect(ledger.status(identity).costState).toBe('unknown')
    }
  })

  test('a changed report identity at the retained sequence conflicts even with matching usage', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    publish(ledger, identity, 1)
    // Same usage bytes and same retained sequence, but a DIFFERENT report id:
    // the retained sequence is owned by one identity, so this is a conflict.
    const impostor = ledger.recordReportedUsage(identity, reportedUsage(1_000), {
      reportId: 'usage:report:impostor',
      publicationSequence: 1,
    })
    expect(impostor.outcome).toBe('conflicting_report')
    // The genuine retained report id still converges.
    const duplicate = ledger.recordReportedUsage(identity, reportedUsage(1_000), {
      reportId: reportIdFor(1),
      publicationSequence: 1,
    })
    expect(duplicate.outcome).toBe('duplicate_report')
  })

  test('an older sequence-free snapshot restores safely and never overwrites settled truth', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    ledger.recordReportedUsage(identity, reportedUsage(42_000), { reportId: 'usage:report:legacy' })
    ledger.settle(identity, {
      currency: 'USD',
      settledMicrounits: 42_000,
      settledAt: at(1_000),
      settlementRef: 'settlement:legacy',
    })
    // Emulate an OLDER snapshot shape: no ordering watermark, no identity.
    const older = ledger.snapshot()
    for (const entry of older.entries) {
      delete entry.highestPublication
      delete entry.retainedReportId
      // A snapshot written before these fields existed carries none of them.
      delete entry.orderingUncertain
    }
    const restored = new ChildUsageLedger()
    // Restoring must not break schema validation on the missing fields.
    expect(() => restored.restore(older)).not.toThrow()
    // Ambiguous legacy history must not be overwritten by an unorderable report.
    const replay = restored.recordReportedUsage(identity, reportedUsage(1_000), {
      reportId: 'usage:report:ambiguous',
    })
    expect(replay.outcome).toBe('conflicting_report')
    expect(restored.status(identity).settled?.settlementRef).toBe('settlement:legacy')
  })
})

describe('per-request sequence binding, round-trip uncertainty, and validation order', () => {
  const identityB = () => ({
    ...identityA(),
    delegationId: ids.delegationIdB,
    childExecutionId: ids.childExecutionIdB,
    childAttemptId: ids.attemptIdB,
  })

  test('interleaved settling requests each bind their own sequence; an old entry redelivery is stale', () => {
    const ledger = new ChildUsageLedger({ maximumTrackedReportIds: 16 })
    const a = identityA()
    const b = identityB()
    // Two request streams interleaved deterministically: A1, B1, A2, B2, A3.
    const interleaved = [
      [a, 'usage:report:a1', 1],
      [b, 'usage:report:b1', 1],
      [a, 'usage:report:a2', 2],
      [b, 'usage:report:b2', 2],
      [a, 'usage:report:a3', 3],
    ]
    for (const [identity, reportId, publicationSequence] of interleaved) {
      expect(
        ledger.recordReportedUsage(identity, reportedUsage(publicationSequence * 1_000), {
          reportId,
          publicationSequence,
        }).outcome
      ).toBe('recorded')
    }
    // Each entry's watermark follows its OWN stream (A=3, B=2), never the
    // interleaved maximum of the other request.
    expect(ledger.status(a).reported).toBeDefined()
    expect(ledger.status(b).reported).toBeDefined()
    // Old-entry redelivery: a fresh id carrying A's retired sequence 1 is stale.
    expect(
      ledger.recordReportedUsage(a, reportedUsage(1_000), {
        reportId: 'usage:report:a1-redelivered',
        publicationSequence: 1,
      }).outcome
    ).toBe('stale_report')
    // The genuine old id still converges as a duplicate.
    expect(
      ledger.recordReportedUsage(a, reportedUsage(1_000), {
        reportId: 'usage:report:a1',
        publicationSequence: 1,
      }).outcome
    ).toBe('duplicate_report')
  })

  test('ordering uncertainty survives repeated snapshot round trips', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    ledger.recordReportedUsage(identity, reportedUsage(42_000), {
      reportId: 'usage:report:legacy',
    })
    ledger.settle(identity, {
      currency: 'USD',
      settledMicrounits: 42_000,
      settledAt: at(1_000),
      settlementRef: 'settlement:legacy',
    })
    const older = ledger.snapshot()
    for (const entry of older.entries) {
      delete entry.highestPublication
      delete entry.retainedReportId
      // A snapshot written before these fields existed carries none of them.
      delete entry.orderingUncertain
    }
    const first = new ChildUsageLedger()
    first.restore(older)
    const second = first.snapshot()
    const third = new ChildUsageLedger()
    third.restore(second)
    // Uncertainty survived both round trips: the replay still fails closed.
    const replay = third.recordReportedUsage(identity, reportedUsage(1_000), {
      reportId: 'usage:report:ambiguous-round-trip',
    })
    expect(replay.outcome).toBe('conflicting_report')
    expect(third.status(identity).settled?.settlementRef).toBe('settlement:legacy')
  })

  test('a malformed sequence fails closed even for an already-seen report id', () => {
    const ledger = new ChildUsageLedger()
    const identity = identityA()
    ledger.recordReportedUsage(identity, reportedUsage(1_000), {
      reportId: 'usage:report:1',
      publicationSequence: 1,
    })
    // Validation runs before the duplicate shortcut: a malformed sequence on a
    // known id still fails closed rather than answering duplicate_report.
    expect(() =>
      ledger.recordReportedUsage(identity, reportedUsage(1_000), {
        reportId: 'usage:report:1',
        publicationSequence: 1.5,
      })
    ).toThrow(ChildUsageLedgerError)
  })
})
