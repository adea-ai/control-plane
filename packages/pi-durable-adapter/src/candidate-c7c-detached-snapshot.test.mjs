import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  PiRestoreGenerationEvidenceReader,
  readPiFrozenReceipt,
  sealPiReceiptSnapshot,
} from './restore-generation-authority.ts'

// CANDIDATE C7c, detached snapshot (method A: a closed-and-checkpointed disposable copy). Offline and disposable only.
//
// It exercises `sealSnapshot` / `snapshotFacts` / `withSnapshotStorage` from the c7c patch on temporary copies of the installed
// SDK with the compat, C2, C4, C7 and C7c patches applied, on disposable SQLite files. Nothing is exported from the SDK index,
// nothing in the adapter runtime calls it, and nothing here adopts the SDK, issues, captures or touches a live store.
//
// Limits (see docs/pi-durable-c7c-detached-snapshot-design.md). Coherent rows, stable bytes and an empty in-process registry do
// not show that any other process was quiescent or that the artifact came from the store the pins name; that is out-of-band
// attestation the caller owns. No caller-supplied boolean is attestation. The result is historical evidence of one committed
// cut and never settles a journal or authorizes an effect.
//
// Two layers are kept apart. The SDK candidate performs STRUCTURAL checks of a file and its rows (regular file, one link, no
// sidecars, closure, fence, cut, digest); its facts say nothing about how the file was made. How it was made (writers closed
// with C4, then a copy after a clean shutdown) is controlled FIXTURE provenance: the helpers `produce` and `copyOf` do those
// steps and assert the file listing, and the constant `CONTROLLED_FIXTURE` below is this file's own assertion of that. It is
// not derived by the SDK, is not production attestation, and a real issuer would need an out-of-band equivalent.
// `sealDetachedLedger` and `readPinnedFrozenReceipt` are test-local glue standing in for the candidate's sealing and read
// boundaries: they are NOT a production issuer and are not exported anywhere.
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
const candidate = (name) => join(adapterRoot, `candidates/${name}/${name}.candidate.patch`)
const patches = [
  'c2-store-fence',
  'c4-close-writers',
  'c7-read-only-open',
  'c7c-detached-snapshot',
].map(candidate)
const scratchBase = join(dirname(installed), '.c7c-snapshot-test')

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

const owned = []
let counter = 0
// One patched SDK copy plus a private directory for its disposable files. `edit` weakens one candidate file after patching, and
// is used only by the mutation proof at the end.
async function makeLab(edit) {
  mkdirSync(scratchBase, { recursive: true })
  const root = mkdtempSync(join(scratchBase, 'sdk-'))
  owned.push(root)
  const pkg = join(root, 'pi-durable')
  cpSync(installed, pkg, { recursive: true, dereference: true })
  execFileSync('git', ['init', '-q'], { cwd: pkg })
  if (!existsSync(join(pkg, 'dist/harness/guarded-abort.js')))
    execFileSync('git', ['apply', compatPatch], { cwd: pkg })
  for (const patch of patches) execFileSync('git', ['apply', patch], { cwd: pkg })
  if (edit !== undefined) {
    const file = join(pkg, edit.file)
    const before = readFileSync(file, 'utf8')
    let after = before
    for (const [find, replace] of edit.replace) {
      if (!after.includes(find)) throw new Error(`mutation target not found: ${find}`)
      after = after.replace(find, replace)
    }
    writeFileSync(file, after)
  }
  const load = (relative) => import(pathToFileURL(join(pkg, relative)).href)
  const dir = mkdtempSync(join(scratchBase, 'db-'))
  owned.push(dir)
  return {
    sdk: await load('dist/index.js'),
    node: await load('dist/storage/sqlite/node.js'),
    snap: await load('dist/storage/sqlite/snapshot.js'),
    dir,
  }
}
let lab
beforeAll(async () => {
  lab = await makeLab()
})
afterAll(() => {
  removeOwned(scratchBase, owned)
})

const hash = (c) => `sha256:${c.repeat(64)}`
const readerPins = (requestId, over = {}) => ({
  sessionId: 'ses_snapshot',
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
  ownerKey: 'owner:snapshot',
  lineageId: 'lineage:1',
  generation: 'gen:1',
  expectedEpoch: 0,
  ...over,
})
const dbPath = (c, tag = 'store') => join(c.dir, `${tag}-${counter++}.sqlite`)
const code = async (promise) => {
  try {
    await promise
  } catch (error) {
    return error.message
  }
  return 'no error'
}
const digestOf = (file) => `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`
const listing = (path) =>
  readdirSync(dirname(path)).filter((name) => name.startsWith(path.split('/').at(-1)))

async function openHarness(c, storage) {
  const harness = await c.sdk.Harness.open(
    storage,
    {
      models: createModels(),
      registry: c.sdk.createRegistry(),
      settings: { compaction: { enabled: false } },
    },
    context
  )
  return { harness, root: await harness.root(context) }
}
// Writes the given receipts as the fence holder, closes the writers (C4) when asked, shuts the Harness down (which closes
// the storage object it was given, checkpointing it) and returns the closed store plus what it committed.
async function produce(c, requestIds, { mutationId, ownerKey } = {}) {
  const path = dbPath(c, 'store')
  const storage = await c.node.openNodeSqliteStorage(path)
  await storage.acquireWriterFence(holder(ownerKey === undefined ? {} : { ownerKey }))
  const { harness, root } = await openHarness(c, storage)
  const receipts = []
  for (const id of requestIds) receipts.push(await root.commitAbort(abortRequest(id), context))
  const closure =
    mutationId === undefined ? undefined : await storage.closeWriterFence({ mutationId })
  await harness.close(context)
  return { path, receipts, closure, conversationId: root.id }
}
// Method A copy: only after the writer is closed and the file holds no sidecar. Plain byte copy into a fresh name.
function copyOf(c, path) {
  expect(listing(path)).toEqual([path.split('/').at(-1)])
  const copy = dbPath(c, 'artifact')
  copyFileSync(path, copy)
  return copy
}
function pinsOf(closure, over = {}) {
  return {
    mutationId: closure.mutationId,
    ownerKey: closure.ownerKey,
    lineageId: closure.lineageId,
    generation: closure.generation,
    epoch: closure.epoch,
    lastSeq: closure.lastSeq,
    ...over,
  }
}
// Edits a disposable artifact with a plain SQLite connection, then closes it so no sidecar is left behind.
function tamper(path, ...statements) {
  const database = new DatabaseSync(path)
  try {
    for (const sql of statements) database.exec(sql)
  } finally {
    database.close()
  }
  expect(listing(path)).toEqual([path.split('/').at(-1)])
}
const sealCode = async (c, path, pins) => {
  try {
    await c.snap.sealSnapshot(path, pins)
  } catch (error) {
    return error.message
  }
  return 'sealed'
}

