import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// CANDIDATE C7. Applies the compat patch and the C2, C4 and C7 candidates only to temporary copies of the installed
// SDK, and uses disposable SQLite files. Nothing here opens, migrates or reads a real store.
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
const patches = {
  compat: join(repoRoot, 'patches/@earendil-works%2Fpi-durable@1.1.0.patch'),
  c2: join(adapterRoot, 'candidates/c2-store-fence/c2-store-fence.candidate.patch'),
  c4: join(adapterRoot, 'candidates/c4-close-writers/c4-close-writers.candidate.patch'),
  c7: join(adapterRoot, 'candidates/c7-read-only-open/c7-read-only-open.candidate.patch'),
}
const scratchBase = join(dirname(installed), '.c7-candidate-test')

const roots = []
// layers: how many candidates to stack on the compat patch, in order c2, c4, c7.
function makeSdk(layers) {
  mkdirSync(scratchBase, { recursive: true })
  const root = mkdtempSync(join(scratchBase, 'sdk-'))
  const pkg = join(root, 'pi-durable')
  cpSync(installed, pkg, { recursive: true, dereference: true })
  execFileSync('git', ['init', '-q'], { cwd: pkg })
  if (!existsSync(join(pkg, 'dist/harness/guarded-abort.js'))) {
    execFileSync('git', ['apply', patches.compat], { cwd: pkg })
    if (!existsSync(join(pkg, 'dist/harness/guarded-abort.js')))
      throw new Error('compatibility patch did not apply to the copy')
  }
  for (const layer of layers) execFileSync('git', ['apply', patches[layer]], { cwd: pkg })
  roots.push(root)
  return pkg
}
const load = (pkg) => import(pathToFileURL(join(pkg, 'dist/storage/sqlite/node.js')).href)

let v1 // compat only: writes schema 1
let v2 // compat + C2: writes schema 2
let v3 // compat + C2 + C4 + C7: writes schema 3 and opens read-only
let dir
let counter = 0
const context = {}
beforeAll(async () => {
  v1 = await load(makeSdk([]))
  v2 = await load(makeSdk(['c2']))
  v3 = await load(makeSdk(['c2', 'c4', 'c7']))
  dir = mkdtempSync(join(scratchBase, 'db-'))
  roots.push(dir)
})
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
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
async function write(storage) {
  const id = await storage.mintId()
  return storage.commit([{ type: 'conversation', value: { id } }], context)
}
// A cleanly closed store written by the given SDK build, with some data in it.
async function makeStore(sdk) {
  const path = dbPath()
  const storage = await sdk.openNodeSqliteStorage(path)
  await write(storage)
  await write(storage)
  await storage.close(context)
  return path
}
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const fingerprint = (path) => {
  const stat = statSync(path)
  return {
    sha256: digest(path),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    entries: readdirSync(dirname(path)).toSorted(),
  }
}
// Test-side reads use an immutable connection too: a plain readOnly connection to a WAL database creates -wal/-shm
// sidecars, which is exactly the side effect the candidate's read-only open avoids.
const immutableDatabase = (path) => {
  const uri = pathToFileURL(path)
  uri.search = '?mode=ro&immutable=1'
  return new DatabaseSync(uri.href, { readOnly: true })
}
const schemaVersion = (path) => {
  const database = immutableDatabase(path)
  try {
    return database.prepare('SELECT version FROM durable_schema').get().version
  } finally {
    database.close()
  }
}
const listing = (path) =>
  readdirSync(dirname(path)).filter((name) => name.startsWith(path.split('/').at(-1)))

