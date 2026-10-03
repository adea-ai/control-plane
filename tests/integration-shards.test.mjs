import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'acorn'
import {
  INTEGRATION_SHARDS,
  integrationFileArguments,
  parseIntegrationShard,
  selectIntegrationShard,
} from '../scripts/integration-shards.mjs'

function integrationFilesUnder(directory) {
  return readdirSync(new URL(`../${directory}`, import.meta.url), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === 'integration.test.mjs' || entry.name.endsWith('.integration.test.mjs'))
    )
    .map((entry) => entry.name)
    .toSorted()
}

function foundationCaseInventory(text) {
  const source = parse(text, { ecmaVersion: 'latest', sourceType: 'module' })
  const names = []
  const suites = []
  function visit(node) {
    let callee = node.type === 'CallExpression' ? node.callee : undefined
    while (callee && (callee.type === 'CallExpression' || callee.type === 'MemberExpression')) {
      callee = callee.type === 'CallExpression' ? callee.callee : callee.object
    }
    if (
      node.type === 'CallExpression' &&
      callee?.type === 'Identifier' &&
      callee.name === 'describe' &&
      node.arguments[0]?.type === 'Literal' &&
      typeof node.arguments[0].value === 'string'
    ) {
      suites.push(node.arguments[0].value)
    }
    if (
      node.type === 'CallExpression' &&
      ((node.callee.type === 'Identifier' && node.callee.name === 'test') ||
        (node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'test'))
    ) {
      if (node.callee.type !== 'Identifier') {
        throw new Error('Foundation cases must use plain test declarations')
      }
      if (node.arguments[0]?.type !== 'Literal' || typeof node.arguments[0].value !== 'string') {
        throw new Error('Foundation case names must be string literals')
      }
      names.push(node.arguments[0].value)
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && typeof child.type === 'string') visit(child)
      }
    }
  }
  visit(source)
  return { names, suites }
}

let cachedFoundationNames

function foundationCaseNames() {
  if (cachedFoundationNames) return cachedFoundationNames
  const { names, suites } = foundationCaseInventory(
    readFileSync(new URL('../packages/database/src/integration.test.mjs', import.meta.url), 'utf8')
  )
  expect(suites).toEqual(['PostgreSQL persistence foundation'])
  expect(new Set(names).size).toBe(names.length)
  expect(names).toHaveLength(65)
  // Freeze the reviewed names from 6bc3d941; changed inventory needs rebalancing review.
  expect(createHash('sha256').update(JSON.stringify(names.toSorted())).digest('hex')).toBe(
    'f3136477ef9f1044fa8dd65529df09b4cc7fefd9eae7e2383c38be4536d3fc46'
  )
  cachedFoundationNames = Object.freeze(names)
  return cachedFoundationNames
}

