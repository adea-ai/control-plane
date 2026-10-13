import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from './provider.ts'
import {
  readPersistenceTransaction,
  withPersistenceReadScope,
} from '../../deployment/src/read-scope.ts'

// Imports the separate source delta directly: it does not resolve the previously
// built deployment/read-scope entry or modify the preserved package output.
test('actual SQLite allocation rolls back when the callback abandons a pending get', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-detached-read-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  let release, pending
  const gate = new Promise((resolve) => {
    release = resolve
  })
  try {
    await provider.migrate()
    const result = await provider
      .transaction(async (tx) => {
        await tx.put({ namespace: 'detached-read-proof', id: 'allocation', value: true })
        const delayed = {
          ...tx,
          get: async (...args) => {
            await gate
            return tx.get(...args)
          },
        }
        await withPersistenceReadScope(provider, delayed, async () => {
          await readPersistenceTransaction(provider, async (read) => {
            pending = read.get('detached-read-proof', 'allocation').catch((error) => error.message)
          })
        })
      })
      .then(
        () => 'unsafe-commit',
        (error) => error.message
      )
    release()
    expect(await pending).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
    expect(result).toBe('PERSISTENCE_READ_SCOPE_PENDING')
    expect(
      await readPersistenceTransaction(provider, (read) =>
        read.get('detached-read-proof', 'allocation')
      )
    ).toBeUndefined()
  } finally {
    release()
    if (pending) await pending
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('actual SQLite allocation rolls back a detached nested scope gated before any read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-detached-nested-scope-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  let release,
    nested,
    reads = 0
  const gate = new Promise((resolve) => {
    release = resolve
  })
  try {
    await provider.migrate()
    const result = await provider
      .transaction(async (tx) => {
        await tx.put({ namespace: 'detached-nested-proof', id: 'allocation', value: true })
        const tracked = {
          ...tx,
          get: async (...args) => {
            reads++
            return tx.get(...args)
          },
        }
        await withPersistenceReadScope(provider, tracked, async () => {
          nested = withPersistenceReadScope(provider, tracked, async () => {
            await gate
            return readPersistenceTransaction(provider, (read) =>
              read.get('detached-nested-proof', 'allocation')
            )
          }).catch((error) => error.message)
        })
      })
      .then(
        () => 'unsafe-commit',
        (error) => error.message
      )
    release()
    expect(await nested).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
    expect(result).toBe('PERSISTENCE_READ_SCOPE_PENDING')
    expect(reads).toBe(0)
    expect(
      await readPersistenceTransaction(provider, (read) =>
        read.get('detached-nested-proof', 'allocation')
      )
    ).toBeUndefined()
  } finally {
    release()
    if (nested) await nested
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
