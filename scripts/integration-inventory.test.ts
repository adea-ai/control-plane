import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  cycleWeight,
  discoverIntegrationInventory,
  INTEGRATION_CYCLE_WEIGHTS,
  isIntegrationTestFile,
  parseIntegrationShard,
  partitionIntegrationFiles,
  planIntegrationRun,
} from './integration-inventory.mjs'

const root = resolve(import.meta.dir, '..')

function sorted(files: string[]) {
  return [...files].toSorted()
}

function load(files: string[]) {
  return files.reduce((sum, file) => sum + cycleWeight(file), 0)
}

describe('integration test file discovery', () => {
  test('matches the names Bun 1.4 runs from a directory and skips helpers', () => {
    for (const name of [
      'a.test.ts',
      'b.spec.mjs',
      'c_test.tsx',
      'd_spec.cts',
      'e.test.js',
      'f.test.mts',
    ]) {
      expect(isIntegrationTestFile(name)).toBe(true)
    }
    for (const name of ['helper.ts', 'fixture.mts', 'test.ts', 'spec.ts', 'a.test.json']) {
      expect(isIntegrationTestFile(name)).toBe(false)
    }
  })

  test('discovers the real package and route-flow suites as repository-relative paths', () => {
    const inventory = discoverIntegrationInventory(root)
    expect(inventory.packageFiles.length).toBeGreaterThan(0)
    expect(inventory.routeFiles.length).toBeGreaterThan(0)
    for (const file of inventory.packageFiles) {
      expect(file).toMatch(/^packages\/[^/]+\/tests\/integration\//u)
      expect(isIntegrationTestFile(basename(file))).toBe(true)
    }
    for (const file of inventory.routeFiles) {
      expect(file.startsWith('apps/web/test/integration/')).toBe(true)
      expect(isIntegrationTestFile(basename(file))).toBe(true)
    }
  })

  test('picks up new test files from disk, skipping helpers and non-integration suites', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'adea-integration-inventory-'))
    const write = (path: string) => {
      mkdirSync(dirname(join(fixture, path)), { recursive: true })
      writeFileSync(join(fixture, path), "import { test } from 'bun:test'\n")
    }
    try {
      write('packages/alpha/tests/integration/a.test.ts')
      write('packages/alpha/tests/integration/fixtures.ts')
      write('packages/alpha/tests/integration/nested/b.spec.ts')
      write('packages/beta/tests/integration/c_test.ts')
      write('packages/beta/tests/unit/not-integration.test.ts')
      write('apps/web/test/integration/route.test.ts')
      expect(discoverIntegrationInventory(fixture).packageFiles).toEqual(
        sorted([
          'packages/alpha/tests/integration/a.test.ts',
          'packages/alpha/tests/integration/nested/b.spec.ts',
          'packages/beta/tests/integration/c_test.ts',
        ])
      )

      write('packages/beta/tests/integration/new-suite.test.ts')
      expect(discoverIntegrationInventory(fixture).packageFiles).toContain(
        'packages/beta/tests/integration/new-suite.test.ts'
      )
      expect(discoverIntegrationInventory(fixture).routeFiles).toEqual([
        'apps/web/test/integration/route.test.ts',
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test('fails loudly when the route-flow directory is missing', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'adea-integration-inventory-'))
    try {
      mkdirSync(join(fixture, 'packages/alpha/tests/integration'), { recursive: true })
      writeFileSync(join(fixture, 'packages/alpha/tests/integration/a.test.ts'), '')
      expect(() => discoverIntegrationInventory(fixture)).toThrow(
        'route-flow lane cannot be silently skipped'
      )
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})

describe('integration shard partition', () => {
  test('the real package inventory splits into two shards with no overlap and no omission', () => {
    const { packageFiles } = discoverIntegrationInventory(root)
    const first = partitionIntegrationFiles(packageFiles, { index: 1, total: 2 })
    const second = partitionIntegrationFiles(packageFiles, { index: 2, total: 2 })
    expect(first.filter((file) => second.includes(file))).toEqual([])
    expect(sorted([...first, ...second])).toEqual(sorted(packageFiles))
    expect(first.length).toBeGreaterThan(0)
    expect(second.length).toBeGreaterThan(0)
  })

  test('a new integration file lands in exactly one shard', () => {
    const packageFiles = [
      ...discoverIntegrationInventory(root).packageFiles,
      'packages/new/tests/integration/brand-new.test.ts',
    ]
    const union = [1, 2].flatMap((index) =>
      partitionIntegrationFiles(packageFiles, { index, total: 2 })
    )
    expect(union.filter((file) => file.endsWith('brand-new.test.ts'))).toHaveLength(1)
    expect(sorted(union)).toEqual(sorted(packageFiles))
  })

  test('the split is balanced by measured cycles, route flow included, to within one file', () => {
    const inventory = discoverIntegrationInventory(root)
    const one = planIntegrationRun(inventory, { index: 1, total: 2 })
    const two = planIntegrationRun(inventory, { index: 2, total: 2 })
    const loadOne = load(one.packageFiles) + load(one.routeFiles)
    const loadTwo = load(two.packageFiles) + load(two.routeFiles)
    const heaviest = Math.max(...inventory.packageFiles.map((file) => cycleWeight(file)))
    expect(Math.abs(loadOne - loadTwo)).toBeLessThanOrEqual(heaviest)
  })

  test('every measured weight names a file that still exists in the inventory', () => {
    const inventory = discoverIntegrationInventory(root)
    const known = new Set([...inventory.packageFiles, ...inventory.routeFiles])
    for (const key of Object.keys(INTEGRATION_CYCLE_WEIGHTS)) {
      expect(known.has(key)).toBe(true)
    }
  })

  test('the partition does not depend on inventory order', () => {
    const ordered = ['c.test.ts', 'a.test.ts', 'd.test.ts', 'b.test.ts', 'e.test.ts']
    const shuffled = ['e.test.ts', 'b.test.ts', 'a.test.ts', 'd.test.ts', 'c.test.ts']
    expect(partitionIntegrationFiles(shuffled, { index: 1, total: 2 })).toEqual(
      partitionIntegrationFiles(ordered, { index: 1, total: 2 })
    )
  })

  test('places the heaviest files first and reserved load steers the split', () => {
    const weights = { 'a.test.ts': 5, 'b.test.ts': 3, 'c.test.ts': 3, 'd.test.ts': 2 }
    expect(
      partitionIntegrationFiles(Object.keys(weights), { index: 1, total: 2 }, { weights })
    ).toEqual(['a.test.ts', 'd.test.ts'])
    expect(
      partitionIntegrationFiles(Object.keys(weights), { index: 2, total: 2 }, { weights })
    ).toEqual(['b.test.ts', 'c.test.ts'])
    const unit = { 'a.test.ts': 1, 'b.test.ts': 1, 'c.test.ts': 1, 'd.test.ts': 1 }
    expect(
      partitionIntegrationFiles(
        Object.keys(unit),
        { index: 1, total: 2 },
        {
          weights: unit,
          reservedLoads: [2],
        }
      )
    ).toEqual(['c.test.ts'])
  })

  test('refuses to build an empty shard', () => {
    expect(() => partitionIntegrationFiles(['a.test.ts'], { index: 2, total: 2 })).toThrow(
      'non-empty shards'
    )
    expect(() =>
      partitionIntegrationFiles(['a.test.ts', 'b.test.ts'], { index: 1, total: 3 })
    ).toThrow('non-empty shards')
  })

  test('refuses a split where reserved load leaves a shard with no files', () => {
    const weights = { 'a.test.ts': 1, 'b.test.ts': 1 }
    expect(() =>
      partitionIntegrationFiles(
        Object.keys(weights),
        { index: 2, total: 2 },
        {
          weights,
          reservedLoads: [1_000_000_000],
        }
      )
    ).toThrow('shard 1/2 would be empty')
  })

  test('refuses a duplicated file and an index outside the shard count', () => {
    expect(() =>
      partitionIntegrationFiles(['a.test.ts', 'a.test.ts'], { index: 1, total: 2 })
    ).toThrow('more than once')
    expect(() =>
      partitionIntegrationFiles(['a.test.ts', 'b.test.ts'], { index: 3, total: 2 })
    ).toThrow('outside 1..total')
  })

  test('parses only index <= total shard specs', () => {
    expect(parseIntegrationShard('')).toBeNull()
    expect(parseIntegrationShard(undefined)).toBeNull()
    expect(parseIntegrationShard('1/1')).toEqual({ index: 1, total: 1 })
    expect(parseIntegrationShard('2/2')).toEqual({ index: 2, total: 2 })
    for (const spec of ['3/2', '0/2', '1/0', '1', 'a/b', '1/2/3', ' 1/2']) {
      expect(() => parseIntegrationShard(spec)).toThrow('ADEA_INTEGRATION_SHARD must look like 1/2')
    }
  })
})

describe('integration run plan', () => {
  test('the default run is the complete inventory, route flow included', () => {
    const inventory = discoverIntegrationInventory(root)
    const plan = planIntegrationRun(inventory, null)
    expect(plan.packageFiles).toEqual(sorted(inventory.packageFiles))
    expect(plan.routeFiles).toEqual(sorted(inventory.routeFiles))
    expect(plan.routeFiles.length).toBeGreaterThan(0)
  })

  test('1/1 selects the same files as the unsharded default', () => {
    const inventory = discoverIntegrationInventory(root)
    expect(planIntegrationRun(inventory, { index: 1, total: 1 })).toEqual(
      planIntegrationRun(inventory, null)
    )
  })

  test('the route flow runs on shard 1 only, exactly once across the shards', () => {
    const inventory = discoverIntegrationInventory(root)
    expect(planIntegrationRun(inventory, { index: 1, total: 2 }).routeFiles).toEqual(
      sorted(inventory.routeFiles)
    )
    expect(planIntegrationRun(inventory, { index: 2, total: 2 }).routeFiles).toEqual([])
  })

  test('refuses an inventory with no route-flow or no package files', () => {
    expect(() => planIntegrationRun({ packageFiles: ['a.test.ts'], routeFiles: [] }, null)).toThrow(
      'route-flow lane cannot be silently skipped'
    )
    expect(() => planIntegrationRun({ packageFiles: [], routeFiles: ['r.test.ts'] }, null)).toThrow(
      'No package integration test files were found'
    )
  })
})

describe('integration runner selection', () => {
  const runnerPath = resolve(root, 'scripts/test-integration.mjs')
  const runPlan = (spec: string | undefined) => {
    const environment: Record<string, string | undefined> = { ...process.env }
    delete environment.ADEA_INTEGRATION_SHARD
    if (spec !== undefined) environment.ADEA_INTEGRATION_SHARD = spec
    return Bun.spawnSync([process.execPath, runnerPath, '--plan'], {
      cwd: root,
      env: environment as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }
  const planFrom = (spec: string | undefined) => {
    const result = runPlan(spec)
    expect(result.exitCode).toBe(0)
    return JSON.parse(result.stdout.toString()) as { packageFiles: string[]; routeFiles: string[] }
  }

  test('--plan reports shard selections that union to the default run', () => {
    const full = planFrom(undefined)
    const one = planFrom('1/2')
    const two = planFrom('2/2')
    expect(one.packageFiles.filter((file) => two.packageFiles.includes(file))).toEqual([])
    expect(sorted([...one.packageFiles, ...two.packageFiles])).toEqual(sorted(full.packageFiles))
    expect(one.routeFiles).toEqual(full.routeFiles)
    expect(two.routeFiles).toEqual([])
    expect(full.routeFiles.length).toBeGreaterThan(0)
  })

  test('the runner refuses an invalid shard before any build or database work', () => {
    const result = runPlan('3/2')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('ADEA_INTEGRATION_SHARD must look like 1/2')
  })
})
