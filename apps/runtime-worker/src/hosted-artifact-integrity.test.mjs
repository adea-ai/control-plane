import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { ObjectStoreError } from '@control-plane/object-store'
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
    async delete() {},
    close() {},
  }
}

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
