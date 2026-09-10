import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { secretCanaryEvidence, secretCanarySinks } from './m9-evidence-matrices.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const actualSinks = secretCanaryEvidence.map(({ sink }) => sink)

if (new Set(actualSinks).size !== actualSinks.length) throw new Error('SECRET_CANARY_DUPLICATE')
if (
  secretCanarySinks.some((sink) => !actualSinks.includes(sink)) ||
  actualSinks.length !== secretCanarySinks.length
) {
  throw new Error('SECRET_CANARY_MATRIX_INCOMPLETE')
}

for (const { file, testName } of secretCanaryEvidence) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  if (!source.includes(`test('${testName}'`)) {
    throw new Error(`SECRET_CANARY_EVIDENCE_MISSING:${file}:${testName}`)
  }
}

const files = [...new Set(secretCanaryEvidence.map(({ file }) => `./${file}`))].toSorted()
const result = spawnSync(process.execPath, ['test', ...files], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  env: process.env,
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

console.log(`Secret canary matrix passed: ${actualSinks.length} production sinks.`)
