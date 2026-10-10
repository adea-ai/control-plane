// Inventory and deterministic shard plan for the database-backed integration lane.
//
// The inventory is every Bun test file under each package's tests/integration
// directory (package suites) and under apps/web/test/integration (route flow),
// as repository-relative paths. A shard runs whole files. Files are placed
// heaviest-first onto the least-loaded shard, weighted by measured request cycles,
// and the route flow is reserved to shard 1 and counted in that shard's load. The
// plan is a pure function of the inventory, the weights, and the shard, so the
// inventory test can check union, disjointness, new files, and empty-shard refusal
// directly. Weights only balance the split; correctness never depends on them.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const ROUTE_FLOW_SHARD = 1

// Cost for a file without a measured entry, so a new file is still placed deterministically.
export const DEFAULT_CYCLE_WEIGHT = 1000

// Measured request cycles per file: client Query and Sync messages through a counting proxy
// against local PostgreSQL, one file per process (2026-10-10). Keys are repository-relative.
// Zero means the file issues no requests through the proxy.
export const INTEGRATION_CYCLE_WEIGHTS = Object.freeze({
  'apps/web/test/integration/account-directory-routes.test.ts': 722,
  'packages/auth/tests/integration/adapter.test.ts': 0,
  'packages/auth/tests/integration/desktop-postgres.test.ts': 17,
  'packages/auth/tests/integration/neon-driver.test.ts': 0,
  'packages/db/tests/integration/account-directory.test.ts': 1424,
  'packages/db/tests/integration/account-summary.test.ts': 729,
  'packages/db/tests/integration/agent-edit-revisions.test.ts': 240,
  'packages/db/tests/integration/agents.test.ts': 178,
  'packages/db/tests/integration/artifact-reference-grants.test.ts': 1173,
  'packages/db/tests/integration/artifact-reference-policy.test.ts': 384,
  'packages/db/tests/integration/artifacts.test.ts': 205,
  'packages/db/tests/integration/content-refs.test.ts': 112,
  'packages/db/tests/integration/content-replicas.test.ts': 140,
  'packages/db/tests/integration/control-plane-identifiers.test.ts': 125,
  'packages/db/tests/integration/conversations.test.ts': 769,
  'packages/db/tests/integration/desktop-auth.test.ts': 14,
  'packages/db/tests/integration/event-audience.test.ts': 830,
  'packages/db/tests/integration/identity.test.ts': 31,
  'packages/db/tests/integration/lead-identity-migration.test.ts': 101,
  'packages/db/tests/integration/lead-topic-migration.test.ts': 28,
  'packages/db/tests/integration/lead-turn-product.test.ts': 651,
  'packages/db/tests/integration/lead-turn-runtime.test.ts': 599,
  'packages/db/tests/integration/lead-turns.test.ts': 1201,
  'packages/db/tests/integration/migration-snapshot-capture.test.ts': 0,
  'packages/db/tests/integration/migrations.test.ts': 26,
  'packages/db/tests/integration/personal-workspaces.test.ts': 650,
  'packages/db/tests/integration/projects.test.ts': 370,
  'packages/db/tests/integration/read-state-counts.test.ts': 944,
  'packages/db/tests/integration/read-state-search.test.ts': 700,
  'packages/db/tests/integration/runtime-node-delivery.test.ts': 1394,
  'packages/db/tests/integration/runtime-nodes.test.ts': 734,
  'packages/db/tests/integration/sharing.test.ts': 581,
  'packages/db/tests/integration/task-submissions.test.ts': 3407,
  'packages/db/tests/integration/tasks.test.ts': 731,
  'packages/db/tests/integration/topic-read-state-search.test.ts': 409,
  'packages/db/tests/integration/workspace-deletion-api.test.ts': 164,
  'packages/db/tests/integration/workspace-deletion.test.ts': 724,
  'packages/db/tests/integration/workspace-events.test.ts': 475,
  'packages/db/tests/integration/workspace-expansion.test.ts': 6,
  'packages/db/tests/integration/workspace-leads.test.ts': 369,
  'packages/db/tests/integration/workspaces.test.ts': 497,
})

// Bun 1.4 discovers test files named *.test.*, *_test.*, *.spec.*, or *_spec.*
// with a js, jsx, ts, tsx, mjs, cjs, mts, or cts extension, and skips helpers
// such as fixtures. Verified against Bun 1.4.0.
const testFilePattern = /[._](?:test|spec)\.[cm]?[jt]sx?$/u

const shardPattern = /^([1-9]\d*)\/([1-9]\d*)$/u

export function isIntegrationTestFile(fileName) {
  return testFilePattern.test(fileName)
}

