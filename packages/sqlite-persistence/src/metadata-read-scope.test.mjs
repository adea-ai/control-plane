import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersistentModelSelectionRepository } from '../../model-gateway/src/selection-repository.ts'
import {
  readPersistenceTransaction,
  withPersistenceReadScope,
  writePersistenceTransaction,
} from '@control-plane/deployment/read-scope'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteCredentialVaultRepository } from './credential-vault-repository.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const credentialId = 'crd_01JABCDEF0123456789ABCDEFG'
function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-read-scope-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    await run(provider)
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('actual model and vault metadata read the open allocation transaction without re-entry', async () => {
  await fixture(async (provider) => {
    let transactions = 0
    const original = provider.transaction.bind(provider)
    provider.transaction = (operation) => {
      transactions++
      return original(operation)
    }
    const models = new PersistentModelSelectionRepository(provider)
    const vault = new SqliteCredentialVaultRepository(provider)
    await provider.transaction(async (tx) => {
      await tx.put({ namespace: 'scope-proof', id: 'value', value: { uncommitted: true } })
      await withPersistenceReadScope(provider, tx, async () => {
        const [defaults, credential, value] = await Promise.all([
          models.getDefaults(workspaceId),
          vault.getCredential(credentialId),
          readPersistenceTransaction(provider, (read) => read.get('scope-proof', 'value')),
        ])
        expect(defaults).toBeUndefined()
        expect(credential).toBeUndefined()
        expect(value.value).toEqual({ uncommitted: true })
        expect(transactions).toBe(1)
      })
    })
  })
})

test('unrelated async callers still serialize behind the allocation transaction', async () => {
  await fixture(async (provider) => {
    const started = deferred(),
      release = deferred()
    const root = provider.transaction((tx) =>
      withPersistenceReadScope(provider, tx, async () => {
        await tx.put({ namespace: 'scope-proof', id: 'value', value: { committed: true } })
        started.resolve()
        await release.promise
      })
    )
    await started.promise
    let outsideEntered = false
    const outside = readPersistenceTransaction(provider, async (read) => {
      outsideEntered = true
      return read.get('scope-proof', 'value')
    })
    await Promise.resolve()
    expect(outsideEntered).toBe(false)
    release.resolve()
    await root
    expect((await outside).value).toEqual({ committed: true })
  })
})

test('metadata write attempted within the read fence refuses and rolls back the allocation', async () => {
  await fixture(async (provider) => {
    await expect(
      provider.transaction(async (tx) => {
        await tx.put({ namespace: 'scope-proof', id: 'value', value: true })
        await withPersistenceReadScope(provider, tx, async () => {
          await writePersistenceTransaction(provider, (write) =>
            write.put({ namespace: 'scope-proof', id: 'forbidden', value: true })
          )
        })
      })
    ).rejects.toThrow('PERSISTENCE_READ_SCOPE_WRITE_DENIED')
    expect(
      await readPersistenceTransaction(provider, (tx) => tx.get('scope-proof', 'value'))
    ).toBeUndefined()
  })
})

test('captured reader and detached async context cannot read after the fence closes', async () => {
  await fixture(async (provider) => {
    let captured, detached
    await provider.transaction((tx) =>
      withPersistenceReadScope(provider, tx, async () => {
        await readPersistenceTransaction(provider, async (read) => {
          captured = read
          expect('put' in read).toBe(false)
        })
        detached = new Promise((resolve) =>
          setTimeout(() => {
            void readPersistenceTransaction(provider, (read) =>
              read.get('scope-proof', 'value')
            ).then(
              () => resolve('unsafe'),
              (error) => resolve(error.message)
            )
          }, 1)
        )
      })
    )
    await expect(captured.get('scope-proof', 'value')).rejects.toThrow(
      'PERSISTENCE_READ_SCOPE_CLOSED'
    )
    expect(await detached).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
  })
})

test('a different provider retains its independent transaction and read scope', async () => {
  await fixture(async (first) =>
    fixture(async (second) => {
      await second.transaction((tx) =>
        tx.put({ namespace: 'scope-proof', id: 'value', value: { other: true } })
      )
      await first.transaction((tx) =>
        withPersistenceReadScope(first, tx, async () => {
          expect(
            (await readPersistenceTransaction(second, (read) => read.get('scope-proof', 'value')))
              .value
          ).toEqual({ other: true })
        })
      )
    })
  )
})

test('unawaited metadata reads prevent the enclosing allocation from committing', async () => {
  await fixture(async (provider) => {
    const release = deferred()
    let pending
    await expect(
      provider.transaction(async (tx) => {
        await tx.put({ namespace: 'scope-proof', id: 'value', value: true })
        await withPersistenceReadScope(provider, tx, async () => {
          pending = readPersistenceTransaction(provider, async (read) => {
            await release.promise
            return read.get('scope-proof', 'value')
          }).catch((error) => error.message)
        })
      })
    ).rejects.toThrow('PERSISTENCE_READ_SCOPE_PENDING')
    release.resolve()
    expect(await pending).toBe('PERSISTENCE_READ_SCOPE_CLOSED')
    expect(
      await readPersistenceTransaction(provider, (tx) => tx.get('scope-proof', 'value'))
    ).toBeUndefined()
  })
})
