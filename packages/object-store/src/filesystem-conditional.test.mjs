import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemObjectStore } from './filesystem.ts'

const ownedRoots = new Set()
const ownedStores = new Set()

afterEach(async () => {
  for (const store of ownedStores) store.close()
  ownedStores.clear()
  for (const root of ownedRoots) {
    const entries = await readdir(root).catch(() => [])
    expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([])
    await rm(root, { recursive: true, force: true })
    ownedRoots.delete(root)
  }
})

async function makeStore(maxObjectBytes = 1024) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'm11-filesystem-artifact-'))
  ownedRoots.add(rootDirectory)
  return { rootDirectory, store: openStore(rootDirectory, maxObjectBytes) }
}

function openStore(rootDirectory, maxObjectBytes = 1024) {
  const store = new FilesystemObjectStore({ rootDirectory, maxObjectBytes })
  ownedStores.add(store)
  return store
}

function legacyBodyPath(rootDirectory, key) {
  return join(rootDirectory, `sha256-${createHash('sha256').update(key).digest('hex')}`)
}

function conditionalPath(rootDirectory, key) {
  return `${legacyBodyPath(rootDirectory, key)}.conditional-v1`
}

function writeModePath(rootDirectory, key) {
  return `${legacyBodyPath(rootDirectory, key)}.write-mode-v1`
}

