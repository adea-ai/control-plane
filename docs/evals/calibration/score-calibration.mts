/**
 * Scores the blinded human calibration packet and computes the agreement and
 * error bounds for #191.
 *
 * The metrics stay withheld until real human scoring exists. When no human
 * scoring file is present, or when only part of the scenario set is scored, the
 * report records that state and publishes no agreement, kappa, or error bound.
 *
 *   bun docs/evals/calibration/score-calibration.mts
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeCalibrationAgreement,
  type CalibrationGraderVerdict,
  type CalibrationHumanScore,
} from '../../../packages/production-readiness/src/adversarial-eval-corpus.ts'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
/** Formats a generated JSON artifact with the repository formatter when it is available. */
function formatJsonArtifact(path: string): void {
  const formatter = join(repositoryRoot, 'node_modules/.bin/oxfmt')
  if (!existsSync(formatter)) return
  spawnSync(formatter, [path], { stdio: 'ignore' })
}

const calibrationDirectory =
  process.env.CALIBRATION_OUTPUT_DIR ?? join(repositoryRoot, 'docs/evals/calibration')
/**
 * The grader verdicts are the answer key and live OUTSIDE the directory the
 * reviewer receives, so the scorer reads them from the same separate root the
 * packet builder writes them to.
 */
const verdictDirectory =
  process.env.CALIBRATION_VERDICT_OUTPUT_DIR ??
  join(calibrationDirectory, '..', 'calibration-verdicts')

const graderVerdictFile = join(verdictDirectory, 'grader-verdicts.json')
const humanScoreFile = join(calibrationDirectory, 'human-scores.json')
const reportFile = join(calibrationDirectory, 'calibration-report.json')

const graderPayload = JSON.parse(await readFile(graderVerdictFile, 'utf8')) as {
  verdicts: CalibrationGraderVerdict[]
}
const graderVerdicts = graderPayload.verdicts

// The blinded packet's own corpus binding. The report attests the corpus the
// packet declares, so a packet built for another corpus is detectable rather
// than being re-stamped with the current corpus digest.
const blindedPacketFile = join(calibrationDirectory, 'blinded-packet.json')
let packet: { packetId: string; corpusDigest: string } | undefined
if (existsSync(blindedPacketFile)) {
  const blindedPacket = JSON.parse(await readFile(blindedPacketFile, 'utf8')) as {
    packetId?: unknown
    corpusDigest?: unknown
  }
  if (
    typeof blindedPacket.packetId === 'string' &&
    typeof blindedPacket.corpusDigest === 'string'
  ) {
    packet = { packetId: blindedPacket.packetId, corpusDigest: blindedPacket.corpusDigest }
  }
}

let humanScores: CalibrationHumanScore[] = []
let humanScoresPresent = false
try {
  const humanPayload = JSON.parse(await readFile(humanScoreFile, 'utf8')) as {
    scores: CalibrationHumanScore[]
  }
  humanScores = humanPayload.scores
  humanScoresPresent = true
} catch {
  humanScoresPresent = false
}

const report = computeCalibrationAgreement({
  humanScores,
  graderVerdicts,
  ...(packet === undefined ? {} : { packet }),
  seed: Number(process.env.CP_EVAL_SEED ?? '191'),
})

await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
formatJsonArtifact(reportFile)

if (!humanScoresPresent || report.status !== 'scored') {
  console.log(
    `calibration metrics withheld (status: ${report.status}). ` +
      'No agreement, kappa, or error bound is published until every scenario is scored by a human reviewer.'
  )
  process.exit(0)
}

console.log(
  `calibration scored: ${report.scoredScenarios} scenarios, ` +
    `${report.metrics?.dimensions.length ?? 0} dimensions, ` +
    `grader-only promotion: ${report.promotion.graderOnlyPromotion}`
)
