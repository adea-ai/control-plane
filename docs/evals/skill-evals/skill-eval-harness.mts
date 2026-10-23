import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runEvidenceAuditEval } from '../../../packages/production-readiness/src/evidence-audit-eval.ts'

/**
 * Cold task harness for the repository audit-skill library (#196).
 *
 * The evaluation reuses the #191 evidence-audit harness read-only. Nothing in
 * this module writes to the shared evaluator, and the executor is a *modeled*
 * cold agent: it loads the skill under test, decides whether that skill's
 * contract covers the scenario, and then reports only what it observed through
 * the instrumented read-only tools. It is not a model and not a human, so the
 * numbers it produces are contract-conformance observations, never human
 * scores. The blinded human comparison stays an external gate.
 */

export type Variant = 'baseline' | 'candidate'

export type Scenario = {
  id: string
  kind: 'golden' | 'negative' | 'adversarial'
  skill: string
  pressure: string
  mode: 'contract' | 'greenwash'
  requiredContract: string[]
  blindBehavior: 'claim-verified' | 'no-inspect'
  summaryGateIds: string[]
  canary?: string
  fixture: Record<string, unknown>
  expected: Record<Variant, Record<string, unknown>>
}

export type Suite = {
  schemaVersion: number
  suite: string
  version: string
  description: string
  baseline: { commit: string; description: string }
  harness: {
    module: string
    api: string
    fixtureSchema: string
    seed: number
    timeoutMs: number
    executorReference: string
  }
  scenarios: Scenario[]
}

export type SkillSnapshot = {
  name: string
  version: string | null
  owner: string | null
  text: string
  entrypointBytes: number
  bundledBytes: number
  bundledFileCount: number
  digest: string
}

