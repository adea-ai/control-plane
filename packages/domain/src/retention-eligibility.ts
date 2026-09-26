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
  /**
   * The class's confirmation prerequisite is unmet: the record is the identity
   * a lost-acknowledgement retry relies on, so nothing may remove it yet.
   */
  'unconfirmed_signal',
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
  /**
   * Classes whose eligibility starts at a confirmation (an accepted receipt, a
   * settled command) set this false while waiting; omitted means the class has
   * no such prerequisite.
   */
  readonly confirmed?: boolean
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
  if (facts.confirmed === false) return retained('unconfirmed_signal')
  if (facts.retentionExpiresAt === undefined) return retained('missing_expiry')
  if (!canonicalInstant.test(facts.retentionExpiresAt)) return retained('malformed_expiry')
  const expiry = Date.parse(facts.retentionExpiresAt)
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== facts.retentionExpiresAt)
    return retained('malformed_expiry')
  const now = Date.parse(facts.now)
  if (Number.isNaN(now)) throw new Error('RETENTION_ELIGIBILITY_INVALID_NOW')
  if (expiry >= now) return retained('not_expired')
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
  /** Candidates inspected in this pass; reference-window scans include young targets. */
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
  /**
   * Records whose payload was removed while their identity was kept. Used by
   * classes that must preserve a deduplication key (see the messaging inbox).
   */
  compacted: z.number().int().nonnegative().optional(),
  raced: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /**
   * Backend-local scan position for plan/package reference-window passes. Reuse
   * only with the same target, backend and class; this is not deletion authority.
   * A later full observation pass starts again after the final page.
   */
  nextAfterId: z.string().min(1).max(128).optional(),
  retainedByReason: z.partialRecord(
    RetentionEligibilityReasonSchema,
    z.number().int().nonnegative()
  ),
})

export type RetentionDeletionResult = z.output<typeof RetentionDeletionResultSchema>

/**
 * Adds two per-reason retained counts. A class that spans more than one storage
 * table reports one merged reason map so an operator sees a single class.
 */
export function realizedCounts(
  left: Readonly<Record<string, number | undefined>>,
  right: Readonly<Record<string, number | undefined>>
): Record<string, number> {
  const merged: Record<string, number> = {}
  for (const [reason, count] of Object.entries(left)) {
    if (count !== undefined) merged[reason] = count
  }
  for (const [reason, count] of Object.entries(right)) {
    if (count === undefined) continue
    merged[reason] = (merged[reason] ?? 0) + count
  }
  return merged
}

/** The acceptance instant recorded inside a stored receipt, when it has one. */
export function acceptedInstant(receipt: unknown): string | undefined {
  const value = (receipt as { acceptedAt?: unknown } | null)?.acceptedAt
  return typeof value === 'string' ? value : undefined
}

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
    if (!Number.isSafeInteger(bound) || bound < 0)
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
