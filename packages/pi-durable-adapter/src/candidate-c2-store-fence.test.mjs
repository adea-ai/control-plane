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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// CANDIDATE C2. Applies the candidate patch only to temporary copies of the installed SDK.
const here = dirname(fileURLToPath(import.meta.url))
const adapterRoot = resolve(here, '..')
const repoRoot = resolve(adapterRoot, '../..')
const installed = realpathSync(join(adapterRoot, 'node_modules/@earendil-works/pi-durable'))
const compatPatch = join(repoRoot, 'patches/@earendil-works%2Fpi-durable@1.1.0.patch')
const candidatePatch = join(adapterRoot, 'candidates/c2-store-fence/c2-store-fence.candidate.patch')
// Inside the package's node_modules so the copy resolves the SDK's own dependencies.
const scratchBase = join(adapterRoot, 'node_modules/.c2-candidate-test')

const roots = []
function makeSdk({ candidate }) {
  mkdirSync(scratchBase, { recursive: true })
  const root = mkdtempSync(join(scratchBase, 'sdk-'))
  const pkg = join(root, 'pi-durable')
  cpSync(installed, pkg, { recursive: true, dereference: true })
  // Make the copy its own repository root so `git apply` cannot skip paths as outside a parent repo.
  execFileSync('git', ['init', '-q'], { cwd: pkg })
  if (!existsSync(join(pkg, 'dist/harness/guarded-abort.js'))) {
    execFileSync('git', ['apply', compatPatch], { cwd: pkg })
    if (!existsSync(join(pkg, 'dist/harness/guarded-abort.js')))
      throw new Error('compatibility patch did not apply to the copy')
  }
  if (candidate) {
    execFileSync('git', ['apply', candidatePatch], { cwd: pkg })
    if (
      !readFileSync(join(pkg, 'dist/storage/sqlite/storage.js'), 'utf8').includes(
        'acquireWriterFence'
      )
    )
      throw new Error('candidate patch did not apply to the copy')
  }
  roots.push(root)
  return pkg
}
async function load(pkg) {
  return import(pathToFileURL(join(pkg, 'dist/storage/sqlite/node.js')).href)
}

