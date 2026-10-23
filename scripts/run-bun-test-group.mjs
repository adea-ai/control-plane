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
    'tests/m11-local-native-terminal-usage.test.mjs',
    'tests/m11-standalone-e2e.test.mjs',
    'tests/child-progress-two-siblings-composition.test.mjs',
    'tests/child-runtime-budget-admission.test.mjs',
    'tests/pi-child-continuation-sqlite.test.mjs',
    'tests/pi-durable-child-host.test.mjs',
    'tests/pi-durable-child-mapping-recovery.test.mjs',
    'tests/delegation-receipt-retention-restart.test.mjs',
    'tests/delegation-interaction-publication-restart.test.mjs',
    'tests/pi-durable-delegation-recovery.test.mjs',
    'tests/pi-durable-canonical-authority.test.mjs',
    'tests/pi-durable-production-child-composition.test.mjs',
    'tests/pi-durable-production-child-bridge-recovery.test.mjs',
    'tests/pi-durable-execution-model-composition.test.mjs',
    'tests/pi-durable-governed-child-composition.test.mjs',
    'tests/pi-durable-compaction-governed-dispatch.test.mjs',
    'tests/pi-durable-governed-publisher-regression.test.mjs',
    'tests/j1-unfinished-child-process-restart.test.mjs',
    'tests/profile-recovery-pi-lead-restart.test.mjs',
    'tests/j1-native-child-store-restart.test.mjs',
    'tests/pi-durable-workspace-scope.test.mjs',
    'tests/pi-production-management-authority.test.mjs',
    'tests/pi-production-management-forwarding.test.mjs',
    'tests/pi-production-runtime-startup.test.mjs',
    'tests/pi-production-factory.test.mjs',
    'tests/pi-byo-model-authority.test.mjs',
    'tests/service-lifecycle-e2e.test.mjs',
    'tests/acp-remote-shared-provider.test.mjs',
    'tests/acp-remote-device-retention.test.mjs',
  ],
  smoke: [
    'tests/agent-skill-library.test.mjs',
    'tests/atomic-clause-ledger.test.mjs',
    'tests/canonical-source-lineage.test.mjs',
    'tests/container-promotion.test.mjs',
    'tests/docker-pull-backoff.test.mjs',
    'tests/digest-writer-guard.test.mjs',
    'tests/e2e-shards.test.mjs',
    'tests/foundation.test.mjs',
    'tests/infrastructure.test.mjs',
    'tests/integration-shards.test.mjs',
    'tests/integration-runner-lifecycle.test.mjs',
    'tests/postgres-probe-diagnostics.test.mjs',
    'tests/hosted-compose-lifecycle.test.mjs',
    'tests/hosted-graph-qualification.test.mjs',
    'tests/langgraph-retirement-inventory.test.mjs',
    'tests/langgraph-retirement-status-adapter.test.mjs',
    'tests/m11-admission-rollout-admin.test.mjs',
    'tests/m11-acp-installation.test.mjs',
    'tests/m11-architecture-audit.test.mjs',
    'tests/m11-architecture-audit-regression.test.mjs',
    'tests/m11-context-command-contract.test.mjs',
    'tests/m11-graph-composition.test.mjs',
    'tests/m11-managed-graph-runtime.test.mjs',
    'tests/m11-injection-eval.test.mjs',
    'tests/m11-native-packaging.test.mjs',
    'tests/managed-pi-docker-packaging.test.mjs',
    'tests/managed-pi-version-preflight.test.mjs',
    'tests/m11-prd-principle-crosswalk.test.mjs',
    'tests/m11-requirements-ledger.test.mjs',
    'tests/m11-reconciliation-parity.test.mjs',
    'tests/cp1-embedded-durable-execution.test.mjs',
    'tests/m11-security-probes.test.mjs',
    'tests/m11-sqlite-benchmark.test.mjs',
    'tests/pi-durable-cp1048-evidence-discipline.test.mjs',
    'tests/profile-recovery-crash-restore.test.mjs',
    'tests/profile-recovery-fenced-rollback.test.mjs',
    'tests/profile-recovery-rebind-fencing.test.mjs',
    'tests/profile-recovery-selfhosted-server-wake-replay.boundary.test.mjs',
    'tests/skill-library.test.mjs',
    'tests/m11-recovery-rpo-rto.test.mjs',
    'tests/m11-retention-apply-cli.test.mjs',
    'tests/m11-retention-class-registry.test.mjs',
    'tests/m11-retention-hold-operator.test.mjs',
    'tests/m11-retention-restore-reapply.test.mjs',
    'tests/profile-recovery-cleanup.test.mjs',
    'tests/railway-production-plan.test.mjs',
    'tests/release-pr-readiness.test.mjs',
    'tests/replacement-compatibility.test.mjs',
    'tests/repository.test.mjs',
    'tests/runner-cleanup.test.mjs',
    'tests/task-cache-qualification.test.mjs',
    'tests/workspace-tooling.test.mjs',
    'tests/restate-identity.test.mjs',
  ],
}