// Controlled fixture provenance: produced by `produce` (C4 closeWriterFence, then Harness.close, which checkpoints and removes
// the sidecars) and `copyOf` (a plain byte copy that first asserts no sidecar exists). It is this test file's own assertion,
// not an SDK-derived fact and not production attestation.
const CONTROLLED_FIXTURE = Object.freeze({
  closedWritersWithC4: true,
  copiedAfterCleanShutdown: true,
})

// Test-local stand-in for the candidate sealing boundary. `ownerEpoch` is the SDK-derived fence epoch (a structural fact).
// `detached` and `coherent` are taken ONLY from the fixture provenance the caller passes here, because the SDK derives neither:
// without it the boundary refuses. It validates the session-level pins here; `readPiFrozenReceipt` later rechecks only the
// session id and request-level pins, so `readPinnedFrozenReceipt` below rechecks the rest. It is not a production issuer.
const SessionError = (message) => new Error(message)
const pinnedSessions = new WeakMap()
function checkHeld(held) {
  const { sessionId, conversationId, restoreGeneration, revision } = held ?? {}
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    !Number.isSafeInteger(conversationId) ||
    conversationId < 1 ||
    typeof restoreGeneration !== 'string' ||
    restoreGeneration.length === 0 ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw SessionError('PI_SNAPSHOT_SESSION_PINS_INVALID')
  return { sessionId, conversationId, restoreGeneration, revision }
}
async function sealDetachedLedgerWith(c, handle, held, authority, fixture) {
  const pins = checkHeld(held)
  const { sessionId, conversationId, restoreGeneration, revision } = pins
  if (fixture?.closedWritersWithC4 !== true || fixture?.copiedAfterCleanShutdown !== true)
    throw SessionError('PI_SNAPSHOT_FIXTURE_PROVENANCE_MISSING')
  const facts = c.snap.snapshotFacts(handle)
  // The held restore generation must still be the current open one for the lineage the closure names.
  await new PiRestoreGenerationEvidenceReader(authority).readCurrent({
    lineageId: facts.closure.lineageId,
    restoreGeneration,
    revision,
  })
  const ledger = await c.snap.withSnapshotStorage(handle, async (storage) => {
    if ((await storage.conversation(conversationId, context)) === undefined)
      throw SessionError('PI_SNAPSHOT_SESSION_MISMATCH')
    const found = await storage.scanDocuments(
      { scope: { kind: 'session' }, kind: 'pi.guarded-abort-receipts', at: 'current' },
      5,
      undefined,
      context
    )
    if (found.items.length > 1) throw SessionError('PI_SNAPSHOT_LEDGER_INVALID')
    if (found.items.length === 0) return { receipts: [] }
    return (await storage.document(found.items[0].id, 'current', context)).value
  })
  if (!Array.isArray(ledger.receipts)) throw SessionError('PI_SNAPSHOT_LEDGER_INVALID')
  if (ledger.receipts.some((receipt) => receipt?.conversationId !== conversationId))
    throw SessionError('PI_SNAPSHOT_SESSION_MISMATCH')
  const sealed = sealPiReceiptSnapshot({
    provenance: {
      sessionId,
      conversationId,
      restoreGeneration,
      ownerEpoch: facts.fenceEpoch,
      detached: fixture.copiedAfterCleanShutdown,
      coherent: fixture.closedWritersWithC4,
      access: 'select_only',
    },
    ledger,
  })
  pinnedSessions.set(sealed, Object.freeze({ ...pins, lineageId: facts.closure.lineageId }))
  return sealed
}
const sealDetachedLedger = (c, handle, held, authority) =>
  sealDetachedLedgerWith(c, handle, held, authority, CONTROLLED_FIXTURE)

// Test-local read boundary. It repeats, at read time, every session-level pin the seal was made with: the session id, the
// conversation id, the restore generation and its revision, and it reads the restore generation authority again. The existing
// reader (`readPiFrozenReceipt`) is unchanged and checks only the session id against its provenance and the request-level pins
// (plus a foreign-conversation refusal for the requested request); it cannot carry the other three pins.
async function readPinnedFrozenReceipt(sealed, held, identity, authority) {
  const record =
    typeof sealed === 'object' && sealed !== null ? pinnedSessions.get(sealed) : undefined
  if (record === undefined) throw SessionError('PI_SNAPSHOT_READ_NOT_SEALED_HERE')
  const pins = checkHeld(held)
  for (const key of ['sessionId', 'conversationId', 'restoreGeneration', 'revision'])
    if (pins[key] !== record[key]) throw SessionError('PI_SNAPSHOT_READ_PIN_MISMATCH')
  if (identity?.sessionId !== pins.sessionId) throw SessionError('PI_SNAPSHOT_READ_PIN_MISMATCH')
  await new PiRestoreGenerationEvidenceReader(authority).readCurrent({
    lineageId: record.lineageId,
    restoreGeneration: pins.restoreGeneration,
    revision: pins.revision,
  })
  return readPiFrozenReceipt(sealed, identity)
}
const authorityFor = (lineageId, restoreGeneration, revision = 7, state = 'open') => ({
  readCurrent: async () => ({ lineageId, restoreGeneration, revision, state }),
})
const heldFor = (conversationId, over = {}) => ({
  sessionId: 'ses_snapshot',
  conversationId,
  restoreGeneration: 'restore:1',
  revision: 7,
  ...over,
})

