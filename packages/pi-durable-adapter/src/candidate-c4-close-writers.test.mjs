import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertPiWriterClosureReceipt } from './cancellation-registration.ts'

// CANDIDATE C4. Applies the compat patch, the C2 candidate and the C4 candidate only to temporary copies of the
// installed SDK.
const here = dirname(fileURLToPath(import.meta.url))
const adapterRoot = resolve(here, '..')
const repoRoot = resolve(adapterRoot, '../..')
// The install layout differs between installs (a per-package symlink locally, a hoisted root hosted), so the
// SDK is found through module resolution rather than a fixed node_modules path.
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
const c2Patch = join(adapterRoot, 'candidates/c2-store-fence/c2-store-fence.candidate.patch')
const c4Patch = join(adapterRoot, 'candidates/c4-close-writers/c4-close-writers.candidate.patch')
const scratchBase = join(dirname(installed), '.c4-candidate-test')

const roots = []
function makeSdk({ c4 }) {
  mkdirSync(scratchBase, { recursive: true })
  const root = mkdtempSync(join(scratchBase, 'sdk-'))
  const pkg = join(root, 'pi-durable')
  cpSync(installed, pkg, { recursive: true, dereference: true })
  execFileSync('git', ['init', '-q'], { cwd: pkg })
  if (!existsSync(join(pkg, 'dist/harness/guarded-abort.js'))) {
    execFileSync('git', ['apply', compatPatch], { cwd: pkg })
    if (!existsSync(join(pkg, 'dist/harness/guarded-abort.js')))
      throw new Error('compatibility patch did not apply to the copy')
  }
  execFileSync('git', ['apply', c2Patch], { cwd: pkg })
  if (c4) {
    execFileSync('git', ['apply', c4Patch], { cwd: pkg })
    if (
      !readFileSync(join(pkg, 'dist/storage/sqlite/storage.js'), 'utf8').includes(
        'closeWriterFence'
      )
    )
      throw new Error('C4 patch did not apply to the copy')
  }
  roots.push(root)
  return pkg
}
const load = (pkg) => import(pathToFileURL(join(pkg, 'dist/storage/sqlite/node.js')).href)

let c4
let c2only
let dir
let counter = 0
const context = {}
beforeAll(async () => {
  c4 = await load(makeSdk({ c4: true }))
  c2only = await load(makeSdk({ c4: false }))
  dir = mkdtempSync(join(scratchBase, 'db-'))
  roots.push(dir)
})
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
const dbPath = () => join(dir, `store-${counter++}.sqlite`)
const acquireRequest = (over = {}) => ({
  ownerKey: 'owner:a',
  lineageId: 'lineage:1',
  generation: 'gen:1',
  expectedEpoch: 0,
  ...over,
})
async function write(storage) {
  const id = await storage.mintId()
  return storage.commit([{ type: 'conversation', value: { id } }], context)
}
const code = async (promise) => {
  try {
    await promise
  } catch (error) {
    return error.message
  }
  return 'no error'
}
const rows = (path, sql) => {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }))
  } finally {
    database.close()
  }
}
const fenceEpoch = (path) => rows(path, 'SELECT epoch FROM durable_writer_fence')[0].epoch
async function heldStorage(path = dbPath()) {
  const storage = await c4.openNodeSqliteStorage(path)
  await storage.acquireWriterFence(acquireRequest())
  return { storage, path }
}

