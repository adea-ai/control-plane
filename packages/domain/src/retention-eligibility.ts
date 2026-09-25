import { z } from 'zod'

/**
 * Authoritative retention eligibility (#194).
 *
 * The fail-closed deletion guards reject until eligibility exists. This module
 * is that predicate: given everything known about one candidate record it
 * returns either `eligible` or the single reason that retains it. It is pure —
 * callers gather facts from storage and re-evaluate them at deletion time,
 * because every fact can change between a scan and a claim.
 *
 * Reasons are ordered by authority and by what an operator must change first:
 * an unbounded class never expires, a missing or malformed deadline is never a
 * candidate, the owner has to reach a terminal settled state before a
 * rejection identity can even be reserved, and holds/references outrank age
 * last.
 */
export const RetentionEligibilityReasonSchema = z.enum([
  /** The class is reference- or lifecycle-governed; age cannot authorize it. */
  'unbounded_class',
  'missing_expiry',
  'malformed_expiry',
  'not_expired',
  /** A rejection/replay identity has to exist before the payload can go. */
  'rejection_key_absent',
  /** The owning command/execution is still active or ambiguous. */
  'non_terminal_owner',
  /** Pending or failed publication is reconciliation work, not garbage. */
  'unsettled_publication',
  /** A checkpoint, plan, workflow or receipt still points at this record. */
  'reference_pending',
  'hold_recorded',
])

export const RetentionEligibilityVerdictSchema = z.discriminatedUnion('verdict', [
  z.object({ verdict: z.literal('eligible') }),
  z.object({
    verdict: z.literal('retained'),
    reason: RetentionEligibilityReasonSchema,
  }),
])

export interface RetentionEligibilityFacts {
  /** Stored deadline for this record; absent when the class has none. */
  readonly retentionExpiresAt?: string | undefined
  /** Evaluation instant. */
  readonly now: string
  /** Policy duration for the class; null means reference-governed retention. */
  readonly policyRetainMs: number | null
  /** Owning command/execution reached a terminal, reconciled state. */
  readonly ownerTerminal: boolean
  /** Publication/delivery settled (no pending or failed delivery). */
  readonly publicationSettled: boolean
  /**
   * The durable rejection/replay identity this class requires before payload
   * removal exists. Classes without that prerequisite pass true.
   */
  readonly rejectionKeyReserved: boolean
  /** Count of durable references still pointing at this record. */
  readonly pendingReferences: number
  /** Count of recorded holds covering this record. */
  readonly holds: number
}

export type RetentionEligibilityReason = z.output<typeof RetentionEligibilityReasonSchema>
export type RetentionEligibilityVerdict = z.output<typeof RetentionEligibilityVerdictSchema>

const canonicalInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function evaluateRetentionEligibility(
  facts: RetentionEligibilityFacts
): RetentionEligibilityVerdict {
  if (facts.policyRetainMs === null) return retained('unbounded_class')
  if (facts.retentionExpiresAt === undefined) return retained('missing_expiry')
  if (!canonicalInstant.test(facts.retentionExpiresAt)) return retained('malformed_expiry')
  const now = Date.parse(facts.now)
  if (Number.isNaN(now)) throw new Error('RETENTION_ELIGIBILITY_INVALID_NOW')
  if (Date.parse(facts.retentionExpiresAt) >= now) return retained('not_expired')
  if (!facts.ownerTerminal) return retained('non_terminal_owner')
  if (!facts.publicationSettled) return retained('unsettled_publication')
  if (!facts.rejectionKeyReserved) return retained('rejection_key_absent')
  if (facts.pendingReferences > 0) return retained('reference_pending')
  if (facts.holds > 0) return retained('hold_recorded')
  return { verdict: 'eligible' }
}

/**
 * Read-only assessment of one class at one instant. Counts only — callers
 * report it (sweep diagnostics, operator tooling) and never treat it as
 * deletion authority, because eligibility is revalidated per candidate at
 * claim time.
 */
export const RetentionAssessmentSchema = z.object({
  classId: z.string().min(1).max(64),
  assessedAt: z.string(),
  /** Expired candidates inspected in this pass. */
  scanned: z.number().int().nonnegative(),
  /** True when the scan hit its bound and more candidates remain. */
  truncated: z.boolean(),
  eligible: z.number().int().nonnegative(),
  retainedByReason: z.partialRecord(
    RetentionEligibilityReasonSchema,
    z.number().int().nonnegative()
  ),
})

export type RetentionAssessment = z.output<typeof RetentionAssessmentSchema>

/**
 * Outcome of one operator-invoked deletion pass. `deleted` counts records that
 * were actually removed; `raced` counts candidates whose state changed between
 * selection and deletion, which the claim must revalidate rather than force.
 */
export const RetentionDeletionResultSchema = z.object({
  classId: z.string().min(1).max(64),
  assessedAt: z.string(),
  dryRun: z.boolean(),
  scanned: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  raced: z.number().int().nonnegative(),
  truncated: z.boolean(),
  retainedByReason: z.partialRecord(
    RetentionEligibilityReasonSchema,
    z.number().int().nonnegative()
  ),
})

export type RetentionDeletionResult = z.output<typeof RetentionDeletionResultSchema>

/** Accumulates per-reason counts for one assessment pass. */
export class RetentionAssessmentCounter {
  /** Maximum candidates this pass admits; callers may scan bound + 1. */
  readonly bound: number
  readonly #classId: string
  readonly #assessedAt: string
  #scanned = 0
  #eligible = 0
  #truncated = false
  readonly #retained = new Map<RetentionEligibilityReason, number>()

  constructor(classId: string, assessedAt: string, bound: number) {
    if (!Number.isSafeInteger(bound) || bound < 1)
      throw new Error('RETENTION_ASSESSMENT_INVALID_BOUND')
    this.#classId = classId
    this.#assessedAt = assessedAt
    this.bound = bound
  }

  /** Admits one candidate; returns false once the bound is reached. */
  add(verdict: RetentionEligibilityVerdict): boolean {
    if (this.#scanned >= this.bound) {
      this.#truncated = true
      return false
    }
    this.#scanned += 1
    if (verdict.verdict === 'eligible') this.#eligible += 1
    else this.#retained.set(verdict.reason, (this.#retained.get(verdict.reason) ?? 0) + 1)
    return true
  }

  result(): RetentionAssessment {
    return {
      classId: this.#classId,
      assessedAt: this.#assessedAt,
      scanned: this.#scanned,
      truncated: this.#truncated,
      eligible: this.#eligible,
      retainedByReason: Object.fromEntries(this.#retained),
    }
  }
}

function retained(reason: RetentionEligibilityReason): RetentionEligibilityVerdict {
  return { verdict: 'retained', reason }
}