let candidatePkg
let compatPkg
let candidate
let compat
let dir
let counter = 0
const context = {}
beforeAll(async () => {
  candidatePkg = makeSdk({ candidate: true })
  compatPkg = makeSdk({ candidate: false })
  candidate = await load(candidatePkg)
  compat = await load(compatPkg)
  dir = mkdtempSync(join(scratchBase, 'db-'))
  roots.push(dir)
})
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
const dbPath = () => join(dir, `store-${counter++}.sqlite`)
const request = (over = {}) => ({
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

describe('candidate C2 store fence (disposable SQLite, patched copy only)', () => {
  test('the candidate applies on top of the compatibility patch and not onto an unpatched tree', () => {
    expect(existsSync(join(candidatePkg, 'dist/harness/guarded-abort.js'))).toBe(true)
    expect(existsSync(join(candidatePkg, 'dist/storage/sqlite/migrations.js'))).toBe(true)
  })

  test('an unarmed store behaves as before: commits need no token', async () => {
    const path = dbPath()
    const storage = await candidate.openNodeSqliteStorage(path)
    await write(storage)
    await write(storage)
    await storage.close(context)
  })

  test('acquire arms the fence and the bound holder keeps committing', async () => {
    const storage = await candidate.openNodeSqliteStorage(dbPath())
    const token = await storage.acquireWriterFence(request())
    expect(token).toEqual({
      ownerKey: 'owner:a',
      epoch: 1,
      lineageId: 'lineage:1',
      generation: 'gen:1',
    })
    expect(Object.isFrozen(token)).toBe(true)
    await write(storage)
    await write(storage)
    await storage.close(context)
  })

  test('an unregistered second writer on the same file is fenced before any write', async () => {
    const path = dbPath()
    const holder = await candidate.openNodeSqliteStorage(path)
    await holder.acquireWriterFence(request())
    const seqBefore = await write(holder)
    const stranger = await candidate.openNodeSqliteStorage(path)
    expect(await code(write(stranger))).toBe('PI_STORE_FENCED')
    const seqAfter = await write(holder)
    expect(seqAfter).toBe(seqBefore + 1)
    await holder.close(context)
    await stranger.close(context)
  })

  test('a later acquire fences the earlier holder, even in another connection', async () => {
    const path = dbPath()
    const first = await candidate.openNodeSqliteStorage(path)
    await first.acquireWriterFence(request())
    const seq = await write(first)
    const second = await candidate.openNodeSqliteStorage(path)
    const token = await second.acquireWriterFence(
      request({ ownerKey: 'owner:b', expectedEpoch: 1 })
    )
    expect(token.epoch).toBe(2)
    expect(await code(write(first))).toBe('PI_STORE_FENCED')
    expect(await write(second)).toBe(seq + 1)
    await first.close(context)
    await second.close(context)
  })

  test('a fenced commit writes nothing', async () => {
    const path = dbPath()
    const first = await candidate.openNodeSqliteStorage(path)
    await first.acquireWriterFence(request())
    const second = await candidate.openNodeSqliteStorage(path)
    await second.acquireWriterFence(request({ ownerKey: 'owner:b', expectedEpoch: 1 }))
    const before = await second.scanConversations({}, 100, undefined, context)
    expect(await code(write(first))).toBe('PI_STORE_FENCED')
    const after = await second.scanConversations({}, 100, undefined, context)
    expect(after.items.length).toBe(before.items.length)
    await first.close(context)
    await second.close(context)
  })

  test('guarded commits are fenced too', async () => {
    const path = dbPath()
    const first = await candidate.openNodeSqliteStorage(path)
    await first.acquireWriterFence(request())
    const second = await candidate.openNodeSqliteStorage(path)
    await second.acquireWriterFence(request({ ownerKey: 'owner:b', expectedEpoch: 1 }))
    const id = await first.mintId()
    let guardRan = false
    const outcome = await code(
      first.commitGuarded(
        [{ type: 'conversation', value: { id } }],
        () => (guardRan = true),
        context
      )
    )
    expect(outcome).toBe('PI_STORE_FENCED')
    expect(guardRan).toBe(false)
    await first.close(context)
    await second.close(context)
  })

  test('acquire refuses a stale epoch, a wrong generation and malformed requests', async () => {
    const path = dbPath()
    const storage = await candidate.openNodeSqliteStorage(path)
    await storage.acquireWriterFence(request())
    expect(await code(storage.acquireWriterFence(request({ expectedEpoch: 0 })))).toBe(
      'PI_STORE_FENCE_STALE'
    )
    expect(
      await code(
        storage.acquireWriterFence(request({ expectedEpoch: 1, expectedGeneration: 'gen:other' }))
      )
    ).toBe('PI_STORE_FENCE_GENERATION')
    for (const bad of [
      null,
      request({ ownerKey: '' }),
      request({ expectedEpoch: -1 }),
      request({ generation: ' x' }),
    ])
      expect(await code(storage.acquireWriterFence(bad))).toBe('PI_STORE_FENCE_REQUEST_INVALID')
    // None of the refusals advanced the epoch.
    expect((await storage.acquireWriterFence(request({ expectedEpoch: 1 }))).epoch).toBe(2)
    await storage.close(context)
  })

  test('reads are not fenced', async () => {
    const path = dbPath()
    const first = await candidate.openNodeSqliteStorage(path)
    await first.acquireWriterFence(request())
    await write(first)
    const second = await candidate.openNodeSqliteStorage(path)
    await second.acquireWriterFence(request({ ownerKey: 'owner:b', expectedEpoch: 1 }))
    expect((await first.scanConversations({}, 100, undefined, context)).items.length).toBe(1)
    await first.close(context)
    await second.close(context)
  })

  test('downgrade hazard: the compatibility-patched SDK refuses a store the candidate migrated', async () => {
    const path = dbPath()
    const storage = await candidate.openNodeSqliteStorage(path)
    await storage.close(context)
    expect(await code(compat.openNodeSqliteStorage(path))).toMatch(/newer than supported/)
  })

  test('a store created by the compatibility patch migrates to an unarmed fence', async () => {
    const path = dbPath()
    const legacy = await compat.openNodeSqliteStorage(path)
    await write(legacy)
    await legacy.close(context)
    const upgraded = await candidate.openNodeSqliteStorage(path)
    await write(upgraded)
    await upgraded.close(context)
  })
})
