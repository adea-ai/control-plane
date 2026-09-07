import {
  EvidenceAuditFixtureSchema,
  evidenceAuditFixtureDigest,
  runEvidenceAuditEval,
  evidenceAuditMetrics,
  type EvidenceAuditExecutor,
} from './evidence-audit-eval.js'
import type { EvalSuite, ObservedEvaluationCase } from './evaluations.js'

export type EvidenceAuditReceipt = Awaited<ReturnType<typeof runEvidenceAuditEval>>

/** Host-owned binding; the evaluated executor never receives metrics or the evidence sink. */
export function createEvidenceAuditMetricsExecutor(options: {
  fixtures: readonly unknown[]
  executor: EvidenceAuditExecutor
  executorReference: string
  seed: number
  timeoutMs?: number
  /** Optional extra archive. The receipt is also persisted atomically inside the evaluation run. */
  recordEvidence?(receipt: EvidenceAuditReceipt): Promise<void>
}): (evaluationCase: EvalSuite['cases'][number]) => Promise<ObservedEvaluationCase> {
  const fixtures = options.fixtures.map((input) => EvidenceAuditFixtureSchema.parse(input))
  if (
    fixtures.length === 0 ||
    new Set(fixtures.map((fixture) => fixture.taskId)).size !== fixtures.length
  )
    throw new Error('EVIDENCE_AUDIT_FIXTURE_SET_INVALID')
  const bindings = new Map(
    fixtures.map((fixture) => [
      fixture.taskId,
      {
        fixture,
        digest: evidenceAuditFixtureDigest(fixture),
      },
    ])
  )
  const { executor, executorReference, seed, timeoutMs, recordEvidence } = options
  return async (evaluationCase) => {
    const binding = bindings.get(evaluationCase.evalCaseId)
    if (!binding || binding.digest !== evaluationCase.inputDigest)
      throw new Error('EVIDENCE_AUDIT_CASE_BINDING_MISMATCH')
    const receipt = await runEvidenceAuditEval({
      fixture: binding.fixture,
      executor,
      executorReference,
      seed,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
    const metrics = evidenceAuditMetrics(receipt)
    await recordEvidence?.(structuredClone(receipt))
    return { metrics, observation: receipt }
  }
}
