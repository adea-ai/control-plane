import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { loadDatabaseCredentials } from '@control-plane/config'
import { sql } from 'drizzle-orm'
import { PostgresCommandAcceptanceRepository } from './command-inbox-repository.ts'
import { createIsolatedTestDatabase } from './testing.ts'
import {
  PostgresContextPackageRepository,
  PostgresContextPackageRetention,
} from './context-package-repository.ts'
import {
  PostgresExecutionPlanRepository,
  PostgresExecutionPlanRetention,
} from './execution-plan-repository.ts'
import { PostgresEvaluationRepository } from './evaluation-repository.ts'
import { PostgresMessagingRetention } from './messaging-retention.ts'
import { PostgresReleaseAuditRepository } from './release-audit-repository.ts'
import { PostgresRetentionHoldRepository } from './retention-hold-repository.ts'
import { contextPackages } from './schema/context-packages.ts'
import { executionPlans } from './schema/execution-plans.ts'
import { inboxMessages, outboxEvents } from './schema/messaging.ts'
import { retiredCommandKeys } from './schema/retired-command-keys.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const retentionMs = 1_000
const observedAt = new Date('2026-09-26T12:00:00.000Z')
const otherWorkspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const otherProjectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const provenance = {
  actorPrincipalRef: 'operator:os-user:postgres-test',
  authorityRef: 'authority:postgres:test-database',
}
const holdPolicy = {
  'context-packages': {
    owner: 'workspace-owner',
    scopes: ['class', 'workspace', 'project'],
    reasonCodes: ['legal-case'],
  },
  'execution-plans': {
    owner: 'platform-operator',
    scopes: ['class', 'workspace', 'project'],
    reasonCodes: ['legal-case'],
  },
  'evaluation-runs': {
    owner: 'release-owner',
    scopes: ['class'],
    reasonCodes: ['legal-case'],
  },
  'audit-records': {
    owner: 'release-owner',
    scopes: ['class'],
    reasonCodes: ['legal-case'],
  },
  messaging: {
    owner: 'platform-operator',
    scopes: ['class'],
    reasonCodes: ['legal-case'],
  },
}
const retiredKeyHoldPolicy = {
  ...holdPolicy,
  'retired-command-keys': {
    owner: 'release-owner',
    scopes: ['class'],
    reasonCodes: ['legal-case'],
  },
}

function planFor(contextPackage) {
  return new ExecutionPlanCompiler('1.0.0').compile({
    ...createExecutionPlanTestFixtureInputs({ contextPackage }),
    compiledAt: '2024-01-01T00:00:00.000Z',
  })
}

function evaluationRun() {
  const configuration = {
    executionPlanDigest: `sha256:${'4'.repeat(64)}`,
    profile: { id: 'profile', version: 'v1', digest: `sha256:${'5'.repeat(64)}` },
    skills: [],
    graph: { id: 'graph', version: 'v1', digest: `sha256:${'6'.repeat(64)}` },
    runtime: { id: 'runtime', version: 'v1', digest: `sha256:${'7'.repeat(64)}` },
    model: { id: 'model', version: 'v1', digest: `sha256:${'8'.repeat(64)}` },
    tools: [],
    policy: { id: 'policy', version: 'v1', digest: `sha256:${'9'.repeat(64)}` },
  }
  const dataset = { id: 'dataset', version: 'v1', digest: `sha256:${'2'.repeat(64)}` }
  const suite = {
    evalSuiteId: 'suite-retention',
    version: 'v1',
    digest: `sha256:${'1'.repeat(64)}`,
    dataset,
    mode: 'offline',
    cases: [
      {
        evalCaseId: 'case-retention',
        inputDigest: `sha256:${'3'.repeat(64)}`,
        scorers: [
          { metric: 'functional_correctness', direction: 'min', threshold: 0.9, required: true },
        ],
      },
    ],
  }
  return {
    evalRunId: 'eval-retention-activation',
    suite,
    configuration,
    results: [
      {
        evalCaseId: 'case-retention',
        dataset,
        configuration,
        metrics: { functional_correctness: 1 },
        failedRequiredMetrics: [],
        status: 'passed',
      },
    ],
    aggregateMetrics: { functional_correctness: 1 },
    status: 'passed',
    startedAt: '2024-01-01T00:00:00.000Z',
    completedAt: '2024-01-01T00:00:01.000Z',
  }
}

