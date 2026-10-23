import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { DelegationService } from '@control-plane/orchestration'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { SqliteContextPackageRepository } from './repositories-extra.ts'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteExecutionRepository, SqliteExecutionPlanRepository } from './repositories.ts'
import { SqliteDelegationRepository } from './delegation-repository.ts'
import { SqliteDelegationEventPublisher } from './delegation-event-publisher.ts'
import { recordId } from './record-storage.ts'
import { snapshotNamespaces, sweepSqliteRetention } from './retention-sweep.fixture.mjs'
import { missingPins, pinSources } from './receipt-pin-sources.fixture.mjs'

const ids = {
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
}

const outcome = {
  delegationId: ids.delegationId,
  childAttemptId: ids.childAttemptId,
  state: 'completed',
  observedAt: '2026-08-25T18:03:00.000Z',
  terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'delegation-terminal-receipt-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  await provider.migrate()
  const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(
    createExecutionPlanTestFixtureInputs()
  )
  const contexts = new SqliteContextPackageRepository(provider)
  const plans = new SqliteExecutionPlanRepository(provider)
  await contexts.put(contextPackageSerializationFixtures.futurePi)
  await plans.put(parentPlan)
  const lifecycle = new ExecutionLifecycleService(new SqliteExecutionRepository(provider))
  await lifecycle.createExecution({
    executionId: ids.parentExecutionId,
    correlation: parentPlan.correlation,
    executionPlan: {
      executionPlanId: parentPlan.executionPlanId,
      contentDigest: parentPlan.contentDigest,
      schemaVersion: parentPlan.schemaVersion,
    },
    acceptedAt: '2026-08-25T18:00:00.000Z',
  })
  const childContext = deriveContextPackage(contextPackageSerializationFixtures.futurePi, {
    objective: 'Complete focused research',
    allowedStateItemIds: [],
    allowedArtifactIds: [],
    budgets: { maximumBytes: 512, maximumTokens: 128 },
    successCriteria: ['Return evidence'],
    returnContract: { contractRef: 'contract://adapter-result/v1' },
    compiledAt: '2026-08-25T18:01:00.000Z',
  })
  await contexts.put(childContext)
  const initial = new DelegationService({
    delegations: new SqliteDelegationRepository(provider),
    lifecycle,
    plans,
    events: { async publish() {} },
  })
  await initial.delegate({
    delegationId: ids.delegationId,
    parentExecutionId: ids.parentExecutionId,
    childExecutionId: ids.childExecutionId,
    role: 'researcher',
    profileVersionId: parentPlan.profile.profileVersionId,
    objective: 'Research the bounded question',
    parentPlan,
    childPlan: {
      correlation: {
        ...parentPlan.correlation,
        taskId: 'tsk_01JBBCDEF0123456789ABCDEFG',
        requestId: 'req_01JBBCDEF0123456789ABCDEFG',
      },
      contextPackage: childContext,
      constraints: parentPlan.constraints,
      runtimeRequirements: parentPlan.runtimeRequirements,
      outputContract: parentPlan.outputContract,
      compiledAt: '2026-08-25T18:01:00.000Z',
    },
    policy: {
      cancellation: 'cascade',
      deadline: 'bounded_by_parent',
      failure: 'retry',
      maximumRetries: 2,
    },
    acceptedAt: '2026-08-25T18:01:00.000Z',
  })
  await initial.dispatchChild({
    delegationId: ids.delegationId,
    childAttemptId: ids.childAttemptId,
    runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
    dispatchedAt: '2026-08-25T18:02:00.000Z',
  })
  await initial.recordChildProgress({
    ...outcome,
    state: 'running',
    terminalResultRef: undefined,
    observedAt: '2026-08-25T18:02:10.000Z',
  })
  return {
    get provider() {
      return provider
    },
    get repository() {
      return new SqliteDelegationRepository(provider)
    },
    get inbox() {
      return new SqliteDelegationEventPublisher(provider, ids.parentExecutionId)
    },
    service(events) {
      return new DelegationService({
        delegations: new SqliteDelegationRepository(provider),
        lifecycle: new ExecutionLifecycleService(new SqliteExecutionRepository(provider)),
        plans: new SqliteExecutionPlanRepository(provider),
        events,
      })
    },
    async reopen() {
      await provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
    },
    async close() {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('CAS-before-publication crash retains the exact terminal receipt and repairs after reopen', async () => {
  const f = await fixture()
  try {
    await expect(
      f
        .service({
          async publish() {
            throw new Error('crash before publication')
          },
        })
        .recordChildProgress(outcome)
    ).rejects.toThrow('crash before publication')
    const pending = await f.repository.get(ids.delegationId)
    const receipt = await f.repository.getTerminalReceipt(ids.delegationId)
    expect(pending.state).toBe('completed')
    expect(receipt.status).toBe('pending')
    expect(receipt.event.details).toEqual({
      state: 'completed',
      childAttemptId: ids.childAttemptId,
      terminalResultRef: outcome.terminalResultRef,
    })
    expect(await f.inbox.list()).toEqual([])
    await f.reopen()
    expect(await f.repository.getTerminalReceipt(ids.delegationId)).toEqual(receipt)
    await Promise.all([
      f.repository.recoverTerminalPublication(ids.delegationId, f.inbox),
      f.repository.recoverTerminalPublication(ids.delegationId, f.inbox),
    ])
    expect(await f.inbox.list()).toEqual([receipt.event])
    expect((await f.repository.getTerminalReceipt(ids.delegationId)).status).toBe('published')
    await f.service(f.inbox).recordChildProgress(outcome)
    expect(await f.inbox.list()).toEqual([receipt.event])
  } finally {
    await f.close()
  }
})

test('the terminal writer alone pins the lead and the child, before and after publication', async () => {
  const f = await fixture()
  try {
    // Delegating and dispatching write no admission, mapping or lookup receipt here,
    // so the terminal writer is the only source of these pins.
    expect(await pinSources(f.provider)).toEqual({})
    await expect(
      f
        .service({
          async publish() {
            throw new Error('crash before publication')
          },
        })
        .recordChildProgress(outcome)
    ).rejects.toThrow('crash before publication')
    const expected = {
      [`execution:${ids.parentExecutionId}`]: ['delegation-terminal-receipts'],
      [`execution:${ids.childExecutionId}`]: ['delegation-terminal-receipts'],
    }
    expect(await pinSources(f.provider)).toEqual(expected)
    await f.repository.recoverTerminalPublication(ids.delegationId, f.inbox)
    expect((await f.repository.getTerminalReceipt(ids.delegationId)).status).toBe('published')
    expect(await pinSources(f.provider)).toEqual(expected)
    expect(await missingPins(f.provider)).toEqual({})
  } finally {
    await f.close()
  }
})

test('lost publisher response leaves a pending receipt and replay converges on one inbox event', async () => {
  const f = await fixture()
  try {
    const inbox = f.inbox
    await expect(
      f
        .service({
          async publish(event, key) {
            await inbox.publish(event, key)
            throw new Error('lost response')
          },
        })
        .recordChildProgress(outcome)
    ).rejects.toThrow('lost response')
    expect((await f.repository.getTerminalReceipt(ids.delegationId)).status).toBe('pending')
    expect(await f.inbox.list()).toHaveLength(1)
    await f.reopen()
    await f.repository.recoverTerminalPublication(ids.delegationId, f.inbox)
    expect(await f.inbox.list()).toHaveLength(1)
    expect((await f.repository.get(ids.delegationId)).terminalPublication.status).toBe('published')
  } finally {
    await f.close()
  }
})

test('terminal CAS rollback retains neither the outcome nor the publication receipt', async () => {
  const f = await fixture()
  try {
    const before = await f.repository.get(ids.delegationId)
    const failing = new SqliteDelegationRepository({
      transaction(operation) {
        return f.provider.transaction((tx) =>
          operation({
            get: tx.get.bind(tx),
            list: tx.list.bind(tx),
            async put(write) {
              if (write.namespace === 'delegations') throw new Error('terminal write failed')
              return tx.put(write)
            },
          })
        )
      },
    })
    await expect(
      failing.compareAndSet(before.revision, {
        ...before,
        state: 'completed',
        revision: before.revision + 1,
        updatedAt: outcome.observedAt,
        terminalResultRef: outcome.terminalResultRef,
        terminalConclusion: 'Exact conclusion must roll back with its receipt.',
        terminalPublication: {
          status: 'pending',
          idempotencyKey: `delegation:${ids.delegationId}:terminal`,
        },
      })
    ).rejects.toThrow('terminal write failed')
    expect(await f.repository.get(ids.delegationId)).toEqual(before)
    expect(await f.repository.getTerminalReceipt(ids.delegationId)).toBeUndefined()
    expect(await f.inbox.list()).toEqual([])
  } finally {
    await f.close()
  }
})

test('terminal receipts reject stale CAS, changed outcomes and removal of the retained intent', async () => {
  const f = await fixture()
  try {
    await expect(
      f
        .service({
          async publish() {
            throw new Error('unavailable')
          },
        })
        .recordChildProgress(outcome)
    ).rejects.toThrow('unavailable')
    const pending = await f.repository.get(ids.delegationId)
    expect(await f.repository.compareAndSet(pending.revision - 1, pending)).toBe(false)
    for (const patch of [
      { terminalResultRef: 'art_01JDBCDEF0123456789ABCDEFG' },
      { terminalConclusion: 'Unattested historical conclusion.' },
      { updatedAt: '2026-08-25T18:04:00.000Z' },
      { childAttemptId: 'att_01JDBCDEF0123456789ABCDEFG' },
      { terminalPublication: undefined },
    ])
      await expect(
        f.repository.compareAndSet(pending.revision, {
          ...pending,
          revision: pending.revision + 1,
          ...patch,
        })
      ).rejects.toThrow('DELEGATION_TERMINAL_RECEIPT_CONFLICT')
    expect(await f.repository.get(ids.delegationId)).toEqual(pending)
    expect((await f.repository.getTerminalReceipt(ids.delegationId)).status).toBe('pending')
    expect(await f.inbox.list()).toEqual([])
  } finally {
    await f.close()
  }
})

test('recovery refuses corrupt receipts before publication and never invents legacy outcomes', async () => {
  const f = await fixture()
  try {
    const legacy = await f.repository.get(ids.delegationId)
    await expect(
      f.repository.recoverTerminalPublication(ids.delegationId, f.inbox)
    ).rejects.toThrow('DELEGATION_TERMINAL_RECEIPT_MISSING')
    expect(await f.repository.get(ids.delegationId)).toEqual(legacy)
    await expect(
      f
        .service({
          async publish() {
            throw new Error('unavailable')
          },
        })
        .recordChildProgress(outcome)
    ).rejects.toThrow('unavailable')
    await f.provider.transaction(async (tx) => {
      const row = await tx.get('delegation-terminal-receipts', recordId(ids.delegationId))
      await tx.put({
        namespace: row.namespace,
        id: row.id,
        expectedRevision: row.revision,
        value: {
          ...row.value,
          event: { ...row.value.event, parentExecutionId: 'exe_01JDBCDEF0123456789ABCDEFG' },
        },
      })
    })
    await expect(
      f.repository.recoverTerminalPublication(ids.delegationId, f.inbox)
    ).rejects.toThrow('DELEGATION_TERMINAL_RECEIPT_CONFLICT')
    expect(await f.inbox.list()).toEqual([])
  } finally {
    await f.close()
  }
})

for (const terminal of [
  { state: 'failed', failureCode: 'CHILD_FAILED', resolution: 'fail_parent' },
  { state: 'cancelled', reason: 'parent_cancelled' },
])
  test(`${terminal.state} outcomes retain and recover their exact publication details`, async () => {
    const f = await fixture()
    try {
      const current = await f.repository.get(ids.delegationId)
      const next = {
        ...current,
        state: terminal.state,
        updatedAt: outcome.observedAt,
        revision: current.revision + 1,
        ...(terminal.failureCode ? { failureCode: terminal.failureCode } : {}),
        terminalPublication: {
          status: 'pending',
          idempotencyKey: `delegation:${ids.delegationId}:terminal`,
          ...(terminal.resolution ? { resolution: terminal.resolution } : {}),
          ...(terminal.reason ? { reason: terminal.reason } : {}),
        },
      }
      expect(await f.repository.compareAndSet(current.revision, next)).toBe(true)
      const receipt = await f.repository.getTerminalReceipt(ids.delegationId)
      await f.reopen()
      await f.repository.recoverTerminalPublication(ids.delegationId, f.inbox)
      expect(await f.inbox.list()).toEqual([receipt.event])
      expect(receipt.event.details).toMatchObject({
        state: terminal.state,
        ...(terminal.failureCode
          ? { failureCode: terminal.failureCode, resolution: terminal.resolution }
          : { reason: terminal.reason }),
      })
    } finally {
      await f.close()
    }
  })

test('legacy pending intents acquire a complete receipt but legacy rows without intent do not', async () => {
  const f = await fixture()
  try {
    await expect(
      f
        .service({
          async publish() {
            throw new Error('unavailable')
          },
        })
        .recordChildProgress(outcome)
    ).rejects.toThrow('unavailable')
    const retained = await f.repository.getTerminalReceipt(ids.delegationId)
    await f.provider.transaction((tx) =>
      tx.delete('delegation-terminal-receipts', recordId(ids.delegationId))
    )
    await f.reopen()
    expect(await f.repository.getTerminalReceipt(ids.delegationId)).toBeUndefined()
    await f.repository.recoverTerminalPublication(ids.delegationId, f.inbox)
    expect(await f.inbox.list()).toEqual([retained.event])
    expect((await f.repository.getTerminalReceipt(ids.delegationId)).status).toBe('published')
  } finally {
    await f.close()
  }
})

test('retention sweeps and a restart leave a pending receipt repairable and a published one retained', async () => {
  const f = await fixture()
  try {
    await expect(
      f
        .service({
          async publish() {
            throw new Error('crash before publication')
          },
        })
        .recordChildProgress(outcome)
    ).rejects.toThrow('crash before publication')
    const pending = await f.repository.getTerminalReceipt(ids.delegationId)
    // The lead is finished as well, so both owners are old enough to be candidates.
    await f.provider.transaction(async (tx) => {
      const row = await tx.get('executions', recordId(ids.parentExecutionId))
      await tx.put({
        namespace: row.namespace,
        id: row.id,
        expectedRevision: row.revision,
        value: { ...row.value, state: 'completed', terminalAt: '2026-08-25T18:04:00.000Z' },
      })
    })
    const watched = [
      'delegations',
      'delegation-terminal-receipts',
      'executions',
      'execution-attempts',
      'execution-plans',
    ]
    const before = await snapshotNamespaces(f.provider, watched)
    const future = new Date('2030-01-01T00:00:00.000Z')
    await sweepSqliteRetention(f.provider, future)
    expect(await snapshotNamespaces(f.provider, watched)).toEqual(before)

    await f.reopen()
    expect(await snapshotNamespaces(f.provider, watched)).toEqual(before)
    expect(await f.repository.getTerminalReceipt(ids.delegationId)).toEqual(pending)
    await f.repository.recoverTerminalPublication(ids.delegationId, f.inbox)
    expect(await f.inbox.list()).toEqual([pending.event])

    // Publication is resolved, but no retention period applies to the receipt.
    const published = await snapshotNamespaces(f.provider, watched)
    expect(published['delegation-terminal-receipts'][0].value.status).toBe('published')
    await sweepSqliteRetention(f.provider, future)
    expect(await snapshotNamespaces(f.provider, watched)).toEqual(published)
    await f.reopen()
    expect(await snapshotNamespaces(f.provider, watched)).toEqual(published)
    expect(await f.inbox.list()).toEqual([pending.event])
  } finally {
    await f.close()
  }
})

test('bounded canonical child conclusion commits with its receipt and replays unchanged after reopen', async () => {
  const f = await fixture()
  const completed = { ...outcome, conclusion: 'The bounded child finished its assigned work.' }
  try {
    await expect(
      f
        .service({
          async publish() {
            throw new Error('publication interrupted')
          },
        })
        .recordChildProgress(completed)
    ).rejects.toThrow('publication interrupted')
    const record = await f.repository.get(ids.delegationId)
    const receipt = await f.repository.getTerminalReceipt(ids.delegationId)
    expect(record.state).toBe('completed')
    expect(record.terminalConclusion).toBe(completed.conclusion)
    expect(receipt.status).toBe('pending')
    expect(receipt.event.details.conclusion).toBe(completed.conclusion)
    expect(receipt.event.details.childAttemptId).toBe(ids.childAttemptId)
    expect(receipt.event.details.terminalResultRef).toBe(outcome.terminalResultRef)
    expect(await missingPins(f.provider)).toEqual({})
    await f.reopen()
    expect(await f.repository.getTerminalReceipt(ids.delegationId)).toEqual(receipt)
    await Promise.all([
      f.repository.recoverTerminalPublication(ids.delegationId, f.inbox),
      f.repository.recoverTerminalPublication(ids.delegationId, f.inbox),
    ])
    expect(await f.inbox.list()).toEqual([receipt.event])
    await f.service(f.inbox).recordChildProgress(completed)
    expect(await f.inbox.list()).toEqual([receipt.event])
  } finally {
    await f.close()
  }
})

test('a retained canonical conclusion cannot be changed or removed before or after publication', async () => {
  const f = await fixture()
  const completed = { ...outcome, conclusion: 'Exact retained child conclusion.' }
  try {
    await expect(
      f
        .service({
          async publish() {
            throw new Error('publication interrupted')
          },
        })
        .recordChildProgress(completed)
    ).rejects.toThrow('publication interrupted')
    for (const published of [false, true]) {
      if (published) await f.repository.recoverTerminalPublication(ids.delegationId, f.inbox)
      const before = await f.repository.get(ids.delegationId)
      const receipt = await f.repository.getTerminalReceipt(ids.delegationId)
      for (const terminalConclusion of [undefined, 'A changed conclusion.']) {
        await expect(
          f.repository.compareAndSet(before.revision, {
            ...before,
            revision: before.revision + 1,
            terminalConclusion,
          })
        ).rejects.toThrow('DELEGATION_TERMINAL_RECEIPT_CONFLICT')
        expect(await f.repository.get(ids.delegationId)).toEqual(before)
        expect(await f.repository.getTerminalReceipt(ids.delegationId)).toEqual(receipt)
      }
      expect(await f.inbox.list()).toEqual(published ? [receipt.event] : [])
    }
  } finally {
    await f.close()
  }
})
