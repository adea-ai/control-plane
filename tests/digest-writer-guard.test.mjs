import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectDigestWriterFlows,
  findDigestWriterFlows,
  matchesDigestWriterException,
  selectRelevantSources,
} from '../scripts/check-digest-writers.mjs'

function flows(files) {
  return findDigestWriterFlows(files)
}

test('rejects a scan root with no production source files', async () => {
  const emptyRoot = await mkdtemp(join(tmpdir(), 'digest-writer-guard-empty-'))
  try {
    await mkdir(join(emptyRoot, 'apps'))
    await mkdir(join(emptyRoot, 'packages'))
    await assert.rejects(
      collectDigestWriterFlows(emptyRoot),
      /no production source files found under apps\/ or packages\//
    )
  } finally {
    await rm(emptyRoot, { recursive: true, force: true })
  }
})

test('rejects missing, empty, and non-directory scan roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'digest-writer-guard-invalid-root-'))
  const fileRoot = join(root, 'not-a-directory')
  try {
    await writeFile(fileRoot, 'not a directory')
    await assert.rejects(collectDigestWriterFlows(''), /scan root must be a non-empty path/)
    await assert.rejects(collectDigestWriterFlows(' \t'), /scan root must be a non-empty path/)
    await assert.rejects(collectDigestWriterFlows(null), /scan root must be a non-empty path/)
    await assert.rejects(
      collectDigestWriterFlows(join(root, 'missing')),
      /could not inspect digest writer scan root/
    )
    await assert.rejects(
      collectDigestWriterFlows(fileRoot),
      /digest writer scan root must be a directory/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows the optional scripts scan root to be absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'digest-writer-guard-optional-scripts-'))
  try {
    await mkdir(join(root, 'apps'))
    await mkdir(join(root, 'packages'))
    await writeFile(join(root, 'apps', 'app.ts'), 'export const app = true')
    await writeFile(join(root, 'packages', 'package.ts'), 'export const pkg = true')

    const results = await collectDigestWriterFlows(root)

    assert.equal(results.length, 0)
    assert.equal(results.scanStats.sourceFiles, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a present scripts scan root that is not a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'digest-writer-guard-invalid-scripts-root-'))
  try {
    await mkdir(join(root, 'apps'))
    await mkdir(join(root, 'packages'))
    await writeFile(join(root, 'apps', 'app.ts'), 'export const app = true')
    await writeFile(join(root, 'packages', 'package.ts'), 'export const pkg = true')
    await writeFile(join(root, 'scripts'), 'unexpected file')

    await assert.rejects(
      collectDigestWriterFlows(root),
      /digest writer scan root must be a directory/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('requires both production scan roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'digest-writer-guard-missing-production-root-'))
  try {
    await mkdir(join(root, 'packages'))
    await writeFile(join(root, 'packages', 'package.ts'), 'export const pkg = true')

    await assert.rejects(collectDigestWriterFlows(root), /required scan root .*apps/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('does not silently ignore EACCES or EIO from an existing subtree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'digest-writer-guard-subtree-errors-'))
  const blocked = join(root, 'packages', 'blocked')
  try {
    await mkdir(blocked, { recursive: true })
    await mkdir(join(root, 'apps'))
    await writeFile(join(root, 'apps', 'app.ts'), 'export const app = true')
    await writeFile(join(root, 'packages', 'package.ts'), 'export const pkg = true')

    for (const code of ['EACCES', 'EIO']) {
      const io = {
        readdir: async (path, options) => {
          if (path === blocked) {
            throw Object.assign(new Error(`injected ${code}`), { code })
          }
          return readdir(path, options)
        },
        readFile,
        stat,
      }

      await assert.rejects(collectDigestWriterFlows(root, io), (error) => {
        assert.ok(error.message.includes(blocked))
        assert.equal(error.cause?.code, code)
        return true
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed on unreadable roots and traversal errors without chmod', async () => {
  const root = await mkdtemp(join(tmpdir(), 'digest-writer-guard-traversal-errors-'))
  const disappeared = join(root, 'packages', 'disappeared')
  try {
    await mkdir(disappeared, { recursive: true })
    await mkdir(join(root, 'apps'))
    await writeFile(join(root, 'apps', 'app.ts'), 'export const app = true')
    await writeFile(join(root, 'packages', 'package.ts'), 'export const pkg = true')

    const cases = [
      { path: root, code: 'EACCES', operation: 'stat' },
      { path: root, code: 'EACCES', operation: 'readdir' },
      { path: join(root, 'apps'), code: 'EACCES', operation: 'readdir' },
      { path: disappeared, code: 'ENOENT', operation: 'readdir' },
      { path: join(root, 'apps', 'app.ts'), code: 'EACCES', operation: 'readFile' },
    ]
    for (const failure of cases) {
      const io = {
        stat: async (path) => {
          if (failure.operation === 'stat' && path === failure.path) {
            throw Object.assign(new Error(`injected ${failure.code}`), { code: failure.code })
          }
          return stat(path)
        },
        readdir: async (path, options) => {
          if (failure.operation === 'readdir' && path === failure.path) {
            throw Object.assign(new Error(`injected ${failure.code}`), { code: failure.code })
          }
          return readdir(path, options)
        },
        readFile: async (path, encoding) => {
          if (failure.operation === 'readFile' && path === failure.path) {
            throw Object.assign(new Error(`injected ${failure.code}`), { code: failure.code })
          }
          return readFile(path, encoding)
        },
      }

      await assert.rejects(collectDigestWriterFlows(root, io), (error) => {
        assert.match(error.message, /digest writer scan|source directory|source file/)
        assert.ok(error.message.includes(failure.path))
        assert.equal(error.cause?.code, failure.code)
        return true
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detects a locale-dependent sort serialized directly into a hash', () => {
  const results = flows({
    'writer.ts': `
      import { createHash } from 'node:crypto'
      export function digest(value: Record<string, unknown>) {
        const ordered = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
        return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
      }
    `,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].sink.kind, 'crypto-hash')
  assert.equal(results[0].sink.owner, 'digest')
  assert.equal(results[0].source.owner, 'digest')
})

test('same-named methods in separate classes do not share taint analysis state', () => {
  const results = flows({
    'writers.ts': `
      import { createHash } from 'node:crypto'
      class SafeWriter {
        digest(value: string[]) {
          return createHash('sha256').update(JSON.stringify(value)).digest('hex')
        }
      }
      class LegacyWriter {
        digest(value: string[]) {
          const ordered = value.toSorted((left, right) => left.localeCompare(right))
          return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
        }
      }
    `,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].source.path, 'writers.ts')
  assert.equal(results[0].source.owner, 'digest')
  assert.equal(results[0].sink.owner, 'digest')
  assert.equal(results[0].sink.kind, 'crypto-hash')
})

test('same-named nested helpers resolve within their actual class method scope', () => {
  const results = flows({
    'writers.ts': `
      import { createHash } from 'node:crypto'
      class SafeWriter {
        digest(value: string[]) {
          function canonical(input: string[]) { return JSON.stringify(input) }
          return createHash('sha256').update(canonical(value)).digest('hex')
        }
      }
      class LegacyWriter {
        digest(value: string[]) {
          function canonical(input: string[]) {
            return JSON.stringify(input.toSorted((a, b) => a.localeCompare(b)))
          }
          return createHash('sha256').update(canonical(value)).digest('hex')
        }
      }
    `,
  })
  assert.ok(results.some((flow) => flow.sink.kind === 'crypto-hash'))
})

for (const [name, source] of [
  [
    'module',
    `
    import { createHash } from 'node:crypto'
    const ordered = ['z', 'ä'].toSorted((a, b) => a.localeCompare(b))
    export function digest() {
      return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
    }
  `,
  ],
  [
    'closure',
    `
    import { createHash } from 'node:crypto'
    export function digest(input: string[]) {
      const ordered = input.toSorted((a, b) => a.localeCompare(b))
      function bytes() { return JSON.stringify(ordered) }
      return createHash('sha256').update(bytes()).digest('hex')
    }
  `,
  ],
]) {
  test(`retains ${name} lexical taint across function evaluation`, () => {
    const results = flows({ 'writer.ts': source })
    assert.ok(results.some((flow) => flow.sink.kind === 'crypto-hash'))
  })
}

test('capture changes participate in return-taint cache identity', () => {
  const results = flows({
    'writer.ts': `
      import { createHash } from 'node:crypto'
      export function digest(input: string[]) {
        let ordered = []
        function bytes() { return JSON.stringify(ordered) }
        bytes()
        ordered = input.toSorted((a, b) => a.localeCompare(b))
        return createHash('sha256').update(bytes()).digest('hex')
      }
    `,
  })
  assert.ok(results.some((flow) => flow.sink.kind === 'crypto-hash'))
})

test('an exported returned closure retains its enclosing lexical taint', () => {
  const results = flows({
    'writer.ts': `
      import { createHash } from 'node:crypto'
      export function writer(input: string[]) {
        const ordered = input.toSorted((a, b) => a.localeCompare(b))
        return () => createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
      }
    `,
  })
  assert.ok(results.some((flow) => flow.sink.kind === 'crypto-hash'))
})

test('a parameter shadows a tainted module binding with the same name', () => {
  const results = flows({
    'writer.ts': `
      import { createHash } from 'node:crypto'
      const ordered = ['z', 'ä'].toSorted((a, b) => a.localeCompare(b))
      export function digest(ordered: string[]) {
        return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
      }
    `,
  })
  assert.deepEqual(results, [])
})

test('an imported helper retains the taints of its own module', () => {
  const results = flows({
    'writer.ts': `
      import { createHash } from 'node:crypto'
      import { bytes } from './legacy.js'
      export function digest() { return createHash('sha256').update(bytes()).digest('hex') }
    `,
    'legacy.ts': `
      const ordered = ['z', 'ä'].toSorted((a, b) => a.localeCompare(b))
      export function bytes() { return JSON.stringify(ordered) }
    `,
  })
  assert.ok(
    results.some((flow) => flow.sink.path === 'writer.ts' && flow.sink.kind === 'crypto-hash')
  )
})

test('a nested block comparator does not replace its enclosing comparator binding', () => {
  const results = flows({
    'writer.ts': `
      import { createHash } from 'node:crypto'
      export function digest(input: string[]) {
        const compare = (a, b) => a.localeCompare(b)
        { const compare = (a, b) => 0 }
        return createHash('sha256').update(JSON.stringify(input.toSorted(compare))).digest('hex')
      }
    `,
  })
  assert.ok(results.some((flow) => flow.sink.kind === 'crypto-hash'))
})

test('a block-local collator does not replace the enclosing Intl.Collator binding', () => {
  const results = flows({
    'writer.ts': `
      import { createHash } from 'node:crypto'
      export function digest(input: string[]) {
        const collator = new Intl.Collator('sv-SE')
        { const collator = { compare: (a, b) => 0 } }
        return createHash('sha256').update(JSON.stringify(input.toSorted(collator.compare))).digest('hex')
      }
    `,
  })
  assert.ok(results.some((flow) => flow.sink.kind === 'crypto-hash'))
})

test('an unused locale comparator in a nested block does not taint the safe outer comparator', () => {
  const results = flows({
    'writer.ts': `
      import { createHash } from 'node:crypto'
      export function digest(input: string[]) {
        const compare = (a, b) => 0
        { const compare = (a, b) => a.localeCompare(b) }
        return createHash('sha256').update(JSON.stringify(input.toSorted(compare))).digest('hex')
      }
    `,
  })
  assert.deepEqual(results, [])
})

for (const order of ['importer-first', 'dependency-first']) {
  test(`module initialization propagates imported return taint with ${order}`, () => {
    const writer = `
      import { createHash } from 'node:crypto'
      import { bytes } from './legacy.js'
      const result = bytes()
      export function digest() { return createHash('sha256').update(result).digest('hex') }
    `
    const legacy = `
      const ordered = ['z', 'ä'].toSorted((a, b) => a.localeCompare(b))
      export function bytes() { return JSON.stringify(ordered) }
    `
    const sources =
      order === 'importer-first'
        ? { 'writer.ts': writer, 'legacy.ts': legacy }
        : { 'legacy.ts': legacy, 'writer.ts': writer }
    const results = flows(sources)
    assert.ok(
      results.some((flow) => flow.sink.path === 'writer.ts' && flow.sink.kind === 'crypto-hash')
    )
  })
}

test('exported module declarations initialize captured taints', () => {
  const results = flows({
    'writer.ts': `
      import { createHash } from 'node:crypto'
      export const ordered = ['z', 'ä'].toSorted((a, b) => a.localeCompare(b))
      export function digest() {
        return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
      }
    `,
  })
  assert.ok(results.some((flow) => flow.sink.kind === 'crypto-hash'))
})

test('follows aliased local serializers and imported aliases into a hash', () => {
  const results = flows({
    'canonical.ts': `
      export function sortLegacy(value: Record<string, unknown>) {
        const compare = (left: [string, unknown], right: [string, unknown]) => left[0].localeCompare(right[0])
        return JSON.stringify(Object.entries(value).toSorted(compare))
      }
    `,
    'writer.ts': `
      import { createHash } from 'node:crypto'
      import { sortLegacy as importedCanonical } from './canonical.js'
      export function digest(value: Record<string, unknown>) {
        const serialize = importedCanonical
        const bytes = serialize(value)
        return createHash('sha256').update(bytes).digest('hex')
      }
    `,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].source.path, 'canonical.ts')
  assert.equal(results[0].sink.path, 'writer.ts')
  assert.equal(results[0].sink.owner, 'digest')
})

test('follows an imported comparator and in-place Array.sort into a hash', () => {
  const results = flows({
    'comparison.ts': `
      export function compareLocale(left: string, right: string) {
        return left.localeCompare(right)
      }
    `,
    'writer.ts': `
      import { createHash } from 'node:crypto'
      import { compareLocale as compare } from './comparison.js'
      export function digest(keys: string[]) {
        keys.sort(compare)
        return createHash('sha256').update(JSON.stringify(keys)).digest('hex')
      }
    `,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].source.path, 'comparison.ts')
  assert.equal(results[0].sink.path, 'writer.ts')
  assert.equal(results[0].sink.owner, 'digest')
})

test('a marker in a legacy file cannot exempt a new hash writer that reuses its serializer', () => {
  const results = flows({
    'legacy.ts': `
      // CANONICAL-JSON: retained historical serialization
      export function legacyCanonical(value: Record<string, unknown>) {
        return JSON.stringify(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)))
      }
      export function legacyHash(value: Record<string, unknown>) {
        return createHash('sha256').update(legacyCanonical(value)).digest('hex')
      }
      export function newWriter(value: Record<string, unknown>) {
        return { payloadHash: legacyHash(value) }
      }
    `,
  })

  assert.ok(
    results.some((flow) => flow.sink.kind === 'digest-field' && flow.sink.owner === 'newWriter')
  )
})

test('an imported legacy digest helper does not grandfather a new writer boundary', () => {
  const results = flows({
    'legacy.ts': `
      import { createHash } from 'node:crypto'
      export function legacyCanonical(value: Record<string, unknown>) {
        return JSON.stringify(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)))
      }
      export function legacyHash(value: Record<string, unknown>) {
        return createHash('sha256').update(legacyCanonical(value)).digest('hex')
      }
    `,
    'writer.ts': `
      import { legacyHash as oldDigest } from './legacy.js'
      export function newWriter(value: Record<string, unknown>) {
        return repository.insert({ payloadHash: oldDigest(value) })
      }
    `,
  })

  assert.ok(
    results.some((flow) => flow.sink.kind === 'digest-field' && flow.sink.path === 'writer.ts')
  )
  assert.ok(
    results.some((flow) => flow.sink.kind === 'persistence' && flow.sink.path === 'writer.ts')
  )
})

test('follows a workspace package barrel to an imported legacy digest helper', () => {
  const results = flows({
    'packages/events/src/legacy.ts': `
      import { createHash } from 'node:crypto'
      export function oldHash(value: string[]) {
        const ordered = value.toSorted((left, right) => left.localeCompare(right))
        return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
      }
    `,
    'packages/events/src/index.ts': `export * from './legacy.js'`,
    'writer.ts': `
      import { oldHash as historicalFrameHash } from '@control-plane/events'
      export function publish(value: string[]) {
        return repository.insert({ payloadHash: historicalFrameHash(value) })
      }
    `,
  })

  assert.ok(
    results.some((flow) => flow.sink.kind === 'digest-field' && flow.sink.path === 'writer.ts')
  )
})

test('workspace scan retains legacy helper, star barrel, and digest writer chain', () => {
  const sources = new Map([
    [
      'packages/demo/src/legacy.ts',
      `
        import { createHash } from 'node:crypto'
        export function legacyHash(value: string[]) {
          const ordered = value.toSorted((left, right) => left.localeCompare(right))
          return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
        }
      `,
    ],
    ['packages/demo/src/index.ts', `export * from './legacy.js'`],
    [
      'apps/demo/src/writer.ts',
      `
        import { legacyHash as historicalDigest } from '@control-plane/demo'
        export function write(value: string[]) {
          return repository.insert({ payloadHash: historicalDigest(value) })
        }
      `,
    ],
  ])
  const selected = selectRelevantSources(sources)
  const results = flows(selected)

  assert.deepEqual([...selected.keys()].toSorted(), [...sources.keys()].toSorted())
  assert.ok(
    results.some(
      (flow) => flow.sink.kind === 'digest-field' && flow.sink.path === 'apps/demo/src/writer.ts'
    )
  )
})

test('scan follows a named key wrapper through a barrel to a persistence hash', () => {
  const sources = new Map([
    [
      'packages/domain/src/context-command.ts',
      `
        export function legacyCanonical(value: string[]) {
          return JSON.stringify(value.toSorted((left, right) => left.localeCompare(right)))
        }
      `,
    ],
    [
      'packages/domain/src/context-node-inbox.ts',
      `
        import { legacyCanonical } from './context-command.js'
        export function contextCommandOperationKey(value: string[]) {
          return legacyCanonical(value)
        }
      `,
    ],
    [
      'packages/domain/src/index.ts',
      `export * from './context-command.js'; export * from './context-node-inbox.js'`,
    ],
    [
      'packages/sqlite-persistence/src/repository.ts',
      `
        import { createHash } from 'node:crypto'
        import { contextCommandOperationKey } from '@control-plane/domain'
        export function key(value: string[]) {
          return createHash('sha256').update(contextCommandOperationKey(value)).digest('hex')
        }
      `,
    ],
  ])
  const selected = selectRelevantSources(sources)
  const results = flows(selected)

  assert.deepEqual([...selected.keys()].toSorted(), [...sources.keys()].toSorted())
  assert.ok(
    results.some(
      (flow) => flow.sink.kind === 'crypto-hash' && flow.sink.path.endsWith('repository.ts')
    )
  )
})

test('full static frontier follows innocuously named wrappers beyond three imports', () => {
  const sources = new Map([
    [
      'packages/legacy/src/bytes.ts',
      `
        export function encode(value: string[]) {
          return JSON.stringify(value.toSorted((left, right) => left.localeCompare(right)))
        }
      `,
    ],
    ['packages/legacy/src/index.ts', `export * from './bytes.js'`],
    [
      'packages/record-tools/src/summary.ts',
      `
        import { encode as convert } from '@control-plane/legacy'
        export function describe(value: string[]) { return convert(value) }
      `,
    ],
    ['packages/record-tools/src/index.ts', `export { describe as prepare } from './summary.js'`],
    [
      'apps/records/src/writer.ts',
      `
        import { prepare as present } from '@control-plane/record-tools'
        import { createHash } from 'node:crypto'
        export function persist(value: string[]) {
          return store.insert({ payloadHash: createHash('sha256').update(present(value)).digest('hex') })
        }
      `,
    ],
  ])
  const selected = selectRelevantSources(sources)
  const results = flows(selected)

  assert.deepEqual([...selected.keys()].toSorted(), [...sources.keys()].toSorted())
  assert.ok(
    results.some(
      (flow) => flow.sink.kind === 'crypto-hash' && flow.sink.path === 'apps/records/src/writer.ts'
    )
  )
})

test('static frontier matches escaped, Unicode, and dollar identifiers as complete tokens', () => {
  const aliases = [
    'café',
    '转换',
    '$convert',
    'convert$',
    '$',
    String.raw`\u0063onvert`,
    String.raw`caf\u00e9`,
  ]
  for (const alias of aliases) {
    const sources = new Map([
      [
        'packages/legacy/src/index.ts',
        `export const encode = values => values.toSorted((a, b) => a.localeCompare(b))`,
      ],
      [
        'apps/records/src/writer.ts',
        `import { encode as ${alias} } from '@control-plane/legacy'
        export const describe = values => ${alias}(values)`,
      ],
    ])
    assert.equal(selectRelevantSources(sources).has('apps/records/src/writer.ts'), true, alias)
  }
})

test('static frontier decodes escapes across default, namespace, and named imports', () => {
  for (const binding of [
    String.raw`\u0063onvert`,
    String.raw`* as \u0063onvert`,
    String.raw`{ encode as \u0063onvert }`,
  ]) {
    const sources = new Map([
      [
        'packages/legacy/src/index.ts',
        `export const encode = values => values.toSorted((a, b) => a.localeCompare(b))`,
      ],
      [
        'apps/records/src/writer.ts',
        `import ${binding} from '@control-plane/legacy'
        export const describe = values => convert(values)`,
      ],
    ])
    assert.equal(selectRelevantSources(sources).has('apps/records/src/writer.ts'), true, binding)
  }
})

test('static frontier retains a separately imported local re-export', () => {
  const sources = new Map([
    [
      'packages/legacy/src/index.ts',
      `export const encode = values => values.toSorted((a, b) => a.localeCompare(b))`,
    ],
    [
      'packages/wrapper/src/index.ts',
      `import { encode as convert } from '@control-plane/legacy'; export { convert }`,
    ],
    [
      'apps/records/src/writer.ts',
      `import { convert } from '@control-plane/wrapper'; export const describe = values => convert(values)`,
    ],
  ])
  assert.deepEqual(
    [...selectRelevantSources(sources).keys()].toSorted(),
    [...sources.keys()].toSorted()
  )
})

test('static frontier excludes import-only names, strings, comments, and identifier substrings', () => {
  for (const [alias, other] of [
    ['convert', '$convert'],
    ['$convert', '$convertExtra'],
    ['convert$', 'convert$extra'],
    ['café', 'caféExtra'],
  ]) {
    const sources = new Map([
      [
        'packages/legacy/src/index.ts',
        `export const encode = values => values.toSorted((a, b) => a.localeCompare(b))`,
      ],
      [
        'apps/records/src/writer.ts',
        `import { encode as ${alias} } from '@control-plane/legacy'
        // ${alias}
        export const describe = '${alias}' + ${other}`,
      ],
    ])
    assert.equal(selectRelevantSources(sources).has('apps/records/src/writer.ts'), false, alias)
  }
})

test('includes script-path writers while excluding only the guard implementation', () => {
  const selected = selectRelevantSources(
    new Map([
      [
        'scripts/new-digest-writer.mjs',
        `
          import { createHash } from 'node:crypto'
          export function write(values) {
            return createHash('sha256').update(values.toSorted((a, b) => a.localeCompare(b)).join(',')).digest('hex')
          }
        `,
      ],
    ])
  )

  assert.deepEqual([...selected.keys()], ['scripts/new-digest-writer.mjs'])
  assert.equal(flows(selected)[0]?.sink.kind, 'crypto-hash')
  assert.equal(
    selectRelevantSources(
      new Map([['scripts/check-digest-writers.mjs', 'value.localeCompare(other)']])
    ).size,
    0
  )
})

test('allows locale sorting for display beside an unrelated shared canonical hash', () => {
  const results = flows({
    'safe.ts': `
      import { createHash } from 'node:crypto'
      import { canonicalJsonStringify } from '@control-plane/contracts'
      export function digest(value: Record<string, unknown>, labels: string[]) {
        const display = labels.toSorted((left, right) => left.localeCompare(right))
        void display
        return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')
      }
    `,
  })

  assert.deepEqual(results, [])
})

test('allows locale-sorted display data to be persisted without a digest boundary', () => {
  const results = flows({
    'display.ts': `
      export function saveLabels(labels: string[]) {
        return repository.put({ labels: labels.toSorted((left, right) => left.localeCompare(right)) })
      }
    `,
  })

  assert.deepEqual(results, [])
})

test('fingerprints bigint literals in candidate persistence statements', () => {
  assert.deepEqual(
    flows({
      'safe.ts': `
        export function saveDisplayMetadata() {
          return repository.put({ labels: [1n] })
        }
      `,
    }),
    []
  )
})

test('detects computed localeCompare and Intl.Collator comparators', () => {
  const results = flows({
    'computed.ts': `
      import { createHash } from 'node:crypto'
      export function computed(value: string[]) {
        const compare = (left: string, right: string) => left['locale' + 'Compare'](right)
        return createHash('sha256').update(value.toSorted(compare).join(',')).digest('hex')
      }
      export function collated(value: string[]) {
        const compare = new Intl.Collator('fr').compare
        return createHash('sha256').update(value.toSorted(compare).join(',')).digest('hex')
      }
    `,
  })

  assert.equal(results.length, 2)
  assert.deepEqual(results.map((flow) => flow.sink.owner).toSorted(), ['collated', 'computed'])
})

test('ignores comment and string mentions of localeCompare', () => {
  assert.deepEqual(
    flows({
      'safe.ts': `
        import { createHash } from 'node:crypto'
        // value.localeCompare(other) is forbidden in canonical digest code
        export function digest(value: string) {
          const note = 'localeCompare is only documentation here'
          return createHash('sha256').update(value + note).digest('hex')
        }
      `,
    }),
    []
  )
})

test('an approved split-update helper does not exempt a downstream digest writer', () => {
  const legacy = `
    import { createHash } from 'node:crypto'
    export function legacy(value: string[]) {
      const ordered = value.toSorted((a, b) => a.localeCompare(b))
      const hash = createHash('sha256')
      hash.update(JSON.stringify(ordered))
      return hash.digest('hex')
    }
  `
  const baseline = flows({ 'legacy.ts': legacy })
  assert.equal(baseline.length, 1)
  assert.equal(baseline[0].sink.kind, 'crypto-hash')
  const approvedHelper = { source: baseline[0].source, sink: baseline[0].sink }
  const results = flows({
    'legacy.ts': legacy,
    'writer.ts': `
      import { legacy } from './legacy.js'
      export function newWriter(value: string[]) {
        return repository.insert({ payloadHash: legacy(value) })
      }
    `,
  })
  const unapproved = results.filter((flow) => !matchesDigestWriterException(flow, approvedHelper))
  assert.ok(
    unapproved.some((flow) => flow.sink.path === 'writer.ts' && flow.sink.kind === 'digest-field')
  )
  assert.ok(
    unapproved.some((flow) => flow.sink.path === 'writer.ts' && flow.sink.kind === 'persistence')
  )
})

for (const [name, operations, returnedHash, tainted] of [
  ['later safe update', 'hash.update(ordered); hash.update("suffix")', 'hash', true],
  ['update through alias', 'const alias = hash; alias.update(ordered)', 'hash', true],
  ['digest through alias', 'const alias = hash; hash.update(ordered)', 'alias', true],
  ['chained updates', 'hash.update("prefix").update(ordered)', 'hash', true],
  [
    'independent receiver',
    'const other = createHash("sha256"); other.update(ordered)',
    'hash',
    false,
  ],
]) {
  test(`split hash state propagates correctly with ${name}`, () => {
    const results = flows({
      'legacy.ts': `
        import { createHash } from 'node:crypto'
        export function legacy(value: string[]) {
          const ordered = JSON.stringify(value.toSorted((a, b) => a.localeCompare(b)))
          const hash = createHash('sha256')
          ${operations}
          return ${returnedHash}.digest('hex')
        }
      `,
      'writer.ts': `
        import { legacy } from './legacy.js'
        export function write(value: string[]) {
          return repository.insert({ payloadHash: legacy(value) })
        }
      `,
    })
    assert.equal(
      results.some((flow) => flow.sink.path === 'writer.ts' && flow.sink.kind === 'digest-field'),
      tainted
    )
    assert.equal(
      results.some((flow) => flow.sink.path === 'writer.ts' && flow.sink.kind === 'persistence'),
      tainted
    )
  })
}

test('uses line-independent source and sink fingerprints for reviewed exceptions', () => {
  const source = `
    import { createHash } from 'node:crypto'
    export function digest(value: Record<string, unknown>) {
      const ordered = Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
      return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
    }
  `
  const original = flows({ 'stable.ts': source })[0]
  const shifted = flows({ 'stable.ts': `\n\n// preceding context\n${source}` })[0]

  assert.equal(shifted.source.fingerprint, original.source.fingerprint)
  assert.equal(shifted.sink.fingerprint, original.sink.fingerprint)
  const exception = {
    source: {
      path: original.source.path,
      owner: original.source.owner,
      fingerprint: original.source.fingerprint,
      sitePath: original.source.sitePath,
      siteOwner: original.source.siteOwner,
      occurrence: original.source.occurrence,
    },
    sink: {
      path: original.sink.path,
      owner: original.sink.owner,
      fingerprint: original.sink.fingerprint,
      kind: original.sink.kind,
      occurrence: original.sink.occurrence,
    },
  }
  assert.equal(matchesDigestWriterException(shifted, exception), true)
  assert.equal(
    matchesDigestWriterException(shifted, {
      ...exception,
      sink: { ...exception.sink, owner: 'newWriter' },
    }),
    false
  )
})

test('does not let one reviewed fingerprint exempt an identical second writer site', () => {
  const results = flows({
    'writer.ts': `
      import { createHash } from 'node:crypto'
      export function digest(value: Record<string, unknown>, left: boolean, right: boolean) {
        if (left) {
          const ordered = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))
          const hash = createHash('sha256')
          hash.update(JSON.stringify(ordered))
          return hash.digest('hex')
        }
        if (right) {
          const ordered = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))
          const hash = createHash('sha256')
          hash.update(JSON.stringify(ordered))
          return hash.digest('hex')
        }
        return undefined
      }
    `,
  })

  assert.equal(results.length, 2)
  assert.deepEqual(results.map((flow) => flow.source.occurrence).toSorted(), [1, 2])
  assert.deepEqual(results.map((flow) => flow.sink.occurrence).toSorted(), [1, 2])

  const approvedFirst = {
    source: {
      path: results[0].source.path,
      owner: results[0].source.owner,
      fingerprint: results[0].source.fingerprint,
      sitePath: results[0].source.sitePath,
      siteOwner: results[0].source.siteOwner,
      occurrence: 1,
    },
    sink: {
      path: results[0].sink.path,
      owner: results[0].sink.owner,
      fingerprint: results[0].sink.fingerprint,
      kind: results[0].sink.kind,
      occurrence: 1,
    },
  }

  assert.equal(matchesDigestWriterException(results[0], approvedFirst), true)
  assert.equal(matchesDigestWriterException(results[1], approvedFirst), false)
})

test('follows a default export re-exported from a workspace package barrel', () => {
  const results = flows({
    'packages/legacy/src/canonical.ts': `
      export default function canonical(value: string[]) {
        return JSON.stringify(value.toSorted((left, right) => left.localeCompare(right)))
      }
    `,
    'packages/legacy/src/index.ts': `export { default } from './canonical.js'`,
    'apps/writer/src/publish.ts': `
      import canonical from '@control-plane/legacy'
      import { createHash } from 'node:crypto'
      export function write(value: string[]) {
        return createHash('sha256').update(canonical(value)).digest('hex')
      }
    `,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].source.path, 'packages/legacy/src/canonical.ts')
  assert.equal(results[0].sink.path, 'apps/writer/src/publish.ts')
})

test('follows local and imported comparator calls inside a sort callback', () => {
  const results = flows({
    'packages/legacy/src/comparison.ts': `
      export function compareImported(left: string, right: string) {
        return left.localeCompare(right, 'en')
      }
    `,
    'packages/legacy/src/canonical.ts': `
      import { compareImported as compareAcrossModule } from './comparison.js'
      function compareDefault(left: string, right: string) {
        return left.localeCompare(right)
      }
      function compareEnglish(left: string, right: string) {
        return left.localeCompare(right, 'en')
      }
      export function canonicalLegacy(value: string[][]) {
        return value.toSorted(([a], [b]) =>
          compareDefault(a, b) || compareEnglish(a, b) || compareAcrossModule(a, b)
        )
      }
    `,
    'packages/legacy/src/index.ts': `export { canonicalLegacy } from './canonical.js'`,
    'apps/writer/src/publish.ts': `
      import { createHash } from 'node:crypto'
      import { canonicalLegacy } from '@control-plane/legacy'
      export function write(value: string[][]) {
        return createHash('sha256').update(JSON.stringify(canonicalLegacy(value))).digest('hex')
      }
    `,
  })

  assert.ok(results.length >= 2)
  assert.ok(results.some((flow) => flow.source.path === 'packages/legacy/src/canonical.ts'))
  assert.ok(results.some((flow) => flow.source.path === 'packages/legacy/src/comparison.ts'))
})

test('follows comparator helpers through cycles without looping', () => {
  const results = flows({
    'canonical.ts': `
      import { createHash } from 'node:crypto'
      function compare(left: string, right: string) { return compareAgain(left, right) }
      function compareAgain(left: string, right: string) {
        return compare(left, right) || left.localeCompare(right, 'en')
      }
      export function digest(values: string[]) {
        return createHash('sha256').update(JSON.stringify(values.toSorted(compare))).digest('hex')
      }
    `,
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].source.path, 'canonical.ts')
  assert.equal(results[0].sink.kind, 'crypto-hash')
})
