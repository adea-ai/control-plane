import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MalformedSummaryError,
  analyzeRun,
  cacheState,
  compareInventories,
  describeInvalidation,
  evaluateExpectation,
  expectedTasks,
  outputInventory,
  parseSummary,
  repositoryRoot,
  removeOutputs,
} from '../scripts/task-cache-qualification.mjs'

const toolchain = 'qualification-test-toolchain'
const expected = expectedTasks(repositoryRoot, toolchain, 'orch:build')
const packages = [
  'apps/control-api',
  'packages/contracts',
  'packages/domain',
  'packages/events',
  'packages/execution-plan',
  'packages/orchestration',
]

const hit = () => ({ CacheHit: { saved_duration_ms: 12, source: 'Local' } })
const disabled = () => ({ Spawned: { cache_status: 'Disabled', outcome: { Success: {} } } })
const missed = (path, kind = 'ContentModified') => ({
  Spawned: {
    cache_status: { Miss: { InputChanged: { kind, path } } },
    outcome: { Success: {} },
  },
})
const configChanged = () => ({
  Spawned: { cache_status: { Miss: 'ConfigChanged' }, outcome: { Success: {} } },
})
const notFound = () => ({
  Spawned: { cache_status: { Miss: 'NotFound' }, outcome: { Success: {} } },
})

/** A run summary in which every cached task was served from the cache. */
function summaryWith(overrides = {}, { exitCode = 0 } = {}) {
  const tasks = []
  for (const task of expected.tasks.values()) {
    tasks.push({
      package_name: '@control-plane/workspace',
      task_name: task.name,
      command: task.command,
      result: task.cached ? hit() : disabled(),
    })
  }
  for (const [name, result] of Object.entries(overrides)) {
    const entry = tasks.find((task) => task.task_name === name)
    if (!entry) throw new Error(`the graph has no task "${name}"`)
    entry.result = result
  }
  return { exit_code: exitCode, tasks }
}

const analyze = (summary) =>
  analyzeRun({ summary: parseSummary(JSON.stringify(summary)), expected, packages })

describe('the summary parser fails closed on malformed input', () => {
  const malformed = [
    ['truncated JSON', '{"tasks": ['],
    ['a JSON array', '[]'],
    ['a JSON string', '"summary"'],
    ['a missing tasks array', '{"exit_code": 0}'],
    ['a missing exit code', '{"tasks": []}'],
    ['a non-numeric exit code', '{"exit_code": "0", "tasks": []}'],
    [
      'a task without a name',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "", "command": "c", "result": {"CacheHit": {}}}]}',
    ],
    [
      'a task without a command',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "t", "command": "", "result": {"CacheHit": {}}}]}',
    ],
    [
      'a task without a result',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "t", "command": "c"}]}',
    ],
    [
      'an unknown result kind',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "t", "command": "c", "result": {"Exploded": {}}}]}',
    ],
    [
      'two result kinds',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "t", "command": "c", "result": {"CacheHit": {}, "Spawned": {}}}]}',
    ],
    [
      'an unknown cache status',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "t", "command": "c", "result": {"Spawned": {"cache_status": "Weird"}}}]}',
    ],
    [
      'an unknown cache miss',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "t", "command": "c", "result": {"Spawned": {"cache_status": {"Miss": {"Unknown": {}}}}}}]}',
    ],
    [
      'an unknown cache miss name',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "t", "command": "c", "result": {"Spawned": {"cache_status": {"Miss": "Weird"}}}}]}',
    ],
    [
      'a cache miss name that differs from ConfigChanged only in case',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "t", "command": "c", "result": {"Spawned": {"cache_status": {"Miss": "configchanged"}}}}]}',
    ],
    [
      'a ConfigChanged miss carrying a payload',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "t", "command": "c", "result": {"Spawned": {"cache_status": {"Miss": {"ConfigChanged": {}}}}}}]}',
    ],
    [
      'an input change without a path',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "t", "command": "c", "result": {"Spawned": {"cache_status": {"Miss": {"InputChanged": {"kind": "ContentModified"}}}}}}]}',
    ],
    [
      'a task reported twice',
      '{"exit_code": 0, "tasks": [{"package_name": "p", "task_name": "t", "command": "c", "result": {"CacheHit": {}}}, {"package_name": "p", "task_name": "t", "command": "c", "result": {"CacheHit": {}}}]}',
    ],
  ]
  for (const [name, text] of malformed) {
    test(`rejects ${name}`, () => {
      expect(() => parseSummary(text)).toThrow(MalformedSummaryError)
    })
  }
})

