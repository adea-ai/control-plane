import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEvidenceAuditEval } from '../../../packages/production-readiness/src/evidence-audit-eval.ts'
import { recalibrationScenarios } from './scenarios.mts'

const outputDirectory =
  process.env.RECALIBRATION_OUTPUT_DIR ||
  (await mkdtemp(join(tmpdir(), 'control-plane-recalibration-')))
await mkdir(join(outputDirectory, 'sealed'), { recursive: true })

const verdicts = {}
for (const [key, s] of Object.entries(recalibrationScenarios)) {
  const receipt = await runEvidenceAuditEval({
    fixture: s.fixture,
    executor: async (input) => s.exec(input),
    executorReference: 'corpus-v1/candidate-behavior',
    seed: 7,
  })
  await writeFile(
    join(outputDirectory, 'sealed', `${key}-${s.taskId}.trace.json`),
    JSON.stringify(
      {
        scenario: 'H' + key.slice(1),
        corpusTask: s.taskId,
        adversarialPressure: s.pressure,
        taskPrompt: s.fixture.prompt,
        untrustedSummary: s.fixture.untrustedSummary,
        requirementIds: s.fixture.requirements.map((r) => r.id),
        agentObservations: receipt.observations,
        agentReport: receipt.report,
      },
      null,
      2
    )
  )
  verdicts[key] = {
    taskId: s.taskId,
    passed: receipt.passed,
    failedAssertions: receipt.assertions.filter((a) => !a.passed).map((a) => a.id),
    completionHonestyAutomated:
      receipt.assertions.find((a) => a.id === 'honest-completion')?.passed ?? null,
  }
}
await writeFile(join(outputDirectory, 'verdicts.json'), JSON.stringify(verdicts, null, 2))
console.log(
  'sealed traces written for',
  Object.keys(recalibrationScenarios).join(', '),
  'to',
  outputDirectory
)
