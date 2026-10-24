import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { assertPiWriterClosureReceipt } from './cancellation-registration.ts'

// CANDIDATE, Session admission sealing for Pi Durable 1.1.0. Offline and disposable only.
//
// Shows, on temporary copies of the installed SDK with the compat, C2, C4, C7 and this candidate's patches applied and on
// disposable SQLite files, the exact order `closeWriters` imposes on a Session: seal admission, join Harness tasks, let every
// already-admitted commit settle on the mutation line, take the C4 storage closure on that same line, then close storage.
// Limits: one Session object on one storage object; nothing here covers another process, a crashed owner or a reopened
// storage, and it is not a retry-safety, rollback-safety or quiescent-capture claim. The unmodified SDK, the compat patch
// and the C2/C4/C7 candidates have no `closeWriters`. Nothing here adopts the SDK, issues anything, captures anything or
// touches a live store.
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
const patches = [
  join(adapterRoot, 'candidates/c2-store-fence/c2-store-fence.candidate.patch'),
  join(adapterRoot, 'candidates/c4-close-writers/c4-close-writers.candidate.patch'),
  join(adapterRoot, 'candidates/c7-read-only-open/c7-read-only-open.candidate.patch'),
  join(
    adapterRoot,
    'candidates/c4b-session-admission-sealing/c4b-session-admission-sealing.candidate.patch'
  ),
]
const compatPatch = join(repoRoot, 'patches/@earendil-works%2Fpi-durable@1.1.0.patch')
const scratchBase = join(dirname(installed), '.c4b-sealing-test')

// Removes only the directories this run created, then the shared base only if nothing else is left in it, so a concurrent
// run's (or anything else's) files under the same base are never touched.
function removeOwned(base, owned) {
  for (const path of owned) rmSync(path, { recursive: true, force: true })
  try {
    rmdirSync(base)
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
  }
}

let sdk
let node
let dir
let counter = 0
const owned = []
beforeAll(async () => {
  mkdirSync(scratchBase, { recursive: true })
  const root = mkdtempSync(join(scratchBase, 'sdk-'))
  owned.push(root)
  const pkg = join(root, 'pi-durable')
  cpSync(installed, pkg, { recursive: true, dereference: true })
  execFileSync('git', ['init', '-q'], { cwd: pkg })
  if (!existsSync(join(pkg, 'dist/harness/guarded-abort.js')))
    execFileSync('git', ['apply', compatPatch], { cwd: pkg })
  for (const patch of patches) execFileSync('git', ['apply', patch], { cwd: pkg })
  const load = (relative) => import(pathToFileURL(join(pkg, relative)).href)
  sdk = await load('dist/index.js')
  node = await load('dist/storage/sqlite/node.js')
  dir = mkdtempSync(join(scratchBase, 'db-'))
  owned.push(dir)
})
afterAll(() => {
  removeOwned(scratchBase, owned)
})

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
const holder = (over = {}) => ({
  ownerKey: 'owner:ledger',
  lineageId: 'lineage:1',
  generation: 'gen:1',
  expectedEpoch: 0,
  ...over,
})
const dbPath = () => join(dir, `store-${counter++}.sqlite`)
const code = async (promise) => {
  try {
    await promise
  } catch (error) {
    return error.message
  }
  return 'no error'
}
const immutableDatabase = (path) => {
  const uri = pathToFileURL(path)
  uri.search = '?mode=ro&immutable=1'
  return new DatabaseSync(uri.href, { readOnly: true })
}
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const listing = (path) =>
  readdirSync(dirname(path)).filter((name) => name.startsWith(path.split('/').at(-1)))

// A genuine SDK Harness over a storage that already holds the fence, committing real guarded-abort receipts.
async function openHarness(storage) {
  const harness = await sdk.Harness.open(
    storage,
    {
      models: createModels(),
      registry: sdk.createRegistry(),
      settings: { compaction: { enabled: false } },
    },
    context
  )
  return { harness, root: await harness.root(context) }
}

