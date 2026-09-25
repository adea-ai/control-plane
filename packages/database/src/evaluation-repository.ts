import { isDeepStrictEqual } from 'node:util'
import {
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import {
  EvalRunSchema,
  type EvalRun,
  type EvaluationRepository,
} from '@control-plane/production-readiness'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { evaluationRuns, releaseAuditRecords } from './schema/evaluations.js'

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
    for (const candidate of candidates) {
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt:
          options.policyRetainMs === null
            ? undefined
            : new Date(candidate.completedAt.getTime() + options.policyRetainMs).toISOString(),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        ownerTerminal: true,
        publicationSettled: true,
        rejectionKeyReserved: true,
        pendingReferences: 0,
        holds: 0,
      })
      if (!counter.add(verdict)) break
      if (verdict.verdict !== 'eligible' || dryRun) continue
      if (options.journal !== undefined) {
        await options.journal([
          { kind: 'postgres.deleteEvaluationRun', evalRunId: candidate.evalRunId },
        ])
      }
      const removed = await this.database
        .delete(evaluationRuns)
        .where(
          and(
            eq(evaluationRuns.evalRunId, candidate.evalRunId),
            lt(evaluationRuns.completedAt, now)
          )
        )
        .returning({ evalRunId: evaluationRuns.evalRunId })
      if (removed.length === 1) deleted += 1
      else raced += 1
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
    for (const candidate of candidates) {
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt:
          options.policyRetainMs === null
            ? undefined
            : new Date(candidate.createdAt.getTime() + options.policyRetainMs).toISOString(),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        ownerTerminal: true,
        publicationSettled: true,
        rejectionKeyReserved: true,
        pendingReferences: 0,
        holds: 0,
      })
      if (!counter.add(verdict)) break
      if (verdict.verdict !== 'eligible' || dryRun) continue
      if (options.journal !== undefined) {
        await options.journal([
          { kind: 'postgres.deleteReleaseAuditRecord', releaseAuditId: candidate.releaseAuditId },
        ])
      }
      const removed = await this.database
        .delete(releaseAuditRecords)
        .where(eq(releaseAuditRecords.releaseAuditId, candidate.releaseAuditId))
        .returning({ releaseAuditId: releaseAuditRecords.releaseAuditId })
      if (removed.length === 1) deleted += 1
      else raced += 1
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