describe('the summary parser accepts what the task runner writes', () => {
  test('reads hits, disabled tasks, misses and failures', () => {
    const summary = parseSummary(
      JSON.stringify({
        exit_code: 1,
        tasks: [
          {
            package_name: '@control-plane/workspace',
            task_name: 'orch:contracts:build',
            command: 'bun run --cwd packages/contracts build',
            result: { CacheHit: { saved_duration_ms: 91, source: 'Local' } },
          },
          {
            package_name: '@control-plane/workspace',
            task_name: 'orch:toolchain',
            command: 'node scripts/orch-toolchain.mjs --expect abc',
            result: { Spawned: { cache_status: 'Disabled', outcome: { Success: {} } } },
          },
          {
            package_name: '@control-plane/workspace',
            task_name: 'orch:domain:build',
            command: 'bun run --cwd packages/domain build',
            result: {
              Spawned: {
                cache_status: {
                  Miss: { InputChanged: { kind: 'ContentModified', path: 'package.json' } },
                },
                outcome: { Success: {} },
              },
            },
          },
          {
            package_name: '@control-plane/workspace',
            task_name: 'orch:events:build',
            command: 'bun run --cwd packages/events build',
            result: {
              Spawned: {
                cache_status: { Miss: 'NotFound' },
                outcome: { Failure: { message: 'boom' } },
              },
            },
          },
        ],
      })
    )
    expect(summary.exitCode).toBe(1)
    expect(summary.tasks.map((task) => task.kind)).toEqual(['hit', 'disabled', 'miss', 'miss'])
    expect(summary.tasks[0].savedMs).toBe(91)
    expect(summary.tasks[2].invalidation).toEqual({
      reason: 'input-changed',
      path: 'package.json',
      inputKind: 'ContentModified',
    })
    expect(summary.tasks[3].invalidation.reason).toBe('not-found')
    expect(summary.tasks[3].failed).toBe(true)
  })
})

describe('a ConfigChanged miss is a reason the runner writes, not an unknown one', () => {
  const entry = (miss) =>
    JSON.stringify({
      exit_code: 0,
      tasks: [
        {
          package_name: '@control-plane/workspace',
          task_name: 'orch:build',
          command: 'bun run build',
          result: { Spawned: { cache_status: { Miss: miss }, outcome: { Success: {} } } },
        },
      ],
    })

  test('parses the bare-string form as its own reason', () => {
    const summary = parseSummary(entry('ConfigChanged'))
    expect(summary.tasks[0].kind).toBe('miss')
    expect(summary.tasks[0].invalidation).toEqual({
      reason: 'config-changed',
      path: null,
      inputKind: null,
    })
  })

  test('still rejects a miss name the runner does not write', () => {
    expect(() => parseSummary(entry('Exploded'))).toThrow(/unknown cache miss "Exploded"/)
  })

  test('is a miss with its own cause, neither cold nor a changed input', () => {
    const analysis = analyze(summaryWith({ 'orch:contracts:build': configChanged() }))
    const invalidation = analysis.invalidations.find((item) => item.task === 'orch:contracts:build')
    expect(invalidation).toEqual({
      task: 'orch:contracts:build',
      kind: 'input-config',
      path: null,
      package: null,
    })
    expect(describeInvalidation(analysis, 'orch:contracts:build')).toBe(
      "the task's declared input configuration changed"
    )
  })

  test('does not satisfy a hits, source or invalidated expectation', () => {
    const analysis = analyze(summaryWith({ 'orch:contracts:build': configChanged() }))
    const hits = evaluateExpectation(analysis, 'hits')
    expect(hits.ok).toBe(false)
    expect(hits.failures.join('\n')).toContain('declared input configuration changed')
    expect(evaluateExpectation(analysis, 'invalidated:source=orch:contracts:build').ok).toBe(false)
    expect(evaluateExpectation(analysis, 'invalidated:config=orch:contracts:build').ok).toBe(false)
    const overrides = {}
    for (const task of expected.tasks.values()) {
      if (task.cached) overrides[task.name] = configChanged()
    }
    expect(evaluateExpectation(analyze(summaryWith(overrides)), 'invalidated').ok).toBe(false)
    expect(evaluateExpectation(analyze(summaryWith(overrides)), 'misses').ok).toBe(true)
  })
})

