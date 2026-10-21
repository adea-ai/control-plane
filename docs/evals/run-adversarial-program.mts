/**
 * Adversarial evaluation program runner (#191).
 *
 * Runs the pinned public corpus twice — once with the deterministic in-process
 * control executor (the pinned baseline) and once with an executor that runs
 * every task in a separate operating-system process whose real effects the host
 * observes — then compares the two runs and records a fail-closed promotion
 * decision.
 *
 * The script never selects a provider, never contacts the network, and never
 * invents a cost or token value: when the harness observed no provider usage the
 * scorecard records that evidence as unavailable.
 *
 *   CP_EVAL_SOURCE_REVISION=<git sha> bun docs/evals/run-adversarial-program.mts
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildAdversarialRunIdentity,
  compareAdversarialRuns,
  evaluateAdversarialPromotionDecision,
  getHiddenTaskSet,
  getOfflineAdversarialCorpus,
  runHiddenAdversarialTaskSet,
  runIsolatedAdversarialTask,
  runOfflineAdversarialCorpus,
} from '../../packages/production-readiness/src/adversarial-eval-corpus.ts'
import { EvaluationConfigurationSchema } from '../../packages/production-readiness/src/evaluations.ts'
import { ReleaseGateRegistry } from '../../packages/production-readiness/src/release-gates.ts'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const seed = Number(process.env.CP_EVAL_SEED ?? '191')
const sourceRevision = process.env.CP_EVAL_SOURCE_REVISION ?? 'unknown'
const outputPath =
  process.env.CP_EVAL_OUTPUT ??
  join(repositoryRoot, 'docs/evidence/cp191-adversarial-baseline-scorecard.json')
const actorReference = process.env.CP_EVAL_ACTOR ?? 'scripted-control-v1'
const isolatedActorReference = process.env.CP_EVAL_ISOLATED_ACTOR ?? 'isolated-process-control-v1'

const sourceContents = await Promise.all(
  [
    'packages/production-readiness/src/adversarial-eval-corpus.ts',
    'packages/production-readiness/src/evidence-audit-eval.ts',
  ].map(async (relativePath) => await readFile(join(repositoryRoot, relativePath), 'utf8'))
)
const sourceDigest = `sha256:${createHash('sha256').update(sourceContents.join('\n')).digest('hex')}`

const configuration = EvaluationConfigurationSchema.parse({
  executionPlanDigest: sourceDigest,
  profile: { id: 'profile-offline-control', version: '1.0.0', digest: sourceDigest },
  skills: [],
  graph: { id: 'graph-offline-control', version: '1.0.0', digest: sourceDigest },
  runtime: { id: 'runtime-scripted', version: '1.0.0', digest: sourceDigest },
  model: { id: 'model-scripted', version: '1.0.0', digest: sourceDigest },
  tools: [{ id: 'tools-offline-control', version: '1.0.0', digest: sourceDigest }],
  policy: { id: 'policy-offline-control', version: '1.0.0', digest: sourceDigest },
})

const corpus = getOfflineAdversarialCorpus()
const fixturesByTaskId = new Map(corpus.cases.map((fixture) => [fixture.taskId, fixture]))

const classify = (task, evidence) => {
  if (evidence.candidate !== task.candidate) return 'stale'
  if (evidence.coverage === 'not_run' || evidence.outcome === 'unavailable') return 'unavailable'
  if (evidence.authority !== 'authoritative' || evidence.coverage === 'sampled') return 'weak'
  return evidence.outcome === 'pass' ? 'verified' : 'failed'
}

const inProcessExecutor = async ({ task, tools }) => {
  const requirements = task.requirementIds.map((id) => {
    const evidence = tools.inspect(id)
    return { id, evidenceId: evidence.id, state: classify(task, evidence) }
  })
  return {
    status: requirements.every(({ state }) => state === 'verified') ? 'complete' : 'partial',
    requirements,
  }
}

const isolatedOutcomes = new Map()
const isolatedExecutor = async ({ task }) => {
  const fixture = fixturesByTaskId.get(task.taskId)
  if (fixture === undefined) throw new Error(`UNKNOWN_CORPUS_CASE:${task.taskId}`)
  const outcome = await runIsolatedAdversarialTask({
    fixture,
    scenario: { inspect: task.requirementIds },
  })
  isolatedOutcomes.set(task.taskId, outcome)
  return outcome.report
}
const isolatedObserver = async ({ taskId }) => isolatedOutcomes.get(taskId)?.effects ?? []

const sourceIdentity = {
  id: 'control-plane',
  revision: sourceRevision,
  digest: sourceDigest,
}

const baseline = await runOfflineAdversarialCorpus({
  evalRunId: 'cp191-baseline-pinned',
  configuration,
  executor: inProcessExecutor,
  executorReference: actorReference,
  seed,
  now: () => '2026-10-21T00:00:00.000Z',
  actor: { reference: actorReference },
  source: sourceIdentity,
  harnessVersion: '4.0.0',
})

const candidate = await runOfflineAdversarialCorpus({
  evalRunId: 'cp191-candidate-isolated',
  configuration,
  executor: isolatedExecutor,
  executorReference: isolatedActorReference,
  seed,
  now: () => '2026-10-21T00:00:00.000Z',
  observationMode: 'independent-isolated-observer',
  observer: isolatedObserver,
  actor: { reference: isolatedActorReference },
  source: sourceIdentity,
  harnessVersion: '4.0.0',
})

const hiddenFixtureByTaskId = new Map(
  getHiddenTaskSet().tasks.map((definition) => [definition.taskId, definition.fixture])
)
const hiddenOutcomes = new Map()
const hiddenExecutor = async ({ task }) => {
  const fixture = hiddenFixtureByTaskId.get(task.taskId)
  if (fixture === undefined) throw new Error(`UNKNOWN_HIDDEN_CASE:${task.taskId}`)
  const outcome = await runIsolatedAdversarialTask({
    fixture,
    scenario: { inspect: task.requirementIds },
  })
  hiddenOutcomes.set(task.taskId, outcome)
  return outcome.report
}
const hiddenObserver = async ({ taskId }) => hiddenOutcomes.get(taskId)?.effects ?? []

const hiddenSetRun = await runHiddenAdversarialTaskSet({
  evalRunId: 'cp191-hidden-rotating',
  configuration,
  executor: hiddenExecutor,
  executorReference: isolatedActorReference,
  seed,
  now: () => '2026-10-21T00:00:00.000Z',
  observationMode: 'independent-isolated-observer',
  observer: hiddenObserver,
})

const baselineIdentity = buildAdversarialRunIdentity({
  seed,
  actor: { reference: actorReference },
  source: sourceIdentity,
  harnessVersion: '4.0.0',
})
const candidateIdentity = buildAdversarialRunIdentity({
  seed,
  actor: { reference: isolatedActorReference },
  source: sourceIdentity,
  harnessVersion: '4.0.0',
})

const comparison = compareAdversarialRuns({
  candidate,
  baseline,
  candidateIdentity,
  baselineIdentity,
})

const registry = new ReleaseGateRegistry({ now: () => '2026-10-21T00:00:00.000Z' })
const decision = evaluateAdversarialPromotionDecision({
  registry,
  releaseGateId: 'cp191-adversarial-program',
  candidate,
  baseline,
  maximumRegressions: {},
  candidateIdentity,
  baselineIdentity,
  requireIndependentObservation: true,
  requireHiddenSet: true,
  hiddenSetRun,
  requireHumanCalibration: true,
  now: () => '2026-10-21T00:00:00.000Z',
})

const scorecard = {
  schemaVersion: 1,
  kind: 'cp191-adversarial-baseline-scorecard',
  issue: '#191',
  generatedBy: 'docs/evals/run-adversarial-program.mts',
  corpus: { id: corpus.id, version: corpus.version, digest: corpus.digest },
  suite: {
    id: baseline.suite.evalSuiteId,
    version: baseline.suite.version,
    digest: baseline.suite.digest,
    mode: baseline.suite.mode,
  },
  source: sourceIdentity,
  seed,
  baselineIdentity,
  candidateIdentity,
  baseline: {
    evalRunId: baseline.evalRunId,
    status: baseline.status,
    cases: baseline.results.length,
    observedToolCalls: baseline.results.reduce(
      (total, result) => total + (result.observation?.observations.length ?? 0),
      0
    ),
    observedLatencyMs: baseline.results.reduce(
      (total, result) => total + (result.observation?.durationMs ?? 0),
      0
    ),
    observedProviderUsage: null,
    observedProviderUsageReason:
      'The offline harness performs no provider call, so no cost or token usage was observed. It is unavailable, not zero.',
  },
  candidate: {
    evalRunId: candidate.evalRunId,
    status: candidate.status,
    cases: candidate.results.length,
    observedToolCalls: candidate.results.reduce(
      (total, result) => total + (result.observation?.observations.length ?? 0),
      0
    ),
    observedLatencyMs: candidate.results.reduce(
      (total, result) => total + (result.observation?.durationMs ?? 0),
      0
    ),
    observedProviderUsage: null,
    observedProviderUsageReason:
      'The offline harness performs no provider call, so no cost or token usage was observed. It is unavailable, not zero.',
  },
  hiddenSet: {
    evalRunId: hiddenSetRun.evalRunId,
    status: hiddenSetRun.status,
    suiteId: hiddenSetRun.suite.evalSuiteId,
    datasetId: hiddenSetRun.suite.dataset.id,
    datasetDigest: hiddenSetRun.suite.dataset.digest,
    cases: hiddenSetRun.results.length,
  },
  comparison: {
    comparable: comparison.comparable,
    reasons: comparison.reasons,
    latency: comparison.latency,
    toolCalls: comparison.toolCalls,
    cost: comparison.cost,
    tokens: comparison.tokens,
    metrics: comparison.metrics,
  },
  promotionDecision: decision,
  externalGates: [
    {
      id: 'blinded-human-calibration',
      status: 'blocked',
      reason:
        'No blinded human scoring exists. The agreement, kappa, and error bounds stay withheld until real scoring is recorded.',
      nextAction:
        'Run docs/evals/build-calibration-packet.mts, obtain blinded human scores, then run docs/evals/score-calibration.mts and attach the report.',
    },
    {
      id: 'live-provider-baseline',
      status: 'blocked',
      reason:
        'No live provider baseline, cost, or token measurement is authorised or observed in this environment.',
      nextAction:
        'Obtain separate authority for a controlled live-provider run, then record authoritative usage, latency, and cost for the same pinned suite and seed.',
    },
    {
      id: 'independent-hidden-task-authorship',
      status: 'blocked',
      reason:
        'The held-out task set is authored inside this repository; independent task authorship and rotation governance remain open.',
      nextAction:
        'Hand the hidden task set to an independent author and re-run the hidden gate with the independently authored set.',
    },
  ],
}

await writeFile(outputPath, JSON.stringify(scorecard, null, 2) + '\n')
console.log(
  JSON.stringify(
    {
      baseline: scorecard.baseline,
      candidate: scorecard.candidate,
      comparison: scorecard.comparison,
      promotion: scorecard.promotionDecision,
      written: outputPath,
    },
    null,
    2
  )
)
