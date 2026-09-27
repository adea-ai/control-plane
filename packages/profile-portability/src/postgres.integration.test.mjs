import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import {
  PostgresContextPackageRepository,
  PostgresContextAuthoringCommandRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionValidationCommandRepository,
  PostgresEvaluationRepository,
  contextPackages,
  executionPlans,
  profileMigrations,
} from '@control-plane/database'
import { assertExecutionPlanIntegrity, deriveExecutionPlan } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import { VersionedCatalog, executionConstraintFixtures } from '@control-plane/domain'
import { eq } from 'drizzle-orm'
import {
  SqlitePersistenceProvider,
  SqliteVersionedCatalogRepository,
  SqliteContextAuthoringCommandRepository,
  SqliteExecutionValidationCommandRepository,
  SqliteEvaluationRepository,
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
import { observedEvaluationFixture } from './evaluation-fixture.mjs'

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
  const cleanupErrors = []
  const providerResults = await Promise.allSettled(providers.map((provider) => provider.close()))
  cleanupErrors.push(
    ...providerResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
  )
  try {
    await database?.dispose()
  } catch (error) {
    cleanupErrors.push(error)
  }
  const directoryResults = await Promise.allSettled(
    directories.map((path) => rm(path, { recursive: true, force: true }))
  )
  cleanupErrors.push(
    ...directoryResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
  )
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'PostgreSQL portability integration cleanup failed')
  }
})