describe('a SpawnFingerprintChanged miss accepts only the changes the runner writes', () => {
  const entry = (changes) =>
    JSON.stringify({
      exit_code: 0,
      tasks: [
        {
          package_name: '@control-plane/workspace',
          task_name: 'orch:build',
          command: 'bun run build',
          result: {
            Spawned: {
              cache_status: { Miss: { SpawnFingerprintChanged: changes } },
              outcome: { Success: {} },
            },
          },
        },
      ],
    })
  const changesOf = (changes) => parseSummary(entry(changes)).tasks[0].invalidation

  // Each form below was captured from vite-plus 1.3.0 by changing the one
  // thing it names in a task between two runs.
  const accepted = [
    ['a changed program', ['ProgramChanged'], ['ProgramChanged']],
    ['changed arguments', ['ArgsChanged'], ['ArgsChanged']],
    ['a changed working directory', ['CwdChanged'], ['CwdChanged']],
    [
      'a program, arguments and working directory changed together',
      ['ProgramChanged', 'ArgsChanged', 'CwdChanged'],
      ['ProgramChanged', 'ArgsChanged', 'CwdChanged'],
    ],
    [
      'a tracked variable that gained a value',
      [{ Env: { Added: { name: 'FOO' } } }],
      ['EnvAdded:FOO'],
    ],
    [
      'a tracked variable that was dropped',
      [{ Env: { Removed: { name: 'FOO' } } }],
      ['EnvRemoved:FOO'],
    ],
    [
      'a tracked variable whose value changed',
      [{ Env: { Changed: { name: 'FOO' } } }],
      ['EnvChanged:FOO'],
    ],
    [
      'a passed-through variable that was added',
      [{ UntrackedEnvAdded: { name: 'BAR' } }],
      ['UntrackedEnvAdded:BAR'],
    ],
    [
      'a passed-through variable that was removed',
      [{ UntrackedEnvRemoved: { name: 'BAR' } }],
      ['UntrackedEnvRemoved:BAR'],
    ],
  ]
  for (const [name, written, labels] of accepted) {
    test(`reads ${name}`, () => {
      expect(changesOf(written)).toEqual({
        reason: 'spawn-fingerprint-changed',
        path: null,
        inputKind: null,
        changes: labels,
      })
    })
  }

  const rejected = [
    ['an empty change list', []],
    ['a change list that is not a list', 'ArgsChanged'],
    ['an unknown bare change', ['Exploded']],
    ['a bare change in the wrong case', ['argschanged']],
    ['an unknown keyed change', [{ Exploded: { name: 'FOO' } }]],
    [
      'a keyed change with two keys',
      [{ Env: { Added: { name: 'FOO' } }, UntrackedEnvAdded: { name: 'BAR' } }],
    ],
    ['an unknown environment change', [{ Env: { Exploded: { name: 'FOO' } } }]],
    [
      'an environment change with two variants',
      [{ Env: { Added: { name: 'A' }, Removed: { name: 'B' } } }],
    ],
    ['an environment change without a name', [{ Env: { Added: {} } }]],
    ['an environment change with an empty name', [{ Env: { Added: { name: '' } } }]],
    ['a passed-through change without a name', [{ UntrackedEnvAdded: {} }]],
    ['a change that is a number', [7]],
  ]
  for (const [name, written] of rejected) {
    test(`rejects ${name}`, () => {
      expect(() => parseSummary(entry(written))).toThrow(MalformedSummaryError)
    })
  }

  test('is a miss of its own kind that names what changed', () => {
    const analysis = analyze(
      summaryWith({
        'orch:contracts:build': {
          Spawned: {
            cache_status: {
              Miss: {
                SpawnFingerprintChanged: ['ArgsChanged', { Env: { Added: { name: 'FOO' } } }],
              },
            },
            outcome: { Success: {} },
          },
        },
      })
    )
    expect(analysis.invalidations.find((item) => item.task === 'orch:contracts:build')).toEqual({
      task: 'orch:contracts:build',
      kind: 'spawn-fingerprint',
      path: null,
      package: null,
      changes: ['ArgsChanged', 'EnvAdded:FOO'],
    })
    expect(describeInvalidation(analysis, 'orch:contracts:build')).toBe(
      "the task's spawn fingerprint changed (ArgsChanged, EnvAdded:FOO)"
    )
  })

  test('does not satisfy a hits, source or invalidated expectation', () => {
    const miss = {
      Spawned: {
        cache_status: { Miss: { SpawnFingerprintChanged: ['CwdChanged'] } },
        outcome: { Success: {} },
      },
    }
    const analysis = analyze(summaryWith({ 'orch:contracts:build': miss }))
    expect(evaluateExpectation(analysis, 'hits').ok).toBe(false)
    expect(evaluateExpectation(analysis, 'invalidated:source=orch:contracts:build').ok).toBe(false)
    const overrides = {}
    for (const task of expected.tasks.values()) {
      if (task.cached) overrides[task.name] = miss
    }
    const everything = analyze(summaryWith(overrides))
    expect(evaluateExpectation(everything, 'invalidated').ok).toBe(false)
    expect(evaluateExpectation(everything, 'misses').ok).toBe(true)
  })
})

