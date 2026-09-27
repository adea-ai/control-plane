import { afterEach, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import {
  lockAndResetReferenceRetentionWindows,
  PostgresContextPackageRepository,
  PostgresContextPackageRetention,
} from './context-package-repository.js'
import {
  PostgresExecutionPlanRepository,
  PostgresExecutionPlanRetention,
} from './execution-plan-repository.js'
import { PostgresContextAuthoringCommandRepository } from './context-authoring-command-repository.js'
import { PostgresExecutionValidationCommandRepository } from './validation-command-repository.js'
import { PostgresRetentionReapplication } from './retention-reapplication.js'
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

function planFor(contextPackage, compiledAt = '2024-01-01T00:00:00.000Z') {
  return new ExecutionPlanCompiler('1.0.0').compile({
    ...createExecutionPlanTestFixtureInputs({ contextPackage }),
    compiledAt,
  })
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function withPlanInsertBarrier(database, { onPlanInsert, onRacedPlanRead }) {
  function wrapTransaction(transaction, interceptPlanInsert) {
    let conflictRereadPending = false
    return new Proxy(transaction, {
      get(target, property) {
        if (property === 'transaction') {
          return (operation, ...args) =>
            target.transaction((nested) => operation(wrapTransaction(nested, true)), ...args)
        }
        if (property === 'insert' && interceptPlanInsert) {
          return (table) => {
            const builder = target.insert(table)
            if (table !== executionPlans) return builder
            const wrapBuilder = (builderTarget) => {
              let proxy
              proxy = new Proxy(builderTarget, {
                get(targetBuilder, builderProperty) {
                  if (builderProperty === 'then') {
                    return (resolve, reject) => {
                      Promise.resolve(onPlanInsert())
                        .then(() =>
                          targetBuilder.then((rows) => {
                            if (rows.length === 0) conflictRereadPending = true
                            return resolve(rows)
                          }, reject)
                        )
                        .catch(reject)
                    }
                  }
                  const member = Reflect.get(targetBuilder, builderProperty, targetBuilder)
                  if (typeof member !== 'function') return member
                  return (...values) => {
                    const result = member.apply(targetBuilder, values)
                    return result?.config?.table === table ? wrapBuilder(result) : result
                  }
                },
              })
              return proxy
            }
            return wrapBuilder(builder)
          }
        }
        if (property === 'select' && interceptPlanInsert) {
          return (...values) => wrapSelectBuilder(target.select(...values), false)
        }
        const member = Reflect.get(target, property, target)
        return typeof member === 'function' ? member.bind(target) : member

        function wrapSelectBuilder(builder, isPlanSelect) {
          let proxy
          proxy = new Proxy(builder, {
            get(query, queryProperty) {
              if (queryProperty === 'then') {
                return (resolve, reject) => {
                  const pauseForConflictRead = isPlanSelect && conflictRereadPending
                  if (pauseForConflictRead) conflictRereadPending = false
                  return query.then(async (rows) => {
                    if (pauseForConflictRead) await onRacedPlanRead?.(rows)
                    return resolve(rows)
                  }, reject)
                }
              }
              const method = Reflect.get(query, queryProperty, query)
              if (typeof method !== 'function') return method
              return (...args) => {
                const result = method.apply(query, args)
                const nextIsPlanSelect =
                  isPlanSelect || (queryProperty === 'from' && args[0] === executionPlans)
                return result && typeof result.then === 'function'
                  ? wrapSelectBuilder(result, nextIsPlanSelect)
                  : result
              }
            },
          })
          return proxy
        }
      },
    })
  }

  return new Proxy(database, {
    get(target, property) {
      if (property === 'transaction') {
        return (operation, ...args) =>
          target.transaction(
            (transaction) => operation(wrapTransaction(transaction, false)),
            ...args
          )
      }
      const member = Reflect.get(target, property, target)
      return typeof member === 'function' ? member.bind(target) : member
    },
  })
}

function planRow(plan) {
  return {
    executionPlanId: plan.executionPlanId,
    contentDigest: plan.contentDigest,
    schemaVersion: plan.schemaVersion,
    workspaceId: plan.correlation.workspaceId,
    projectId: plan.correlation.projectId,
    taskId: plan.correlation.taskId,
    agentId: plan.correlation.agentId,
    plan,
    compiledAt: new Date(plan.compiledAt),
  }
}

async function waitForLockWait(database, queryFragment) {
  let waiting = []
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const rows = await database.execute(
      sql`select query, wait_event from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
    )
    if (rows.some((row) => row.query.includes(queryFragment))) return
    waiting = rows
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`EXPECTED_POSTGRES_LOCK_WAIT:${queryFragment}:${JSON.stringify(waiting)}`)
}

describe.skipIf(!enabled)('PostgreSQL reference retention windows', () => {
  const isolatedDatabases = []

  async function createDatabase() {
    const isolated = await createIsolatedTestDatabase(credentials)
    isolatedDatabases.push(isolated)
    await isolated.migrate()
    return isolated.application
  }

  afterEach(async () => {
    const created = isolatedDatabases.splice(0)
    const results = await Promise.allSettled(created.map((isolated) => isolated.dispose()))
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length > 0) {
      throw new AggregateError(errors, 'ISOLATED_TEST_DATABASE_DISPOSAL_FAILED')
    }
  })

  test('starts the full window at the first unreferenced observation, not compiledAt', async () => {
    const database = await createDatabase()
    const package_ = contextPackageSerializationFixtures.futurePi
    await new PostgresContextPackageRepository(database).put(package_)
    const plan = planFor(package_)
    const plans = new PostgresExecutionPlanRepository(database)
    await plans.put(plan)

    const observedAt = new Date('2026-09-26T12:00:00.000Z')
    const retention = new PostgresExecutionPlanRetention(database)
    const first = await retention.deleteEligibleExecutionPlans(observedAt, {
      policyRetainMs: retentionMs,
      dryRun: false,
    })
    expect(first.deleted).toBe(0)
    expect(first.retainedByReason).toEqual({ not_expired: 1 })
    const [observed] = await database
      .select({ unreferencedSince: executionPlans.unreferencedSince })
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, plan.executionPlanId))
      .limit(1)
    expect(observed?.unreferencedSince?.toISOString()).toBe(observedAt.toISOString())

    const exactBoundary = await retention.deleteEligibleExecutionPlans(
      new Date(observedAt.getTime() + retentionMs),
      { policyRetainMs: retentionMs, dryRun: false }
    )
    expect(exactBoundary.deleted).toBe(0)
    expect(exactBoundary.retainedByReason).toEqual({ not_expired: 1 })

    const afterBoundary = await retention.deleteEligibleExecutionPlans(
      new Date(observedAt.getTime() + retentionMs + 1),
      { policyRetainMs: retentionMs, dryRun: false }
    )
    expect(afterBoundary.deleted).toBe(1)
    expect(
      await plans.get({ executionPlanId: plan.executionPlanId, contentDigest: plan.contentDigest })
    ).toBeUndefined()

    const contextRetention = new PostgresContextPackageRetention(database)
    const contextObservedAt = new Date(observedAt.getTime() + retentionMs + 2)
    const contextFirst = await contextRetention.deleteEligibleContextPackages(contextObservedAt, {
      policyRetainMs: retentionMs,
      dryRun: false,
    })
    expect(contextFirst.deleted).toBe(0)
    expect(contextFirst.retainedByReason).toEqual({ not_expired: 1 })
    const [contextObserved] = await database
      .select({ unreferencedSince: contextPackages.unreferencedSince })
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, package_.contextPackageId))
      .limit(1)
    expect(contextObserved?.unreferencedSince?.toISOString()).toBe(contextObservedAt.toISOString())
    expect(
      (
        await contextRetention.deleteEligibleContextPackages(
          new Date(contextObservedAt.getTime() + retentionMs),
          { policyRetainMs: retentionMs, dryRun: false }
        )
      ).deleted
    ).toBe(0)
    expect(
      (
        await contextRetention.deleteEligibleContextPackages(
          new Date(contextObservedAt.getTime() + retentionMs + 1),
          { policyRetainMs: retentionMs, dryRun: false }
        )
      ).deleted
    ).toBe(1)
  }, 30_000)

  test('dry-run and zero-bound scans do not persist clocks; rollback and restart preserve observations', async () => {
    const database = await createDatabase()
    const package_ = contextPackageSerializationFixtures.futurePi
    await new PostgresContextPackageRepository(database).put(package_)
    const retention = new PostgresContextPackageRetention(database)
    const observedAt = new Date('2026-12-22T00:00:00.000Z')

    const dryRun = await retention.deleteEligibleContextPackages(observedAt, {
      policyRetainMs: retentionMs,
      dryRun: true,
    })
    expect(dryRun.retainedByReason).toEqual({ not_expired: 1 })
    const zeroBound = await retention.deleteEligibleContextPackages(observedAt, {
      policyRetainMs: retentionMs,
      bound: 0,
      dryRun: false,
    })
    expect(zeroBound).toMatchObject({ scanned: 0, truncated: true, deleted: 0 })
    expect(zeroBound.nextAfterId).toBeUndefined()
    const [unobserved] = await database
      .select({ unreferencedSince: contextPackages.unreferencedSince })
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, package_.contextPackageId))
      .limit(1)
    expect(unobserved?.unreferencedSince).toBeNull()

    await retention.deleteEligibleContextPackages(observedAt, {
      policyRetainMs: retentionMs,
      dryRun: false,
    })
    const rolledBack = await new PostgresContextPackageRetention(
      database
    ).deleteEligibleContextPackages(new Date(observedAt.getTime() - 24 * 60 * 60 * 1_000), {
      policyRetainMs: retentionMs,
      dryRun: false,
    })
    expect(rolledBack.retainedByReason).toEqual({ not_expired: 1 })
    const [persisted] = await database
      .select({ unreferencedSince: contextPackages.unreferencedSince })
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, package_.contextPackageId))
      .limit(1)
    expect(persisted?.unreferencedSince?.toISOString()).toBe(observedAt.toISOString())

    await new PostgresRetentionReapplication(database).resetReferenceRetentionWindows()
    const [restored] = await database
      .select({ unreferencedSince: contextPackages.unreferencedSince })
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, package_.contextPackageId))
      .limit(1)
    expect(restored?.unreferencedSince).toBeNull()
  }, 30_000)

  test('cursor pages start at ID order and reach later unreferenced targets after a pinned first row', async () => {
    const database = await createDatabase()
    const packages = new PostgresContextPackageRepository(database)
    const fixtures = [
      contextPackageSerializationFixtures.futurePi,
      contextPackageSerializationFixtures.futureAcp,
      contextPackageSerializationFixtures.futureLangGraph,
    ]
    for (const package_ of fixtures) await packages.put(package_)
    const ordered = await database
      .select({ contextPackageId: contextPackages.contextPackageId })
      .from(contextPackages)
      .orderBy(contextPackages.contextPackageId)
    expect(ordered).toHaveLength(3)
    const firstPackage = await packages.getById(ordered[0].contextPackageId)
    expect(firstPackage).toBeDefined()
    const plan = planFor(firstPackage)
    await new PostgresExecutionPlanRepository(database).put(plan)

    const retention = new PostgresContextPackageRetention(database)
    const observedAt = new Date('2026-12-22T00:00:00.000Z')
    const first = await retention.deleteEligibleContextPackages(observedAt, {
      policyRetainMs: retentionMs,
      bound: 1,
      dryRun: false,
    })
    expect(first).toMatchObject({
      scanned: 1,
      truncated: true,
      nextAfterId: ordered[0].contextPackageId,
    })
    expect(first.retainedByReason).toEqual({ reference_pending: 1 })

    const second = await retention.deleteEligibleContextPackages(observedAt, {
      policyRetainMs: retentionMs,
      bound: 1,
      dryRun: false,
      afterId: first.nextAfterId,
    })
    expect(second.scanned).toBe(1)
    expect(second.truncated).toBe(true)
    expect(second.nextAfterId).toBe(ordered[1].contextPackageId)
    expect(second.retainedByReason).toEqual({ not_expired: 1 })

    const finalPage = await retention.deleteEligibleContextPackages(observedAt, {
      policyRetainMs: retentionMs,
      bound: 1,
      dryRun: false,
      afterId: second.nextAfterId,
    })
    expect(finalPage).toMatchObject({ scanned: 1, truncated: false })
    expect(finalPage.nextAfterId).toBeUndefined()
    expect(finalPage.retainedByReason).toEqual({ not_expired: 1 })

    const expired = await retention.deleteEligibleContextPackages(
      new Date(observedAt.getTime() + retentionMs + 1),
      { policyRetainMs: retentionMs, dryRun: false }
    )
    expect(expired.deleted).toBe(2)
    expect(await packages.getById(firstPackage.contextPackageId)).toBeDefined()
  }, 30_000)

  test('combining constrained and unconstrained plan refs preserves schema validation', async () => {
    const database = await createDatabase()
    const package_ = contextPackageSerializationFixtures.futurePi
    await new PostgresContextPackageRepository(database).put(package_)
    const plan = planFor(package_)
    const plans = new PostgresExecutionPlanRepository(database)
    await plans.put(plan)
    const observedAt = new Date('2026-12-22T00:00:00.000Z')
    await new PostgresExecutionPlanRetention(database).deleteEligibleExecutionPlans(observedAt, {
      policyRetainMs: retentionMs,
      dryRun: false,
    })
    const [before] = await database
      .select({ unreferencedSince: executionPlans.unreferencedSince })
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, plan.executionPlanId))
      .limit(1)
    expect(before?.unreferencedSince?.toISOString()).toBe(observedAt.toISOString())

    const result = await database.transaction((transaction) =>
      lockAndResetReferenceRetentionWindows(transaction, {
        executionPlans: [
          {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            schemaVersion: plan.schemaVersion + 1,
          },
          { executionPlanId: plan.executionPlanId, contentDigest: plan.contentDigest },
        ],
      })
    )
    expect(result).toEqual({ ok: false, target: 'execution-plan', id: plan.executionPlanId })
    const [after] = await database
      .select({ unreferencedSince: executionPlans.unreferencedSince })
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, plan.executionPlanId))
      .limit(1)
    expect(after?.unreferencedSince?.toISOString()).toBe(observedAt.toISOString())
  }, 30_000)

  test('new authoring and validation receipts clear previously observed reference clocks', async () => {
    const database = await createDatabase()
    const packages = new PostgresContextPackageRepository(database)
    const authoringPackage = contextPackageSerializationFixtures.futurePi
    await packages.put(authoringPackage)
    const observedAt = new Date('2026-12-22T00:00:00.000Z')
    await new PostgresContextPackageRetention(database).deleteEligibleContextPackages(observedAt, {
      policyRetainMs: retentionMs,
      dryRun: false,
    })
    const [authoringClockBefore] = await database
      .select({ unreferencedSince: contextPackages.unreferencedSince })
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, authoringPackage.contextPackageId))
      .limit(1)
    expect(authoringClockBefore?.unreferencedSince?.toISOString()).toBe(observedAt.toISOString())

    const authoringScope = {
      principalRef: 'service:retention-window-test',
      workspaceId: authoringPackage.projectState.workspaceId,
      projectId: authoringPackage.projectState.projectId,
      operation: 'context.author',
      idempotencyKey: 'retention-window-authoring-0001',
    }
    await new PostgresContextAuthoringCommandRepository(database).commit(
      {
        scope: authoringScope,
        payloadHash: `sha256:${'d'.repeat(64)}`,
        contextPackage: {
          contextPackageId: authoringPackage.contextPackageId,
          contentDigest: authoringPackage.contentDigest,
        },
      },
      authoringPackage
    )
    const [authoringClockAfter] = await database
      .select({ unreferencedSince: contextPackages.unreferencedSince })
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, authoringPackage.contextPackageId))
      .limit(1)
    expect(authoringClockAfter?.unreferencedSince).toBeNull()

    const planPackage = contextPackageSerializationFixtures.futureAcp
    await packages.put(planPackage)
    const plan = planFor(planPackage)
    const plans = new PostgresExecutionPlanRepository(database)
    await plans.put(plan)
    await new PostgresExecutionPlanRetention(database).deleteEligibleExecutionPlans(observedAt, {
      policyRetainMs: retentionMs,
      dryRun: false,
    })
    const [planClockBefore] = await database
      .select({ unreferencedSince: executionPlans.unreferencedSince })
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, plan.executionPlanId))
      .limit(1)
    expect(planClockBefore?.unreferencedSince?.toISOString()).toBe(observedAt.toISOString())

    await new PostgresExecutionValidationCommandRepository(database).commit(
      {
        scope: {
          callerPrincipalId: 'svc_agent-hq',
          workspaceId: plan.correlation.workspaceId,
          projectId: plan.correlation.projectId,
          operation: 'execution.validate',
          idempotencyKey: 'retention-window-validation-0001',
        },
        commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
        requestId: plan.correlation.requestId,
        payloadHash: `sha256:${'e'.repeat(64)}`,
        executionPlan: {
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
        },
        recordedAt: plan.compiledAt,
      },
      plan
    )
    const [planClockAfter] = await database
      .select({ unreferencedSince: executionPlans.unreferencedSince })
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, plan.executionPlanId))
      .limit(1)
    expect(planClockAfter?.unreferencedSince).toBeNull()
  }, 30_000)

  test('restarts a raced new plan reference after a retention scan observes it', async () => {
    const database = await createDatabase()
    const package_ = contextPackageSerializationFixtures.futurePi
    await new PostgresContextPackageRepository(database).put(package_)
    const plan = planFor(package_)
    const insertReached = deferred()
    const continueInsert = deferred()
    const updaterAcquired = deferred()
    const releaseUpdater = deferred()
    const racedDatabase = withPlanInsertBarrier(database, {
      onPlanInsert: () => {
        insertReached.resolve()
        return continueInsert.promise
      },
    })
    const validationCommands = new PostgresExecutionValidationCommandRepository(racedDatabase)
    const record = {
      scope: {
        callerPrincipalId: 'svc_agent-hq',
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        operation: 'execution.validate',
        idempotencyKey: 'retention-window-validation-race-0001',
      },
      commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
      requestId: plan.correlation.requestId,
      payloadHash: `sha256:${'f'.repeat(64)}`,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
      },
      recordedAt: plan.compiledAt,
    }
    const commit = validationCommands.commit(record, plan)
    const commitResult = commit.then(
      () => ({ completed: true }),
      (error) => ({ error })
    )
    const pending = [commit]

    try {
      const firstEvent = await Promise.race([
        insertReached.promise.then(() => ({ insertReached: true })),
        commitResult,
      ])
      if (!firstEvent.insertReached) {
        if (firstEvent.error) throw firstEvent.error
        throw new Error('PLAN_INSERT_COMPLETED_BEFORE_BARRIER')
      }
      await database.insert(executionPlans).values(planRow(plan))
      const staleAt = new Date('2026-12-22T00:00:00.000Z')
      await new PostgresExecutionPlanRetention(database).deleteEligibleExecutionPlans(staleAt, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      const [observed] = await database
        .select({ unreferencedSince: executionPlans.unreferencedSince })
        .from(executionPlans)
        .where(eq(executionPlans.executionPlanId, plan.executionPlanId))
        .limit(1)
      expect(observed?.unreferencedSince?.toISOString()).toBe(staleAt.toISOString())

      const duplicateCommit = validationCommands.commit(record, plan)
      pending.push(duplicateCommit)
      await waitForLockWait(database, 'pg_advisory_xact_lock')

      const updater = database.transaction(async (transaction) => {
        await transaction
          .update(contextPackages)
          .set({ unreferencedSince: new Date('2026-12-23T00:00:00.000Z') })
          .where(eq(contextPackages.contextPackageId, package_.contextPackageId))
        updaterAcquired.resolve()
        await releaseUpdater.promise
      })
      pending.push(updater)
      await waitForLockWait(database, 'context_packages')
      continueInsert.resolve()
      await updaterAcquired.promise
      await waitForLockWait(database, 'context_packages')
      releaseUpdater.resolve()
      const [committed, duplicate] = await Promise.all([commit, duplicateCommit])
      expect(committed).toEqual(record)
      expect(duplicate).toEqual(record)
    } finally {
      continueInsert.resolve()
      releaseUpdater.resolve()
      await Promise.allSettled(pending)
    }

    const [referenced] = await database
      .select({ unreferencedSince: executionPlans.unreferencedSince })
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, plan.executionPlanId))
      .limit(1)
    expect(referenced?.unreferencedSince).toBeNull()
    expect(await validationCommands.get(record.scope)).toEqual(record)
  }, 30_000)

  test('fails closed after a repeated plan reference race without a receipt or clock mutation', async () => {
    const database = await createDatabase()
    const package_ = contextPackageSerializationFixtures.futurePi
    await new PostgresContextPackageRepository(database).put(package_)
    const originalContextClock = new Date('2026-09-01T00:00:00.000Z')
    await new PostgresContextPackageRetention(database).deleteEligibleContextPackages(
      originalContextClock,
      { policyRetainMs: retentionMs, dryRun: false }
    )
    const plan = planFor(package_)
    const firstInsertReached = deferred()
    const continueFirstInsert = deferred()
    const firstConflictRead = deferred()
    const continueFirstConflictRead = deferred()
    const secondInsertReached = deferred()
    const continueSecondInsert = deferred()
    let insertAttempt = 0
    let conflictRead = 0
    const racedDatabase = withPlanInsertBarrier(database, {
      onPlanInsert: () => {
        insertAttempt += 1
        if (insertAttempt === 1) {
          firstInsertReached.resolve()
          return continueFirstInsert.promise
        }
        if (insertAttempt === 2) {
          secondInsertReached.resolve()
          return continueSecondInsert.promise
        }
        throw new Error('UNEXPECTED_EXECUTION_PLAN_INSERT_RETRY')
      },
      onRacedPlanRead: async (rows) => {
        conflictRead += 1
        if (conflictRead === 1) {
          expect(rows).toHaveLength(1)
          firstConflictRead.resolve()
          await continueFirstConflictRead.promise
        }
      },
    })
    const validationCommands = new PostgresExecutionValidationCommandRepository(racedDatabase)
    const record = {
      scope: {
        callerPrincipalId: 'svc_agent-hq',
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        operation: 'execution.validate',
        idempotencyKey: 'retention-window-validation-race-0002',
      },
      commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
      requestId: plan.correlation.requestId,
      payloadHash: `sha256:${'a'.repeat(64)}`,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
      },
      recordedAt: plan.compiledAt,
    }
    const commit = validationCommands.commit(record, plan)
    const commitResult = commit.then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    const planClock = new Date('2026-12-22T00:00:00.000Z')

    try {
      const firstPause = await Promise.race([
        firstInsertReached.promise.then(() => ({ paused: true })),
        commitResult,
      ])
      if (!firstPause.paused) {
        if (firstPause.error) throw firstPause.error
        throw new Error('PLAN_INSERT_COMPLETED_BEFORE_FIRST_BARRIER')
      }

      await database.insert(executionPlans).values(planRow(plan))
      await new PostgresExecutionPlanRetention(database).deleteEligibleExecutionPlans(planClock, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      continueFirstInsert.resolve()

      const readPause = await Promise.race([
        firstConflictRead.promise.then(() => ({ paused: true })),
        commitResult,
      ])
      if (!readPause.paused) {
        if (readPause.error) throw readPause.error
        throw new Error('PLAN_CONFLICT_READ_COMPLETED_BEFORE_BARRIER')
      }
      await database
        .delete(executionPlans)
        .where(eq(executionPlans.executionPlanId, plan.executionPlanId))
      continueFirstConflictRead.resolve()

      const secondPause = await Promise.race([
        secondInsertReached.promise.then(() => ({ paused: true })),
        commitResult,
      ])
      if (!secondPause.paused) {
        if (secondPause.error) throw secondPause.error
        throw new Error('PLAN_INSERT_COMPLETED_BEFORE_SECOND_BARRIER')
      }
      await database.insert(executionPlans).values(planRow(plan))
      await new PostgresExecutionPlanRetention(database).deleteEligibleExecutionPlans(planClock, {
        policyRetainMs: retentionMs,
        dryRun: false,
      })
      continueSecondInsert.resolve()

      const outcome = await commitResult
      expect(outcome.error?.message).toBe('EXECUTION_PLAN_REFERENCE_CONFLICT_RETRY_EXHAUSTED')
      expect(outcome.value).toBeUndefined()
    } finally {
      continueFirstInsert.resolve()
      continueFirstConflictRead.resolve()
      continueSecondInsert.resolve()
      await commitResult
    }

    expect(await validationCommands.get(record.scope)).toBeUndefined()
    const [packageAfter] = await database
      .select({ unreferencedSince: contextPackages.unreferencedSince })
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, package_.contextPackageId))
      .limit(1)
    expect(packageAfter?.unreferencedSince?.toISOString()).toBe(originalContextClock.toISOString())
    const [planAfter] = await database
      .select({ unreferencedSince: executionPlans.unreferencedSince })
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, plan.executionPlanId))
      .limit(1)
    expect(planAfter?.unreferencedSince?.toISOString()).toBe(planClock.toISOString())
    expect(await new PostgresExecutionPlanRepository(database).get(record.executionPlan)).toEqual(
      plan
    )
  }, 30_000)
})
