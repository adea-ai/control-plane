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
    // Evidence is in the store, readable from a detached read-only snapshot.
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

  test('a replay is refused when the stored row no longer matches', async () => {
    const { storage, path } = await heldStorage()
    await storage.closeWriterFence({ mutationId: 'mutation:tamper' })
    const raw = new DatabaseSync(path)
    raw.exec(
      "UPDATE durable_writer_closure SET last_seq = last_seq + 1 WHERE mutation_id = 'mutation:tamper'"
    )
    raw.close()
    expect(await code(storage.closeWriterFence({ mutationId: 'mutation:tamper' }))).toBe(
      'PI_STORE_CLOSURE_CONFLICT'
    )
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
