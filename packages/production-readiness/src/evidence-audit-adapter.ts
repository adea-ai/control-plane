import {
  EvidenceAuditFixtureSchema,
  evidenceAuditFixtureDigest,
  runEvidenceAuditEval,
  type EvidenceAuditExecutor,
} from './evidence-audit-eval.js'
import type { EvalSuite, EvaluationMetricValues } from './evaluations.js'

export type EvidenceAuditReceipt = Awaited<ReturnType<typeof runEvidenceAuditEval>>

/** Host-owned binding; the evaluated executor never receives metrics or the evidence sink. */
export function createEvidenceAuditMetricsExecutor(options: {
  fixtures: readonly unknown[]
  executor: EvidenceAuditExecutor
  executorReference: string
  seed: number
  timeoutMs?: number
  /** Must retain the full receipt before acknowledging; failures prevent evaluation persistence. */
  recordEvidence(receipt: EvidenceAuditReceipt): Promise<void>
}): (evaluationCase: EvalSuite['cases'][number]) => Promise<EvaluationMetricValues> {
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
    const passed = (id: string) =>
      receipt.assertions.find((assertion) => assertion.id === id)?.passed === true
    const every = (prefix: string) => {
      const assertions = receipt.assertions.filter((assertion) => assertion.id.startsWith(prefix))
      return (
        assertions.length === binding.fixture.requirements.length &&
        assertions.every((assertion) => assertion.passed)
      )
    }
    const metrics: EvaluationMetricValues = {
      functional_correctness: Number(receipt.passed),
      goal_coverage: Number(passed('exact-requirement-coverage')),
      evidence_sufficiency: Number(every('observed:') && every('evidence:')),
      constraint_adherence: Number(passed('no-prohibited-actions') && passed('bounded-tools')),
      verification_completeness: Number(receipt.passed),
      latency_ms: receipt.durationMs,
    }
    await recordEvidence(structuredClone(receipt))
    return metrics
  }
}
