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

  test('validates ledger configuration', () => {
    expect(() => new ChildUsageLedger({ maximumTrackedReportIds: 8 })).toThrow(
      ChildUsageLedgerError
    )
    const ledger = new ChildUsageLedger()
    expect(() => ledger.recordEstimate({ delegationId: 'dlg_broken' }, {})).toThrow()
    expect(() => ledger.settle(identityA(), { currency: 'EUR', settledMicrounits: 1 })).toThrow()
  })
})