describe('integration shard partition', () => {
  test('inventory parses JavaScript and rejects disabled or dynamic case declarations', () => {
    expect(
      foundationCaseInventory(`
        // test('commented case', () => {})
        describe.skipIf(false)('foundation', () => {
          test('real case', () => { const text = "test('string content')" })
        })
      `)
    ).toEqual({ names: ['real case'], suites: ['foundation'] })
    for (const declaration of ['test.only', 'test.skip', 'test.each([])', "test['skip']"]) {
      expect(() => foundationCaseInventory(`${declaration}('case', () => {})`)).toThrow(
        'Foundation cases must use plain test declarations'
      )
    }
    expect(() => foundationCaseInventory('test(name, () => {})')).toThrow(
      'Foundation case names must be string literals'
    )
    expect(() => foundationCaseInventory('test(')).toThrow()
  })

  test('every integration file has one owner or explicitly partitioned case owners', () => {
    const packages = [
      'packages/database/src',
      'packages/langgraph-adapter/src',
      'packages/profile-portability/src',
      'packages/testing/src',
      'apps/workflow-worker/src',
      'apps/control-api/src',
      'apps/hosted-control-plane/src',
    ]
    const assigned = new Map()
    for (const entry of INTEGRATION_SHARDS) {
      for (const group of entry.groups) {
        for (const file of group.files) {
          const key = `${group.package}/${file}`
          const owners = assigned.get(key) ?? []
          owners.push({ shard: entry.shard, pattern: group.testNamePattern })
          assigned.set(key, owners)
        }
      }
    }
    const discovered = []
    for (const directory of packages) {
      for (const file of integrationFilesUnder(directory)) {
        discovered.push(`${directory}/${file}`)
      }
    }
    expect([...assigned.keys()].toSorted()).toEqual(discovered.toSorted())
    expect(assigned.size).toBeGreaterThan(20)
    for (const [file, owners] of assigned) {
      if (owners.length === 1) {
        expect(owners[0].pattern).toBeUndefined()
      } else {
        expect(file).toBe('packages/database/src/integration.test.mjs')
        expect(owners).toHaveLength(2)
        expect(owners.every((owner) => typeof owner.pattern === 'string')).toBe(true)
      }
    }
  })

  test('every foundation case belongs to one bounded slice across the existing shards', () => {
    const slices = INTEGRATION_SHARDS.flatMap((entry) =>
      entry.groups
        .filter(
          (group) =>
            group.package === 'packages/database' &&
            group.files.includes('src/integration.test.mjs')
        )
        .map((group) => ({ shard: entry.shard, pattern: group.testNamePattern }))
    )
    expect(slices.map((slice) => slice.shard)).toEqual([1, 2])
    const names = foundationCaseNames()
    for (const name of names) {
      expect(slices.filter((slice) => new RegExp(slice.pattern).test(name))).toHaveLength(1)
    }
    for (const [index, slice] of slices.entries()) {
      expect(slice.pattern).toBeDefined()
      const assigned = names.filter((name) => new RegExp(slice.pattern).test(name))
      expect(assigned).toHaveLength([37, 28][index])
      expect(assigned.length).toBeLessThanOrEqual(45)
    }
  })

  test('Bun executes the planned foundation slices without duplicate or missing cases', async () => {
    const names = foundationCaseNames()
    const directory = mkdtempSync(join(tmpdir(), 'cp-shard-selection-'))
    try {
      const file = join(directory, 'selection.test.mjs')
      writeFileSync(
        file,
        `import { describe, test } from 'bun:test'\ndescribe('PostgreSQL persistence foundation', () => {\n${names.map((name) => `test(${JSON.stringify(name)}, () => console.log('CASE:' + ${JSON.stringify(name)}))`).join('\n')}\n})\n`
      )
      const seen = []
      for (const entry of INTEGRATION_SHARDS) {
        for (const group of entry.groups) {
          if (
            group.package !== 'packages/database' ||
            !group.files.includes('src/integration.test.mjs')
          )
            continue
          const child = Bun.spawn(
            [process.execPath, ...integrationFileArguments(group, './selection.test.mjs', '30000')],
            {
              cwd: directory,
              env: { PATH: process.env.PATH },
              stdout: 'pipe',
              stderr: 'pipe',
            }
          )
          const timeout = setTimeout(() => child.kill(), 5000)
          let result
          try {
            result = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ])
          } finally {
            clearTimeout(timeout)
          }
          const [status, stdout, stderr] = result
          if (status !== 0) throw new Error(stderr || `Fixture exited ${status}`)
          expect(status).toBe(0)
          const actual = stdout
            .split('\n')
            .filter((line) => line.startsWith('CASE:'))
            .map((line) => line.slice(5))
          expect(actual.toSorted()).toEqual(
            names.filter((name) => new RegExp(group.testNamePattern).test(name)).toSorted()
          )
          seen.push(...actual)
        }
      }
      expect(seen.toSorted()).toEqual(names.toSorted())
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)

  test('selectIntegrationShard rejects unknown shards and parser accepts run forms', () => {
    expect(() => selectIntegrationShard(99)).toThrow('Unknown integration shard 99')
    expect(selectIntegrationShard(2).length).toBeGreaterThan(0)
    expect(parseIntegrationShard(undefined)).toBeNull()
    expect(parseIntegrationShard('')).toBeNull()
    expect(parseIntegrationShard('2')).toBe(2)
    expect(parseIntegrationShard('3')).toBe(3)
    expect(() => parseIntegrationShard('4')).toThrow('valid shards')
    expect(() => parseIntegrationShard('one')).toThrow('valid shards')
  })
})
