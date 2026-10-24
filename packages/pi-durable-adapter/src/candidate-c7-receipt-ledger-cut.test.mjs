import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
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
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { assertPiWriterClosureReceipt } from './cancellation-registration.ts'
import { readPiFrozenReceipt, sealPiReceiptSnapshot } from './restore-generation-authority.ts'

// CANDIDATE C7, receipt-ledger same-cut proof. Offline and disposable only.
//
// It shows, on temporary copies of the installed SDK with the compat, C2, C4 and C7 candidate patches applied and on
// disposable SQLite files, that the `pi.guarded-abort-receipts` ledger read through the C7 read-only open is the same
// ledger, from the same cut, that a read-write reopen of a byte copy of the same store reads, and that the cut is the one a C4
// closure receipt names. Both ledgers then seal and read identically through the #1312 snapshot reader.
//
// Limits. The replay below is test code, not a production issuer. The provenance passed to `sealPiReceiptSnapshot` is
// this test's own assertion, as for any issuer, and is not SDK attestation. The cut is identified by a C4 closure on one
// storage object. The writer is closed first; `Harness.close` then closes the storage it was given and writes nothing in
// these tests, which the unchanged `lastSeq` shows. This proves nothing about another process, a crashed owner or a store that
// was not closed this way, and it describes no quiescent-capture method. Nothing here adopts the SDK, issues anything,
// captures anything or touches a live store.
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
]
const compatPatch = join(repoRoot, 'patches/@earendil-works%2Fpi-durable@1.1.0.patch')
const scratchBase = join(dirname(installed), '.c7-ledger-test')

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
const pinsFor = (requestId, over = {}) => ({
  sessionId: 'ses_ledger',
  requestId,
  requestDigest: hash('a'),
  targetDigest: hash('b'),
  expiresAt: '2026-10-20T12:01:00.000Z',
  turnKey: 'turn:initial',
  inferenceId: 'native:1',
  ...over,
})
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
// Writes the given receipts as the fence holder, closes the writers (C4), then shuts the Harness down (which closes
// the storage object it was given).
async function produce(path, requestIds, { expectedEpoch = 0, mutationId } = {}) {
  const storage = await node.openNodeSqliteStorage(path)
  await storage.acquireWriterFence(holder({ expectedEpoch }))
  const { harness, root } = await openHarness(storage)
  const receipts = []
  for (const id of requestIds) receipts.push(await root.commitAbort(abortRequest(id), context))
  // Harness.close closes the storage it owns and writes nothing (no task is running here), so the writers are closed
  // first; the closure's lastSeq is then compared with what the reopened file holds, which proves close wrote nothing.
  const closure =
    mutationId === undefined ? undefined : await storage.closeWriterFence({ mutationId })
  await harness.close(context)
  return { storage, receipts, closure, conversationId: root.id }
}
// Test-local SELECT-only replay of the session ledger document through the storage's public reads, plus the cut it was
// read at. It never writes.
async function replay(storage) {
  const found = await storage.scanDocuments(
    { scope: { kind: 'session' }, kind: 'pi.guarded-abort-receipts', at: 'current' },
    5,
    undefined,
    context
  )
  expect(found.items.length).toBe(1)
  const materialized = await storage.document(found.items[0].id, 'current', context)
  const metadata = await storage.db.get('SELECT next_seq FROM durable_metadata WHERE singleton = 1')
  return { ledger: materialized.value, lastSeq: Number(metadata.next_seq) - 1 }
}
const sealed = (ledger, conversationId, ownerEpoch) =>
  sealPiReceiptSnapshot({
    provenance: {
      sessionId: 'ses_ledger',
      conversationId,
      restoreGeneration: 'restore:1',
      ownerEpoch,
      detached: true,
      coherent: true,
      access: 'select_only',
    },
    ledger,
  })

