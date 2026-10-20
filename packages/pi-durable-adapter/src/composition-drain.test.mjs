import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodePiDurableRuntime } from './composition.ts'
import { fixture } from './adapter.fixture.mjs'

test('Node composition close fences new Pi tasks and drains an admitted run before journal teardown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-composition-task-drain-'))
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const setup = fixture(directory)
  const originalFactory = setup.options.engineFactory
  let runs = 0
  let composition
  try {
    composition = await createNodePiDurableRuntime({
      ...setup.options,
      engineFactory: async (...args) => {
        const engine = await originalFactory(...args)
        return {
          ...engine,
          run: async (...input) => {
            runs++
            entered.resolve()
            await release.promise
            return engine.run(...input)
          },
        }
      },
    })
    const handle = await composition.adapter.start(setup.request)
    await entered.promise
    const closing = composition.close()
    let closed = false
    void closing.then(() => {
      closed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    await expect(composition.adapter.start(setup.request)).rejects.toThrow('PI_ADAPTER_CLOSED')
    release.resolve()
    await closing
    expect(closed).toBe(true)
    composition = await createNodePiDurableRuntime(setup.options)
    expect((await composition.adapter.status(handle)).state).toBe('completed')
    expect(runs).toBe(1)
  } finally {
    release.resolve()
    await composition?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
