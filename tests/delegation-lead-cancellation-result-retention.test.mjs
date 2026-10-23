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
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
} from '../packages/sqlite-persistence/src/repositories.ts'
import { SqliteContextPackageRepository } from '../packages/sqlite-persistence/src/repositories-extra.ts'
import { SqliteDelegationRepository } from '../packages/sqlite-persistence/src/delegation-repository.ts'
import { SqliteDelegationEventPublisher } from '../packages/sqlite-persistence/src/delegation-event-publisher.ts'

// CP #1024: "retain results after lead cancellation/restart" in the ordering no
// other module proves - the child's terminal RESULT is retained first, the lead
// is cancelled afterwards. The cascade stop republishes the retained completion
// and must never overwrite it with a cancellation, both before and after a real
// restart where the canonical database closes and reopens from the same file,
// including the window where the completion publication is still pending after
// a crash. Every fixture is synthetic and offline; nothing here certifies a live
// qualified child callback.

const stopAt = '2026-08-25T18:03:00.000Z'
const runningAt = '2026-08-25T18:02:10.000Z'
const dispatchedAt = '2026-08-25T18:02:00.000Z'
const resultRef = 'art_01JBBCDEF0123456789ABCDEFG'
const completion = {
  delegationId: ids.delegationId,
  childAttemptId: ids.childAttemptId,
  state: 'completed',
  observedAt: stopAt,
  terminalResultRef: resultRef,
}
const leadStop = { parentExecutionId: ids.parentExecutionId, cancelledAt: stopAt }

function storage(provider) {
  return {
    executions: new SqliteExecutionRepository(provider),
    plans: new SqliteExecutionPlanRepository(provider),
    contexts: new SqliteContextPackageRepository(provider),
    delegations: new SqliteDelegationRepository(provider),
    events: new SqliteDelegationEventPublisher(provider, ids.parentExecutionId),
  }
}

function service(stores) {
  return new DelegationService({
    ...stores,
    lifecycle: new ExecutionLifecycleService(stores.executions),
  })
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

/** Delegates, dispatches the child and retains its running progress. */
async function dispatchedChild(stores, fixture) {
  const input = delegationInput(fixture)
  await stores.contexts.put(input.childPlan.contextPackage)
  await fixture.service.delegate(input)
  await fixture.service.dispatchChild({
    delegationId: ids.delegationId,
    childAttemptId: ids.childAttemptId,
    runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
    dispatchedAt,
  })
  await fixture.service.recordChildProgress({
    ...completion,
    state: 'running',
    terminalResultRef: undefined,
    observedAt: runningAt,
  })
}

/** The retained result: completed state, exact reference, one event, no cancellation. */
async function expectRetainedCompletion(stores) {
  const inbox = await stores.events.list()
  const completed = inbox.filter((event) => event.type === 'delegation.completed')
  expect(completed).toHaveLength(1)
  expect(completed[0].details.terminalResultRef).toBe(resultRef)
  expect(completed[0].details.childAttemptId).toBe(ids.childAttemptId)
  expect(inbox.filter((event) => event.type === 'delegation.cancelled')).toHaveLength(0)

  const record = await stores.delegations.get(ids.delegationId)
  expect(record.state).toBe('completed')
  expect(record.terminalResultRef).toBe(resultRef)
  expect(record.terminalPublication.status).toBe('published')

  expect((await stores.executions.getExecution(ids.childExecutionId)).state).toBe('completed')
  expect((await stores.executions.getAttempt(ids.childAttemptId)).state).toBe('completed')
}

test('a lead cancellation after a retained completion republishes it and survives a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-cancellation-result-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let stores = storage(provider)
    const fixture = await createFixture(undefined, stores)
    await dispatchedChild(stores, fixture)
    await fixture.service.recordChildProgress(completion)
    await expectRetainedCompletion(stores)

    // The lead stops after the result is retained: the cascade republishes the
    // completion and returns without cancelling anything.
    expect(await fixture.service.cancelChildren(leadStop)).toEqual([])
    await expectRetainedCompletion(stores)

    // Real restart: the canonical store closes and reopens from the same file.
    await provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    stores = storage(provider)
    const recovered = service(stores)
    await recovered.reconcileChildPublications(ids.parentExecutionId)
    await recovered.reconcileChildPublications(ids.parentExecutionId)
    // Repeating the stop after the restart still never becomes a cancellation.
    expect(await recovered.cancelChildren(leadStop)).toEqual([])
    await recovered.reconcileChildPublications(ids.parentExecutionId)
    await expectRetainedCompletion(stores)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a crash while the completion publication is pending keeps the result through lead cancellation and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-cancellation-result-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const first = storage(provider)
    const fixture = await createFixture(undefined, first)
    await dispatchedChild(first, fixture)

    // The completion commits its result and the lifecycle transition first, then
    // crashes inside the inbox publication: the canonical result is retained and
    // only its publication intent is still pending.
    const interrupted = new DelegationService({
      delegations: first.delegations,
      lifecycle: fixture.lifecycle,
      plans: fixture.plans,
      events: intercept(first.events, 'publish', async () => {
        throw new Error('injected publication crash')
      }),
    })
    await expect(interrupted.recordChildProgress(completion)).rejects.toThrow(
      'injected publication crash'
    )
    const pending = await first.delegations.get(ids.delegationId)
    expect(pending.state).toBe('completed')
    expect(pending.terminalResultRef).toBe(resultRef)
    expect(pending.terminalPublication.status).toBe('pending')
    expect((await first.executions.getExecution(ids.childExecutionId)).state).toBe('completed')
    expect(
      (await first.events.list()).filter((event) => event.type === 'delegation.completed')
    ).toHaveLength(0)

    // Real restart with the completion publication still pending.
    await provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    const stores = storage(provider)
    const recovered = service(stores)

    // The lead cancellation arrives after the restart: it must repair the
    // retained completion, not replace it with a cancellation.
    expect(await recovered.cancelChildren(leadStop)).toEqual([])
    await expectRetainedCompletion(stores)

    await recovered.reconcileChildPublications(ids.parentExecutionId)
    await recovered.reconcileChildPublications(ids.parentExecutionId)
    await expectRetainedCompletion(stores)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
