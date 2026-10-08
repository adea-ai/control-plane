import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault, InMemorySecretProvider } from '@control-plane/credential-vault'
import { assertCredentialVaultRepositoryConformance } from '@control-plane/credential-vault/conformance'
import { SqliteCredentialVaultRepository } from './credential-vault-repository.ts'
import { SqlitePersistenceProvider } from './provider.ts'

const canary = 'sqlite-credential-vault-SECRET-canary-51ad'

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'credential-vault-sqlite-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('SQLite credential repository satisfies the vault conformance sequence', async () => {
  await withDirectory(async (directory) => {
    const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
    try {
      await persistence.migrate()
      await assertCredentialVaultRepositoryConformance(
        new SqliteCredentialVaultRepository(persistence),
        { secretCanary: canary }
      )
    } finally {
      // A full directory byte scan needs the explicit stable cold-checkpoint contract.
      persistence.close({ checkpoint: true })
    }
    const files = await readdir(directory)
    expect(files).toEqual(['state.sqlite'])
    // Statement finalization may occur between directory enumeration and byte reads.
    Bun.gc(true)
    for (const file of files) {
      const bytes = await readFile(join(directory, file))
      expect(bytes.includes(Buffer.from(canary))).toBe(false)
    }
  })
})

test('SQLite credential metadata, leases and audit survive a restart', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'state.sqlite')
    const provider = new InMemorySecretProvider()
    const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
    const credentialId = 'crd_01JABCDEF0123456789ABCDEFG'
    const open = async () => {
      const persistence = new SqlitePersistenceProvider({ path })
      await persistence.migrate()
      return {
        persistence,
        vault: new CredentialVault({
          provider,
          repository: new SqliteCredentialVaultRepository(persistence),
          now: () => '2026-10-06T09:00:00.000Z',
        }),
      }
    }
    const first = await open()
    await first.vault.create({
      credentialId,
      workspaceId,
      connectorRef: 'connector:github',
      provider: 'github',
      secret: canary,
      createdAt: '2026-10-06T09:00:00.000Z',
      createdBy: 'svc_agent-hq',
    })
    await first.persistence.close()
    const second = await open()
    try {
      expect(await second.vault.metadata(credentialId, workspaceId)).toMatchObject({
        status: 'active',
        revision: 1,
        createdBy: 'svc_agent-hq',
      })
      expect(
        (await second.vault.findByConnector(workspaceId, 'connector:github'))?.credentialId
      ).toBe(credentialId)
      expect((await second.vault.audit({ workspaceId })).map(({ action }) => action)).toEqual([
        'credential.created',
      ])
    } finally {
      await second.persistence.close()
    }
  })
})