const primaryLanes = ['unit', 'integration', 'e2e', 'smoke']
const deterministicSeed = '1104'

/**
 * Measured wall-clock cost of every E2E file, in CI seconds.
 *
 * The values are the mean of the per-file totals measured in run 39346283807
 * (2026-10-20, head 96f62506) and run 39263107268 (2026-10-19, main
 * a4c9aa69). The E2E lane is one sequential job, so its wall clock is the sum
 * of these costs. Run 39346283807 measured 128.7s for the same 490 passing
 * tests and 3,910 assertions that measured 82.7s on main, and the extra time
 * was runner speed rather than work: that job's build phase took 23.1s
 * against 15.3s on main, and every file scaled by the same factor. The lane
 * therefore runs as two shards, and this table keeps the split balanced.
 */
export const e2eMeasuredSeconds = new Map([
  ['tests/acp-remote-device-retention.test.mjs', 0.1],
  ['tests/acp-remote-shared-provider.test.mjs', 0.3],
  ['tests/child-progress-two-siblings-composition.test.mjs', 0.1],
  ['tests/child-runtime-budget-admission.test.mjs', 0.3],
  ['tests/delegation-interaction-publication-restart.test.mjs', 0.2],
  ['tests/delegation-receipt-retention-restart.test.mjs', 0.5],
  ['tests/j1-native-child-store-restart.test.mjs', 0.5],
  ['tests/j1-unfinished-child-process-restart.test.mjs', 17.0],
  ['tests/m10-operability.test.mjs', 0.0],
  ['tests/m10-portability-conformance.test.mjs', 0.1],
  ['tests/m11-consistency-metric-wiring.test.mjs', 0.1],
  ['tests/m11-context-authoring-composition.test.mjs', 0.0],
  ['tests/m11-context-composition.test.mjs', 0.4],
  ['tests/m11-context-transport-e2e.test.mjs', 0.2],
  ['tests/m11-local-native-terminal-usage.test.mjs', 1.7],
  ['tests/m11-standalone-e2e.test.mjs', 14.9],
  ['tests/m2-core-domain.test.mjs', 0.0],
  ['tests/m3-durable-execution.test.mjs', 0.1],
  ['tests/m4-runtime-fabric.test.mjs', 0.1],
  ['tests/m5-runtime-gateway.test.mjs', 0.3],
  ['tests/m6-runtime-adapters.test.mjs', 0.1],
  ['tests/m7-tools-models-sandboxes.test.mjs', 0.1],
  ['tests/m8-multi-agent-orchestration.test.mjs', 0.1],
  ['tests/m9-cloud-certification.test.mjs', 0.0],
  ['tests/m9-production-hardening.test.mjs', 0.0],
  ['tests/pi-byo-model-authority.test.mjs', 11.2],
  ['tests/pi-child-continuation-sqlite.test.mjs', 1.9],
  ['tests/pi-durable-canonical-authority.test.mjs', 0.1],
  ['tests/pi-durable-child-host.test.mjs', 2.0],
  ['tests/pi-durable-child-mapping-recovery.test.mjs', 9.5],
  ['tests/pi-durable-compaction-governed-dispatch.test.mjs', 28.9],
  ['tests/pi-durable-delegation-recovery.test.mjs', 0.4],
  ['tests/pi-durable-execution-model-composition.test.mjs', 0.0],
  ['tests/pi-durable-governed-child-composition.test.mjs', 1.5],
  ['tests/pi-durable-governed-publisher-regression.test.mjs', 0.3],
  ['tests/pi-durable-production-child-bridge-recovery.test.mjs', 2.6],
  ['tests/pi-durable-production-child-composition.test.mjs', 2.3],
  ['tests/pi-durable-workspace-scope.test.mjs', 0.1],
  ['tests/pi-production-factory.test.mjs', 3.5],
  ['tests/pi-production-management-authority.test.mjs', 1.1],
  ['tests/pi-production-management-forwarding.test.mjs', 1.8],
  ['tests/pi-production-runtime-startup.test.mjs', 0.0],
  ['tests/profile-recovery-pi-lead-restart.test.mjs', 5.0],
  ['tests/service-lifecycle-e2e.test.mjs', 0.2],
])

