// CP #1024: real SQLite close/reopen recovery without callback redelivery.
import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFixture,
  delegationInput,
  ids,
} from '../packages/orchestration/src/delegation-fixtures.mjs'
import { DelegationService } from '@control-plane/orchestration'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { SqlitePersistenceProvider } from '../packages/sqlite-persistence/src/provider.ts'
import {
  SqliteExecutionRepository,
  SqliteExecutionPlanRepository,
} from '../packages/sqlite-persistence/src/repositories.ts'
import { SqliteContextPackageRepository } from '../packages/sqlite-persistence/src/repositories-extra.ts'
import { SqliteDelegationRepository } from '../packages/sqlite-persistence/src/delegation-repository.ts'
import { SqliteDelegationEventPublisher } from '../packages/sqlite-persistence/src/delegation-event-publisher.ts'
const storage = (provider) => ({
  executions: new SqliteExecutionRepository(provider),
  plans: new SqliteExecutionPlanRepository(provider),
  contexts: new SqliteContextPackageRepository(provider),
  delegations: new SqliteDelegationRepository(provider),
  events: new SqliteDelegationEventPublisher(provider, ids.parentExecutionId),
})
const waiting = {
  delegationId: ids.delegationId,
  childAttemptId: ids.childAttemptId,
  state: 'awaiting_input',
  observedAt: '2026-08-25T18:02:10.000Z',
  interaction: { interactionId: 'int_01JBBCDEF0123456789ABCDEFG', kind: 'input' },
}
for (const boundary of ['before-wait-record', 'before-inbox', 'after-inbox-before-ack']) {
  test(`SQLite interaction publication closes/reopens at ${boundary}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp1024-interaction-reopen-'))
    const path = join(directory, 'state.sqlite')
    let provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const first = storage(provider)
      const f = await createFixture(undefined, first)
      const input = delegationInput(f)
      await first.contexts.put(input.childPlan.contextPackage)
      await f.service.delegate(input)
      await f.service.dispatchChild({
        delegationId: ids.delegationId,
        childAttemptId: ids.childAttemptId,
        runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
        dispatchedAt: '2026-08-25T18:02:00.000Z',
      })
      await f.service.recordChildProgress({
        ...waiting,
        state: 'running',
        interaction: undefined,
        observedAt: '2026-08-25T18:02:05.000Z',
      })
      const interrupted = new DelegationService({
        ...first,
        lifecycle: f.lifecycle,
        delegations: {
          get: (id) => first.delegations.get(id),
          compareAndSet: (revision, record) => {
            if (
              (boundary === 'before-wait-record' && record.state === 'awaiting_input') ||
              (boundary === 'after-inbox-before-ack' &&
                record.interactionPublications?.some((x) => x.status === 'published'))
            )
              throw new Error('synthetic-crash')
            return first.delegations.compareAndSet(revision, record)
          },
        },
        events: {
          async publish(event, key) {
            if (boundary === 'before-inbox') throw new Error('synthetic-crash')
            await first.events.publish(event, key)
          },
        },
      })
      await expect(interrupted.recordChildProgress(waiting)).rejects.toThrow('synthetic-crash')
      await provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const reopened = storage(provider)
      const recovered = new DelegationService({
        ...reopened,
        lifecycle: new ExecutionLifecycleService(reopened.executions),
      })
      await recovered.reconcileChildPublications(ids.parentExecutionId)
      const before = await reopened.delegations.get(ids.delegationId)
      await recovered.recordChildProgress({ ...waiting, observedAt: '2026-08-25T18:03:00.000Z' })
      await recovered.reconcileChildPublications(ids.parentExecutionId)
      expect(await reopened.delegations.get(ids.delegationId)).toEqual(before)
      const events = (await reopened.events.list()).filter(
        (x) => x.details.state === 'awaiting_input'
      )
      expect(events).toHaveLength(1)
      expect(events[0].occurredAt).toBe(waiting.observedAt)
      expect(events[0].details.interaction).toEqual(waiting.interaction)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

async function withRestartFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'cp1024-combined-reopen-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const first = storage(provider)
    const f = await createFixture(undefined, first)
    const input = delegationInput(f)
    await first.contexts.put(input.childPlan.contextPackage)
    await f.service.delegate(input)
    await f.service.dispatchChild({
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
      dispatchedAt: '2026-08-25T18:02:00.000Z',
    })
    await f.service.recordChildProgress({
      ...waiting,
      state: 'running',
      interaction: undefined,
      observedAt: '2026-08-25T18:02:05.000Z',
    })
    await run(first, f, async () => {
      await provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const reopened = storage(provider)
      return { ...reopened, lifecycle: new ExecutionLifecycleService(reopened.executions) }
    })
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}
const completion = {
  ...waiting,
  interaction: undefined,
  state: 'completed',
  observedAt: '2026-08-25T18:04:00.000Z',
  terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
}
const offlineEvents = {
  async publish() {
    throw new Error('offline-inbox')
  },
}

test('SQLite combined pending terminal intent commits before offline wait delivery after reopen', async () => {
  await withRestartFixture(async (first, f, reopen) => {
    const offline = new DelegationService({
      ...first,
      lifecycle: f.lifecycle,
      events: offlineEvents,
    })
    await expect(offline.recordChildProgress(waiting)).rejects.toThrow('offline-inbox')
    const interrupted = new DelegationService({
      ...first,
      lifecycle: f.lifecycle,
      events: offlineEvents,
      delegations: {
        get: (id) => first.delegations.get(id),
        async compareAndSet(revision, record) {
          const saved = await first.delegations.compareAndSet(revision, record)
          if (saved && record.pendingProgress?.state === 'completed')
            throw new Error('intent-crash')
          return saved
        },
      },
    })
    await expect(interrupted.recordChildProgress(completion)).rejects.toThrow('intent-crash')
    const reopened = await reopen()
    const recovery = new DelegationService({ ...reopened, events: offlineEvents })
    await expect(recovery.reconcileChildPublications(ids.parentExecutionId)).rejects.toThrow(
      'offline-inbox'
    )
    const canonical = await reopened.delegations.get(ids.delegationId)
    expect(canonical.state).toBe('completed')
    expect(canonical.pendingProgress).toBeUndefined()
    expect(canonical.terminalPublication.status).toBe('pending')
    expect(canonical.interactionPublications[0].status).toBe('pending')
    expect((await reopened.lifecycle.getExecution(ids.childExecutionId)).state).toBe('completed')
    const online = await reopen()
    const delivered = []
    const service = new DelegationService({
      ...online,
      events: {
        async publish(event, key) {
          delivered.push(event.details.state)
          await online.events.publish(event, key)
        },
      },
    })
    await service.reconcileChildPublications(ids.parentExecutionId)
    await service.reconcileChildPublications(ids.parentExecutionId)
    expect(delivered).toEqual(['awaiting_input', 'completed'])
  })
})

for (const lostAcknowledgement of ['awaiting_input', 'completed']) {
  test(`SQLite terminal recovery drains wait before terminal with lost ${lostAcknowledgement} acknowledgement`, async () => {
    await withRestartFixture(async (first, f, reopen) => {
      const offline = new DelegationService({
        ...first,
        lifecycle: f.lifecycle,
        events: offlineEvents,
      })
      await expect(offline.recordChildProgress(waiting)).rejects.toThrow('offline-inbox')
      await expect(offline.recordChildProgress(completion)).rejects.toThrow('offline-inbox')
      const reopened = await reopen()
      const deliveries = []
      const publisher = {
        async publish(event, key) {
          deliveries.push(event.details.state)
          await reopened.events.publish(event, key)
          if (event.details.state === lostAcknowledgement) throw new Error('lost-ack')
        },
      }
      await expect(
        reopened.delegations.recoverTerminalPublication(ids.delegationId, publisher)
      ).rejects.toThrow('lost-ack')
      // Every real durable inbox prefix must put the wait before terminal.
      expect(deliveries[0]).toBe('awaiting_input')
      if (lostAcknowledgement === 'awaiting_input') expect(deliveries).toEqual(['awaiting_input'])
      const online = await reopen()
      const repaired = []
      const current = await online.delegations.recoverTerminalPublication(ids.delegationId, {
        async publish(event, key) {
          repaired.push(event.details.state)
          await online.events.publish(event, key)
        },
      })
      expect(current.terminalPublication.status).toBe('published')
      expect(current.interactionPublications[0].status).toBe('published')
      const before = await online.delegations.get(ids.delegationId)
      await new DelegationService({ ...online }).reconcileChildPublications(ids.parentExecutionId)
      await online.delegations.recoverTerminalPublication(ids.delegationId, online.events)
      expect(await online.delegations.get(ids.delegationId)).toEqual(before)
      const relevant = (await online.events.list()).filter((event) =>
        ['awaiting_input', 'completed'].includes(event.details.state)
      )
      expect(relevant).toHaveLength(2)
      expect(repaired).toEqual(
        lostAcknowledgement === 'awaiting_input' ? ['awaiting_input', 'completed'] : ['completed']
      )
    })
  })
}