function makeHold(classId, owner, scope) {
  return {
    holdId: randomUUID(),
    classId,
    scope,
    owner,
    reasonCode: 'legal-case',
    createdAt: '2026-09-26T11:00:00.000Z',
    createdBy: provenance,
    revision: 0,
  }
}

function deferred() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe.skipIf(!enabled)('PostgreSQL retention-hold activation', () => {
  const isolatedDatabases = []

  async function createDatabase() {
    const isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    isolatedDatabases.push(isolated)
    await isolated.migrate()
    return isolated
  }

  afterEach(async () => {
    const created = isolatedDatabases.splice(0)
    const results = await Promise.allSettled(created.map((isolated) => isolated.dispose()))
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length > 0)
      throw new AggregateError(errors, 'ISOLATED_TEST_DATABASE_DISPOSAL_FAILED')
  })

  test('holds suppress plan, context, evaluation, audit and messaging deletion until release', async () => {
    const isolated = await createDatabase()
    const database = isolated.application
    const contextFixture = contextPackageSerializationFixtures.futureAcp
    const planContext = contextPackageSerializationFixtures.futurePi
    const contexts = new PostgresContextPackageRepository(database)
    await contexts.put(contextFixture)
    await contexts.put(planContext)
    const plan = planFor(planContext)
    const plans = new PostgresExecutionPlanRepository(database)
    await plans.put(plan)

    const evalRepository = new PostgresEvaluationRepository(database)
    const run = evaluationRun()
    await evalRepository.saveRun(run)
    const auditRepository = new PostgresReleaseAuditRepository(database)
    const audit = {
      releaseAuditId: randomUUID(),
      releaseGateId: 'gate-retention-activation',
      action: 'promote',
      actor: 'operator://retention-test',
      toRunId: run.evalRunId,
      at: '2024-01-01T00:00:02.000Z',
    }
    await auditRepository.append(audit)
    await database.insert(inboxMessages).values({
      consumer: 'retention-activation-test',
      messageId: 'old-message',
      payload: { kind: 'retained-delivery' },
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    })
    await database.insert(outboxEvents).values({
      aggregateType: 'retention-test',
      aggregateId: 'old-event',
      eventType: 'retention.test',
      payload: { kind: 'settled' },
      status: 'published',
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
    })

    const holdRepository = new PostgresRetentionHoldRepository(database, holdPolicy)
    const contextHold = makeHold('context-packages', 'workspace-owner', {
      kind: 'project',
      workspaceId: contextFixture.projectState.workspaceId,
      projectId: contextFixture.projectState.projectId,
    })
    const planHold = makeHold('execution-plans', 'platform-operator', {
      kind: 'project',
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
    })
    const evaluationHold = makeHold('evaluation-runs', 'release-owner', { kind: 'class' })
    const auditHold = makeHold('audit-records', 'release-owner', { kind: 'class' })
    const messagingHold = makeHold('messaging', 'platform-operator', { kind: 'class' })
    for (const hold of [contextHold, planHold, evaluationHold, auditHold, messagingHold])
      await holdRepository.create(hold)

    const journal = []
    const options = {
      policyRetainMs: retentionMs,
      dryRun: false,
      retentionHoldPolicy: holdPolicy,
      journal: async (entries) => journal.push(...entries),
    }
    const planRetention = new PostgresExecutionPlanRetention(database)
    const contextRetention = new PostgresContextPackageRetention(database)
    const messageRetention = new PostgresMessagingRetention(database)

    const firstPlanPass = await planRetention.deleteEligibleExecutionPlans(observedAt, options)
    const firstContextPass = await contextRetention.deleteEligibleContextPackages(
      observedAt,
      options
    )
    expect(firstPlanPass.deleted).toBe(0)
    expect(firstContextPass.deleted).toBe(0)
    const planClock = await database
      .select({ unreferencedSince: executionPlans.unreferencedSince })
      .from(executionPlans)
    const contextClock = await database
      .select({
        contextPackageId: contextPackages.contextPackageId,
        unreferencedSince: contextPackages.unreferencedSince,
      })
      .from(contextPackages)
      .where(sql`${contextPackages.contextPackageId} = ${contextFixture.contextPackageId}`)
    expect(planClock[0]?.unreferencedSince?.toISOString()).toBe(observedAt.toISOString())
    expect(contextClock[0]?.unreferencedSince?.toISOString()).toBe(observedAt.toISOString())

    const expiredAt = new Date(observedAt.getTime() + retentionMs + 1)
    const heldPlanPass = await planRetention.deleteEligibleExecutionPlans(expiredAt, options)
    const heldContextPass = await contextRetention.deleteEligibleContextPackages(expiredAt, options)
    const heldEvaluationPass = await evalRepository.deleteEligibleEvaluationRuns(expiredAt, options)
    const heldAuditPass = await evalRepository.deleteEligibleReleaseAuditRecords(expiredAt, options)
    const heldMessagingPass = await messageRetention.sweepEligibleMessaging(expiredAt, options)
    expect(heldPlanPass).toMatchObject({ deleted: 0, retainedByReason: { hold_recorded: 1 } })
    expect(heldContextPass.retainedByReason).toMatchObject({ hold_recorded: 1 })
    expect(heldEvaluationPass.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(heldAuditPass.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(heldMessagingPass.retainedByReason).toEqual({ hold_recorded: 2 })
    expect(heldMessagingPass).toMatchObject({ deleted: 0, compacted: 0 })
    expect(journal).toEqual([])
    const clockWhileHeld = await database
      .select({ unreferencedSince: contextPackages.unreferencedSince })
      .from(contextPackages)
      .where(sql`${contextPackages.contextPackageId} = ${contextFixture.contextPackageId}`)
    expect(clockWhileHeld[0]?.unreferencedSince?.toISOString()).toBe(observedAt.toISOString())

    const release = {
      requestId: randomUUID(),
      releasedAt: expiredAt.toISOString(),
      releasedBy: provenance,
    }
    for (const hold of [contextHold, planHold, evaluationHold, auditHold, messagingHold])
      await holdRepository.release({ holdId: hold.holdId, expectedRevision: 0, release })

    const releasedPlanPass = await planRetention.deleteEligibleExecutionPlans(expiredAt, options)
    const releasedContextPass = await contextRetention.deleteEligibleContextPackages(
      expiredAt,
      options
    )
    const releasedEvaluationPass = await evalRepository.deleteEligibleEvaluationRuns(
      expiredAt,
      options
    )
    const releasedAuditPass = await evalRepository.deleteEligibleReleaseAuditRecords(
      expiredAt,
      options
    )
    const releasedMessagingPass = await messageRetention.sweepEligibleMessaging(expiredAt, options)
    expect(releasedPlanPass.deleted).toBe(1)
    expect(releasedContextPass.deleted).toBe(1)
    expect(releasedEvaluationPass.deleted).toBe(1)
    expect(releasedAuditPass.deleted).toBe(1)
    expect(releasedMessagingPass).toMatchObject({ deleted: 1, compacted: 1 })
    expect(journal.map((entry) => entry.kind).toSorted()).toEqual([
      'postgres.compactInboxMessage',
      'postgres.deleteContextPackage',
      'postgres.deleteEvaluationRun',
      'postgres.deleteExecutionPlan',
      'postgres.deleteOutboxEvent',
      'postgres.deleteReleaseAuditRecord',
    ])
    expect(
      await plans.get({ executionPlanId: plan.executionPlanId, contentDigest: plan.contentDigest })
    ).toBeUndefined()
    expect(await contexts.getById(contextFixture.contextPackageId)).toBeUndefined()
    expect(await evalRepository.getRun(run.evalRunId)).toBeUndefined()
    expect(await auditRepository.list('gate-retention-activation')).toEqual([])
  }, 30_000)

  test('a project hold in another tenant does not suppress physical deletion', async () => {
    const isolated = await createDatabase()
    const database = isolated.application
    const contextFixture = contextPackageSerializationFixtures.futureAcp
    const contextRepository = new PostgresContextPackageRepository(database)
    await contextRepository.put(contextFixture)
    const planContext = contextPackageSerializationFixtures.futurePi
    await contextRepository.put(planContext)
    const plan = planFor(planContext)
    await new PostgresExecutionPlanRepository(database).put(plan)
    const contextRetention = new PostgresContextPackageRetention(database)
    const planRetention = new PostgresExecutionPlanRetention(database)
    const options = { policyRetainMs: retentionMs, dryRun: false, retentionHoldPolicy: holdPolicy }
    await contextRetention.deleteEligibleContextPackages(observedAt, options)
    await planRetention.deleteEligibleExecutionPlans(observedAt, options)

    const holds = new PostgresRetentionHoldRepository(database, holdPolicy)
    await holds.create(
      makeHold('context-packages', 'workspace-owner', {
        kind: 'project',
        workspaceId: otherWorkspaceId,
        projectId: otherProjectId,
      })
    )
    await holds.create(
      makeHold('execution-plans', 'platform-operator', {
        kind: 'project',
        workspaceId: otherWorkspaceId,
        projectId: otherProjectId,
      })
    )
    const expiredAt = new Date(observedAt.getTime() + retentionMs + 1)
    expect((await contextRetention.deleteEligibleContextPackages(expiredAt, options)).deleted).toBe(
      1
    )
    expect((await planRetention.deleteEligibleExecutionPlans(expiredAt, options)).deleted).toBe(1)
    expect(await contextRepository.getById(contextFixture.contextPackageId)).toBeUndefined()
  }, 30_000)

  test('missing policy and malformed stored holds fail closed before deleting a candidate', async () => {
    const isolated = await createDatabase()
    const database = isolated.application
    const package_ = contextPackageSerializationFixtures.futureAcp
    await new PostgresContextPackageRepository(database).put(package_)
    const holds = new PostgresRetentionHoldRepository(database, holdPolicy)
    const hold = makeHold('context-packages', 'workspace-owner', {
      kind: 'project',
      workspaceId: package_.projectState.workspaceId,
      projectId: package_.projectState.projectId,
    })
    await holds.create(hold)
    const retention = new PostgresContextPackageRetention(database)
    const baseOptions = { policyRetainMs: retentionMs, dryRun: false }
    await expect(retention.deleteEligibleContextPackages(observedAt, baseOptions)).rejects.toThrow(
      'RETENTION_HOLD_POLICY_INVALID'
    )
    expect(
      await new PostgresContextPackageRepository(database).getById(package_.contextPackageId)
    ).toBeDefined()

    await database.execute(
      sql`update retention_holds set hold_owner = 'INVALID OWNER' where hold_id = ${hold.holdId}`
    )
    await expect(
      retention.deleteEligibleContextPackages(observedAt, {
        ...baseOptions,
        retentionHoldPolicy: holdPolicy,
      })
    ).rejects.toThrow('RETENTION_HOLD_STORED_RECORD_INVALID')
    expect(
      await new PostgresContextPackageRepository(database).getById(package_.contextPackageId)
    ).toBeDefined()
  }, 30_000)

  test('class holds protect retired command keys until the hold is released', async () => {
    const isolated = await createDatabase()
    const scopeKey = randomUUID().replaceAll('-', '').repeat(2).slice(0, 64)
    const application = isolated.application
    const holds = new PostgresRetentionHoldRepository(application, retiredKeyHoldPolicy)
    const hold = makeHold('retired-command-keys', 'release-owner', { kind: 'class' })
    await isolated.withMigrationDatabase(async (migrationDatabase) => {
      // The operator retention path uses the migration role for tombstones;
      // hold administration follows the application-role path used by the CLI.
      await migrationDatabase.insert(retiredCommandKeys).values({
        scopeKey,
        commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
        executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        retiredAt: new Date('2026-01-01T00:00:00.000Z'),
        metadataVersion: 1,
        identityDigest: null,
      })
    })

    await holds.create(hold)
    const journal = []
    const options = {
      policyRetainMs: retentionMs,
      dryRun: false,
      retentionHoldPolicy: retiredKeyHoldPolicy,
      journal: async (operations) => journal.push(...operations),
    }

    const heldPass = await isolated.withMigrationDatabase(async (migrationDatabase) => {
      const retention = new PostgresCommandAcceptanceRepository(migrationDatabase)
      const pass = await retention.deleteEligibleRetiredCommandKeys(observedAt, options)
      expect(await migrationDatabase.select().from(retiredCommandKeys)).toHaveLength(1)
      return pass
    })
    expect(heldPass).toMatchObject({ deleted: 0, retainedByReason: { hold_recorded: 1 } })
    expect(journal).toEqual([])

    await holds.release({
      holdId: hold.holdId,
      expectedRevision: 0,
      release: {
        requestId: randomUUID(),
        releasedAt: observedAt.toISOString(),
        releasedBy: provenance,
      },
    })

    const releasedPass = await isolated.withMigrationDatabase(async (migrationDatabase) => {
      const retention = new PostgresCommandAcceptanceRepository(migrationDatabase)
      const pass = await retention.deleteEligibleRetiredCommandKeys(observedAt, options)
      expect(await migrationDatabase.select().from(retiredCommandKeys)).toHaveLength(0)
      return pass
    })
    expect(releasedPass.deleted).toBe(1)
    expect(journal).toEqual([{ kind: 'postgres.deleteRetiredCommandKey', scopeKey }])
  }, 30_000)

  test('a committing hold writer wins a waiting real context-package deletion claim', async () => {
    const isolated = await createDatabase()
    const database = isolated.application
    const package_ = contextPackageSerializationFixtures.futureAcp
    await new PostgresContextPackageRepository(database).put(package_)
    const retention = new PostgresContextPackageRetention(database)
    const options = { policyRetainMs: retentionMs, dryRun: false, retentionHoldPolicy: holdPolicy }
    await retention.deleteEligibleContextPackages(observedAt, options)

    const claimed = deferred()
    const releaseClaim = deferred()
    const hold = makeHold('context-packages', 'workspace-owner', {
      kind: 'project',
      workspaceId: package_.projectState.workspaceId,
      projectId: package_.projectState.projectId,
    })
    const blocker = database.transaction(async (transaction) => {
      // The real repository writes under a savepoint; its mutex survives until
      // the parent transaction commits, on a connection distinct from deletion.
      await new PostgresRetentionHoldRepository(transaction, holdPolicy).create(hold)
      claimed.resolve()
      await releaseClaim.promise
    })
    let deletionSettled = false
    let deletion
    const claimErrors = []
    try {
      await claimed.promise
      deletion = retention
        .deleteEligibleContextPackages(new Date(observedAt.getTime() + retentionMs + 1), options)
        .then((result) => {
          deletionSettled = true
          return result
        })
      expect(await waitForAdvisoryWait(database)).toBe(true)
      expect(deletionSettled).toBe(false)
    } catch (error) {
      claimErrors.push(error)
    } finally {
      releaseClaim.resolve()
      const settled = await Promise.allSettled([blocker, deletion])
      for (const result of settled) {
        if (result.status === 'rejected') claimErrors.push(result.reason)
      }
    }
    if (claimErrors.length > 0) throw new AggregateError(claimErrors, 'HOLD_CLAIM_FAILED')
    expect(await deletion).toMatchObject({ deleted: 0, retainedByReason: { hold_recorded: 1 } })
    expect(
      await new PostgresRetentionHoldRepository(database, holdPolicy).get(hold.holdId)
    ).toEqual(hold)
    expect(
      await new PostgresContextPackageRepository(database).getById(package_.contextPackageId)
    ).toBeDefined()
  }, 30_000)
})

async function waitForAdvisoryWait(database) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const rows = await database.execute(
      sql`select query from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
    )
    if (rows.some((row) => row.query?.includes('pg_advisory_xact_lock'))) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}
