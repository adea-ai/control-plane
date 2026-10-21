/**
 * Builds the blinded human calibration packet for #191.
 *
 * The packet contains the task, the adversarial pressure, the observed agent
 * trace, and the rubric. It never contains the grader verdict, the harness
 * assertions, or the expected states. The grader verdicts are written to a
 * separate file that the reviewer never receives.
 *
 *   bun docs/evals/calibration/build-calibration-packet.mts
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEvidenceAuditEval } from '../../../packages/production-readiness/src/evidence-audit-eval.ts'
import {
  buildBlindedCalibrationPacket,
  type CalibrationScenarioTrace,
} from '../../../packages/production-readiness/src/adversarial-eval-corpus.ts'
import { recalibrationScenarios } from '../recalibration/scenarios.mts'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const outputDirectory =
  process.env.CALIBRATION_OUTPUT_DIR ?? join(repositoryRoot, 'docs/evals/calibration')

const traces: CalibrationScenarioTrace[] = []
const graderVerdicts: {
  scenarioId: string
  dimension: string
  score: 'pass' | 'partial' | 'fail'
  completionHonesty: 'yes' | 'overclaimed' | 'underclaimed'
}[] = []

for (const [key, scenario] of Object.entries(recalibrationScenarios)) {
  const receipt = await runEvidenceAuditEval({
    fixture: scenario.fixture,
    executor: async (input) => scenario.exec(input),
    executorReference: 'corpus-v1/candidate-behavior',
    seed: 7,
  })
  traces.push({
    id: 'H' + key.slice(1),
    corpusTask: scenario.taskId,
    pressure: scenario.pressure,
    taskPrompt: scenario.fixture.prompt,
    untrustedSummary: scenario.fixture.untrustedSummary,
    requirementIds: scenario.fixture.requirements.map((requirement) => requirement.id),
    agentObservations: receipt.observations,
    agentReport: receipt.report,
  })
  const completionHonesty = receipt.assertions.find(({ id }) => id === 'honest-completion')?.passed
  for (const dimension of [
    'goal_coverage',
    'constraint_adherence',
    'evidence_sufficiency',
    'verification_completeness',
    'scope_control',
    'refusal_escalation_quality',
  ]) {
    graderVerdicts.push({
      scenarioId: 'H' + key.slice(1),
      dimension,
      score: receipt.passed ? 'pass' : 'partial',
      completionHonesty: completionHonesty === true ? 'yes' : 'overclaimed',
    })
  }
}

const packet = buildBlindedCalibrationPacket({ traces })

await mkdir(outputDirectory, { recursive: true })
await writeFile(
  join(outputDirectory, 'blinded-packet.json'),
  JSON.stringify(packet, null, 2) + '\n'
)
await writeFile(
  join(outputDirectory, 'grader-verdicts.json'),
  JSON.stringify({ schemaVersion: 1, kit: packet.packetId, verdicts: graderVerdicts }, null, 2) +
    '\n'
)
console.log(
  `blinded packet written with ${packet.scenarios.length} scenarios to ${outputDirectory}`
)
