import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, test } from 'bun:test'
import { FilesystemObjectStore, ObjectStoreError, R2ObjectStore } from '@control-plane/object-store'
import { ObjectStoreHostedArtifactStore } from './hosted-managed-pi-artifact-stores.js'

const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const input = { attemptId, mediaType: 'application/json', value: { ok: true } }
const key = `runtime-results/${attemptId}/result.json`
const body = new TextEncoder().encode('{"ok":true}')
const descriptor = {
  key,
  size: body.byteLength,
  sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
  contentType: 'application/json',
  metadata: { attempt: attemptId },
}

function store({ existing = false, head = {}, get = {}, put = {}, missingGet = false } = {}) {
  let present = existing
  const calls = []
  return {
    calls,
    remove() {
      present = false
    },
    async head(requested) {
      calls.push(['head', requested])
      if (!present) throw new ObjectStoreError('OBJECT_STORE_NOT_FOUND', false)
      return { ...descriptor, ...head }
    },
    async get(requested) {
      calls.push(['get', requested])
      if (!present || missingGet) throw new ObjectStoreError('OBJECT_STORE_NOT_FOUND', false)
      return { ...descriptor, body: body.slice(), ...get }
    },
    async put(request) {
      calls.push(['put', request.key])
      present = true
      return { ...descriptor, ...put }
    },
    async putIfAbsent(request) {
      if (present) return { outcome: 'exists' }
      return { outcome: 'created', object: await this.put(request) }
    },
    async delete() {},
    close() {},
  }
}

test('refuses an artifact store without atomic conditional creation before any storage operation', () => {
  const objects = store({ existing: true })
  delete objects.putIfAbsent
  expect(() => new ObjectStoreHostedArtifactStore(objects)).toThrow(
    'HOSTED_ARTIFACT_CONDITIONAL_CREATE_REQUIRED'
  )
  expect(objects.calls).toEqual([])
})

test.each([false, true])(
  'independent writers observing a missing key fence concurrent results (identical=%s)',
  async (identical) => {
    let stored
    let initialHeads = 0
    let release
    const barrier = new Promise((resolve) => {
      release = resolve
    })
    const writes = []
    const client = {
      async send(command) {
        if (command.constructor.name === 'HeadObjectCommand' && initialHeads < 2) {
          initialHeads++
          if (initialHeads === 2) release()
          await barrier
          throw Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } })
        }
        if (command.constructor.name === 'PutObjectCommand') {
          writes.push(command.input)
          if (stored && command.input.IfNoneMatch === '*') {
            throw Object.assign(new Error('exists'), { $metadata: { httpStatusCode: 412 } })
          }
          stored = {
            body: command.input.Body.slice(),
            contentType: command.input.ContentType,
            metadata: command.input.Metadata,
          }
          return {}
        }
        if (!stored)
          throw Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } })
        return {
          ContentLength: stored.body.byteLength,
          ContentType: stored.contentType,
          Metadata: stored.metadata,
          Body: Readable.from([stored.body.slice()]),
        }
      },
    }
    const create = () =>
      new ObjectStoreHostedArtifactStore(
        new R2ObjectStore({ bucket: 'artifacts', client, maxObjectBytes: 1024 })
      )
    const results = await Promise.allSettled([
      create().persist(input),
      create().persist({ ...input, value: identical ? input.value : { ok: false } }),
    ])
    const successes = results.filter((result) => result.status === 'fulfilled')
    expect(successes).toHaveLength(identical ? 2 : 1)
    if (identical) expect(successes[0].value).toEqual(successes[1].value)
    else
      expect(results.find((result) => result.status === 'rejected').reason.message).toBe(
        'HOSTED_ARTIFACT_RESULT_CONFLICT'
      )
    expect(writes.every((request) => request.IfNoneMatch === '*')).toBe(true)
    const reference = await create().persist(input)
    expect(reference).toEqual(successes[0].value)
  }
)

test.each([
  ['wrong head key', { existing: true, head: { key: 'another-workspace/result.json' } }],
  ['wrong head attempt', { existing: true, head: { metadata: { attempt: 'another-attempt' } } }],
  ['wrong GET key', { existing: true, get: { key: 'another-workspace/result.json' } }],
  ['wrong GET attempt', { existing: true, get: { metadata: {} } }],
  ['wrong GET size', { existing: true, get: { size: body.byteLength + 1 } }],
  ['wrong GET digest', { existing: true, get: { sha256: `sha256:${'a'.repeat(64)}` } }],
  ['wrong GET media type', { existing: true, get: { contentType: 'text/plain' } }],
  ['corrupt bytes', { existing: true, get: { body: new Uint8Array(body.byteLength) } }],
  ['unreadable PUT', { missingGet: true }],
  ['wrong PUT key', { put: { key: 'another-workspace/result.json' } }],
  ['wrong PUT content type', { put: { contentType: 'text/plain' } }],
  ['wrong PUT attempt', { put: { metadata: {} } }],
])('refuses a terminal artifact with %s', async (_name, options) => {
  await expect(new ObjectStoreHostedArtifactStore(store(options)).persist(input)).rejects.toThrow()
})

test('verifies readable bytes on initial PUT and on every warm and cold replay', async () => {
  const objects = store()
  const artifacts = new ObjectStoreHostedArtifactStore(objects)
  const first = await artifacts.persist(input)
  expect(objects.calls.filter(([method]) => method === 'get')).toHaveLength(1)
  expect(await artifacts.persist(input)).toEqual(first)
  expect(await new ObjectStoreHostedArtifactStore(objects).persist(input)).toEqual(first)
  expect(objects.calls.filter(([method]) => method === 'get')).toHaveLength(3)
  expect(objects.calls.filter(([method]) => method === 'put')).toHaveLength(1)
})

