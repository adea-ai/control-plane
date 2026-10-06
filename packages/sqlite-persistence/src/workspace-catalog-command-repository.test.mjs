import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceCatalog } from '@control-plane/domain'
import {
  SqlitePersistenceProvider,
  SqliteVersionedCatalogRepository,
  SqliteWorkspaceCatalogCommandRepository,
} from './index.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const skillId = 'skl_01JABCDEF0123456789ABCDEF1'
const cleanups = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function provider() {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-catalog-commands-'))
  const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  cleanups.push(async () => {
    await persistence.close()
    await rm(directory, { recursive: true, force: true })
  })
  await persistence.migrate()
  return persistence
}

const command = (payloadHash, idempotencyKey = 'catalog-command-key-1') => ({
  callerId: 'svc_agent-hq',
  operation: 'skill.publish',
  idempotencyKey,
  payloadHash,
})

const publish = (store, versionId = 'skv_01JABCDEF0123456789ABCDEF1') =>
  new WorkspaceCatalog(store, workspaceId)
    .publishSkillVersion({
      skillId,
      skillVersionId: versionId,
      displayName: 'Release notes',
      manifest: {
        schemaVersion: 1,
        semanticVersion: '1.0.0',
        requiredCapabilities: [],
        requiredTools: [],
        compatibleProfileSchemaVersions: [1],
        compatibleContractMajorVersions: [3],
      },
      content: { instructions: 'Summarize.', artifactRefs: [] },
      at: '2026-10-06T12:00:00.000Z',
    })
    .then(({ version }) => ({ skillVersionId: version.skillVersionId }))

test('commits the catalog mutation and receipt together and replays the original result', async () => {
  const persistence = await provider()
  const commands = new SqliteWorkspaceCatalogCommandRepository(persistence)
  let runs = 0
  const action = async (store) => {
    runs += 1
    return publish(store)
  }
  const first = await commands.executeCommand(workspaceId, command('a'.repeat(64)), action)
  const replay = await commands.executeCommand(workspaceId, command('a'.repeat(64)), action)
  expect(replay).toEqual(first)
  expect(runs).toBe(1)
  await expect(
    commands.executeCommand(workspaceId, command('b'.repeat(64)), action)
  ).rejects.toMatchObject({ code: 'CATALOG_COMMAND_CONFLICT' })
  // Receipts are scoped by workspace: the same key elsewhere runs as an independent command
  // (here it fails because the version ID is already taken, rather than replaying).
  await expect(
    commands.executeCommand('wsp_01JZZZZZZ0123456789ABCDEFG', command('a'.repeat(64)), action)
  ).rejects.toMatchObject({ code: 'VERSION_ALREADY_EXISTS' })
  expect(runs).toBe(2)
})

test('rolls back catalog writes when the action fails after a partial mutation', async () => {
  const persistence = await provider()
  const commands = new SqliteWorkspaceCatalogCommandRepository(persistence)
  await expect(
    commands.executeCommand(workspaceId, command('c'.repeat(64)), async (store) => {
      await publish(store)
      throw new Error('late failure')
    })
  ).rejects.toThrow('late failure')
  const catalog = new SqliteVersionedCatalogRepository(persistence)
  expect(await catalog.getSkill(skillId)).toBeUndefined()
  expect(
    await persistence.transaction((transaction) => transaction.list('workspace-catalog-commands'))
  ).toEqual([])
})

test('fails closed on a corrupt receipt', async () => {
  const persistence = await provider()
  const commands = new SqliteWorkspaceCatalogCommandRepository(persistence)
  await commands.executeCommand(workspaceId, command('d'.repeat(64)), publish)
  await persistence.transaction(async (transaction) => {
    const [record] = await transaction.list('workspace-catalog-commands')
    await transaction.put({
      namespace: 'workspace-catalog-commands',
      id: record.id,
      expectedRevision: record.revision,
      value: { ...record.value, workspaceId: 'wsp_01JZZZZZZ0123456789ABCDEFG' },
    })
  })
  await expect(
    commands.executeCommand(workspaceId, command('d'.repeat(64)), publish)
  ).rejects.toThrow('SQLITE_WORKSPACE_CATALOG_RECEIPT_CORRUPT')
})
