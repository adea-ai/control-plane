import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { DelegationService } from '@control-plane/orchestration'
import {
  createFixture,
  delegationInput,
  ids,
} from '../packages/orchestration/src/delegation-fixtures.mjs'
import { SqlitePersistenceProvider } from '../packages/sqlite-persistence/src/provider.ts'
import {
  SqliteExecutionRepository,
  SqliteExecutionPlanRepository,
} from '../packages/sqlite-persistence/src/repositories.ts'
import { SqliteContextPackageRepository } from '../packages/sqlite-persistence/src/repositories-extra.ts'
import { SqliteDelegationRepository } from '../packages/sqlite-persistence/src/delegation-repository.ts'
import { SqliteDelegationEventPublisher } from '../packages/sqlite-persistence/src/delegation-event-publisher.ts'

function storage(provider) {
  return {
    executions: new SqliteExecutionRepository(provider),
    plans: new SqliteExecutionPlanRepository(provider),
    contexts: new SqliteContextPackageRepository(provider),
    delegations: new SqliteDelegationRepository(provider),
    events: new SqliteDelegationEventPublisher(provider, ids.parentExecutionId),
  }
}
const completion = {
  delegationId: ids.delegationId,
  childAttemptId: ids.childAttemptId,
  state: 'completed',
  observedAt: '2026-08-25T18:03:00.000Z',
  terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
}
function intercept(target, method, callback) {
  return new Proxy(target, {
    get(object, key) {
      if (key === method) return callback
      const value = Reflect.get(object, key)
      return typeof value === 'function' ? value.bind(object) : value
    },
  })
}

for (const boundary of [
  'before-attempt',
  'after-attempt',
  'after-execution',
  'before-outcome-cas',
  'before-publication',
  'after-publication',
]) {
  test(`persistent delegation startup recovery repairs ${boundary} without callback redelivery`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'delegation-recovery-'))
    const path = join(directory, 'state.sqlite')
    let provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const first = storage(provider)
      const fixture = await createFixture(undefined, first)
      const input = delegationInput(fixture)
      await first.contexts.put(input.childPlan.contextPackage)
      await fixture.service.delegate(input)
      await fixture.service.dispatchChild({
        delegationId: ids.delegationId,
        childAttemptId: ids.childAttemptId,
        runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
        dispatchedAt: '2026-08-25T18:02:00.000Z',
      })
      await fixture.service.recordChildProgress({
        ...completion,
        state: 'running',
        terminalResultRef: undefined,
        observedAt: '2026-08-25T18:02:10.000Z',
      })
      const crash = () => {
        throw new Error('injected process boundary')
      }
      let lifecycle = fixture.lifecycle
      let delegations = first.delegations
      let events = first.events
      if (boundary === 'before-attempt' || boundary === 'after-attempt')
        lifecycle = intercept(lifecycle, 'transitionAttempt', async (request) => {
          if (boundary === 'before-attempt') crash()
          await fixture.lifecycle.transitionAttempt(request)
          crash()
        })
      if (boundary === 'after-execution')
        lifecycle = intercept(lifecycle, 'transitionExecution', async (request) => {
          await fixture.lifecycle.transitionExecution(request)
          crash()
        })
      if (boundary === 'before-outcome-cas' || boundary === 'after-publication')
        delegations = intercept(delegations, 'compareAndSet', async (revision, record) => {
          if (
            (boundary === 'before-outcome-cas' &&
              record.terminalPublication?.status === 'pending') ||
            (boundary === 'after-publication' && record.terminalPublication?.status === 'published')
          )
            crash()
          return first.delegations.compareAndSet(revision, record)
        })
      if (boundary === 'before-publication')
        events = intercept(events, 'publish', async () => crash())
      const interrupted = new DelegationService({
        delegations,
        lifecycle,
        plans: first.plans,
        events,
      })
      await expect(interrupted.recordChildProgress(completion)).rejects.toThrow(
        'injected process boundary'
      )
      const retained = await first.delegations.get(ids.delegationId)
      expect(retained.pendingProgress ?? retained.terminalPublication).toBeDefined()
      // Every canonical store closes; no in-memory repository or original service survives recovery.
      await provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const reopened = storage(provider)
      const recovered = new DelegationService({
        ...reopened,
        lifecycle: new ExecutionLifecycleService(reopened.executions),
      })
      await recovered.reconcileChildPublications(ids.parentExecutionId)
      await recovered.reconcileChildPublications(ids.parentExecutionId)
      expect(await reopened.delegations.findByChild(ids.childExecutionId)).toMatchObject({
        state: 'completed',
        childAttemptId: ids.childAttemptId,
        terminalPublication: { status: 'published' },
      })
      expect((await reopened.executions.getExecution(ids.childExecutionId)).state).toBe('completed')
      expect((await reopened.executions.getAttempt(ids.childAttemptId)).state).toBe('completed')
      expect(
        (await reopened.events.list()).filter((event) => event.type === 'delegation.completed')
      ).toHaveLength(1)
      expect(
        (await reopened.events.list()).find((event) => event.type === 'delegation.completed')
          .details.childAttemptId
      ).toBe(ids.childAttemptId)
      await recovered.recordChildProgress(completion)
      expect(
        (await reopened.events.list()).filter((event) => event.type === 'delegation.completed')
      ).toHaveLength(1)
      const record = await reopened.delegations.get(ids.delegationId)
      expect(
        await reopened.delegations.compareAndSet(record.revision, {
          ...record,
          revision: record.revision + 1,
          role: 'broadened-role',
        })
      ).toBe(false)
      expect(
        await reopened.delegations.compareAndSet(record.revision - 1, {
          ...record,
          revision: record.revision + 1,
        })
      ).toBe(false)
      expect(await reopened.delegations.listByParent('exe_01JABCDEF0123456789ABCDEFH')).toEqual([])
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

