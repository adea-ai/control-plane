import { createHash } from 'node:crypto'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import { RuntimeAttemptBudgetAuthoritySchema, RuntimeUsageSchema } from '@control-plane/runtime-sdk'
import { z } from 'zod'

/**
 * Correlated child usage with an explicit cost-state machine
 * (M13.04.2, refs adea-ai/control-plane#1019; coordinates with the
 * budget-allocator deliverable in adea-ai/control-plane#1018).
 *
 * Usage is retained against the full job/attempt identity (parent execution,
 * delegation, child execution, child attempt). Every cost state —
 * `estimated`, `reserved`, `reported`, `reconciled`, `settled` — exists only
 * when its evidence was explicitly recorded; a stage with no recorded
 * evidence is absent from the outcome, and an attempt with no evidence at all
 * surfaces as the explicit `unknown` cost state. Nothing is ever inferred:
 * the ledger does not convert an estimate or a reservation into a charge,
 * does not extrapolate reported usage, and never fills a missing stage with
 * a blank or zero value.
 *
 * The reservation stage consumes the runtime's existing
 * `RuntimeAttemptBudgetAuthority` contract verbatim — the same authority the
 * delegation runtime bridge already accepts from its `reserveBudget` seam —
 * so the future descendant-aware allocator (#1018) plugs in without a new
 * wire shape. Allocating that authority remains #1018's deliverable; this
 * ledger only records and reconciles against whichever authority the runtime
 * produced.
 */

const TimestampSchema = z.iso.datetime()
const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, 'Expected a safe integer')
const ReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)

/** Full job/attempt correlation for a usage record. */
export const ChildUsageIdentitySchema = z
  .object({
    parentExecutionId: IdentifierSchemas.executionId,
    delegationId: IdentifierSchemas.delegationId,
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId,
  })
  .strict()

export type ChildUsageIdentity = z.output<typeof ChildUsageIdentitySchema>

/**
 * An explicit cost estimate supplied before or at admission (for example the
 * plan compiler's budget ceiling). `source` names — opaquely — who supplied
 * it. An estimate is recorded evidence, never derived from usage.
 */
export const ChildCostEstimateSchema = z
  .object({
    currency: z.literal('USD'),
    maximumMicrounits: SafeNonnegativeIntegerSchema,
    source: ReferenceSchema,
  })
  .strict()

export type ChildCostEstimate = z.output<typeof ChildCostEstimateSchema>

/**
 * The outcome of reconciling reported usage against recorded evidence. With a
 * reservation recorded, the reported charge is compared against the reserved
 * maximum (`within_reservation` / `exceeded_reservation`); without one, the
 * reconciliation records exactly that (`without_reservation`) instead of
 * inventing a bound. The compared figures are frozen into the record so a
 * later report cannot silently change what was reconciled.
 */
export const ChildUsageReconciliationSchema = z
  .object({
    result: z.enum(['within_reservation', 'exceeded_reservation', 'without_reservation']),
    reconciledAt: TimestampSchema,
    reportedChargedMicrounits: SafeNonnegativeIntegerSchema,
    reservedMaximumMicrounits: SafeNonnegativeIntegerSchema.optional(),
  })
  .strict()

export type ChildUsageReconciliation = z.output<typeof ChildUsageReconciliationSchema>

/**
 * An explicit settlement recorded by an authorized settler. The settled
 * amount is exactly what was settled — the ledger never computes it from
 * estimates, reservations or reports.
 */
export const ChildUsageSettlementSchema = z
  .object({
    currency: z.literal('USD'),
    settledMicrounits: SafeNonnegativeIntegerSchema,
    settledAt: TimestampSchema,
    settlementRef: ReferenceSchema,
  })
  .strict()

export type ChildUsageSettlement = z.output<typeof ChildUsageSettlementSchema>

/**
 * The explicit cost state: the most advanced stage with recorded evidence.
 * `unknown` is a first-class state — an attempt whose usage was never
 * reported, estimated, reserved, reconciled or settled is `unknown`, never
 * silently blank and never zero.
 */
