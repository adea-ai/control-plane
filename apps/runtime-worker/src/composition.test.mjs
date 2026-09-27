import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { composeContextNode } from './composition.ts'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const nodeId = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const transport = {
  send: async () => {},
  nextSequence: async () => 1,
  assertCurrent: async () => {},
}

test('failed context-node migration closes its already-opened owned SQLite handle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-node-startup-cleanup-'))
  const originalMigrate = SqlitePersistenceProvider.prototype.migrate
  const originalClose = SqlitePersistenceProvider.prototype.close
  let provider
  let closed = 0
  const migrate = spyOn(SqlitePersistenceProvider.prototype, 'migrate').mockImplementation(
    async function () {
      provider = this
      await originalMigrate.call(this)
      throw new Error('NODE_MIGRATION_FAILED')
    }
  )
  const close = spyOn(SqlitePersistenceProvider.prototype, 'close').mockImplementation(function (
    ...args
  ) {
    closed++
    return originalClose.apply(this, args)
  })
  try {
    await expect(
      composeContextNode({
        store: { backend: 'sqlite', path: join(directory, 'node.db') },
        workspaceId,
        nodeId,
        timeoutMs: 1000,
        driver: {},
        transport,
      })
    ).rejects.toThrow('NODE_MIGRATION_FAILED')
    expect(provider).toBeDefined()
    expect(closed).toBe(1)
    await expect(provider.health()).rejects.toMatchObject({ code: 'SQLITE_CLOSED' })
  } finally {
    migrate.mockRestore()
    close.mockRestore()
    provider?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed channel setup closes the migrated store, while successful composition transfers ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-node-ownership-'))
  const originalMigrate = SqlitePersistenceProvider.prototype.migrate
  const originalClose = SqlitePersistenceProvider.prototype.close
  const providers = []
  let closed = 0
  let node
  const migrate = spyOn(SqlitePersistenceProvider.prototype, 'migrate').mockImplementation(
    async function () {
      providers.push(this)
      await originalMigrate.call(this)
    }
  )
  const close = spyOn(SqlitePersistenceProvider.prototype, 'close').mockImplementation(function (
    ...args
  ) {
    closed++
    return originalClose.apply(this, args)
  })
  const options = {
    store: { backend: 'sqlite', path: join(directory, 'node.db') },
    workspaceId,
    nodeId,
    timeoutMs: 1000,
    driver: {},
    transport,
  }
  let sends = 0
  try {
    await expect(
      composeContextNode({
        ...options,
        transport: {
          ...transport,
          get send() {
            if (++sends === 2) throw new Error('NODE_CHANNEL_SETUP_FAILED')
            return transport.send
          },
        },
      })
    ).rejects.toThrow('NODE_CHANNEL_SETUP_FAILED')
    expect(closed).toBe(1)
    await expect(providers[0].health()).rejects.toMatchObject({ code: 'SQLITE_CLOSED' })

    node = await composeContextNode(options)
    expect(closed).toBe(1)
    expect((await providers[1].health()).ready).toBe(true)
    await node.close()
    expect(closed).toBe(2)
    await expect(providers[1].health()).rejects.toMatchObject({ code: 'SQLITE_CLOSED' })
  } finally {
    migrate.mockRestore()
    close.mockRestore()
    await node?.close()
    for (const provider of providers) provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed startup preserves both the startup error and a cleanup failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-node-cleanup-error-'))
  const originalMigrate = SqlitePersistenceProvider.prototype.migrate
  const originalClose = SqlitePersistenceProvider.prototype.close
  const startupError = new Error('NODE_MIGRATION_FAILED')
  const cleanupError = new Error('NODE_STORE_CLOSE_FAILED')
  let provider
  const migrate = spyOn(SqlitePersistenceProvider.prototype, 'migrate').mockImplementation(
    async function () {
      provider = this
      await originalMigrate.call(this)
      throw startupError
    }
  )
  const close = spyOn(SqlitePersistenceProvider.prototype, 'close').mockImplementation(function () {
    originalClose.call(this)
    throw cleanupError
  })
  try {
    let failure
    try {
      await composeContextNode({
        store: { backend: 'sqlite', path: join(directory, 'node.db') },
        workspaceId,
        nodeId,
        timeoutMs: 1000,
        driver: {},
        transport,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.message).toBe('CONTEXT_NODE_STARTUP_CLEANUP_FAILED')
    expect(failure.errors).toEqual([startupError, cleanupError])
    expect(failure.cause).toBe(cleanupError)
    await expect(provider.health()).rejects.toMatchObject({ code: 'SQLITE_CLOSED' })
  } finally {
    migrate.mockRestore()
    close.mockRestore()
    provider?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
