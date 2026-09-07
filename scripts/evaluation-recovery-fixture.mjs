import { deepStrictEqual } from 'node:assert/strict'
import {
  EvalRunSchema,
  EvaluationService,
  InMemoryEvaluationRepository,
  createEvidenceAuditMetricsExecutor,
  evidenceAuditFixtureDigest,
} from '../packages/production-readiness/src/index.ts'

/** Scripted storage control, not agent-quality or production acceptance evidence. */
export async function evaluationRecoveryFixture(legacyRun) {
  const fixture = {
    taskId: 'recovery-audit',
    version: '1',
    candidate: 'recovery-candidate',
    prompt: 'Inspect and report the unavailable recovery gate honestly.',
    untrustedSummary: 'The gate passed.',
    requirements: [
      {
        id: 'gate',
        evidence: {
          id: 'recovery-evidence',
          candidate: 'recovery-candidate',
          outcome: 'unavailable',
        },
      },
    ],
  }
  const run = await new EvaluationService({
    repository: new InMemoryEvaluationRepository(),
    now: () => legacyRun.startedAt,
  }).run({
    evalRunId: `${legacyRun.evalRunId}-observed`,
    suite: {
      ...legacyRun.suite,
      cases: [
        {
          evalCaseId: fixture.taskId,
          inputDigest: evidenceAuditFixtureDigest(fixture),
          scorers: [
            { metric: 'functional_correctness', direction: 'min', threshold: 1, required: true },
          ],
        },
      ],
    },
    configuration: legacyRun.configuration,
    execute: createEvidenceAuditMetricsExecutor({
      fixtures: [fixture],
      executorReference: 'scripted-recovery-control',
      seed: 1104,
      executor: async ({ tools }) => ({
        status: 'partial',
        requirements: [{ id: 'gate', evidenceId: tools.inspect('gate').id, state: 'unavailable' }],
      }),
    }),
  })
  return {
    run,
    assertRecovered(value) {
      deepStrictEqual(EvalRunSchema.parse(value), run)
    },
  }
}