describe.skipIf(!enabled)('PostgreSQL deployment-profile migration', () => {
  test('moves a supported catalog subset SQLite to PostgreSQL and back with stable identity', async () => {
    const local = await sqliteProvider('local')
    await seedCatalog(local)
    const evaluation = await observedEvaluationFixture()
    await new SqliteEvaluationRepository(local).saveRun(evaluation)
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
    expect(
      await new PostgresEvaluationRepository(database.application).getRun(evaluation.evalRunId)
    ).toEqual(evaluation)
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
    expect(await new SqliteEvaluationRepository(restored).getRun(evaluation.evalRunId)).toEqual(
      evaluation
    )
    expect(restoredManifest.records.map(({ contentDigest }) => contentDigest)).toEqual(
      localManifest.records.map(({ contentDigest }) => contentDigest)
    )
  })

  test('resets PostgreSQL reference clocks for new lineage edges and preserves equivalent replay clocks', async () => {
    const fixture = await postgresReferenceFixture('new-edge-clock')
    const initialClock = '2025-06-07T08:09:10.000Z'
    await setPostgresReferenceClocks(
      [fixture.parentContext.contextPackageId, fixture.unrelatedContext.contextPackageId],
      [fixture.parentPlan.executionPlanId, fixture.unrelatedPlan.executionPlanId],
      initialClock
    )
    const manifest = await exportPortableState(
      postgresImportSource([
        portableRecord('context-package', fixture.parentContext),
        portableRecord('context-package', fixture.childContext),
        portableRecord('execution-plan', fixture.parentPlan),
        portableRecord('execution-plan', fixture.childPlan),
      ]),
      { exportId: 'postgres-reference-clock-import', createdAt }
    )
    const destination = postgresDestination()
    const plan = await planPortableImport(manifest, destination)
    expect(plan.applicable).toBe(true)
    expect(
      plan.records
        .filter(({ state }) => state === 'equivalent')
        .map(({ record }) => record.logicalId)
    ).toEqual(
      [
        `context-packages/${fixture.parentContext.contextPackageId}`,
        `execution-plans/${fixture.parentPlan.executionPlanId}`,
      ].toSorted()
    )
    expect(
      plan.records.filter(({ state }) => state === 'missing').map(({ record }) => record.logicalId)
    ).toEqual(
      [
        `context-packages/${fixture.childContext.contextPackageId}`,
        `execution-plans/${fixture.childPlan.executionPlanId}`,
      ].toSorted()
    )
    await expect(
      applyPortableImport(manifest, plan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'applied' })
    expect(
      await postgresReferenceClocks(
        [
          fixture.parentContext.contextPackageId,
          fixture.childContext.contextPackageId,
          fixture.unrelatedContext.contextPackageId,
        ],
        [
          fixture.parentPlan.executionPlanId,
          fixture.childPlan.executionPlanId,
          fixture.unrelatedPlan.executionPlanId,
        ]
      )
    ).toEqual({
      contextPackages: [null, null, initialClock],
      executionPlans: [null, null, initialClock],
    })

    const replayClock = '2025-07-08T09:10:11.000Z'
    await setPostgresReferenceClocks(
      [
        fixture.parentContext.contextPackageId,
        fixture.childContext.contextPackageId,
        fixture.unrelatedContext.contextPackageId,
      ],
      [
        fixture.parentPlan.executionPlanId,
        fixture.childPlan.executionPlanId,
        fixture.unrelatedPlan.executionPlanId,
      ],
      replayClock
    )
    const replayPlan = await planPortableImport(manifest, destination)
    expect(replayPlan.records.every(({ state }) => state === 'equivalent')).toBe(true)
    await expect(
      applyPortableImport(manifest, replayPlan, destination, {}, () => createdAt)
    ).resolves.toMatchObject({ outcome: 'replayed' })
    expect(
      await postgresReferenceClocks(
        [
          fixture.parentContext.contextPackageId,
          fixture.childContext.contextPackageId,
          fixture.unrelatedContext.contextPackageId,
        ],
        [
          fixture.parentPlan.executionPlanId,
          fixture.childPlan.executionPlanId,
          fixture.unrelatedPlan.executionPlanId,
        ]
      )
    ).toEqual({
      contextPackages: [replayClock, replayClock, replayClock],
      executionPlans: [replayClock, replayClock, replayClock],
    })
  })

  test('rolls back PostgreSQL lineage claims, imported rows, provenance, and clocks on invalid derivation', async () => {
    const fixture = await postgresReferenceFixture('rollback-edge-clock')
    await new PostgresContextPackageRepository(database.application).put(fixture.childContext)
    const widenedPlan = rehashExecutionPlan({
      ...fixture.childPlan,
      constraints: {
        ...fixture.childPlan.constraints,
        tools: {
          ...fixture.childPlan.constraints.tools,
          grants: fixture.childPlan.constraints.tools.grants.map((grant, index) =>
            index === 0 ? { ...grant, operations: [...grant.operations, 'admin'] } : grant
          ),
        },
      },
    })
    expect(assertExecutionPlanIntegrity(widenedPlan)).toEqual(widenedPlan)
    const clock = '2025-08-09T10:11:12.000Z'
    await setPostgresReferenceClocks(
      [
        fixture.parentContext.contextPackageId,
        fixture.childContext.contextPackageId,
        fixture.unrelatedContext.contextPackageId,
      ],
      [fixture.parentPlan.executionPlanId, fixture.unrelatedPlan.executionPlanId],
      clock
    )
    const exportId = 'postgres-invalid-lineage-rollback'
    const manifest = await exportPortableState(
      postgresImportSource([portableRecord('execution-plan', widenedPlan)]),
      { exportId, createdAt }
    )
    const destination = postgresDestination()
    const plan = await planPortableImport(manifest, destination)
    expect(plan).toMatchObject({ applicable: true, records: [{ state: 'missing' }] })

    await expect(
      applyPortableImport(manifest, plan, destination, {}, () => createdAt)
    ).rejects.toMatchObject({ code: 'PORTABLE_PLAN_STALE' })
    expect(
      await database.application
        .select({ executionPlanId: executionPlans.executionPlanId })
        .from(executionPlans)
        .where(eq(executionPlans.executionPlanId, widenedPlan.executionPlanId))
    ).toEqual([])
    expect(
      await database.application
        .select({ exportId: profileMigrations.exportId })
        .from(profileMigrations)
        .where(eq(profileMigrations.exportId, exportId))
    ).toEqual([])
    expect(
      await postgresReferenceClocks(
        [
          fixture.parentContext.contextPackageId,
          fixture.childContext.contextPackageId,
          fixture.unrelatedContext.contextPackageId,
        ],
        [fixture.parentPlan.executionPlanId, fixture.unrelatedPlan.executionPlanId]
      )
    ).toEqual({
      contextPackages: [clock, clock, clock],
      executionPlans: [clock, clock],
    })
  })
})