describe('the expected task set comes from the build graph', () => {
  test('no task count is hardcoded', () => {
    const cached = [...expected.tasks.values()].filter((task) => task.cached)
    expect(cached.length).toBeGreaterThan(0)
    expect(expected.tasks.get('orch:toolchain').cached).toBe(false)
    expect(expected.tasks.get('orch:build').cached).toBe(false)
    for (const task of expected.tasks.values()) {
      expect(expected.tasks.has(task.name)).toBe(true)
      if (task.name === 'orch:build' || task.name === 'orch:toolchain') continue
      expect(task.command).toContain(toolchain)
    }
  })

  test('the expected outputs are the outputs the graph declares', () => {
    const outputs = new Set()
    for (const task of expected.tasks.values()) for (const glob of task.outputs) outputs.add(glob)
    expect(outputs.size).toBeGreaterThan(0)
    for (const glob of outputs) expect(glob).toMatch(/dist\/\*\*$/)
  })

  test('a scoped run covers the scoped task and its dependencies only', () => {
    const scoped = expectedTasks(repositoryRoot, toolchain, 'orch:contracts:build')
    expect([...scoped.tasks.keys()].toSorted()).toEqual(['orch:contracts:build', 'orch:toolchain'])
  })
})

describe('a run is compared with the graph, not with a log line', () => {
  test('every cached task served from the cache satisfies the hits expectation', () => {
    const analysis = analyze(summaryWith())
    const expectation = evaluateExpectation(analysis, 'hits')
    expect(expectation.ok).toBe(true)
    expect(expectation.failures).toEqual([])
    expect(analysis.hits.length).toBe(analysis.cached.length)
  })

  test('a task that ran is reported instead of passing', () => {
    const analysis = analyze(summaryWith({ 'orch:contracts:build': notFound() }))
    const expectation = evaluateExpectation(analysis, 'hits')
    expect(expectation.ok).toBe(false)
    expect(expectation.failures.join(' ')).toContain('orch:contracts:build')
  })

  test('a task the graph does not declare fails the qualification', () => {
    const summary = summaryWith()
    summary.tasks.push({
      package_name: '@control-plane/workspace',
      task_name: 'orch:not-in-the-graph:build',
      command: 'bun run --cwd packages/nothing build',
      result: hit(),
    })
    const analysis = analyze(summary)
    const expectation = evaluateExpectation(analysis, 'hits')
    expect(expectation.ok).toBe(false)
    expect(expectation.failures.join(' ')).toContain('orch:not-in-the-graph:build')
  })

  test('a task the run did not execute fails the qualification', () => {
    const summary = summaryWith()
    summary.tasks = summary.tasks.filter((task) => task.task_name !== 'orch:contracts:build')
    const analysis = analyze(summary)
    const expectation = evaluateExpectation(analysis, 'hits')
    expect(expectation.ok).toBe(false)
    expect(expectation.failures.join(' ')).toContain('orch:contracts:build')
  })

  test('a run that failed fails the qualification', () => {
    const analysis = analyze(summaryWith({}, { exitCode: 1 }))
    expect(evaluateExpectation(analysis, 'hits').ok).toBe(false)
  })
})

