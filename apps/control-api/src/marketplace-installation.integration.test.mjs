import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createIsolatedPostgres } from '@control-plane/testing/postgres'
import { integrationTestTimeout } from '@control-plane/database/testing'
import { MarketplaceInstallationService } from './marketplace/installation.ts'
import { PostgresMarketplaceInstallationRepository } from './marketplace/postgres-installation-repository.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const workspaceA = 'wsp_01JABCDEF0123456789ABCDEFG'
const workspaceB = 'wsp_01JABCDEF0123456789ABCDEFH'
let database

const plugin = {
  canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
  pluginId: 'plugin:openai-official:gmail',
  releaseId: `release:${'c'.repeat(64)}`,
}

function service(repository) {
  const release = {
    ...plugin,
    contentResolution: 'complete',
    requiredConnectors: [],
    requiredCredentials: [],
  }
  let tick = 0
  return new MarketplaceInstallationService({
    registry: {
      getCatalog: async () => ({
        catalog: {
          plugins: [
            {
              ...release,
              availableReleases: [release],
              currentReleaseId: release.releaseId,
              harnessCompatibility: { codex: { status: 'portable' } },
              securityClassification: { level: 'low' },
            },
          ],
        },
        catalogId: `catalog:${'a'.repeat(64)}`,
        state: 'ready',
      }),
      verifyRelease: async () => true,
    },
    repository,
    now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, tick++)).toISOString(),
  })
}

function install(key, workspaceId = workspaceA, userId = 'user-1') {
  return {
    idempotencyKey: key,
    payload: { ...plugin, requestedHarness: 'codex', workspaceIdentity: { userId, workspaceId } },
    workspaceId,
  }
}

function uninstall(installationId, key, workspaceId = workspaceA, userId = 'user-2') {
  return {
    idempotencyKey: key,
    payload: { installationId, workspaceIdentity: { userId, workspaceId } },
    workspaceId,
  }
}

beforeAll(async () => {
  if (!enabled) return
  database = await createIsolatedPostgres({ migrate: false })
  await database.migrate()
}, integrationTestTimeout(60_000))

afterAll(async () => {
  await database?.dispose()
}, integrationTestTimeout())

test.skipIf(!enabled)(
  'persists the uninstall transition with workspace isolation and idempotent replay',
  async () => {
    const repository = new PostgresMarketplaceInstallationRepository(database.application)
    const authority = service(repository)
    const installed = await authority.install(install('pg-lifecycle-install-0001'))
    const other = await authority.install(
      install('pg-lifecycle-install-0002', workspaceA, 'user-9')
    )
    expect(installed.state).toBe('installed')

    expect(
      (await authority.list(workspaceA, { installedBy: 'user-1' })).map((r) => r.installationId)
    ).toEqual([installed.installationId])
    await expect(
      authority.get({
        parameters: {
          installationId: installed.installationId,
          workspaceIdentity: { userId: 'user-1', workspaceId: workspaceB },
        },
        workspaceId: workspaceB,
      })
    ).rejects.toMatchObject({ response: { code: 'MARKETPLACE_INSTALLATION_NOT_FOUND' } })
    await expect(
      authority.uninstall(uninstall(installed.installationId, 'pg-lifecycle-un-0001', workspaceB))
    ).rejects.toMatchObject({ response: { code: 'MARKETPLACE_INSTALLATION_NOT_FOUND' } })

    const first = await authority.uninstall(
      uninstall(installed.installationId, 'pg-lifecycle-un-0001')
    )
    expect(first).toMatchObject({
      installation: { state: 'uninstalled', uninstalledBy: 'user-2' },
      replayed: false,
    })
    expect(
      await authority.uninstall(uninstall(installed.installationId, 'pg-lifecycle-un-0001'))
    ).toEqual({ installation: first.installation, replayed: true })
    await expect(
      authority.uninstall(uninstall(other.installationId, 'pg-lifecycle-un-0001'))
    ).rejects.toMatchObject({ response: { code: 'MARKETPLACE_IDEMPOTENCY_CONFLICT' } })

    // A direct transition attempt on a terminal row and a taken key both no-op.
    expect(
      await repository.markUninstalled({
        idempotencyKey: 'pg-lifecycle-un-0002',
        installationId: installed.installationId,
        requestDigest: 'f'.repeat(64),
        uninstalledAt: '2026-09-02T00:00:00.000Z',
        uninstalledBy: 'late',
        workspaceId: workspaceA,
      })
    ).toBeUndefined()
    expect(
      await repository.markUninstalled({
        idempotencyKey: 'pg-lifecycle-un-0001',
        installationId: other.installationId,
        requestDigest: 'f'.repeat(64),
        uninstalledAt: '2026-09-02T00:00:00.000Z',
        uninstalledBy: 'late',
        workspaceId: workspaceA,
      })
    ).toBeUndefined()

    expect((await authority.list(workspaceA)).map((r) => r.installationId)).toEqual([
      other.installationId,
    ])
    await expect(authority.install(install('pg-lifecycle-install-0001'))).rejects.toMatchObject({
      response: { code: 'MARKETPLACE_INSTALLATION_UNINSTALLED' },
    })
    const reinstalled = await authority.install(install('pg-lifecycle-install-0003'))
    expect(reinstalled.installationId).not.toBe(installed.installationId)
    expect((await authority.list(workspaceA, { installedBy: 'user-1' })).length).toBe(1)
    expect(
      await authority.get({
        parameters: {
          installationId: installed.installationId,
          workspaceIdentity: { userId: 'user-1', workspaceId: workspaceA },
        },
        workspaceId: workspaceA,
      })
    ).toEqual(first.installation)
  },
  integrationTestTimeout()
)
