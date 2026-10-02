import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { ObjectStoreJsonToolExecutor } from './object-store-tool.ts'

const request = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  operation: 'store-json',
  input: { message: 'durable tool effect', count: 1 },
}
const version = {
  executor: { type: 'internal', reference: 'local.object-store-json.v1' },
}

test('Local object-store tool writes immutable JSON and verifies cold replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-object-tool-'))
  let store = new FilesystemObjectStore({ rootDirectory: directory, maxObjectBytes: 4096 })
  try {
    const executor = new ObjectStoreJsonToolExecutor(store)
    const first = await executor.execute(request, version, new AbortController().signal)
    expect(first.output).toMatchObject({
      size: Buffer.byteLength(JSON.stringify(request.input)),
      contentDigest: expect.stringMatching(/^sha256:/),
    })
    store.close()
    store = new FilesystemObjectStore({ rootDirectory: directory, maxObjectBytes: 4096 })
    const cold = new ObjectStoreJsonToolExecutor(store)
    expect(await cold.execute(request, version, new AbortController().signal)).toEqual(first)
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
  const executor = new ObjectStoreJsonToolExecutor({
    putIfAbsent: async () => {
      writes++
      throw Error('unexpected write')
    },
  })
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

for (const binding of ['workspace', 'execution'])
  test(`created object receipts must confirm their ${binding} binding`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm11-object-receipt-'))
    const store = new FilesystemObjectStore({ rootDirectory: directory, maxObjectBytes: 4096 })
    try {
      const executor = new ObjectStoreJsonToolExecutor({
        putIfAbsent: async (input) => {
          const result = await store.putIfAbsent(input)
          return {
            ...result,
            object: {
              ...result.object,
              metadata: { ...result.object.metadata, [binding]: 'wrong-binding' },
            },
          }
        },
      })
      await expect(
        executor.execute(request, version, new AbortController().signal)
      ).rejects.toMatchObject({ code: 'OBJECT_EFFECT_INVALID', effectState: 'committed' })
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
