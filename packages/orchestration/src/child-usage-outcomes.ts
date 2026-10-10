import { createHash } from 'node:crypto'
import {
  canonicalJsonStringify,
  compareCodePointOrder,
  IdentifierSchemas,
} from '@control-plane/contracts'
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
  /**
   * The report's content was already superseded by a newer retained report:
   * a redelivery from beyond the dedup horizon may never overwrite it.
   */
  | { readonly outcome: 'stale_report'; readonly reportId: string }

const SnapshotFingerprintSchema = z.string().min(1).max(128)

/**
 * One retained outcome together with its dedup horizons, shaped for durable
 * persistence by the owner. Fingerprints are content hashes — secret-free by
 * construction — and restoring them keeps report dedup, stale-report
 * protection and settlement/reconciliation staleness guarantees intact
 * across a restart instead of resetting the horizons.
 */
export const ChildUsageLedgerSnapshotEntrySchema = z
  .object({
    outcome: ChildUsageOutcomeSchema,
    reportFingerprints: z.array(z.tuple([z.string().min(1).max(256), SnapshotFingerprintSchema])),
    supersededFingerprints: z.array(SnapshotFingerprintSchema),
    /**
     * O(1) watermark of the highest canonical publication sequence this entry
     * has accepted. Unlike the bounded dedup horizons it is never evicted, so
     * an old report replayed from beyond the horizon can still be ordered as
     * stale instead of overwriting newer reconciled/settled truth.
     * Optional so a sequence-free (older) snapshot restores safely to 0
     * instead of failing schema validation.
     */
    highestPublication: z.number().int().nonnegative().optional(),
    /**
     * O(1) identity binding of the retained publication: the report id that
     * owns the watermark. A different id claiming the retained sequence is a
     * conflict even when its usage body matches.
     */
    retainedReportId: z.string().min(1).max(256).optional(),
  })
  .strict()

export const ChildUsageLedgerSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(ChildUsageLedgerSnapshotEntrySchema),
  })
  .strict()