export const ChildCostStateSchema = z.enum([
  'unknown',
  'estimated',
  'reserved',
  'reported',
  'reconciled',
  'settled',
])

export type ChildCostState = z.output<typeof ChildCostStateSchema>

/** Retained outcome for one child attempt's usage. */
export const ChildUsageOutcomeSchema = z
  .object({
    identity: ChildUsageIdentitySchema,
    costState: ChildCostStateSchema,
    estimated: ChildCostEstimateSchema.optional(),
    reserved: RuntimeAttemptBudgetAuthoritySchema.optional(),
    reported: RuntimeUsageSchema.optional(),
    /** Usage reports retained for this attempt (the latest kept as `reported`). */
    usageReportCount: z.number().int().positive().optional(),
    reconciled: ChildUsageReconciliationSchema.optional(),
    settled: ChildUsageSettlementSchema.optional(),
  })
  .strict()

export type ChildUsageOutcome = z.output<typeof ChildUsageOutcomeSchema>

export type ChildUsageReportReceipt =
  | ({ readonly outcome: 'recorded' } & ChildUsageOutcome)
  | { readonly outcome: 'duplicate_report'; readonly reportId: string }
  | { readonly outcome: 'conflicting_report'; readonly reportId: string }

export type ChildUsageLedgerErrorCode = 'CONFIGURATION' | 'IDENTITY_CONFLICT' | 'EVIDENCE_MISSING'

export class ChildUsageLedgerError extends Error {
  constructor(
    readonly code: ChildUsageLedgerErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChildUsageLedgerError'
  }
}

type ReservedUsage = z.output<typeof RuntimeAttemptBudgetAuthoritySchema>
type ReportedUsage = z.output<typeof RuntimeUsageSchema>

interface ChildUsageEntry {
  readonly identity: ChildUsageIdentity
  estimated: ChildCostEstimate | undefined
  reserved: ReservedUsage | undefined
  reported: ReportedUsage | undefined
  usageReportCount: number | undefined
  reconciled: ChildUsageReconciliation | undefined
  settled: ChildUsageSettlement | undefined
  /** Content fingerprint per report id; committed only for retained reports. */
  reportFingerprints: Map<string, string>
}

function costStateOf(
  entry: Pick<ChildUsageEntry, 'estimated' | 'reserved' | 'reported' | 'reconciled' | 'settled'>
): ChildCostState {
  let state: ChildCostState = 'unknown'
  for (const stage of ['estimated', 'reserved', 'reported', 'reconciled', 'settled'] as const) {
    if (entry[stage] !== undefined) state = stage
  }
  return state
}

