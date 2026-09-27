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
      const parentObservedAt = new Date(Date.parse(parent.compiledAt) + retentionMs + 60_000)
      await new PostgresExecutionPlanRetention(database).deleteEligibleExecutionPlans(
        parentObservedAt,
        { policyRetainMs: retentionMs, dryRun: false }
      )
      const [parentClockBeforeChild] = await database
        .select({ clock: executionPlans.unreferencedSince })
        .from(executionPlans)
        .where(eq(executionPlans.executionPlanId, parent.executionPlanId))
        .limit(1)
      expect(parentClockBeforeChild?.clock?.toISOString()).toBe(parentObservedAt.toISOString())
      await plans.put(child)
      const [parentClockAfterChild] = await database
        .select({ clock: executionPlans.unreferencedSince })
        .from(executionPlans)
        .where(eq(executionPlans.executionPlanId, parent.executionPlanId))
        .limit(1)
      expect(parentClockAfterChild?.clock).toBeNull()

      const observedAt = new Date(Date.parse(child.compiledAt) + retentionMs + 60_000)
      const retention = new PostgresExecutionPlanRetention(database)
      const first = await retention.deleteEligibleExecutionPlans(observedAt, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(first.deleted).toBe(0)
      expect(first.retainedByReason).toEqual({ reference_pending: 1, not_expired: 1 })
      expect(await plans.get(planReference(parent))).toBeDefined()
      expect(await plans.get(planReference(child))).toBeDefined()

      const firstExpiry = new Date(observedAt.getTime() + retentionMs + 1)
      const second = await retention.deleteEligibleExecutionPlans(firstExpiry, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(second.deleted).toBe(1)
      expect(second.retainedByReason).toEqual({ reference_pending: 1 })
      expect(await plans.get(planReference(child))).toBeUndefined()

      const ancestorObserved = await retention.deleteEligibleExecutionPlans(firstExpiry, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(ancestorObserved.deleted).toBe(0)
      expect(ancestorObserved.retainedByReason).toEqual({ not_expired: 1 })
      const parentExpiry = new Date(firstExpiry.getTime() + retentionMs + 1)
      const third = await retention.deleteEligibleExecutionPlans(parentExpiry, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(third.deleted).toBe(1)
      expect(await plans.get(planReference(parent))).toBeUndefined()
    })
  }, 30_000)

  test('retains a parent context package until its child is swept, then releases the ancestor', async () => {
    await withDatabase(async (database) => {
      const parent = contextPackageSerializationFixtures.futurePi
      const child = childPackageAt(parent, '2026-09-22T12:00:00.000Z')
      const packages = new PostgresContextPackageRepository(database)
      await packages.put(parent)
      const parentObservedAt = new Date(Date.parse(parent.compiledAt) + retentionMs + 60_000)
      await new PostgresContextPackageRetention(database).deleteEligibleContextPackages(
        parentObservedAt,
        { policyRetainMs: retentionMs, dryRun: false }
      )
      const [parentClockBeforeChild] = await database
        .select({ clock: contextPackages.unreferencedSince })
        .from(contextPackages)
        .where(eq(contextPackages.contextPackageId, parent.contextPackageId))
        .limit(1)
      expect(parentClockBeforeChild?.clock?.toISOString()).toBe(parentObservedAt.toISOString())
      await packages.put(child)
      const [parentClockAfterChild] = await database
        .select({ clock: contextPackages.unreferencedSince })
        .from(contextPackages)
        .where(eq(contextPackages.contextPackageId, parent.contextPackageId))
        .limit(1)
      expect(parentClockAfterChild?.clock).toBeNull()

      const observedAt = new Date(Date.parse(child.compiledAt) + retentionMs + 60_000)
      const retention = new PostgresContextPackageRetention(database)
      const first = await retention.deleteEligibleContextPackages(observedAt, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(first.deleted).toBe(0)
      expect(first.retainedByReason).toEqual({ reference_pending: 1, not_expired: 1 })
      expect(await packages.get(packageReference(parent))).toBeDefined()
      expect(await packages.get(packageReference(child))).toBeDefined()

      const firstExpiry = new Date(observedAt.getTime() + retentionMs + 1)
      const second = await retention.deleteEligibleContextPackages(firstExpiry, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(second.deleted).toBe(1)
      expect(second.retainedByReason).toEqual({ reference_pending: 1 })
      expect(await packages.get(packageReference(child))).toBeUndefined()

      const ancestorObserved = await retention.deleteEligibleContextPackages(firstExpiry, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(ancestorObserved.deleted).toBe(0)
      expect(ancestorObserved.retainedByReason).toEqual({ not_expired: 1 })
      const parentExpiry = new Date(firstExpiry.getTime() + retentionMs + 1)
      const third = await retention.deleteEligibleContextPackages(parentExpiry, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(third.deleted).toBe(1)
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
      const observedAt = new Date(Date.parse(parent.compiledAt) + retentionMs + 60_000)
      const retention = new PostgresExecutionPlanRetention(database)
      const observed = await retention.deleteEligibleExecutionPlans(observedAt, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(observed.deleted).toBe(0)
      expect(observed.retainedByReason).toEqual({ not_expired: 1 })
      let competingPut
      const result = await retention.deleteEligibleExecutionPlans(
        new Date(observedAt.getTime() + retentionMs + 1),
        {
          policyRetainMs: retentionMs,
          dryRun: false,
          journal: async () => {
            competingPut = plans.put(child)
            await waitForLockWait(database, 'execution_plans')
          },
        }
      )
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
      const observedAt = new Date(Date.parse(parent.compiledAt) + retentionMs + 60_000)
      const retention = new PostgresContextPackageRetention(database)
      const observed = await retention.deleteEligibleContextPackages(observedAt, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      expect(observed.deleted).toBe(0)
      expect(observed.retainedByReason).toEqual({ not_expired: 1 })
      let competingPut
      const result = await retention.deleteEligibleContextPackages(
        new Date(observedAt.getTime() + retentionMs + 1),
        {
          policyRetainMs: retentionMs,
          dryRun: false,
          journal: async () => {
            competingPut = packages.put(child)
            await waitForLockWait(database, 'context_packages')
          },
        }
      )
      expect(result.deleted).toBe(1)
      await expect(competingPut).rejects.toMatchObject({
        code: 'CONTRADICTORY_CONTEXT_REFERENCE',
      })
      expect(await packages.get(packageReference(child))).toBeUndefined()
    })
  }, 30_000)
})