describe('candidate C4 closeWriterFence (disposable SQLite, patched copy only)', () => {
  test('the receipt is committed with the epoch bump and validates through the real assertion', async () => {
    const { storage, path } = await heldStorage()
    await write(storage)
    const lastSeq = await write(storage)
    const receipt = await storage.closeWriterFence({ mutationId: 'mutation:one' })
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(receipt).toMatchObject({
      schemaVersion: 'pi-writer-closure-receipt/v1',
      mutationId: 'mutation:one',
      ownerKey: 'owner:a',
      lineageId: 'lineage:1',
      generation: 'gen:1',
      previousEpoch: 1,
      epoch: 2,
      lastSeq,
      settledInFlight: true,
    })
    const evidence = assertPiWriterClosureReceipt(receipt, {
      mutationId: 'mutation:one',
      lineageId: 'lineage:1',
      generation: 'gen:1',
      previousEpoch: 1,
      observedSeq: lastSeq,
    })
    expect(evidence.qualifiedAuthorization).toBe(false)
    // Evidence is in the store, readable through a separate read-only connection to the live database file.
    expect(fenceEpoch(path)).toBe(2)
    expect(rows(path, 'SELECT * FROM durable_writer_closure')).toEqual([
      {
        mutation_id: 'mutation:one',
        owner_key: 'owner:a',
        lineage_id: 'lineage:1',
        generation: 'gen:1',
        previous_epoch: 1,
        epoch: 2,
        last_seq: lastSeq,
        closed_at: receipt.closedAt,
      },
    ])
    await storage.close(context)
  })

  test('after the close, the former holder and any other writer are fenced and nothing is written', async () => {
    const { storage, path } = await heldStorage()
    const lastSeq = await write(storage)
    const receipt = await storage.closeWriterFence({ mutationId: 'mutation:fence' })
    const stranger = await c4.openNodeSqliteStorage(path)
    expect(await code(write(storage))).toBe('PI_STORE_FENCED')
    expect(await code(write(stranger))).toBe('PI_STORE_FENCED')
    // Neither refused commit moved the sequence past the receipt.
    const another = await c4.openNodeSqliteStorage(path)
    await another.acquireWriterFence(
      acquireRequest({ ownerKey: 'owner:b', expectedEpoch: receipt.epoch })
    )
    expect(await write(another)).toBe(lastSeq + 1)
    await storage.close(context)
    await stranger.close(context)
    await another.close(context)
  })

  test('commits issued but not awaited before the close settle first, and lastSeq covers them', async () => {
    const { storage } = await heldStorage()
    const pending = [write(storage), write(storage), write(storage)]
    const closing = storage.closeWriterFence({ mutationId: 'mutation:inflight' })
    const results = await Promise.allSettled(pending)
    const receipt = await closing
    // Whatever committed before the close is at or below lastSeq; whatever came after was fenced and wrote nothing.
    const committed = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    for (const seq of committed) expect(seq).toBeLessThanOrEqual(receipt.lastSeq)
    for (const refused of results.filter((r) => r.status === 'rejected'))
      expect(refused.reason.message).toBe('PI_STORE_FENCED')
    expect(receipt.lastSeq).toBe(committed.length === 0 ? receipt.lastSeq : Math.max(...committed))
    await storage.close(context)
  })

  test('a replay on the same storage returns the same receipt; another storage with the same id conflicts', async () => {
    const { storage, path } = await heldStorage()
    const first = await storage.closeWriterFence({ mutationId: 'mutation:replay' })
    const second = await storage.closeWriterFence({ mutationId: 'mutation:replay' })
    expect(second).toBe(first)
    expect(fenceEpoch(path)).toBe(2)
    expect(rows(path, 'SELECT mutation_id FROM durable_writer_closure').length).toBe(1)
    const other = await c4.openNodeSqliteStorage(path)
    await other.acquireWriterFence(acquireRequest({ ownerKey: 'owner:b', expectedEpoch: 2 }))
    expect(await code(other.closeWriterFence({ mutationId: 'mutation:replay' }))).toBe(
      'PI_STORE_CLOSURE_CONFLICT'
    )
    // The conflict left the epoch where the acquire put it and added no receipt.
    expect(fenceEpoch(path)).toBe(3)
    expect(rows(path, 'SELECT mutation_id FROM durable_writer_closure').length).toBe(1)
    await storage.close(context)
    await other.close(context)
  })

  // One negative control per stored field: a replay returns cached evidence only while the whole stored row equals it.
  const tampers = {
    owner_key: "owner_key = 'owner:evil'",
    lineage_id: "lineage_id = 'lineage:evil'",
    generation: "generation = 'gen:evil'",
    previous_epoch: 'previous_epoch = previous_epoch + 1',
    epoch: 'epoch = epoch + 1',
    last_seq: 'last_seq = last_seq + 1',
    closed_at: "closed_at = '2000-01-01T00:00:00.000Z'",
  }
  for (const [field, assignment] of Object.entries(tampers))
    test(`a replay is refused when the stored ${field} no longer matches the cached receipt`, async () => {
      const { storage, path } = await heldStorage()
      await write(storage)
      const receipt = await storage.closeWriterFence({ mutationId: 'mutation:tamper' })
      // Control: before any change, the replay returns the identical cached receipt.
      expect(await storage.closeWriterFence({ mutationId: 'mutation:tamper' })).toBe(receipt)
      const raw = new DatabaseSync(path)
      raw.exec(
        `UPDATE durable_writer_closure SET ${assignment} WHERE mutation_id = 'mutation:tamper'`
      )
      raw.close()
      const before = rows(path, 'SELECT * FROM durable_writer_closure')
      const epochBefore = fenceEpoch(path)
      expect(await code(storage.closeWriterFence({ mutationId: 'mutation:tamper' }))).toBe(
        'PI_STORE_CLOSURE_CONFLICT'
      )
      // The refused replay re-issued nothing and moved no epoch.
      expect(rows(path, 'SELECT * FROM durable_writer_closure')).toEqual(before)
      expect(fenceEpoch(path)).toBe(epochBefore)
      await storage.close(context)
    })

  test('a replay is refused when the stored row is gone', async () => {
    const { storage, path } = await heldStorage()
    await storage.closeWriterFence({ mutationId: 'mutation:gone' })
    const raw = new DatabaseSync(path)
    raw.exec("DELETE FROM durable_writer_closure WHERE mutation_id = 'mutation:gone'")
    raw.close()
    expect(await code(storage.closeWriterFence({ mutationId: 'mutation:gone' }))).toBe(
      'PI_STORE_CLOSURE_CONFLICT'
    )
    expect(fenceEpoch(path)).toBe(2)
    expect(rows(path, 'SELECT mutation_id FROM durable_writer_closure')).toEqual([])
    await storage.close(context)
  })

  // Holds the first transaction.get of the next transaction until released.
  function gateNextGet(storage) {
    const db = storage.db
    const original = db.transaction.bind(db)
    let release
    let reached
    const gate = new Promise((open) => (release = open))
    const entered = new Promise((arrive) => (reached = arrive))
    db.transaction = (callback, ...rest) => {
      db.transaction = original
      return original(
        (transaction) => {
          const get = transaction.get.bind(transaction)
          transaction.get = async (...args) => {
            reached()
            await gate
            return get(...args)
          }
          return callback(transaction)
        },
        ...rest
      )
    }
    return { entered, release }
  }
  // The next transaction commits, then its result is lost to the caller.
  function loseNextResponse(storage) {
    const db = storage.db
    const original = db.transaction.bind(db)
    db.transaction = async (...args) => {
      db.transaction = original
      await original(...args)
      throw new Error('response lost')
    }
  }
  const closureRows = (path) => rows(path, 'SELECT * FROM durable_writer_closure')

  test('a concurrent duplicate shares one attempt: one row, one epoch bump, the same receipt', async () => {
    const { storage, path } = await heldStorage()
    await write(storage)
    const { entered, release } = gateNextGet(storage)
    const first = storage.closeWriterFence({ mutationId: 'mutation:dup' })
    await entered
    const second = storage.closeWriterFence({ mutationId: 'mutation:dup' })
    release()
    const [a, b] = await Promise.all([first, second])
    expect(b).toBe(a)
    expect(fenceEpoch(path)).toBe(2)
    expect(closureRows(path).length).toBe(1)
    await storage.close(context)
  })

  test('concurrent closes with different ids: exactly one wins and the other is fenced', async () => {
    const { storage, path } = await heldStorage()
    const results = await Promise.allSettled([
      storage.closeWriterFence({ mutationId: 'mutation:x' }),
      storage.closeWriterFence({ mutationId: 'mutation:y' }),
    ])
    expect(results.map((r) => r.status).toSorted()).toEqual(['fulfilled', 'rejected'])
    expect(results.find((r) => r.status === 'rejected').reason.message).toBe('PI_STORE_FENCED')
    expect(fenceEpoch(path)).toBe(2)
    expect(closureRows(path).length).toBe(1)
    await storage.close(context)
  })

  test('a response lost after the commit: the retry returns the persisted receipt, with no second row or bump', async () => {
    const { storage, path } = await heldStorage()
    await write(storage)
    loseNextResponse(storage)
    expect(await code(storage.closeWriterFence({ mutationId: 'mutation:lost' }))).toBe(
      'response lost'
    )
    // The commit survived: the epoch moved once and the row exists.
    expect(fenceEpoch(path)).toBe(2)
    const [persisted] = closureRows(path)
    const receipt = await storage.closeWriterFence({ mutationId: 'mutation:lost' })
    expect(receipt).toMatchObject({
      mutationId: 'mutation:lost',
      ownerKey: 'owner:a',
      lineageId: 'lineage:1',
      generation: 'gen:1',
      previousEpoch: 1,
      epoch: 2,
      lastSeq: persisted.last_seq,
      closedAt: persisted.closed_at,
    })
    expect(Object.isFrozen(receipt)).toBe(true)
    assertPiWriterClosureReceipt(receipt, {
      mutationId: 'mutation:lost',
      lineageId: 'lineage:1',
      generation: 'gen:1',
      previousEpoch: 1,
      observedSeq: persisted.last_seq,
    })
    expect(fenceEpoch(path)).toBe(2)
    expect(closureRows(path)).toEqual([persisted])
    // The storage is now unbound and a further replay returns the same retained receipt.
    expect(await storage.closeWriterFence({ mutationId: 'mutation:lost' })).toBe(receipt)
    expect(await code(write(storage))).toBe('PI_STORE_FENCED')
    await storage.close(context)
  })

  test('after a lost response, a different mutationId is not a replay and is fenced', async () => {
    const { storage, path } = await heldStorage()
    loseNextResponse(storage)
    await code(storage.closeWriterFence({ mutationId: 'mutation:lost-a' }))
    expect(await code(storage.closeWriterFence({ mutationId: 'mutation:lost-b' }))).toBe(
      'PI_STORE_FENCED'
    )
    expect(fenceEpoch(path)).toBe(2)
    expect(closureRows(path).length).toBe(1)
    await storage.close(context)
  })

  // The persisted row must match the retained holder evidence in every identity field before it is adopted.
  const identityTampers = {
    owner_key: "owner_key = 'owner:evil'",
    lineage_id: "lineage_id = 'lineage:evil'",
    generation: "generation = 'gen:evil'",
    previous_epoch: 'previous_epoch = previous_epoch + 1',
    epoch: 'epoch = epoch + 1',
  }
  for (const [field, assignment] of Object.entries(identityTampers))
    test(`after a lost response, a persisted ${field} that differs from the holder evidence is a conflict`, async () => {
      const { storage, path } = await heldStorage()
      loseNextResponse(storage)
      await code(storage.closeWriterFence({ mutationId: 'mutation:lost-tamper' }))
      const raw = new DatabaseSync(path)
      raw.exec(
        `UPDATE durable_writer_closure SET ${assignment} WHERE mutation_id = 'mutation:lost-tamper'`
      )
      raw.close()
      const before = closureRows(path)
      const epochBefore = fenceEpoch(path)
      expect(await code(storage.closeWriterFence({ mutationId: 'mutation:lost-tamper' }))).toBe(
        'PI_STORE_CLOSURE_CONFLICT'
      )
      expect(closureRows(path)).toEqual(before)
      expect(fenceEpoch(path)).toBe(epochBefore)
      await storage.close(context)
    })

  test('replay covers every mutation this storage closed, not only the latest', async () => {
    const { storage, path } = await heldStorage()
    const first = await storage.closeWriterFence({ mutationId: 'mutation:first' })
    // Reacquire on the same storage at the receipt epoch, write, then close a second mutation.
    await storage.acquireWriterFence(acquireRequest({ expectedEpoch: first.epoch }))
    const seq = await write(storage)
    const second = await storage.closeWriterFence({ mutationId: 'mutation:second' })
    expect(second.previousEpoch).toBe(3)
    expect(second.epoch).toBe(4)
    expect(second.lastSeq).toBe(seq)
    expect(await storage.closeWriterFence({ mutationId: 'mutation:first' })).toBe(first)
    expect(await storage.closeWriterFence({ mutationId: 'mutation:second' })).toBe(second)
    expect(fenceEpoch(path)).toBe(4)
    expect(closureRows(path).length).toBe(2)
    // The older mutation's evidence is still checked against its own stored row.
    const raw = new DatabaseSync(path)
    raw.exec(
      "UPDATE durable_writer_closure SET lineage_id = 'lineage:evil' WHERE mutation_id = 'mutation:first'"
    )
    raw.close()
    expect(await code(storage.closeWriterFence({ mutationId: 'mutation:first' }))).toBe(
      'PI_STORE_CLOSURE_CONFLICT'
    )
    expect(await storage.closeWriterFence({ mutationId: 'mutation:second' })).toBe(second)
    await storage.close(context)
  })

  test('an unbound storage cannot close', async () => {
    const storage = await c4.openNodeSqliteStorage(dbPath())
    expect(await code(storage.closeWriterFence({ mutationId: 'mutation:unbound' }))).toBe(
      'PI_STORE_FENCE_NOT_HELD'
    )
    await storage.close(context)
  })

  test('a holder that was already fenced by a later acquire cannot close, and writes nothing', async () => {
    const { storage, path } = await heldStorage()
    const second = await c4.openNodeSqliteStorage(path)
    await second.acquireWriterFence(acquireRequest({ ownerKey: 'owner:b', expectedEpoch: 1 }))
    expect(await code(storage.closeWriterFence({ mutationId: 'mutation:late' }))).toBe(
      'PI_STORE_FENCED'
    )
    expect(fenceEpoch(path)).toBe(2)
    expect(rows(path, 'SELECT mutation_id FROM durable_writer_closure')).toEqual([])
    await storage.close(context)
    await second.close(context)
  })

  test('a new owner acquires at the receipt epoch', async () => {
    const { storage, path } = await heldStorage()
    const receipt = await storage.closeWriterFence({ mutationId: 'mutation:handoff' })
    const next = await c4.openNodeSqliteStorage(path)
    const token = await next.acquireWriterFence(
      acquireRequest({ ownerKey: 'owner:b', expectedEpoch: receipt.epoch })
    )
    expect(token.epoch).toBe(receipt.epoch + 1)
    await storage.close(context)
    await next.close(context)
  })

  test('an exhausted epoch is refused before any write and no receipt row exists', async () => {
    const { storage, path } = await heldStorage()
    await storage.close(context)
    const raw = new DatabaseSync(path)
    raw.exec(`UPDATE durable_writer_fence SET epoch = ${Number.MAX_SAFE_INTEGER}`)
    raw.close()
    // Re-binding at the exhausted epoch is itself refused, so exercise the close guard through a storage whose
    // token matches the row: the row was edited to the exhausted value after the token was issued.
    const holder = await c4.openNodeSqliteStorage(path)
    holder.fence = {
      ownerKey: 'owner:a',
      epoch: Number.MAX_SAFE_INTEGER,
      lineageId: 'lineage:1',
      generation: 'gen:1',
    }
    expect(await code(holder.closeWriterFence({ mutationId: 'mutation:exhausted' }))).toBe(
      'PI_STORE_FENCE_EPOCH_EXHAUSTED'
    )
    expect(fenceEpoch(path)).toBe(Number.MAX_SAFE_INTEGER)
    expect(rows(path, 'SELECT mutation_id FROM durable_writer_closure')).toEqual([])
    await holder.close(context)
  })

  test('malformed requests are refused, and the request property is read exactly once', async () => {
    const { storage, path } = await heldStorage()
    for (const bad of [
      null,
      undefined,
      'x',
      {},
      { mutationId: '' },
      { mutationId: ' x' },
      { mutationId: 5 },
      { mutationId: 'x'.repeat(8193) },
    ])
      expect(await code(storage.closeWriterFence(bad))).toBe('PI_STORE_CLOSURE_REQUEST_INVALID')
    expect(fenceEpoch(path)).toBe(1)
    let reads = 0
    const input = {}
    Object.defineProperty(input, 'mutationId', {
      enumerable: true,
      get() {
        reads += 1
        return reads === 1 ? 'mutation:accessor' : 'mutation:evil'
      },
    })
    const receipt = await storage.closeWriterFence(input)
    expect(reads).toBe(1)
    expect(receipt.mutationId).toBe('mutation:accessor')
    expect(
      rows(path, 'SELECT mutation_id FROM durable_writer_closure').map((r) => r.mutation_id)
    ).toEqual(['mutation:accessor'])
    await storage.close(context)
  })

  test('a store with no closes behaves as C2 did; the epoch only moves on a successful close', async () => {
    const { storage, path } = await heldStorage()
    await write(storage)
    expect(fenceEpoch(path)).toBe(1)
    await storage.closeWriterFence({ mutationId: 'mutation:once' })
    expect(fenceEpoch(path)).toBe(2)
    await storage.close(context)
  })

  test('downgrade hazard: the C2-only SDK refuses a store migrated to schema 3', async () => {
    const path = dbPath()
    const storage = await c4.openNodeSqliteStorage(path)
    await storage.close(context)
    expect(
      rows(path, "SELECT name FROM sqlite_master WHERE name = 'durable_writer_closure'").length
    ).toBe(1)
    expect(await code(c2only.openNodeSqliteStorage(path))).toMatch(/newer than supported/)
  })
})