// Each scenario builds a disposable artifact and returns the code `sealSnapshot` answers with, or 'sealed'. They are shared by
// the ordinary tests and by the mutation proof, which re-runs one against an SDK copy whose candidate check was weakened.
const closureOf = (c, mutationId) => produce(c, ['cancel:one', 'cancel:two'], { mutationId })
async function closedArtifact(c) {
  const written = await closureOf(c, 'mutation:snapshot')
  return { ...written, artifact: copyOf(c, written.path) }
}
const scenarios = {
  sealed: async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    return sealCode(c, artifact, pinsOf(closure))
  },
  'extra pin key': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    return sealCode(c, artifact, { ...pinsOf(closure), restoreGeneration: 'restore:1' })
  },
  'closure row owner differs from the pin': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    tamper(artifact, "UPDATE durable_writer_closure SET owner_key = 'owner:other'")
    return sealCode(c, artifact, pinsOf(closure))
  },
  'closure row lineage differs from the pin': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    tamper(artifact, "UPDATE durable_writer_closure SET lineage_id = 'lineage:other'")
    return sealCode(c, artifact, pinsOf(closure))
  },
  'closure row generation differs from the pin': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    tamper(artifact, "UPDATE durable_writer_closure SET generation = 'gen:other'")
    return sealCode(c, artifact, pinsOf(closure))
  },
  'fence owner differs from the pin': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    tamper(artifact, "UPDATE durable_writer_fence SET owner_key = 'owner:other'")
    return sealCode(c, artifact, pinsOf(closure))
  },
  'fence lineage differs from the pin': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    tamper(artifact, "UPDATE durable_writer_fence SET lineage_id = 'lineage:other'")
    return sealCode(c, artifact, pinsOf(closure))
  },
  'fence generation differs from the pin': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    tamper(artifact, "UPDATE durable_writer_fence SET generation = 'gen:other'")
    return sealCode(c, artifact, pinsOf(closure))
  },
  'the fence is not armed': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    tamper(artifact, 'UPDATE durable_writer_fence SET armed = 0')
    return sealCode(c, artifact, pinsOf(closure))
  },
  'an extra symbol pin key': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    return sealCode(c, artifact, { ...pinsOf(closure), [Symbol('extra')]: 1 })
  },
  'an extra non-enumerable pin key': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    const pins = pinsOf(closure)
    Object.defineProperty(pins, 'extra', { value: 1, enumerable: false })
    return sealCode(c, artifact, pins)
  },
  'a non-enumerable pin': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    const pins = pinsOf(closure)
    Object.defineProperty(pins, 'epoch', { enumerable: false })
    return sealCode(c, artifact, pins)
  },
  'epoch pin differs from the closure': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    return sealCode(c, artifact, pinsOf(closure, { epoch: closure.epoch + 1 }))
  },
  'closure epoch is not previous epoch plus one': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    tamper(artifact, 'UPDATE durable_writer_closure SET previous_epoch = previous_epoch - 1')
    return sealCode(c, artifact, pinsOf(closure))
  },
  'fence epoch is below the closure epoch': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    tamper(artifact, 'UPDATE durable_writer_fence SET epoch = epoch - 1')
    return sealCode(c, artifact, pinsOf(closure))
  },
  'a successor acquired the fence after the closure': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    const successor = await c.node.openNodeSqliteStorage(artifact)
    await successor.acquireWriterFence(
      holder({ ownerKey: 'owner:next', expectedEpoch: closure.epoch })
    )
    await successor.close(context)
    return sealCode(c, artifact, pinsOf(closure))
  },
  'closure lastSeq differs from the pin': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    tamper(artifact, 'UPDATE durable_writer_closure SET last_seq = last_seq + 1')
    return sealCode(c, artifact, pinsOf(closure))
  },
  'the cut is not the closure cut': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    tamper(artifact, 'UPDATE durable_metadata SET next_seq = next_seq + 1 WHERE singleton = 1')
    return sealCode(c, artifact, pinsOf(closure))
  },
  'a second hard link': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    linkSync(artifact, `${artifact}.alias`)
    return sealCode(c, artifact, pinsOf(closure))
  },
  'a symlink to a valid artifact': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    const link = dbPath(c, 'link')
    symlinkSync(artifact, link)
    return sealCode(c, link, pinsOf(closure))
  },
  'a path through a symlinked directory': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    const aliasDir = join(c.dir, `dir-alias-${counter++}`)
    symlinkSync(c.dir, aliasDir)
    return sealCode(c, join(aliasDir, artifact.split('/').at(-1)), pinsOf(closure))
  },
  'the artifact is open for writing in this process': async (c) => {
    const { artifact, closure } = await closedArtifact(c)
    // A read-write open registers the file; its -wal/-shm sidecars are not what this scenario is about, so the refusal is
    // read before and after the close: while open it must be NOT_DETACHED, and once closed the same file must seal.
    const writer = await c.node.openNodeSqliteStorage(artifact)
    const whileOpen = await sealCode(c, artifact, pinsOf(closure))
    await writer.close(context)
    const afterClose = await sealCode(c, artifact, pinsOf(closure))
    return afterClose === 'sealed' ? whileOpen : `after close: ${afterClose}`
  },
}
const expected = {
  sealed: 'sealed',
  'extra pin key': 'PI_SNAPSHOT_PINS_INVALID',
  'closure row owner differs from the pin': 'PI_SNAPSHOT_CLOSURE_MISMATCH',
  'closure row lineage differs from the pin': 'PI_SNAPSHOT_CLOSURE_MISMATCH',
  'closure row generation differs from the pin': 'PI_SNAPSHOT_CLOSURE_MISMATCH',
  'fence owner differs from the pin': 'PI_SNAPSHOT_CLOSURE_MISMATCH',
  'fence lineage differs from the pin': 'PI_SNAPSHOT_CLOSURE_MISMATCH',
  'fence generation differs from the pin': 'PI_SNAPSHOT_CLOSURE_MISMATCH',
  'the fence is not armed': 'PI_SNAPSHOT_CLOSURE_MISMATCH',
  'an extra symbol pin key': 'PI_SNAPSHOT_PINS_INVALID',
  'an extra non-enumerable pin key': 'PI_SNAPSHOT_PINS_INVALID',
  'a non-enumerable pin': 'PI_SNAPSHOT_PINS_INVALID',
  'epoch pin differs from the closure': 'PI_SNAPSHOT_CLOSURE_MISMATCH',
  'closure epoch is not previous epoch plus one': 'PI_SNAPSHOT_CLOSURE_MISMATCH',
  'fence epoch is below the closure epoch': 'PI_SNAPSHOT_CLOSURE_MISMATCH',
  'a successor acquired the fence after the closure': 'PI_SNAPSHOT_SUPERSEDED',
  'closure lastSeq differs from the pin': 'PI_SNAPSHOT_CUT_MISMATCH',
  'the cut is not the closure cut': 'PI_SNAPSHOT_CUT_MISMATCH',
  'a second hard link': 'PI_SNAPSHOT_NOT_DETACHED',
  'a symlink to a valid artifact': 'PI_SNAPSHOT_ARTIFACT_INVALID',
  'a path through a symlinked directory': 'PI_SNAPSHOT_ARTIFACT_INVALID',
  'the artifact is open for writing in this process': 'PI_SNAPSHOT_NOT_DETACHED',
}