function usageFingerprint(usage: ReportedUsage): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(usage)).digest('hex')}`
}

export interface ChildUsageLedgerOptions {
  /**
   * Bounded memory for report deduplication per attempt. Default 8192; the
   * oldest fingerprint is evicted, mirroring the evidence buffer's duplicate
   * tracking (a redelivery of an evicted report id re-folds as a new report).
   */
  readonly maximumTrackedReportIds?: number
}

/**
 * Retains usage correlated to job/attempt identities with the explicit
 * estimated/reserved/reported/reconciled/settled/unknown cost state machine.
 * Identities and reports are owner-supplied and schema-validated like
 * evidence-buffer events; the owner supplies each report's delivery identity
 * (`reportId`) because redelivery policy is the owner's.
 */
export class ChildUsageLedger {
  readonly #entries = new Map<string, ChildUsageEntry>()
  readonly #maximumTrackedReportIds: number

  constructor(options: ChildUsageLedgerOptions = {}) {
    this.#maximumTrackedReportIds = options.maximumTrackedReportIds ?? 8_192
    if (this.#maximumTrackedReportIds < 16) {
      throw new ChildUsageLedgerError(
        'CONFIGURATION',
        'maximumTrackedReportIds must be at least 16'
      )
    }
  }

  /** Records an explicit cost estimate for the attempt. */
  recordEstimate(identity: unknown, estimate: unknown): ChildUsageOutcome {
    const entry = this.#entryFor(identity)
    entry.estimated = ChildCostEstimateSchema.parse(estimate)
    return this.#outcome(entry)
  }

  /**
   * Records a runtime attempt budget reservation (the existing
   * `RuntimeAttemptBudgetAuthority` produced by the delegation runtime
   * bridge's `reserveBudget` seam). A reservation binding a different
   * execution or attempt than the record's identity is a conflict, not a
   * silent retarget.
   */
  recordReservation(identity: unknown, reservation: unknown): ChildUsageOutcome {
    const parsedIdentity = ChildUsageIdentitySchema.parse(identity)
    const entry = this.#entryFor(parsedIdentity)
    const parsed = RuntimeAttemptBudgetAuthoritySchema.parse(reservation)
    if (
      parsed.executionId !== parsedIdentity.childExecutionId ||
      parsed.attemptId !== parsedIdentity.childAttemptId
    ) {
      throw new ChildUsageLedgerError(
        'IDENTITY_CONFLICT',
        'Reservation binds a different execution/attempt than the usage record'
      )
    }
    entry.reserved = parsed
    return this.#outcome(entry)
  }

  /**
   * Retains a runtime usage report (validated against the runtime SDK's
   * `RuntimeUsage` contract). The latest report is retained as `reported`
   * with a retained-report count; a redelivered `reportId` is answered as a
   * duplicate without folding, and a reused `reportId` with different content
   * conflicts instead of silently overwriting. Recording a new report after a
   * reconciliation explicitly clears the reconciliation — it reconciled the
   * previous report, and presenting it against a newer one would be stale.
   */
  recordReportedUsage(
    identity: unknown,
    usage: unknown,
    delivery: { readonly reportId: string }
  ): ChildUsageReportReceipt | ChildUsageOutcome {
    const entry = this.#entryFor(identity)
    const reportId = ReferenceSchema.parse(delivery.reportId)
    const parsed = RuntimeUsageSchema.parse(usage)
    const fingerprint = usageFingerprint(parsed)
    const seen = entry.reportFingerprints.get(reportId)
    if (seen !== undefined) {
      if (seen !== fingerprint) {
        return { outcome: 'conflicting_report', reportId }
      }
      return { outcome: 'duplicate_report', reportId }
    }
    entry.reported = parsed
    entry.usageReportCount = (entry.usageReportCount ?? 0) + 1
    // A reconciliation belongs to the report it compared; a newer report
    // supersedes it explicitly (the caller reconciles again for the new one).
    entry.reconciled = undefined
    this.#trackReportId(entry, reportId, fingerprint)
    return { outcome: 'recorded', ...this.#outcome(entry) }
  }

  /**
   * Reconciles the retained report against recorded evidence. Requires a
   * reported usage with an accounting charge — reconciling without reported
   * evidence would fabricate a comparison, so it fails with
   * `EVIDENCE_MISSING` and the outcome keeps its explicit state instead.
   * The reported charge is compared against the reserved maximum when a
   * reservation exists and recorded as `without_reservation` when none does.
   */
  reconcile(identity: unknown, input: { readonly reconciledAt: string }): ChildUsageOutcome {
    const entry = this.#entryFor(identity)
    const reportedChargedMicrounits = entry.reported?.accounting?.chargedMicrounits
    if (entry.reported === undefined || reportedChargedMicrounits === undefined) {
      throw new ChildUsageLedgerError(
        'EVIDENCE_MISSING',
        'Reconciliation requires a reported usage with accounting charges'
      )
    }
    const reconciledAt = TimestampSchema.parse(input.reconciledAt)
    entry.reconciled =
      entry.reserved === undefined
        ? {
            result: 'without_reservation',
            reconciledAt,
            reportedChargedMicrounits,
          }
        : {
            result:
              reportedChargedMicrounits > entry.reserved.maximumMicrounits
                ? 'exceeded_reservation'
                : 'within_reservation',
            reconciledAt,
            reportedChargedMicrounits,
            reservedMaximumMicrounits: entry.reserved.maximumMicrounits,
          }
    return this.#outcome(entry)
  }

  /** Records an explicit settlement by an authorized settler. */
  settle(identity: unknown, settlement: unknown): ChildUsageOutcome {
    const entry = this.#entryFor(identity)
    entry.settled = ChildUsageSettlementSchema.parse(settlement)
    return this.#outcome(entry)
  }

  /**
   * The attempt's retained outcome. An attempt with no recorded evidence
   * surfaces as `costState: 'unknown'` — explicitly unknown, never a blank
   * record or an inferred zero.
   */
  status(identity: unknown): ChildUsageOutcome {
    const parsed = ChildUsageIdentitySchema.parse(identity)
    const entry = this.#entries.get(this.#key(parsed))
    return entry ? this.#outcome(entry) : { identity: parsed, costState: 'unknown' }
  }

  /** Every retained attempt for the delegation, sorted by attempt identity. */
  listByDelegation(delegationId: string): readonly ChildUsageOutcome[] {
    const parsed = IdentifierSchemas.delegationId.parse(delegationId)
    return [...this.#entries.values()]
      .filter((entry) => entry.identity.delegationId === parsed)
      .map((entry) => this.#outcome(entry))
      .toSorted((left, right) =>
        left.identity.childAttemptId < right.identity.childAttemptId ? -1 : 1
      )
  }

  #key(identity: ChildUsageIdentity): string {
    return `${identity.delegationId}:${identity.childAttemptId}`
  }

  /**
   * Resolves (or creates) the attempt's record. A known delegation/attempt
   * key reporting a different parent or child execution is a correlation
   * conflict — the same explicit treatment the evidence buffer applies to
   * changed child identities inside a generation.
   */
  #entryFor(identity: unknown): ChildUsageEntry {
    const parsed = ChildUsageIdentitySchema.parse(identity)
    const key = this.#key(parsed)
    const existing = this.#entries.get(key)
    if (existing) {
      if (
        existing.identity.parentExecutionId !== parsed.parentExecutionId ||
        existing.identity.childExecutionId !== parsed.childExecutionId
      ) {
        throw new ChildUsageLedgerError(
          'IDENTITY_CONFLICT',
          'Attempt identity already correlated to a different parent/child execution'
        )
      }
      return existing
    }
    const entry: ChildUsageEntry = {
      identity: parsed,
      estimated: undefined,
      reserved: undefined,
      reported: undefined,
      usageReportCount: undefined,
      reconciled: undefined,
      settled: undefined,
      reportFingerprints: new Map(),
    }
    this.#entries.set(key, entry)
    return entry
  }

  #trackReportId(entry: ChildUsageEntry, reportId: string, fingerprint: string): void {
    entry.reportFingerprints.set(reportId, fingerprint)
    while (entry.reportFingerprints.size > this.#maximumTrackedReportIds) {
      const oldest = entry.reportFingerprints.keys().next()
      if (oldest.done) break
      entry.reportFingerprints.delete(oldest.value)
    }
  }

  #outcome(entry: ChildUsageEntry): ChildUsageOutcome {
    return ChildUsageOutcomeSchema.parse({
      identity: entry.identity,
      costState: costStateOf(entry),
      ...(entry.estimated !== undefined ? { estimated: entry.estimated } : {}),
      ...(entry.reserved !== undefined ? { reserved: entry.reserved } : {}),
      ...(entry.reported !== undefined ? { reported: entry.reported } : {}),
      ...(entry.usageReportCount !== undefined ? { usageReportCount: entry.usageReportCount } : {}),
      ...(entry.reconciled !== undefined ? { reconciled: entry.reconciled } : {}),
      ...(entry.settled !== undefined ? { settled: entry.settled } : {}),
    })
  }
}
