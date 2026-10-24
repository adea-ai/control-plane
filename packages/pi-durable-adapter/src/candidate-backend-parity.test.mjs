import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'

// EVIDENCE CHARACTERIZATION ONLY. Offline and disposable.
//
// Records, on temporary copies of the installed Pi Durable 1.1.0 SDK, what each storage backend does today when asked for
// the operations the C2, C4, C7 and c4b candidates are built on: writer fence, closure receipt, guarded commit, read-only
// open and Session.closeWriters. It changes no backend and adds no patch. It does not say which backend any product mode
// (Local, Self-hosted, Hosted) uses, and it makes no claim about a deployed Cloudflare Worker or Durable Object.
//
// THE "CLOUDFLARE" BACKEND HERE IS A TEST DOUBLE. It is the SDK's own `openDurableObjectSqliteStorage` running over a
// stand-in for `ctx.storage` that is built on node:sqlite in memory. It shows what the SDK's adapter code does when its
// two inputs behave as a minimal single-threaded SQLite-backed Durable Object (`sql.exec` and `transaction`). It is NOT
// evidence of Cloudflare behavior: the real transaction, input/output gate, eviction and storage semantics are not modeled.
const here = dirname(fileURLToPath(import.meta.url))
const adapterRoot = resolve(here, '..')
const repoRoot = resolve(adapterRoot, '../..')
// The install layout differs between installs (a per-package symlink locally, a hoisted root hosted), so the SDK is found
// through module resolution rather than a fixed node_modules path.
function installedSdkRoot() {
  let directory = dirname(createRequire(import.meta.url).resolve('@earendil-works/pi-durable'))
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error('installed pi-durable package root not found')
    directory = parent
  }
  return realpathSync(directory)
}
const installed = installedSdkRoot()
const compatPatch = join(repoRoot, 'patches/@earendil-works%2Fpi-durable@1.1.0.patch')
const candidatePatches = [
  'c2-store-fence/c2-store-fence.candidate.patch',
  'c4-close-writers/c4-close-writers.candidate.patch',
  'c7-read-only-open/c7-read-only-open.candidate.patch',
  'c4b-session-admission-sealing/c4b-session-admission-sealing.candidate.patch',
].map((relative) => join(adapterRoot, 'candidates', relative))
const scratchBase = join(dirname(installed), '.backend-parity-test')

// Removes only the directories this run created, then the shared base only if nothing else is left in it.
function removeOwned(base, owned) {
  for (const path of owned) rmSync(path, { recursive: true, force: true })
  try {
    rmdirSync(base)
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
  }
}

const owned = []
// Every in-memory database the Durable Object double creates, so afterAll can prove each one was disposed.
const doubles = []
// layers: the candidate patches to stack on the compatibility patch, in order.
async function loadSdk(candidates) {
  mkdirSync(scratchBase, { recursive: true })
  const root = mkdtempSync(join(scratchBase, 'sdk-'))
  owned.push(root)
  const pkg = join(root, 'pi-durable')
  cpSync(installed, pkg, { recursive: true, dereference: true })
  execFileSync('git', ['init', '-q'], { cwd: pkg })
  if (!existsSync(join(pkg, 'dist/harness/guarded-abort.js')))
    execFileSync('git', ['apply', compatPatch], { cwd: pkg })
  for (const patch of candidates) execFileSync('git', ['apply', patch], { cwd: pkg })
  const load = (relative) => import(pathToFileURL(join(pkg, relative)).href)
  return {
    sdk: await load('dist/index.js'),
    node: await load('dist/storage/sqlite/node.js'),
    sqlite: await load('dist/storage/sqlite/index.js'),
    memory: await load('dist/storage/memory.js'),
    jsonl: await load('dist/storage/jsonl/node.js'),
    jsonlClass: await load('dist/storage/jsonl/index.js'),
    cloudflare: await load('dist/storage/sqlite/cloudflare.js'),
  }
}