describe('the invalidation fixtures', () => {
  test('a changed source invalidates only the task that owns it', () => {
    const analysis = analyze(
      summaryWith({ 'orch:contracts:build': missed('packages/contracts/src/index.ts') })
    )
    const invalidation = analysis.invalidations.find(
      (entry) => entry.task === 'orch:contracts:build'
    )
    expect(invalidation.kind).toBe('source')
    expect(invalidation.package).toBe('packages/contracts')
    expect(invalidation.path).toBe('packages/contracts/src/index.ts')
    expect(evaluateExpectation(analysis, 'invalidated:source=orch:contracts:build').ok).toBe(true)
    expect(evaluateExpectation(analysis, 'hits').ok).toBe(false)
    expect(evaluateExpectation(analysis, 'invalidated:config=orch:contracts:build').ok).toBe(false)
  })

  test('a changed configuration input invalidates every task', () => {
    const overrides = {}
    for (const task of expected.tasks.values()) {
      if (task.cached) overrides[task.name] = missed('package.json')
    }
    const analysis = analyze(summaryWith(overrides))
    expect(analysis.invalidations).toHaveLength(analysis.cached.length)
    for (const invalidation of analysis.invalidations) {
      expect(invalidation.kind).toBe('config')
      expect(invalidation.package).toBe(null)
      expect(invalidation.path).toBe('package.json')
    }
    expect(evaluateExpectation(analysis, 'invalidated').ok).toBe(true)
    expect(evaluateExpectation(analysis, 'misses').ok).toBe(true)
    expect(evaluateExpectation(analysis, 'hits').ok).toBe(false)
  })

  test('a different toolchain is a toolchain invalidation, not a cache hit', () => {
    const summary = summaryWith()
    const entry = summary.tasks.find((task) => task.task_name === 'orch:contracts:build')
    entry.command = entry.command.replace(toolchain, 'another-toolchain')
    const analysis = analyze(summary)
    expect(analysis.commandMismatches).toHaveLength(1)
    expect(analysis.commandMismatches[0].kind).toBe('toolchain')
    expect(analysis.commandMismatches[0].expected).toContain(toolchain)
    expect(analysis.commandMismatches[0].observed).toContain('another-toolchain')
    expect(evaluateExpectation(analysis, 'invalidated:toolchain=orch:contracts:build').ok).toBe(
      true
    )
    expect(evaluateExpectation(analysis, 'hits').ok).toBe(false)
  })

  test('a toolchain change invalidates every task it touched', () => {
    const summary = summaryWith()
    for (const task of summary.tasks) {
      task.command = task.command.replace(toolchain, 'another-toolchain')
    }
    const analysis = analyze(summary)
    expect(analysis.commandMismatches).toHaveLength(expected.tasks.size - 1)
    for (const mismatch of analysis.commandMismatches) {
      expect(mismatch.kind).toBe('toolchain')
      expect(mismatch.task).not.toBe('orch:build')
    }
    expect(evaluateExpectation(analysis, 'invalidated:toolchain=orch:contracts:build').ok).toBe(
      false
    )
    expect(evaluateExpectation(analysis, 'hits').ok).toBe(false)
  })

  test('a clean run misses every cached task and says why', () => {
    const overrides = {}
    for (const task of expected.tasks.values()) {
      if (task.cached) overrides[task.name] = notFound()
    }
    const analysis = analyze(summaryWith(overrides))
    expect(evaluateExpectation(analysis, 'misses').ok).toBe(true)
    expect(evaluateExpectation(analysis, 'hits').ok).toBe(false)
    for (const invalidation of analysis.invalidations) expect(invalidation.kind).toBe('cold')
  })
})