/** The number of shards the E2E lane is split into. */
export const e2eShardCount = 2

/**
 * Splits the E2E files into balanced shards.
 *
 * The split is a greedy longest-processing-time partition over the measured
 * costs above: the heaviest file goes to the emptiest shard, so no shard is
 * dominated by one file and the two shards finish at about the same time.
 * A file without a measured cost fails closed rather than joining a shard
 * blind.
 */
export function selectE2eShard(files, shard, total = e2eShardCount) {
  const shards = Array.from({ length: total }, () => [])
  const loads = Array.from({ length: total }, () => 0)
  const ordered = [...files].toSorted((left, right) => {
    const leftCost = e2eMeasuredSeconds.get(left) ?? 0
    const rightCost = e2eMeasuredSeconds.get(right) ?? 0
    if (leftCost !== rightCost) return rightCost - leftCost
    return left < right ? -1 : left > right ? 1 : 0
  })
  for (const file of ordered) {
    const cost = e2eMeasuredSeconds.get(file)
    if (cost === undefined) {
      throw new Error(`No measured E2E cost for ${file}; the shard split would be blind.`)
    }
    let target = 0
    for (let index = 1; index < total; index += 1) {
      if (loads[index] < loads[target]) target = index
    }
    shards[target].push(file)
    loads[target] += cost
  }
  return { files: shards[shard - 1].toSorted(), loads, shards }
}

/**
 * The files one lane invocation runs.
 *
 * The E2E lane runs as two shards when the runner asks for shards, so the
 * lane's wall clock is the slower shard instead of the sum of every file.
 * Every other lane is unchanged, and an unsharded run keeps every file.
 */
export function selectLaneFiles(group, files, environment = process.env) {
  if (group !== 'e2e') return files
  const total = Number(environment.E2E_TOTAL_SHARDS ?? '1')
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`Unsupported E2E_TOTAL_SHARDS: ${String(environment.E2E_TOTAL_SHARDS)}`)
  }
  if (total === 1) return files
  if (total !== e2eShardCount) {
    throw new Error(`The E2E lane has ${e2eShardCount} shards; the run asked for ${total}.`)
  }
  const index = Number(environment.E2E_SHARD_INDEX ?? '1')
  if (!Number.isInteger(index) || index < 1 || index > total) {
    throw new Error(`Unsupported E2E_SHARD_INDEX: ${String(environment.E2E_SHARD_INDEX)}`)
  }
  return selectE2eShard(files, index, total).files
}

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
    await Promise.all(
      (group === 'integration' ? testRoots : sourceRoots).map((directory) =>
        walk(resolve(repositoryRoot, directory))
      )
    )
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
  const files = selectLaneFiles(group, await discoverTestFiles(group))
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
