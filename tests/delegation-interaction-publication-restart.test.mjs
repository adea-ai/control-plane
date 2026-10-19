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