describe('candidate C7c detached snapshot, method A (disposable SQLite, patched SDK copy only)', () => {
  test('every scenario answers with its pinned code on the unmodified candidate', async () => {
    for (const [name, run] of Object.entries(scenarios))
      expect({ name, answer: await run(lab) }).toEqual({ name, answer: expected[name] })
  })

  test('a sealed artifact exposes only derived facts, equal to the closure receipt, and neither the original nor the artifact changes', async () => {
    const { path, artifact, closure } = await closedArtifact(lab)
    const originalBefore = digestOf(path)
    const artifactBefore = { sha256: digestOf(artifact), entries: listing(artifact) }
    const handle = await lab.snap.sealSnapshot(artifact, pinsOf(closure))
    const facts = lab.snap.snapshotFacts(handle)
    // Structural facts only: no constant method label and no detached or coherent claim, which the SDK cannot derive.
    expect(Object.keys(facts).toSorted()).toEqual([
      'closure',
      'cutSeq',
      'digest',
      'fenceEpoch',
      'schemaVersion',
    ])
    expect(facts.closure).toMatchObject({
      mutationId: closure.mutationId,
      ownerKey: closure.ownerKey,
      lineageId: closure.lineageId,
      generation: closure.generation,
      previousEpoch: closure.previousEpoch,
      epoch: closure.epoch,
      lastSeq: closure.lastSeq,
    })
    expect(facts.fenceEpoch).toBe(closure.epoch)
    expect(facts.cutSeq).toBe(closure.lastSeq)
    expect(facts.schemaVersion).toBeGreaterThanOrEqual(3)
    expect(facts.digest).toBe(artifactBefore.sha256)
    // Opaque and frozen: no path, hash, store, statement or flag leaks from the handle, and the facts cannot be rewritten.
    expect(Object.isFrozen(handle)).toBe(true)
    expect(Reflect.ownKeys(handle)).toEqual([])
    expect(Object.isFrozen(facts)).toBe(true)
    expect(Object.isFrozen(facts.closure)).toBe(true)
    expect(() => {
      'use strict'
      facts.cutSeq = 0
    }).toThrow()
    expect({ sha256: digestOf(artifact), entries: listing(artifact) }).toEqual(artifactBefore)
    expect(digestOf(path)).toBe(originalBefore)
    // Cover the unfenced case: the original is fenced at the closure epoch, so a stranger cannot commit past this cut.
    const stranger = await lab.node.openNodeSqliteStorage(path)
    expect(
      await code(
        stranger
          .mintId()
          .then(() => stranger.commit([{ type: 'conversation', value: { id: 99 } }], context))
      )
    ).toBe('PI_STORE_FENCED')
    await stranger.close(context)
  })

  test('handles are issued only by sealSnapshot', async () => {
    for (const forged of [
      {},
      Object.freeze({}),
      Object.create(null),
      null,
      undefined,
      'handle',
      7,
    ]) {
      expect(await code(Promise.resolve().then(() => lab.snap.snapshotFacts(forged)))).toBe(
        'PI_SNAPSHOT_NOT_ISSUED'
      )
      expect(await code(lab.snap.withSnapshotStorage(forged, async () => 1))).toBe(
        'PI_SNAPSHOT_NOT_ISSUED'
      )
    }
  })

  test('pins must be exactly the six independently held values, read once, with no getters', async () => {
    const { artifact, closure } = await closedArtifact(lab)
    const good = pinsOf(closure)
    const bad = [
      null,
      undefined,
      [],
      'pins',
      {},
      Object.fromEntries(Object.entries(good).filter(([key]) => key !== 'lastSeq')),
      Object.fromEntries(Object.entries(good).filter(([key]) => key !== 'mutationId')),
      { ...good, extra: 1 },
      { ...good, mutationId: '' },
      { ...good, mutationId: ' padded ' },
      { ...good, ownerKey: 7 },
      { ...good, lineageId: undefined },
      { ...good, generation: 'g'.repeat(8193) },
      { ...good, epoch: 0 },
      { ...good, epoch: 1.5 },
      { ...good, epoch: '2' },
      { ...good, epoch: Number.MAX_SAFE_INTEGER + 2 },
      { ...good, lastSeq: -1 },
      { ...good, lastSeq: Number.NaN },
      { ...good, lastSeq: '5' },
      Object.defineProperty({ ...good }, 'epoch', { get: () => closure.epoch, enumerable: true }),
      // The contract is exactly six OWN keys: symbols and non-enumerable extras are keys too, and a non-enumerable pin is refused.
      { ...good, [Symbol('extra')]: 1 },
      Object.defineProperty({ ...good }, 'hidden', { value: 1, enumerable: false }),
      Object.defineProperty({ ...good }, Symbol.for('hidden'), { value: 1, enumerable: false }),
      Object.defineProperty({ ...good }, 'lastSeq', { enumerable: false }),
    ]
    for (const pins of bad)
      expect(await sealCode(lab, artifact, pins)).toBe('PI_SNAPSHOT_PINS_INVALID')
    // Getters are never invoked, whether on a pin or on a hidden extra key.
    let reads = 0
    const spy = (name, enumerable) =>
      Object.defineProperty({ ...good }, name, {
        get() {
          reads += 1
          return name === 'epoch' ? closure.epoch : 1
        },
        enumerable,
      })
    for (const pins of [spy('epoch', true), spy('hidden', false), spy('visible', true)])
      expect(await sealCode(lab, artifact, pins)).toBe('PI_SNAPSHOT_PINS_INVALID')
    expect(reads).toBe(0)
    // A mutated pin object after the call started cannot change what was checked: pins are copied before the first await.
    const live = { ...good }
    const pending = lab.snap.sealSnapshot(artifact, live)
    live.epoch = 99
    live.lastSeq = 99
    expect(lab.snap.snapshotFacts(await pending).closure.epoch).toBe(closure.epoch)
  })

  test('the mutation id is the closure key: an unknown id is a missing closure, not a different valid one', async () => {
    const { artifact, closure } = await closedArtifact(lab)
    expect(await sealCode(lab, artifact, pinsOf(closure, { mutationId: 'mutation:other' }))).toBe(
      'PI_SNAPSHOT_CLOSURE_MISSING'
    )
  })

  test('a store whose writers were never closed has no closure, and a store without the closure table says so too', async () => {
    const open = await produce(lab, ['cancel:one'])
    const artifact = copyOf(lab, open.path)
    const pins = {
      mutationId: 'mutation:never',
      ownerKey: 'owner:snapshot',
      lineageId: 'lineage:1',
      generation: 'gen:1',
      epoch: 2,
      lastSeq: 1,
    }
    expect(await sealCode(lab, artifact, pins)).toBe('PI_SNAPSHOT_CLOSURE_MISSING')
    const closed = await closedArtifact(lab)
    tamper(closed.artifact, 'DROP TABLE durable_writer_closure')
    expect(await sealCode(lab, closed.artifact, pinsOf(closed.closure))).toBe(
      'PI_SNAPSHOT_CLOSURE_MISSING'
    )
  })

  test('the default C7 sidecar and schema refusals are unchanged and are not weakened by sealing', async () => {
    const { artifact, closure } = await closedArtifact(lab)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      writeFileSync(`${artifact}${suffix}`, '')
      expect(await sealCode(lab, artifact, pinsOf(closure))).toBe('PI_STORE_READ_ONLY_SIDECARS')
      rmSync(`${artifact}${suffix}`)
    }
    expect(await sealCode(lab, artifact, pinsOf(closure))).toBe('sealed')
    // The plain C7 open is still the only reader and still refuses the same way.
    writeFileSync(`${artifact}-wal`, '')
    expect(await code(lab.node.openNodeSqliteStorage(artifact, { mode: 'read-only' }))).toBe(
      'PI_STORE_READ_ONLY_SIDECARS'
    )
    rmSync(`${artifact}-wal`)

    const newer = await closedArtifact(lab)
    tamper(newer.artifact, 'UPDATE durable_schema SET version = 99 WHERE singleton = 1')
    expect(await sealCode(lab, newer.artifact, pinsOf(newer.closure))).toBe(
      'PI_STORE_READ_ONLY_SCHEMA_NEWER'
    )
  })

  test("a successor's uncheckpointed WAL copied beside the file is refused, and so is the live store itself", async () => {
    const { path, closure } = await closedArtifact(lab)
    const successor = await lab.node.openNodeSqliteStorage(path)
    await successor.acquireWriterFence(
      holder({ ownerKey: 'owner:next', expectedEpoch: closure.epoch })
    )
    const next = await openHarness(lab, successor)
    await next.root.commitAbort(abortRequest('cancel:three'), context)
    // The live path is open for writing in this process.
    expect(await sealCode(lab, path, pinsOf(closure))).toBe('PI_SNAPSHOT_NOT_DETACHED')
    // A torn copy of the main file with its WAL and shm is not a checkpointed copy.
    const torn = dbPath(lab, 'torn')
    for (const suffix of ['', '-wal', '-shm']) copyFileSync(`${path}${suffix}`, `${torn}${suffix}`)
    expect(existsSync(`${torn}-wal`)).toBe(true)
    expect(await sealCode(lab, torn, pinsOf(closure))).toBe('PI_STORE_READ_ONLY_SIDECARS')
    // A copy of the main file alone is stale: it sits at the closure cut and must be recognised as such only by its pins.
    const stale = dbPath(lab, 'stale')
    copyFileSync(path, stale)
    await next.harness.close(context)
    expect(readFileSync(stale).length).toBeGreaterThan(0)
  })

  test('malformed, empty, truncated and non-store artifacts fail closed', async () => {
    const { artifact, closure } = await closedArtifact(lab)
    const pins = pinsOf(closure)
    const garbage = dbPath(lab, 'garbage')
    writeFileSync(garbage, randomBytes(8192))
    // C7 reads a file with no readable schema table as an uninitialized store; either way nothing is sealed.
    expect(await sealCode(lab, garbage, pins)).toBe('PI_STORE_READ_ONLY_SCHEMA_UNINITIALIZED')
    const empty = dbPath(lab, 'empty')
    writeFileSync(empty, '')
    expect(await sealCode(lab, empty, pins)).toBe('PI_STORE_READ_ONLY_SCHEMA_UNINITIALIZED')
    const truncated = dbPath(lab, 'truncated')
    copyFileSync(artifact, truncated)
    truncateSync(truncated, Math.floor(statSync(artifact).size / 2))
    expect(await sealCode(lab, truncated, pins)).toBe('PI_STORE_READ_ONLY_SCHEMA_UNINITIALIZED')
    // A store whose header and schema read but whose ledger pages are damaged is refused, not read as an empty ledger.
    const damaged = dbPath(lab, 'damaged')
    copyFileSync(artifact, damaged)
    const uri = pathToFileURL(damaged)
    uri.search = '?mode=ro&immutable=1'
    const probe = new DatabaseSync(uri.href, { readOnly: true })
    const { rootpage } = probe
      .prepare("SELECT rootpage FROM sqlite_master WHERE name = 'document_revisions'")
      .get()
    const { page_size } = probe.prepare('PRAGMA page_size').get()
    probe.close()
    const bytes = readFileSync(damaged)
    bytes.fill(
      0xff,
      (Number(rootpage) - 1) * Number(page_size),
      (Number(rootpage) - 1) * Number(page_size) + 16
    )
    writeFileSync(damaged, bytes)
    expect(await sealCode(lab, damaged, pins)).toBe('PI_SNAPSHOT_ARTIFACT_INVALID')
    const plain = dbPath(lab, 'plain')
    const database = new DatabaseSync(plain)
    database.exec('CREATE TABLE unrelated (x)')
    database.close()
    expect(await sealCode(lab, plain, pins)).toBe('PI_STORE_READ_ONLY_SCHEMA_UNINITIALIZED')
    for (const bad of [
      join(lab.dir, 'absent.sqlite'),
      lab.dir,
      'relative.sqlite',
      '',
      7,
      `${artifact}/../${artifact.split('/').at(-1)}`,
    ])
      expect(await sealCode(lab, bad, pins)).toBe('PI_SNAPSHOT_ARTIFACT_INVALID')
  })

  test('sealing a missing path refuses and creates nothing', async () => {
    const missing = join(lab.dir, 'never-created.sqlite')
    const { closure } = await closedArtifact(lab)
    expect(await sealCode(lab, missing, pinsOf(closure))).toBe('PI_SNAPSHOT_ARTIFACT_INVALID')
    expect(existsSync(missing)).toBe(false)
    expect(readdirSync(lab.dir).some((name) => name.includes('never-created'))).toBe(false)
  })

  test('the bytes must not change between sealing and a read, nor during a read', async () => {
    const { artifact, closure } = await closedArtifact(lab)
    const handle = await lab.snap.sealSnapshot(artifact, pinsOf(closure))
    const ledgerCount = (storage) =>
      storage
        .scanDocuments(
          { scope: { kind: 'session' }, kind: 'pi.guarded-abort-receipts', at: 'current' },
          5,
          undefined,
          context
        )
        .then((found) => found.items.length)
    expect(await lab.snap.withSnapshotStorage(handle, ledgerCount)).toBe(1)

    // Changed during the read: the result is dropped.
    expect(
      await code(
        lab.snap.withSnapshotStorage(handle, async (storage) => {
          const count = await ledgerCount(storage)
          const bytes = readFileSync(artifact)
          bytes[bytes.length - 1] ^= 0xff
          writeFileSync(artifact, bytes)
          return count
        })
      )
    ).toBe('PI_SNAPSHOT_UNSTABLE')
    // And it stays refused afterwards: the sealed digest is not the file's digest any more.
    expect(await code(lab.snap.withSnapshotStorage(handle, ledgerCount))).toBe(
      'PI_SNAPSHOT_UNSTABLE'
    )
  })

  test('a file changed between sealing and a read, or a sidecar that appears, is refused', async () => {
    const first = await closedArtifact(lab)
    const handle = await lab.snap.sealSnapshot(first.artifact, pinsOf(first.closure))
    tamper(first.artifact, 'CREATE TABLE intruder (x)')
    expect(await code(lab.snap.withSnapshotStorage(handle, async () => 1))).toBe(
      'PI_SNAPSHOT_UNSTABLE'
    )
    const second = await closedArtifact(lab)
    const other = await lab.snap.sealSnapshot(second.artifact, pinsOf(second.closure))
    writeFileSync(`${second.artifact}-wal`, '')
    expect(await code(lab.snap.withSnapshotStorage(other, async () => 1))).toBe(
      'PI_STORE_READ_ONLY_SIDECARS'
    )
    rmSync(`${second.artifact}-wal`)
    expect(await lab.snap.withSnapshotStorage(other, async () => 1)).toBe(1)
  })

  test('a sealed artifact later opened for writing in this process is refused for reads', async () => {
    const { artifact, closure } = await closedArtifact(lab)
    const handle = await lab.snap.sealSnapshot(artifact, pinsOf(closure))
    const writer = await lab.node.openNodeSqliteStorage(artifact)
    expect(await code(lab.snap.withSnapshotStorage(handle, async () => 1))).toBe(
      'PI_SNAPSHOT_NOT_DETACHED'
    )
    await writer.close(context)
  })

  test('the read-only storage a snapshot hands out cannot write', async () => {
    const { artifact, closure } = await closedArtifact(lab)
    const handle = await lab.snap.sealSnapshot(artifact, pinsOf(closure))
    const before = digestOf(artifact)
    const outcomes = await lab.snap.withSnapshotStorage(handle, async (storage) => [
      await code(storage.mintId()),
      await code(storage.commit([{ type: 'conversation', value: { id: 99 } }], context)),
      await code(storage.acquireWriterFence(holder())),
      await code(storage.closeWriterFence({ mutationId: 'mutation:again' })),
    ])
    expect(outcomes).toEqual(Array(4).fill('PI_STORE_READ_ONLY'))
    expect(digestOf(artifact)).toBe(before)
  })
})