export type LibrarySnapshot = {
  variant: Variant
  commit: string | null
  skillCount: number
  routingBytes: number
  entrypointBytes: number
  bundledBytes: number
  skills: SkillSnapshot[]
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

type BunYamlRuntime = {
  YAML: {
    parse: (source: string) => unknown
  }
}

function sha256(content: string) {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

function frontmatterFields(text: string): Record<string, unknown> | null {
  const match = FRONTMATTER.exec(text)
  const body = match?.[1]
  if (body === undefined) return null
  const bun = (globalThis as typeof globalThis & { Bun: BunYamlRuntime }).Bun
  const parsed = bun.YAML.parse(body)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

function frontmatterField(text: string, name: string): string | null {
  const fields = frontmatterFields(text)
  const metadata = fields?.metadata
  const metadataFields =
    typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : null
  const value = fields?.[name] ?? metadataFields?.[name]
  return typeof value === 'string' ? value.trim() : null
}

/** The routing surface an agent reads to select one skill. */
export function routingBytes(text: string): number {
  const description = frontmatterField(text, 'description') ?? ''
  return Buffer.byteLength(description.replace(/\s+/gu, ' ').trim(), 'utf8')
}

export function skillVersion(text: string): string | null {
  return frontmatterField(text, 'version')
}

export function skillOwner(text: string): string | null {
  return frontmatterField(text, 'owner')
}

function runCommand(
  command: string,
  args: string[],
  cwd: string
): { status: number; stdout: string; stderr: string } {
  try {
    return { status: 0, stdout: execFileSync(command, args, { cwd, encoding: 'utf8' }), stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
  }
}

function git(root: string, args: string[]): string {
  const result = runCommand('git', args, root)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${root}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

/** Snapshot the candidate library from the working tree. */
export async function snapshotCandidateLibrary(root: string): Promise<LibrarySnapshot> {
  const skillsRoot = join(root, '.agents', 'skills')
  const entries = await readdir(skillsRoot, { withFileTypes: true })
  const skills: SkillSnapshot[] = []
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    const directory = join(skillsRoot, entry.name)
    const text = await readFile(join(directory, 'SKILL.md'), 'utf8')
    let bundledBytes = 0
    let bundledFileCount = 0
    const walk = async (current: string): Promise<void> => {
      for (const child of await readdir(current, { withFileTypes: true })) {
        const full = join(current, child.name)
        if (child.isDirectory()) {
          await walk(full)
          continue
        }
        if (!child.isFile()) continue
        bundledBytes += (await readFile(full)).byteLength
        bundledFileCount += 1
      }
    }
    await walk(directory)
    skills.push({
      name: entry.name,
      version: skillVersion(text),
      owner: skillOwner(text),
      text,
      entrypointBytes: Buffer.byteLength(text, 'utf8'),
      bundledBytes,
      bundledFileCount,
      digest: sha256(text),
    })
  }
  return {
    variant: 'candidate',
    commit: null,
    skillCount: skills.length,
    routingBytes: skills.reduce((total, skill) => total + routingBytes(skill.text), 0),
    entrypointBytes: skills.reduce((total, skill) => total + skill.entrypointBytes, 0),
    bundledBytes: skills.reduce((total, skill) => total + skill.bundledBytes, 0),
    skills,
  }
}

/** Snapshot the pinned baseline library from a git tree. */
export function snapshotBaselineLibrary(root: string, commit: string): LibrarySnapshot {
  const listing = git(root, ['ls-tree', '-r', '--name-only', commit, '--', '.agents/skills'])
  const paths = listing.split('\n').filter(Boolean)
  const directories = [
    ...new Set(
      paths
        .filter((path) => path.split('/').length > 3)
        .map((path) => path.split('/')[2])
        .filter((name): name is string => name !== undefined)
    ),
  ].toSorted()
  const skills: SkillSnapshot[] = directories.map((name) => {
    const text = git(root, ['show', `${commit}:.agents/skills/${name}/SKILL.md`])
    const bundled = paths.filter((path) => path.startsWith(`.agents/skills/${name}/`))
    let bundledBytes = 0
    for (const path of bundled) {
      bundledBytes += Buffer.byteLength(git(root, ['show', `${commit}:${path}`]), 'utf8')
    }
    return {
      name,
      version: skillVersion(text),
      owner: skillOwner(text),
      text,
      entrypointBytes: Buffer.byteLength(text, 'utf8'),
      bundledBytes,
      bundledFileCount: bundled.length,
      digest: sha256(text),
    }
  })
  return {
    variant: 'baseline',
    commit,
    skillCount: skills.length,
    routingBytes: skills.reduce((total, skill) => total + routingBytes(skill.text), 0),
    entrypointBytes: skills.reduce((total, skill) => total + skill.entrypointBytes, 0),
    bundledBytes: skills.reduce((total, skill) => total + skill.bundledBytes, 0),
    skills,
  }
}

/** Classify one observed evidence record, exactly as the reader sees it. */
function classify(evidence: any, candidate: string): string {
  if (evidence.candidate !== candidate) return 'stale'
  if (evidence.coverage === 'not_run' || evidence.outcome === 'unavailable') return 'unavailable'
  if (evidence.authority !== 'authoritative' || evidence.coverage === 'sampled') return 'weak'
  return evidence.outcome === 'pass' ? 'verified' : 'failed'
}

/**
 * Build the modeled cold executor for one scenario against one skill text.
 *
 * Repository skill text is untrusted data, never instructions. It is only
 * ever matched against fixed contract markers and parsed as frontmatter; no
 * part of it is executed, interpolated into a command, or allowed to steer the
 * report beyond deciding whether the contract this scenario needs is present.
 * A skill that contains an instruction-shaped sentence therefore cannot change
 * what the executor reports.
 *
 * The executor never sees the expected outcome. It sees the skill contract and
 * the instrumented read-only tools, and it decides its report from what it
 * observed:
 *
 * - `contract` mode with the required contract present: read every gate and
 *   report the observed state, halting with a partial report whenever a gate
 *   is not verified.
 * - `contract` mode with the required contract absent: the skill carries no
 *   instruction for the scenario, so the executor falls back to the modeled
 *   default of trusting the untrusted summary.
 * - `greenwash` mode: never reads evidence at all. This is the negative
 *   control; the harness must fail it.
 */
export function createColdExecutor(scenario: Scenario, skillText: string) {
  const contractPresent = scenario.requiredContract.every((marker) => skillText.includes(marker))
  const honorsContract = scenario.mode === 'contract' && contractPresent

  return async ({ task, tools }: any) => {
    if (
      scenario.mode === 'greenwash' ||
      (!honorsContract && scenario.blindBehavior === 'no-inspect')
    ) {
      return {
        status: 'complete',
        requirements: task.requirementIds.map((id: string, index: number) => ({
          id,
          evidenceId: scenario.summaryGateIds[index] ?? `summary-gate-${index + 1}`,
          state: 'verified',
        })),
      }
    }

    const requirements = task.requirementIds.map((id: string) => {
      const evidence = tools.inspect(id)
      return {
        id,
        evidenceId: evidence.id,
        state: honorsContract ? classify(evidence, task.candidate) : 'verified',
      }
    })
    const allVerified = requirements.every((item: any) => item.state === 'verified')
    return {
      status: allVerified ? 'complete' : 'partial',
      requirements,
    }
  }
}

export type ScenarioObservation = {
  id: string
  kind: string
  skill: string
  variant: Variant
  contractPresent: boolean
  context: {
    entrypointBytes: number
    bundledBytes: number
    bundledFileCount: number
    skillMdDigest: string
    routingBytes: number
  }
  measurements: {
    toolCalls: number
    inspectCalls: number
    attemptCalls: number
    deniedCalls: number
    durationMs: number
    failedAssertions: string[]
    errors: string[]
  }
  observed: {
    passed: boolean
    reportingHonesty: boolean
    behaviorCompliance: boolean
    taskOutcome: string
  }
  expected: Record<string, unknown>
  matchesExpectation: boolean
}

/** Run one scenario against one library variant and record the observations. */
export async function runScenario(options: {
  suite: Suite
  scenario: Scenario
  variant: Variant
  library: LibrarySnapshot
}): Promise<ScenarioObservation> {
  const { suite, scenario, variant, library } = options
  const skill = library.skills.find((item) => item.name === scenario.skill)
  if (!skill) throw new Error(`scenario ${scenario.id} needs skill '${scenario.skill}'`)

  const executor = createColdExecutor(scenario, skill.text)
  const receipt = await runEvidenceAuditEval({
    fixture: scenario.fixture,
    executor,
    executorReference: suite.harness.executorReference,
    seed: suite.harness.seed,
    timeoutMs: suite.harness.timeoutMs,
  })

  const observed = {
    passed: receipt.passed,
    reportingHonesty: receipt.verdicts.reportingHonesty,
    behaviorCompliance: receipt.verdicts.behaviorCompliance,
    taskOutcome: receipt.verdicts.taskOutcome,
  }
  const expected = scenario.expected[variant] as Record<string, unknown>
  const contractPresent = scenario.requiredContract.every((marker) => skill.text.includes(marker))

  return {
    id: scenario.id,
    kind: scenario.kind,
    skill: scenario.skill,
    variant,
    contractPresent,
    context: {
      entrypointBytes: skill.entrypointBytes,
      bundledBytes: skill.bundledBytes,
      bundledFileCount: skill.bundledFileCount,
      skillMdDigest: skill.digest,
      routingBytes: routingBytes(skill.text),
    },
    measurements: {
      toolCalls: receipt.observations.length,
      inspectCalls: receipt.observations.filter((item) => item.operation === 'inspect').length,
      attemptCalls: receipt.observations.filter((item) => item.operation === 'attempt').length,
      deniedCalls: receipt.observations.filter((item) => item.outcome === 'denied').length,
      durationMs: Math.round(receipt.durationMs * 1000) / 1000,
      failedAssertions: receipt.assertions.filter((item) => !item.passed).map((item) => item.id),
      errors: receipt.completion === 'returned' ? [] : [`executor ${receipt.completion}`],
    },
    observed,
    expected,
    matchesExpectation: JSON.stringify(observed) === JSON.stringify(expected),
  }
}

/** Deterministic, drift-free evidence artifact. Timings are excluded. */
export function buildEvidence(options: {
  suite: Suite
  baseline: LibrarySnapshot
  candidate: LibrarySnapshot
  observations: ScenarioObservation[]
}) {
  const { suite, baseline, candidate, observations } = options
  const byVariant = (variant: Variant) => observations.filter((item) => item.variant === variant)
  const summarize = (variant: Variant) => {
    const rows = byVariant(variant)
    return {
      scenarios: rows.length,
      matchedExpectation: rows.filter((row) => row.matchesExpectation).length,
      passed: rows.filter((row) => row.observed.passed).length,
      reportingHonesty: rows.filter((row) => row.observed.reportingHonesty).length,
      behaviorCompliance: rows.filter((row) => row.observed.behaviorCompliance).length,
      toolCalls: rows.reduce((total, row) => total + row.measurements.toolCalls, 0),
      inspectCalls: rows.reduce((total, row) => total + row.measurements.inspectCalls, 0),
      deniedCalls: rows.reduce((total, row) => total + row.measurements.deniedCalls, 0),
      failedAssertions: rows.reduce(
        (total, row) => total + row.measurements.failedAssertions.length,
        0
      ),
    }
  }
  const skillsCovered = [...new Set(suite.scenarios.map((scenario) => scenario.skill))].toSorted()
  const retainedSkills = candidate.skills.map((skill) => skill.name).toSorted()
  return {
    schemaVersion: 1,
    suite: suite.suite,
    version: suite.version,
    generatedBy: 'docs/evals/skill-evals/run-skill-evals.mts',
    harness: {
      module: suite.harness.module,
      api: suite.harness.api,
      fixtureSchema: suite.harness.fixtureSchema,
      seed: suite.harness.seed,
      executorReference: suite.harness.executorReference,
      ownership: 'owned by CP #191 (F2W5); consumed read-only',
    },
    coverage: {
      retainedSkills: retainedSkills.length,
      coveredSkills: skillsCovered.length,
      skillsCovered,
      skillsNotCovered: retainedSkills.filter((name) => !skillsCovered.includes(name)),
      note: 'Every retained skill is exercised by at least one scenario. Coverage means the skill contract is exercised by the modeled cold executor, not that the skill content is correct, complete, or actionable.',
    },
    measurementLimits: [
      'The baseline-versus-candidate difference is decided by whether the skill text carries the contract markers the scenario requires. The library-level contract is therefore a small number of independent facts (the evidence contract, the boundary contract, and the stop conditions), and the scenarios differ in their evidence fixtures rather than in the skill-side input.',
      'The suite measures contract presence and honest reporting through a modeled cold executor over the CP #191 harness. It is not a model, not a human, and not a live routing measurement.',
    ],
    baseline: {
      commit: baseline.commit,
      reproduction:
        'The baseline arm is reproduced only when the pinned commit is present in the checkout. A depth-1 clone does not contain it, so a lane that checks out at depth 1 reproduces the candidate arm only and skips the baseline comparison.',
      skillCount: baseline.skillCount,
      routingBytes: baseline.routingBytes,
      entrypointBytes: baseline.entrypointBytes,
      bundledBytes: baseline.bundledBytes,
      skills: baseline.skills.map((skill) => ({
        name: skill.name,
        version: skill.version,
        entrypointBytes: skill.entrypointBytes,
        bundledBytes: skill.bundledBytes,
        bundledFileCount: skill.bundledFileCount,
        routingBytes: routingBytes(skill.text),
        skillMdDigest: skill.digest,
      })),
    },
    candidate: {
      skillCount: candidate.skillCount,
      routingBytes: candidate.routingBytes,
      entrypointBytes: candidate.entrypointBytes,
      bundledBytes: candidate.bundledBytes,
      skills: candidate.skills.map((skill) => ({
        name: skill.name,
        version: skill.version,
        entrypointBytes: skill.entrypointBytes,
        bundledBytes: skill.bundledBytes,
        bundledFileCount: skill.bundledFileCount,
        routingBytes: routingBytes(skill.text),
        skillMdDigest: skill.digest,
      })),
    },
    delta: {
      routingBytes: candidate.routingBytes - baseline.routingBytes,
      entrypointBytes: candidate.entrypointBytes - baseline.entrypointBytes,
      bundledBytes: candidate.bundledBytes - baseline.bundledBytes,
    },
    results: {
      baseline: summarize('baseline'),
      candidate: summarize('candidate'),
    },
    scenarios: observations.map((row) => ({
      id: row.id,
      kind: row.kind,
      skill: row.skill,
      variant: row.variant,
      contractPresent: row.contractPresent,
      context: row.context,
      toolCalls: row.measurements.toolCalls,
      inspectCalls: row.measurements.inspectCalls,
      deniedCalls: row.measurements.deniedCalls,
      failedAssertions: row.measurements.failedAssertions,
      observed: row.observed,
      expected: row.expected,
      matchesExpectation: row.matchesExpectation,
    })),
    humanGate: {
      status: 'awaiting-blinded-human-scoring',
      reviewerCorrections: null,
      note: 'Human calibration is an external gate. No human score, reviewer correction count, or blinded verdict is produced by this offline run; the nulls above must stay null until a real reviewer fills them in.',
      packet: 'docs/evals/skill-evals/blinded-comparison-packet.md',
    },
  }
}

export async function loadSuite(root: string): Promise<Suite> {
  const path = join(root, 'docs', 'evals', 'skill-evals', 'skill-eval-fixtures.v1.json')
  const suite = JSON.parse(await readFile(path, 'utf8')) as Suite
  if (suite.schemaVersion !== 1) throw new Error('unsupported skill-eval fixture schema version')
  if (!Array.isArray(suite.scenarios) || suite.scenarios.length === 0) {
    throw new Error('skill-eval fixture set is empty')
  }
  return suite
}

/** Every canary value the fixture set declares, in scenario order. */
export function suiteCanaries(suite: Suite): string[] {
  return suite.scenarios
    .map((scenario) => scenario.canary)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

/**
 * One output the runner may persist. `content` is the exact byte sequence
 * that would be written; `name` is a stable label used in failure messages.
 */
export type PersistedOutput = {
  path: string
  content: string
  name: string
}

/**
 * A canary value was found in a serialized output.
 *
 * The gate runs before any destination write, so this rejection creates no
 * output file and overwrites no prior artifact. The message names the affected
 * outputs only: a canary value is never emitted.
 */
export class SkillEvalCanaryGateError extends Error {
  readonly outputs: string[]

  constructor(outputs: string[]) {
    super(
      `skill-eval canary gate refused to persist ${outputs.length} output(s) containing a canary value: ${outputs.join(', ')}`
    )
    this.name = 'SkillEvalCanaryGateError'
    this.outputs = outputs
  }
}

/**
 * A destination write failed after the canary gate had already passed.
 *
 * The batch is written sequentially, so earlier outputs may already be on
 * disk. `persisted` names the outputs that were written before the failure
 * and `failed` names the one that did not, so the caller can report a partial
 * state truthfully instead of claiming that nothing was written.
 */
export class SkillEvalPersistenceError extends Error {
  readonly persisted: string[]
  readonly failed: string

  constructor(persisted: string[], failed: string, cause: unknown) {
    super(
      `skill-eval persistence failed while writing '${failed}' after ${persisted.length} output(s) had already been persisted. The output state may be partial.`,
      { cause }
    )
    this.name = 'SkillEvalPersistenceError'
    this.persisted = persisted
    this.failed = failed
  }
}

/**
 * Fail-closed canary gate.
 *
 * Every output that could be persisted is scanned before the first byte is
 * written, so a canary value never reaches disk and no existing artifact is
 * overwritten. The failure message names the affected outputs only: a canary
 * value is never emitted.
 */
export function assertOutputsCanaryFree(outputs: PersistedOutput[], canaries: string[]): void {
  const affected = outputs
    .filter((output) => canaries.some((canary) => output.content.includes(canary)))
    .map((output) => output.name)
  if (affected.length === 0) return
  throw new SkillEvalCanaryGateError(affected)
}

/**
 * Scan, then write.
 *
 * A canary rejection is raised before the first destination write, so it
 * creates no output and overwrites no prior artifact. A write failure is
 * different: the batch is sequential, so the outputs written before the
 * failure stay on disk. That is reported as a
 * {@link SkillEvalPersistenceError} that lists exactly what was persisted.
 */
export async function persistOutputs(
  outputs: PersistedOutput[],
  canaries: string[]
): Promise<void> {
  assertOutputsCanaryFree(outputs, canaries)
  const persisted: string[] = []
  for (const output of outputs) {
    try {
      await mkdir(dirname(output.path), { recursive: true })
      await writeFile(output.path, output.content)
    } catch (cause) {
      throw new SkillEvalPersistenceError(persisted, output.name, cause)
    }
    persisted.push(output.name)
  }
}
