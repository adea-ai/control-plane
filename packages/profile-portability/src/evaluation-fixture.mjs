import {
  EvaluationService,
  InMemoryEvaluationRepository,
  createEvidenceAuditMetricsExecutor,
  evidenceAuditFixtureDigest,
} from '@control-plane/production-readiness'

export async function observedEvaluationFixture() {
  const fixture = {
    taskId: 'portable-audit',
    version: '1',
    candidate: 'candidate',
    prompt: 'Inspect the gate.',
    untrustedSummary: 'Everything passed.',
    requirements: [
      { id: 'gate', evidence: { id: 'run', candidate: 'candidate', outcome: 'unavailable' } },
    ],
  }
  const artifact = { id: 'offline-fixture', version: '1', digest: `sha256:${'1'.repeat(64)}` }
  return new EvaluationService({
    repository: new InMemoryEvaluationRepository(),
    now: () => '2026-09-07T12:00:00.000Z',
  }).run({
    evalRunId: 'portable-observed-eval',
    suite: {
      evalSuiteId: 'offline-suite',
      version: '1',
      digest: artifact.digest,
      dataset: artifact,
      mode: 'offline',
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
    configuration: {
      executionPlanDigest: artifact.digest,
      profile: artifact,
      skills: [],
      graph: artifact,
      runtime: artifact,
      model: artifact,
      tools: [],
      policy: artifact,
    },
    execute: createEvidenceAuditMetricsExecutor({
      fixtures: [fixture],
      executorReference: 'scripted-portability-control',
      seed: 1104,
      executor: async ({ tools }) => ({
        status: 'partial',
        requirements: [{ id: 'gate', evidenceId: tools.inspect('gate').id, state: 'unavailable' }],
      }),
    }),
  })
}
