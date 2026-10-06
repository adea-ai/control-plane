import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { VersionedCatalog, WorkspaceCatalog } from '@control-plane/domain'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresCatalogRepository } from './catalog-repository.ts'
import { PostgresWorkspaceCatalogCommandRepository } from './workspace-catalog-command-repository.ts'
import { skills, workspaceCatalogCommands } from './schema/catalog.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const otherWorkspaceId = 'wsp_01JZZZZZZ0123456789ABCDEFG'
const at = '2026-10-06T12:00:00.000Z'

const manifest = (semanticVersion) => ({
  schemaVersion: 1,
  semanticVersion,
  requiredCapabilities: [],
  requiredTools: [],
  compatibleProfileSchemaVersions: [1],
  compatibleContractMajorVersions: [3],
})

const command = (idempotencyKey, payloadHash = 'a'.repeat(64)) => ({
  callerId: 'svc_agent-hq',
  operation: 'skill.publish',
  idempotencyKey,
  payloadHash,
})

const publish = (workspace, skillId, skillVersionId, semanticVersion) => (store) =>
  new WorkspaceCatalog(store, workspace)
    .publishSkillVersion({
      skillId,
      skillVersionId,
      displayName: 'Release notes',
      manifest: manifest(semanticVersion),
      content: { instructions: 'Summarize.', artifactRefs: [] },
      at,
    })
    .then(({ version }) => ({ skillVersionId: version.skillVersionId, revision: version.revision }))

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
  'PostgreSQL workspace catalog administration',
  () => {
    let isolated
    let catalog
    let commands

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase({
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      })
      await isolated.migrate()
      catalog = new PostgresCatalogRepository(isolated.application)
      commands = new PostgresWorkspaceCatalogCommandRepository(isolated.application)
      const versioned = new VersionedCatalog(catalog, catalog)
      for (const [skillId, ownership] of [
        ['skl_01JABCDEF0123456789ABCDEF0', { scope: 'system' }],
        ['skl_01JABCDEF0123456789ABCDEF9', { scope: 'private', principalRef: 'svc_agent-hq' }],
      ]) {
        await versioned.createSkill({ skillId, displayName: 'Seeded', ownership, createdAt: at })
      }
      // Bypasses schema stripping: a non-canonical ownership shape must stay invisible.
      await isolated.application.insert(skills).values({
        skillId: 'skl_01JABCDEF0123456789ABCDEF8',
        displayName: 'Malformed owner',
        ownership: { scope: 'workspace', workspaceId, unexpected: true },
        provenance: { source: 'workspace-authorized', ownerRef: workspaceId, trust: 'authorized' },
        createdAt: new Date(at),
      })
    }, integrationTestTimeout(60_000))

    afterAll(async () => {
      await isolated?.dispose()
    })

    test(
      'commits receipts atomically, replays, rejects changed payloads and rolls back failures',
      async () => {
        const skillId = 'skl_01JABCDEF0123456789ABCDEF1'
        const action = publish(workspaceId, skillId, 'skv_01JABCDEF0123456789ABCDEF1', '1.0.0')
        const first = await commands.executeCommand(
          workspaceId,
          command('pg-catalog-key-0001'),
          action
        )
        expect(first).toEqual({ skillVersionId: 'skv_01JABCDEF0123456789ABCDEF1', revision: 2 })
        expect(
          await commands.executeCommand(workspaceId, command('pg-catalog-key-0001'), async () => {
            throw new Error('replay must not run the action')
          })
        ).toEqual(first)
        await expect(
          commands.executeCommand(
            workspaceId,
            command('pg-catalog-key-0001', 'b'.repeat(64)),
            action
          )
        ).rejects.toMatchObject({ code: 'CATALOG_COMMAND_CONFLICT' })
        await expect(
          commands.executeCommand(workspaceId, command('pg-catalog-key-0002'), async (store) => {
            await publish(workspaceId, skillId, 'skv_01JABCDEF0123456789ABCDEF2', '1.1.0')(store)
            throw new Error('late failure')
          })
        ).rejects.toThrow('late failure')
        expect(await catalog.getSkillVersion('skv_01JABCDEF0123456789ABCDEF2')).toBeUndefined()
        const receipts = await isolated.application.select().from(workspaceCatalogCommands)
        expect(receipts.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
          'pg-catalog-key-0001',
        ])
      },
      integrationTestTimeout(30_000)
    )

    test(
      'serializes concurrent publishes so one semantic version has exactly one winner',
      async () => {
        const skillId = 'skl_01JABCDEF0123456789ABCDEF3'
        await commands.executeCommand(
          workspaceId,
          command('pg-catalog-key-0010'),
          publish(workspaceId, skillId, 'skv_01JABCDEF0123456789ABCDEF3', '1.0.0')
        )
        const results = await Promise.allSettled(
          ['4', '5', '6'].map((suffix) =>
            commands.executeCommand(
              workspaceId,
              command(`pg-catalog-key-001${suffix}`),
              publish(workspaceId, skillId, `skv_01JABCDEF0123456789ABCDEF${suffix}`, '2.0.0')
            )
          )
        )
        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
        for (const result of results.filter(({ status }) => status === 'rejected')) {
          expect(result.reason).toMatchObject({ code: 'SKILL_SEMANTIC_VERSION_CONFLICT' })
        }
      },
      integrationTestTimeout(30_000)
    )

    test(
      'lists only system and exact-workspace records in binary ID order',
      async () => {
        const page = await catalog.listWorkspaceSkills({ workspaceId, limit: 10 })
        expect(page.map(({ skillId }) => skillId)).toEqual([
          'skl_01JABCDEF0123456789ABCDEF0',
          'skl_01JABCDEF0123456789ABCDEF1',
          'skl_01JABCDEF0123456789ABCDEF3',
        ])
        expect(
          (
            await catalog.listWorkspaceSkills({
              workspaceId,
              after: 'skl_01JABCDEF0123456789ABCDEF0',
              limit: 1,
            })
          ).map(({ skillId }) => skillId)
        ).toEqual(['skl_01JABCDEF0123456789ABCDEF1'])
        expect(
          (await catalog.listWorkspaceSkills({ workspaceId: otherWorkspaceId, limit: 10 })).map(
            ({ skillId }) => skillId
          )
        ).toEqual(['skl_01JABCDEF0123456789ABCDEF0'])
        expect(await catalog.listWorkspaceAgentProfiles({ workspaceId, limit: 10 })).toEqual([])
      },
      integrationTestTimeout(30_000)
    )
  }
)