async function postgresReferenceFixture(label) {
  const parentContext = contextPackageSerializationFixtures.futurePi
  const childContext = deriveContextPackage(parentContext, {
    objective: `Portable PostgreSQL child ${label}`,
    allowedStateItemIds: [],
    allowedArtifactIds: [],
    budgets: { maximumBytes: 512, maximumTokens: 128 },
    successCriteria: ['Preserve durable parent references'],
    returnContract: parentContext.returnContract,
    compiledAt: '2026-08-30T13:00:00.000Z',
  })
  const parentPlan = createExecutionPlanTestFixture({ contextPackage: parentContext })
  const childPlan = deriveExecutionPlan(parentPlan, {
    correlation: parentPlan.correlation,
    contextPackage: childContext,
    constraints: parentPlan.constraints,
    runtimeRequirements: parentPlan.runtimeRequirements,
    outputContract: parentPlan.outputContract,
    compiledAt: '2026-08-30T13:00:00.000Z',
  })
  const unrelatedContext = contextPackageSerializationFixtures.futureLangGraph
  const unrelatedPlan = createExecutionPlanTestFixture({ contextPackage: unrelatedContext })

  await new PostgresContextPackageRepository(database.application).put(parentContext)
  await new PostgresContextPackageRepository(database.application).put(unrelatedContext)
  await new PostgresExecutionPlanRepository(database.application).put(parentPlan)
  await new PostgresExecutionPlanRepository(database.application).put(unrelatedPlan)

  return { parentContext, childContext, parentPlan, childPlan, unrelatedContext, unrelatedPlan }
}

async function setPostgresReferenceClocks(contextIds, planIds, instant) {
  const timestamp = new Date(instant)
  for (const contextPackageId of contextIds) {
    const rows = await database.application
      .update(contextPackages)
      .set({ unreferencedSince: timestamp })
      .where(eq(contextPackages.contextPackageId, contextPackageId))
      .returning({ contextPackageId: contextPackages.contextPackageId })
    expect(rows).toHaveLength(1)
  }
  for (const executionPlanId of planIds) {
    const rows = await database.application
      .update(executionPlans)
      .set({ unreferencedSince: timestamp })
      .where(eq(executionPlans.executionPlanId, executionPlanId))
      .returning({ executionPlanId: executionPlans.executionPlanId })
    expect(rows).toHaveLength(1)
  }
}

async function postgresReferenceClocks(contextIds, planIds) {
  const contextClockValues = []
  for (const contextPackageId of contextIds) {
    const [row] = await database.application
      .select({ unreferencedSince: contextPackages.unreferencedSince })
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, contextPackageId))
      .limit(1)
    contextClockValues.push(row?.unreferencedSince?.toISOString() ?? null)
  }
  const planClockValues = []
  for (const executionPlanId of planIds) {
    const [row] = await database.application
      .select({ unreferencedSince: executionPlans.unreferencedSince })
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, executionPlanId))
      .limit(1)
    planClockValues.push(row?.unreferencedSince?.toISOString() ?? null)
  }
  return { contextPackages: contextClockValues, executionPlans: planClockValues }
}

function postgresImportSource(records) {
  return {
    profile: 'cloud',
    persistence: 'postgresql',
    objectStore: 's3-compatible',
    componentVersions: {},
    async snapshot() {
      return { records, artifacts: [], secretReferences: [] }
    },
  }
}

function postgresDestination() {
  return new PostgresPortableStateDestination({
    database: database.application,
    profile: 'cloud',
    capabilities: new Set(),
    secretProviders: new Set(),
  })
}

function portableRecord(category, value) {
  const namespace = category === 'context-package' ? 'context-packages' : 'execution-plans'
  const identityField = category === 'context-package' ? 'contextPackageId' : 'executionPlanId'
  return {
    category,
    logicalId: `${namespace}/${value[identityField]}`,
    revision: 0,
    value,
  }
}

function rehashExecutionPlan(plan) {
  const { executionPlanId: _executionPlanId, contentDigest: _contentDigest, ...content } = plan
  const contentDigest = `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(content))
    .digest('hex')}`
  const bytes = Buffer.from(contentDigest.slice(7, 39), 'hex')
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let bits = 0
  let accumulator = 0
  let identifier = ''
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      identifier += alphabet[(accumulator >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) identifier += alphabet[(accumulator << (5 - bits)) & 31]
  return {
    ...content,
    executionPlanId: `pln_${identifier.slice(0, 26)}`,
    contentDigest,
  }
}

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
