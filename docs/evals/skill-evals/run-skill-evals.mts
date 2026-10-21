import { execFileSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertOutputsCanaryFree,
  buildEvidence,
  loadSuite,
  persistOutputs,
  runScenario,
  SkillEvalCanaryGateError,
  SkillEvalPersistenceError,
  snapshotBaselineLibrary,
  snapshotCandidateLibrary,
  suiteCanaries,
  type PersistedOutput,
  type ScenarioObservation,
  type Suite,
} from './skill-eval-harness.mts'

/**
 * Cold-task runner for the repository audit-skill library (#196).
 *
 * It reuses the #191 evidence-audit harness read-only and runs every scenario
 * twice: once against the pinned baseline skill library and once against the
 * candidate library in this working tree. The measured quantities are context
 * bytes, tool calls, harness duration, executor errors, failed assertions, and
 * the three harness verdict axes.
 *
 * The runner never calls a provider and never scores anything as a human
 * score. The blinded human comparison remains an external gate; see
 * `blinded-comparison-packet.md`.
 *
 * Persistence is fail-closed. Every output that could be written is serialized
 * first and scanned for canary values; only when the whole batch is clean is
 * anything written. A rejected batch creates no file and overwrites no
 * existing artifact, and the failure message names the affected outputs
 * without emitting a canary value.
 *
 * The batch itself is not atomic across outputs: it is written sequentially,
 * so a write failure on a later output can leave the earlier outputs on disk.
 * That case is reported as a partial state, with the persisted outputs named,
 * and it never claims that nothing was written.
 */

export type SkillEvalRun = {
  evidence: ReturnType<typeof buildEvidence>
  outputs: PersistedOutput[]
  observations: ScenarioObservation[]
}

export type SkillEvalRunOptions = {
  /** Repository root that owns the skill library and the suite. */
  root: string
  suite: Suite
  /** Directory that receives the sealed receipt and the scorecard. */
  outDir: string
  /** Repository evidence artifact path, or null to skip the repository artifact. */
  evidencePath: string | null
  /** Canary values to refuse to persist. Defaults to the suite's own canaries. */
  canaries?: string[]
  /**
   * Normalizes the repository artifact bytes before they are persisted. It runs
   * only after the raw batch has passed the canary gate, and the normalized
   * bytes are gated again before anything is written.
   */
  formatArtifact?: (content: string) => Promise<string>
}

/**
 * Run the suite, build every serialized output, gate the whole batch, and only
 * then persist. A canary in any output aborts before the first write.
 */
export async function runSkillEvalSuite(options: SkillEvalRunOptions): Promise<SkillEvalRun> {
  const { root, suite, outDir, evidencePath } = options
  const canaries = options.canaries ?? suiteCanaries(suite)

  const candidate = await snapshotCandidateLibrary(root)
  const baseline = snapshotBaselineLibrary(root, suite.baseline.commit)

  const observations: ScenarioObservation[] = []
  for (const scenario of suite.scenarios) {
    for (const variant of ['baseline', 'candidate'] as const) {
      const library = variant === 'baseline' ? baseline : candidate
      observations.push(await runScenario({ suite, scenario, variant, library }))
    }
  }

  const evidence = buildEvidence({ suite, baseline, candidate, observations })
  const evidenceContent = `${JSON.stringify(evidence, null, 2)}\n`
  const scorecardContent = `${JSON.stringify(
    {
      suite: suite.suite,
      version: suite.version,
      results: evidence.results,
      delta: evidence.delta,
      timing: observations.map((observation) => ({
        id: observation.id,
        variant: observation.variant,
        durationMs: observation.measurements.durationMs,
        toolCalls: observation.measurements.toolCalls,
        errors: observation.measurements.errors,
      })),
      humanGate: evidence.humanGate,
    },
    null,
    2
  )}\n`

  const outputs: PersistedOutput[] = [
    {
      path: join(outDir, 'sealed', 'evidence.v1.json'),
      content: evidenceContent,
      name: 'sealed evidence receipt',
    },
    {
      path: join(outDir, 'scorecard.json'),
      content: scorecardContent,
      name: 'skill-eval scorecard',
    },
  ]

  // Gate the raw batch first: a rejected batch must not even reach the
  // formatter, let alone the disk.
  assertOutputsCanaryFree(outputs, canaries)

  if (evidencePath) {
    const content = options.formatArtifact
      ? await options.formatArtifact(evidenceContent)
      : evidenceContent
    outputs.push({
      path: evidencePath,
      content,
      name: 'repository evidence artifact',
    })
    // The normalized bytes are the bytes that would land on disk, so they are
    // gated again.
    assertOutputsCanaryFree(outputs, canaries)
  }

  await persistOutputs(outputs, canaries)
  return { evidence, outputs, observations }
}