export type ChildUsageLedgerSnapshot = z.output<typeof ChildUsageLedgerSnapshotSchema>

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
  /**
   * Fingerprints of reports this entry has already superseded, bounded like
   * the report-id horizon. Without it, a redelivered OLD report whose id was
   * evicted would look brand new and overwrite the newer retained report.
   */
  supersededFingerprints: Set<string>
  /**
   * Highest canonical publication sequence accepted for this entry. Never
   * evicted: it is the ordering watermark that keeps an old replay stale even
   * after both bounded horizons have turned over.
   */
  highestPublication: number
  /** O(1) report id that owns the watermark above. */
  retainedReportId: string | undefined
  /** True when a restored snapshot predates the ordering watermark. */
  orderingUncertain: boolean
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
   * Bounded memory for report deduplication and superseded-content tracking
   * per attempt. Default 8192; the oldest entries are evicted, mirroring the
   * evidence buffer's duplicate tracking. Beyond that horizon a redelivered
   * report id is re-folded by content: an identical redelivery still answers
   * `duplicate_report`, and content already superseded by a newer report
   * answers `stale_report` instead of overwriting it.
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
   * silent retarget. A new reservation supersedes any reconciliation: the
   * frozen comparison was made against the previous reserved bound and must
   * not be presented as if it covered this one.
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
    entry.reconciled = undefined
    return this.#outcome(entry)
  }

  /**
   * Retains a runtime usage report (validated against the runtime SDK's
   * `RuntimeUsage` contract). The latest report is retained as `reported`
   * with a retained-report count; a redelivered `reportId` is answered as a
   * duplicate without folding, and a reused `reportId` with different content
   * conflicts instead of silently overwriting. Beyond the bounded dedup
   * horizon the report id alone cannot order reports, so content decides: a
   * redelivery identical to the retained report is still a duplicate, and
   * content this entry has already superseded answers `stale_report` — an old
   * report can never overwrite a newer one. Recording a newer report
   * explicitly clears the reconciliation AND the settlement recorded against
   * its predecessor: both belonged to the superseded report, and presenting
   * either against the newer one would be stale. The caller reconciles and
   * settles the new report explicitly.
   */
  recordReportedUsage(
    identity: unknown,
    usage: unknown,
    delivery: { readonly reportId: string; readonly publicationSequence?: number }
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
    const sequence = delivery.publicationSequence
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) {
      // A malformed canonical sequence must fail closed before any mutation;
      // it can never be trusted to order a report.
      throw new ChildUsageLedgerError(
        'CONFIGURATION',
        'publicationSequence must be a positive safe integer'
      )
    }
    if (sequence === undefined) {
      // A sequence-free delivery is only trustworthy while no ordered
      // publication has happened yet. Once the canonical ordering history
      // exists the retained-content horizon cannot order an arbitrary replay,
      // so the report fails closed instead of overwriting newer truth.
      if (entry.highestPublication > 0) {
        return { outcome: 'conflicting_report', reportId }
      }
      if (entry.reported !== undefined) {
        if (usageFingerprint(entry.reported) === fingerprint) {
          return { outcome: 'duplicate_report', reportId }
        }
        if (entry.supersededFingerprints.has(fingerprint)) {
          return { outcome: 'stale_report', reportId }
        }
        // Ambiguous history: a restored snapshot that predates the ordering
        // watermark cannot order an unorderable report, so it never overwrites
        // the retained truth it carried across the restart.
        if (entry.orderingUncertain) {
          return { outcome: 'conflicting_report', reportId }
        }
      }
    } else if (sequence < entry.highestPublication) {
      // The canonical sequence orders the report against everything retained,
      // even beyond the bounded dedup horizons: an older sequence is stale.
      return { outcome: 'stale_report', reportId }
    } else if (sequence === entry.highestPublication) {
      // The retained sequence is owned by exactly one report id: an identical
      // redelivery converges, while a changed id or body is a conflict even
      // when the usage bytes match.
      return entry.retainedReportId === reportId &&
        entry.reported !== undefined &&
        usageFingerprint(entry.reported) === fingerprint
        ? { outcome: 'duplicate_report', reportId }
        : { outcome: 'conflicting_report', reportId }
    }
    const previous = entry.reported
    entry.reported = parsed
    entry.usageReportCount = (entry.usageReportCount ?? 0) + 1
    // Reconciliation and settlement are evidence about the report they were
    // recorded against; a newer report supersedes both explicitly.
    entry.reconciled = undefined
    entry.settled = undefined
    if (previous !== undefined) this.#trackSuperseded(entry, usageFingerprint(previous))
    if (sequence !== undefined) {
      entry.highestPublication = sequence
      entry.retainedReportId = reportId
    }
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
   * record or an inferred zero. The caller must present the SAME parent and
   * child executions the record is correlated to: delegation and attempt
   * identity alone never unlock an outcome bound to different executions.
   */
  status(identity: unknown): ChildUsageOutcome {
    const parsed = ChildUsageIdentitySchema.parse(identity)
    const entry = this.#entries.get(this.#key(parsed))
    if (entry === undefined) return { identity: parsed, costState: 'unknown' }
    if (
      entry.identity.parentExecutionId !== parsed.parentExecutionId ||
      entry.identity.childExecutionId !== parsed.childExecutionId
    ) {
      throw new ChildUsageLedgerError(
        'IDENTITY_CONFLICT',
        'Attempt identity already correlated to a different parent/child execution'
      )
    }
    return this.#outcome(entry)
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

  /**
   * Serializes every retained outcome with its dedup horizons for the owner
   * to persist through the canonical durable path. Content fingerprints are
   * hashes — secret-free by construction — and entries are ordered by
   * attempt identity so equal states serialize comparably.
   */
  snapshot(): ChildUsageLedgerSnapshot {
    return {
      schemaVersion: 1,
      entries: [...this.#entries.values()]
        .map((entry) => ({
          outcome: this.#outcome(entry),
          reportFingerprints: [...entry.reportFingerprints],
          supersededFingerprints: [...entry.supersededFingerprints],
          highestPublication: entry.highestPublication,
          retainedReportId: entry.retainedReportId,
        }))
        .toSorted((left, right) =>
          compareCodePointOrder(
            `${left.outcome.identity.delegationId}:${left.outcome.identity.childAttemptId}`,
            `${right.outcome.identity.delegationId}:${right.outcome.identity.childAttemptId}`
          )
        ),
    }
  }

  /**
   * Restores a snapshot the owner loaded from durable storage, rebuilding the
   * dedup horizons alongside the evidence so restart does not reset report
   * dedup, stale-report protection or settlement/reconciliation staleness.
   * Validation is two-phase: every entry is checked and rederived first, so a
   * conflicting or inconsistent snapshot restores nothing instead of
   * half-applying. A duplicated snapshot key or an entry colliding with
   * retained evidence is an explicit IDENTITY_CONFLICT; an outcome that does
   * not rederive its own cost state is CONFIGURATION.
   */
  restore(snapshot: unknown): void {
    const parsed = ChildUsageLedgerSnapshotSchema.parse(snapshot)
    const prepared: Array<{ readonly key: string; readonly entry: ChildUsageEntry }> = []
    const seen = new Set<string>()
    for (const item of parsed.entries) {
      const outcome = ChildUsageOutcomeSchema.parse(item.outcome)
      const key = this.#key(outcome.identity)
      if (seen.has(key)) {
        throw new ChildUsageLedgerError(
          'IDENTITY_CONFLICT',
          'Snapshot contains a duplicate attempt identity'
        )
      }
      seen.add(key)
      const retained = this.#entries.get(key)
      if (retained !== undefined && this.#hasEvidence(retained)) {
        throw new ChildUsageLedgerError(
          'IDENTITY_CONFLICT',
          'Snapshot collides with retained evidence'
        )
      }
      const entry: ChildUsageEntry = {
        identity: outcome.identity,
        estimated: outcome.estimated,
        reserved: outcome.reserved,
        reported: outcome.reported,
        usageReportCount: outcome.usageReportCount,
        reconciled: outcome.reconciled,
        settled: outcome.settled,
        reportFingerprints: new Map(item.reportFingerprints),
        supersededFingerprints: new Set(item.supersededFingerprints),
        // An older sequence-free snapshot restores to a zero watermark, which
        // the ordering rules treat as uncertain ordering history rather than a
        // schema break.
        highestPublication: item.highestPublication ?? 0,
        retainedReportId: item.retainedReportId,
        // A snapshot that predates the ordering watermark lost its ordering
        // history on the wire: once it carries a report the evidence is
        // ambiguous, so a sequence-free replay must not overwrite it.
        orderingUncertain: item.highestPublication === undefined && outcome.reported !== undefined,
      }
      if (this.#outcome(entry).costState !== outcome.costState) {
        throw new ChildUsageLedgerError(
          'CONFIGURATION',
          'Snapshot outcome does not rederive from its own evidence'
        )
      }
      prepared.push({ key, entry })
    }
    for (const { key, entry } of prepared) this.#entries.set(key, entry)
  }

  #hasEvidence(entry: ChildUsageEntry): boolean {
    return (
      entry.estimated !== undefined ||
      entry.reserved !== undefined ||
      entry.reported !== undefined ||
      entry.usageReportCount !== undefined ||
      entry.reconciled !== undefined ||
      entry.settled !== undefined
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
      supersededFingerprints: new Set(),
      highestPublication: 0,
      retainedReportId: undefined,
      orderingUncertain: false,
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

  #trackSuperseded(entry: ChildUsageEntry, fingerprint: string): void {
    entry.supersededFingerprints.add(fingerprint)
    while (entry.supersededFingerprints.size > this.#maximumTrackedReportIds) {
      const oldest = entry.supersededFingerprints.values().next()
      if (oldest.done) break
      entry.supersededFingerprints.delete(oldest.value)
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
