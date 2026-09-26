import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { SqliteContextPackageRepository, SqlitePersistenceProvider } from './index.js'
import { SqliteExecutionPlanRepository } from './index.js'

const ninetyDaysMs = 90 * 24 * 60 * 60 * 1_000
// The package digest covers compiledAt, so the clock is derived from the
// fixture rather than the fixture from the clock.
const fixtureCompiledAt = contextPackageSerializationFixtures.futurePi.compiledAt
const retentionDeadline = new Date(Date.parse(fixtureCompiledAt) + ninetyDaysMs + 60_000)

function packageFixture() {
  return contextPackageSerializationFixtures.futurePi
}

function storedId(value) {
  return `r-${createHash('sha256').update(value).digest('hex')}`
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

function childPackageAfterParentKey(parent) {
  for (let day = 1; day <= 366; day += 1) {
    const compiledAt = new Date(Date.parse(parent.compiledAt) + day * 86_400_000).toISOString()
    const child = childPackageAt(parent, compiledAt)
    if (storedId(parent.contextPackageId) < storedId(child.contextPackageId)) return child
  }
  throw new Error('UNABLE_TO_ORDER_CHILD_PACKAGE_AFTER_PARENT')
}

async function withProvider(run) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-package-retention-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    return await run(provider, directory)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('SQLite context-package retention deletion (#194)', () => {
  test('a child package pins its parent through deletion and then the ancestor becomes eligible', async () => {
    await withProvider(async (provider) => {
      const parent = packageFixture()
      const child = childPackageAfterParentKey(parent)
      const packages = new SqliteContextPackageRepository(provider)
      await packages.put(parent)
      await packages.put(child)

      const now = new Date(Date.parse(child.compiledAt) + ninetyDaysMs + 60_000)
      const first = await packages.deleteEligibleContextPackages(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(first.deleted).toBe(1)
      expect(first.retainedByReason).toEqual({ reference_pending: 1 })
      expect(await packages.get(parent)).toBeDefined()
      expect(await packages.get(child)).toBeUndefined()

      const second = await packages.deleteEligibleContextPackages(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(second.deleted).toBe(1)
      expect(await packages.get(parent)).toBeUndefined()
    })
  })

  test('new child packages require the exact parent but identical replay survives parent cleanup', async () => {
    await withProvider(async (provider) => {
      const parent = packageFixture()
      const child = childPackageAt(parent, '2026-08-22T12:00:00.000Z')
      const wrongParent = childPackageAt(
        parent,
        '2026-08-23T12:00:00.000Z',
        'wrong stored ancestor fixture'
      )
      const packages = new SqliteContextPackageRepository(provider)

      await expect(packages.put(child)).rejects.toMatchObject({
        code: 'CONTRADICTORY_CONTEXT_REFERENCE',
      })
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'context-packages',
          id: storedId(parent.contextPackageId),
          value: wrongParent,
        })
      )
      await expect(packages.put(child)).rejects.toMatchObject({
        code: 'CONTRADICTORY_CONTEXT_REFERENCE',
      })
      await provider.transaction((transaction) =>
        transaction.delete('context-packages', storedId(parent.contextPackageId))
      )

      await packages.put(parent)
      const reference = await packages.put(child)
      await provider.transaction((transaction) =>
        transaction.delete('context-packages', storedId(parent.contextPackageId))
      )
      expect(await packages.put(child)).toEqual(reference)
    })
  })

  test('a plan put racing package deletion fails closed when deletion linearizes first', async () => {
    await withProvider(async (provider) => {
      const package_ = packageFixture()
      const packages = new SqliteContextPackageRepository(provider)
      await packages.put(package_)
      const plan = createExecutionPlanTestFixture({ contextPackage: package_ })
      const plans = new SqliteExecutionPlanRepository(provider)
      let competingPut

      const deletion = await packages.deleteEligibleContextPackages(retentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
        journal: async () => {
          // The claim transaction holds SQLite's BEGIN IMMEDIATE writer lock.
          // Start, but do not await, the competing writer here; it resumes only
          // after the claim commits and then must see the missing parent.
          competingPut = plans.put(plan)
        },
      })

      expect(deletion.deleted).toBe(1)
      await expect(competingPut).rejects.toMatchObject({ code: 'MISSING_CONTEXT_PACKAGE' })
      expect(
        await plans.get({
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
        })
      ).toBeUndefined()
    })
  })

  test('an unreferenced package past its window is deleted', async () => {
    await withProvider(async (provider) => {
      const packages = new SqliteContextPackageRepository(provider)
      const package_ = packageFixture()
      await packages.put(package_)

      const dry = await packages.deleteEligibleContextPackages(retentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: true,
      })
      expect(dry.eligible).toBe(1)
      expect(dry.deleted).toBe(0)
      expect(await packages.get(package_)).toBeDefined()

      const applied = await packages.deleteEligibleContextPackages(retentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(applied.deleted).toBe(1)
      expect(await packages.get(package_)).toBeUndefined()
    })
  })

  test('the window is measured from compiledAt', async () => {
    await withProvider(async (provider) => {
      const packages = new SqliteContextPackageRepository(provider)
      const package_ = packageFixture()
      await packages.put(package_)

      const insideWindow = new Date(Date.parse(fixtureCompiledAt) + ninetyDaysMs - 1_000)
      const early = await packages.deleteEligibleContextPackages(insideWindow, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(early.deleted).toBe(0)
      expect(early.retainedByReason).toEqual({ not_expired: 1 })

      const atDeadline = new Date(Date.parse(fixtureCompiledAt) + ninetyDaysMs)
      const boundary = await packages.deleteEligibleContextPackages(atDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(boundary.deleted).toBe(0)
      expect(boundary.retainedByReason).toEqual({ not_expired: 1 })

      const past = await packages.deleteEligibleContextPackages(
        new Date(atDeadline.getTime() + 1),
        { policyRetainMs: ninetyDaysMs, dryRun: false }
      )
      expect(past.deleted).toBe(1)
    })
  })

  test('a plan pin and an authoring command both retain the package', async () => {
    await withProvider(async (provider) => {
      const packages = new SqliteContextPackageRepository(provider)
      const package_ = packageFixture()
      await packages.put(package_)

      // A plan that pins this package.
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'execution-plans',
          id: 'r-plan-fixture',
          value: {
            executionPlanId: 'pln_fixture',
            contextPackage: { contextPackageId: package_.contextPackageId },
          },
        })
      )
      const withPlan = await packages.deleteEligibleContextPackages(retentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(withPlan.deleted).toBe(0)
      expect(withPlan.retainedByReason).toEqual({ reference_pending: 1 })
      await provider.transaction((transaction) =>
        transaction.delete('execution-plans', 'r-plan-fixture')
      )

      // An authoring command that produced this package.
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'context-authoring-commands',
          id: 'r-authoring-fixture',
          value: {
            contextPackageId: package_.contextPackageId,
            scopeKey: 'fixture',
            state: 'completed',
          },
        })
      )
      const withCommand = await packages.deleteEligibleContextPackages(retentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(withCommand.deleted).toBe(0)
      expect(withCommand.retainedByReason).toEqual({ reference_pending: 1 })

      // References gone: the package becomes eligible.
      await provider.transaction((transaction) =>
        transaction.delete('context-authoring-commands', 'r-authoring-fixture')
      )
      const freed = await packages.deleteEligibleContextPackages(retentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(freed.deleted).toBe(1)
      expect(await packages.get(package_)).toBeUndefined()
    })
  })

  test('an unbounded policy retains packages', async () => {
    await withProvider(async (provider) => {
      const packages = new SqliteContextPackageRepository(provider)
      const package_ = packageFixture()
      await packages.put(package_)

      const unbounded = await packages.deleteEligibleContextPackages(retentionDeadline, {
        policyRetainMs: null,
        dryRun: false,
      })
      expect(unbounded.deleted).toBe(0)
      expect(unbounded.retainedByReason).toEqual({ unbounded_class: 1 })
      expect(await packages.get(package_)).toBeDefined()
    })
  })
})
