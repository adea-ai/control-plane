import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQueuedRuntimeCommandRecord } from '@control-plane/domain'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
import { RuntimeCommandArtifactVerifier } from './runtime-artifact-verifier.js'

const directories = new Set()
const stores = new Set()

afterEach(async () => {
  for (const store of stores) store.close()
  stores.clear()
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true })
    directories.delete(directory)
  }
})

const bodyFor = (value) => new TextEncoder().encode(JSON.stringify(value))
async function createFixture({ maxArtifactBytes = 262144, hooks = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'm11-runtime-artifact-verifier-'))
  directories.add(directory)
  const storage = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 64 * 1024 * 1024,
  })
  stores.add(storage)
  const calls = { head: 0, get: 0 }
  const objectStore = {
    async head(key) {
      calls.head += 1
      const descriptor = await storage.head(key)
      return hooks.head?.(descriptor, key) ?? descriptor
    },
    async get(key) {
      calls.get += 1
      await hooks.beforeGet?.(key)
      const object = await storage.get(key)
      return hooks.get?.(object, key) ?? object
    },
    put: (input) => storage.put(input),
    putIfAbsent: (input) => storage.putIfAbsent(input),
    delete: (key) => storage.delete(key),
    close: () => storage.close(),
  }
  const command = createQueuedRuntimeCommandRecord(golden.command, '2026-08-25T12:00:00.000Z')
  const attemptId = command.attemptId
  const key = `runtime-results/${attemptId}/result.json`
  const body = bodyFor({ result: 'verified' })
  const stored = await storage.put({
    key,
    body,
    contentType: 'application/json',
    metadata: { attempt: attemptId },
  })
  const artifact = {
    artifactId: `art_${attemptId.slice(4)}`,
    digest: stored.sha256,
    mediaType: 'application/json',
    sizeBytes: stored.size,
  }
  return {
    artifact,
    body,
    calls,
    command,
    key,
    objectStore,
    storage,
    verifier: new RuntimeCommandArtifactVerifier(objectStore, { maxArtifactBytes }),
  }
}

describe('RuntimeCommandArtifactVerifier', () => {
  test('accepts the deterministic attempt-bound hosted artifact after HEAD and GET verification', async () => {
    const fixture = await createFixture()

    await fixture.verifier.verify({ command: fixture.command, artifact: fixture.artifact })

    expect(fixture.calls).toEqual({ head: 1, get: 1 })
  })

  test.each([
    ['missing object', async (fixture) => fixture.storage.delete(fixture.key)],
    [
      'wrong attempt metadata',
      async (fixture) =>
        fixture.storage.put({
          key: fixture.key,
          body: fixture.body,
          contentType: 'application/json',
          metadata: { attempt: `${fixture.command.attemptId.slice(0, -1)}H` },
        }),
    ],
    [
      'stored digest and bytes changed after reference creation',
      async (fixture) =>
        fixture.storage.put({
          key: fixture.key,
          body: bodyFor({ result: 'corrupt' }),
          contentType: 'application/json',
          metadata: { attempt: fixture.command.attemptId },
        }),
    ],
    [
      'wrong storage key',
      async (fixture) => {
        fixture.objectStore.head = async (key) => ({
          ...(await fixture.storage.head(key)),
          key: 'other/key',
        })
      },
    ],
    [
      'wrong attempt-derived artifact ID',
      async (fixture) => {
        fixture.artifact.artifactId = `art_${fixture.command.attemptId.slice(4, -1)}H`
      },
    ],
    ['media type mismatch', async (fixture) => (fixture.artifact.mediaType = 'text/plain')],
    ['reference size mismatch', async (fixture) => (fixture.artifact.sizeBytes += 1)],
    [
      'HEAD and GET metadata mismatch',
      async (fixture) => {
        fixture.objectStore.get = async (key) => ({
          ...(await fixture.storage.get(key)),
          metadata: { attempt: fixture.command.attemptId, source: 'changed' },
        })
      },
    ],
    [
      'object changes between HEAD and GET',
      async (fixture) => {
        fixture.objectStore.get = async (key) => {
          await fixture.storage.put({
            key,
            body: bodyFor({ result: 'replaced' }),
            contentType: 'application/json',
            metadata: { attempt: fixture.command.attemptId },
          })
          return fixture.storage.get(key)
        }
      },
    ],
  ])('rejects %s with a sanitized failure', async (_case, mutate) => {
    const fixture = await createFixture()
    await mutate(fixture)

    await expect(
      fixture.verifier.verify({ command: fixture.command, artifact: fixture.artifact })
    ).rejects.toThrow('RUNTIME_ARTIFACT_VERIFICATION_FAILED')
  })

  test('rejects a reference above the configured bound before GET', async () => {
    const fixture = await createFixture()
    fixture.artifact.sizeBytes = 262145

    await expect(
      fixture.verifier.verify({ command: fixture.command, artifact: fixture.artifact })
    ).rejects.toThrow('RUNTIME_ARTIFACT_VERIFICATION_FAILED')
    expect(fixture.calls).toEqual({ head: 0, get: 0 })
  })

  test.each([
    [
      'malformed command',
      (fixture) => ({
        command: { ...fixture.command, attemptId: 'invalid-attempt' },
        artifact: fixture.artifact,
      }),
    ],
    [
      'malformed reference',
      (fixture) => ({
        command: fixture.command,
        artifact: { ...fixture.artifact, sizeBytes: -1 },
      }),
    ],
  ])('rejects a %s before storage access', async (_label, inputFor) => {
    const fixture = await createFixture()

    await expect(fixture.verifier.verify(inputFor(fixture))).rejects.toThrow(
      'RUNTIME_ARTIFACT_VERIFICATION_FAILED'
    )
    expect(fixture.calls).toEqual({ head: 0, get: 0 })
  })

  test('rejects invalid configured byte limits before storage calls', async () => {
    const fixture = await createFixture()
    for (const maxArtifactBytes of [0, -1, 64 * 1024 * 1024 + 1, Number.NaN]) {
      expect(
        () => new RuntimeCommandArtifactVerifier(fixture.objectStore, { maxArtifactBytes })
      ).toThrow('RUNTIME_ARTIFACT_LIMIT_INVALID')
    }
    expect(fixture.calls).toEqual({ head: 0, get: 0 })
  })

  test('sanitizes object-store failures instead of exposing provider detail', async () => {
    const fixture = await createFixture({
      hooks: {
        head: () => {
          throw new Error('provider-secret-and-path')
        },
      },
    })

    await expect(
      fixture.verifier.verify({ command: fixture.command, artifact: fixture.artifact })
    ).rejects.toThrow('RUNTIME_ARTIFACT_VERIFICATION_FAILED')
    try {
      await fixture.verifier.verify({ command: fixture.command, artifact: fixture.artifact })
    } catch (error) {
      expect(error.message).not.toContain('provider-secret-and-path')
    }
  })
})