let baseline // compatibility patch only
let stack // compatibility patch + C2, C4, C7, c4b
let dir
let counter = 0
beforeAll(async () => {
  baseline = await loadSdk([])
  stack = await loadSdk(candidatePatches)
  dir = mkdtempSync(join(scratchBase, 'db-'))
  owned.push(dir)
})
afterAll(() => {
  removeOwned(scratchBase, owned)
  const leaked = doubles.filter((stand) => !stand.isDisposed())
  if (leaked.length > 0)
    throw new Error(`${leaked.length} Durable Object double database(s) not disposed`)
})

const path = (name) => join(dir, `${name}-${counter++}`)
const code = async (promise) => {
  try {
    await promise
  } catch (error) {
    return error.message
  }
  return 'no error'
}
const holder = {
  ownerKey: 'owner:parity',
  lineageId: 'lineage:1',
  generation: 'gen:1',
  expectedEpoch: 0,
}
async function writeConversation(storage) {
  const id = await storage.mintId()
  await storage.commit([{ type: 'conversation', value: { id } }], context)
  return id
}
const hash = (c) => `sha256:${c.repeat(64)}`
const abortRequest = (requestId) => ({
  requestId,
  requestDigest: hash('a'),
  metadata: {
    targetDigest: hash('b'),
    expiresAt: '2026-10-20T12:01:00.000Z',
    fenceRevision: 1,
    inferenceId: 'native:1',
    turnKey: 'turn:initial',
    scopeDigest: 'c'.repeat(64),
  },
  hostDocuments: [],
  async prepare() {
    return () => {}
  },
})
async function openHarness(build, storage) {
  const harness = await build.sdk.Harness.open(
    storage,
    {
      models: createModels(),
      registry: build.sdk.createRegistry(),
      settings: { compaction: { enabled: false } },
    },
    context
  )
  return { harness, root: await harness.root(context) }
}
// What a storage object exposes of the candidate surface (methods only; nothing is called).
const surface = (storage) => ({
  acquireWriterFence: typeof storage.acquireWriterFence,
  closeWriterFence: typeof storage.closeWriterFence,
  commitGuarded: typeof storage.commitGuarded,
})
const methods = (cls) => Object.getOwnPropertyNames(cls.prototype).toSorted()

