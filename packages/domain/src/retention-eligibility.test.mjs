import { describe, expect, test } from 'bun:test'
import {
  RetentionAssessmentCounter,
  RetentionEligibilityReasonSchema,
  evaluateRetentionEligibility,
} from './retention-eligibility.js'

const now = '2026-09-24T12:00:00.000Z'
const day = 24 * 60 * 60 * 1_000

const eligibleFacts = {
  retentionExpiresAt: '2026-09-01T00:00:00.000Z',
  now,
  policyRetainMs: 30 * day,
  ownerTerminal: true,
  publicationSettled: true,
  rejectionKeyReserved: true,
  pendingReferences: 0,
  holds: 0,
}

describe('retention eligibility (#194)', () => {
  test('a fully covered expired record is eligible', () => {
    expect(evaluateRetentionEligibility(eligibleFacts)).toEqual({ verdict: 'eligible' })
  })

  test('an unconfirmed record is retained for the reason that names it', () => {
    expect(evaluateRetentionEligibility({ ...eligibleFacts, confirmed: false })).toEqual({
      verdict: 'retained',
      reason: 'unconfirmed_signal',
    })
    // The class-level statement outranks it.
    expect(
      evaluateRetentionEligibility({ ...eligibleFacts, confirmed: false, policyRetainMs: null })
    ).toEqual({ verdict: 'retained', reason: 'unbounded_class' })
  })

  test('an unbounded class is never authorized by age', () => {
    expect(evaluateRetentionEligibility({ ...eligibleFacts, policyRetainMs: null })).toEqual({
      verdict: 'retained',
      reason: 'unbounded_class',
    })
  })

  test('missing and malformed deadlines are never candidates', () => {
    expect(
      evaluateRetentionEligibility({ ...eligibleFacts, retentionExpiresAt: undefined })
    ).toEqual({ verdict: 'retained', reason: 'missing_expiry' })
    expect(
      evaluateRetentionEligibility({ ...eligibleFacts, retentionExpiresAt: '2026-09-01 00:00:00' })
    ).toEqual({ verdict: 'retained', reason: 'malformed_expiry' })
  })

  test('the deadline boundary itself is not expired', () => {
    expect(evaluateRetentionEligibility({ ...eligibleFacts, retentionExpiresAt: now })).toEqual({
      verdict: 'retained',
      reason: 'not_expired',
    })
    expect(
      evaluateRetentionEligibility({
        ...eligibleFacts,
        retentionExpiresAt: '2026-09-24T11:59:59.999Z',
      })
    ).toEqual({ verdict: 'eligible' })
  })

  test('a payload is retained until its rejection key is reserved', () => {
    expect(evaluateRetentionEligibility({ ...eligibleFacts, rejectionKeyReserved: false })).toEqual(
      { verdict: 'retained', reason: 'rejection_key_absent' }
    )
  })

  test('a non-terminal owner retains the record', () => {
    expect(evaluateRetentionEligibility({ ...eligibleFacts, ownerTerminal: false })).toEqual({
      verdict: 'retained',
      reason: 'non_terminal_owner',
    })
  })

  test('unsettled publication is reconciliation work, not garbage', () => {
    expect(evaluateRetentionEligibility({ ...eligibleFacts, publicationSettled: false })).toEqual({
      verdict: 'retained',
      reason: 'unsettled_publication',
    })
  })

  test('pending references retain the record', () => {
    expect(evaluateRetentionEligibility({ ...eligibleFacts, pendingReferences: 2 })).toEqual({
      verdict: 'retained',
      reason: 'reference_pending',
    })
  })

  test('a recorded hold outranks every other satisfied fact', () => {
    expect(evaluateRetentionEligibility({ ...eligibleFacts, holds: 1 })).toEqual({
      verdict: 'retained',
      reason: 'hold_recorded',
    })
  })

  test('a live owner is reported before its missing rejection key', () => {
    expect(
      evaluateRetentionEligibility({
        ...eligibleFacts,
        ownerTerminal: false,
        rejectionKeyReserved: false,
      })
    ).toEqual({ verdict: 'retained', reason: 'non_terminal_owner' })
    expect(
      evaluateRetentionEligibility({
        ...eligibleFacts,
        publicationSettled: false,
        rejectionKeyReserved: false,
      })
    ).toEqual({ verdict: 'retained', reason: 'unsettled_publication' })
  })

  test('an unparseable evaluation instant is a programming error, not a verdict', () => {
    expect(() => evaluateRetentionEligibility({ ...eligibleFacts, now: 'today' })).toThrow(
      'RETENTION_ELIGIBILITY_INVALID_NOW'
    )
  })

  test('the counter bounds a scan and reports truncation', () => {
    const counter = new RetentionAssessmentCounter('command-inbox', now, 2)
    expect(counter.add({ verdict: 'eligible' })).toBe(true)
    expect(counter.add({ verdict: 'retained', reason: 'hold_recorded' })).toBe(true)
    expect(counter.add({ verdict: 'eligible' })).toBe(false)
    expect(counter.result()).toEqual({
      classId: 'command-inbox',
      assessedAt: now,
      scanned: 2,
      truncated: true,
      eligible: 1,
      retainedByReason: { hold_recorded: 1 },
    })
  })

  test('a zero bound admits no candidates and reports truncation when one is offered', () => {
    const counter = new RetentionAssessmentCounter('command-inbox', now, 0)
    expect(counter.add({ verdict: 'eligible' })).toBe(false)
    expect(counter.result()).toEqual({
      classId: 'command-inbox',
      assessedAt: now,
      scanned: 0,
      truncated: true,
      eligible: 0,
      retainedByReason: {},
    })
  })

  test('the counter rejects negative and non-integer bounds', () => {
    expect(() => new RetentionAssessmentCounter('command-inbox', now, -1)).toThrow(
      'RETENTION_ASSESSMENT_INVALID_BOUND'
    )
    expect(() => new RetentionAssessmentCounter('command-inbox', now, 1.5)).toThrow(
      'RETENTION_ASSESSMENT_INVALID_BOUND'
    )
  })

  test('every declared reason is reachable and distinctly named', () => {
    const reasons = [
      'unbounded_class',
      'unconfirmed_signal',
      'missing_expiry',
      'malformed_expiry',
      'not_expired',
      'rejection_key_absent',
      'non_terminal_owner',
      'unsettled_publication',
      'reference_pending',
      'hold_recorded',
    ]
    expect(new Set(RetentionEligibilityReasonSchema.options)).toEqual(new Set(reasons))
  })
})