for (const boundary of [
  'dispatch-attempt-commit',
  'dispatch-record-cas',
  'cancel-execution-commit',
]) {
  test(`startup recovery repairs ${boundary} with retained command identity`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'delegation-command-'))
    const path = join(directory, 'state.sqlite')
    let provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const first = storage(provider)
      const fixture = await createFixture(undefined, first)
      const input = delegationInput(fixture)
      await first.contexts.put(input.childPlan.contextPackage)
      await fixture.service.delegate(input)
      let lifecycle = fixture.lifecycle
      let delegations = first.delegations
      const crash = () => {
        throw new Error('command process boundary')
      }
      if (boundary === 'dispatch-attempt-commit')
        lifecycle = intercept(lifecycle, 'createAttempt', async (request) => {
          await fixture.lifecycle.createAttempt(request)
          crash()
        })
      if (boundary === 'dispatch-record-cas')
        delegations = intercept(delegations, 'compareAndSet', async (revision, record) => {
          if (record.state === 'dispatched') crash()
          return first.delegations.compareAndSet(revision, record)
        })
      if (boundary === 'cancel-execution-commit')
        lifecycle = intercept(lifecycle, 'transitionExecution', async (request) => {
          await fixture.lifecycle.transitionExecution(request)
          crash()
        })
      const interrupted = new DelegationService({
        delegations,
        lifecycle,
        plans: first.plans,
        events: first.events,
      })
      const dispatch = {
        delegationId: ids.delegationId,
        childAttemptId: ids.childAttemptId,
        runtime: {
          runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG',
          externalSessionId: 'ses_01JBBCDEF0123456789ABCDEFG',
        },
        dispatchedAt: '2026-08-25T18:02:00.000Z',
      }
      if (boundary.startsWith('dispatch'))
        await expect(interrupted.dispatchChild(dispatch)).rejects.toThrow(
          'command process boundary'
        )
      else
        await expect(
          interrupted.cancelChildren({
            parentExecutionId: ids.parentExecutionId,
            cancelledAt: '2026-08-25T18:03:00.000Z',
          })
        ).rejects.toThrow('command process boundary')
      await provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      const reopened = storage(provider)
      const recovered = new DelegationService({
        ...reopened,
        lifecycle: new ExecutionLifecycleService(reopened.executions),
      })
      await recovered.reconcileChildPublications(ids.parentExecutionId)
      if (boundary.startsWith('dispatch')) {
        await recovered.dispatchChild(dispatch)
        expect(await reopened.executions.listAttempts(ids.childExecutionId)).toHaveLength(1)
        expect(
          (await reopened.executions.getAttempt(ids.childAttemptId)).runtime.externalSessionId
        ).toBe(dispatch.runtime.externalSessionId)
        expect((await reopened.delegations.get(ids.delegationId)).state).toBe('dispatched')
        await expect(
          recovered.dispatchChild({
            ...dispatch,
            runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFH' },
          })
        ).rejects.toMatchObject({ code: 'DELEGATION_STATE_CONFLICT' })
      } else {
        expect((await reopened.delegations.get(ids.delegationId)).terminalPublication.status).toBe(
          'published'
        )
        expect(
          (await reopened.events.list()).filter((event) => event.type === 'delegation.cancelled')
        ).toHaveLength(1)
      }
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