describe('candidate C7c sealing boundary glue and the frozen receipt reader (test-local, not an issuer)', () => {
  test('a coherent snapshot seals and reads like the read-write comparator, with the owner epoch derived from the fence', async () => {
    const { artifact, closure, receipts, conversationId } = await closedArtifact(lab)
    const handle = await lab.snap.sealSnapshot(artifact, pinsOf(closure))
    const sealed = await sealDetachedLedger(
      lab,
      handle,
      heldFor(conversationId),
      authorityFor(closure.lineageId, 'restore:1')
    )
    for (const [index, id] of ['cancel:one', 'cancel:two'].entries()) {
      const found = readPiFrozenReceipt(sealed, readerPins(id))
      expect(found.outcome).toBe('found')
      expect(found.receipt).toEqual(receipts[index])
      expect(Object.isFrozen(found.receipt.metadata)).toBe(true)
    }
    expect(readPiFrozenReceipt(sealed, readerPins('cancel:missing'))).toEqual({ outcome: 'absent' })

    // Comparator: a read-write reopen of a byte copy of the same closed store reads the same ledger from the same cut.
    const comparator = copyOf(lab, artifact)
    const owner = await lab.node.openNodeSqliteStorage(comparator)
    const found = await owner.scanDocuments(
      { scope: { kind: 'session' }, kind: 'pi.guarded-abort-receipts', at: 'current' },
      5,
      undefined,
      context
    )
    const live = (await owner.document(found.items[0].id, 'current', context)).value
    const metadata = await owner.db.get('SELECT next_seq FROM durable_metadata WHERE singleton = 1')
    await owner.close(context)
    expect(Number(metadata.next_seq) - 1).toBe(lab.snap.snapshotFacts(handle).cutSeq)
    const viaLive = sealPiReceiptSnapshot({
      provenance: {
        sessionId: 'ses_snapshot',
        conversationId,
        restoreGeneration: 'restore:1',
        ownerEpoch: closure.epoch,
        detached: true,
        coherent: true,
        access: 'select_only',
      },
      ledger: live,
    })
    for (const id of ['cancel:one', 'cancel:two', 'cancel:missing'])
      expect(JSON.stringify(readPiFrozenReceipt(sealed, readerPins(id)))).toBe(
        JSON.stringify(readPiFrozenReceipt(viaLive, readerPins(id)))
      )
  })

  test('the boundary refuses without controlled fixture provenance: the SDK derives neither detached nor coherent', async () => {
    const { artifact, closure, conversationId } = await closedArtifact(lab)
    const handle = await lab.snap.sealSnapshot(artifact, pinsOf(closure))
    const authority = authorityFor(closure.lineageId, 'restore:1')
    for (const fixture of [
      undefined,
      null,
      {},
      { closedWritersWithC4: true },
      { copiedAfterCleanShutdown: true },
      { closedWritersWithC4: true, copiedAfterCleanShutdown: 'yes' },
      { closedWritersWithC4: false, copiedAfterCleanShutdown: true },
    ])
      expect(
        await code(sealDetachedLedgerWith(lab, handle, heldFor(conversationId), authority, fixture))
      ).toBe('PI_SNAPSHOT_FIXTURE_PROVENANCE_MISSING')
    expect(
      await code(
        sealDetachedLedgerWith(lab, handle, heldFor(conversationId), authority, CONTROLLED_FIXTURE)
      )
    ).toBe('no error')
  })

  test('a store with no receipts at its cut reads as absent, which is history and not proof the effect never happened', async () => {
    const written = await produce(lab, [], { mutationId: 'mutation:empty' })
    const artifact = copyOf(lab, written.path)
    const handle = await lab.snap.sealSnapshot(artifact, pinsOf(written.closure))
    const sealed = await sealDetachedLedger(
      lab,
      handle,
      heldFor(written.conversationId),
      authorityFor('lineage:1', 'restore:1')
    )
    expect(readPiFrozenReceipt(sealed, readerPins('cancel:one'))).toEqual({ outcome: 'absent' })
  })

  test('session pins are validated at the sealing boundary, and the existing reader rechecks the session id', async () => {
    const { artifact, closure, conversationId } = await closedArtifact(lab)
    const handle = await lab.snap.sealSnapshot(artifact, pinsOf(closure))
    const good = authorityFor(closure.lineageId, 'restore:1')
    // Boundary: malformed session pins.
    for (const over of [
      { sessionId: '' },
      { sessionId: 7 },
      { conversationId: 0 },
      { conversationId: 1.5 },
      { restoreGeneration: '' },
      { revision: -1 },
    ])
      expect(await code(sealDetachedLedger(lab, handle, heldFor(conversationId, over), good))).toBe(
        'PI_SNAPSHOT_SESSION_PINS_INVALID'
      )
    // Boundary: a conversation the snapshot does not hold, and the restore generation authority disagreeing.
    expect(await code(sealDetachedLedger(lab, handle, heldFor(conversationId + 50), good))).toBe(
      'PI_SNAPSHOT_SESSION_MISMATCH'
    )
    for (const authority of [
      authorityFor(closure.lineageId, 'restore:2'),
      authorityFor(closure.lineageId, 'restore:1', 8),
      authorityFor(closure.lineageId, 'restore:1', 7, 'closing'),
      authorityFor('lineage:other', 'restore:1'),
    ])
      expect(await code(sealDetachedLedger(lab, handle, heldFor(conversationId), authority))).toBe(
        'PI_RESTORE_GENERATION_EVIDENCE_CONFLICT'
      )
    // Reader: the session pin is checked again, so a handle sealed for one session cannot answer for another.
    const sealed = await sealDetachedLedger(lab, handle, heldFor(conversationId), good)
    expect(() =>
      readPiFrozenReceipt(sealed, readerPins('cancel:one', { sessionId: 'ses_other' }))
    ).toThrow('PI_FROZEN_RECEIPT_SESSION_MISMATCH')
    expect(() => readPiFrozenReceipt({}, readerPins('cancel:one'))).toThrow(
      'PI_FROZEN_RECEIPT_SNAPSHOT_NOT_ISSUED'
    )
  })

  test('the existing reader rechecks only the session id and request pins; the test-local wrapper rechecks all four session pins and the authority', async () => {
    const { artifact, closure, conversationId } = await closedArtifact(lab)
    const handle = await lab.snap.sealSnapshot(artifact, pinsOf(closure))
    const good = authorityFor(closure.lineageId, 'restore:1')
    const sealed = await sealDetachedLedger(lab, handle, heldFor(conversationId), good)
    const held = heldFor(conversationId)

    // The unchanged reader cannot carry a conversation id, restore generation or revision at all.
    for (const extra of [{ conversationId }, { restoreGeneration: 'restore:1' }, { revision: 7 }])
      expect(() => readPiFrozenReceipt(sealed, readerPins('cancel:one', extra))).toThrow(
        'PI_FROZEN_RECEIPT_IDENTITY_INVALID'
      )

    // The wrapper reads the same evidence when every pin matches, and absent stays absent.
    expect(
      (await readPinnedFrozenReceipt(sealed, held, readerPins('cancel:one'), good)).outcome
    ).toBe('found')
    expect(await readPinnedFrozenReceipt(sealed, held, readerPins('cancel:none'), good)).toEqual({
      outcome: 'absent',
    })

    // Each session-level pin is rechecked at read time.
    for (const over of [
      { sessionId: 'ses_other' },
      { conversationId: conversationId + 1 },
      { restoreGeneration: 'restore:2' },
      { revision: 8 },
    ])
      expect(
        await code(
          readPinnedFrozenReceipt(
            sealed,
            heldFor(conversationId, over),
            readerPins('cancel:one'),
            good
          )
        )
      ).toBe('PI_SNAPSHOT_READ_PIN_MISMATCH')
    // The identity must name the same session as the held pins.
    expect(
      await code(
        readPinnedFrozenReceipt(
          sealed,
          held,
          readerPins('cancel:one', { sessionId: 'ses_other' }),
          good
        )
      )
    ).toBe('PI_SNAPSHOT_READ_PIN_MISMATCH')
    // Malformed held pins and a handle this boundary did not seal.
    expect(
      await code(
        readPinnedFrozenReceipt(
          sealed,
          heldFor(conversationId, { revision: -1 }),
          readerPins('cancel:one'),
          good
        )
      )
    ).toBe('PI_SNAPSHOT_SESSION_PINS_INVALID')
    for (const forged of [{}, null, undefined, 'sealed'])
      expect(
        await code(readPinnedFrozenReceipt(forged, held, readerPins('cancel:one'), good))
      ).toBe('PI_SNAPSHOT_READ_NOT_SEALED_HERE')
    // A handle sealed by the bare seam, without this boundary, is not accepted by the wrapper.
    const bare = sealPiReceiptSnapshot({
      provenance: {
        sessionId: 'ses_snapshot',
        conversationId,
        restoreGeneration: 'restore:1',
        ownerEpoch: closure.epoch,
        detached: true,
        coherent: true,
        access: 'select_only',
      },
      ledger: { receipts: [] },
    })
    expect(await code(readPinnedFrozenReceipt(bare, held, readerPins('cancel:one'), good))).toBe(
      'PI_SNAPSHOT_READ_NOT_SEALED_HERE'
    )
    // The restore generation authority is read again at read time: a generation closed, replaced or moved since sealing refuses.
    for (const authority of [
      authorityFor(closure.lineageId, 'restore:1', 7, 'closing'),
      authorityFor(closure.lineageId, 'restore:2'),
      authorityFor(closure.lineageId, 'restore:1', 8),
      authorityFor('lineage:other', 'restore:1'),
    ])
      expect(
        await code(readPinnedFrozenReceipt(sealed, held, readerPins('cancel:one'), authority))
      ).toBe('PI_RESTORE_GENERATION_EVIDENCE_CONFLICT')
    // And the unchanged reader still rejects what it does check: the session id.
    expect(() =>
      readPiFrozenReceipt(sealed, readerPins('cancel:one', { sessionId: 'ses_other' }))
    ).toThrow('PI_FROZEN_RECEIPT_SESSION_MISMATCH')
  })

  test('a receipt from a foreign conversation in the ledger is a session mismatch, not an absent receipt', async () => {
    const { artifact, closure, conversationId } = await closedArtifact(lab)
    tamper(
      artifact,
      `UPDATE document_revisions SET content = replace(content, '"conversationId":${conversationId},', '"conversationId":${conversationId + 7},')`
    )
    // The SDK derives closure, fence and cut facts only; it does not read the ledger, so the artifact still seals.
    const handle = await lab.snap.sealSnapshot(artifact, pinsOf(closure))
    expect(
      await code(
        sealDetachedLedger(
          lab,
          handle,
          heldFor(conversationId),
          authorityFor(closure.lineageId, 'restore:1')
        )
      )
    ).toBe('PI_SNAPSHOT_SESSION_MISMATCH')
  })

  test('a ledger altered after the cut cannot reach the reader through an unchanged handle', async () => {
    const { artifact, closure, conversationId } = await closedArtifact(lab)
    const handle = await lab.snap.sealSnapshot(artifact, pinsOf(closure))
    tamper(
      artifact,
      "UPDATE document_revisions SET content = replace(content, 'cancel:one', 'cancel:evil')"
    )
    expect(
      await code(
        sealDetachedLedger(
          lab,
          handle,
          heldFor(conversationId),
          authorityFor(closure.lineageId, 'restore:1')
        )
      )
    ).toBe('PI_SNAPSHOT_UNSTABLE')
  })
})