describe('the output inventory is the real output, not a log line', () => {
  const withRoot = (body) => {
    const root = mkdtempSync(join(tmpdir(), 'task-cache-qualification-'))
    try {
      return body(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  const build = (root, contents) => {
    mkdirSync(join(root, 'packages', 'demo', 'dist'), { recursive: true })
    writeFileSync(join(root, 'packages', 'demo', 'package.json'), '{"name":"demo"}\n')
    for (const [name, text] of Object.entries(contents)) {
      writeFileSync(join(root, 'packages', 'demo', 'dist', name), text)
    }
  }

  test('the same outputs inventory identically', () => {
    withRoot((root) => {
      build(root, { 'a.js': 'export const a = 1\n', 'b.js': 'export const b = 2\n' })
      const first = outputInventory(root, ['packages/demo/dist/**'])
      const second = outputInventory(root, ['packages/demo/dist/**'])
      expect(first).toEqual(second)
      expect(first.files.map((file) => file.path)).toEqual([
        'packages/demo/dist/a.js',
        'packages/demo/dist/b.js',
      ])
    })
  })

  test('a changed output changes the inventory', () => {
    withRoot((root) => {
      build(root, { 'a.js': 'export const a = 1\n' })
      const before = outputInventory(root, ['packages/demo/dist/**'])
      writeFileSync(join(root, 'packages', 'demo', 'dist', 'a.js'), 'export const a = 2\n')
      const after = outputInventory(root, ['packages/demo/dist/**'])
      const difference = compareInventories(before, after)
      expect(difference.equal).toBe(false)
      expect(difference.changed.map((entry) => entry.path)).toEqual(['packages/demo/dist/a.js'])
      expect(difference.added).toEqual([])
      expect(difference.removed).toEqual([])
    })
  })

  test('added and removed outputs are reported', () => {
    withRoot((root) => {
      build(root, { 'a.js': 'export const a = 1\n' })
      const before = outputInventory(root, ['packages/demo/dist/**'])
      writeFileSync(join(root, 'packages', 'demo', 'dist', 'b.js'), 'export const b = 2\n')
      const after = outputInventory(root, ['packages/demo/dist/**'])
      const difference = compareInventories(before, after)
      expect(difference.added).toEqual(['packages/demo/dist/b.js'])
      expect(difference.removed).toEqual([])
    })
  })
})

describe('the cache state is read from the disk', () => {
  test('counts the entries the cache holds', () => {
    const root = mkdtempSync(join(tmpdir(), 'task-cache-qualification-'))
    try {
      const directory = join(root, 'node_modules', '.vite', 'task-cache', 'v18')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'one.tar.zst'), 'entry')
      writeFileSync(join(directory, 'two.tar.zst'), 'entry')
      writeFileSync(join(directory, 'last-summary.json'), '{}')
      const state = cacheState(root)
      expect(state.count).toBe(2)
      expect(state.versions).toEqual(['v18'])
      expect(state.entries.map((entry) => entry.name)).toEqual([
        'v18/one.tar.zst',
        'v18/two.tar.zst',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a missing cache holds no entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'task-cache-qualification-'))
    try {
      expect(cacheState(root).count).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/** Runs the qualification command line the way the lane runs it. */
const runCli = (args) =>
  spawnSync(
    process.execPath,
    [join(repositoryRoot, 'scripts', 'task-cache-qualification.mjs'), ...args],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )

const digestOf = (text) => createHash('sha256').update(text).digest('hex')

/** An inventory of build outputs, with the digests the qualification records. */
const inventoryFixture = (files, roots = ['packages/demo/dist']) => ({
  files: files.map(([path, text]) => ({
    path,
    bytes: Buffer.byteLength(text),
    sha256: digestOf(text),
  })),
  roots,
})

const withDirectory = (body) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-cache-qualification-'))
  try {
    return body(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('the command line fails when two inventories differ', () => {
  const baseline = inventoryFixture([
    ['packages/demo/dist/a.js', 'export const a = 1\n'],
    ['packages/demo/dist/b.js', 'export const b = 2\n'],
  ])

  const compareWith = (other) =>
    withDirectory((directory) => {
      const left = join(directory, 'left.json')
      const right = join(directory, 'right.json')
      writeFileSync(left, JSON.stringify(baseline))
      writeFileSync(right, JSON.stringify(other))
      return runCli(['compare', left, right])
    })

  test('identical inventories pass', () => {
    const result = compareWith(baseline)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).equal).toBe(true)
    expect(JSON.parse(result.stdout).ok).toBe(true)
  })

  test('a changed output fails', () => {
    const changed = inventoryFixture([
      ['packages/demo/dist/a.js', 'export const a = 2\n'],
      ['packages/demo/dist/b.js', 'export const b = 2\n'],
    ])
    const result = compareWith(changed)
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout)
    expect(report.equal).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.changed.map((entry) => entry.path)).toEqual(['packages/demo/dist/a.js'])
    expect(result.stderr).toContain('the outputs differ')
  })

  test('a missing output fails', () => {
    const missing = inventoryFixture([['packages/demo/dist/a.js', 'export const a = 1\n']])
    const result = compareWith(missing)
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout)
    expect(report.equal).toBe(false)
    expect(report.removed).toEqual(['packages/demo/dist/b.js'])
  })

  test('an extra output fails', () => {
    const extra = inventoryFixture([
      ['packages/demo/dist/a.js', 'export const a = 1\n'],
      ['packages/demo/dist/b.js', 'export const b = 2\n'],
      ['packages/demo/dist/c.js', 'export const c = 3\n'],
    ])
    const result = compareWith(extra)
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout)
    expect(report.equal).toBe(false)
    expect(report.added).toEqual(['packages/demo/dist/c.js'])
  })

  test('an inventory that covers no declared output fails', () => {
    const result = compareWith(inventoryFixture([], []))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('proves nothing')
  })
})

describe('the restored outputs must be complete and current', () => {
  const baseline = inventoryFixture([
    ['packages/demo/dist/a.js', 'export const a = 1\n'],
    ['packages/demo/dist/b.js', 'export const b = 2\n'],
  ])

  const compareWith = (restored) =>
    withDirectory((directory) => {
      const left = join(directory, 'baseline.json')
      const right = join(directory, 'restored.json')
      writeFileSync(left, JSON.stringify(baseline))
      writeFileSync(right, JSON.stringify(restored))
      return runCli(['compare', left, right])
    })

  test('a restored output that is missing fails', () => {
    const result = compareWith(
      inventoryFixture([['packages/demo/dist/a.js', 'export const a = 1\n']])
    )
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).removed).toEqual(['packages/demo/dist/b.js'])
  })

  test('a restored output that is truncated fails', () => {
    const result = compareWith(
      inventoryFixture([
        ['packages/demo/dist/a.js', 'export const a = 1\n'],
        ['packages/demo/dist/b.js', 'export const b ='],
      ])
    )
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).changed.map((entry) => entry.path)).toEqual([
      'packages/demo/dist/b.js',
    ])
  })

  test('a restored output that is stale fails', () => {
    const result = compareWith(
      inventoryFixture([
        ['packages/demo/dist/a.js', 'export const a = 1\n'],
        ['packages/demo/dist/b.js', 'export const b = 3\n'],
      ])
    )
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).changed.map((entry) => entry.path)).toEqual([
      'packages/demo/dist/b.js',
    ])
  })

  test('a restored output set that lost an output root fails', () => {
    const widened = inventoryFixture(
      [
        ['packages/demo/dist/a.js', 'export const a = 1\n'],
        ['packages/demo/dist/b.js', 'export const b = 2\n'],
      ],
      ['packages/demo/dist', 'packages/other/dist']
    )
    const result = withDirectory((directory) => {
      const left = join(directory, 'baseline.json')
      const right = join(directory, 'restored.json')
      writeFileSync(left, JSON.stringify(widened))
      writeFileSync(right, JSON.stringify(baseline))
      return runCli(['compare', left, right])
    })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).roots.removed).toEqual(['packages/other/dist'])
  })
})