for (const terminal of ['completed', 'cancelled']) {
  test(`physical workspace lead reopens real project child, current authority and retained ${terminal} inbox`, async () => {
    const { workspaceInput, currentSnapshot, actor, now } =
      await import('../packages/orchestration/src/delegation-workspace-fixtures.mjs')
    const compiled = workspaceInput()
    const directory = await mkdtemp(join(tmpdir(), 'workspace-child-recovery-'))
    const path = join(directory, 'state.sqlite')
    let provider = new SqlitePersistenceProvider({ path })
    let active = true
    const scopeAdmission = {
      now: () => now,
      resolveCallerPrincipalId: async () => actor,
      authority: {
        readCurrent: async (input) => ({ ...currentSnapshot(input), grantActive: active }),
      },
    }
    const service = (stores) =>
      new DelegationService({
        ...stores,
        lifecycle: new ExecutionLifecycleService(stores.executions),
        scopeAdmission,
      })
    try {
      await provider.migrate()
      let stores = storage(provider)
      await createFixture(undefined, {
        ...stores,
        parentPlan: compiled.parentPlan,
        parentContext: compiled.parentContext,
      })
      await stores.contexts.put(compiled.childContext)
      const command = compiled.command
      const scoped = service(stores)
      const admitted = await scoped.delegate(command)
      expect(admitted.plan.schemaVersion).toBe(2)
      expect(admitted.plan.correlation.projectId).toBe(ids.projectId)
      expect(compiled.parentPlan.correlation.projectId).toBeUndefined()
      await scoped.dispatchChild({
        delegationId: ids.delegationId,
        childAttemptId: ids.childAttemptId,
        runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
        dispatchedAt: '2026-08-25T18:02:00.000Z',
      })
      await provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      stores = storage(provider)
      const resumed = service(stores)
      active = false
      await expect(resumed.delegate(command)).rejects.toThrow('SCOPE_ADMISSION_DENIED')
      active = true
      expect((await resumed.delegate(command)).record.childAttemptId).toBe(ids.childAttemptId)
      await expect(
        resumed.recordChildProgress({
          ...completion,
          childAttemptId: 'att_01JCBCDEF0123456789ABCDEFG',
        })
      ).rejects.toThrow()
      if (terminal === 'completed') {
        await resumed.recordChildProgress({
          ...completion,
          state: 'running',
          terminalResultRef: undefined,
          observedAt: '2026-08-25T18:02:10.000Z',
        })
        await resumed.recordChildProgress(completion)
      } else {
        await resumed.cancelChildren({
          parentExecutionId: ids.parentExecutionId,
          cancelledAt: '2026-08-25T18:03:00.000Z',
        })
      }
      await provider.close()
      provider = new SqlitePersistenceProvider({ path })
      await provider.migrate()
      stores = storage(provider)
      await service(stores).reconcileChildPublications(ids.parentExecutionId)
      await service(stores).reconcileChildPublications(ids.parentExecutionId)
      const inbox = await stores.events.list()
      expect(inbox.filter((event) => event.type === `delegation.${terminal}`)).toHaveLength(1)
      expect(
        inbox.find((event) => event.type === `delegation.${terminal}`).details.childAttemptId
      ).toBe(ids.childAttemptId)
      expect((await stores.executions.getExecution(ids.childExecutionId)).state).toBe(terminal)
      expect(await stores.delegations.listByParent(ids.parentExecutionId)).toHaveLength(1)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
