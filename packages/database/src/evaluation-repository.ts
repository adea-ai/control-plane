import { isDeepStrictEqual } from 'node:util'
import {
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  type RetentionDeletionResult,
  type RetentionJournalSink,
  type RetentionHoldPolicy,
} from '@control-plane/domain'
import {
  EvalRunSchema,
  type EvalRun,
  type EvaluationRepository,
} from '@control-plane/production-readiness'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { evaluationRuns, releaseAuditRecords } from './schema/evaluations.js'
import {
  acquirePostgresRetentionHoldClassMutex,
  countPostgresMatchingActiveRetentionHolds,
  validatePostgresRetentionHoldPolicy,
} from './retention-hold-repository.js'

export class PostgresEvaluationRepository implements EvaluationRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  /**
   * Deletes evaluation runs past their retention window (#194). A run is release
   * evidence, so eligibility is the window alone — nothing references a run —
   * and the deletion is dry-run by default, bounded and journalled like every
   * other class. It replaces an earlier cutoff-only primitive that deleted
   * without a dry run, a bound or a journal.
   */
  async deleteEligibleEvaluationRuns(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
      readonly retentionHoldPolicy?: RetentionHoldPolicy
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('EVALUATION_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter(
      'evaluation-runs',
      assessedAt,
      options.bound ?? 64
    )
    let deleted = 0
    let raced = 0
    const candidates = await this.database
      .select({ evalRunId: evaluationRuns.evalRunId, completedAt: evaluationRuns.completedAt })
      .from(evaluationRuns)
      .where(
        options.policyRetainMs === null
          ? sql`true`
          : lt(evaluationRuns.completedAt, new Date(now.getTime() - options.policyRetainMs))
      )
      .orderBy(asc(evaluationRuns.completedAt))
      .limit(counter.bound + 1)
    await this.database.transaction((transaction) =>
      validatePostgresRetentionHoldPolicy(transaction, options.retentionHoldPolicy)
    )
    for (const candidate of candidates) {
      if (!counter.admitCandidate()) break
      const outcome = await this.database.transaction(async (transaction) => {
        await acquirePostgresRetentionHoldClassMutex(transaction, 'evaluation-runs')
        const [stored] = await transaction
          .select({ completedAt: evaluationRuns.completedAt })
          .from(evaluationRuns)
          .where(eq(evaluationRuns.evalRunId, candidate.evalRunId))
          .limit(1)
          .for('update')
        if (stored === undefined) return { verdict: undefined, removed: false, raced: true }
        const holds = await countPostgresMatchingActiveRetentionHolds(
          transaction,
          { classId: 'evaluation-runs', scope: { kind: 'class' } },
          options.retentionHoldPolicy
        )
        const freshVerdict = evaluateRetentionEligibility({
          retentionExpiresAt:
            options.policyRetainMs === null
              ? undefined
              : new Date(stored.completedAt.getTime() + options.policyRetainMs).toISOString(),
          now: assessedAt,
          policyRetainMs: options.policyRetainMs,
          ownerTerminal: true,
          publicationSettled: true,
          rejectionKeyReserved: true,
          pendingReferences: 0,
          holds,
        })
        counter.recordVerdict(freshVerdict)
        if (freshVerdict.verdict !== 'eligible' || dryRun)
          return { verdict: freshVerdict, removed: false, raced: false, bound: false }
        if (options.journal !== undefined) {
          await options.journal([
            { kind: 'postgres.deleteEvaluationRun', evalRunId: candidate.evalRunId },
          ])
        }
        const removed = await transaction
          .delete(evaluationRuns)
          .where(
            and(
              eq(evaluationRuns.evalRunId, candidate.evalRunId),
              lt(evaluationRuns.completedAt, now)
            )
          )
          .returning({ evalRunId: evaluationRuns.evalRunId })
        return {
          verdict: freshVerdict,
          removed: removed.length === 1,
          raced: removed.length !== 1,
          bound: false,
        }
      })
      if (outcome.bound) break
      if (outcome.raced) raced += 1
      if (outcome.removed) deleted += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }

  /**
   * Deletes release audit records past their retention window (#194). These
   * records are release evidence and the owner's decision gives them their own
   * longer window (400 days by default); the pass is dry-run by default,
   * bounded and journalled, and it never removes anything inside the window.
   */
  async deleteEligibleReleaseAuditRecords(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
      readonly retentionHoldPolicy?: RetentionHoldPolicy
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('AUDIT_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter('audit-records', assessedAt, options.bound ?? 64)
    let deleted = 0
    let raced = 0
    const candidates = await this.database
      .select({
        releaseAuditId: releaseAuditRecords.releaseAuditId,
        createdAt: releaseAuditRecords.createdAt,
      })
      .from(releaseAuditRecords)
      .where(
        options.policyRetainMs === null
          ? sql`true`
          : lt(releaseAuditRecords.createdAt, new Date(now.getTime() - options.policyRetainMs))
      )
      .orderBy(asc(releaseAuditRecords.createdAt))
      .limit(counter.bound + 1)
    await this.database.transaction((transaction) =>
      validatePostgresRetentionHoldPolicy(transaction, options.retentionHoldPolicy)
    )
    for (const candidate of candidates) {
      if (!counter.admitCandidate()) break
      const outcome = await this.database.transaction(async (transaction) => {
        await acquirePostgresRetentionHoldClassMutex(transaction, 'audit-records')
        const [stored] = await transaction
          .select({ createdAt: releaseAuditRecords.createdAt })
          .from(releaseAuditRecords)
          .where(eq(releaseAuditRecords.releaseAuditId, candidate.releaseAuditId))
          .limit(1)
          .for('update')
        if (stored === undefined) return { verdict: undefined, removed: false, raced: true }
        const holds = await countPostgresMatchingActiveRetentionHolds(
          transaction,
          { classId: 'audit-records', scope: { kind: 'class' } },
          options.retentionHoldPolicy
        )
        const freshVerdict = evaluateRetentionEligibility({
          retentionExpiresAt:
            options.policyRetainMs === null
              ? undefined
              : new Date(stored.createdAt.getTime() + options.policyRetainMs).toISOString(),
          now: assessedAt,
          policyRetainMs: options.policyRetainMs,
          ownerTerminal: true,
          publicationSettled: true,
          rejectionKeyReserved: true,
          pendingReferences: 0,
          holds,
        })
        counter.recordVerdict(freshVerdict)
        if (freshVerdict.verdict !== 'eligible' || dryRun)
          return { verdict: freshVerdict, removed: false, raced: false, bound: false }
        if (options.journal !== undefined) {
          await options.journal([
            { kind: 'postgres.deleteReleaseAuditRecord', releaseAuditId: candidate.releaseAuditId },
          ])
        }
        const removed = await transaction
          .delete(releaseAuditRecords)
          .where(eq(releaseAuditRecords.releaseAuditId, candidate.releaseAuditId))
          .returning({ releaseAuditId: releaseAuditRecords.releaseAuditId })
        return {
          verdict: freshVerdict,
          removed: removed.length === 1,
          raced: removed.length !== 1,
          bound: false,
        }
      })
      if (outcome.bound) break
      if (outcome.raced) raced += 1
      if (outcome.removed) deleted += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }

  async saveRun(value: EvalRun): Promise<void> {
    const run = EvalRunSchema.parse(value)
    const inserted = await this.database
      .insert(evaluationRuns)
      .values(toEvaluationRunRow(run))
      .onConflictDoNothing()
      .returning({ evalRunId: evaluationRuns.evalRunId })
    if (inserted.length === 1) return
    const current = await this.getRun(run.evalRunId)
    if (current === undefined) throw new Error('EVALUATION_RUN_SAVE_RACE')
    if (!isDeepStrictEqual(current, run)) throw new Error('EVALUATION_RUN_CONFLICT')
  }

  async getRun(evalRunId: string): Promise<EvalRun | undefined> {
    const [row] = await this.database
      .select()
      .from(evaluationRuns)
      .where(eq(evaluationRuns.evalRunId, evalRunId))
    return row === undefined ? undefined : fromEvaluationRunRow(row)
  }
}

type EvaluationRunRow = typeof evaluationRuns.$inferSelect

export function toEvaluationRunRow(run: EvalRun): typeof evaluationRuns.$inferInsert {
  const parsed = EvalRunSchema.parse(run)
  return {
    evalRunId: parsed.evalRunId,
    status: parsed.status,
    evidence: parsed,
    startedAt: new Date(parsed.startedAt),
    completedAt: new Date(parsed.completedAt),
  }
}

export function fromEvaluationRunRow(row: EvaluationRunRow): EvalRun {
  const run = EvalRunSchema.parse(row.evidence)
  if (
    row.evalRunId !== run.evalRunId ||
    row.status !== run.status ||
    row.startedAt.toISOString() !== run.startedAt ||
    row.completedAt.toISOString() !== run.completedAt
  ) {
    throw new Error('EVALUATION_RUN_ROW_INCONSISTENT')
  }
  return run
}
