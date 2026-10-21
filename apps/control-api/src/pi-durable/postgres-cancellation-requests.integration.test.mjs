import { beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  commandInbox,
} from '@control-plane/database'
import {
  piCancellationRequestDigest,
  piCancellationTargetDigest,
} from '@control-plane/pi-durable-adapter'
import {
  PostgresPiCancellationRequests,
  piCancellationRequestNamespace,
  piCancellationRequestKey,
  piCancellationRequestEvent,
} from './postgres-cancellation-requests.ts'
import { deterministicPiLeadIntentIds } from './node-admission.ts'

import {
  cancellationPostgresEnabled,
  createCancellationTestDatabase,
} from './postgres-cancellation-test-database.fixture.mjs'

const enabled = cancellationPostgresEnabled()
const at = '2026-10-20T12:00:00.000Z'
const later = '2026-10-20T13:00:00.000Z'
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const workspaceId = id('wsp')
describe.skipIf(!enabled)('Pi cancellation request retention on disposable PostgreSQL', () => {
  let client, database, executions, ownedDatabase
  beforeAll(async () => {
    // Private peer socket for operator qualification, or the explicit disposable-local CI lane.
    // The normal lane creates one owned database with existing roles; it never grants access.
    ownedDatabase = await createCancellationTestDatabase()
    client = ownedDatabase.client
    expect(
      Number((await client`show server_version_num`)[0].server_version_num)
    ).toBeGreaterThanOrEqual(180000)
    expect(Number((await client`show server_version_num`)[0].server_version_num)).toBeLessThan(
      190000
    )
    database = drizzle(client)
    await migrate(database, {
      migrationsFolder: fileURLToPath(
        new URL('../../../../packages/database/drizzle', import.meta.url)
      ),
    })
    executions = new PostgresExecutionRepository(database)
  }, 30_000)
  afterAll(async () => {
    await ownedDatabase?.close()
  })

  async function fixture() {
    const productIntentId = randomUUID()
    const ids = deterministicPiLeadIntentIds(workspaceId, productIntentId)
    const context = contextPackageSerializationFixtures.futurePi
    const input = createExecutionPlanTestFixtureInputs({ contextPackage: context })
    input.correlation.workspaceId = workspaceId
    const plan = new ExecutionPlanCompiler('1.0.0').compile(input)
    await new PostgresContextPackageRepository(database).put(context)
    await new PostgresExecutionPlanRepository(database).put(plan)
    const lifecycle = new ExecutionLifecycleService(executions)
    await lifecycle.createExecution({
      executionId: ids.executionId,
      correlation: plan.correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      acceptedAt: at,
    })
    await lifecycle.createAttempt({
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      expectedExecutionVersion: 1,
      queuedAt: at,
    })
    await database.insert(commandInbox).values({
      commandId: ids.commandId,
      callerPrincipalId: 'svc_adea',
      operation: 'execution.accept',
      workspaceId,
      projectId: plan.correlation.projectId ?? null,
      executionScope: plan.correlation.executionScope ?? null,
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
      requestId: ids.requestId,
      idempotencyKey: `lead-turn:${productIntentId}`,
      payloadHash: 'a'.repeat(64),
      status: 'accepted',
      executionId: ids.executionId,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      executionPlanSchemaVersion: plan.schemaVersion,
      version: 1,
      conflictCount: 0,
      receivedAt: new Date(at),
      lastSeenAt: new Date(at),
      retentionExpiresAt: new Date(later),
    })
    const target = {
      workspaceId,
      productIntentId,
      originalActorPrincipalId: 'user:original',
      servicePrincipalId: 'svc_adea',
      scopeRef: 'adea-product:scope',
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      executionVersion: 2,
      attemptVersion: 1,
      admissionDigest: `sha256:${'a'.repeat(64)}`,
      handle: {
        handleId: `pi-${productIntentId}`,
        attemptId: ids.attemptId,
        externalSessionId: id('ses'),
        startedAt: at,
      },
      restoreGeneration: 'test:unqualified',
      ownerEpoch: 1,
      turnKey: 'initial',
      targetKind: 'active_generation',
      generation: { inferenceId: 'native:1', inferenceKey: 'initial:native:1' },
      authorityExpiresAt: later,
    }
    const body = { target, idempotencyKey: 'cancel:one', requestedAt: at }
    const intent = {
      schemaVersion: 'pi-cancellation-retained-intent/v1',
      ...body,
      requestDigest: piCancellationRequestDigest(body),
    }
    return { intent, ids, repository: new PostgresPiCancellationRequests(database) }
  }
  function changed(intent, target) {
    const body = {
      target: { ...intent.target, ...target },
      requestedAt: intent.requestedAt,
      idempotencyKey: intent.idempotencyKey,
    }
    return { ...intent, ...body, requestDigest: piCancellationRequestDigest(body) }
  }
  async function counts(intent) {
    const key = piCancellationRequestKey(intent)
    const [row] = await client`select
      (select count(*)::int from persistence_records where namespace=${piCancellationRequestNamespace} and id=${key}) as requests,
      (select count(*)::int from outbox_events where aggregate_id=${key} and event_type=${piCancellationRequestEvent}) as outbox`
    return row
  }
  async function blocked(minimum = 1) {
    for (let i = 0; i < 200; i++) {
      const rows =
        await client`select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0`
      if (rows.length >= minimum) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('EXPECTED_POSTGRES_LOCK_WAIT')
  }

  test('retains one request and pending retry atomically; replay grants no permission or lifecycle transition', async () => {
    const { intent, ids, repository } = await fixture()
    const before = [
      await executions.getExecution(ids.executionId),
      await executions.getAttempt(ids.attemptId),
    ]
    const first = await repository.retain(intent)
    const duplicate = await repository.retain(structuredClone(intent))
    expect(first.replayed).toBe(false)
    expect(duplicate).toEqual({ record: first.record, replayed: true })
    expect(await counts(intent)).toEqual({ requests: 1, outbox: 1 })
    const [outbox] =
      await client`select status, attempts, published_at, payload from outbox_events where id=${first.record.outboxId}`
    expect(outbox).toMatchObject({ status: 'pending', attempts: 0, published_at: null })
    expect(outbox.payload).toEqual({
      schemaVersion: 'pi-cancellation-request-retry/v1',
      requestKey: piCancellationRequestKey(intent),
      requestDigest: intent.requestDigest,
      targetDigest: piCancellationTargetDigest(intent.target),
    })
    expect(first.record).not.toHaveProperty('permit')
    expect([
      await executions.getExecution(ids.executionId),
      await executions.getAttempt(ids.attemptId),
    ]).toEqual(before)
  })

  test('same key with changed digest conflicts without another outbox row', async () => {
    const { intent, repository } = await fixture()
    await repository.retain(intent)
    await expect(
      repository.retain(
        changed(intent, {
          generation: { inferenceId: 'native:2', inferenceKey: 'initial:native:2' },
        })
      )
    ).rejects.toThrow('PI_CANCELLATION_IDEMPOTENCY_CONFLICT')
    expect(await counts(intent)).toEqual({ requests: 1, outbox: 1 })
  })

  test('stale execution or attempt version leaves neither record', async () => {
    for (const mismatch of [{ executionVersion: 1 }, { attemptVersion: 2 }]) {
      const { intent, repository } = await fixture()
      await expect(repository.retain(changed(intent, mismatch))).rejects.toThrow(
        'PI_CANCELLATION_REQUEST_STALE_VERSION'
      )
      expect(await counts(intent)).toEqual({ requests: 0, outbox: 0 })
    }
  })

  test('wrong accepting principal, deterministic identity and retained session binding are rejected', async () => {
    for (const change of [{ servicePrincipalId: 'svc_other' }, { productIntentId: randomUUID() }]) {
      const { intent, repository } = await fixture()
      const request = changed(intent, change)
      await expect(repository.retain(request)).rejects.toThrow(
        'PI_CANCELLATION_REQUEST_BINDING_REJECTED'
      )
      expect(await counts(request)).toEqual({ requests: 0, outbox: 0 })
    }
    const { intent, ids, repository } = await fixture()
    await client`update execution_attempts set external_session_id=${id('ses').replace(/G$/, 'H')} where attempt_id=${ids.attemptId}`
    await expect(repository.retain(intent)).rejects.toThrow(
      'PI_CANCELLATION_REQUEST_BINDING_REJECTED'
    )
    expect(await counts(intent)).toEqual({ requests: 0, outbox: 0 })
  })

  test('a real outbox INSERT failure rolls back the earlier request INSERT and retry succeeds', async () => {
    const { intent, repository } = await fixture()
    const key = piCancellationRequestKey(intent)
    await client.unsafe(
      `create function pi_cancel_test_reject() returns trigger language plpgsql as $$ begin if NEW.aggregate_id='${key}' then raise exception 'TEST_OUTBOX_INSERT_FAILED'; end if; return NEW; end $$`
    )
    await client`create trigger pi_cancel_test_reject before insert on outbox_events for each row execute function pi_cancel_test_reject()`
    try {
      const [result] = await Promise.allSettled([repository.retain(intent)])
      expect(result.status).toBe('rejected')
      expect(result.reason.cause?.message ?? result.reason.message).toContain(
        'TEST_OUTBOX_INSERT_FAILED'
      )
      expect(await counts(intent)).toEqual({ requests: 0, outbox: 0 })
    } finally {
      await client`drop trigger pi_cancel_test_reject on outbox_events`
      await client`drop function pi_cancel_test_reject()`
    }
    expect((await repository.retain(intent)).replayed).toBe(false)
    expect(await counts(intent)).toEqual({ requests: 1, outbox: 1 })
  })

  test('competing same-key writers produce one insertion, and differing targets cannot both win', async () => {
    const { intent, repository } = await fixture()
    const results = await Promise.all(Array.from({ length: 8 }, () => repository.retain(intent)))
    expect(results.filter((result) => !result.replayed)).toHaveLength(1)
    expect(await counts(intent)).toEqual({ requests: 1, outbox: 1 })
    const other = await fixture()
    const contenders = await Promise.allSettled([
      other.repository.retain(other.intent),
      other.repository.retain(changed(other.intent, { ownerEpoch: 2 })),
    ])
    expect(contenders.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(contenders.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(contenders.find((result) => result.status === 'rejected').reason.message).toBe(
      'PI_CANCELLATION_IDEMPOTENCY_CONFLICT'
    )
    expect(await counts(other.intent)).toEqual({ requests: 1, outbox: 1 })
  })

  test('a prior competing lifecycle writer blocks retention and its committed version is observed', async () => {
    const { intent, ids, repository } = await fixture()
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers()
    const writer = client.begin(async (tx) => {
      await tx`update executions set version=version+1 where execution_id=${ids.executionId}`
      entered.resolve()
      await release.promise
    })
    let reader
    try {
      await entered.promise
      reader = repository.retain(intent)
      // Attach a rejection handler immediately while deliberately waiting on the transaction lock.
      const outcome = Promise.allSettled([reader])
      await blocked()
      release.resolve()
      await writer
      const [result] = await outcome
      expect(result.status).toBe('rejected')
      expect(result.reason.message).toBe('PI_CANCELLATION_REQUEST_STALE_VERSION')
      expect(await counts(intent)).toEqual({ requests: 0, outbox: 0 })
    } finally {
      release.resolve()
      await writer
    }
  })

  test('retention holds its shared attempt lock through the outbox insert before a later lifecycle writer', async () => {
    const { intent, ids, repository } = await fixture()
    const key = piCancellationRequestKey(intent)
    const holder = await client.reserve()
    await holder`begin`
    await holder`select pg_advisory_xact_lock(87211941)`
    await client.unsafe(
      `create function pi_cancel_test_gate() returns trigger language plpgsql as $$ begin if NEW.aggregate_id='${key}' then perform pg_advisory_xact_lock(87211941); end if; return NEW; end $$`
    )
    await client`create trigger pi_cancel_test_gate before insert on outbox_events for each row execute function pi_cancel_test_gate()`
    let finished = false
    const retaining = repository.retain(intent)
    const retained = Promise.allSettled([retaining])
    let writing
    try {
      await blocked()
      writing = Promise.resolve(
        client`update execution_attempts set version=version+1 where attempt_id=${ids.attemptId}`
      )
      await blocked(2)
      expect(await counts(intent)).toEqual({ requests: 0, outbox: 0 })
      await holder`commit`
      finished = true
      const [result] = await retained
      expect(result.status).toBe('fulfilled')
      expect(result.value.replayed).toBe(false)
      await writing
      expect((await executions.getAttempt(ids.attemptId)).version).toBe(2)
      expect(await counts(intent)).toEqual({ requests: 1, outbox: 1 })
    } finally {
      if (!finished) await holder`rollback`
      holder.release()
      await retained
      await writing
      await client`drop trigger pi_cancel_test_gate on outbox_events`
      await client`drop function pi_cancel_test_gate()`
    }
  })

  test('a fresh OS process retrieves the durable pair after restart without inferring current authority', async () => {
    const { intent, ids, repository } = await fixture()
    const first = await repository.retain(intent)
    await client`update executions set version=version+1 where execution_id=${ids.executionId}`
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL('./postgres-cancellation-request-reader.fixture.mjs', import.meta.url)
        ),
      ],
      {
        env: ownedDatabase.environment,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    child.stdin.write(JSON.stringify(intent))
    child.stdin.end()
    const [exit, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exit, errors }).toEqual({ exit: 0, errors: '' })
    const reopened = JSON.parse(output)
    expect(reopened.record).toEqual(first.record)
    expect(reopened.replay).toEqual({ record: first.record, replayed: true })
    expect(await counts(intent)).toEqual({ requests: 1, outbox: 1 })
  })
})