// TEST DOUBLE for a SQLite-backed Durable Object's `ctx.storage` (`sql.exec` and `transaction`), over node:sqlite.
// Rows come back the way the real binding returns them: numbers, and BLOBs as ArrayBuffer. It is serial and local, so it
// models none of the platform's gates, eviction, or failure behavior.
function durableObjectDouble() {
  const database = new DatabaseSync(':memory:')
  let disposed = false
  const toBinding = (value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)
  const toValue = (value) => {
    if (typeof value === 'bigint') return Number(value)
    if (value instanceof Uint8Array) return value.slice().buffer
    return value
  }
  const stand = {
    sql: {
      exec(query, ...bindings) {
        const reads = /^\s*(select|pragma|with)\b/i.test(query)
        if (bindings.length === 0 && !reads) {
          database.exec(query)
          return { toArray: () => [] }
        }
        const statement = database.prepare(query)
        if (!reads) {
          statement.run(...bindings.map(toBinding))
          return { toArray: () => [] }
        }
        const rows = statement.all(...bindings.map(toBinding)).map((row) => {
          const copy = {}
          for (const [key, value] of Object.entries(row)) copy[key] = toValue(value)
          return copy
        })
        return { toArray: () => rows }
      },
    },
    // The SDK's storage.close does not own this stand-in database, so each test disposes it itself, in a finally.
    dispose() {
      if (disposed) return
      disposed = true
      database.close()
    },
    isDisposed: () => disposed,
    async transaction(closure) {
      database.exec('BEGIN')
      try {
        const result = await closure()
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
  doubles.push(stand)
  return stand
}

describe('candidate surface by backend (methods only)', () => {
  const present = {
    acquireWriterFence: 'function',
    closeWriterFence: 'function',
    commitGuarded: 'function',
  }
  const absent = {
    acquireWriterFence: 'undefined',
    closeWriterFence: 'undefined',
    commitGuarded: 'undefined',
  }

  test('Node SQLite: the compat patch alone has no fence or closure; the candidate stack adds both', async () => {
    const before = await baseline.node.openNodeSqliteStorage(path('base') + '.sqlite')
    const after = await stack.node.openNodeSqliteStorage(path('stack') + '.sqlite')
    try {
      expect(surface(before)).toEqual({ ...absent, commitGuarded: 'function' })
      expect(surface(after)).toEqual(present)
      expect(typeof baseline.sqlite.SqliteStorage.openReadOnly).toBe('undefined')
      expect(typeof stack.sqlite.SqliteStorage.openReadOnly).toBe('function')
    } finally {
      await before.close(context)
      await after.close(context)
    }
  })

  test('MemoryStorage and JsonlStorage expose no fence, closure, guarded commit or read-only open, with or without the candidates', async () => {
    for (const build of [baseline, stack]) {
      const memory = new build.memory.MemoryStorage()
      const jsonl = await build.jsonl.openNodeJsonlStorage(path('surface'), context)
      try {
        expect(surface(memory)).toEqual(absent)
        expect(surface(jsonl)).toEqual(absent)
        expect(typeof build.memory.MemoryStorage.openReadOnly).toBe('undefined')
        expect(typeof build.jsonlClass.JsonlStorage.openReadOnly).toBe('undefined')
      } finally {
        await jsonl.close(context)
      }
    }
    // The candidates edit only SQLite storage, Session and Harness: the other two classes are the same code in both builds.
    expect(methods(stack.memory.MemoryStorage)).toEqual(methods(baseline.memory.MemoryStorage))
    expect(methods(stack.jsonlClass.JsonlStorage)).toEqual(
      methods(baseline.jsonlClass.JsonlStorage)
    )
  })

  test('the SDK exports one Durable Object SQLite entry point and no read-only Durable Object facade', () => {
    expect(Object.keys(stack.cloudflare).toSorted()).toEqual([
      'DurableObjectSqliteDatabase',
      'openDurableObjectSqliteStorage',
    ])
    expect(Object.keys(stack.cloudflare).toSorted()).toEqual(
      Object.keys(baseline.cloudflare).toSorted()
    )
  })
})

describe('Node SQLite, candidate stack', () => {
  test('fence, guarded commit, closure receipt, then every later commit is fenced', async () => {
    const storage = await stack.node.openNodeSqliteStorage(path('node') + '.sqlite')
    try {
      await writeConversation(storage)
      expect((await storage.acquireWriterFence(holder)).epoch).toBe(1)
      expect(
        await storage.commitGuarded(
          [{ type: 'conversation', value: { id: await storage.mintId() } }],
          () => {},
          context
        )
      ).toBeGreaterThan(0)
      const receipt = await storage.closeWriterFence({ mutationId: 'parity:node' })
      expect(receipt.schemaVersion).toBe('pi-writer-closure-receipt/v1')
      expect(receipt.epoch).toBe(2)
      expect(await code(writeConversation(storage))).toBe('PI_STORE_FENCED')
    } finally {
      await storage.close(context)
    }
  })

  test('Session.closeWriters returns the receipt and leaves the Harness closed; guarded abort receipts commit before it', async () => {
    const storage = await stack.node.openNodeSqliteStorage(path('node') + '.sqlite')
    await storage.acquireWriterFence(holder)
    const { harness, root } = await openHarness(stack, storage)
    try {
      const abort = await root.commitAbort(abortRequest('parity:node'), context)
      expect(abort.requestId).toBe('parity:node')
      const receipt = await harness.closeWriters({ mutationId: 'parity:node:close' }, context)
      expect(receipt.schemaVersion).toBe('pi-writer-closure-receipt/v1')
      expect(await code(harness.root(context))).toBe('Harness is closed')
    } finally {
      // closeWriters already closed the Harness and its storage; this only matters if an assertion above failed first.
      await harness.close(context).catch(() => {})
    }
  })

  test('read-only open: a closed store reads, and each mutating entry point is refused directly', async () => {
    const file = path('node-ro') + '.sqlite'
    const writer = await stack.node.openNodeSqliteStorage(file)
    const id = await writeConversation(writer)
    await writer.close(context)
    const reader = await stack.node.openNodeSqliteStorage(file, { mode: 'read-only' })
    try {
      expect((await reader.conversation(id, context)).id).toBe(id)
      // Each call below is made directly with a valid pre-existing ID, so the refusal cannot come from mintId failing first.
      const write = [{ type: 'conversation', value: { id } }]
      expect(await code(reader.commit(write, context))).toBe('PI_STORE_READ_ONLY')
      expect(await code(reader.commitGuarded(write, () => {}, context))).toBe('PI_STORE_READ_ONLY')
      expect(await code(reader.acquireWriterFence(holder))).toBe('PI_STORE_READ_ONLY')
      expect(await code(reader.closeWriterFence({ mutationId: 'parity:readonly' }))).toBe(
        'PI_STORE_READ_ONLY'
      )
      // Distinct from the above: minting an ID is itself refused.
      expect(await code(reader.mintId())).toBe('PI_STORE_READ_ONLY')
    } finally {
      await reader.close(context)
    }
  })

  test('the store persists across close and reopen', async () => {
    const file = path('node-persist') + '.sqlite'
    const first = await stack.node.openNodeSqliteStorage(file)
    const id = await writeConversation(first)
    await first.close(context)
    const second = await stack.node.openNodeSqliteStorage(file)
    try {
      expect((await second.conversation(id, context)).id).toBe(id)
    } finally {
      await second.close(context)
    }
  })
})

describe('MemoryStorage and JsonlStorage refusal behavior (candidate stack applied to the SDK copy)', () => {
  const backends = {
    MemoryStorage: async () => new stack.memory.MemoryStorage(),
    JsonlStorage: async () => stack.jsonl.openNodeJsonlStorage(path('jsonl'), context),
  }
  for (const [name, open] of Object.entries(backends)) {
    test(`${name}: guarded abort and Session.closeWriters are refused, and the Harness stays usable`, async () => {
      const storage = await open()
      const { harness, root } = await openHarness(stack, storage)
      try {
        expect(await code(root.commitAbort(abortRequest('parity:refused'), context))).toBe(
          'PI_GUARDED_COMMIT_UNAVAILABLE'
        )
        expect(
          await code(harness.closeWriters({ mutationId: 'parity:refused:close' }, context))
        ).toBe('PI_SESSION_CLOSE_WRITERS_UNAVAILABLE')
        // Not sealed: the Harness still serves the root, and a later close is the ordinary one.
        expect(await code(harness.root(context))).toBe('no error')
      } finally {
        await harness.close(context)
      }
    })

    test(`${name}: a refused closeWriters seals nothing, so a write on the same storage and Harness afterwards is accepted`, async () => {
      const storage = await open()
      const { harness } = await openHarness(stack, storage)
      try {
        const before = await writeConversation(storage)
        expect(
          await code(harness.closeWriters({ mutationId: 'parity:refused:then-write' }, context))
        ).toBe('PI_SESSION_CLOSE_WRITERS_UNAVAILABLE')
        // The same storage object the Harness holds, after the refusal: nothing is fenced or sealed.
        const after = await writeConversation(storage)
        expect(after).not.toBe(before)
        expect((await storage.conversation(before, context)).id).toBe(before)
        expect((await storage.conversation(after, context)).id).toBe(after)
        expect(await code(harness.root(context))).toBe('no error')
      } finally {
        await harness.close(context)
      }
    })
  }

  test('MemoryStorage holds nothing across instances', async () => {
    const first = new stack.memory.MemoryStorage()
    const id = await writeConversation(first)
    const second = new stack.memory.MemoryStorage()
    expect(await second.conversation(id, context)).toBeUndefined()
  })

  test('JsonlStorage persists across close and reopen', async () => {
    const directory = path('jsonl-persist')
    const first = await stack.jsonl.openNodeJsonlStorage(directory, context)
    const id = await writeConversation(first)
    await first.close(context)
    const second = await stack.jsonl.openNodeJsonlStorage(directory, context)
    try {
      expect((await second.conversation(id, context)).id).toBe(id)
    } finally {
      await second.close(context)
    }
  })

  test('JsonlStorage has no read-only mode: an unsupported `mode` option is ignored and the store opens writable', async () => {
    const directory = path('jsonl-mode')
    const first = await stack.jsonl.openNodeJsonlStorage(directory, context)
    await writeConversation(first)
    await first.close(context)
    const second = await stack.jsonl.openNodeJsonlStorage(directory, context, { mode: 'read-only' })
    try {
      expect(await code(writeConversation(second))).toBe('no error')
    } finally {
      await second.close(context)
    }
  })
})

describe('Durable Object SQLite TEST DOUBLE (not Cloudflare evidence), candidate stack applied to the SDK copy', () => {
  test('the double`s dispose closes its in-memory database, and the SDK storage close does not', async () => {
    const stand = durableObjectDouble()
    const storage = await stack.cloudflare.openDurableObjectSqliteStorage(stand)
    await storage.close(context)
    expect(stand.isDisposed()).toBe(false)
    expect(() => stand.sql.exec('SELECT 1')).not.toThrow()
    stand.dispose()
    expect(stand.isDisposed()).toBe(true)
    expect(() => stand.sql.exec('SELECT 1')).toThrow()
  })

  test('the fence, closure receipt and post-closure refusal work through the double`s transaction', async () => {
    const stand = durableObjectDouble()
    const storage = await stack.cloudflare.openDurableObjectSqliteStorage(stand)
    try {
      await writeConversation(storage)
      expect((await storage.acquireWriterFence(holder)).epoch).toBe(1)
      const receipt = await storage.closeWriterFence({ mutationId: 'parity:double' })
      expect(receipt.schemaVersion).toBe('pi-writer-closure-receipt/v1')
      expect(await code(writeConversation(storage))).toBe('PI_STORE_FENCED')
    } finally {
      await storage.close(context)
      stand.dispose()
    }
  })

  test('the adapter has no guarded transaction, so a guarded commit and a guarded abort receipt are unavailable', async () => {
    const stand = durableObjectDouble()
    const storage = await stack.cloudflare.openDurableObjectSqliteStorage(stand)
    let harness
    try {
      await storage.acquireWriterFence(holder)
      expect(typeof storage.commitGuarded).toBe('function')
      expect(
        await code(
          storage.commitGuarded(
            [{ type: 'conversation', value: { id: await storage.mintId() } }],
            () => {},
            context
          )
        )
      ).toBe('PI_GUARDED_COMMIT_UNAVAILABLE')
      const opened = await openHarness(stack, storage)
      harness = opened.harness
      expect(await code(opened.root.commitAbort(abortRequest('parity:double'), context))).toBe(
        'PI_GUARDED_COMMIT_UNAVAILABLE'
      )
      // Session.closeWriters itself needs only the fence and the closure, so it succeeds over the double.
      const receipt = await harness.closeWriters({ mutationId: 'parity:double:close' }, context)
      expect(receipt.schemaVersion).toBe('pi-writer-closure-receipt/v1')
    } finally {
      // closeWriters closes the Harness and its storage; these only matter if an assertion above failed first.
      if (harness !== undefined) await harness.close(context).catch(() => {})
      else await storage.close(context).catch(() => {})
      stand.dispose()
    }
  })

  test('SqliteStorage.openReadOnly accepts any database facade, including the double`s, and checks nothing about owners or sidecars', async () => {
    const stand = durableObjectDouble()
    const writer = await stack.cloudflare.openDurableObjectSqliteStorage(stand)
    let reader
    try {
      const id = await writeConversation(writer)
      reader = await stack.sqlite.SqliteStorage.openReadOnly(
        new stack.cloudflare.DurableObjectSqliteDatabase(stand)
      )
      expect((await reader.conversation(id, context)).id).toBe(id)
      // Direct calls with the existing ID, so the refusal is not mintId failing first.
      expect(await code(reader.commit([{ type: 'conversation', value: { id } }], context))).toBe(
        'PI_STORE_READ_ONLY'
      )
      expect(await code(reader.mintId())).toBe('PI_STORE_READ_ONLY')
      // The writer is still open and still holds the same store: nothing refused the second handle.
      expect(await code(writeConversation(writer))).toBe('no error')
    } finally {
      if (reader !== undefined) await reader.close(context)
      await writer.close(context)
      stand.dispose()
    }
  })
})
