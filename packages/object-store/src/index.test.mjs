import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { TextEncoder } from 'node:util'
import {
  ObjectStoreError,
  R2ObjectStore,
  createR2ObjectStore,
  createS3CompatibleObjectStore,
} from './index.ts'

const configuration = {
  endpoint: 'https://account-id.r2.cloudflarestorage.com',
  bucket: 'ctrl-plane',
  region: 'auto',
  accessKeyId: 'access-key-id',
  secretAccessKey: 'secret-access-key',
}

describe('R2ObjectStore', () => {
  test('constructs a generic S3-compatible client with an operator-selected region', () => {
    const configurations = []
    const store = createS3CompatibleObjectStore(
      {
        endpoint: 'https://objects.example.test',
        bucket: 'control-plane',
        region: 'us-east-1',
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
      },
      {
        maxObjectBytes: 1024,
        createClient: (clientOptions) => {
          configurations.push(clientOptions)
          return { send: async () => ({}) }
        },
      }
    )
    expect(configurations).toMatchObject([
      { endpoint: 'https://objects.example.test', region: 'us-east-1', forcePathStyle: true },
    ])
    store.close()
  })
  test('constructs an S3-compatible client without exposing configuration on the store', () => {
    let clientConfiguration
    const store = createR2ObjectStore(configuration, {
      maxObjectBytes: 1024,
      createClient: (value) => {
        clientConfiguration = value
        return { send: async () => ({}) }
      },
    })

    expect(clientConfiguration).toEqual({
      endpoint: configuration.endpoint,
      region: 'auto',
      forcePathStyle: true,
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
    })
    expect(JSON.stringify(store)).not.toContain('secret-access-key')
  })

  test('writes, reads, heads, and deletes through the provider-neutral contract', async () => {
    const calls = []
    const body = new TextEncoder().encode('staging-object')
    const checksum = createHash('sha256').update(body).digest('hex')
    const client = {
      async send(command) {
        calls.push({ name: command.constructor.name, input: command.input })
        if (command.constructor.name === 'PutObjectCommand') return { ETag: '"etag-1"' }
        if (command.constructor.name === 'GetObjectCommand') {
          return {
            Body: { transformToByteArray: async () => body },
            ContentLength: body.byteLength,
            ContentType: 'application/json',
            ETag: '"etag-1"',
            Metadata: { 'control-plane-sha256': checksum, workspace: 'workspace-1' },
          }
        }
        if (command.constructor.name === 'HeadObjectCommand') {
          return {
            ContentLength: body.byteLength,
            ContentType: 'application/json',
            ETag: '"etag-1"',
            Metadata: { 'control-plane-sha256': checksum, workspace: 'workspace-1' },
          }
        }
        return {}
      },
    }
    const store = new R2ObjectStore({
      bucket: configuration.bucket,
      client,
      maxObjectBytes: 1024,
    })

    const written = await store.put({
      key: 'm9/synthetic/object.json',
      body,
      contentType: 'application/json',
      metadata: { workspace: 'workspace-1' },
    })
    const read = await store.get('m9/synthetic/object.json')
    const headed = await store.head('m9/synthetic/object.json')
    await store.delete('m9/synthetic/object.json')

    expect(written).toMatchObject({ key: 'm9/synthetic/object.json', size: body.byteLength })
    expect(written.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(read).toEqual({
      ...headed,
      body,
    })
    expect(calls.map(({ name }) => name)).toEqual([
      'PutObjectCommand',
      'GetObjectCommand',
      'HeadObjectCommand',
      'DeleteObjectCommand',
    ])
    expect(calls[0].input).toMatchObject({
      Bucket: 'ctrl-plane',
      Key: 'm9/synthetic/object.json',
      ContentLength: body.byteLength,
      Metadata: { 'control-plane-sha256': checksum, workspace: 'workspace-1' },
    })
  })

  test('applies the environment prefix to every provider address while exposing visible keys', async () => {
    const calls = []
    const store = new R2ObjectStore({
      bucket: configuration.bucket,
      prefix: 'staging/',
      client: {
        put: undefined,
        send: async (command) => {
          calls.push(command)
          return {
            ETag: 'etag-value',
            ContentLength: 5,
            Metadata: { 'control-plane-sha256': 'a'.repeat(64) },
          }
        },
      },
      maxObjectBytes: 1024,
    })
    const put = await store.put({ key: 'm9/object.json', body: new Uint8Array([1, 2, 3, 4, 5]) })
    expect(put.key).toBe('m9/object.json')
    await store.head('m9/object.json')
    expect(calls.map((command) => command.input.Key)).toEqual([
      'staging/m9/object.json',
      'staging/m9/object.json',
    ])

    const withoutPrefix = []
    const plain = new R2ObjectStore({
      bucket: configuration.bucket,
      client: {
        send: async (command) => {
          withoutPrefix.push(command)
          return {
            ETag: 'e',
            ContentLength: 5,
            Metadata: { 'control-plane-sha256': 'a'.repeat(64) },
          }
        },
      },
      maxObjectBytes: 1024,
    })
    await plain.put({ key: 'm9/object.json', body: new Uint8Array([1, 2, 3, 4, 5]) })
    expect(withoutPrefix[0].input.Key).toBe('m9/object.json')
  })

  test('rejects unsafe environment prefixes at construction', () => {
    for (const prefix of ['/absolute/', '../escape/', 'a//b', './x/', 'bad prefix/']) {
      expect(
        () =>
          new R2ObjectStore({
            bucket: configuration.bucket,
            prefix,
            client: { send: async () => ({}) },
            maxObjectBytes: 1024,
          })
      ).toThrow()
    }
  })

  test('fails closed when provider content does not match the stored checksum', async () => {
    const body = new TextEncoder().encode('tampered')
    const store = new R2ObjectStore({
      bucket: configuration.bucket,
      client: {
        send: async () => ({
          Body: { transformToByteArray: async () => body },
          ContentLength: body.byteLength,
          Metadata: { 'control-plane-sha256': '0'.repeat(64) },
        }),
      },
      maxObjectBytes: 1024,
    })

    await expect(store.get('m9/synthetic/object.json')).rejects.toMatchObject({
      code: 'OBJECT_STORE_INTEGRITY_FAILURE',
      retryable: false,
    })
  })

  test('rejects invalid keys, oversized payloads, and unsafe metadata before provider calls', async () => {
    let calls = 0
    const store = new R2ObjectStore({
      bucket: configuration.bucket,
      client: { send: async () => calls++ },
      maxObjectBytes: 4,
    })

    await expect(store.put({ key: '../secret', body: new Uint8Array([1]) })).rejects.toMatchObject({
      code: 'OBJECT_STORE_INVALID_INPUT',
    })
    await expect(store.put({ key: 'safe', body: new Uint8Array(5) })).rejects.toMatchObject({
      code: 'OBJECT_STORE_TOO_LARGE',
    })
    await expect(
      store.put({ key: 'safe', body: new Uint8Array([1]), metadata: { Authorization: 'secret' } })
    ).rejects.toMatchObject({ code: 'OBJECT_STORE_INVALID_INPUT' })
    expect(calls).toBe(0)
  })

  test('normalizes not-found and provider failures without retaining raw errors', async () => {
    const notFound = Object.assign(new Error('provider payload with credential-value'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    })
    const failed = new Error('provider payload with credential-value')
    const errors = [notFound, failed]
    const store = new R2ObjectStore({
      bucket: configuration.bucket,
      client: {
        send: async () => {
          throw errors.shift()
        },
      },
      maxObjectBytes: 1024,
    })

    await expect(store.get('missing')).rejects.toMatchObject({
      code: 'OBJECT_STORE_NOT_FOUND',
      retryable: false,
    })
    try {
      await store.delete('failed')
      throw new Error('Expected delete to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ObjectStoreError)
      expect(error).toMatchObject({ code: 'OBJECT_STORE_PROVIDER_FAILURE', retryable: true })
      expect(JSON.stringify(error)).not.toContain('credential-value')
    }
  })
})
