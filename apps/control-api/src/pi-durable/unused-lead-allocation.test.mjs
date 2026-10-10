import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  SqlitePersistenceProvider,
  SqliteExecutionRepository,
  SqliteExecutionPlanRepository,
  SqliteContextPackageRepository,
  SqliteDurableUsageStore,
} from '@control-plane/sqlite-persistence'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { createUnusedPiLeadAllocationReleaser } from './unused-lead-allocation.ts'

const at = '2026-10-08T00:00:00.000Z'
const later = '2026-10-08T01:00:00.000Z'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const unsafe = 'PI_LEAD_UNUSED_ALLOCATION_UNSAFE'

async function fixture(body) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-unused-allocation-'))
  const path = join(directory, 'state.sqlite')
  let provider
  const open = async () => {
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    const executions = new SqliteExecutionRepository(provider)
    const store = new SqliteDurableUsageStore(provider)
    const ledger = new DurableUsageLedger({ store, now: () => later })
    const transaction = (workspaceId, operation) =>
      provider.transaction((nativeTransaction) =>
        SqliteDurableUsageStore.withTransaction(nativeTransaction, workspaceId, (boundStore) => {
          // All repository calls and ledger mutations use this one native transaction.
          const bound = new Proxy(provider, {
            get(target, property) {
              if (property === 'transaction')
                return (repositoryOperation) => repositoryOperation(nativeTransaction)
              const value = Reflect.get(target, property)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
          return operation({
            executions: new SqliteExecutionRepository(bound),
            ledger: new DurableUsageLedger({ store: boundStore, now: () => later }),
          })
        })
      )
    return {
      executions,
      ledger,
      store,
      transaction,
      release: createUnusedPiLeadAllocationReleaser({ transaction, now: () => later }),
    }
  }
  try {
    let repositories = await open()
    const input = createExecutionPlanTestFixtureInputs()
    const plan = new ExecutionPlanCompiler('1.0.0').compile(input)
    await new SqliteContextPackageRepository(provider).put(input.contextPackage)
    await new SqliteExecutionPlanRepository(provider).put(plan)
    const lifecycle = new ExecutionLifecycleService(repositories.executions)
    const execution = await lifecycle.createExecution({
      executionId,
      correlation: plan.correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      acceptedAt: at,
      deadlineAt: later,
    })
    await lifecycle.createAttempt({
      executionId,
      attemptId,
      expectedExecutionVersion: execution.version,
      queuedAt: at,
    })
    const budget = {
      schemaVersion: 1,
      workspaceId: plan.correlation.workspaceId,
      executionId,
      attemptId,
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      reservationKey: `runtime-attempt:${attemptId}`,
      currency: 'USD',
      maximumMicrounits: 1000,
      maximumTokens: 100,
    }
    await repositories.ledger.openBudget({
      workspaceId: budget.workspaceId,
      executionId,
      currency: budget.currency,
      maximumMicrounits: budget.maximumMicrounits,
      maximumTokens: budget.maximumTokens,
      source: { sourceId: executionId, idempotencyKey: 'fixture:budget' },
    })
    await repositories.ledger.reserve({
      workspaceId: budget.workspaceId,
      executionId,
      attemptId,
      reservationKey: budget.reservationKey,
      maximumMicrounits: budget.maximumMicrounits,
      maximumTokens: budget.maximumTokens,
      source: { sourceId: attemptId, idempotencyKey: `${budget.reservationKey}:reserve` },
    })
    const admission = {
      schemaVersion: 'pi-lead-authority/v1',
      intentId: 'f643a115-617d-4bae-8d52-cfe458c0b8ac',
      workspaceId: budget.workspaceId,
      allowedPrincipalIds: ['svc_adea'],
      admissionDigest: `sha256:${'a'.repeat(64)}`,
      deadlineAt: later,
      admittedAttempt: {
        executionId,
        attemptId,
        executionPlanId: plan.executionPlanId,
        executionPlanDigest: plan.contentDigest,
      },
      startRequest: {
        executionId,
        attemptId,
        idempotencyKey: 'fixture:start',
        executionPlan: plan,
        attemptBudget: budget,
      },
    }
    await body({
      ...repositories,
      admission,
      budget,
      lifecycle,
      reopen: async () => {
        await provider.close()
        repositories = await open()
        return repositories
      },
      snapshot: async () => ({
        execution: await repositories.executions.getExecution(executionId),
        attempt: await repositories.executions.getAttempt(attemptId),
        entries: await repositories.ledger.entries(budget.workspaceId, executionId),
      }),
    })
  } finally {
    await provider?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('unused queued allocation cancels canonical records and releases once across physical SQLite reopen', async () =>
  fixture(async (f) => {
    await f.release(f.admission)
    const before = await f.snapshot()
    expect(before.execution.state).toBe('cancelled')
    expect(before.attempt.state).toBe('cancelled')
    expect(before.entries.filter((entry) => entry.kind === 'release')).toHaveLength(1)
    expect(before.entries.filter((entry) => entry.kind === 'settlement')).toHaveLength(1)
    const reopened = await f.reopen()
    await reopened.release(f.admission)
    await reopened.release(f.admission)
    expect(await f.snapshot()).toEqual(before)
    const summary = await reopened.ledger.summary(f.budget.workspaceId, executionId)
    expect(summary.reservedMicrounits).toBe(0)
    expect(summary.availableMicrounits).toBe(1000)
    expect(summary.availableTokens).toBe(100)
  }))

test.each(['workspace', 'plan', 'money', 'tokens', 'currency'])(
  'changed %s pin cannot release canonical allocation',
  async (fault) =>
    fixture(async (f) => {
      const changed = structuredClone(f.admission)
      if (fault === 'workspace') changed.workspaceId = 'wsp_01JABCDEF0123456789ABCDEFA'
      if (fault === 'plan') changed.admittedAttempt.executionPlanDigest = `sha256:${'b'.repeat(64)}`
      if (fault === 'money') changed.startRequest.attemptBudget.maximumMicrounits--
      if (fault === 'tokens') changed.startRequest.attemptBudget.maximumTokens--
      if (fault === 'currency') changed.startRequest.attemptBudget.currency = 'EUR'
      const before = await f.snapshot()
      await expect(f.release(changed)).rejects.toThrow(unsafe)
      expect(await f.snapshot()).toEqual(before)
    })
)

test.each(['starting', 'running', 'reconciliation_required', 'cancelled'])(
  'unowned %s attempt cannot be released',
  async (state) =>
    fixture(async (f) => {
      const attempt = await f.executions.getAttempt(attemptId)
      await f.lifecycle.transitionAttempt({
        attemptId,
        expectedVersion: attempt.version,
        to: state,
        transitionedAt: later,
        ...(state === 'reconciliation_required'
          ? { failure: { classification: 'unknown', code: 'AMBIGUOUS' } }
          : {}),
      })
      const before = await f.snapshot()
      await expect(f.release(f.admission)).rejects.toThrow(unsafe)
      expect(await f.snapshot()).toEqual(before)
    })
)

test.each(['open', 'settled'])(
  'any %s physical model hold history keeps allocation unavailable to unused cleanup',
  async (status) =>
    fixture(async (f) => {
      const hold = {
        workspaceId: f.budget.workspaceId,
        executionId,
        attemptId,
        reservationKey: f.budget.reservationKey,
        modelCallId: 'mdc_01JABCDEF0123456789ABCDEFG',
        maximumMicrounits: 10,
        maximumTokens: 10,
        fundingSource: 'byo_api',
        priceSnapshotDigest: `sha256:${'a'.repeat(64)}`,
        requestDigest: `sha256:${'b'.repeat(64)}`,
        source: { sourceId: 'fixture:model', idempotencyKey: 'fixture:model:reserve' },
      }
      await f.ledger.reserveModelRequestForDispatch(hold)
      if (status === 'settled')
        await f.ledger.settleModelRequest({
          workspaceId: hold.workspaceId,
          executionId,
          attemptId,
          reservationKey: hold.reservationKey,
          modelCallId: hold.modelCallId,
          costMicrounits: 0,
          tokens: 0,
          source: { sourceId: 'fixture:model', idempotencyKey: 'fixture:model:settle' },
        })
      const before = await f.snapshot()
      const reopened = await f.reopen()
      await expect(reopened.release(f.admission)).rejects.toThrow(unsafe)
      expect(await f.snapshot()).toEqual(before)
    })
)

test('unused cleanup refuses an obsolete latest attempt after the prior allocation was independently released', async () =>
  fixture(async (f) => {
    await f.ledger.settle({
      workspaceId: f.budget.workspaceId,
      executionId,
      reservationKey: f.budget.reservationKey,
      source: { sourceId: 'fixture:other-owner', idempotencyKey: 'fixture:other-owner:settle' },
    })
    const execution = await f.executions.getExecution(executionId)
    await f.lifecycle.createAttempt({
      executionId,
      attemptId: 'att_01JABCDEF0123456789ABCDEFA',
      expectedExecutionVersion: execution.version,
      queuedAt: later,
    })
    const before = await f.snapshot()
    await expect(f.release(f.admission)).rejects.toThrow(unsafe)
    expect(await f.snapshot()).toEqual(before)
  }))

test('queued attempts with a retained runtime session are not unused', async () =>
  fixture(async (f) => {
    let attempt = await f.executions.getAttempt(attemptId)
    await f.executions.compareAndSetAttempt(attempt.version, {
      ...attempt,
      version: attempt.version + 1,
      runtime: { externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG' },
    })
    const before = await f.snapshot()
    await expect(f.release(f.admission)).rejects.toThrow(unsafe)
    expect(await f.snapshot()).toEqual(before)
  }))

test('concurrent cleanup replays one cancellation and one durable unused settlement', async () =>
  fixture(async (f) => {
    await Promise.all([f.release(f.admission), f.release(f.admission)])
    const snapshot = await f.snapshot()
    expect(snapshot.execution.version).toBe(3)
    expect(snapshot.attempt.version).toBe(2)
    expect(snapshot.entries.filter((entry) => entry.kind === 'release')).toHaveLength(1)
    expect(snapshot.entries.filter((entry) => entry.kind === 'settlement')).toHaveLength(1)
  }))

test('failure after canonical cancellation rolls back records and ledger before physical retry', async () =>
  fixture(async (f) => {
    const canary = 'PRIVATE_FAILURE_MUST_NOT_ESCAPE'
    const release = createUnusedPiLeadAllocationReleaser({
      now: () => later,
      transaction: (workspace, operation) =>
        f.transaction(workspace, (resources) => {
          const ledger = new Proxy(resources.ledger, {
            get(target, property) {
              if (property === 'settle')
                return async () => {
                  expect((await resources.executions.getExecution(executionId)).state).toBe(
                    'cancelled'
                  )
                  expect((await resources.executions.getAttempt(attemptId)).state).toBe('cancelled')
                  throw new Error(canary)
                }
              const value = Reflect.get(target, property)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
          return operation({ ...resources, ledger })
        }),
    })
    const before = await f.snapshot()
    await expect(release(f.admission)).rejects.toThrow(unsafe)
    expect(await f.snapshot()).toEqual(before)
    const reopened = await f.reopen()
    await reopened.release(f.admission)
    expect((await f.snapshot()).attempt.state).toBe('cancelled')
    expect(JSON.stringify(await f.snapshot())).not.toContain(canary)
  }))