describe('candidate C7 receipt-ledger same-cut proof (disposable SQLite, patched SDK copy only)', () => {
  test('the read-only ledger equals the ledger a read-write reopen of a byte copy reads, from the same cut, and that cut is the C4 closure', async () => {
    const path = dbPath()
    const written = await produce(path, ['cancel:one', 'cancel:two'], {
      mutationId: 'mutation:ledger',
    })
    const { closure, receipts, conversationId } = written
    await written.storage.close(context)
    expect(receipts.length).toBe(2)

    // The cut is named by the closure: the former holder and any unfenced or unauthorized opener can no longer commit
    // after it. An authorized successor can still acquire the fence at the closure epoch and write (see the controls below).
    const stranger = await node.openNodeSqliteStorage(path)
    expect(
      await code(
        stranger
          .mintId()
          .then(() => stranger.commit([{ type: 'conversation', value: { id: 99 } }], context))
      )
    ).toBe('PI_STORE_FENCED')
    await stranger.close(context)

    // The comparator is a read-write reopen of a byte copy (no fence is acquired; a read-write open must not touch the
    // original).
    const copy = `${path}.rw-copy`
    copyFileSync(path, copy)
    const owner = await node.openNodeSqliteStorage(copy)
    const live = await replay(owner)
    await owner.close(context)

    const before = { sha256: digest(path), entries: listing(path) }
    const reader = await node.openNodeSqliteStorage(path, { mode: 'read-only' })
    const detached = await replay(reader)
    await reader.close(context)
    expect({ sha256: digest(path), entries: listing(path) }).toEqual(before)

    // Same ledger, same cut, and the cut is exactly what the closure receipt names.
    expect(JSON.stringify(detached.ledger)).toBe(JSON.stringify(live.ledger))
    expect(detached.lastSeq).toBe(live.lastSeq)
    expect(detached.lastSeq).toBe(closure.lastSeq)
    expect(detached.ledger.receipts.map((r) => r.requestId)).toEqual(['cancel:one', 'cancel:two'])
    expect(
      assertPiWriterClosureReceipt(closure, {
        mutationId: 'mutation:ledger',
        lineageId: 'lineage:1',
        generation: 'gen:1',
        previousEpoch: 1,
        observedSeq: detached.lastSeq,
      }).qualifiedAuthorization
    ).toBe(false)

    // Both ledgers seal and read identically through the #1312 snapshot reader.
    const fromReader = sealed(detached.ledger, conversationId, closure.epoch)
    const fromOwner = sealed(live.ledger, conversationId, closure.epoch)
    for (const [index, id] of ['cancel:one', 'cancel:two'].entries()) {
      const a = readPiFrozenReceipt(fromReader, pinsFor(id))
      const b = readPiFrozenReceipt(fromOwner, pinsFor(id))
      expect(a.outcome).toBe('found')
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      expect(a.receipt).toEqual(receipts[index])
      expect(Object.isFrozen(a)).toBe(true)
      expect(Object.isFrozen(a.receipt.metadata)).toBe(true)
    }
    expect(readPiFrozenReceipt(fromReader, pinsFor('cancel:missing'))).toEqual({
      outcome: 'absent',
    })
    expect(readPiFrozenReceipt(fromOwner, pinsFor('cancel:missing'))).toEqual({ outcome: 'absent' })
  })

  test('a receipt committed after the closure cannot enter the cut: a stranger Harness is fenced and the store is unchanged', async () => {
    const path = dbPath()
    const { storage, closure } = await produce(path, ['cancel:one'], {
      mutationId: 'mutation:late',
    })
    await storage.close(context)
    const before = { sha256: digest(path), entries: listing(path) }

    const stranger = await node.openNodeSqliteStorage(path)
    const late = await openHarness(stranger)
    expect(await code(late.root.commitAbort(abortRequest('cancel:late'), context))).toBe(
      'PI_STORE_FENCED'
    )
    await late.harness.close(context)
    expect({ sha256: digest(path), entries: listing(path) }).toEqual(before)

    const reader = await node.openNodeSqliteStorage(path, { mode: 'read-only' })
    const detached = await replay(reader)
    await reader.close(context)
    expect(detached.lastSeq).toBe(closure.lastSeq)
    expect(detached.ledger.receipts.map((r) => r.requestId)).toEqual(['cancel:one'])
    const snapshot = sealed(detached.ledger, 1, closure.epoch)
    expect(readPiFrozenReceipt(snapshot, pinsFor('cancel:late'))).toEqual({ outcome: 'absent' })
  })

  test("a receipt that lives only in a successor owner's WAL is not in the closure cut, and the read-only open refuses rather than reading the stale file", async () => {
    const path = dbPath()
    const first = await produce(path, ['cancel:one'], { mutationId: 'mutation:first' })
    await first.storage.close(context)
    const { closure } = first

    // A successor takes the fence at the closure epoch and commits another receipt; its WAL is not checkpointed.
    const successor = await node.openNodeSqliteStorage(path)
    await successor.acquireWriterFence(
      holder({ ownerKey: 'owner:next', expectedEpoch: closure.epoch })
    )
    const next = await openHarness(successor)
    await next.root.commitAbort(abortRequest('cancel:three'), context)
    expect(listing(path).length).toBeGreaterThan(1)

    // Refused: this is the only way a reader could be told the main file is not the whole truth.
    expect(await code(node.openNodeSqliteStorage(path, { mode: 'read-only' }))).toBe(
      'PI_STORE_READ_ONLY_SIDECARS'
    )
    // Control: the main file alone is stale and still sits exactly at the closure cut, so a lexical or lenient read
    // would have produced a ledger that is not the successor's.
    const stale = immutableDatabase(path)
    let staleLastSeq
    try {
      staleLastSeq =
        Number(
          stale.prepare('SELECT next_seq FROM durable_metadata WHERE singleton = 1').get().next_seq
        ) - 1
    } finally {
      stale.close()
    }
    expect(staleLastSeq).toBe(closure.lastSeq)
    const owner = await replay(successor)
    expect(owner.lastSeq).toBeGreaterThan(closure.lastSeq)
    expect(owner.ledger.receipts.map((r) => r.requestId)).toEqual(['cancel:one', 'cancel:three'])
    await next.harness.close(context)
  })

  test('the equality has teeth: a successor that acquires the fence on a copy and commits one more receipt differs in ledger, cut and read outcome', async () => {
    const path = dbPath()
    const { storage, closure, conversationId } = await produce(path, ['cancel:one'], {
      mutationId: 'mutation:teeth',
    })
    await storage.close(context)
    const reader = await node.openNodeSqliteStorage(path, { mode: 'read-only' })
    const detached = await replay(reader)
    await reader.close(context)

    const copy = `${path}.rw-copy`
    copyFileSync(path, copy)
    const owner = await node.openNodeSqliteStorage(copy)
    await owner.acquireWriterFence(holder({ ownerKey: 'owner:next', expectedEpoch: closure.epoch }))
    const next = await openHarness(owner)
    await next.root.commitAbort(abortRequest('cancel:extra'), context)
    const live = await replay(owner)
    await next.harness.close(context)

    expect(JSON.stringify(live.ledger)).not.toBe(JSON.stringify(detached.ledger))
    expect(live.lastSeq).toBeGreaterThan(detached.lastSeq)
    expect(
      readPiFrozenReceipt(
        sealed(detached.ledger, conversationId, closure.epoch),
        pinsFor('cancel:extra')
      )
    ).toEqual({
      outcome: 'absent',
    })
    expect(
      readPiFrozenReceipt(
        sealed(live.ledger, conversationId, closure.epoch + 1),
        pinsFor('cancel:extra')
      ).outcome
    ).toBe('found')
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
    // Control: the shared base is removed only once nothing else is left in it.
    removeOwned(base, [sibling])
    expect(existsSync(base)).toBe(false)
  })
})
