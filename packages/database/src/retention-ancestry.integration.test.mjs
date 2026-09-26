import { describe, expect, test } from 'bun:test'
import process from 'node:process'
import { deriveContextPackage, contextPackageSerializationFixtures } from '@control-plane/context'
import { deriveExecutionPlan, ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  PostgresContextPackageRepository,
  PostgresContextPackageRetention,
} from './context-package-repository.js'
import {
  PostgresExecutionPlanRepository,
  PostgresExecutionPlanRetention,
} from './execution-plan-repository.js'
import { createIsolatedTestDatabase } from './testing.ts'
import { contextPackages } from './schema/context-packages.js'
import { executionPlans } from './schema/execution-plans.js'
import { eq, sql } from 'drizzle-orm'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const retentionMs = 90 * 24 * 60 * 60 * 1_000
const credentials = {
  administration: { role: 'administration', url: process.env.DATABASE_ADMIN_URL },
  migration: { role: 'migration', url: process.env.DATABASE_MIGRATION_URL },
  application: { role: 'application', url: process.env.DATABASE_URL },
}

async function withDatabase(run) {
  const isolated = await createIsolatedTestDatabase(credentials)
  try {
    await isolated.migrate()
    await run(isolated.application)
  } finally {
    await isolated.dispose()
  }
}

function planAt(compiledAt) {
  return new ExecutionPlanCompiler('1.0.0').compile({
    ...createExecutionPlanTestFixtureInputs(),
    compiledAt,
  })
}

function childPlanAt(parent, compiledAt) {
  return deriveExecutionPlan(parent, {
    correlation: parent.correlation,
    contextPackage: contextPackageSerializationFixtures.futurePi,
    constraints: parent.constraints,
    runtimeRequirements: parent.runtimeRequirements,
    outputContract: parent.outputContract,
    compiledAt,
  })
}

function childPackageAt(parent, compiledAt, objective = 'retention ancestry child') {
  return deriveContextPackage(parent, {
    objective,
    allowedStateItemIds: [],
    allowedArtifactIds: [],
    budgets: parent.budgets,
    successCriteria: parent.successCriteria,
    returnContract: parent.returnContract,
    compiledAt,
  })
}

function planReference(plan) {
  return { executionPlanId: plan.executionPlanId, contentDigest: plan.contentDigest }
}

function packageReference(package_) {
  return { contextPackageId: package_.contextPackageId, contentDigest: package_.contentDigest }
}

