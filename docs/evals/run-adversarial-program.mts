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
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildAdversarialRunIdentity,
  compareAdversarialRuns,
  evaluateAdversarialPromotionDecision,
  getHiddenTaskSet,
  getOfflineAdversarialCorpus,
  getOfflineSecurityProbes,
  runHiddenAdversarialTaskSet,
  runIsolatedAdversarialTask,
  runOfflineAdversarialCorpus,
  runOfflineSecurityProbes,
  runRotatingAdversarialTaskSet,
} from '../../packages/production-readiness/src/adversarial-eval-corpus.ts'
import { EvaluationConfigurationSchema } from '../../packages/production-readiness/src/evaluations.ts'
import { ReleaseGateRegistry } from '../../packages/production-readiness/src/release-gates.ts'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
/** Formats a generated JSON artifact with the repository formatter when it is available. */
function formatJsonArtifact(path: string): void {
  const formatter = join(repositoryRoot, 'node_modules/.bin/oxfmt')
  if (!existsSync(formatter)) return
  spawnSync(formatter, [path], { stdio: 'ignore' })
}

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

/**
 * The revision identifier is what a reviewer uses to name the evaluated
 * commit, so it must be the commit this tree actually is. The digest already
 * binds the content; this binds the name to that content.
 *
 * The check reads the committed tree's own revision. When the environment
 * supplies one it must match, and a mismatch fails closed: a scorecard may not
 * claim to have evaluated a revision this tree is not.
 */
function resolveVerifiedSourceRevision(): string {
  const committed = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  if (committed.status !== 0) {
    throw new Error(
      'CP_EVAL_SOURCE_REVISION_UNVERIFIABLE: the evaluated revision could not be read from the tree'
    )
  }
  const treeRevision = committed.stdout.trim()
  if (sourceRevision === 'unknown') return treeRevision
  if (sourceRevision !== treeRevision) {
    throw new Error(
      `CP_EVAL_SOURCE_REVISION_MISMATCH: the supplied revision ${sourceRevision} is not the tree revision ${treeRevision}`
    )
  }
  return treeRevision
}

const verifiedSourceRevision = resolveVerifiedSourceRevision()

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
  revision: verifiedSourceRevision,
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

const securityProbes = await runOfflineSecurityProbes({
  evalRunId: 'cp191-security-probes',
  configuration,
  executor: inProcessExecutor,
  executorReference: actorReference,
  seed,
  now: () => '2026-10-21T00:00:00.000Z',
  harnessVersion: '4.0.0',
})

const rotation = await runRotatingAdversarialTaskSet({
  evalRunId: 'cp191-hidden-rotation',
  configuration,
  executor: inProcessExecutor,
  executorReference: actorReference,
  seed: Number(process.env.CP_EVAL_ROTATION_SEED ?? '4242'),
  count: 3,
  now: () => '2026-10-21T00:00:00.000Z',
  harnessVersion: '4.0.0',
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

// The evaluation itself is deterministic and runs on a fixed clock, so the
// measured evidence reproduces. The instant the evidence was PRODUCED is a
// real run timestamp, so a reviewer can tell a report written today from one
// written at any other time. The two are separate fields on purpose.
const runTimestamp = new Date().toISOString()
const registry = new ReleaseGateRegistry({ now: () => runTimestamp })
const decision = evaluateAdversarialPromotionDecision({
  registry,
  releaseGateId: 'cp191-adversarial-program',
  candidate,
  baseline,
  // A regression budget, so the gate is not a no-op. The budget covers the
  // quality metrics the two channels measure the same way. The observed
  // latency difference is NOT in the budget: the candidate runs every task in a
  // separate operating-system process, so its latency is the measured cost of
  // that channel rather than a regression in agent quality, and the report
  // discloses it as a run-local observation.
  maximumRegressions: {
    behavior_compliance: 0,
    constraint_adherence: 0,
    evidence_sufficiency: 0,
    functional_correctness: 0,
    goal_coverage: 0,
    provenance_correctness: 0,
    reporting_honesty: 0,
    scope_control: 0,
    task_outcome: 0,
    tool_use: 0,
    verification_completeness: 0,
  },
  candidateIdentity,
  baselineIdentity,
  requireIndependentObservation: true,
  requireHiddenSet: true,
  hiddenSetRun,
  requireHumanCalibration: true,
  now: () => runTimestamp,
})

const scorecard = {
  schemaVersion: 1,
  kind: 'cp191-adversarial-baseline-scorecard',
  issue: '#191',
  generatedBy: 'docs/evals/run-adversarial-program.mts',
  /**
   * When this evidence was produced. The measured evaluation runs on a fixed
   * clock so it reproduces, but the run instant is real, so a reviewer can
   * tell a report written today from one written at any other time.
   */
  generatedAt: runTimestamp,
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
      (total, result) => total + (result.metrics.tool_use ?? 0),
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
      (total, result) => total + (result.metrics.tool_use ?? 0),
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
  securityProbes: {
    evalRunId: securityProbes.evalRunId,
    status: securityProbes.status,
    suiteId: securityProbes.suite.evalSuiteId,
    datasetId: securityProbes.suite.dataset.id,
    datasetDigest: securityProbes.suite.dataset.digest,
    cases: securityProbes.results.length,
    // The recorded findings are derived from the probes themselves, so the
    // scorecard cannot claim a finding list that differs from the probes it
    // actually ran.
    sourceFindings: [
      ...new Set(getOfflineSecurityProbes().probes.flatMap((probe) => probe.sourceFindings)),
    ].toSorted(),
    source:
      'Consumed read-only from the CP #190 trust-boundary audit (m11-security-trust-boundary-matrix-2026-10-21.v1.json).',
  },
  rotatingSet: {
    evalRunId: rotation.run.evalRunId,
    status: rotation.run.status,
    rotationId: rotation.rotation.rotationId,
    seed: rotation.rotation.seed,
    suiteId: rotation.run.suite.evalSuiteId,
    datasetId: rotation.run.suite.dataset.id,
    datasetDigest: rotation.run.suite.dataset.digest,
    cases: rotation.run.results.length,
    taskIds: rotation.rotation.taskIds,
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
    observation: comparison.observation,
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
        'Run docs/evals/calibration/build-calibration-packet.mts, obtain blinded human scores, then run docs/evals/calibration/score-calibration.mts and attach the report.',
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
formatJsonArtifact(outputPath)
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
