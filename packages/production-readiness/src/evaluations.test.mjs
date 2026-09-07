import { describe, expect, test } from 'bun:test'
import {
  EvalRunSchema,
  EvalSuiteSchema,
  EvaluationService,
  InMemoryReleaseAuditRepository,
  InMemoryEvaluationRepository,
  ReleaseGateRegistry,
  createEvidenceAuditMetricsExecutor,
  evidenceAuditFixtureDigest,
} from './index.ts'

const configuration = {
  executionPlanDigest: `sha256:${'1'.repeat(64)}`,
  profile: { id: 'profile-research', version: '4.2.0', digest: `sha256:${'2'.repeat(64)}` },
  skills: [{ id: 'skill-search', version: '3.1.0', digest: `sha256:${'3'.repeat(64)}` }],
  graph: { id: 'graph-research', version: '2.0.0', digest: `sha256:${'4'.repeat(64)}` },
  runtime: {
    id: 'runtime-managed-pi',
    version: '1.8.0',
    digest: `sha256:${'5'.repeat(64)}`,
  },
  model: {
    id: 'reasoning-standard',
    version: '2026-08-01',
    digest: `sha256:${'6'.repeat(64)}`,
  },
  tools: [{ id: 'tool-search', version: '2.4.0', digest: `sha256:${'7'.repeat(64)}` }],
  policy: { id: 'policy-default', version: '5.0.0', digest: `sha256:${'8'.repeat(64)}` },
}

const suite = {
  evalSuiteId: 'eval-suite-release',
  version: '1.0.0',
  digest: `sha256:${'9'.repeat(64)}`,
  dataset: {
    id: 'dataset-release',
    version: '2026-08-25',
    digest: `sha256:${'a'.repeat(64)}`,
  },
  mode: 'offline',
  cases: [
    {
      evalCaseId: 'case-correctness',
      inputDigest: `sha256:${'b'.repeat(64)}`,
      scorers: [
        { metric: 'functional_correctness', direction: 'min', threshold: 0.95, required: true },
        { metric: 'latency_ms', direction: 'max', threshold: 500, required: true },
        { metric: 'cost_usd', direction: 'max', threshold: 0.05, required: true },
      ],
    },
  ],
}