/**
 * Normalize the repository artifact with the repository formatter.
 *
 * The formatter runs on a staged copy outside the repository so the
 * destination is never written before the canary gate has passed. The staged
 * copy is always removed.
 */
async function formatRepositoryArtifact(root: string, content: string): Promise<string> {
  const staging = join(tmpdir(), `skill-eval-evidence-${process.pid}.json`)
  try {
    await writeFile(staging, content)
    try {
      execFileSync(
        process.execPath,
        [
          join(root, 'node_modules', '.bin', 'oxfmt'),
          '--write',
          '-c',
          join(root, '.oxfmtrc.json'),
          staging,
        ],
        { cwd: root, encoding: 'utf8' }
      )
    } catch {
      console.error(
        'skill-evals: the repository formatter is unavailable; run `bunx oxfmt --write`'
      )
      return content
    }
    return await readFile(staging, 'utf8')
  } finally {
    await rm(staging, { force: true })
  }
}

/**
 * Describe a failed run truthfully.
 *
 * The three cases carry different guarantees, so they are reported
 * differently:
 *
 * - A canary rejection is raised before the first destination write, so no
 *   output file was created and no prior artifact was overwritten.
 * - An unexpected error escapes before the batch is written, with the same
 *   guarantee. Every destination write is wrapped, so a write failure always
 *   surfaces as a {@link SkillEvalPersistenceError} instead.
 * - A persistence failure is different: the batch is written sequentially, so
 *   the outputs written before the failure are on disk. The report says
 *   exactly which ones, and it does not claim that nothing was written.
 */
export function describeSkillEvalFailure(error: unknown): string[] {
  if (error instanceof SkillEvalCanaryGateError) {
    return [error.message, 'skill-evals: no output file was created or overwritten']
  }
  if (error instanceof SkillEvalPersistenceError) {
    const persisted = error.persisted.length > 0 ? `: ${error.persisted.join(', ')}` : ''
    return [
      error.message,
      `skill-evals: ${error.persisted.length} output(s) were persisted before the failure${persisted}`,
      'skill-evals: the output state may be partial; the persisted outputs are on disk and must be inspected before use',
    ]
  }
  return [
    error instanceof Error ? error.message : String(error),
    'skill-evals: the run failed before the output batch was written; no output file was created or overwritten',
  ]
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const OUT = '/tmp/skill-evals'
  const EVIDENCE_PATH = join(root, 'docs', 'evals', 'skill-evals', 'skill-eval-evidence.v1.json')
  const writeEvidence = process.argv.includes('--write-evidence')

  const suite = await loadSuite(root)
  const canaries = suiteCanaries(suite)

  let run: SkillEvalRun
  try {
    run = await runSkillEvalSuite({
      root,
      suite,
      outDir: OUT,
      evidencePath: writeEvidence ? EVIDENCE_PATH : null,
      canaries,
      formatArtifact: (content) => formatRepositoryArtifact(root, content),
    })
  } catch (error) {
    // Fail closed, and report only what is true about the output state.
    for (const line of describeSkillEvalFailure(error)) console.error(line)
    process.exit(1)
  }

  const { evidence, observations } = run
  let failures = 0
  for (const observation of observations) {
    const status = observation.matchesExpectation ? 'MATCH' : 'MISMATCH'
    if (!observation.matchesExpectation) failures += 1
    console.log(
      `${observation.id} [${observation.variant}] ${status} ` +
        `contract=${observation.contractPresent ? 'present' : 'absent'} ` +
        `tools=${observation.measurements.toolCalls} ` +
        `failed=${observation.measurements.failedAssertions.length} ` +
        JSON.stringify(observation.observed)
    )
  }

  const baselineResult = evidence.results.baseline
  const candidateResult = evidence.results.candidate
  console.log(
    `skill-evals: baseline ${baselineResult.passed}/${baselineResult.scenarios} passed, ` +
      `candidate ${candidateResult.passed}/${candidateResult.scenarios} passed`
  )
  console.log(
    `skill-evals: routing context ${evidence.baseline.routingBytes} -> ${evidence.candidate.routingBytes} bytes ` +
      `(${evidence.delta.routingBytes >= 0 ? '+' : ''}${evidence.delta.routingBytes}), ` +
      `entrypoints ${evidence.baseline.entrypointBytes} -> ${evidence.candidate.entrypointBytes} bytes ` +
      `(${evidence.delta.entrypointBytes >= 0 ? '+' : ''}${evidence.delta.entrypointBytes})`
  )
  console.log(
    'skill-evals: human calibration remains an external gate — ' +
      'no human score or reviewer correction count is produced by this run'
  )
  if (writeEvidence) console.log('skill-evals: evidence artifact written')

  if (failures > 0) {
    console.error(`skill-evals: ${failures} deviation(s) from the documented error bounds`)
    process.exit(1)
  }
  console.log('skill-evals: all scenarios within the documented error bounds')
}
