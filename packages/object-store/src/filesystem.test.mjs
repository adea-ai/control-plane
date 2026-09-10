import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TextEncoder } from 'node:util'
import { FilesystemObjectStore } from './filesystem.ts'

const stores = []
afterEach(() => {
  for (const activeStore of stores.splice(0)) activeStore.close()
})

async function store() {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'control-plane-objects-'))
  const instance = new FilesystemObjectStore({ rootDirectory, maxObjectBytes: 1024 })
  stores.push(instance)
  return { rootDirectory, instance }
}

function objectPath(rootDirectory, key) {
  return join(rootDirectory, `sha256-${createHash('sha256').update(key).digest('hex')}`)
}

describe('FilesystemObjectStore', () => {
  test('preserves ObjectStore identity, metadata, integrity, and owner-only permissions', async () => {
    const { rootDirectory, instance } = await store()
    const body = new TextEncoder().encode('local artifact')
    const descriptor = await instance.put({
      key: 'artifacts/execution-1/result.json',
      body,
      contentType: 'application/json',
      metadata: { execution: 'execution-1' },
    })
    expect(await instance.head(descriptor.key)).toEqual(descriptor)
    expect(await instance.get(descriptor.key)).toEqual({ ...descriptor, body })
    const storedPath = objectPath(rootDirectory, descriptor.key)
    expect((await stat(storedPath)).mode & 0o777).toBe(0o600)
    expect((await stat(`${storedPath}.control-plane.json`)).mode & 0o777).toBe(0o600)
  })

  test('rejects traversal and oversized bodies', async () => {
    const { instance } = await store()
    await expect(instance.put({ key: '../escape', body: new Uint8Array() })).rejects.toMatchObject({
      code: 'OBJECT_STORE_INVALID_INPUT',
    })
    await expect(instance.put({ key: 'large', body: new Uint8Array(1025) })).rejects.toMatchObject({
      code: 'OBJECT_STORE_TOO_LARGE',
    })
  })

  test('detects body tampering and deletes both files idempotently', async () => {
    const { rootDirectory, instance } = await store()
    await instance.put({ key: 'artifact', body: new TextEncoder().encode('trusted') })
    await writeFile(objectPath(rootDirectory, 'artifact'), 'tampered')
    await chmod(objectPath(rootDirectory, 'artifact'), 0o600)
    await expect(instance.get('artifact')).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await instance.delete('artifact')
    await instance.delete('artifact')
    await expect(instance.head('artifact')).rejects.toMatchObject({
      code: 'OBJECT_STORE_NOT_FOUND',
    })
  })

  test('does not map logical key components onto filesystem directories', async () => {
    const { rootDirectory, instance } = await store()
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'control-plane-objects-outside-'))
    const outside = new FilesystemObjectStore({
      rootDirectory: outsideDirectory,
      maxObjectBytes: 1024,
    })
    stores.push(outside)
    await outside.put({ key: 'secret', body: new TextEncoder().encode('outside secret') })
    await symlink(outsideDirectory, join(rootDirectory, 'linked'), 'dir')

    await expect(instance.get('linked/secret')).rejects.toMatchObject({
      code: 'OBJECT_STORE_NOT_FOUND',
    })
    await instance.put({ key: 'linked/created', body: new TextEncoder().encode('contained') })
    expect(await instance.get('linked/created')).toMatchObject({
      body: new TextEncoder().encode('contained'),
    })
    await instance.delete('linked/secret')

    expect(await outside.get('secret')).toMatchObject({
      body: new TextEncoder().encode('outside secret'),
    })
    await expect(readFile(join(outsideDirectory, 'created'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('rejects final body and metadata symlinks without touching their targets', async () => {
    const { rootDirectory, instance } = await store()
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'control-plane-objects-targets-'))
    const outsideBody = join(outsideDirectory, 'outside-body')
    const outsideMetadata = join(outsideDirectory, 'outside-metadata')
    await writeFile(outsideBody, 'trusted', { mode: 0o600 })
    await writeFile(outsideMetadata, 'outside metadata', { mode: 0o600 })
    await instance.put({ key: 'artifact', body: new TextEncoder().encode('trusted') })
    const bodyPath = objectPath(rootDirectory, 'artifact')
    const metadataPath = `${bodyPath}.control-plane.json`

    await rm(bodyPath)
    await symlink(outsideBody, bodyPath)
    await expect(instance.get('artifact')).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await expect(instance.delete('artifact')).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    expect(await readFile(outsideBody, 'utf8')).toBe('trusted')

    await rm(bodyPath)
    await writeFile(bodyPath, 'trusted', { mode: 0o600 })
    await rm(metadataPath)
    await symlink(outsideMetadata, metadataPath)
    await expect(instance.head('artifact')).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
    await expect(
      instance.put({ key: 'artifact', body: new TextEncoder().encode('replacement') })
    ).rejects.toMatchObject({ code: 'OBJECT_STORE_INTEGRITY_FAILURE' })
    expect(await readFile(outsideMetadata, 'utf8')).toBe('outside metadata')
  })

  test('fails closed when the configured root is replaced between operations', async () => {
    const { rootDirectory, instance } = await store()
    await instance.put({ key: 'artifact', body: new TextEncoder().encode('trusted') })
    await rename(rootDirectory, `${rootDirectory}-replaced`)
    await mkdir(rootDirectory, { mode: 0o700 })

    await expect(instance.get('artifact')).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
    })
  })

  test('normalizes filesystem read failures without reporting missing objects', async () => {
    const { rootDirectory, instance } = await store()
    await instance.put({ key: 'artifact', body: new TextEncoder().encode('trusted') })
    await chmod(rootDirectory, 0o000)
    try {
      await expect(instance.get('artifact')).rejects.toMatchObject({
        code: 'OBJECT_STORE_PROVIDER_FAILURE',
      })
    } finally {
      await chmod(rootDirectory, 0o700)
    }
  })
})