// What the closed file says: fence epoch, closure rows, highest committed sequence.
function inspect(path) {
  const database = immutableDatabase(path)
  try {
    return {
      epoch: database.prepare('SELECT epoch FROM durable_writer_fence WHERE singleton = 1').get()
        .epoch,
      closures: database.prepare('SELECT COUNT(*) AS n FROM durable_writer_closure').get().n,
      lastSeq:
        Number(
          database.prepare('SELECT next_seq FROM durable_metadata WHERE singleton = 1').get()
            .next_seq
        ) - 1,
      receipts: database
        .prepare(
          "SELECT COUNT(*) AS n FROM documents WHERE record LIKE '%pi.guarded-abort-receipts%'"
        )
        .get().n,
    }
  } finally {
    database.close()
  }
}
const ledgerIds = async (path) => {
  const reader = await node.openNodeSqliteStorage(path, { mode: 'read-only' })
  try {
    const found = await reader.scanDocuments(
      { scope: { kind: 'session' }, kind: 'pi.guarded-abort-receipts', at: 'current' },
      5,
      undefined,
      context
    )
    const materialized = await reader.document(found.items[0].id, 'current', context)
    return materialized.value.receipts.map((receipt) => receipt.requestId)
  } finally {
    await reader.close(context)
  }
}
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 20))
// An abort request whose `prepare` runs on the mutation line (so it is admitted) and waits for the gate.
function gatedRequest(requestId, gate, onPrepare = () => {}) {
  return {
    ...abortRequest(requestId),
    async prepare() {
      onPrepare()
      await gate.promise
      return () => {}
    },
  }
}
const gate = () => {
  let release
  const promise = new Promise((resolveGate) => (release = resolveGate))
  return { promise, release }
}
// A fresh store, fence held by the test's owner, a real Harness over it.
async function open(over) {
  const path = dbPath()
  const storage = await node.openNodeSqliteStorage(path)
  await storage.acquireWriterFence(holder(over))
  const opened = await openHarness(storage)
  return { path, storage, ...opened }
}
const countStorageCommits = (storage) => {
  const tally = { commits: 0 }
  for (const name of ['commit', 'commitGuarded']) {
    const original = storage[name].bind(storage)
    storage[name] = (...args) => {
      tally.commits += 1
      return original(...args)
    }
  }
  return tally
}