// Mutation proof. For each candidate check, the SDK copy is rebuilt with that one check weakened and the scenario that the
// check exists for is run again. A check is proven only if the weakened copy no longer answers what the scenario pins, so a
// test that cannot tell the difference would fail here. `becomes` records what the weakened copy answers, so a reviewer sees
// whether the weakening fails open ('sealed') or merely moves to a different refusal that a second check still provides.
const SNAPSHOT = 'dist/storage/sqlite/snapshot.js'
const NODE = 'dist/storage/sqlite/node.js'
const mutations = [
  {
    scenario: 'extra pin key',
    file: SNAPSHOT,
    replace: [
      [
        'if (own.length !== PIN_KEYS.length || own.some((key, index) => key !== PIN_KEYS[index]))',
        'if (false)',
      ],
    ],
    becomes: 'sealed',
  },
  {
    scenario: 'the fence is not armed',
    file: SNAPSHOT,
    replace: [['if (number(fence.armed) !== 1)', 'if (false)']],
    becomes: 'sealed',
  },
  {
    scenario: 'an extra symbol pin key',
    file: SNAPSHOT,
    replace: [['Reflect.ownKeys(input)', 'Object.keys(input)']],
    becomes: 'sealed',
  },
  {
    scenario: 'an extra non-enumerable pin key',
    file: SNAPSHOT,
    replace: [['Reflect.ownKeys(input)', 'Object.keys(input)']],
    becomes: 'sealed',
  },
  {
    scenario: 'a non-enumerable pin',
    file: SNAPSHOT,
    replace: [[' || descriptor.enumerable !== true', '']],
    becomes: 'sealed',
  },
  {
    scenario: 'closure row owner differs from the pin',
    file: SNAPSHOT,
    replace: [['row.ownerKey !== pins.ownerKey ||', '']],
    becomes: 'sealed',
  },
  {
    scenario: 'closure row lineage differs from the pin',
    file: SNAPSHOT,
    replace: [['row.lineageId !== pins.lineageId ||', '']],
    becomes: 'sealed',
  },
  {
    scenario: 'closure row generation differs from the pin',
    file: SNAPSHOT,
    replace: [['row.generation !== pins.generation ||', '']],
    becomes: 'sealed',
  },
  {
    scenario: 'fence owner differs from the pin',
    file: SNAPSHOT,
    replace: [['|| fence.owner_key !== pins.ownerKey', '']],
    becomes: 'sealed',
  },
  {
    scenario: 'fence lineage differs from the pin',
    file: SNAPSHOT,
    replace: [['|| fence.lineage_id !== pins.lineageId', '']],
    becomes: 'sealed',
  },
  {
    scenario: 'fence generation differs from the pin',
    file: SNAPSHOT,
    replace: [['|| fence.generation !== pins.generation', '']],
    becomes: 'sealed',
  },
  {
    scenario: 'epoch pin differs from the closure',
    file: SNAPSHOT,
    replace: [['row.epoch !== pins.epoch ||', '']],
    becomes: 'sealed',
  },
  {
    scenario: 'closure epoch is not previous epoch plus one',
    file: SNAPSHOT,
    replace: [['row.epoch !== row.previousEpoch + 1)', 'false)']],
    becomes: 'sealed',
  },
  {
    scenario: 'fence epoch is below the closure epoch',
    file: SNAPSHOT,
    replace: [['if (fenceEpoch !== row.epoch ||', 'if (false ||']],
    becomes: 'sealed',
  },
  {
    scenario: 'a successor acquired the fence after the closure',
    file: SNAPSHOT,
    replace: [['if (fenceEpoch > row.epoch)', 'if (false)']],
    becomes: 'PI_SNAPSHOT_CLOSURE_MISMATCH',
  },
  {
    scenario: 'closure lastSeq differs from the pin',
    file: SNAPSHOT,
    replace: [['row.lastSeq !== pins.lastSeq ||', '']],
    becomes: 'sealed',
  },
  {
    scenario: 'the cut is not the closure cut',
    file: SNAPSHOT,
    replace: [['|| cutSeq !== pins.lastSeq)', ')']],
    becomes: 'sealed',
  },
  {
    scenario: 'a second hard link',
    file: SNAPSHOT,
    replace: [['if (stat.nlink !== 1)', 'if (false)']],
    becomes: 'sealed',
  },
  {
    scenario: 'a symlink to a valid artifact',
    file: SNAPSHOT,
    replace: [
      ['if (stat.isSymbolicLink() || !stat.isFile())', 'if (false)'],
      ['if (canonical !== artifactPath)', 'if (false)'],
    ],
    becomes: 'sealed',
  },
  {
    scenario: 'a path through a symlinked directory',
    file: SNAPSHOT,
    replace: [['if (canonical !== artifactPath)', 'if (false)']],
    becomes: 'sealed',
  },
  {
    scenario: 'the artifact is open for writing in this process',
    file: SNAPSHOT,
    replace: [['if (isOpenForWrite(stat))', 'if (false)']],
    becomes: 'PI_STORE_READ_ONLY_SIDECARS',
  },
  {
    // The registry must also forget a file once its writer closed, or a clean copy would be refused forever.
    scenario: 'the artifact is open for writing in this process',
    file: NODE,
    replace: [['releaseWriterOpen(this);', '']],
    becomes: 'after close: PI_SNAPSHOT_NOT_DETACHED',
  },
]

describe('candidate C7c mutation proof: each check is needed by a scenario that fails when it is weakened', () => {
  for (const mutation of mutations) {
    test(`${mutation.scenario}: weakening ${mutation.replace.map(([find]) => JSON.stringify(find)).join(' + ')} changes the answer to ${mutation.becomes}`, async () => {
      const weakened = await makeLab({ file: mutation.file, replace: mutation.replace })
      const answer = await scenarios[mutation.scenario](weakened)
      expect(answer).not.toBe(expected[mutation.scenario])
      expect(answer).toBe(mutation.becomes)
    })
  }

  test("a scenario that passes on an untouched copy is not a mutation target: the unmodified copy answers 'sealed'", async () => {
    expect(await scenarios.sealed(lab)).toBe('sealed')
  })

  test("cleanup removes only this run's own directories: a sibling run's sentinel under the same base survives", () => {
    const base = mkdtempSync(join(lab.dir, 'cleanup-base-'))
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
