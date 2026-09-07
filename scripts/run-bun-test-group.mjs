import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceRoots = ['apps', 'packages']
const testRoots = [...sourceRoots, 'tests']
const repositoryGroups = {
  e2e: [
    'tests/m2-core-domain.test.mjs',
    'tests/m3-durable-execution.test.mjs',
    'tests/m4-runtime-fabric.test.mjs',
    'tests/m5-runtime-gateway.test.mjs',
    'tests/m6-runtime-adapters.test.mjs',
    'tests/m7-tools-models-sandboxes.test.mjs',
    'tests/m8-multi-agent-orchestration.test.mjs',
    'tests/m9-cloud-certification.test.mjs',
    'tests/m9-production-hardening.test.mjs',
    'tests/m10-portability-conformance.test.mjs',
    'tests/m10-operability.test.mjs',
    'tests/m11-standalone-e2e.test.mjs',
  ],
  smoke: [
    'tests/foundation.test.mjs',
    'tests/infrastructure.test.mjs',
    'tests/m11-architecture-audit.test.mjs',
    'tests/m11-requirements-ledger.test.mjs',
    'tests/neon-workflow.test.mjs',
    'tests/repository.test.mjs',
  ],
}

const primaryLanes = ['unit', 'integration', 'e2e', 'smoke']
const deterministicSeed = '1104'

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? walk(path) : [path]
    })
  )
  return paths.flat()
}

function isIntegrationTest(path) {
  const name = basename(path)
  return name === 'integration.test.mjs' || name.endsWith('.integration.test.mjs')
}

export async function discoverTestFiles(group) {
  if (group in repositoryGroups) return repositoryGroups[group]
  if (group !== 'unit' && group !== 'integration') {
    throw new Error(`Unknown test group: ${group}`)
  }

  const files = (
    await Promise.all(sourceRoots.map((directory) => walk(resolve(repositoryRoot, directory))))
  )
    .flat()
    .filter(
      (path) => path.endsWith('.test.mjs') && isIntegrationTest(path) === (group === 'integration')
    )
    .map((path) => relative(repositoryRoot, path))
    .sort()

  if (files.length === 0) throw new Error(`No ${group} tests were discovered.`)
  return files
}

export async function discoverTestInventory() {
  const groups = await Promise.all(
    primaryLanes.map(async (primaryLane) => ({
      primaryLane,
      files: await discoverTestFiles(primaryLane),
    }))
  )
  const inventory = groups
    .flatMap(({ primaryLane, files }) => files.map((path) => ({ path, primaryLane })))
    .sort((left, right) => left.path.localeCompare(right.path))
  const duplicates = inventory.filter(
    ({ path }, index) => inventory.findIndex((candidate) => candidate.path === path) !== index
  )
  if (duplicates.length > 0) {
    throw new Error(
      `Test files have multiple primary lanes: ${[...new Set(duplicates.map(({ path }) => path))].join(', ')}`
    )
  }
  const discovered = (
    await Promise.all(testRoots.map((directory) => walk(resolve(repositoryRoot, directory))))
  )
    .flat()
    .filter((path) => path.endsWith('.test.mjs'))
    .map((path) => relative(repositoryRoot, path))
    .sort()
  const assigned = new Set(inventory.map(({ path }) => path))
  const discoveredSet = new Set(discovered)
  const unowned = discovered.filter((path) => !assigned.has(path))
  const missing = inventory.filter(({ path }) => !discoveredSet.has(path)).map(({ path }) => path)
  if (unowned.length > 0 || missing.length > 0) {
    throw new Error(
      `Test lane inventory drift: unowned [${unowned.join(', ')}], missing [${missing.join(', ')}]`
    )
  }
  return inventory
}

export function normalizedBunTestArguments(arguments_) {
  if (
    arguments_.some(
      (argument) =>
        argument === '--retry' ||
        argument.startsWith('--retry=') ||
        argument === '--rerun-each' ||
        argument.startsWith('--rerun-each=')
    )
  ) {
    throw new Error('Automatic retries are forbidden; rerun a failed lane only for diagnostics.')
  }
  const hasSeed = arguments_.some(
    (argument) => argument === '--seed' || argument.startsWith('--seed=')
  )
  const hasRandomize = arguments_.includes('--randomize')
  return [
    ...(!hasRandomize ? ['--randomize'] : []),
    ...(!hasSeed ? ['--seed', deterministicSeed] : []),
    ...arguments_,
  ]
}

if (import.meta.main) {
  const [group, ...bunArguments] = process.argv.slice(2)
  const files = await discoverTestFiles(group)
  const collectsCoverage = bunArguments.includes('--coverage')
  const testArguments = normalizedBunTestArguments(bunArguments)
  const result = spawnSync(
    process.execPath,
    ['test', ...testArguments, ...files.map((path) => `./${path}`)],
    {
      cwd: repositoryRoot,
      stdio: 'inherit',
      env: process.env,
    }
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
  } else if (collectsCoverage) {
    const coverage = spawnSync(
      process.execPath,
      ['scripts/check-coverage.mjs', 'coverage/lcov.info'],
      {
        cwd: repositoryRoot,
        stdio: 'inherit',
        env: process.env,
      }
    )
    if (coverage.error) throw coverage.error
    process.exitCode = coverage.status ?? 1
  }
}
