import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteEncryptedSecretStore } from './credential-secret-store.ts'
import { SqlitePersistenceProvider } from './provider.ts'

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'credential-secret-store-'))
  const path = join(directory, 'state.sqlite')
  const open = async () => {
    const persistence = new SqlitePersistenceProvider({ path })
    await persistence.migrate()
    return persistence
  }
  try {
    await run({ open, path })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const record = (overrides = {}) => ({
  locator: 'local://credential-secrets/credential-test-1',
  version: '1',
  ciphertext: 'Y2lwaGVydGV4dC1vbmx5',
  iv: 'aXYtMTItYnl0ZXM',
  authTag: 'YXV0aC10YWc',
  keyReference: 'control-plane-local-secret-key',
  encryptionVersion: 'aad-v1',
  ...overrides,
})

test('stores ciphertext records durably and returns exactly the stored fields', async () => {
  await withStore(async ({ open }) => {
    const first = await open()
    const store = new SqliteEncryptedSecretStore(first)
    await store.put(record())
    expect(await store.get({ locator: record().locator, version: '1' })).toEqual({
      ciphertext: 'Y2lwaGVydGV4dC1vbmx5',
      iv: 'aXYtMTItYnl0ZXM',
      authTag: 'YXV0aC10YWc',
      keyReference: 'control-plane-local-secret-key',
      encryptionVersion: 'aad-v1',
    })
    first.close({ checkpoint: true })

    // Durable across a reopen of the same database file.
    const reopened = await open()
    try {
      expect(
        await new SqliteEncryptedSecretStore(reopened).get({
          locator: record().locator,
          version: '1',
        })
      ).toMatchObject({ ciphertext: 'Y2lwaGVydGV4dC1vbmx5' })
    } finally {
      reopened.close({ checkpoint: true })
    }
  })
})

test('put is create-only: a second write for the same locator and version keeps the first record', async () => {
  await withStore(async ({ open }) => {
    const persistence = await open()
    try {
      const store = new SqliteEncryptedSecretStore(persistence)
      await store.put(record())
      await store.put(record({ ciphertext: 'c2Vjb25kLXdyaXRl' }))
      expect((await store.get({ locator: record().locator, version: '1' })).ciphertext).toBe(
        'Y2lwaGVydGV4dC1vbmx5'
      )
    } finally {
      persistence.close()
    }
  })
})

test('versions are independent and delete removes only the named revision', async () => {
  await withStore(async ({ open }) => {
    const persistence = await open()
    try {
      const store = new SqliteEncryptedSecretStore(persistence)
      await store.put(record({ version: '1' }))
      await store.put(record({ version: '2', ciphertext: 'c2Vjb25kLXZlcnNpb24' }))
      await store.delete({ locator: record().locator, version: '1' })
      expect(await store.get({ locator: record().locator, version: '1' })).toBeUndefined()
      expect((await store.get({ locator: record().locator, version: '2' })).ciphertext).toBe(
        'c2Vjb25kLXZlcnNpb24'
      )
    } finally {
      persistence.close()
    }
  })
})
