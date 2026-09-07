import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import {
  PostgresContextAuthoringCommandRepository,
  PostgresExecutionValidationCommandRepository,
} from '@control-plane/database'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { VersionedCatalog, executionConstraintFixtures } from '@control-plane/domain'
import {
  SqlitePersistenceProvider,
  SqliteVersionedCatalogRepository,
  SqliteContextAuthoringCommandRepository,
  SqliteExecutionValidationCommandRepository,
} from '@control-plane/sqlite-persistence'
import {
  PersistencePortableStateDestination,
  PersistencePortableStateSource,
  PostgresPortableStateDestination,
  PostgresPortableStateSource,
  applyPortableImport,
  exportPortableState,
  planPortableImport,
} from './index.ts'

const enabled =
  process.env.RUN_M10_POSTGRES_CONFORMANCE === 'true' ||
  process.env.RUN_DATABASE_INTEGRATION === 'true'
const createdAt = '2026-08-30T12:00:00.000Z'
const directories = []
const providers = []
let database

beforeAll(async () => {
  if (!enabled) return
  database = await createIsolatedTestDatabase({
    administration: { role: 'administration', url: process.env.DATABASE_ADMIN_URL },
    migration: { role: 'migration', url: process.env.DATABASE_MIGRATION_URL },
    application: { role: 'application', url: process.env.DATABASE_URL },
  })
  await database.migrate()
})

afterAll(async () => {
  await Promise.all(providers.map((provider) => provider.close()))
  await database?.dispose()
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })))
})

