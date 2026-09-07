import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EvaluationService,
  createEvidenceAuditMetricsExecutor,
  evidenceAuditFixtureDigest,
} from '@control-plane/production-readiness'
import { SqliteEvaluationRepository, SqlitePersistenceProvider } from './index.ts'

test('atomically retains an observed evaluation run through concurrency, rollback and SQLite reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-eval-receipts-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  const now = '2026-09-07T12:00:00.000Z'
  try {
    await provider.migrate()
    const repository = new SqliteEvaluationRepository(provider)
    const fixture = {
      taskId: 'audit-case',
      version: '1',
      candidate: 'candidate',
      prompt: 'Inspect the gate.',
      untrustedSummary: 'Everything passed.',
      requirements: [
        { id: 'gate', evidence: { id: 'run', candidate: 'candidate', outcome: 'unavailable' } },
      ],
    }
    const artifact = { id: 'offline-fixture', version: '1', digest: `sha256:${'1'.repeat(64)}` }
    const run = await new EvaluationService({ repository, now: () => now }).run({
      evalRunId: 'sqlite-observed-eval',
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
        executorReference: 'scripted-control',
        seed: 1104,
        executor: async ({ tools }) => {
          const evidence = tools.inspect('gate')
          return {
            status: 'partial',
            requirements: [{ id: 'gate', evidenceId: evidence.id, state: 'unavailable' }],
          }
        },
      }),
    })
    expect(run.status).toBe('passed')
    expect(run.results[0].observation.report.status).toBe('partial')
    await Promise.all(Array.from({ length: 8 }, () => repository.saveRun(run)))
    await provider.transaction(async (transaction) =>
      expect(await transaction.list('evaluation-runs')).toHaveLength(1)
    )
    const changed = { ...run, completedAt: '2026-09-07T12:00:01.000Z' }
    await expect(repository.saveRun(changed)).rejects.toThrow('EVALUATION_RUN_CONFLICT')
    const failing = new SqliteEvaluationRepository({
      transaction: (operation) =>
        provider.transaction(async (transaction) => {
          await operation(transaction)
          throw new Error('INJECTED_EVALUATION_ROLLBACK')
        }),
    })
    await expect(failing.saveRun({ ...run, evalRunId: 'rolled-back-eval' })).rejects.toThrow(
      'INJECTED_EVALUATION_ROLLBACK'
    )
    expect(await repository.getRun('rolled-back-eval')).toBeUndefined()
    await provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    let reopened = new SqliteEvaluationRepository(provider)
    expect(await reopened.getRun(run.evalRunId)).toEqual(run)
    const snapshot = await provider.backup()
    await provider.transaction(async (transaction) => {
      const stored = (await transaction.list('evaluation-runs'))[0]
      await transaction.delete(stored.namespace, stored.id, stored.revision)
    })
    expect(await reopened.getRun(run.evalRunId)).toBeUndefined()
    await provider.restore(snapshot)
    expect(await reopened.getRun(run.evalRunId)).toEqual(run)
    await provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    reopened = new SqliteEvaluationRepository(provider)
    expect(await reopened.getRun(run.evalRunId)).toEqual(run)
    const detached = await reopened.getRun(run.evalRunId)
    detached.results[0].observation.report.status = 'complete'
    expect(await reopened.getRun(run.evalRunId)).toEqual(run)
    const original = await provider.transaction(
      async (transaction) => (await transaction.list('evaluation-runs'))[0]
    )
    for (const mutate of [
      (value) => {
        value.evalRunId = 'wrong-row'
      },
      (value) => {
        value.results[0].observation.observations[0].target = 'forged'
      },
    ]) {
      const corrupted = structuredClone(run)
      mutate(corrupted)
      await provider.transaction(async (transaction) => {
        const current = await transaction.get(original.namespace, original.id)
        await transaction.put({
          namespace: original.namespace,
          id: original.id,
          value: corrupted,
          expectedRevision: current.revision,
        })
      })
      await expect(reopened.getRun(run.evalRunId)).rejects.toThrow()
      await provider.transaction(async (transaction) => {
        const current = await transaction.get(original.namespace, original.id)
        await transaction.put({
          namespace: original.namespace,
          id: original.id,
          value: run,
          expectedRevision: current.revision,
        })
      })
    }
    expect(await reopened.getRun(run.evalRunId)).toEqual(run)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
