import { isDeepStrictEqual } from 'node:util'
import {
  EvalRunSchema,
  type EvalRun,
  type EvaluationRepository,
} from '@control-plane/production-readiness'
import { eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { evaluationRuns } from './schema/evaluations.js'

export class PostgresEvaluationRepository implements EvaluationRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

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