async function waitForLockWait(database, tableName) {
  let waiting = []
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const rows = await database.execute(
      sql`select query, wait_event from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
    )
    if (rows.some((row) => row.query.includes(tableName))) return
    waiting = rows
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`EXPECTED_POSTGRES_LOCK_WAIT:${tableName}:${JSON.stringify(waiting)}`)
}

describe.skipIf(!enabled)('PostgreSQL ancestry retention', () => {
  test('retains a parent plan until its child is swept, then releases the ancestor', async () => {
    await withDatabase(async (database) => {
      const package_ = contextPackageSerializationFixtures.futurePi
      await new PostgresContextPackageRepository(database).put(package_)
      const parent = planAt('2024-01-01T00:00:00.000Z')
      const child = childPlanAt(parent, '2024-02-01T00:00:00.000Z')
      const plans = new PostgresExecutionPlanRepository(database)
      await plans.put(parent)
      await plans.put(child)

      const now = new Date(Date.parse(child.compiledAt) + retentionMs + 60_000)
      const retention = new PostgresExecutionPlanRetention(database)
      const first = await retention.deleteEligibleExecutionPlans(now, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(first.deleted).toBe(1)
      expect(first.retainedByReason).toEqual({ reference_pending: 1 })
      expect(await plans.get(planReference(parent))).toBeDefined()
      expect(await plans.get(planReference(child))).toBeUndefined()

      const second = await retention.deleteEligibleExecutionPlans(now, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(second.deleted).toBe(1)
      expect(await plans.get(planReference(parent))).toBeUndefined()
    })
  }, 30_000)

  test('retains a parent context package until its child is swept, then releases the ancestor', async () => {
    await withDatabase(async (database) => {
      const parent = contextPackageSerializationFixtures.futurePi
      const child = childPackageAt(parent, '2026-09-22T12:00:00.000Z')
      const packages = new PostgresContextPackageRepository(database)
      await packages.put(parent)
      await packages.put(child)

      const now = new Date(Date.parse(child.compiledAt) + retentionMs + 60_000)
      const retention = new PostgresContextPackageRetention(database)
      const first = await retention.deleteEligibleContextPackages(now, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(first.deleted).toBe(1)
      expect(first.retainedByReason).toEqual({ reference_pending: 1 })
      expect(await packages.get(packageReference(parent))).toBeDefined()
      expect(await packages.get(packageReference(child))).toBeUndefined()

      const second = await retention.deleteEligibleContextPackages(now, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(second.deleted).toBe(1)
      expect(await packages.get(packageReference(parent))).toBeUndefined()
    })
  }, 30_000)

  test('new child puts require exact parents while identical replay survives parent cleanup', async () => {
    await withDatabase(async (database) => {
      const package_ = contextPackageSerializationFixtures.futurePi
      const packages = new PostgresContextPackageRepository(database)
      await packages.put(package_)
      const parentPlan = planAt('2024-01-01T00:00:00.000Z')
      const childPlan = childPlanAt(parentPlan, '2024-02-01T00:00:00.000Z')
      const wrongParentPlan = planAt('2024-03-01T00:00:00.000Z')
      const plans = new PostgresExecutionPlanRepository(database)

      await expect(plans.put(childPlan)).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })
      await plans.put(parentPlan)
      const childReference = await plans.put(childPlan)
      await database
        .delete(executionPlans)
        .where(eq(executionPlans.executionPlanId, parentPlan.executionPlanId))
      expect(await plans.put(childPlan)).toEqual(childReference)

      await database.insert(executionPlans).values({
        executionPlanId: parentPlan.executionPlanId,
        contentDigest: wrongParentPlan.contentDigest,
        schemaVersion: wrongParentPlan.schemaVersion,
        workspaceId: wrongParentPlan.correlation.workspaceId,
        projectId: wrongParentPlan.correlation.projectId,
        taskId: wrongParentPlan.correlation.taskId,
        agentId: wrongParentPlan.correlation.agentId,
        plan: wrongParentPlan,
        compiledAt: new Date(wrongParentPlan.compiledAt),
      })
      await expect(
        plans.put(childPlanAt(parentPlan, '2024-02-02T00:00:00.000Z'))
      ).rejects.toMatchObject({
        code: 'INVALID_REFERENCE',
      })

      const packageParent = package_
      const childPackage = childPackageAt(packageParent, '2026-08-22T12:00:00.000Z')
      const wrongParentPackage = childPackageAt(
        packageParent,
        '2026-08-23T12:00:00.000Z',
        'wrong stored ancestor fixture'
      )
      await database
        .delete(contextPackages)
        .where(eq(contextPackages.contextPackageId, packageParent.contextPackageId))
      await expect(packages.put(childPackage)).rejects.toMatchObject({
        code: 'CONTRADICTORY_CONTEXT_REFERENCE',
      })
      await packages.put(packageParent)
      const childPackageReference = await packages.put(childPackage)
      await database
        .delete(contextPackages)
        .where(eq(contextPackages.contextPackageId, packageParent.contextPackageId))
      expect(await packages.put(childPackage)).toEqual(childPackageReference)

      await database.insert(contextPackages).values({
        contextPackageId: packageParent.contextPackageId,
        contentDigest: wrongParentPackage.contentDigest,
        schemaVersion: wrongParentPackage.schemaVersion,
        workspaceId: wrongParentPackage.projectState.workspaceId,
        projectId: wrongParentPackage.projectState.projectId,
        contextPackage: wrongParentPackage,
        compiledAt: new Date(wrongParentPackage.compiledAt),
      })
      await expect(
        packages.put(childPackageAt(packageParent, '2026-08-24T12:00:00.000Z'))
      ).rejects.toThrow('CONTEXT_PACKAGE_PERSISTENCE_INTEGRITY_ERROR')
    })
  }, 30_000)

  test('plan deletion claim blocks a racing child-plan insertion', async () => {
    await withDatabase(async (database) => {
      const package_ = contextPackageSerializationFixtures.futurePi
      await new PostgresContextPackageRepository(database).put(package_)
      const parent = planAt('2024-01-01T00:00:00.000Z')
      const child = childPlanAt(parent, '2024-02-01T00:00:00.000Z')
      const plans = new PostgresExecutionPlanRepository(database)
      await plans.put(parent)
      const now = new Date(Date.parse(parent.compiledAt) + retentionMs + 60_000)
      let competingPut
      const result = await new PostgresExecutionPlanRetention(
        database
      ).deleteEligibleExecutionPlans(now, {
        policyRetainMs: retentionMs,
        dryRun: false,
        journal: async () => {
          competingPut = plans.put(child)
          await waitForLockWait(database, 'execution_plans')
        },
      })
      expect(result.deleted).toBe(1)
      await expect(competingPut).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })
      expect(await plans.get(planReference(child))).toBeUndefined()
    })
  }, 30_000)

  test('context deletion claim blocks a racing child-package insertion', async () => {
    await withDatabase(async (database) => {
      const parent = contextPackageSerializationFixtures.futurePi
      const child = childPackageAt(parent, '2026-08-22T12:00:00.000Z')
      const packages = new PostgresContextPackageRepository(database)
      await packages.put(parent)
      const now = new Date(Date.parse(parent.compiledAt) + retentionMs + 60_000)
      let competingPut
      const result = await new PostgresContextPackageRetention(
        database
      ).deleteEligibleContextPackages(now, {
        policyRetainMs: retentionMs,
        dryRun: false,
        journal: async () => {
          competingPut = packages.put(child)
          await waitForLockWait(database, 'context_packages')
        },
      })
      expect(result.deleted).toBe(1)
      await expect(competingPut).rejects.toMatchObject({
        code: 'CONTRADICTORY_CONTEXT_REFERENCE',
      })
      expect(await packages.get(packageReference(child))).toBeUndefined()
    })
  }, 30_000)
})