test('a warm replay repairs missing bytes instead of returning a cached success', async () => {
  const objects = store()
  const artifacts = new ObjectStoreHostedArtifactStore(objects)
  const first = await artifacts.persist(input)
  objects.remove()
  expect(await artifacts.persist(input)).toEqual(first)
  expect(objects.calls.filter(([method]) => method === 'put')).toHaveLength(2)
})

test('rejects oversized results before opening any ObjectStore operation', async () => {
  const objects = store()
  const artifacts = new ObjectStoreHostedArtifactStore(objects, { maxResultBytes: 4 })
  await expect(artifacts.persist(input)).rejects.toThrow('HOSTED_ARTIFACT_TOO_LARGE')
  expect(objects.calls).toEqual([])
})

test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
  'rejects invalid artifact byte limit %s',
  (maxResultBytes) => {
    expect(() => new ObjectStoreHostedArtifactStore(store(), { maxResultBytes })).toThrow(
      'HOSTED_ARTIFACT_LIMIT_INVALID'
    )
  }
)

test('coalesces concurrent identical writes but fences conflicting in-flight results', async () => {
  const objects = store()
  const artifacts = new ObjectStoreHostedArtifactStore(objects)
  const first = artifacts.persist(input)
  const same = artifacts.persist(input)
  await expect(artifacts.persist({ ...input, value: { ok: false } })).rejects.toThrow(
    'HOSTED_ARTIFACT_RESULT_CONFLICT'
  )
  expect(await same).toEqual(await first)
  expect(objects.calls.filter(([method]) => method === 'put')).toHaveLength(1)
})

test('recovers a lost PUT acknowledgement by verifying existing bytes without rewriting', async () => {
  const objects = store()
  const put = objects.put.bind(objects)
  objects.put = async (request) => {
    await put(request)
    throw new ObjectStoreError('OBJECT_STORE_PROVIDER_FAILURE', true)
  }
  const artifacts = new ObjectStoreHostedArtifactStore(objects)
  await expect(artifacts.persist(input)).rejects.toThrow()
  expect(await artifacts.persist(input)).toMatchObject({ digest: descriptor.sha256 })
  expect(objects.calls.filter(([method]) => method === 'put')).toHaveLength(1)
  expect(objects.calls.filter(([method]) => method === 'get')).toHaveLength(1)
})

test.each([
  ['misbound winner key', { head: { key: 'other/result.json' } }],
  ['misbound winner attempt', { head: { metadata: { attempt: 'another-attempt' } } }],
  ['corrupt winner bytes', { get: { body: new Uint8Array(body.byteLength) } }],
  ['unreadable winner', { missingGet: true }],
])('an existing-object response cannot publish %s', async (_name, options) => {
  const objects = store(options)
  objects.putIfAbsent = async (request) => {
    await objects.put(request)
    return { outcome: 'exists' }
  }
  await expect(new ObjectStoreHostedArtifactStore(objects).persist(input)).rejects.toThrow()
})

test('does not fall back to ordinary PUT when conditional creation is unavailable at the provider', async () => {
  const objects = store()
  objects.putIfAbsent = async () => {
    throw new ObjectStoreError('OBJECT_STORE_PROVIDER_FAILURE', false)
  }
  await expect(new ObjectStoreHostedArtifactStore(objects).persist(input)).rejects.toMatchObject({
    code: 'OBJECT_STORE_PROVIDER_FAILURE',
  })
  expect(objects.calls.filter(([method]) => method === 'put')).toHaveLength(0)
})

test.each([false, true])(
  'actual filesystem artifact writers fence simultaneous missing-key observations (identical=%s)',
  async (identical) => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'm11-conditional-hosted-artifact-'))
    const objects = [0, 1].map(
      () => new FilesystemObjectStore({ rootDirectory, maxObjectBytes: 1024 })
    )
    let heads = 0
    let release
    const barrier = new Promise((resolve) => {
      release = resolve
    })
    for (const object of objects) {
      const head = object.head.bind(object)
      let first = true
      object.head = async (requested) => {
        if (!first) return head(requested)
        first = false
        let observedError
        try {
          await head(requested)
        } catch (error) {
          observedError = error
        }
        expect(observedError).toMatchObject({ code: 'OBJECT_STORE_NOT_FOUND' })
        heads++
        if (heads === 2) release()
        await barrier
        throw observedError
      }
    }
    try {
      const requests = [input, { ...input, value: identical ? input.value : { ok: false } }]
      const results = await Promise.allSettled(
        objects.map((object, index) =>
          new ObjectStoreHostedArtifactStore(object).persist(requests[index])
        )
      )
      const successes = results.filter((result) => result.status === 'fulfilled')
      expect(successes).toHaveLength(identical ? 2 : 1)
      if (identical) expect(successes[0].value).toEqual(successes[1].value)
      else
        expect(results.find((result) => result.status === 'rejected').reason.message).toBe(
          'HOSTED_ARTIFACT_RESULT_CONFLICT'
        )
      const winner = results.findIndex((result) => result.status === 'fulfilled')
      const reopened = new FilesystemObjectStore({ rootDirectory, maxObjectBytes: 1024 })
      try {
        expect(
          await new ObjectStoreHostedArtifactStore(reopened).persist(requests[winner])
        ).toEqual(results[winner].value)
      } finally {
        reopened.close()
      }
    } finally {
      for (const object of objects) object.close()
      await rm(rootDirectory, { recursive: true, force: true })
    }
  }
)
