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
    // The fixture writes into apps/, so that root has to exist first: without
    // it the case failed on its own ENOENT instead of the injected failure.
    await mkdir(join(root, 'apps'), { recursive: true })
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
