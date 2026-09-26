import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'
import {
  RetentionAssessmentCounter,
  RetentionJournalOperationSchema,
  evaluateRetentionEligibility,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import {
  EvalRunSchema,
  type EvalRun,
  type EvaluationRepository,
} from '@control-plane/production-readiness'

export class SqliteEvaluationRepository implements EvaluationRepository {
  constructor(readonly provider: PersistenceProvider) {}

  async saveRun(input: EvalRun): Promise<void> {
    const run = EvalRunSchema.parse(input)
    await this.provider.transaction(async (transaction) => {
      const id = recordId(run.evalRunId)
      const stored = await transaction.get('evaluation-runs', id)
      if (stored) {
        const existing = EvalRunSchema.parse(stored.value)
        if (existing.evalRunId !== run.evalRunId) throw new Error('EVALUATION_RUN_ROW_INCONSISTENT')
        if (!isDeepStrictEqual(existing, run)) throw new Error('EVALUATION_RUN_CONFLICT')
        return
      }
      await transaction.put({
        namespace: 'evaluation-runs',
        id,
        value: JSON.parse(JSON.stringify(run)) as JsonValue,
      })
    })
  }

  async getRun(evalRunId: string): Promise<EvalRun | undefined> {
    EvalRunSchema.shape.evalRunId.parse(evalRunId)
    return this.provider.transaction(async (transaction) => {
      const stored = await transaction.get('evaluation-runs', recordId(evalRunId))
      if (!stored) return undefined
      const run = EvalRunSchema.parse(stored.value)
      if (run.evalRunId !== evalRunId) throw new Error('EVALUATION_RUN_ROW_INCONSISTENT')
      return run
    })
  }

  /**
   * Deletes evaluation runs past their retention window (#194). A run is
   * release evidence, so eligibility is the window alone — nothing references a
   * run — and the deletion is dry-run by default, bounded, revision-guarded and
   * journalled like every other class. It replaces an earlier cutoff-only
   * primitive that deleted without a dry run, a bound or a journal.
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
    let afterId: string | undefined
    let done = false
    while (!done) {
      const page = await this.provider.transaction((transaction) =>
        transaction.scan('evaluation-runs', {
          limit: 128,
          ...(afterId === undefined ? {} : { afterId }),
        })
      )
      if (page.length === 0) break
      afterId = page[page.length - 1]?.id
      for (const record of page) {
        const outcome = await this.provider.transaction(async (transaction) => {
          const stored = await transaction.get('evaluation-runs', record.id)
          if (stored === undefined)
            return { verdict: undefined, admitted: false, removed: false }
          let run: EvalRun
          try {
            run = EvalRunSchema.parse(stored.value)
          } catch {
            // Unreadable evidence is never a deletion candidate.
            return { verdict: undefined, admitted: false, removed: false }
          }
          const verdict = evaluateRetentionEligibility({
            retentionExpiresAt:
              options.policyRetainMs === null
                ? undefined
                : new Date(Date.parse(run.completedAt) + options.policyRetainMs).toISOString(),
            now: assessedAt,
            policyRetainMs: options.policyRetainMs,
            ownerTerminal: true,
            publicationSettled: true,
            rejectionKeyReserved: true,
            pendingReferences: 0,
            holds: 0,
          })
          if (!counter.add(verdict)) return { verdict, admitted: false, removed: false }
          if (verdict.verdict !== 'eligible' || dryRun)
            return { verdict, admitted: true, removed: false }
          if (options.journal !== undefined) {
            await options.journal(
              RetentionJournalOperationSchema.array().parse([
                { kind: 'sqlite.delete', namespace: 'evaluation-runs', id: stored.id },
              ])
            )
          }
          let removed = false
          try {
            removed = await transaction.delete('evaluation-runs', stored.id, stored.revision)
          } catch {
            return { verdict, admitted: true, removed: false }
          }
          return { verdict, admitted: true, removed }
        })
        if (outcome.verdict !== undefined && !outcome.admitted) {
          done = true
          break
        }
        if (outcome.removed) deleted += 1
      }
      if (page.length < 128) break
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }
}

function recordId(value: string): string {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}
