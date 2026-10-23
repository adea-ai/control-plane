import { expect, test } from 'bun:test'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodePiDurableRuntime } from './composition.ts'
import { PiDurableVersion } from './contracts.ts'
import { fixture } from './adapter.fixture.mjs'
import { processAdapterFixture } from './adapter-process.fixture.mjs'

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
    const closing = composition.closeForSameVersionUpgrade()
    let closed = false
    void closing.then(() => {
      closed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    await expect(composition.adapter.start(setup.request)).rejects.toThrow('PI_ADAPTER_CLOSED')
    release.resolve()
    const manifest = await closing
    expect(closed).toBe(true)
    expect(manifest.version).toEqual(PiDurableVersion)
    expect(manifest.files.map((file) => file.path)).toContain('authority.sqlite')
    composition = await createNodePiDurableRuntime({
      ...setup.options,
      sameVersionManifest: manifest,
    })
    expect((await composition.adapter.status(handle)).state).toBe('completed')
    expect(runs).toBe(1)
  } finally {
    release.resolve()
    await composition?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test('same-version reopen validates the closed bytes and refuses version or store drift', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-composition-manifest-'))
  const setup = fixture(directory)
  let composition
  try {
    composition = await createNodePiDurableRuntime(setup.options)
    await composition.adapter.start(setup.request)
    await composition.adapter.drain()
    const manifest = await composition.closeForSameVersionUpgrade()
    await expect(
      createNodePiDurableRuntime({
        ...setup.options,
        sameVersionManifest: { ...manifest, version: { ...manifest.version, journal: 99 } },
      })
    ).rejects.toThrow()
    await expect(
      createNodePiDurableRuntime({
        ...setup.options,
        sameVersionManifest: {
          ...manifest,
          files: [{ ...manifest.files[0], path: '../other.sqlite' }],
        },
      })
    ).rejects.toThrow()
    await appendFile(join(directory, 'authority.sqlite'), Buffer.from('drift'))
    await expect(
      createNodePiDurableRuntime({
        ...setup.options,
        sameVersionManifest: manifest,
      })
    ).rejects.toThrow('PI_UPGRADE_STORE_MANIFEST_MISMATCH')
  } finally {
    await composition?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('local handoff manifest includes native Pi session bytes and detects their drift', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-native-manifest-'))
  const setup = processAdapterFixture(directory)
  let composition
  try {
    composition = await createNodePiDurableRuntime(setup.options)
    const handle = await composition.adapter.start(setup.request)
    await composition.adapter.drain()
    expect((await composition.adapter.status(handle)).state).toBe('completed')
    const manifest = await composition.closeForSameVersionUpgrade()
    const nativeFile = manifest.files.find((file) =>
      /^sessions\/[a-f0-9]{64}\.sqlite$/.test(file.path)
    )
    expect(nativeFile).toBeDefined()
    await appendFile(join(directory, nativeFile.path), Buffer.from('native drift'))
    await expect(
      createNodePiDurableRuntime({
        ...setup.options,
        sameVersionManifest: manifest,
      })
    ).rejects.toThrow('PI_UPGRADE_STORE_MANIFEST_MISMATCH')
  } finally {
    await composition?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('incompatible retained Pi journal version blocks recovery without starting an engine', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-composition-version-fence-'))
  const setup = fixture(directory)
  let composition
  try {
    composition = await createNodePiDurableRuntime({
      ...setup.options,
      engineFactory: async () => {
        throw new Error('stop before engine run')
      },
    })
    const handle = await composition.adapter.start(setup.request)
    await composition.adapter.drain()
    const retained = composition.adapter.journal.get(handle.handleId)
    expect(retained.state).toBe('unknown')
    composition.adapter.journal.database
      .prepare('UPDATE pi_admissions SET body = ? WHERE handle_id = ?')
      .run(
        JSON.stringify({
          ...retained,
          admission: {
            ...retained.admission,
            version: { ...retained.admission.version, journal: 99 },
          },
        }),
        handle.handleId
      )
    await composition.close()

    let engineCreations = 0
    composition = await createNodePiDurableRuntime({
      ...setup.options,
      engineFactory: async (input) => {
        engineCreations++
        return setup.options.engineFactory(input)
      },
    })
    expect(composition.recoveryBlocked).toEqual([
      { handleId: handle.handleId, code: 'PI_RECOVERY_AUTHORITY_BLOCKED' },
    ])
    expect(engineCreations).toBe(0)
    const after = composition.adapter.journal.get(handle.handleId)
    expect(after.state).toBe('unknown')
    expect(after.admission.version.journal).toBe(99)
  } finally {
    await composition?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
