import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadDatabaseCredentials } from '@control-plane/config'
import { PostgresModelSelectionRepository } from './model-selection-repository.ts'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const connection = {
  connectionRef: `mconn_${'1'.repeat(32)}`,
  revision: 1,
  workspaceId,
  ownerRef: 'svc_workspace-admin',
  credentialRef: 'crd_01JABCDEF0123456789ABCDEFG',
  credentialRevision: 1,
  provider: 'openai',
  accountRef: 'account:one',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  status: 'active',
  models: ['fixture-model'],
  workspaceGrant: {
    grantRef: 'grant:one',
    revision: 1,
    status: 'active',
    expiresAt: '2026-10-09T12:00:00.000Z',
  },
}
const selection = {
  schemaVersion: 'model-selection/v1',
  selectionRef: `msel_${'2'.repeat(32)}`,
  selectionRevision: 1,
  workspaceId,
  connectionRef: connection.connectionRef,
  connectionRevision: 1,
  credentialRef: connection.credentialRef,
  credentialRevision: 1,
  provider: 'openai',
  providerModel: 'fixture-model',
  accountRef: 'account:one',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
  workspaceGrant: { grantRef: 'grant:one', revision: 1 },
  configurationRevision: 1,
}
describe.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
  'PostgreSQL immutable model selection repository',
  () => {
    let isolated
    let repository
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase({
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      })
      await isolated.migrate()
      repository = new PostgresModelSelectionRepository(isolated.application)
    }, integrationTestTimeout(60_000))
    afterAll(async () => {
      await isolated?.dispose()
    })
    test('serializes competing defaults and immutable insertions and scopes reads on reopen', async () => {
      expect(await repository.saveConnection(0, connection)).toBe(true)
      const contenders = await Promise.all([
        repository.saveDefaults(0, {
          workspaceId,
          revision: 1,
          lead: { connectionRef: connection.connectionRef, providerModel: 'fixture-model' },
        }),
        repository.saveDefaults(0, {
          workspaceId,
          revision: 1,
          direct: { connectionRef: connection.connectionRef, providerModel: 'fixture-model' },
        }),
      ])
      expect(contenders.filter(Boolean)).toHaveLength(1)
      const inserts = await Promise.all([
        repository.insertSelection(selection),
        repository.insertSelection(selection),
      ])
      expect(inserts.filter(Boolean)).toHaveLength(1)
      expect(await repository.insertSelection({ ...selection, providerModel: 'replaced' })).toBe(
        false
      )
      repository = new PostgresModelSelectionRepository(isolated.application)
      expect(await repository.getSelection(workspaceId, selection.selectionRef)).toEqual(selection)
      expect(await repository.getConnection(workspaceId, connection.connectionRef)).toEqual(
        connection
      )
      expect(await repository.listConnections('wsp_01JABCDEF0123456789ABCDEFH')).toEqual([])
      expect(await repository.getDefaults('wsp_01JABCDEF0123456789ABCDEFH')).toBeUndefined()
      expect(
        await repository.getSelection('wsp_01JABCDEF0123456789ABCDEFH', selection.selectionRef)
      ).toBeUndefined()
    })
    test('rejects account replacement and stale competing updates; revocation cannot revive', async () => {
      expect(
        await repository.saveConnection(1, {
          ...connection,
          revision: 2,
          accountRef: 'account:switched',
        })
      ).toBe(false)
      const revoked = {
        ...connection,
        revision: 2,
        status: 'revoked',
        workspaceGrant: { ...connection.workspaceGrant, revision: 2, status: 'revoked' },
      }
      const updates = await Promise.all([
        repository.saveConnection(1, revoked),
        repository.saveConnection(1, { ...connection, revision: 2 }),
      ])
      expect(updates.filter(Boolean)).toHaveLength(1)
      const current = await repository.getConnection(workspaceId, connection.connectionRef)
      if (current.status !== 'revoked')
        expect(await repository.saveConnection(2, { ...revoked, revision: 3 })).toBe(true)
      const tombstone = await repository.getConnection(workspaceId, connection.connectionRef)
      expect(
        await repository.saveConnection(tombstone.revision, {
          ...tombstone,
          revision: tombstone.revision + 1,
          status: 'active',
        })
      ).toBe(false)
    })
  }
)