describe('candidate C7 read-only open (disposable SQLite, patched copies only)', () => {
  test('byte identity: opening, reading and closing changes neither the bytes, the stat nor the directory', async () => {
    const path = await makeStore(v3)
    const before = fingerprint(path)
    const storage = await v3.openNodeSqliteStorage(path, { mode: 'read-only' })
    const page = await storage.scanConversations({}, 100, undefined, context)
    expect(page.items.length).toBe(2)
    await storage.close(context)
    expect(fingerprint(path)).toEqual(before)
    expect(listing(path)).toEqual([path.split('/').at(-1)])
  })

  test('reads return the same values a live owner returns from the same cut', async () => {
    const path = await makeStore(v3)
    const copy = `${path}.live`
    copyFileSync(path, copy)
    const live = await v3.openNodeSqliteStorage(copy)
    const owner = await live.scanConversations({}, 100, undefined, context)
    await live.close(context)
    const storage = await v3.openNodeSqliteStorage(path, { mode: 'read-only' })
    const detached = await storage.scanConversations({}, 100, undefined, context)
    expect(JSON.stringify(detached)).toBe(JSON.stringify(owner))
    // A document read goes through the transaction path, which must be a plain read transaction here.
    expect(await code(storage.document('missing', undefined, context))).not.toBe(
      'SQLite transaction failed and rollback failed'
    )
    await storage.close(context)
  })

  test('an absent file fails and creates neither the file nor its directory', async () => {
    const missingDir = join(dir, `absent-${counter++}`)
    const path = join(missingDir, 'store.sqlite')
    expect(await code(v3.openNodeSqliteStorage(path, { mode: 'read-only' }))).toBe(
      'PI_STORE_READ_ONLY_ABSENT'
    )
    expect(existsSync(missingDir)).toBe(false)
    const flat = dbPath()
    expect(await code(v3.openNodeSqliteStorage(flat, { mode: 'read-only' }))).toBe(
      'PI_STORE_READ_ONLY_ABSENT'
    )
    expect(existsSync(flat)).toBe(false)
    expect(listing(flat)).toEqual([])
  })

  test('a newer schema fails closed: no migration, bytes unchanged', async () => {
    const path = await makeStore(v3)
    const raw = new DatabaseSync(path)
    raw.exec('UPDATE durable_schema SET version = 99')
    raw.close()
    const before = fingerprint(path)
    expect(await code(v3.openNodeSqliteStorage(path, { mode: 'read-only' }))).toBe(
      'PI_STORE_READ_ONLY_SCHEMA_NEWER'
    )
    expect(fingerprint(path)).toEqual(before)
    expect(schemaVersion(path)).toBe(99)
  })

  test('an uninitialized or foreign file fails closed and is not touched', async () => {
    const empty = dbPath()
    writeFileSync(empty, '')
    const foreign = dbPath()
    const raw = new DatabaseSync(foreign)
    raw.exec('CREATE TABLE unrelated (a)')
    raw.close()
    for (const path of [empty, foreign]) {
      const before = fingerprint(path)
      expect(await code(v3.openNodeSqliteStorage(path, { mode: 'read-only' }))).toBe(
        'PI_STORE_READ_ONLY_SCHEMA_UNINITIALIZED'
      )
      expect(fingerprint(path)).toEqual(before)
    }
  })

  for (const [name, sdk, version] of [
    ['schema 1 (compat only)', () => v1, 1],
    ['schema 2 (C2 fence)', () => v2, 2],
    ['schema 3 (C4 closure)', () => v3, 3],
  ])
    test(`an older or current known store is read as is: ${name}, no migration`, async () => {
      const path = await makeStore(sdk())
      expect(schemaVersion(path)).toBe(version)
      const before = fingerprint(path)
      const storage = await v3.openNodeSqliteStorage(path, { mode: 'read-only' })
      expect((await storage.scanConversations({}, 100, undefined, context)).items.length).toBe(2)
      await storage.close(context)
      expect(schemaVersion(path)).toBe(version)
      expect(fingerprint(path)).toEqual(before)
    })

  test('a store with -wal, -shm or -journal sidecars is refused in the default mode, and nothing is changed', async () => {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const path = await makeStore(v3)
      writeFileSync(`${path}${suffix}`, 'x')
      const before = fingerprint(path)
      const sidecar = digest(`${path}${suffix}`)
      expect(await code(v3.openNodeSqliteStorage(path, { mode: 'read-only' }))).toBe(
        'PI_STORE_READ_ONLY_SIDECARS'
      )
      expect(fingerprint(path)).toEqual(before)
      expect(digest(`${path}${suffix}`)).toBe(sidecar)
    }
  })

  test('a live writer is not disturbed: its sidecars make the read-only open refuse, and a clean close lets it succeed', async () => {
    const path = dbPath()
    const writer = await v3.openNodeSqliteStorage(path)
    await write(writer)
    expect(listing(path).length).toBeGreaterThan(1) // WAL sidecars exist while the writer is open
    const sidecars = listing(path)
    expect(await code(v3.openNodeSqliteStorage(path, { mode: 'read-only' }))).toBe(
      'PI_STORE_READ_ONLY_SIDECARS'
    )
    // The refused open created and removed nothing, and the writer keeps working.
    expect(listing(path)).toEqual(sidecars)
    await write(writer)
    await writer.close(context)
    const reader = await v3.openNodeSqliteStorage(path, { mode: 'read-only' })
    expect((await reader.scanConversations({}, 100, undefined, context)).items.length).toBe(2)
    await reader.close(context)
  })

  test('a raw writer holding a transaction does not make the read-only open mutate anything', async () => {
    const path = await makeStore(v3)
    const raw = new DatabaseSync(path)
    // Switching to rollback-journal mode is the raw writer's own change; the fingerprint is taken after it.
    raw.exec('PRAGMA journal_mode = DELETE')
    const before = fingerprint(path)
    raw.exec('BEGIN IMMEDIATE')
    raw.exec('CREATE TABLE intruder (a)')
    // The open transaction leaves a -journal sidecar, so the read-only open is refused and writes nothing itself.
    const outcome = await code(v3.openNodeSqliteStorage(path, { mode: 'read-only' }))
    const during = listing(path)
    raw.exec('ROLLBACK')
    raw.close()
    expect(outcome).toBe('PI_STORE_READ_ONLY_SIDECARS')
    expect(during).toContain(`${path.split('/').at(-1)}-journal`)
    expect(fingerprint(path)).toEqual(before)
    expect(listing(path)).toEqual([path.split('/').at(-1)])
  })

  test('every mutating call rejects with PI_STORE_READ_ONLY and leaves bytes unchanged', async () => {
    const path = await makeStore(v3)
    const before = fingerprint(path)
    const storage = await v3.openNodeSqliteStorage(path, { mode: 'read-only' })
    const id = 'conv-x'
    const attempts = {
      commit: () => storage.commit([{ type: 'conversation', value: { id } }], context),
      commitGuarded: () =>
        storage.commitGuarded([{ type: 'conversation', value: { id } }], () => {}, context),
      mintId: () => storage.mintId(),
      acquireWriterFence: () =>
        storage.acquireWriterFence({
          ownerKey: 'o',
          lineageId: 'l',
          generation: 'g',
          expectedEpoch: 0,
        }),
      closeWriterFence: () => storage.closeWriterFence({ mutationId: 'm' }),
    }
    for (const [name, attempt] of Object.entries(attempts))
      expect([name, await code(attempt())]).toEqual([name, 'PI_STORE_READ_ONLY'])
    await storage.close(context)
    expect(fingerprint(path)).toEqual(before)
    // Neither a fence acquisition nor an epoch bump happened.
    expect(schemaVersion(path)).toBe(3)
    const raw = immutableDatabase(path)
    expect({ ...raw.prepare('SELECT epoch, armed FROM durable_writer_fence').get() }).toEqual({
      epoch: 0,
      armed: 0,
    })
    raw.close()
  })

  test('only read SQL reaches the database: no PRAGMA, no checkpoint, no write; a read-write close does checkpoint', async () => {
    const record = (storage) => {
      const seen = []
      const database = storage.db.database
      for (const method of ['exec', 'prepare']) {
        const original = database[method].bind(database)
        database[method] = (sql, ...rest) => {
          seen.push(sql.trim().replace(/\s+/g, ' '))
          return original(sql, ...rest)
        }
      }
      return seen
    }
    const path = await makeStore(v3)
    const readOnly = await v3.openNodeSqliteStorage(path, { mode: 'read-only' })
    const seen = record(readOnly)
    await readOnly.scanConversations({}, 100, undefined, context)
    await readOnly.document('missing', undefined, context)
    await readOnly.close(context)
    expect(seen.length).toBeGreaterThan(0)
    for (const sql of seen) expect(/^(SELECT|BEGIN$|ROLLBACK$)/i.test(sql)).toBe(true)
    // Control: the spy does see the checkpoint when a read-write storage closes.
    const copy = `${path}.rw`
    copyFileSync(path, copy)
    const readWrite = await v3.openNodeSqliteStorage(copy)
    const controlSeen = record(readWrite)
    await readWrite.close(context)
    expect(controlSeen.some((sql) => /wal_checkpoint/i.test(sql))).toBe(true)
  })

  test('data_version is unchanged around a read', async () => {
    const path = await makeStore(v3)
    const storage = await v3.openNodeSqliteStorage(path, { mode: 'read-only' })
    const before = await storage.db.get('PRAGMA data_version')
    await storage.scanConversations({}, 100, undefined, context)
    expect(await storage.db.get('PRAGMA data_version')).toEqual(before)
    await storage.close(context)
  })

  test('close is idempotent and the file is released', async () => {
    const path = await makeStore(v3)
    const storage = await v3.openNodeSqliteStorage(path, { mode: 'read-only' })
    const closing = storage.close(context)
    await closing
    expect(storage.close(context)).toBe(closing)
    expect(await code(storage.scanConversations({}, 1, undefined, context))).not.toBe('no error')
    // A read-write open of the same file afterwards works, which shows no lock was left behind.
    const rw = await v3.openNodeSqliteStorage(path)
    await write(rw)
    await rw.close(context)
  })

  test('the default mode is unchanged (creates and migrates), and an unknown mode is refused', async () => {
    const created = dbPath()
    const storage = await v3.openNodeSqliteStorage(created)
    await storage.close(context)
    expect(schemaVersion(created)).toBe(3)
    const explicit = await v3.openNodeSqliteStorage(created, { mode: 'read-write' })
    await explicit.close(context)
    expect(await code(v3.openNodeSqliteStorage(created, { mode: 'snapshot' }))).toBe(
      'PI_STORE_OPEN_MODE_INVALID'
    )
    expect(await code(v3.openNodeSqliteStorage(':memory:', { mode: 'read-only' }))).toBe(
      'PI_STORE_READ_ONLY_PATH_INVALID'
    )
  })
})
