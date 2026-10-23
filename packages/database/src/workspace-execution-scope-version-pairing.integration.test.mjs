import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { loadDatabaseCredentials } from '@control-plane/config'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { contextPackages } from './schema/context-packages.ts'
import { executionPlans } from './schema/execution-plans.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const legacyPlan = createExecutionPlanTestFixture()
const legacyContext = contextPackageSerializationFixtures.futurePi
let isolated
let database
let historicalFolder

describe.skipIf(!enabled)('PostgreSQL scope and schema-version pairing migration', () => {
  beforeAll(async () => {
    const credentials = {
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    }
    isolated = await createIsolatedTestDatabase(credentials)
    database = isolated.application
    historicalFolder = await mkdtemp(join(tmpdir(), 'cp-scope-version-pairing-'))
    await cp(new URL('../drizzle', import.meta.url), historicalFolder, { recursive: true })
    const journalPath = join(historicalFolder, 'meta/_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    const fullJournal = structuredClone(journal)
    journal.entries = journal.entries.filter(({ idx }) => idx < 72)
    await writeFile(journalPath, JSON.stringify(journal))
    await isolated.migrate({ migrationsFolder: historicalFolder })

    await new PostgresContextPackageRepository(database).put(legacyContext)
    await new PostgresExecutionPlanRepository(database).put(legacyPlan)

    // Before 0072, both columns could be updated to schema version 2 while
    // execution_scope remained NULL. Roll back the probe so the additive
    // migration can run against valid retained records.
    const rollback = new Error('ROLLBACK_VERSION_PAIR_REPRODUCTION')
    await isolated.withMigrationDatabase(async (old) => {
      try {
        await old.transaction(async (transaction) => {
          const [plan] = await transaction
            .update(executionPlans)
            .set({ schemaVersion: 2 })
            .where(eq(executionPlans.executionPlanId, legacyPlan.executionPlanId))
            .returning({ schemaVersion: executionPlans.schemaVersion })
          expect(plan.schemaVersion).toBe(2)
          const [context] = await transaction
            .update(contextPackages)
            .set({ schemaVersion: 2 })
            .where(eq(contextPackages.contextPackageId, legacyContext.contextPackageId))
            .returning({ schemaVersion: contextPackages.schemaVersion })
          expect(context.schemaVersion).toBe(2)
          throw rollback
        })
      } catch (error) {
        if (error !== rollback) throw error
      }
    })

    await writeFile(journalPath, JSON.stringify(fullJournal))
    await isolated.migrate({ migrationsFolder: historicalFolder })
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    await isolated?.dispose()
    if (historicalFolder) await rm(historicalFolder, { recursive: true, force: true })
  }, integrationTestTimeout())

  test('raw plan and context updates reject unpaired schema versions and preserve legacy rows', async () => {
    const projectScope = {
      schemaVersion: 1,
      kind: 'project',
      projectId: legacyPlan.correlation.projectId,
    }
    for (const malformed of [
      { schemaVersion: 2, executionScope: null },
      { schemaVersion: 1, executionScope: projectScope },
      { schemaVersion: 3, executionScope: projectScope },
    ]) {
      await expect(
        database
          .update(executionPlans)
          .set(malformed)
          .where(eq(executionPlans.executionPlanId, legacyPlan.executionPlanId))
          .execute()
      ).rejects.toMatchObject({ cause: { code: '23514' } })
      await expect(
        database
          .update(contextPackages)
          .set(malformed)
          .where(eq(contextPackages.contextPackageId, legacyContext.contextPackageId))
          .execute()
      ).rejects.toMatchObject({ cause: { code: '23514' } })
    }
    const [plan] = await database
      .select()
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, legacyPlan.executionPlanId))
    const [context] = await database
      .select()
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, legacyContext.contextPackageId))
    expect(plan.schemaVersion).toBe(1)
    expect(plan.executionScope).toBeNull()
    expect(context.schemaVersion).toBe(1)
    expect(context.executionScope).toBeNull()
  })
})