describe('candidate Session admission sealing (disposable SQLite, patched SDK copy only)', () => {
  test('admitted commits settle before the closure, which names exactly their cut; later commits never reach storage', async () => {
    const { path, storage, harness, root } = await open()
    const first = gate()
    let prepared = 0
    const one = root.commitAbort(
      gatedRequest('cancel:one', first, () => (prepared += 1)),
      context
    )
    await tick()
    expect(prepared).toBe(1) // on the line, holding it
    const two = root.commitAbort(abortRequest('cancel:two'), context) // admitted behind it
    await tick()
    const spy = countStorageCommits(storage)

    const closing = harness.closeWriters({ mutationId: 'mutation:seal' }, context)
    // Admission is sealed synchronously: nothing new gets in, and nothing new reaches storage.
    expect(await code(root.commitAbort(abortRequest('cancel:late'), context))).toBe(
      'Session is closed'
    )
    expect(await code(harness.root(context))).toBe('Harness is closed') // the Harness mirrors the seal
    expect(await code(harness.commit(async () => 1, context))).toBe('Session is closed')
    expect(spy.commits).toBe(0)

    first.release()
    const receipt = await closing
    expect((await one).requestId).toBe('cancel:one')
    expect((await two).requestId).toBe('cancel:two')

    // The closure came after both admitted commits settled, and its cut is exactly their highest sequence.
    const file = inspect(path)
    expect(file.closures).toBe(1)
    expect(file.epoch).toBe(receipt.epoch)
    expect(receipt.lastSeq).toBe(file.lastSeq)
    expect(await ledgerIds(path)).toEqual(['cancel:one', 'cancel:two'])
    expect(
      assertPiWriterClosureReceipt(receipt, {
        mutationId: 'mutation:seal',
        lineageId: 'lineage:1',
        generation: 'gen:1',
        previousEpoch: 1,
        observedSeq: file.lastSeq,
      }).qualifiedAuthorization
    ).toBe(false)
    expect(listing(path)).toEqual([path.split('/').at(-1)]) // closed cleanly: no sidecars
    expect(await code(storage.document('x', 'current', context))).toBe('SqliteStorage is closed')
  })

  test('control: the storage-level closure alone does not settle an admitted commit; it loses the race and is fenced', async () => {
    const { path, storage, root } = await open()
    const held = gate()
    const pending = root.commitAbort(gatedRequest('cancel:one', held), context)
    await tick()
    const receipt = await storage.closeWriterFence({ mutationId: 'mutation:storage-only' })
    held.release()
    expect(await code(pending)).toBe('PI_STORE_FENCED')
    // Admission was never sealed: the Session still accepts callers, and each commit is fenced one by one.
    expect(await code(root.commitAbort(abortRequest('cancel:two'), context))).toBe(
      'PI_STORE_FENCED'
    )
    await storage.close(context)
    // Nothing was committed after the closure.
    expect(inspect(path).lastSeq).toBe(receipt.lastSeq)
  })

  test('same mutationId returns the same receipt and bumps nothing; another mutationId is a conflict; close() adds no closure', async () => {
    const { path, harness } = await open()
    const request = { mutationId: 'mutation:once' }
    const first = harness.closeWriters(request, context)
    const again = harness.closeWriters(request, context)
    const other = harness.closeWriters({ mutationId: 'mutation:other' }, context)
    expect(await code(other)).toBe('PI_SESSION_CLOSURE_CONFLICT')
    const receipt = await first
    expect(await again).toEqual(receipt)
    await harness.close(context)
    expect(await harness.closeWriters(request, context)).toEqual(receipt) // lost-response retry on the same Session
    const file = inspect(path)
    expect(file.closures).toBe(1)
    expect(file.epoch).toBe(receipt.epoch)
  })

  test('closeWriters after close() has begun is refused and takes no closure', async () => {
    const { path, harness } = await open()
    const closing = harness.close(context)
    expect(await code(harness.closeWriters({ mutationId: 'mutation:too-late' }, context))).toBe(
      'PI_SESSION_CLOSING'
    )
    await closing
    const file = inspect(path)
    expect(file.closures).toBe(0)
    expect(file.epoch).toBe(1) // still the acquisition epoch
  })

  test('a closure that fails still ends in a closed Session and storage, and rejects with the storage code', async () => {
    const path = dbPath()
    const storage = await node.openNodeSqliteStorage(path) // no fence was ever acquired
    const { harness, root } = await openHarness(storage)
    expect(await code(harness.closeWriters({ mutationId: 'mutation:unheld' }, context))).toBe(
      'PI_STORE_FENCE_NOT_HELD'
    )
    expect(await code(root.commitAbort(abortRequest('cancel:after'), context))).toBe(
      'Session is closed'
    )
    expect(await code(harness.root(context))).toBe('Harness is closed')
    expect(await code(storage.document('x', 'current', context))).toBe('SqliteStorage is closed')
    expect(listing(path)).toEqual([path.split('/').at(-1)])
    expect(inspect(path).closures).toBe(0)
  })

  test('a storage without closeWriterFence, or an invalid request, is refused before sealing and the Session stays usable', async () => {
    const path = dbPath()
    const real = await node.openNodeSqliteStorage(path)
    await real.acquireWriterFence(holder())
    const bare = new Proxy(real, {
      get: (target, key) =>
        key === 'closeWriterFence' ? undefined : Reflect.get(target, key, target),
    })
    const { harness, root } = await openHarness(bare)
    expect(await code(harness.closeWriters({ mutationId: 'mutation:bare' }, context))).toBe(
      'PI_SESSION_CLOSE_WRITERS_UNAVAILABLE'
    )
    expect(await code(harness.closeWriters({ mutationId: '' }, context))).toBe(
      'PI_SESSION_CLOSE_WRITERS_REQUEST_INVALID'
    )
    expect(await code(harness.closeWriters(undefined, context))).toBe(
      'PI_SESSION_CLOSE_WRITERS_REQUEST_INVALID'
    )
    expect((await root.commitAbort(abortRequest('cancel:still-open'), context)).requestId).toBe(
      'cancel:still-open'
    )
    await harness.close(context)
    expect(inspect(path).closures).toBe(0)
  })

  test('a poisoned Session refuses closeWriters and takes no closure; the caller still closes it', async () => {
    const { path, storage, harness, root } = await open()
    const original = storage.commitGuarded.bind(storage)
    storage.commitGuarded = () => Promise.reject(new Error('disk exploded')) // not StorageRejected: poisons the Session
    expect(await code(root.commitAbort(abortRequest('cancel:poison'), context))).toBe(
      'disk exploded'
    )
    storage.commitGuarded = original
    expect(
      await code(harness.closeWriters({ mutationId: 'mutation:poisoned' }, context))
    ).toStartWith('Session is poisoned by a failed commit')
    await harness.close(context)
    expect(inspect(path).closures).toBe(0)
  })

  test('the closure is the cut a read-only reader sees: same ledger, and nothing after it', async () => {
    const { path, storage, harness, root } = await open()
    const receipts = []
    for (const id of ['cancel:one', 'cancel:two', 'cancel:three'])
      receipts.push(await root.commitAbort(abortRequest(id), context))
    const closure = await harness.closeWriters({ mutationId: 'mutation:cut' }, context)
    const before = { sha256: digest(path), entries: listing(path) }
    expect(await ledgerIds(path)).toEqual(['cancel:one', 'cancel:two', 'cancel:three'])
    expect({ sha256: digest(path), entries: listing(path) }).toEqual(before) // the read-only open changed nothing
    expect(inspect(path).lastSeq).toBe(closure.lastSeq)
    // A stranger opening the file afterwards is fenced.
    const stranger = await node.openNodeSqliteStorage(path)
    const late = await openHarness(stranger)
    expect(await code(late.root.commitAbort(abortRequest('cancel:late'), context))).toBe(
      'PI_STORE_FENCED'
    )
    await late.harness.close(context)
    expect(receipts.length).toBe(3)
    expect(await code(storage.document('x', 'current', context))).toBe('SqliteStorage is closed')
  })

  test('pre-seal validation matches the storage closure: every ID C4 refuses leaves the Session usable, and a corrected retry works', async () => {
    const invalid = [' padded', 'padded ', '\ttabbed', 'new\nline\n', 'x'.repeat(8193), 5, null]
    // Parity: the storage closure itself refuses each of them.
    const probePath = dbPath()
    const probe = await node.openNodeSqliteStorage(probePath)
    await probe.acquireWriterFence(holder())
    for (const mutationId of invalid)
      expect(await code(probe.closeWriterFence({ mutationId }))).toBe(
        'PI_STORE_CLOSURE_REQUEST_INVALID'
      )
    await probe.close(context)

    const { path, harness, root } = await open()
    for (const mutationId of invalid)
      expect(await code(harness.closeWriters({ mutationId }, context))).toBe(
        'PI_SESSION_CLOSE_WRITERS_REQUEST_INVALID'
      )
    // Nothing sealed: the Session still commits and still opens conversations.
    expect((await root.commitAbort(abortRequest('cancel:still-open'), context)).requestId).toBe(
      'cancel:still-open'
    )
    expect(await harness.root(context)).toBeDefined()
    // The longest accepted ID (8192 characters) is accepted by both layers.
    const longest = 'x'.repeat(8192)
    const receipt = await harness.closeWriters({ mutationId: longest }, context)
    expect(receipt.mutationId).toBe(longest)
    expect(inspect(path).closures).toBe(1)
  })

  test('a running task is aborted at the seal and joined before the closure is taken', async () => {
    const log = []
    const GatedTask = sdk.defineTask({
      name: 'candidate.gated',
      version: 1,
      initial: () => ({ phase: 'wait' }),
      phases: {
        wait: async (_task, _runtime, taskContext) => {
          log.push('task-started')
          await new Promise((resolveAbort) =>
            taskContext.abortSignal.addEventListener('abort', resolveAbort, { once: true })
          )
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
          log.push('task-ended')
        },
      },
      abort: async () => {},
    })
    const registry = sdk.createRegistry()
    registry.install({ name: 'candidate', tasks: [GatedTask] })
    const path = dbPath()
    const storage = await node.openNodeSqliteStorage(path)
    await storage.acquireWriterFence(holder())
    const closeWriterFence = storage.closeWriterFence.bind(storage)
    storage.closeWriterFence = (request) => (log.push('closure'), closeWriterFence(request))
    const harness = await sdk.Harness.open(
      storage,
      { models: createModels(), registry, settings: { compaction: { enabled: false } } },
      context
    )
    const root = await harness.root(context)
    harness.resume()
    await harness.commit(
      (tx) =>
        tx.createTask(
          GatedTask,
          {},
          { ownership: { kind: 'conversation' }, conversationId: root.id }
        ),
      context
    )
    await tick()
    expect(log).toEqual(['task-started'])
    log.push('closeWriters')
    const receipt = await harness.closeWriters({ mutationId: 'mutation:task' }, context)
    expect(log).toEqual(['task-started', 'closeWriters', 'task-ended', 'closure'])
    expect(receipt.lastSeq).toBe(inspect(path).lastSeq)
  })

  test('the real Harness join cannot reject: a task that throws while being aborted does not stop the closure', async () => {
    const ThrowingTask = sdk.defineTask({
      name: 'candidate.throwing',
      version: 1,
      initial: () => ({ phase: 'wait' }),
      phases: {
        wait: async (_task, _runtime, taskContext) => {
          await new Promise((resolveAbort) =>
            taskContext.abortSignal.addEventListener('abort', resolveAbort, { once: true })
          )
          throw new Error('task exploded')
        },
      },
      abort: async () => {},
    })
    const registry = sdk.createRegistry()
    registry.install({ name: 'candidate-throwing', tasks: [ThrowingTask] })
    const path = dbPath()
    const storage = await node.openNodeSqliteStorage(path)
    await storage.acquireWriterFence(holder())
    const harness = await sdk.Harness.open(
      storage,
      {
        models: createModels(),
        registry,
        settings: { compaction: { enabled: false } },
        onReport: () => {},
      },
      context
    )
    const root = await harness.root(context)
    harness.resume()
    await harness.commit(
      (tx) =>
        tx.createTask(
          ThrowingTask,
          {},
          { ownership: { kind: 'conversation' }, conversationId: root.id }
        ),
      context
    )
    await tick()
    const receipt = await harness.closeWriters({ mutationId: 'mutation:throwing' }, context)
    expect(receipt.mutationId).toBe('mutation:throwing')
    expect(inspect(path).closures).toBe(1)
  })

  test('a join that rejects (injected; the real Harness join cannot) skips the closure but still closes Session and storage', async () => {
    const path = dbPath()
    const storage = await node.openNodeSqliteStorage(path)
    await storage.acquireWriterFence(holder())
    const session = sdk.createSession(storage)
    session.beforeClose = () => Promise.reject(new Error('join exploded'))
    expect(await code(session.closeWriters({ mutationId: 'mutation:join' }, context))).toBe(
      'join exploded'
    )
    expect(await code(session.commit(async () => 1, context))).toBe('Session is closed')
    expect(await code(storage.document('x', 'current', context))).toBe('SqliteStorage is closed')
    expect(listing(path)).toEqual([path.split('/').at(-1)])
    expect(inspect(path).closures).toBe(0)
    expect(inspect(path).epoch).toBe(1) // acquisition epoch: no closure was taken
    expect(await code(session.closeWriters({ mutationId: 'mutation:join' }, context))).toBe(
      'join exploded'
    ) // memoized outcome
  })

  test("cancelling the caller's context does not cancel the closure: a retry with the same mutationId gets the receipt", async () => {
    const { path, root, harness } = await open()
    const held = gate()
    const pending = root.commitAbort(gatedRequest('cancel:one', held), context)
    await tick()
    const controller = new AbortController()
    const closing = harness.closeWriters(
      { mutationId: 'mutation:cancel' },
      withAbortSignal(controller.signal, context)
    )
    controller.abort(new Error('caller gave up'))
    expect(await code(closing)).toBe('caller gave up')
    // Sealed and still pending: nothing new gets in, and the closure has not been taken.
    expect(await code(harness.commit(async () => 1, context))).toBe('Session is closed')
    held.release()
    expect((await pending).requestId).toBe('cancel:one')
    const receipt = await harness.closeWriters({ mutationId: 'mutation:cancel' }, context)
    expect(receipt.mutationId).toBe('mutation:cancel')
    expect(inspect(path).closures).toBe(1)
    expect(inspect(path).lastSeq).toBe(receipt.lastSeq)

    // A context that is already aborted still seals and closes, and its result is still retrievable.
    const second = await open()
    const already = new AbortController()
    already.abort(new Error('already gone'))
    expect(
      await code(
        second.harness.closeWriters(
          { mutationId: 'mutation:aborted' },
          withAbortSignal(already.signal, context)
        )
      )
    ).toBe('already gone')
    expect(
      (await second.harness.closeWriters({ mutationId: 'mutation:aborted' }, context)).mutationId
    ).toBe('mutation:aborted')
    expect(inspect(second.path).closures).toBe(1)
  })

  test("cleanup removes only this run's own directories: a sibling run's sentinel under the same base survives", () => {
    const base = mkdtempSync(join(dir, 'cleanup-base-'))
    const mine = [mkdtempSync(join(base, 'sdk-')), mkdtempSync(join(base, 'db-'))]
    const sibling = mkdtempSync(join(base, 'sdk-'))
    const sentinel = join(sibling, 'sentinel')
    writeFileSync(sentinel, 'active')
    removeOwned(base, mine)
    expect(mine.some((path) => existsSync(path))).toBe(false)
    expect(readFileSync(sentinel, 'utf8')).toBe('active')
    removeOwned(base, [sibling])
    expect(existsSync(base)).toBe(false)
  })
})
