import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'
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
}

function recordId(value: string): string {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}
