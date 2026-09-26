import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  REFERENCE_RETENTION_NAMESPACES,
  SqliteContextAuthoringCommandRepository,
  SqliteContextPackageRepository,
  SqlitePersistenceProvider,
} from './index.js'
import { SqliteExecutionPlanRepository } from './index.js'

const ninetyDaysMs = 90 * 24 * 60 * 60 * 1_000
// The package digest covers compiledAt, so the clock is derived from the
// fixture rather than the fixture from the clock.
const fixtureCompiledAt = contextPackageSerializationFixtures.futurePi.compiledAt
const referenceObservedAt = new Date(Date.parse(fixtureCompiledAt) + ninetyDaysMs + 60_000)
const retentionDeadline = new Date(referenceObservedAt.getTime() + ninetyDaysMs)
const afterRetentionDeadline = new Date(retentionDeadline.getTime() + 1)
const cursorScanAt = new Date('2026-08-27T00:00:00.000Z')

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

      await packages.deleteEligibleContextPackages(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      const now = afterRetentionDeadline
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
      expect(second.deleted).toBe(0)
      expect(second.retainedByReason).toEqual({ not_expired: 1 })
      const final = await packages.deleteEligibleContextPackages(
        new Date(now.getTime() + ninetyDaysMs + 1),
        { policyRetainMs: ninetyDaysMs, dryRun: false }
      )
      expect(final.deleted).toBe(1)
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

  test('new context-authoring writes validate ancestry while accepted replay stays historical', async () => {
    await withProvider(async (provider) => {
      const parent = packageFixture()
      const child = childPackageAt(parent, '2026-08-22T12:00:00.000Z')
      const commands = new SqliteContextAuthoringCommandRepository(provider)
      const record = {
        scope: {
          principalRef: 'service:retention-test',
          workspaceId: parent.projectState.workspaceId,
          projectId: parent.projectState.projectId,
          operation: 'context.author',
          idempotencyKey: 'context-authoring-parent-0001',
        },
        payloadHash: `sha256:${'a'.repeat(64)}`,
        contextPackage: {
          contextPackageId: child.contextPackageId,
          contentDigest: child.contentDigest,
        },
      }

      await expect(commands.commit(record, child)).rejects.toMatchObject({
        code: 'CONTRADICTORY_CONTEXT_REFERENCE',
      })
      await provider.transaction(async (transaction) => {
        expect(await transaction.list('context-packages')).toEqual([])
        expect(await transaction.list('context-authoring-commands')).toEqual([])
      })

      await new SqliteContextPackageRepository(provider).put(parent)
      expect(await commands.commit(record, child)).toEqual(record)
      await provider.transaction((transaction) =>
        transaction.delete('context-packages', storedId(parent.contextPackageId))
      )
      expect(await commands.commit(record, child)).toEqual(record)
    })
  })

  test('new package references clear old clocks and restart after a short reference cycle', async () => {
    await withProvider(async (provider) => {
      const packages = new SqliteContextPackageRepository(provider)
      const contextPackage = packageFixture()
      await packages.put(contextPackage)
      const observation = referenceObservedAt
      await packages.deleteEligibleContextPackages(observation, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      const targetId = storedId(contextPackage.contextPackageId)
      const metadataNamespace = REFERENCE_RETENTION_NAMESPACES.contextPackages
      expect(
        await provider.transaction((transaction) => transaction.get(metadataNamespace, targetId))
      ).toEqual(
        expect.objectContaining({
          namespace: metadataNamespace,
          id: targetId,
          value: { unreferencedSince: observation.toISOString() },
        })
      )

      const plan = createExecutionPlanTestFixture({ contextPackage })
      const plans = new SqliteExecutionPlanRepository(provider)
      await plans.put(plan)
      expect(
        await provider.transaction((transaction) => transaction.get(metadataNamespace, targetId))
      ).toBeUndefined()
      await provider.transaction((transaction) =>
        transaction.delete('execution-plans', storedId(plan.executionPlanId))
      )

      const restartedWindow = await packages.deleteEligibleContextPackages(afterRetentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(restartedWindow.deleted).toBe(0)
      expect(restartedWindow.retainedByReason).toEqual({ not_expired: 1 })
      expect(
        await provider.transaction((transaction) => transaction.get(metadataNamespace, targetId))
      ).toEqual(
        expect.objectContaining({
          value: { unreferencedSince: afterRetentionDeadline.toISOString() },
        })
      )
    })
  })

  test('authoring a new command clears an existing package clock but replay does not revalidate history', async () => {
    await withProvider(async (provider) => {
      const packages = new SqliteContextPackageRepository(provider)
      const package_ = packageFixture()
      await packages.put(package_)
      await packages.deleteEligibleContextPackages(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      const targetId = storedId(package_.contextPackageId)
      const namespace = REFERENCE_RETENTION_NAMESPACES.contextPackages
      expect(
        await provider.transaction((transaction) => transaction.get(namespace, targetId))
      ).toBeDefined()
      const record = {
        scope: {
          principalRef: 'service:retention-test',
          workspaceId: package_.projectState.workspaceId,
          projectId: package_.projectState.projectId,
          operation: 'context.author',
          idempotencyKey: 'context-authoring-clock-0001',
        },
        payloadHash: `sha256:${'b'.repeat(64)}`,
        contextPackage: {
          contextPackageId: package_.contextPackageId,
          contentDigest: package_.contentDigest,
        },
      }
      const commands = new SqliteContextAuthoringCommandRepository(provider)
      expect(await commands.commit(record, package_)).toEqual(record)
      expect(
        await provider.transaction((transaction) => transaction.get(namespace, targetId))
      ).toBeUndefined()
      expect(await commands.commit(record, package_)).toEqual(record)

      await provider.transaction(async (transaction) => {
        const [stored] = await transaction.list('context-authoring-commands')
        expect(stored).toBeDefined()
        await transaction.delete('context-authoring-commands', stored.id, stored.revision)
      })
      const observedAgain = await packages.deleteEligibleContextPackages(afterRetentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(observedAgain.deleted).toBe(0)
      expect(observedAgain.retainedByReason).toEqual({ not_expired: 1 })
    })
  })

  test('package continuation visits young targets in key order and dry-run/bound-zero do not write clocks', async () => {
    await withProvider(async (provider) => {
      const packages = new SqliteContextPackageRepository(provider)
      const parent = packageFixture()
      await packages.put(parent)
      await packages.put(childPackageAt(parent, '2026-08-24T12:00:00.000Z', 'cursor child one'))
      await packages.put(childPackageAt(parent, '2026-08-25T12:00:00.000Z', 'cursor child two'))
      const ids = await provider.transaction(async (transaction) =>
        (await transaction.scan('context-packages', { limit: 128 })).map((record) => record.id)
      )
      const namespace = REFERENCE_RETENTION_NAMESPACES.contextPackages

      const zero = await packages.deleteEligibleContextPackages(cursorScanAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
        bound: 0,
      })
      expect(zero.scanned).toBe(0)
      expect(zero.truncated).toBe(true)
      expect(await provider.transaction((transaction) => transaction.list(namespace))).toEqual([])

      const dry = await packages.deleteEligibleContextPackages(cursorScanAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: true,
        bound: 1,
      })
      expect(dry.nextAfterId).toBe(ids[0])
      expect(dry.scanned).toBe(1)
      expect(dry.truncated).toBe(true)
      expect(await provider.transaction((transaction) => transaction.list(namespace))).toEqual([])

      const first = await packages.deleteEligibleContextPackages(cursorScanAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
        bound: 1,
      })
      expect(first.nextAfterId).toBe(ids[0])
      const second = await packages.deleteEligibleContextPackages(cursorScanAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
        bound: 1,
        afterId: first.nextAfterId,
      })
      expect(second.nextAfterId).toBe(ids[1])
      const final = await packages.deleteEligibleContextPackages(cursorScanAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
        bound: 1,
        afterId: second.nextAfterId,
      })
      expect(final.scanned).toBe(1)
      expect(final.truncated).toBe(false)
      expect(final.nextAfterId).toBeUndefined()
    })
  })

  test('failed first-observation writes roll back the metadata clock', async () => {
    await withProvider(async (provider) => {
      const package_ = packageFixture()
      await new SqliteContextPackageRepository(provider).put(package_)
      const namespace = REFERENCE_RETENTION_NAMESPACES.contextPackages
      const failingProvider = {
        transaction(operation) {
          return provider.transaction((transaction) =>
            operation({
              get: transaction.get.bind(transaction),
              list: transaction.list.bind(transaction),
              scan: transaction.scan.bind(transaction),
              delete: transaction.delete.bind(transaction),
              put(write) {
                if (write.namespace === namespace) throw new Error('INJECTED_WINDOW_WRITE_FAILURE')
                return transaction.put(write)
              },
            })
          )
        },
      }
      await expect(
        new SqliteContextPackageRepository(failingProvider).deleteEligibleContextPackages(
          referenceObservedAt,
          { policyRetainMs: ninetyDaysMs, dryRun: false }
        )
      ).rejects.toThrow('INJECTED_WINDOW_WRITE_FAILURE')
      expect(
        await provider.transaction((transaction) =>
          transaction.get(namespace, storedId(package_.contextPackageId))
        )
      ).toBeUndefined()
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

      await packages.deleteEligibleContextPackages(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      const deletion = await packages.deleteEligibleContextPackages(afterRetentionDeadline, {
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

  test('a package receives a full window from the first unreferenced observation', async () => {
    await withProvider(async (provider) => {
      const packages = new SqliteContextPackageRepository(provider)
      const package_ = packageFixture()
      await packages.put(package_)

      const dry = await packages.deleteEligibleContextPackages(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: true,
      })
      expect(dry.eligible).toBe(0)
      expect(dry.retainedByReason).toEqual({ not_expired: 1 })
      expect(dry.deleted).toBe(0)
      expect(await packages.get(package_)).toBeDefined()

      const applied = await packages.deleteEligibleContextPackages(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(applied.deleted).toBe(0)
      expect(applied.retainedByReason).toEqual({ not_expired: 1 })
      const expired = await packages.deleteEligibleContextPackages(afterRetentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(expired.deleted).toBe(1)
      expect(await packages.get(package_)).toBeUndefined()
      const metadataNamespace = REFERENCE_RETENTION_NAMESPACES.contextPackages
      const targetId = storedId(package_.contextPackageId)
      expect(
        await provider.transaction((transaction) => transaction.get(metadataNamespace, targetId))
      ).toBeUndefined()
      await packages.put(package_)
      expect(
        await provider.transaction((transaction) => transaction.get(metadataNamespace, targetId))
      ).toBeUndefined()
    })
  })

  test('the reference window respects before, exact, and after-boundary instants', async () => {
    await withProvider(async (provider) => {
      const packages = new SqliteContextPackageRepository(provider)
      const package_ = packageFixture()
      await packages.put(package_)

      const observed = await packages.deleteEligibleContextPackages(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(observed.retainedByReason).toEqual({ not_expired: 1 })

      const insideWindow = new Date(retentionDeadline.getTime() - 1)
      const early = await packages.deleteEligibleContextPackages(insideWindow, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(early.deleted).toBe(0)
      expect(early.retainedByReason).toEqual({ not_expired: 1 })

      const atDeadline = retentionDeadline
      const boundary = await packages.deleteEligibleContextPackages(atDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(boundary.deleted).toBe(0)
      expect(boundary.retainedByReason).toEqual({ not_expired: 1 })

      const past = await packages.deleteEligibleContextPackages(afterRetentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
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
      expect(freed.deleted).toBe(0)
      expect(freed.retainedByReason).toEqual({ not_expired: 1 })
      const expired = await packages.deleteEligibleContextPackages(
        new Date(retentionDeadline.getTime() + ninetyDaysMs + 1),
        { policyRetainMs: ninetyDaysMs, dryRun: false }
      )
      expect(expired.deleted).toBe(1)
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
