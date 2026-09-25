import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { SqliteContextPackageRepository, SqlitePersistenceProvider } from './index.js'

const ninetyDaysMs = 90 * 24 * 60 * 60 * 1_000
// The package digest covers compiledAt, so the clock is derived from the
// fixture rather than the fixture from the clock.
const compiledAt = contextPackageSerializationFixtures.futurePi.compiledAt
const now = new Date(Date.parse(compiledAt) + ninetyDaysMs + 60_000)

function packageFixture() {
  return contextPackageSerializationFixtures.futurePi
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
  test('an unreferenced package past its window is deleted', async () => {
    await withProvider(async (provider) => {
      const packages = new SqliteContextPackageRepository(provider)
      const package_ = packageFixture()
      await packages.put(package_)

      const dry = await packages.deleteEligibleContextPackages(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: true,
      })
      expect(dry.eligible).toBe(1)
      expect(dry.deleted).toBe(0)
      expect(await packages.get(package_)).toBeDefined()

      const applied = await packages.deleteEligibleContextPackages(now, {
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

      const insideWindow = new Date(Date.parse(compiledAt) + ninetyDaysMs - 1_000)
      const early = await packages.deleteEligibleContextPackages(insideWindow, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(early.deleted).toBe(0)
      expect(early.retainedByReason).toEqual({ not_expired: 1 })

      const atDeadline = new Date(Date.parse(compiledAt) + ninetyDaysMs)
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
      const withPlan = await packages.deleteEligibleContextPackages(now, {
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
      const withCommand = await packages.deleteEligibleContextPackages(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(withCommand.deleted).toBe(0)
      expect(withCommand.retainedByReason).toEqual({ reference_pending: 1 })

      // References gone: the package becomes eligible.
      await provider.transaction((transaction) =>
        transaction.delete('context-authoring-commands', 'r-authoring-fixture')
      )
      const freed = await packages.deleteEligibleContextPackages(now, {
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

      const unbounded = await packages.deleteEligibleContextPackages(now, {
        policyRetainMs: null,
        dryRun: false,
      })
      expect(unbounded.deleted).toBe(0)
      expect(unbounded.retainedByReason).toEqual({ unbounded_class: 1 })
      expect(await packages.get(package_)).toBeDefined()
    })
  })
})
