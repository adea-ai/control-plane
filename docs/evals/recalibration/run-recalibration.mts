import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEvidenceAuditEval } from '../../../packages/production-readiness/src/evidence-audit-eval.ts'
import { recalibrationScenarios } from './scenarios.mts'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** Formats a generated JSON artifact with the repository formatter when it is available. */
function formatJsonArtifact(path: string): void {
  const formatter = join(repositoryRoot, 'node_modules/.bin/oxfmt')
  if (!existsSync(formatter)) return
  spawnSync(formatter, [path], { stdio: 'ignore' })
}

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
    ) + '\n'
  )
  verdicts[key] = {
    taskId: s.taskId,
    passed: receipt.passed,
    failedAssertions: receipt.assertions.filter((a) => !a.passed).map((a) => a.id),
    completionHonestyAutomated:
      receipt.assertions.find((a) => a.id === 'honest-completion')?.passed ?? null,
  }
}
await writeFile(join(outputDirectory, 'verdicts.json'), JSON.stringify(verdicts, null, 2) + '\n')
for (const file of await readdir(join(outputDirectory, 'sealed'))) {
  formatJsonArtifact(join(outputDirectory, 'sealed', file))
}
formatJsonArtifact(join(outputDirectory, 'verdicts.json'))
console.log(
  'sealed traces written for',
  Object.keys(recalibrationScenarios).join(', '),
  'to',
  outputDirectory
)
