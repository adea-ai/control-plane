import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildEvidence,
  loadSuite,
  runScenario,
  snapshotBaselineLibrary,
  snapshotCandidateLibrary,
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
 */
const root = fileURLToPath(new URL('../../..', import.meta.url))
const OUT = '/tmp/skill-evals'
const EVIDENCE_PATH = join(root, 'docs', 'evals', 'skill-evals', 'skill-eval-evidence.v1.json')
const writeEvidence = process.argv.includes('--write-evidence')

const suite = await loadSuite(root)
const candidate = await snapshotCandidateLibrary(root)
const baseline = snapshotBaselineLibrary(root, suite.baseline.commit)

const observations = []
for (const scenario of suite.scenarios) {
  for (const variant of ['baseline', 'candidate'] as const) {
    const library = variant === 'baseline' ? baseline : candidate
    observations.push(await runScenario({ suite, scenario, variant, library }))
  }
}

const evidence = buildEvidence({ suite, baseline, candidate, observations })

await mkdir(`${OUT}/sealed`, { recursive: true })
await writeFile(`${OUT}/sealed/evidence.v1.json`, `${JSON.stringify(evidence, null, 2)}\n`)
await writeFile(
  `${OUT}/scorecard.json`,
  `${JSON.stringify(
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
)

// A canary that appears in an untrusted summary must never reach a persisted
// artifact. The harness has no free-text output channel, so the leak property
// is verified at the artifact boundary.
const canaries = suite.scenarios
  .map((scenario) => scenario.canary)
  .filter((value): value is string => typeof value === 'string')
const serialized = JSON.stringify(evidence)
const leaked = canaries.filter((canary) => serialized.includes(canary))

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
if (leaked.length > 0) {
  failures += 1
  console.error(`skill-evals: ${leaked.length} secret canary value(s) reached a persisted artifact`)
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

if (writeEvidence) {
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`)
  // Normalize the artifact with the repository formatter so the committed file
  // satisfies `bun run format:check` and stays byte-stable across runs.
  try {
    const formatter = Bun.spawnSync({
      cmd: ['node_modules/.bin/oxfmt', '--write', EVIDENCE_PATH],
      cwd: root,
    })
    if (formatter.exitCode !== 0) {
      console.error(
        'skill-evals: the repository formatter could not normalize the evidence artifact'
      )
    }
  } catch {
    console.error('skill-evals: the repository formatter is unavailable; run `bunx oxfmt --write`')
  }
  console.log('skill-evals: evidence artifact written')
}

if (failures > 0) {
  console.error(`skill-evals: ${failures} deviation(s) from the documented error bounds`)
  process.exit(1)
}
console.log('skill-evals: all scenarios within the documented error bounds')
