import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  isolationDimensions,
  isolationEvidence,
  isolationOperations,
} from './m9-evidence-matrices.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

const expectedCells = isolationDimensions.flatMap((dimension) =>
  isolationOperations.map((operation) => `${dimension}:${operation}`)
)
const actualCells = isolationEvidence.map(({ dimension, operation }) => `${dimension}:${operation}`)
if (new Set(actualCells).size !== actualCells.length) throw new Error('ISOLATION_MATRIX_DUPLICATE')
if (
  expectedCells.some((cell) => !actualCells.includes(cell)) ||
  actualCells.length !== expectedCells.length
) {
  throw new Error('ISOLATION_MATRIX_INCOMPLETE')
}

for (const { file, testName } of isolationEvidence) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  if (!source.includes(`test('${testName}'`))
    throw new Error(`ISOLATION_EVIDENCE_MISSING:${file}:${testName}`)
}

const files = [...new Set(isolationEvidence.map(({ file }) => `./${file}`))].toSorted()
const result = spawnSync(process.execPath, ['test', ...files], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  env: process.env,
})
if (result.error) throw result.error
if (result.status !== 0) process.exitCode = result.status ?? 1
else console.log(`Isolation matrix passed: ${actualCells.length} production read/mutation cells.`)