async function createModeClaim(path, mode) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`CPFSMOD1\n${mode}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const value = (key, bytes, metadata = { attempt: 'one' }) => ({
  key,
  body: new Uint8Array(bytes),
  contentType: 'application/octet-stream',
  metadata,
})

describe('FilesystemObjectStore conditional publication', () => {
  test('publishes one complete envelope and cold reopen verifies the original object', async () => {
    const { rootDirectory, store } = await makeStore()
    const input = value('attempts/a/artifacts/result.bin', [0, 1, 2, 255])

    const result = await store.putIfAbsent(input)

    expect(result).toMatchObject({
      outcome: 'created',
      object: {
        key: input.key,
        size: input.body.length,
        contentType: input.contentType,
        metadata: input.metadata,
      },
    })
    expect(await store.get(input.key)).toMatchObject({ ...result.object, body: input.body })
    expect(await readdir(rootDirectory)).toHaveLength(2)
    store.close()
    const reopened = openStore(rootDirectory)
    expect(await reopened.get(input.key)).toMatchObject({ ...result.object, body: input.body })
    expect(await reopened.head(input.key)).toEqual(result.object)
  })

  test('independent instances that both observe a missing key publish exactly one winner', async () => {
    const { rootDirectory, store: first } = await makeStore()
    const second = openStore(rootDirectory)
    const firstValue = value('attempts/race/result', [1, 2, 3])
    const secondValue = value('attempts/race/result', [8, 9])
    await expect(first.head(firstValue.key)).rejects.toMatchObject({
      code: 'OBJECT_STORE_NOT_FOUND',
    })
    await expect(second.head(secondValue.key)).rejects.toMatchObject({
      code: 'OBJECT_STORE_NOT_FOUND',
    })

    const results = await Promise.all([
      first.putIfAbsent(firstValue),
      second.putIfAbsent(secondValue),
    ])

    expect(results.map(({ outcome }) => outcome).toSorted()).toEqual(['created', 'exists'])
    const winner = await first.get(firstValue.key)
    expect([firstValue.body, secondValue.body]).toContainEqual(winner.body)
    expect(await second.putIfAbsent({ ...firstValue })).toEqual({ outcome: 'exists' })
    expect(await readdir(rootDirectory)).toHaveLength(2)
  })

  test('separate child processes wait after both observe missing and leave one durable winner', async () => {
    const { rootDirectory, store } = await makeStore()
    const script = `
      import { FilesystemObjectStore } from ${JSON.stringify(new URL('./filesystem.ts', import.meta.url).href)};
      import { createInterface } from 'node:readline';
      const [root, bodyBase64] = process.argv.slice(1);
      const store = new FilesystemObjectStore({ rootDirectory: root, maxObjectBytes: 1024 });
      try { await store.head('process/race/result'); } catch (error) {
        if (error.code !== 'OBJECT_STORE_NOT_FOUND') throw error;
      }
      const input = createInterface({ input: process.stdin });
      process.stdout.write('ready' + String.fromCharCode(10));
      input.once('line', async () => {
        try {
          const result = await store.putIfAbsent({
            key: 'process/race/result', body: new Uint8Array(Buffer.from(bodyBase64, 'base64')),
            metadata: { contender: bodyBase64 },
          });
          process.stdout.write(JSON.stringify(result) + String.fromCharCode(10));
          store.close(); input.close();
        } catch (error) {
          process.stderr.write(String(error?.code ?? error)); process.exitCode = 1;
          store.close(); input.close();
        }
      });
    `
    const children = []
    try {
      const contenderA = startContender(script, rootDirectory, 'fs-conditional-contender-a', [3, 4])
      children.push(contenderA)
      const contenderB = startContender(script, rootDirectory, 'fs-conditional-contender-b', [7, 8])
      children.push(contenderB)
      const ready = await Promise.all(children.map((child) => child.readLine()))
      expect(ready).toEqual(['ready', 'ready'])
      children.forEach((child) => child.process.stdin.write('go\n'))
      const records = await Promise.all(children.map((child) => child.readLine()))
      const exits = await Promise.all(children.map((child) => child.exit))
      expect(exits.map((status) => status.code)).toEqual([0, 0])
      expect(exits.map((status) => status.signal)).toEqual([null, null])
      expect(exits.map((status) => status.error)).toEqual([undefined, undefined])
      expect(records.map((line) => JSON.parse(line).outcome).toSorted()).toEqual([
        'created',
        'exists',
      ])
      store.close()
      const reopened = openStore(rootDirectory)
      const persisted = await reopened.get('process/race/result')
      expect([
        [3, 4],
        [7, 8],
      ]).toContainEqual([...persisted.body])
    } finally {
      for (const child of children) {
        if (child.process.exitCode === null && child.process.signalCode === null)
          child.process.kill()
      }
      await Promise.all(children.map((child) => child.exit.catch(() => undefined)))
    }
  })

  test('ordinary mutable put cannot replace a conditional envelope, but delete removes it', async () => {
    const { rootDirectory, store: conditionalStore } = await makeStore()
    const mutableStore = openStore(rootDirectory)
    const original = value('immutable/result', [1, 2, 3])
    await conditionalStore.putIfAbsent(original)

    await expect(
      mutableStore.put({ ...original, body: new Uint8Array([9]) })
    ).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    expect(await conditionalStore.get(original.key)).toMatchObject({ body: original.body })
    await conditionalStore.delete(original.key)
    await mutableStore.delete(original.key)
    await expect(conditionalStore.get(original.key)).rejects.toMatchObject({
      code: 'OBJECT_STORE_NOT_FOUND',
    })
    expect(await readdir(rootDirectory)).toEqual([])
  })

  test('mutable publication mode fences a cross-process conditional race after mutable preflight', async () => {
    const { rootDirectory, store } = await makeStore()
    const input = value('mixed-mode/result', [1, 2, 3])
    const script = `
      import fs from 'node:fs';
      import { createInterface } from 'node:readline';
      const originalRename = fs.promises.rename;
      let resumeMutable;
      let paused = false;
      fs.promises.rename = async (...args) => {
        if (!paused && String(args[0]).includes('.tmp')) {
          paused = true;
          process.stdout.write('mutable-paused' + String.fromCharCode(10));
          await new Promise((resolve) => { resumeMutable = resolve; });
        }
        return originalRename(...args);
      };
      const { FilesystemObjectStore } = await import(${JSON.stringify(new URL('./filesystem.ts', import.meta.url).href)});
      const [root, bodyBase64] = process.argv.slice(1);
      const store = new FilesystemObjectStore({ rootDirectory: root, maxObjectBytes: 1024 });
      const input = { key: 'mixed-mode/result', body: new Uint8Array(Buffer.from(bodyBase64, 'base64')), metadata: { writer: 'mutable' } };
      const control = createInterface({ input: process.stdin });
      control.on('line', (line) => {
        if (line === 'start') {
          void store.put(input).then((object) => {
            process.stdout.write(JSON.stringify({ object }) + String.fromCharCode(10));
            store.close(); control.close();
          }, (error) => {
            process.stderr.write(String(error?.code ?? error)); process.exitCode = 1;
            store.close(); control.close();
          });
        } else if (line === 'resume') {
          resumeMutable?.();
        }
      });
      process.stdout.write('ready' + String.fromCharCode(10));
    `
    const child = startContender(script, rootDirectory, 'fs-mixed-mode-mutable-child', input.body)
    let conditionalResult
    let mutableResult
    let childResult
    let childExit
    try {
      expect(await child.readLine()).toBe('ready')
      child.process.stdin.write('start\n')
      expect(await child.readLine()).toBe('mutable-paused')
      try {
        conditionalResult = await store.putIfAbsent(input)
      } catch (error) {
        conditionalResult = { error }
      }
    } finally {
      if (child.process.exitCode === null && child.process.signalCode === null) {
        child.process.stdin.write('resume\n')
        childResult = await child.readLine().catch(() => undefined)
      }
      childExit = await child.exit
    }
    mutableResult = JSON.parse(childResult).object
    expect(childExit.code).toBe(0)
    expect(childExit.signal).toBeNull()
    expect(conditionalResult).toMatchObject({
      error: { code: 'OBJECT_STORE_PROVIDER_FAILURE', retryable: true },
    })
    expect(await store.head(input.key)).toEqual(mutableResult)
    expect(await store.get(input.key)).toMatchObject({ ...mutableResult, body: input.body })
  })

  test('a durable conditional-only mode claim is resumed after cold reopen', async () => {
    const { rootDirectory, store } = await makeStore()
    const input = value('mode-recovery/conditional', [4, 5, 6])
    await createModeClaim(writeModePath(rootDirectory, input.key), 'conditional')
    store.close()
    const reopened = openStore(rootDirectory)
    await expect(reopened.put(input)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })

    const result = await reopened.putIfAbsent(input)

    expect(result.outcome).toBe('created')
    expect(await reopened.get(input.key)).toMatchObject({ ...result.object, body: input.body })
    expect(await readdir(rootDirectory)).toHaveLength(2)
  })

  test('a pre-mode conditional envelope still blocks mutable overwrite and counts as existing', async () => {
    const { rootDirectory, store } = await makeStore()
    const input = value('legacy-mode/conditional', [8, 9])
    await store.putIfAbsent(input)
    await rm(writeModePath(rootDirectory, input.key))
    const previousModeStore = openStore(rootDirectory)

    await expect(previousModeStore.put(input)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    expect(await previousModeStore.putIfAbsent(input)).toEqual({ outcome: 'exists' })
    expect(await previousModeStore.get(input.key)).toMatchObject({ body: input.body })
  })

  test('a mutable-only claim is retryable for create-only until the legacy object is complete', async () => {
    const { rootDirectory, store } = await makeStore()
    const input = value('mode-recovery/mutable', [7, 8])
    await createModeClaim(writeModePath(rootDirectory, input.key), 'mutable')

    await expect(store.putIfAbsent(input)).rejects.toMatchObject({
      code: 'OBJECT_STORE_PROVIDER_FAILURE',
      retryable: true,
    })
    const descriptor = await store.put(input)
    expect(await store.putIfAbsent(input)).toEqual({ outcome: 'exists' })
    expect(await store.get(input.key)).toMatchObject({ ...descriptor, body: input.body })
  })

  test('write mode claims reject symlinks, special files, malformed bytes, and oversized contents', async () => {
    const { rootDirectory, store } = await makeStore()
    const input = value('invalid-mode/result', [1])
    const modePath = writeModePath(rootDirectory, input.key)
    const outsideRoot = await mkdtemp(join(tmpdir(), 'm11-filesystem-artifact-mode-'))
    ownedRoots.add(outsideRoot)
    const target = join(outsideRoot, 'target')
    await writeFile(target, 'CPFSMOD1\nconditional\n')

    await symlink(target, modePath)
    await expect(store.putIfAbsent(input)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await expect(store.put(input)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await rm(modePath)
    await mkdir(modePath, { mode: 0o700 })
    await expect(store.putIfAbsent(input)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await rm(modePath, { recursive: true })
    await writeFile(modePath, 'not-a-mode')
    await expect(store.putIfAbsent(input)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await rm(modePath)
    await writeFile(modePath, 'x'.repeat(65))
    await expect(store.put(input)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
  })

  test('legacy two-file objects remain readable and count as existing without replacement', async () => {
    const { store } = await makeStore()
    const original = value('legacy/result', [6, 5, 4])
    const descriptor = await store.put(original)

    expect(await store.putIfAbsent({ ...original, body: new Uint8Array([0]) })).toEqual({
      outcome: 'exists',
    })
    expect(await store.get(original.key)).toMatchObject({ ...descriptor, body: original.body })
    await store.put({ ...original, body: new Uint8Array([2]) })
    expect(await store.get(original.key)).toMatchObject({ body: new Uint8Array([2]) })
  })

  test('never falls back to a legacy body when a conditional envelope exists but is malformed', async () => {
    const { rootDirectory, store } = await makeStore()
    const legacy = value('legacy/prefer-conditional', [6, 6])
    await store.put(legacy)
    const other = value('other/key', [9, 9])
    await store.putIfAbsent(other)
    const malformedForRequestedKey = await readFile(conditionalPath(rootDirectory, other.key))
    await writeFile(conditionalPath(rootDirectory, legacy.key), malformedForRequestedKey)

    await expect(store.get(legacy.key)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
  })

  test('accepts the full bounded metadata contract when JSON escaping expands the header', async () => {
    const { store } = await makeStore()
    const metadata = { payload: '\u0000'.repeat(8_000) }
    const input = { ...value('large-metadata/header', [1]), metadata }

    const created = await store.putIfAbsent(input)

    expect(created.outcome).toBe('created')
    expect((await store.get(input.key)).metadata).toEqual(metadata)
  })

  test('conditional final symlinks, special files, root replacement, and malformed envelopes fail closed', async () => {
    const { rootDirectory, store } = await makeStore()
    const input = value('unsafe/result', [1, 2])
    await store.putIfAbsent(input)
    const envelope = conditionalPath(rootDirectory, input.key)
    const validBytes = await readFile(envelope)

    await writeFile(envelope, validBytes.subarray(0, 7))
    await expect(store.get(input.key)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await writeFile(envelope, validBytes)
    const oversizedHeader = Buffer.from(validBytes)
    oversizedHeader.writeUInt32BE(1024 * 1024, 8)
    await writeFile(envelope, oversizedHeader)
    await expect(store.head(input.key)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await writeFile(envelope, validBytes)
    const tampered = Buffer.from(validBytes)
    tampered[tampered.length - 1] ^= 1
    await writeFile(envelope, tampered)
    await expect(store.get(input.key)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await writeFile(envelope, validBytes)

    const outsideRoot = await mkdtemp(join(tmpdir(), 'm11-filesystem-artifact-outside-'))
    ownedRoots.add(outsideRoot)
    const target = join(outsideRoot, 'target')
    await writeFile(target, validBytes)
    await rm(envelope)
    await mkdir(envelope, { mode: 0o700 })
    await expect(store.get(input.key)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await expect(store.putIfAbsent(input)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await rm(envelope, { recursive: true })
    await writeFile(envelope, validBytes)
    await rm(envelope)
    await symlink(target, envelope)
    await expect(store.get(input.key)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await expect(store.putIfAbsent(input)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    expect(await readFile(target)).toEqual(validBytes)
    await rm(envelope)
    await writeFile(envelope, validBytes)
    const movedRoot = `${rootDirectory}-moved`
    await rename(rootDirectory, movedRoot)
    ownedRoots.add(movedRoot)
    await mkdir(rootDirectory, { mode: 0o700 })
    await expect(store.get(input.key)).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
  })

  test('rejects invalid keys and oversized bodies before creating an envelope', async () => {
    const { rootDirectory, store } = await makeStore(8)
    await expect(store.putIfAbsent(value('../escape', [1]))).rejects.toMatchObject({
      code: 'OBJECT_STORE_INVALID_INPUT',
    })
    await expect(
      store.putIfAbsent(
        value(
          'large',
          Array.from({ length: 9 }, () => 1)
        )
      )
    ).rejects.toMatchObject({
      code: 'OBJECT_STORE_TOO_LARGE',
    })
    expect(await readdir(rootDirectory)).toEqual([])
  })
})

function startContender(script, rootDirectory, label, bytes) {
  const child = spawn(
    process.execPath,
    ['-e', script, rootDirectory, Buffer.from(bytes).toString('base64')],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  console.info(`owned-child ${label} pid=${child.pid}`)
  const lines = createInterface({ input: child.stdout })
  const pendingLines = []
  const waiters = []
  let errorOutput = ''
  child.stderr.on('data', (chunk) => {
    if (errorOutput.length < 4_096)
      errorOutput += chunk.toString().slice(0, 4_096 - errorOutput.length)
  })
  lines.on('line', (line) => {
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(line)
    else pendingLines.push(line)
  })
  const childDeadline = setTimeout(() => child.kill(), 15_000)
  const exit = new Promise((resolve) => {
    child.once('error', (error) => {
      clearTimeout(childDeadline)
      while (waiters.length) waiters.shift().reject(error)
      resolve({ code: null, signal: null, error, stderr: errorOutput })
    })
    child.once('exit', (code, signal) => {
      clearTimeout(childDeadline)
      lines.close()
      while (waiters.length)
        waiters.shift().reject(new Error(`child exited before output: ${label}`))
      resolve({ code: signal ? null : code, signal, stderr: errorOutput })
    })
  })
  lines.once('close', () => {
    while (waiters.length) waiters.shift().reject(new Error(`child output closed: ${label}`))
  })
  // label is intentionally attached to the recorded ChildProcess for cleanup diagnostics.
  child.resourceLabel = label
  return {
    process: child,
    exit,
    readLine: (timeoutMs = 5_000) => {
      if (pendingLines.length) return Promise.resolve(pendingLines.shift())
      return new Promise((resolve, reject) => {
        let waiter
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error(`timed out waiting for child output: ${label}`))
        }, timeoutMs)
        waiter = {
          resolve: (line) => {
            clearTimeout(timer)
            resolve(line)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        }
        waiters.push(waiter)
      })
    },
  }
}