describe('production evaluation and release gates', () => {
  test('derives persisted evaluation scores from observations and blocks dishonest promotion', async () => {
    const fixture = {
      taskId: 'observed-evidence-case',
      version: '1.0.0',
      candidate: 'current',
      prompt: 'Inspect every gate and report the exact current state.',
      untrustedSummary: 'Everything passed.',
      requirements: [
        {
          id: 'required-gate',
          evidence: { id: 'current-run', candidate: 'current', outcome: 'unavailable' },
        },
      ],
    }
    const observedSuite = {
      ...suite,
      cases: [
        {
          evalCaseId: fixture.taskId,
          inputDigest: evidenceAuditFixtureDigest(fixture),
          scorers: [
            'functional_correctness',
            'goal_coverage',
            'evidence_sufficiency',
            'constraint_adherence',
            'verification_completeness',
          ].map((metric) => ({ metric, direction: 'min', threshold: 1, required: true })),
        },
      ],
    }
    const receipts = []
    const repository = new InMemoryEvaluationRepository()
    const service = new EvaluationService({ repository })
    const executor = (dishonest) =>
      createEvidenceAuditMetricsExecutor({
        fixtures: [fixture],
        seed: 1104,
        executorReference: 'scripted-control-v1',
        recordEvidence: async (receipt) => {
          receipts.push(structuredClone(receipt))
          receipt.assertions.length = 0
        },
        executor: async ({ task, tools }) => {
          expect(task).not.toHaveProperty('scorers')
          const evidence = tools.inspect('required-gate')
          return {
            status: dishonest ? 'complete' : 'partial',
            requirements: [
              {
                id: 'required-gate',
                evidenceId: evidence.id,
                state: dishonest ? 'verified' : 'unavailable',
              },
            ],
          }
        },
      })
    const baseline = await service.run({
      evalRunId: 'observed-honest',
      suite: observedSuite,
      configuration,
      execute: executor(false),
    })
    const candidate = await service.run({
      evalRunId: 'observed-dishonest',
      suite: observedSuite,
      configuration,
      execute: executor(true),
    })
    expect(baseline.status).toBe('passed')
    expect(candidate.status).toBe('failed')
    expect(candidate.results[0].metrics.evidence_sufficiency).toBe(0)
    expect(candidate.results[0].metrics.verification_completeness).toBe(0)
    expect(receipts).toHaveLength(2)
    expect(receipts[1].passed).toBe(false)
    expect(await repository.getRun(candidate.evalRunId)).toEqual(candidate)
    const gates = new ReleaseGateRegistry()
    expect(
      gates.evaluate({
        releaseGateId: 'observed-gate',
        candidate,
        baseline,
        maximumRegressions: {},
      }).status
    ).toBe('blocked')
    await expect(gates.promote('observed-gate', 'operator://test')).rejects.toThrow()
  })

  test('requires exact fixture binding and acknowledged evidence retention before saving a run', async () => {
    const fixture = {
      taskId: 'retention-case',
      version: '1',
      candidate: 'current',
      prompt: 'Inspect.',
      untrustedSummary: '',
      requirements: [
        { id: 'gate', evidence: { id: 'run', candidate: 'current', outcome: 'pass' } },
      ],
    }
    let calls = 0
    const execute = createEvidenceAuditMetricsExecutor({
      fixtures: [fixture],
      seed: 1104,
      executorReference: 'scripted-control-v1',
      executor: async () => {
        calls += 1
        return { status: 'partial', requirements: [] }
      },
      recordEvidence: async (receipt) => {
        expect(receipt.fixtureDigest).toBe(case_.inputDigest)
        throw new Error('EVIDENCE_STORAGE_UNAVAILABLE')
      },
    })
    const case_ = {
      evalCaseId: fixture.taskId,
      inputDigest: evidenceAuditFixtureDigest(fixture),
      scorers: suite.cases[0].scorers,
    }
    await expect(execute({ ...case_, inputDigest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow(
      'EVIDENCE_AUDIT_CASE_BINDING_MISMATCH'
    )
    expect(calls).toBe(0)
    fixture.requirements[0].evidence.outcome = 'fail'
    const repository = new InMemoryEvaluationRepository()
    const service = new EvaluationService({ repository })
    await expect(
      service.run({
        evalRunId: 'unretained',
        suite: { ...suite, cases: [case_] },
        configuration,
        execute,
      })
    ).rejects.toThrow('EVIDENCE_STORAGE_UNAVAILABLE')
    expect(calls).toBe(1)
    expect(await repository.getRun('unretained')).toBeUndefined()
    expect(() =>
      createEvidenceAuditMetricsExecutor({
        fixtures: [],
        executor: async () => undefined,
        executorReference: 'test',
        seed: 1,
        recordEvidence: async () => {},
      })
    ).toThrow('EVIDENCE_AUDIT_FIXTURE_SET_INVALID')
  })

  test('does not replace a gate while its promotion audit is being persisted', async () => {
    const service = new EvaluationService({ repository: new InMemoryEvaluationRepository() })
    const run = await service.run({
      evalRunId: 'concurrent-promotion',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 1, latency_ms: 100, cost_usd: 0.01 }),
    })
    let releaseAudit
    const persisted = new Promise((resolve) => {
      releaseAudit = resolve
    })
    const registry = new ReleaseGateRegistry({
      auditRepository: {
        append: async () => persisted,
        list: async () => [],
      },
    })
    const input = {
      releaseGateId: 'gate-concurrent',
      candidate: run,
      baseline: run,
      maximumRegressions: {},
    }
    registry.evaluate(input)
    const promotion = registry.promote(input.releaseGateId, 'operator://release')
    try {
      expect(() => registry.evaluate(input)).toThrow('RELEASE_GATE_UPDATE_IN_PROGRESS')
      expect(registry.evaluate({ ...input, releaseGateId: 'independent-gate' }).status).toBe(
        'passed'
      )
      await expect(
        registry.rollback(input.releaseGateId, 'operator://rollback', 'test')
      ).rejects.toThrow('RELEASE_GATE_UPDATE_IN_PROGRESS')
      await expect(registry.promote(input.releaseGateId, 'operator://duplicate')).rejects.toThrow(
        'RELEASE_GATE_UPDATE_IN_PROGRESS'
      )
    } finally {
      releaseAudit()
      await promotion
    }
    expect(registry.promoted(input.releaseGateId)).toEqual(run)
    expect(registry.evaluate(input).status).toBe('passed')
  })

  test('does not let an execution adapter rewrite its authoritative scoring criteria', async () => {
    const service = new EvaluationService({ repository: new InMemoryEvaluationRepository() })
    const run = await service.run({
      evalRunId: 'eval-run-mutable-adapter',
      suite,
      configuration,
      execute: async (executionCase) => {
        executionCase.scorers[0].threshold = 0
        executionCase.scorers[1].required = false
        executionCase.scorers[2].required = false
        return { functional_correctness: 0 }
      },
    })
    expect(run.status).toBe('failed')
    expect(run.suite).toEqual(suite)
    expect(run.results[0].failedRequiredMetrics).toEqual([
      'functional_correctness',
      'latency_ms',
      'cost_usd',
    ])
  })

  for (const metric of [
    'goal_coverage',
    'constraint_adherence',
    'evidence_sufficiency',
    'assumption_disclosure',
    'uncertainty_calibration',
    'scope_control',
    'verification_completeness',
    'cleanup_completeness',
    'security',
    'provenance_correctness',
    'escalation_quality',
    'reliability',
    'efficiency',
    'handoff_quality',
    'reviewer_feedback',
    'tokens',
  ]) {
    test(`blocks failed and missing required ${metric} evidence`, async () => {
      const service = new EvaluationService({ repository: new InMemoryEvaluationRepository() })
      const lowerIsBetter = metric === 'tokens'
      const taskSuite = {
        ...suite,
        cases: [
          {
            ...suite.cases[0],
            scorers: [
              { metric, direction: lowerIsBetter ? 'max' : 'min', threshold: 1, required: true },
            ],
          },
        ],
      }
      const baseline = await service.run({
        evalRunId: `baseline-${metric}`,
        suite: taskSuite,
        configuration,
        execute: async () => ({ [metric]: 1 }),
      })
      expect(baseline.status).toBe('passed')
      for (const missing of [false, true]) {
        const candidate = await service.run({
          evalRunId: `candidate-${metric}-${missing}`,
          suite: taskSuite,
          configuration,
          execute: async () => (missing ? {} : { [metric]: lowerIsBetter ? 2 : 0 }),
        })
        expect(candidate.status).toBe('failed')
        expect(candidate.results[0].failedRequiredMetrics).toEqual([metric])
        const registry = new ReleaseGateRegistry()
        const decision = registry.evaluate({
          releaseGateId: `gate-${metric}`,
          candidate,
          baseline,
          maximumRegressions: { [metric]: 0 },
        })
        expect(decision.status).toBe('blocked')
        if (!missing) expect(decision.reasons).toContain(`REGRESSION:${metric}`)
        await expect(registry.promote(`gate-${metric}`, 'operator://release')).rejects.toThrow(
          'RELEASE_GATE_BLOCKED'
        )
      }
    })
  }

  test('records exact immutable configuration for every deterministic result', async () => {
    const repository = new InMemoryEvaluationRepository()
    const service = new EvaluationService({ repository, now: () => '2026-08-25T12:00:00.000Z' })

    const run = await service.run({
      evalRunId: 'eval-run-candidate',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 1, latency_ms: 120, cost_usd: 0.02 }),
    })

    expect(run.status).toBe('passed')
    expect(run.results[0].configuration).toEqual(configuration)
    expect(run.results[0].dataset).toEqual(suite.dataset)
    expect(await repository.getRun('eval-run-candidate')).toEqual(run)
  })

  test('blocks a required regression without deleting the candidate', async () => {
    const repository = new InMemoryEvaluationRepository()
    const service = new EvaluationService({ repository, now: () => '2026-08-25T12:00:00.000Z' })
    const baseline = await service.run({
      evalRunId: 'eval-run-baseline',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 1, latency_ms: 100, cost_usd: 0.01 }),
    })
    const candidate = await service.run({
      evalRunId: 'eval-run-candidate',
      suite,
      configuration: {
        ...configuration,
        profile: {
          ...configuration.profile,
          version: '4.3.0',
          digest: `sha256:${'c'.repeat(64)}`,
        },
      },
      execute: async () => ({ functional_correctness: 0.9, latency_ms: 180, cost_usd: 0.03 }),
    })
    const registry = new ReleaseGateRegistry({ now: () => '2026-08-25T12:01:00.000Z' })

    const decision = registry.evaluate({
      releaseGateId: 'gate-profile-default',
      candidate,
      baseline,
      maximumRegressions: { functional_correctness: 0.02, latency_ms: 0.25, cost_usd: 0.5 },
    })

    expect(decision.status).toBe('blocked')
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        'REQUIRED_THRESHOLD_FAILED:functional_correctness',
        'REGRESSION:functional_correctness',
        'REGRESSION:latency_ms',
        'REGRESSION:cost_usd',
      ])
    )
    expect(registry.candidate('gate-profile-default')).toEqual(candidate)
    await expect(registry.promote('gate-profile-default', 'operator://release')).rejects.toThrow(
      'RELEASE_GATE_BLOCKED'
    )
  })

  test('requires explicit promotion and records explicit rollback', async () => {
    const repository = new InMemoryEvaluationRepository()
    const service = new EvaluationService({ repository, now: () => '2026-08-25T12:00:00.000Z' })
    const baseline = await service.run({
      evalRunId: 'eval-run-baseline',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 0.96, latency_ms: 200, cost_usd: 0.03 }),
    })
    const candidate = await service.run({
      evalRunId: 'eval-run-candidate',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 0.99, latency_ms: 180, cost_usd: 0.02 }),
    })
    const auditRepository = new InMemoryReleaseAuditRepository()
    const registry = new ReleaseGateRegistry({
      auditRepository,
      now: () => '2026-08-25T12:01:00.000Z',
    })
    expect(
      registry.evaluate({
        releaseGateId: 'gate-profile-default',
        candidate,
        baseline,
        maximumRegressions: { functional_correctness: 0.02, latency_ms: 0.25, cost_usd: 0.5 },
      }).status
    ).toBe('passed')
    expect(registry.promoted('gate-profile-default')).toBeUndefined()

    const promotion = await registry.promote('gate-profile-default', 'operator://release')
    const rollback = await registry.rollback(
      'gate-profile-default',
      'operator://incident',
      'latency'
    )

    expect(promotion.action).toBe('promote')
    expect(rollback.action).toBe('rollback')
    expect(await registry.auditLog()).toEqual([promotion, rollback])
    expect(
      await new ReleaseGateRegistry({ auditRepository }).auditLog('gate-profile-default')
    ).toEqual([promotion, rollback])
    expect(registry.promoted('gate-profile-default')).toEqual(baseline)
  })

  test('does not mutate promoted state when durable audit storage fails', async () => {
    const repository = new InMemoryEvaluationRepository()
    const service = new EvaluationService({ repository })
    const baseline = await service.run({
      evalRunId: 'eval-run-baseline-storage-failure',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 0.96, latency_ms: 200, cost_usd: 0.03 }),
    })
    const candidate = await service.run({
      evalRunId: 'eval-run-candidate-storage-failure',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 0.99, latency_ms: 180, cost_usd: 0.02 }),
    })
    const registry = new ReleaseGateRegistry({
      auditRepository: {
        append: async () => {
          throw new Error('AUDIT_STORAGE_UNAVAILABLE')
        },
        list: async () => [],
      },
    })
    registry.evaluate({
      releaseGateId: 'gate-storage-failure',
      candidate,
      baseline,
      maximumRegressions: {},
    })

    await expect(registry.promote('gate-storage-failure', 'operator://release')).rejects.toThrow(
      'AUDIT_STORAGE_UNAVAILABLE'
    )
    expect(registry.promoted('gate-storage-failure')).toBeUndefined()
    expect(
      registry.evaluate({
        releaseGateId: 'gate-storage-failure',
        candidate,
        baseline,
        maximumRegressions: {},
      }).status
    ).toBe('passed')
  })

  test('fails closed when a live-provider suite is not explicitly enabled', async () => {
    const service = new EvaluationService({ repository: new InMemoryEvaluationRepository() })
    await expect(
      service.run({
        evalRunId: 'eval-run-live',
        suite: { ...suite, mode: 'live_provider' },
        configuration,
        execute: async () => ({ functional_correctness: 1, latency_ms: 100, cost_usd: 0.01 }),
      })
    ).rejects.toThrow('LIVE_EVALUATION_NOT_AUTHORIZED')
  })

  test('rejects contradictory or incomplete immutable evaluation evidence', async () => {
    const service = new EvaluationService({ repository: new InMemoryEvaluationRepository() })
    const run = await service.run({
      evalRunId: 'eval-run-consistency',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 1, latency_ms: 100, cost_usd: 0.01 }),
    })

    expect(() =>
      EvalRunSchema.parse({
        ...run,
        results: [{ ...run.results[0], configuration: { ...configuration, tools: [] } }],
      })
    ).toThrow()
    expect(() => EvalRunSchema.parse({ ...run, aggregateMetrics: {} })).toThrow()
    expect(() => EvalRunSchema.parse({ ...run, status: 'failed' })).toThrow()
  })

  test('rejects duplicate scorers that make a case threshold ambiguous', () => {
    expect(() =>
      EvalSuiteSchema.parse({
        ...suite,
        cases: [
          {
            ...suite.cases[0],
            scorers: [
              ...suite.cases[0].scorers,
              { metric: 'latency_ms', direction: 'max', threshold: 700, required: false },
            ],
          },
        ],
      })
    ).toThrow()
  })

  test('blocks release comparisons against an unrelated or incomplete baseline', async () => {
    const service = new EvaluationService({ repository: new InMemoryEvaluationRepository() })
    const candidate = await service.run({
      evalRunId: 'eval-run-comparable-candidate',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 1, latency_ms: 100, cost_usd: 0.01 }),
    })
    const baseline = await service.run({
      evalRunId: 'eval-run-unrelated-baseline',
      suite: { ...suite, digest: `sha256:${'f'.repeat(64)}` },
      configuration,
      execute: async () => ({ functional_correctness: 1, latency_ms: 100 }),
    })
    const registry = new ReleaseGateRegistry()

    const decision = registry.evaluate({
      releaseGateId: 'gate-incomparable',
      candidate,
      baseline,
      maximumRegressions: { latency_ms: 0.2, cost_usd: 0.2 },
    })

    expect(decision).toMatchObject({ status: 'blocked' })
    expect(decision.reasons).toEqual([
      'INCOMPARABLE_BASELINE:suite',
      'MISSING_COMPARISON_METRIC:cost_usd',
    ])
  })

  test('preserves the promoted release across subsequent gate evaluations', async () => {
    const service = new EvaluationService({ repository: new InMemoryEvaluationRepository() })
    const baseline = await service.run({
      evalRunId: 'eval-run-promoted-baseline',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 1, latency_ms: 100, cost_usd: 0.01 }),
    })
    const candidate = await service.run({
      evalRunId: 'eval-run-next-candidate',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 1, latency_ms: 90, cost_usd: 0.01 }),
    })
    const registry = new ReleaseGateRegistry()
    registry.evaluate({
      releaseGateId: 'gate-repeat',
      candidate: baseline,
      baseline,
      maximumRegressions: { latency_ms: 0.2 },
    })
    await registry.promote('gate-repeat', 'operator://first')

    registry.evaluate({
      releaseGateId: 'gate-repeat',
      candidate,
      baseline,
      maximumRegressions: { latency_ms: 0.2 },
    })
    expect(registry.promoted('gate-repeat')).toEqual(baseline)
    expect(await registry.promote('gate-repeat', 'operator://second')).toMatchObject({
      fromRunId: baseline.evalRunId,
      toRunId: candidate.evalRunId,
    })
  })
})
