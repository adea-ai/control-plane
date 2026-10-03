import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { ObjectStoreJsonToolExecutor } from './object-store-tool.ts'

const request = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  idempotencyKey: 'object-store-tool-test-0001',
  operation: 'store-json',
  input: { message: 'durable tool effect', count: 1 },
}
const artifactScope = {
  workspaceId: request.workspaceId,
  projectId: 'prj_01JABCDEF0123456789ABCDEFG',
}
const version = {
  executor: { type: 'internal', reference: 'local.object-store-json.v1' },
}

test('Local object-store tool writes immutable JSON and verifies cold replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-object-tool-'))
  let store = new FilesystemObjectStore({ rootDirectory: directory, maxObjectBytes: 4096 })
  try {
    const executor = new ObjectStoreJsonToolExecutor(store, artifactScope)
    const first = await executor.execute(request, version, new AbortController().signal)
    const artifactRef = first.output.artifactRef
    const contentDigest = first.output.contentDigest
    const size = first.output.size
    expect(artifactRef).toMatch(/^art_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(size).toBe(Buffer.byteLength(JSON.stringify(request.input)))
    expect(contentDigest).toMatch(/^sha256:/)
    const artifact = await store.get(artifactRef)
    expect(artifact.metadata).toMatchObject({
      'workspace-id': request.workspaceId,
      'project-id': artifactScope.projectId,
      'execution-id': request.executionId,
      sensitivity: 'internal',
    })
    store.close()
    store = new FilesystemObjectStore({ rootDirectory: directory, maxObjectBytes: 4096 })
    const cold = new ObjectStoreJsonToolExecutor(store, artifactScope)
    expect(await cold.execute(request, version, new AbortController().signal)).toEqual(first)
    expect((await store.get(artifactRef)).sha256).toBe(contentDigest)
    await expect(
      cold.execute(
        { ...request, input: { replacement: true } },
        version,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'OBJECT_EFFECT_CONFLICT', effectState: 'committed' })
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Local object-store tool rejects cancellation and wrong binding before writing', async () => {
  let writes = 0
  const executor = new ObjectStoreJsonToolExecutor(
    {
      putIfAbsent: async () => {
        writes++
        throw Error('unexpected write')
      },
    },
    artifactScope
  )
  await expect(executor.execute(request, version, AbortSignal.abort())).rejects.toMatchObject({
    effectState: 'none',
  })
  await expect(
    executor.execute(
      request,
      { executor: { type: 'mcp', reference: 'other' } },
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'TOOL_BINDING_MISMATCH', effectState: 'none' })
  expect(writes).toBe(0)
})

for (const scenario of [
  { phase: 'new receipt', marker: 'revoked', expected: 'OBJECT_EFFECT_INVALID' },
  { phase: 'cold replay', marker: 'quarantined', expected: 'OBJECT_EFFECT_CONFLICT' },
  { phase: 'cold replay', marker: 'unknown-state', expected: 'OBJECT_EFFECT_CONFLICT' },
])
  test(`Local JSON artifact rejects ${scenario.marker} lifecycle metadata on ${scenario.phase}`, async () => {
    let descriptor
    const objectStore = {
      putIfAbsent: async (input) => {
        const body = new TextEncoder().encode(canonicalJsonStringify(request.input))
        descriptor = {
          key: input.key,
          size: body.byteLength,
          contentType: input.contentType,
          sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
          metadata: { ...input.metadata, 'artifact-state': scenario.marker },
        }
        return scenario.phase === 'new receipt'
          ? { outcome: 'created', object: descriptor }
          : { outcome: 'exists' }
      },
      get: async () => ({ ...descriptor, body: new Uint8Array() }),
    }
    const executor = new ObjectStoreJsonToolExecutor(objectStore, artifactScope)
    await expect(
      executor.execute(request, version, new AbortController().signal)
    ).rejects.toMatchObject({ code: scenario.expected, effectState: 'committed' })
  })

for (const binding of ['workspace', 'execution', 'project'])
  test(`created object receipts must confirm their ${binding} binding`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm11-object-receipt-'))
    const store = new FilesystemObjectStore({ rootDirectory: directory, maxObjectBytes: 4096 })
    try {
      const executor = new ObjectStoreJsonToolExecutor(
        {
          putIfAbsent: async (input) => {
            const result = await store.putIfAbsent(input)
            return {
              ...result,
              object: {
                ...result.object,
                metadata: {
                  ...result.object.metadata,
                  [binding === 'workspace'
                    ? 'workspace'
                    : binding === 'execution'
                      ? 'execution'
                      : 'project-id']: 'wrong-binding',
                },
              },
            }
          },
        },
        artifactScope
      )
      await expect(
        executor.execute(request, version, new AbortController().signal)
      ).rejects.toMatchObject({ code: 'OBJECT_EFFECT_INVALID', effectState: 'committed' })
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
