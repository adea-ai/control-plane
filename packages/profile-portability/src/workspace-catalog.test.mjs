import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceCatalog, executionConstraintFixtures } from '@control-plane/domain'
import {
  SqlitePersistenceProvider,
  SqliteVersionedCatalogRepository,
  SqliteWorkspaceCatalogCommandRepository,
} from '@control-plane/sqlite-persistence'
import {
  PersistencePortableStateDestination,
  PersistencePortableStateSource,
  applyPortableImport,
  exportPortableState,
  planPortableImport,
} from './index.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const createdAt = '2026-10-06T12:00:00.000Z'
const cleanups = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function sqlite(profile) {
  const directory = await mkdtemp(join(tmpdir(), `portable-workspace-catalog-${profile}-`))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite'), profile })
  cleanups.push(async () => {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  })
  await provider.migrate()
  return provider
}

test('workspace-owned catalog entries published through the API move between profiles', async () => {
  const source = await sqlite('local')
  const commands = new SqliteWorkspaceCatalogCommandRepository(source)
  const command = (operation, key) => ({
    callerId: 'svc_agent-hq',
    operation,
    idempotencyKey: `portable-catalog-${key}`,
    payloadHash: key.repeat(64).slice(0, 64),
  })
  const skill = await commands.executeCommand(workspaceId, command('skill.publish', 'a'), (store) =>
    new WorkspaceCatalog(store, workspaceId)
      .publishSkillVersion({
        skillId: 'skl_01JABCDEF0123456789ABCDEF1',
        skillVersionId: 'skv_01JABCDEF0123456789ABCDEF1',
        displayName: 'Release notes',
        manifest: {
          schemaVersion: 1,
          semanticVersion: '1.0.0',
          requiredCapabilities: [],
          requiredTools: [],
          compatibleProfileSchemaVersions: [1],
          compatibleContractMajorVersions: [3],
        },
        content: { instructions: 'Summarize merged work.', artifactRefs: [] },
        at: createdAt,
      })
      .then(({ version }) => ({
        skillId: version.skillId,
        skillVersionId: version.skillVersionId,
        contentDigest: version.manifest.contentDigest,
      }))
  )
  await commands.executeCommand(workspaceId, command('profile.publish', 'b'), (store) =>
    new WorkspaceCatalog(store, workspaceId)
      .publishAgentProfileVersion({
        profileId: 'prf_01JABCDEF0123456789ABCDEF1',
        profileVersionId: 'pfv_01JABCDEF0123456789ABCDEF1',
        displayName: 'Release manager',
        version: 1,
        definition: {
          schemaVersion: 1,
          roleInstructions: 'Coordinate releases',
          skills: [skill],
          capabilityRequirements: [],
          executionConstraints: executionConstraintFixtures.readOnly,
          outputContractRefs: [],
        },
        at: createdAt,
      })
      .then(({ version }) => ({ profileVersionId: version.profileVersionId }))
  )

  const manifest = await exportPortableState(
    new PersistencePortableStateSource({
      persistence: source,
      componentVersions: { contracts: '1.13.0' },
    }),
    { exportId: 'workspace-catalog-portability', createdAt }
  )
  // Catalog records and versions are portable; idempotency receipts are not logical state.
  expect(manifest.records.map(({ logicalId }) => logicalId.split('/')[0]).toSorted()).toEqual([
    'agent-profile-versions',
    'agent-profiles',
    'skill-versions',
    'skills',
  ])

  const destinationProvider = await sqlite('hosted-simple')
  const destination = new PersistencePortableStateDestination({
    persistence: destinationProvider,
    capabilities: new Set(),
    secretProviders: new Set(),
  })
  const plan = await planPortableImport(manifest, destination)
  await expect(
    applyPortableImport(manifest, plan, destination, {}, () => createdAt)
  ).resolves.toMatchObject({ outcome: 'applied' })

  const imported = new SqliteVersionedCatalogRepository(destinationProvider)
  const catalog = new WorkspaceCatalog(imported, workspaceId)
  const skills = await catalog.listSkills(imported, { limit: 10 })
  const profiles = await catalog.listAgentProfiles(imported, { limit: 10 })
  expect(skills.items.map(({ skill: record }) => record.ownership)).toEqual([
    { scope: 'workspace', workspaceId },
  ])
  expect(skills.items[0].latestVersion.manifest.contentDigest).toBe(skill.contentDigest)
  expect(profiles.items[0].latestVersion).toMatchObject({ lifecycle: 'published', revision: 2 })
  expect(
    (
      await new WorkspaceCatalog(imported, 'wsp_01JZZZZZZ0123456789ABCDEFG').listSkills(imported, {
        limit: 10,
      })
    ).items
  ).toEqual([])
})