describe('the command line fails when the run itself is wrong', () => {
  const summaryFor = (summary) =>
    withDirectory((directory) => {
      const file = join(directory, 'last-summary.json')
      writeFileSync(file, JSON.stringify(summary))
      return runCli(['summary', '--summary', file, '--toolchain', toolchain])
    })

  test('a run that executed every task passes without a cache pattern', () => {
    const result = summaryFor(summaryWith())
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.ok).toBe(true)
    expect(report.expectation).toBe(null)
  })

  test('a missing task fails without a cache pattern', () => {
    const summary = summaryWith()
    summary.tasks = summary.tasks.filter((task) => task.task_name !== 'orch:contracts:build')
    const result = summaryFor(summary)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('orch:contracts:build')
    expect(result.stderr).toContain('did not execute')
  })

  test('an unexpected task fails without a cache pattern', () => {
    const summary = summaryWith()
    summary.tasks.push({
      package_name: '@control-plane/workspace',
      task_name: 'orch:not-in-the-graph:build',
      command: 'bun run --cwd packages/nothing build',
      result: hit(),
    })
    const result = summaryFor(summary)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('outside the graph')
  })

  test('a command the graph does not declare fails without a cache pattern', () => {
    const summary = summaryWith()
    const entry = summary.tasks.find((task) => task.task_name === 'orch:contracts:build')
    entry.command = 'bun run --cwd packages/contracts build --other'
    const result = summaryFor(summary)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('but the graph expects')
  })

  test('a failed task fails without a cache pattern', () => {
    const summary = summaryWith()
    const entry = summary.tasks.find((task) => task.task_name === 'orch:contracts:build')
    entry.result = {
      Spawned: {
        cache_status: { Miss: 'NotFound' },
        outcome: { Failure: { message: 'the build failed' } },
      },
    }
    const result = summaryFor(summary)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('the run failed')
  })

  test('a non-zero exit status fails without a cache pattern', () => {
    const result = summaryFor(summaryWith({}, { exitCode: 1 }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('exited with status 1')
  })
})

describe('only the declared outputs are cleaned', () => {
  test('the cleaning removes the declared outputs and nothing else', () => {
    withDirectory((root) => {
      mkdirSync(join(root, 'packages', 'demo', 'dist', 'nested'), { recursive: true })
      mkdirSync(join(root, 'packages', 'demo', 'src'), { recursive: true })
      writeFileSync(join(root, 'packages', 'demo', 'package.json'), '{"name":"demo"}\n')
      writeFileSync(join(root, 'packages', 'demo', 'dist', 'a.js'), 'export const a = 1\n')
      writeFileSync(
        join(root, 'packages', 'demo', 'dist', 'nested', 'b.js'),
        'export const b = 2\n'
      )
      writeFileSync(join(root, 'packages', 'demo', 'src', 'index.ts'), 'export const a = 1\n')
      const removed = removeOutputs(root, ['packages/demo/dist/**'])
      expect(removed).toEqual(['packages/demo/dist/a.js', 'packages/demo/dist/nested/b.js'])
      expect(existsSync(join(root, 'packages', 'demo', 'src', 'index.ts'))).toBe(true)
      expect(existsSync(join(root, 'packages', 'demo', 'package.json'))).toBe(true)
      expect(existsSync(join(root, 'packages', 'demo', 'dist', 'a.js'))).toBe(false)
    })
  })
})
