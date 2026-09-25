import { performance } from 'node:perf_hooks'
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
    'tests/m11-consistency-metric-wiring.test.mjs',
    'tests/m11-context-authoring-composition.test.mjs',
    'tests/m11-context-composition.test.mjs',
    'tests/m11-context-transport-e2e.test.mjs',
    'tests/m11-standalone-e2e.test.mjs',
    'tests/service-lifecycle-e2e.test.mjs',
  ],
  smoke: [
    'tests/agent-skill-library.test.mjs',
    'tests/container-promotion.test.mjs',
    'tests/foundation.test.mjs',
    'tests/infrastructure.test.mjs',
    'tests/m11-acp-installation.test.mjs',
    'tests/m11-architecture-audit.test.mjs',
    'tests/m11-context-command-contract.test.mjs',
    'tests/m11-graph-composition.test.mjs',
    'tests/m11-native-packaging.test.mjs',
    'tests/m11-prd-principle-crosswalk.test.mjs',
    'tests/m11-requirements-ledger.test.mjs',
    'tests/m11-reconciliation-parity.test.mjs',
    'tests/cp1-embedded-durable-execution.test.mjs',
    'tests/m11-security-probes.test.mjs',
    'tests/m11-sqlite-benchmark.test.mjs',
    'tests/neon-workflow.test.mjs',
    'tests/skill-library.test.mjs',
    'tests/m11-recovery-rpo-rto.test.mjs',
    'tests/m11-retention-apply-cli.test.mjs',
    'tests/m11-retention-class-registry.test.mjs',
    'tests/m11-retention-restore-reapply.test.mjs',
    'tests/repository.test.mjs',
    'tests/restate-identity.test.mjs',
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
    .toSorted()

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
    // Code-point ordering (not localeCompare): this script is copied into temp
    // fixture repos by tests, so shared-package imports are unavailable here.
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
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
    .toSorted()
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
  const startedAt = performance.now()
  const result = spawnSync(
    process.execPath,
    ['test', ...testArguments, ...files.map((path) => `./${path}`)],
    {
      cwd: repositoryRoot,
      stdio: 'inherit',
      env: process.env,
    }
  )
  const elapsedSeconds = Math.round((performance.now() - startedAt) / 100) / 10

  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
  } else if (process.env.CI === 'true' && process.env.SKIP_LANE_BUDGET !== '1') {
    // Budgets are calibrated to CI runner timings; local hosts are too contended
    // for a hard gate, so enforcement is CI-only.
    const budget = spawnSync(
      process.execPath,
      ['scripts/check-budgets.mjs', 'lane', '--group', group, '--seconds', String(elapsedSeconds)],
      {
        cwd: repositoryRoot,
        stdio: 'inherit',
        env: process.env,
      }
    )
    if (budget.error) throw budget.error
    if (budget.status !== 0) process.exitCode = budget.status ?? 1
  } else if (result.status === 0) {
    console.log(
      `lane ${group}: ${elapsedSeconds}s (budget check is CI-only; SKIP_LANE_BUDGET=1 also skips)`
    )
  }
  if (result.status === 0 && collectsCoverage) {
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
    if (coverage.status !== 0) process.exitCode ??= coverage.status ?? 1
  }
}