// Unset or empty runs everything. Otherwise the spec is <index>/<total>, 1-based.
export function parseIntegrationShard(spec) {
  if (!spec) return null
  const match = shardPattern.exec(spec)
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(`ADEA_INTEGRATION_SHARD must look like 1/2 with index <= total, got ${spec}`)
  }
  return { index: Number(match[1]), total: Number(match[2]) }
}

export function cycleWeight(file, weights = INTEGRATION_CYCLE_WEIGHTS) {
  return Object.hasOwn(weights, file) ? weights[file] : DEFAULT_CYCLE_WEIGHT
}

function compareText(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function sortedUnique(files, label) {
  const sorted = [...files].toSorted(compareText)
  if (new Set(sorted).size !== sorted.length) {
    throw new Error(`the ${label} integration inventory lists a file more than once`)
  }
  return sorted
}

// Places files heaviest-first onto the least-loaded shard, ties going to the lower
// index, so the same inputs always produce the same buckets. reservedLoads seeds a
// shard's load before placement. Every shard is built even when only one is asked
// for, so each invocation agrees on the whole assignment.
export function partitionIntegrationFiles(
  files,
  shard,
  { weights = INTEGRATION_CYCLE_WEIGHTS, reservedLoads = [] } = {}
) {
  const { index, total } = shard
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
    throw new Error(`shard ${index}/${total} is outside 1..total`)
  }
  const sorted = sortedUnique(files, 'package')
  if (sorted.length < total) {
    throw new Error(
      `cannot split ${sorted.length} package integration files into ${total} non-empty shards`
    )
  }
  const loads = Array.from({ length: total }, (_, position) => reservedLoads[position] ?? 0)
  const buckets = Array.from({ length: total }, () => [])
  const heaviestFirst = sorted.toSorted(
    (left, right) =>
      cycleWeight(right, weights) - cycleWeight(left, weights) || compareText(left, right)
  )
  for (const file of heaviestFirst) {
    let target = 0
    for (let position = 1; position < total; position += 1) {
      if (loads[position] < loads[target]) target = position
    }
    buckets[target].push(file)
    loads[target] += cycleWeight(file, weights)
  }
  const empty = buckets.findIndex((bucket) => bucket.length === 0)
  if (empty !== -1) {
    throw new Error(`shard ${empty + 1}/${total} would be empty; refusing to build the split`)
  }
  return buckets[index - 1].toSorted(compareText)
}

export function planIntegrationRun(
  { packageFiles, routeFiles },
  shard,
  { weights = INTEGRATION_CYCLE_WEIGHTS } = {}
) {
  if (packageFiles.length === 0) throw new Error('No package integration test files were found')
  if (routeFiles.length === 0) {
    throw new Error(
      'apps/web/test/integration has no route-flow test files; the route-flow lane cannot be silently skipped'
    )
  }
  const sortedRouteFiles = sortedUnique(routeFiles, 'route-flow')
  if (shard === null) {
    return { packageFiles: sortedUnique(packageFiles, 'package'), routeFiles: sortedRouteFiles }
  }
  const routeLoad = sortedRouteFiles.reduce((sum, file) => sum + cycleWeight(file, weights), 0)
  const reservedLoads = []
  reservedLoads[ROUTE_FLOW_SHARD - 1] = routeLoad
  return {
    packageFiles: partitionIntegrationFiles(packageFiles, shard, { weights, reservedLoads }),
    routeFiles: shard.index === ROUTE_FLOW_SHARD ? sortedRouteFiles : [],
  }
}

// Reads directory listings only and returns repository-relative paths. Each package's
// tests/integration directory is included when it exists, and the route-flow directory
// must exist.
export function discoverIntegrationInventory(root) {
  const packagesDirectory = resolve(root, 'packages')
  const packageRoots = readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(packagesDirectory, entry.name, 'tests', 'integration'))
    .filter(isDirectory)
    .toSorted(compareText)
  if (packageRoots.length === 0) {
    throw new Error('No package integration test directories were found')
  }
  const routeFlowRoot = resolve(root, 'apps', 'web', 'test', 'integration')
  if (!isDirectory(routeFlowRoot)) {
    throw new Error(
      'apps/web/test/integration is missing; the route-flow lane cannot be silently skipped'
    )
  }
  return {
    packageFiles: packageRoots.flatMap((directory) => listIntegrationTestFiles(root, directory)),
    routeFiles: listIntegrationTestFiles(root, routeFlowRoot),
  }
}

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory()
}

function listIntegrationTestFiles(root, directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' ? [] : listIntegrationTestFiles(root, path)
      }
      return entry.isFile() && isIntegrationTestFile(entry.name) ? [relative(root, path)] : []
    })
    .toSorted(compareText)
}
