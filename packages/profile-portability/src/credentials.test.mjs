import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault, InMemorySecretProvider } from '@control-plane/credential-vault'
import {
  SqliteCredentialVaultRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import {
  PersistencePortableStateDestination,
  PersistencePortableStateSource,
  applyPortableImport,
  assertPortableManifest,
  createPortableRecord,
  exportPortableState,
  finalizePortableManifest,
  planPortableImport,
} from './index.ts'

const createdAt = '2026-10-06T12:00:00.000Z'
const canary = 'portable-credential-SECRET-canary-0c6f'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const activeId = 'crd_01JABCDEF0123456789ABCDEFG'
const revokedId = 'crd_01JABCDEF0123456789ABCDEFH'
const cleanup = []

afterEach(async () => {
  for (const task of cleanup.splice(0).toReversed()) await task()
})

async function sqliteProvider(profile) {
  const directory = await mkdtemp(join(tmpdir(), 'portable-credentials-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite'), profile })
  await provider.migrate()
  cleanup.push(async () => rm(directory, { recursive: true, force: true }))
  cleanup.push(async () => provider.close())
  return provider
}

function vaultFor(provider, secrets = new InMemorySecretProvider()) {
  return new CredentialVault({
    provider: secrets,
    repository: new SqliteCredentialVaultRepository(provider),
    decisionPoint: {
      async authorize(request) {
        return {
          effect: 'allow',
          decisionId: `sha256:${'b'.repeat(64)}`,
          reasonCode: 'CEDAR_PERMIT',
          policySnapshot: request.policySnapshot,
          evaluatedAt: request.context.requestedAt,
        }
      },
    },
    now: () => createdAt,
  })
}

test('exports credential metadata without secrets and requires secret re-entry after import', async () => {
  const sourceProvider = await sqliteProvider('local')
  const sourceVault = vaultFor(sourceProvider)
  await sourceVault.create({
    credentialId: activeId,
    workspaceId,
    connectorRef: 'connector:github',
    provider: 'github',
    secret: canary,
    createdAt,
    createdBy: 'svc_agent-hq',
  })
  await sourceVault.rotate(activeId, `${canary}-rotated`, 'svc_agent-hq')
  await sourceVault.create({
    credentialId: revokedId,
    workspaceId,
    connectorRef: 'connector:slack',
    provider: 'slack',
    secret: `${canary}-slack`,
    createdAt,
  })
  await sourceVault.revoke(revokedId, 'svc_agent-hq')

  const manifest = await exportPortableState(
    new PersistencePortableStateSource({
      persistence: sourceProvider,
      componentVersions: { contracts: '3.0.0' },
    }),
    { exportId: 'export-credentials', createdAt, sensitiveValues: [canary] }
  )
  const credentials = manifest.records.filter(({ category }) => category === 'credential-metadata')
  expect(credentials.map(({ logicalId }) => logicalId).toSorted()).toEqual([
    `credentials/${activeId}`,
    `credentials/${revokedId}`,
  ])
  expect(credentials.find(({ logicalId }) => logicalId.endsWith(activeId)).value).toEqual({
    credentialId: activeId,
    workspaceId,
    connectorRef: 'connector:github',
    provider: 'github',
    revision: 2,
    createdAt,
    createdBy: 'svc_agent-hq',
    rotatedAt: createdAt,
  })
  const serialized = JSON.stringify(manifest)
  for (const forbidden of [
    canary,
    'memory://',
    'secretRevisions',
    'ciphertextDigest',
    'keyReference',
  ]) {
    expect(serialized.includes(forbidden)).toBe(false)
  }
  expect(manifest.secretReferences).toEqual([])

  const destinationProvider = await sqliteProvider('hosted-simple')
  const destination = new PersistencePortableStateDestination({
    persistence: destinationProvider,
    capabilities: new Set(),
    secretProviders: new Set(),
  })
  const plan = await planPortableImport(manifest, destination)
  expect(plan.applicable).toBe(true)
  await expect(
    applyPortableImport(manifest, plan, destination, {}, () => createdAt)
  ).resolves.toMatchObject({ outcome: 'applied' })

  const destinationVault = vaultFor(destinationProvider)
  expect(await destinationVault.metadata(activeId, workspaceId)).toMatchObject({
    status: 'secret_required',
    revision: 2,
  })
  expect((await destinationVault.metadata(revokedId, workspaceId)).status).toBe('revoked')
  const lease = {
    credentialLeaseId: 'crl_01JABCDEF0123456789ABCDEFG',
    credentialId: activeId,
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    workspaceId,
    principalRef: 'service:tool-gateway',
    operation: 'issues.list',
    resourceRef: 'mcp/github/issues.list',
    requestedAt: createdAt,
    expiresAt: '2026-10-06T12:01:00.000Z',
    policySnapshot: {
      policyId: 'workspace-standard',
      version: 1,
      digest: `sha256:${'a'.repeat(64)}`,
    },
  }
  await expect(destinationVault.lease(lease)).rejects.toMatchObject({
    code: 'CREDENTIAL_SECRET_REQUIRED',
  })
  expect((await destinationVault.audit({ workspaceId })).map(({ action }) => action)).toEqual([
    'credential.imported',
    'credential.imported',
  ])

  // Replaying the same manifest stays equivalent while metadata is unchanged.
  const replay = await planPortableImport(manifest, destination)
  expect(replay.records.every(({ state }) => state === 'equivalent')).toBe(true)
  await expect(
    applyPortableImport(manifest, replay, destination, {}, () => createdAt)
  ).resolves.toMatchObject({ outcome: 'replayed' })

  // Re-entering the secret through rotation makes the imported credential leasable again.
  await destinationVault.rotate(activeId, `${canary}-reentered`, 'operator:import', {
    workspaceId,
    expectedRevision: 2,
  })
  const issued = await destinationVault.lease(lease)
  await expect(
    destinationVault.use(
      issued.capabilityRef,
      { workspaceId, operation: lease.operation, resourceRef: lease.resourceRef },
      (secret) => secret === `${canary}-reentered`
    )
  ).resolves.toBe(true)
})

test('manifests that carry secret material or status for a credential are rejected', async () => {
  const sourceProvider = await sqliteProvider('local')
  await vaultFor(sourceProvider).create({
    credentialId: activeId,
    workspaceId,
    connectorRef: 'connector:github',
    provider: 'github',
    secret: canary,
    createdAt,
  })
  const manifest = await exportPortableState(
    new PersistencePortableStateSource({
      persistence: sourceProvider,
      componentVersions: { contracts: '3.0.0' },
    }),
    { exportId: 'export-credentials-tamper', createdAt }
  )
  const { contentDigest: _digest, ...unsigned } = manifest
  for (const extra of [
    { secret: canary },
    { secretRevisions: [] },
    { status: 'active' },
    { locator: 'neon://credential-secrets/crd' },
  ]) {
    const records = manifest.records.map(({ contentDigest: _recordDigest, ...record }) =>
      createPortableRecord(
        record.category === 'credential-metadata'
          ? { ...record, value: { ...record.value, ...extra } }
          : record
      )
    )
    // Digests are valid, so only the strict credential schema can reject the manifest.
    const tampered = finalizePortableManifest({ ...unsigned, records })
    expect(() => assertPortableManifest(tampered)).toThrow()
  }
})