describe.skipIf(!enabled)('PostgreSQL deployment-profile migration', () => {
  test('moves a supported catalog subset SQLite to PostgreSQL and back with stable identity', async () => {
    const local = await sqliteProvider('local')
    await seedCatalog(local)
    const package_ = contextPackageSerializationFixtures.futurePi
    const command = {
      scope: {
        principalRef: 'service:migration-fixture',
        workspaceId: package_.projectState.workspaceId,
        projectId: package_.projectState.projectId,
        operation: 'context.author',
        idempotencyKey: 'migration-authoring-0001',
      },
      payloadHash: `sha256:${'b'.repeat(64)}`,
      contextPackage: {
        contextPackageId: package_.contextPackageId,
        contentDigest: package_.contentDigest,
      },
    }
    await new SqliteContextAuthoringCommandRepository(local).commit(command, package_)
    const executionPlan = createExecutionPlanTestFixture()
    const validation = {
      scope: {
        callerPrincipalId: 'svc_migration',
        workspaceId: executionPlan.correlation.workspaceId,
        projectId: executionPlan.correlation.projectId,
        operation: 'execution.validate',
        idempotencyKey: 'migration-validation-0001',
      },
      commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
      requestId: executionPlan.correlation.requestId,
      payloadHash: `sha256:${'c'.repeat(64)}`,
      executionPlan: {
        executionPlanId: executionPlan.executionPlanId,
        contentDigest: executionPlan.contentDigest,
      },
      recordedAt: createdAt,
    }
    await new SqliteExecutionValidationCommandRepository(local).commit(validation, executionPlan)
    const localManifest = await exportPortableState(
      new PersistencePortableStateSource({
        persistence: local,
        componentVersions: { contracts: '1.0.0' },
      }),
      { exportId: 'sqlite-to-postgres', createdAt }
    )
    const cloud = new PostgresPortableStateDestination({
      database: database.application,
      profile: 'cloud',
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const cloudPlan = await planPortableImport(localManifest, cloud)
    expect(cloudPlan).toMatchObject({ applicable: true, conflicts: [] })
    await expect(
      applyPortableImport(localManifest, cloudPlan, cloud, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'applied' })
    expect(
      await new PostgresContextAuthoringCommandRepository(database.application).get(command.scope)
    ).toEqual(command)
    expect(
      await new PostgresExecutionValidationCommandRepository(database.application).get(
        validation.scope
      )
    ).toEqual(validation)
    const replayPlan = await planPortableImport(localManifest, cloud)
    const replay = await applyPortableImport(localManifest, replayPlan, cloud, {}, () => createdAt)
    expect(replay).toMatchObject({ outcome: 'replayed' })

    const cloudManifest = await exportPortableState(
      new PostgresPortableStateSource({
        database: database.application,
        profile: 'cloud',
        objectStore: 's3-compatible',
        componentVersions: { contracts: '1.0.0' },
      }),
      { exportId: 'postgres-to-sqlite', createdAt }
    )
    const restored = await sqliteProvider('local')
    const localDestination = new PersistencePortableStateDestination({
      persistence: restored,
      capabilities: new Set(),
      secretProviders: new Set(),
    })
    const restorePlan = await planPortableImport(cloudManifest, localDestination)
    await expect(
      applyPortableImport(cloudManifest, restorePlan, localDestination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'applied' })
    const restoredManifest = await exportPortableState(
      new PersistencePortableStateSource({
        persistence: restored,
        componentVersions: { contracts: '1.0.0' },
      }),
      { exportId: 'restored', createdAt }
    )
    expect(await new SqliteContextAuthoringCommandRepository(restored).get(command.scope)).toEqual(
      command
    )
    expect(
      await new SqliteExecutionValidationCommandRepository(restored).get(validation.scope)
    ).toEqual(validation)
    expect(restoredManifest.records.map(({ logicalId }) => logicalId)).toEqual(
      localManifest.records.map(({ logicalId }) => logicalId)
    )
    expect(restoredManifest.records.map(({ contentDigest }) => contentDigest)).toEqual(
      localManifest.records.map(({ contentDigest }) => contentDigest)
    )
  })
})

async function seedCatalog(provider) {
  const repository = new SqliteVersionedCatalogRepository(provider)
  const catalog = new VersionedCatalog(repository, repository)
  const profileId = 'prf_01JABCDEF0123456789ABCDEFG'
  const profileVersionId = 'pfv_01JABCDEF0123456789ABCDEFG'
  const skillId = 'skl_01JABCDEF0123456789ABCDEFG'
  const skillVersionId = 'skv_01JABCDEF0123456789ABCDEFG'
  await catalog.createAgentProfile({
    profileId,
    displayName: 'Portable profile',
    ownership: { scope: 'system' },
    createdAt,
  })
  await catalog.createSkill({
    skillId,
    displayName: 'Portable skill',
    ownership: { scope: 'system' },
    createdAt,
  })
  const skill = await catalog.createSkillDraft({
    skillId,
    skillVersionId,
    manifest: {
      schemaVersion: 1,
      semanticVersion: '1.0.0',
      requiredCapabilities: [],
      requiredTools: [],
      compatibleProfileSchemaVersions: [1],
      compatibleContractMajorVersions: [1],
      evalRefs: [],
    },
    content: { instructions: 'Portable.', artifactRefs: [] },
    createdAt,
  })
  await catalog.publishSkillVersion({
    skillVersionId,
    expectedRevision: skill.revision,
    publishedAt: createdAt,
  })
  const profile = await catalog.createAgentProfileDraft({
    profileId,
    profileVersionId,
    version: 1,
    definition: {
      schemaVersion: 1,
      roleInstructions: 'Portable',
      personaInstructions: 'Exact',
      skills: [{ skillId, skillVersionId, contentDigest: skill.manifest.contentDigest }],
      capabilityRequirements: [],
      executionConstraints: executionConstraintFixtures.readOnly,
      outputContractRefs: ['contract://portable/v1'],
    },
    createdAt,
  })
  await catalog.publishAgentProfileVersion({
    profileVersionId,
    expectedRevision: profile.revision,
    publishedAt: createdAt,
  })
}

async function sqliteProvider(profile) {
  const directory = await mkdtemp(join(tmpdir(), `postgres-portability-${profile}-`))
  directories.push(directory)
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite'), profile })
  providers.push(provider)
  await provider.migrate()
  return provider
}
