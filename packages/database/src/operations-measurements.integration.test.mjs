import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { loadDatabaseCredentials } from '@control-plane/config'
import { operationsMetricNames, operationsStorageNamespaces } from '@control-plane/telemetry'
import {
  createPostgresOperationsMeasurementProducer,
  createPostgresRuntimeMeasurements,
  postgresMeasuredNamespaces,
} from './operations-measurements.ts'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import * as schema from './schema/index.ts'

// Disposable PostgreSQL only: the isolated database is created, migrated and
// dropped per run by `createIsolatedTestDatabase`; no operator database is read.
const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const timeout = integrationTestTimeout(60_000)

const NOW = new Date('2026-10-14T12:00:00.000Z')
const WORKSPACE_A = 'wsp_01JABCDEF0123456789ABCDEFA'
const WORKSPACE_B = 'wsp_01JABCDEF0123456789ABCDEFB'
const SECRET = 'sk-live-HOSTED-MEASUREMENT-SECRET'
const DIGEST = `sha256:${'a'.repeat(64)}`
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60_000)
const usd = (microunits) => microunits / 1_000_000

let counter = 0
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABC${String(++counter).padStart(4, '0')}`

describe.skipIf(!enabled)('Hosted PostgreSQL operations measurement producer', () => {
  let isolated
  let application
  let migrationSql
  let applicationUrl
  const clients = []

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
    const applicationCredentials = loadDatabaseCredentials(process.env, 'application')
    const url = new URL(applicationCredentials.url)
    url.pathname = `/${isolated.name}`
    applicationUrl = url.toString()
    // A dedicated pool so the producer's connections can be inspected and ended.
    const applicationClient = postgres(applicationUrl, { max: 4, prepare: false })
    clients.push(applicationClient)
    application = drizzle(applicationClient, { schema })
    const migrationCredentials = loadDatabaseCredentials(process.env, 'migration')
    const migrationUrl = new URL(migrationCredentials.url)
    migrationUrl.pathname = `/${isolated.name}`
    migrationSql = postgres(migrationUrl.toString(), { max: 2, prepare: false })
    clients.push(migrationSql)
    await seedWorkspaceA()
    await seedWorkspaceB()
  }, timeout)

  afterAll(async () => {
    for (const client of clients) await client.end({ timeout: 5 })
    await isolated?.dispose()
  }, timeout)

  afterEach(async () => {
    await migrationSql`grant select on usage_budget_states to ${migrationSql(
      new URL(applicationUrl).username
    )}`
  })

  // ---- Fixtures ------------------------------------------------------------

  async function insertExecution(workspaceId, row) {
    const executionId = id('exe')
    await migrationSql`insert into executions
      (execution_id, state, version, workspace_id, project_id, task_id, agent_id, request_id,
       execution_plan_id, execution_plan_digest, execution_plan_schema_version, attempt_count,
       reconciliation_required_at, accepted_at, created_at, updated_at)
      values (${executionId}, ${row.state}, 1, ${workspaceId}, ${id('prj')}, ${id('tsk')}, ${id('agt')},
        ${id('req')}, ${id('pln')}, ${DIGEST}, 1, ${row.attempts ?? 1},
        ${row.reconciliationRequiredAt ?? null}, ${row.updatedAt}, ${row.updatedAt}, ${row.updatedAt})`
    return executionId
  }

  async function insertAttempt(executionId, row) {
    const attemptId = id('att')
    await migrationSql`insert into execution_attempts
      (attempt_id, execution_id, sequence, state, version, accepted_at, queued_at, terminal_at, created_at, updated_at)
      values (${attemptId}, ${executionId}, ${row.sequence}, ${row.state}, 1,
        ${row.acceptedAt ?? row.queuedAt}, ${row.queuedAt ?? null}, ${row.terminalAt ?? null},
        ${row.acceptedAt ?? row.queuedAt}, ${row.updatedAt ?? row.queuedAt})`
    return attemptId
  }

  async function insertInteraction(executionId, attemptId, row) {
    await migrationSql`insert into interaction_requests
      (interaction_id, execution_id, attempt_id, kind, state, prompt, allowed_actions,
       allowed_principal_ids, version, requested_at, expires_at, response, resolved_at)
      values (${id('int')}, ${executionId}, ${attemptId}, 'approval', ${row.state},
        ${migrationSql.json({ text: SECRET })}, ${migrationSql.json(['approve'])},
        ${migrationSql.json([])}, 1, ${row.requestedAt}, ${ago(-600)},
        ${row.resolvedAt === undefined ? null : migrationSql.json({ answer: SECRET })},
        ${row.resolvedAt ?? null})`
  }

  async function ensureConnection() {
    const rows = await migrationSql`select runtime_connection_id from runtime_connections limit 1`
    if (rows.length > 0) return rows[0].runtime_connection_id
    const runtimeConnectionId = id('rtc')
    await migrationSql`insert into runtime_connections
      (runtime_connection_id, identity_digest, connection_type, runtime_definition_id, location,
       adapter_version, driver_version, harness_version, status, health, capabilities,
       compatibility_state, limitations, last_discovered_at, last_heartbeat_at, last_health_check_at,
       version, created_at, updated_at)
      values (${runtimeConnectionId}, ${DIGEST}, 'managed_cloud', ${id('rtd')}, 'agent_hq_cloud',
        '1', '1', '1', 'connected', 'healthy', ${migrationSql.json({})}, 'compatible',
        ${migrationSql.json([])}, ${NOW}, ${NOW}, ${NOW}, 1, ${NOW}, ${NOW})`
    return runtimeConnectionId
  }

  async function insertCommand(workspaceId, executionId, attemptId, row) {
    const runtimeConnectionId = await ensureConnection()
    await migrationSql`insert into runtime_commands
      (command_id, execution_id, attempt_id, runtime_node_ref_id, runtime_connection_id, workspace_id,
       idempotency_key, payload_hash, command_envelope, issued_at, expires_at, status, version,
       delivery_attempts, first_dispatched_at, created_at, updated_at)
      values (${id('cmd')}, ${executionId}, ${attemptId}, ${id('nod')}, ${runtimeConnectionId},
        ${workspaceId}, ${id('key')}, ${DIGEST}, ${migrationSql.json({ secret: SECRET })},
        ${row.issuedAt}, ${ago(-600)}, ${row.status}, 1, 0, ${row.firstDispatchedAt ?? null},
        ${row.issuedAt}, ${row.issuedAt})`
  }

  const sequences = { event: 0, ledger: 0 }
  async function insertEvent(workspaceId, executionId, row) {
    await migrationSql`insert into execution_events
      (event_id, execution_id, sequence, event_type, schema_version, request_id, workspace_id,
       project_id, task_id, agent_id, trace_id, payload, payload_bytes, payload_hash, occurred_at,
       recorded_at, retention_expires_at, publication_status, publication_attempts,
       publication_version, archived_at)
      values (${id('evt')}, ${executionId}, ${(sequences.event += 1)}, 'execution.test', 1, ${id('req')},
        ${workspaceId}, ${id('prj')}, ${id('tsk')}, ${id('agt')}, ${id('trc')},
        ${migrationSql.json({ note: SECRET })}, 10, ${'b'.repeat(64)}, ${ago(30)}, ${ago(30)},
        ${ago(-6000)}, ${row.status}, 0, 1, ${row.archivedAt ?? null})`
  }

  async function insertProjection(workspaceId, kind, model) {
    await migrationSql`insert into runtime_discovery_projections
      (kind, resource_id, workspace_id, model, updated_at)
      values (${kind}, ${id('res')}, ${workspaceId}, ${migrationSql.json(model)}, ${ago(5)})`
  }

  async function insertPlan(workspaceId) {
    await migrationSql`insert into execution_plans
      (execution_plan_id, content_digest, schema_version, workspace_id, project_id, task_id, agent_id,
       plan, compiled_at)
      values (${id('pln')}, ${DIGEST}, 1, ${workspaceId}, ${id('prj')}, ${id('tsk')}, ${id('agt')},
        ${migrationSql.json({ objective: SECRET })}, ${ago(10)})`
  }

  async function insertLedger(workspaceId, executionId, row) {
    await migrationSql`insert into usage_ledger_entries
      (entry_id, sequence, workspace_id, execution_id, kind, source_id, idempotency_key,
       funding_source, quantity, currency, cost_microunits, cost_exact, recorded_at)
      values (${id('led')}, ${(sequences.ledger += 1)}, ${workspaceId}, ${executionId}, 'model_usage',
        ${id('src')}, ${id('key')}, 'hq_managed', ${migrationSql.json({ unit: 'tokens', value: 10 })},
        ${row.currency}, ${row.cost}, ${row.exact}, ${row.recordedAt})`
  }

  async function insertBudget(workspaceId, executionId, state) {
    await migrationSql`insert into usage_budget_states
      (execution_id, workspace_id, schema_version, state)
      values (${executionId}, ${workspaceId}, 1, ${migrationSql.json(state)})`
  }

  async function insertReceipt(workspaceId, executionId) {
    await migrationSql`insert into usage_operation_receipts
      (workspace_id, idempotency_key, execution_id, fingerprint, schema_version, receipt)
      values (${workspaceId}, ${id('key')}, ${executionId}, ${DIGEST}, 1, ${migrationSql.json({ note: SECRET })})`
  }

  const budgetState = (workspaceId, executionId, currency, charges) => ({
    schemaVersion: 1,
    workspaceId,
    executionId,
    currency,
    status: 'open',
    reservations: charges.map((chargedMicrounits) => ({ chargedMicrounits, status: 'open' })),
  })

  let executionsA
  async function seedWorkspaceA() {
    const running = await insertExecution(WORKSPACE_A, {
      state: 'running',
      attempts: 2,
      updatedAt: ago(30),
    })
    const completed = await insertExecution(WORKSPACE_A, {
      state: 'completed',
      updatedAt: ago(120),
    })
    const reconcile = await insertExecution(WORKSPACE_A, {
      state: 'reconciliation_required',
      updatedAt: ago(10),
      reconciliationRequiredAt: ago(10),
    })
    const awaiting = await insertExecution(WORKSPACE_A, {
      state: 'awaiting_input',
      updatedAt: ago(60),
    })
    executionsA = { running, completed, reconcile, awaiting }

    const failedAttempt = await insertAttempt(running, {
      sequence: 1,
      state: 'failed',
      queuedAt: ago(180),
      terminalAt: ago(170),
    })
    const runningAttempt = await insertAttempt(running, {
      sequence: 2,
      state: 'running',
      queuedAt: ago(120),
    })
    await insertAttempt(completed, {
      sequence: 1,
      state: 'completed',
      queuedAt: ago(130),
      terminalAt: ago(121),
    })
    const reconcileAttempt = await insertAttempt(reconcile, {
      sequence: 1,
      state: 'running',
      queuedAt: ago(20),
    })
    const awaitingAttempt = await insertAttempt(awaiting, {
      sequence: 1,
      state: 'awaiting_input',
      queuedAt: ago(70),
    })
    void failedAttempt

    await insertInteraction(running, runningAttempt, {
      state: 'responded',
      requestedAt: ago(100),
      resolvedAt: ago(90),
    })
    await insertInteraction(running, runningAttempt, {
      state: 'responded',
      requestedAt: ago(50),
      resolvedAt: ago(20),
    })
    await insertInteraction(awaiting, awaitingAttempt, { state: 'pending', requestedAt: ago(45) })
    await insertInteraction(reconcile, reconcileAttempt, { state: 'pending', requestedAt: ago(15) })
    await insertInteraction(reconcile, reconcileAttempt, {
      state: 'expired',
      requestedAt: ago(200),
    })

    await insertCommand(WORKSPACE_A, running, runningAttempt, {
      status: 'queued',
      issuedAt: ago(20),
    })
    await insertCommand(WORKSPACE_A, running, runningAttempt, {
      status: 'dispatched',
      issuedAt: ago(60),
      firstDispatchedAt: new Date(ago(60).getTime() + 30_000),
    })
    await insertCommand(WORKSPACE_A, running, runningAttempt, {
      status: 'succeeded',
      issuedAt: ago(90),
      firstDispatchedAt: ago(89),
    })
    await insertCommand(WORKSPACE_A, running, runningAttempt, {
      status: 'queued',
      issuedAt: ago(5),
    })

    await insertEvent(WORKSPACE_A, running, { status: 'pending' })
    await insertEvent(WORKSPACE_A, running, { status: 'published' })
    await insertEvent(WORKSPACE_A, running, { status: 'failed' })
    await insertEvent(WORKSPACE_A, running, { status: 'pending', archivedAt: ago(1) })

    await insertProjection(WORKSPACE_A, 'external_session', { state: 'active' })
    await insertProjection(WORKSPACE_A, 'external_session', { state: 'active' })
    await insertProjection(WORKSPACE_A, 'external_session', { state: 'closed' })
    await insertProjection(WORKSPACE_A, 'runtime_connection', { status: 'connected' })
    await insertPlan(WORKSPACE_A)
    await insertPlan(WORKSPACE_A)

    await insertLedger(WORKSPACE_A, running, {
      currency: 'USD',
      cost: 1_500_000,
      exact: true,
      recordedAt: ago(60),
    })
    await insertLedger(WORKSPACE_A, running, {
      currency: 'USD',
      cost: 250_000,
      exact: false,
      recordedAt: ago(30),
    })
    await insertLedger(WORKSPACE_A, running, {
      currency: 'USD',
      cost: 9_000_000,
      exact: true,
      recordedAt: ago(48 * 60),
    })
    await insertLedger(WORKSPACE_A, running, {
      currency: 'EUR',
      cost: 7_000,
      exact: true,
      recordedAt: ago(10),
    })

    await insertBudget(
      WORKSPACE_A,
      running,
      budgetState(WORKSPACE_A, running, 'USD', [1_000_000, 500_000])
    )
    await insertBudget(
      WORKSPACE_A,
      reconcile,
      budgetState(WORKSPACE_A, reconcile, 'USD', [2_000_000])
    )
    await insertReceipt(WORKSPACE_A, running)
    await insertReceipt(WORKSPACE_A, reconcile)
  }

  async function seedWorkspaceB() {
    // Louder and older than A in every dimension, so any cross-tenant read shows.
    for (let index = 0; index < 6; index += 1) {
      const execution = await insertExecution(WORKSPACE_B, {
        state: index % 2 === 0 ? 'running' : 'reconciliation_required',
        updatedAt: ago(5000 + index),
        reconciliationRequiredAt: index % 2 === 0 ? null : ago(5000),
      })
      const attempt = await insertAttempt(execution, {
        sequence: 1,
        state: 'running',
        queuedAt: ago(6000),
      })
      const second = await insertAttempt(execution, {
        sequence: 2,
        state: 'queued',
        queuedAt: ago(5500),
      })
      void second
      await insertInteraction(execution, attempt, { state: 'pending', requestedAt: ago(4000) })
      await insertCommand(WORKSPACE_B, execution, attempt, {
        status: 'queued',
        issuedAt: ago(3000),
      })
      await insertEvent(WORKSPACE_B, execution, { status: 'pending' })
      await insertLedger(WORKSPACE_B, execution, {
        currency: 'USD',
        cost: 99_000_000,
        exact: true,
        recordedAt: ago(10),
      })
      await insertBudget(
        WORKSPACE_B,
        execution,
        budgetState(WORKSPACE_B, execution, 'EUR', [77_000_000])
      )
      await insertReceipt(WORKSPACE_B, execution)
      await insertPlan(WORKSPACE_B)
      await insertProjection(WORKSPACE_B, 'external_session', { state: 'active' })
    }
  }

  // ---- Helpers ---------------------------------------------------------------

  const producerFor = (workspaceId, extra = {}) =>
    createPostgresOperationsMeasurementProducer({
      database: application,
      workspaceId,
      now: () => NOW,
      ...extra,
    })

  const pointsOf = (points, name, labels = {}) =>
    points.filter(
      (point) =>
        point.name === name &&
        Object.entries(labels).every(([key, value]) => point.labels?.[key] === value)
    )
  const valueOf = (points, name, labels = {}) => {
    const matches = pointsOf(points, name, labels)
    expect(matches.length).toBeLessThanOrEqual(1)
    return matches[0]?.value
  }

  // Independent per-table aggregates, scoped by a different query shape than the
  // producer's. Row size is pg_column_size of the row value wrapped in a subselect,
  // the shape in which it is stable (a bare aggregate can differ by alignment padding).
  async function independentBytes(workspaceId) {
    const total = async (from, where) =>
      Number(
        (
          await migrationSql.unsafe(
            `select coalesce(sum(b), 0) as bytes from (select pg_column_size(t.*) as b from ${from} t ${where} limit 100000) s`,
            [workspaceId]
          )
        )[0].bytes
      )
    const viaExecution = async (table) =>
      Number(
        (
          await migrationSql.unsafe(
            `select coalesce(sum(b), 0) as bytes from (select pg_column_size(x.*) as b from ${table} x join executions e on e.execution_id = x.execution_id where e.workspace_id = $1 limit 100000) s`,
            [workspaceId]
          )
        )[0].bytes
      )
    return {
      executions: await total('executions', 'where t.workspace_id = $1'),
      'execution-attempts': await viaExecution('execution_attempts'),
      'interaction-requests': await viaExecution('interaction_requests'),
      'runtime-commands': await total('runtime_commands', 'where t.workspace_id = $1'),
      'execution-events': await total('execution_events', 'where t.workspace_id = $1'),
      'execution-plans': await total('execution_plans', 'where t.workspace_id = $1'),
      'runtime-discovery-sessions': await total(
        'runtime_discovery_projections',
        "where t.workspace_id = $1 and t.kind = 'external_session'"
      ),
      'runtime-discovery-connections': await total(
        'runtime_discovery_projections',
        "where t.workspace_id = $1 and t.kind = 'runtime_connection'"
      ),
      'usage-ledger-entries': await total('usage_ledger_entries', 'where t.workspace_id = $1'),
      'usage-budgets': await total('usage_budget_states', 'where t.workspace_id = $1'),
      'usage-effects': await total('usage_operation_receipts', 'where t.workspace_id = $1'),
    }
  }

  /** Holds an exclusive lock until released; resolves once the lock is really held. */
  async function holdExclusiveLock(table) {
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    let acquired
    const locked = new Promise((resolve) => {
      acquired = resolve
    })
    const done = migrationSql.begin(async (transaction) => {
      await transaction.unsafe(`lock table ${table} in access exclusive mode`)
      acquired()
      await held
    })
    await locked
    return { release, done }
  }

  // ---- Tests -----------------------------------------------------------------

  test(
    'measures exact scoped values for the selected workspace only',
    async () => {
      const result = await producerFor(WORKSPACE_A, {
        storageUsdPerGiBMonth: 100_000,
      }).measureDetailed()
      expect(result).toBeDefined()
      for (const namespace of postgresMeasuredNamespaces)
        expect(result.sources[namespace]).toEqual({ status: 'complete' })
      const { points } = result

      const stat = (name, labels, expected) => {
        for (const [statistic, value] of Object.entries(expected))
          expect(valueOf(points, name, { ...labels, statistic })).toBe(value)
      }
      stat(
        operationsMetricNames.queueLatency,
        { stage: 'dispatch' },
        { min: 30_000, median: 30_000, max: 60_000 }
      )
      stat(
        operationsMetricNames.queueLatency,
        { stage: 'wait' },
        { min: 300_000, median: 300_000, max: 1_200_000 }
      )
      stat(
        operationsMetricNames.humanLatency,
        { outcome: 'responded' },
        { min: 600_000, median: 600_000, max: 1_800_000 }
      )
      stat(
        operationsMetricNames.humanLatency,
        { outcome: 'waiting' },
        { min: 900_000, median: 900_000, max: 2_700_000 }
      )
      stat(
        operationsMetricNames.retryAge,
        { kind: 'gap' },
        { min: 3_000_000, median: 3_000_000, max: 3_000_000 }
      )
      stat(
        operationsMetricNames.retryAge,
        { kind: 'current' },
        { min: 7_200_000, median: 7_200_000, max: 7_200_000 }
      )
      stat(
        operationsMetricNames.reconciliationAge,
        {},
        { min: 600_000, median: 1_800_000, max: 3_600_000 }
      )

      expect(valueOf(points, operationsMetricNames.usageCostUsd, { exactness: 'exact' })).toBe(1.5)
      expect(valueOf(points, operationsMetricNames.usageCostUsd, { exactness: 'inexact' })).toBe(
        0.25
      )

      const active = (objectKind) =>
        valueOf(points, operationsMetricNames.activeObjectCount, { object_kind: objectKind })
      expect(active('execution')).toBe(3)
      expect(active('job')).toBe(3)
      expect(active('attempt')).toBe(3)
      expect(active('session')).toBe(2)
      expect(active('approval')).toBe(2)
      expect(active('effect')).toBe(2)

      // Row bytes equal an independent per-table aggregate over workspace A alone.
      const expected = await independentBytes(WORKSPACE_A)
      let total = 0
      for (const [namespace, bytes] of Object.entries(expected)) {
        expect(valueOf(points, operationsMetricNames.storageRetainedBytes, { namespace })).toBe(
          bytes
        )
        total += bytes
      }
      expect(
        valueOf(points, operationsMetricNames.storageRetainedBytes, { namespace: 'total' })
      ).toBe(total)

      // Rewritten bytes exist only where the table has a last-write timestamp.
      expect(
        valueOf(points, operationsMetricNames.storageRewrittenBytes, { namespace: 'executions' })
      ).toBeGreaterThan(0)
      expect(
        valueOf(points, operationsMetricNames.storageRewrittenBytes, { namespace: 'usage-budgets' })
      ).toBeUndefined()
      expect(
        valueOf(points, operationsMetricNames.storageRewrittenBytes, { namespace: 'total' })
      ).toBeUndefined()
      // No baseline yet: growth is unavailable, never estimated.
      expect(pointsOf(points, operationsMetricNames.storageGrowthBytes)).toHaveLength(0)

      const storageUsd = valueOf(points, operationsMetricNames.operatingCostUsd, {
        component: 'storage',
      })
      expect(storageUsd).toBeCloseTo((total / 1024 ** 3) * 100_000, 4)
      expect(
        valueOf(points, operationsMetricNames.operatingCostUsd, { component: 'total' })
      ).toBeCloseTo(storageUsd + usd(3_500_000), 4)
    },
    timeout
  )

  test(
    'workspace B reads its own data and never workspace A',
    async () => {
      const result = await producerFor(WORKSPACE_B).measureDetailed()
      const { points } = result
      const active = (objectKind) =>
        valueOf(points, operationsMetricNames.activeObjectCount, { object_kind: objectKind })
      expect(active('execution')).toBe(6)
      expect(active('job')).toBe(6)
      expect(active('approval')).toBe(6)
      expect(active('effect')).toBe(6)
      expect(active('session')).toBe(6)
      expect(valueOf(points, operationsMetricNames.usageCostUsd, { exactness: 'exact' })).toBe(594)
      // B has only EUR budgets, so no USD operating-cost total is claimed.
      expect(
        valueOf(points, operationsMetricNames.operatingCostUsd, { component: 'total' })
      ).toBeUndefined()
      const expected = await independentBytes(WORKSPACE_B)
      for (const [namespace, bytes] of Object.entries(expected))
        expect([
          namespace,
          valueOf(points, operationsMetricNames.storageRetainedBytes, { namespace }),
        ]).toEqual([namespace, bytes])
    },
    timeout
  )

  test(
    'records stamped with another workspace on in-scope executions count for neither tenant',
    async () => {
      const [attempt] =
        await migrationSql`select attempt_id from execution_attempts where execution_id = ${executionsA.running} limit 1`
      const before = await producerFor(WORKSPACE_A).measureDetailed()
      const beforeBefore = await producerFor(WORKSPACE_B).measureDetailed()
      await insertCommand(WORKSPACE_B, executionsA.running, attempt.attempt_id, {
        status: 'queued',
        issuedAt: ago(1),
      })
      await insertEvent(WORKSPACE_B, executionsA.running, { status: 'pending' })
      try {
        const after = await producerFor(WORKSPACE_A).measureDetailed()
        const afterB = await producerFor(WORKSPACE_B).measureDetailed()
        const active = (result, kind) =>
          valueOf(result.points, operationsMetricNames.activeObjectCount, { object_kind: kind })
        expect(active(after, 'job')).toBe(active(before, 'job'))
        expect(active(after, 'effect')).toBe(active(before, 'effect'))
        expect(active(afterB, 'job')).toBe(active(beforeBefore, 'job'))
        expect(active(afterB, 'effect')).toBe(active(beforeBefore, 'effect'))
      } finally {
        await migrationSql`delete from runtime_commands where execution_id = ${executionsA.running} and workspace_id = ${WORKSPACE_B}`
        await migrationSql`delete from execution_events where execution_id = ${executionsA.running} and workspace_id = ${WORKSPACE_B}`
      }
    },
    timeout
  )

  test(
    'an unknown or unseeded workspace measures zero rows, not another tenant',
    async () => {
      const result = await producerFor('wsp_01JABCDEF0123456789ABCDEFZ').measureDetailed()
      for (const namespace of postgresMeasuredNamespaces)
        expect(result.sources[namespace]).toEqual({ status: 'complete' })
      expect(
        valueOf(result.points, operationsMetricNames.activeObjectCount, {
          object_kind: 'execution',
        })
      ).toBe(0)
      expect(
        valueOf(result.points, operationsMetricNames.storageRetainedBytes, { namespace: 'total' })
      ).toBe(0)
      // No samples means no latency points; absence is not a zero latency.
      expect(pointsOf(result.points, operationsMetricNames.queueLatency)).toHaveLength(0)
      expect(pointsOf(result.points, operationsMetricNames.usageCostUsd)).toHaveLength(0)
    },
    timeout
  )

  test(
    'a source over its scan bound is incomplete and its points are suppressed',
    async () => {
      // Workspace A holds 4 executions and 5 attempts; a bound of 4 truncates
      // attempts, interactions (5), commands (4 fit), events (4 fit) selectively.
      const result = await producerFor(WORKSPACE_A, { maxScanRows: 4 }).measureDetailed()
      expect(result.sources['execution-attempts']).toEqual({
        status: 'incomplete',
        reason: 'row_budget_reached',
      })
      expect(result.sources['interaction-requests']).toEqual({
        status: 'incomplete',
        reason: 'row_budget_reached',
      })
      expect(result.sources.executions).toEqual({ status: 'complete' })
      expect(pointsOf(result.points, operationsMetricNames.retryAge)).toHaveLength(0)
      expect(pointsOf(result.points, operationsMetricNames.humanLatency)).toHaveLength(0)
      expect(
        valueOf(result.points, operationsMetricNames.activeObjectCount, { object_kind: 'attempt' })
      ).toBeUndefined()
      expect(
        valueOf(result.points, operationsMetricNames.activeObjectCount, { object_kind: 'approval' })
      ).toBeUndefined()
      // Complete sources still report; the total and cost need every namespace.
      expect(
        valueOf(result.points, operationsMetricNames.activeObjectCount, {
          object_kind: 'execution',
        })
      ).toBe(3)
      expect(
        valueOf(result.points, operationsMetricNames.storageRetainedBytes, { namespace: 'total' })
      ).toBeUndefined()
      expect(result.baselineCommitted).toBe(false)
    },
    timeout
  )

  test(
    'bounding executions marks every join-anchored source incomplete',
    async () => {
      const result = await producerFor(WORKSPACE_B, { maxScanRows: 3 }).measureDetailed()
      expect(result.sources.executions).toEqual({
        status: 'incomplete',
        reason: 'row_budget_reached',
      })
      for (const namespace of [
        'execution-attempts',
        'interaction-requests',
        'runtime-commands',
        'execution-events',
      ])
        expect(result.sources[namespace]).toEqual({
          status: 'incomplete',
          reason: 'row_budget_reached',
        })
      expect(
        pointsOf(result.points, operationsMetricNames.activeObjectCount, {
          object_kind: 'execution',
        })
      ).toHaveLength(0)
    },
    timeout
  )

  test(
    'only a complete snapshot becomes the growth baseline',
    async () => {
      const producer = producerFor(WORKSPACE_A)
      const first = await producer.measureDetailed()
      expect(first.baselineCommitted).toBe(true)
      const firstTotal = valueOf(first.points, operationsMetricNames.storageRetainedBytes, {
        namespace: 'total',
      })

      // Grow the workspace, then make one source unreadable: the partial pass
      // reports growth for complete namespaces only and must not replace the baseline.
      await insertPlan(WORKSPACE_A)
      await migrationSql`revoke select on usage_budget_states from ${migrationSql(new URL(applicationUrl).username)}`
      const partial = await producer.measureDetailed()
      expect(partial.sources['usage-budgets']).toEqual({
        status: 'unavailable',
        reason: 'permission_denied',
      })
      expect(partial.baselineCommitted).toBe(false)
      expect(
        valueOf(partial.points, operationsMetricNames.storageGrowthBytes, {
          namespace: 'execution-plans',
        })
      ).toBeGreaterThan(0)
      expect(
        valueOf(partial.points, operationsMetricNames.storageGrowthBytes, {
          namespace: 'executions',
        })
      ).toBe(0)
      expect(
        valueOf(partial.points, operationsMetricNames.storageGrowthBytes, { namespace: 'total' })
      ).toBeUndefined()
      expect(
        valueOf(partial.points, operationsMetricNames.storageRetainedBytes, { namespace: 'total' })
      ).toBeUndefined()
      expect(
        pointsOf(partial.points, operationsMetricNames.storageGrowthBytes, {
          namespace: 'usage-budgets',
        })
      ).toHaveLength(0)

      // Recovery: growth is measured against the last COMPLETE snapshot, not the partial one.
      await migrationSql`grant select on usage_budget_states to ${migrationSql(new URL(applicationUrl).username)}`
      const recovered = await producer.measureDetailed()
      expect(recovered.baselineCommitted).toBe(true)
      const recoveredTotal = valueOf(recovered.points, operationsMetricNames.storageRetainedBytes, {
        namespace: 'total',
      })
      expect(
        valueOf(recovered.points, operationsMetricNames.storageGrowthBytes, { namespace: 'total' })
      ).toBe(recoveredTotal - firstTotal)
      expect(recoveredTotal).toBeGreaterThan(firstTotal)
      // Signed shrinkage is preserved.
      await migrationSql`delete from execution_plans where workspace_id = ${WORKSPACE_A} and execution_plan_id in (select execution_plan_id from execution_plans where workspace_id = ${WORKSPACE_A} order by created_at desc limit 1)`
      const shrunk = await producer.measureDetailed()
      expect(
        valueOf(shrunk.points, operationsMetricNames.storageGrowthBytes, {
          namespace: 'execution-plans',
        })
      ).toBeLessThan(0)
    },
    timeout
  )

  test(
    'unreadable and damaged sources degrade honestly with fixed reason codes',
    async () => {
      const username = new URL(applicationUrl).username
      // Permission failure: only usage-budgets degrades, the pass still reports the rest.
      await migrationSql`revoke select on usage_budget_states from ${migrationSql(username)}`
      const denied = await producerFor(WORKSPACE_A, { storageUsdPerGiBMonth: 1 }).measureDetailed()
      expect(denied.sources['usage-budgets']).toEqual({
        status: 'unavailable',
        reason: 'permission_denied',
      })
      expect(
        valueOf(denied.points, operationsMetricNames.activeObjectCount, {
          object_kind: 'execution',
        })
      ).toBe(3)
      expect(
        valueOf(denied.points, operationsMetricNames.operatingCostUsd, { component: 'storage' })
      ).toBeUndefined()
      expect(
        valueOf(denied.points, operationsMetricNames.operatingCostUsd, { component: 'total' })
      ).toBeUndefined()
      expect(JSON.stringify(denied)).not.toContain('usage_budget_states')
      await migrationSql`grant select on usage_budget_states to ${migrationSql(username)}`

      // Damaged budget JSON is reported, never summed.
      const damaged = await insertExecution(WORKSPACE_A, { state: 'completed', updatedAt: ago(3) })
      await insertBudget(WORKSPACE_A, damaged, {
        schemaVersion: 1,
        currency: 'usd',
        reservations: 'broken',
      })
      try {
        const result = await producerFor(WORKSPACE_A, {
          storageUsdPerGiBMonth: 1,
        }).measureDetailed()
        expect(result.sources['usage-budgets']).toEqual({
          status: 'incomplete',
          reason: 'malformed_records',
        })
        expect(
          valueOf(result.points, operationsMetricNames.operatingCostUsd, { component: 'total' })
        ).toBeUndefined()
      } finally {
        await migrationSql`delete from usage_budget_states where execution_id = ${damaged}`
        await migrationSql`delete from executions where execution_id = ${damaged}`
      }

      // A negative or fractional charge is malformed per reservation: it can never offset a
      // valid charge in the sum or surface as a negative cost metric.
      for (const charges of [[-1_000_000, 5_000_000], [-5_000_000], [2_000_000, 0.5]]) {
        const invalid = await insertExecution(WORKSPACE_A, {
          state: 'completed',
          updatedAt: ago(3),
        })
        await insertBudget(WORKSPACE_A, invalid, budgetState(WORKSPACE_A, invalid, 'USD', charges))
        try {
          const result = await producerFor(WORKSPACE_A, {
            storageUsdPerGiBMonth: 1,
          }).measureDetailed()
          expect(result.sources['usage-budgets']).toEqual({
            status: 'incomplete',
            reason: 'malformed_records',
          })
          for (const point of result.points) {
            if (point.name === operationsMetricNames.operatingCostUsd) {
              expect(point.value).toBeGreaterThanOrEqual(0)
            }
          }
          expect(
            valueOf(result.points, operationsMetricNames.operatingCostUsd, { component: 'total' })
          ).toBeUndefined()
        } finally {
          await migrationSql`delete from usage_budget_states where execution_id = ${invalid}`
          await migrationSql`delete from executions where execution_id = ${invalid}`
        }
      }

      // Safe-integer overflow is detected, not wrapped.
      const huge = await insertExecution(WORKSPACE_A, { state: 'completed', updatedAt: ago(3) })
      await insertLedger(WORKSPACE_A, huge, {
        currency: 'USD',
        cost: 9_000_000_000_000_000_000n,
        exact: true,
        recordedAt: ago(1),
      })
      await insertLedger(WORKSPACE_A, huge, {
        currency: 'USD',
        cost: 9_000_000_000_000_000_000n,
        exact: true,
        recordedAt: ago(2),
      })
      try {
        const result = await producerFor(WORKSPACE_A).measureDetailed()
        expect(result.sources['usage-ledger-entries']).toEqual({
          status: 'incomplete',
          reason: 'unsafe_total',
        })
        expect(pointsOf(result.points, operationsMetricNames.usageCostUsd)).toHaveLength(0)
      } finally {
        await migrationSql`delete from usage_ledger_entries where execution_id = ${huge}`
        await migrationSql`delete from executions where execution_id = ${huge}`
      }

      // A negative ledger amount is damage, never a credit that offsets other spend.
      const negative = await insertExecution(WORKSPACE_A, { state: 'completed', updatedAt: ago(3) })
      await insertLedger(WORKSPACE_A, negative, {
        currency: 'USD',
        cost: 3_000_000,
        exact: true,
        recordedAt: ago(1),
      })
      await insertLedger(WORKSPACE_A, negative, {
        currency: 'USD',
        cost: -2_000_000,
        exact: true,
        recordedAt: ago(2),
      })
      try {
        const result = await producerFor(WORKSPACE_A).measureDetailed()
        expect(result.sources['usage-ledger-entries']).toEqual({
          status: 'incomplete',
          reason: 'malformed_records',
        })
        expect(pointsOf(result.points, operationsMetricNames.usageCostUsd)).toHaveLength(0)
      } finally {
        await migrationSql`delete from usage_ledger_entries where execution_id = ${negative}`
        await migrationSql`delete from executions where execution_id = ${negative}`
      }
    },
    timeout
  )

  test(
    'a lock held on one table times out that source only, within the lock timeout',
    async () => {
      const lock = await holdExclusiveLock('usage_operation_receipts')
      try {
        const startedAt = Date.now()
        const result = await producerFor(WORKSPACE_A, { lockTimeoutMs: 200 }).measureDetailed()
        expect(Date.now() - startedAt).toBeLessThan(5000)
        expect(result.sources['usage-effects']).toEqual({
          status: 'unavailable',
          reason: 'lock_timeout',
        })
        expect(result.baselineCommitted).toBe(false)
        expect(
          valueOf(result.points, operationsMetricNames.activeObjectCount, { object_kind: 'job' })
        ).toBe(3)
      } finally {
        lock.release()
        await lock.done
      }
    },
    timeout
  )

  test(
    'join-anchored sources plan nested loops from the bounded executions, never merge or hash joins (even when nested loops are discouraged)',
    async () => {
      // A merge or hash join would read other tenants' child rows to find this
      // workspace's. The bounded lateral shape forbids it whatever the statistics.
      const captured = []
      const client = postgres(applicationUrl, {
        max: 1,
        prepare: false,
        debug: (_connection, query, parameters) => captured.push({ query, parameters }),
      })
      clients.push(client)
      await createPostgresOperationsMeasurementProducer({
        database: drizzle(client, { schema }),
        workspaceId: WORKSPACE_A,
        now: () => NOW,
      }).measureDetailed()
      const joined = captured.filter(({ query }) => /^\s*with ex as/.test(query))
      expect(joined).toHaveLength(4)
      for (const { query, parameters } of joined) {
        // Discourage nested loops so only a structural fence keeps them.
        const [{ 'QUERY PLAN': plan }] = await migrationSql.begin(async (transaction) => {
          await transaction`set local enable_nestloop = off`
          return transaction.unsafe(`explain (format json) ${query}`, parameters)
        })
        const nodes = JSON.stringify(plan)
        expect(nodes).toContain('Nested Loop')
        expect(nodes).not.toContain('Merge Join')
        expect(nodes).not.toContain('Hash Join')
      }
    },
    timeout
  )

  test(
    'each pass is one read-only repeatable-read transaction that cannot write and leaves nothing open',
    async () => {
      const observed = []
      const probing = {
        transaction: (callback, config) =>
          application.transaction(async (transaction) => {
            observed.push({
              readOnly: (await transaction.execute(sql`show transaction_read_only`))[0]
                .transaction_read_only,
              isolation: (await transaction.execute(sql`show transaction_isolation`))[0]
                .transaction_isolation,
              config,
            })
            const before = (
              await transaction.execute(sql`select count(*)::int as n from executions`)
            )[0].n
            let writeError
            try {
              await transaction.transaction(async (savepoint) => {
                await savepoint.execute(
                  sql`delete from executions where workspace_id = ${WORKSPACE_A}`
                )
              })
            } catch (error) {
              writeError = error
            }
            observed.push({ writeCode: writeError?.code ?? writeError?.cause?.code, before })
            return callback(transaction)
          }, config),
      }
      const result = await createPostgresOperationsMeasurementProducer({
        database: probing,
        workspaceId: WORKSPACE_A,
        now: () => NOW,
      }).measureDetailed()
      expect(result).toBeDefined()
      expect(observed[0].readOnly).toBe('on')
      expect(observed[0].isolation).toBe('repeatable read')
      expect(observed[0].config).toEqual({
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      })
      expect(observed[1].writeCode).toBe('25006')
      const [{ n }] = await migrationSql`select count(*)::int as n from executions`
      expect(n).toBe(observed[1].before)
      const open = await migrationSql`select count(*)::int as n from pg_stat_activity
        where datname = ${isolated.name} and state like 'idle in transaction%'`
      expect(open[0].n).toBe(0)
    },
    timeout
  )

  test(
    'emitted attributes are cataloged and bounded; ids, payloads and secrets never appear',
    async () => {
      const recorded = []
      const adapter = {
        add: (name, value, attributes) => recorded.push({ kind: 'add', name, value, attributes }),
        record: (name, value, attributes) =>
          recorded.push({ kind: 'record', name, value, attributes }),
        recordGauge: (name, value, attributes) =>
          recorded.push({ kind: 'gauge', name, value, attributes }),
      }
      const lifecycle = createPostgresRuntimeMeasurements({
        database: application,
        adapter,
        intervalMs: 3_600_000,
        workspaceId: WORKSPACE_A,
        storageUsdPerGiBMonth: 1,
        now: () => NOW,
      })
      lifecycle.start()
      await lifecycle.sample()
      await lifecycle.sample()
      await lifecycle.close()
      expect(recorded.length).toBeGreaterThan(40)
      const serialized = JSON.stringify(recorded)
      for (const forbidden of [
        SECRET,
        WORKSPACE_A,
        WORKSPACE_B,
        executionsA.running,
        'exe_',
        'wsp_',
        'att_',
        'prj_',
      ])
        expect(serialized).not.toContain(forbidden)
      const labelKeys = new Set()
      for (const entry of recorded) {
        expect(Object.values(operationsMetricNames)).toContain(entry.name)
        expect(Number.isFinite(entry.value)).toBe(true)
        expect(entry.attributes['service.name']).toBe('hosted-control-plane')
        for (const key of Object.keys(entry.attributes)) labelKeys.add(key)
        if (entry.attributes.namespace !== undefined)
          expect(operationsStorageNamespaces).toContain(entry.attributes.namespace)
      }
      expect([...labelKeys].toSorted()).toEqual(
        [
          'component',
          'exactness',
          'namespace',
          'object_kind',
          'outcome',
          'service.name',
          'stage',
          'statistic',
          'kind',
        ]
          .filter((key) => labelKeys.has(key))
          .toSorted()
      )
      // Pass volume stays well under the lifecycle's per-pass cap.
      expect(recorded.length).toBeLessThanOrEqual(2 * 512)
    },
    timeout
  )

  test(
    'an unreachable or ended database yields no points and leaks no driver text',
    async () => {
      const dead = postgres('postgres://measure_user:pw-leaky-secret@127.0.0.1:1/missing', {
        max: 1,
        prepare: false,
        connect_timeout: 1,
      })
      const producer = createPostgresOperationsMeasurementProducer({
        database: drizzle(dead, { schema }),
        workspaceId: WORKSPACE_A,
        now: () => NOW,
      })
      await expect(producer.measure()).resolves.toBeUndefined()
      await expect(producer.measureDetailed()).resolves.toBeUndefined()
      await dead.end({ timeout: 1 })

      const recorded = []
      const lifecycle = createPostgresRuntimeMeasurements({
        database: drizzle(dead, { schema }),
        adapter: {
          add: (...args) => recorded.push(args),
          record: (...args) => recorded.push(args),
          recordGauge: (...args) => recorded.push(args),
        },
        intervalMs: 3_600_000,
        workspaceId: WORKSPACE_A,
      })
      lifecycle.start()
      await lifecycle.sample()
      await lifecycle.close()
      expect(recorded).toEqual([])
    },
    timeout
  )

  test(
    'close drains an in-flight pass, then no further queries run and the pool ends cleanly',
    async () => {
      const pool = postgres(applicationUrl, { max: 2, prepare: false })
      const recorded = []
      const adapter = {
        add: (...args) => recorded.push(args),
        record: (...args) => recorded.push(args),
        recordGauge: (...args) => recorded.push(args),
      }
      const lock = await holdExclusiveLock('usage_operation_receipts')
      const lifecycle = createPostgresRuntimeMeasurements({
        database: drizzle(pool, { schema }),
        adapter,
        intervalMs: 3_600_000,
        workspaceId: WORKSPACE_A,
        lockTimeoutMs: 400,
        now: () => NOW,
      })
      lifecycle.start()
      const closing = lifecycle.close()
      await closing
      const emitted = recorded.length
      expect(emitted).toBeGreaterThan(0)
      lock.release()
      await lock.done
      await lifecycle.sample()
      expect(recorded.length).toBe(emitted)
      await pool.end({ timeout: 5 })
      const open = await migrationSql`select count(*)::int as n from pg_stat_activity
        where datname = ${isolated.name} and usename = ${new URL(applicationUrl).username}
          and state like 'idle in transaction%'`
      expect(open[0].n).toBe(0)
    },
    timeout
  )

  test(
    'concurrent callers share one in-flight pass',
    async () => {
      const producer = producerFor(WORKSPACE_A)
      const [first, second] = await Promise.all([
        producer.measureDetailed(),
        producer.measureDetailed(),
      ])
      expect(second).toBe(first)
    },
    timeout
  )
})
