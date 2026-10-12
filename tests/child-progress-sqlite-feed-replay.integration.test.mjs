import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  ChildProgressEvidenceBuffer,
  ChildProgressLeadDispatcher,
  ChildProgressLeadFeed,
  DelegationService,
} from '@control-plane/orchestration'
import {
  SqliteDelegationEventPublisher,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { json, recordId } from '../packages/sqlite-persistence/src/record-storage.ts'
import {
  createFixture,
  delegationInput,
  ids,
} from '../packages/orchestration/src/delegation-fixtures.mjs'

function createFeed(provider, parentExecutionId = ids.parentExecutionId) {
  const dispatcher = new ChildProgressLeadDispatcher({
    buffer: new ChildProgressEvidenceBuffer({ parentExecutionId }),
  })
  return {
    dispatcher,
    feed: new ChildProgressLeadFeed({
      publications: new SqliteDelegationEventPublisher(provider, parentExecutionId),
      dispatcher,
      generationOf: () => 1,
    }),
  }
}

async function insertLegacyAwaitingInput(provider, event) {
  const idempotencyKey = `delegation:${event.delegationId}:progress:legacy`
  await provider.transaction((transaction) =>
    transaction.put({
      namespace: 'delegation-publications',
      id: recordId(canonicalJsonStringify([event.parentExecutionId, idempotencyKey])),
      value: json({ idempotencyKey, event }),
    })
  )
}

test('DelegationService persists awaiting-input interaction context, replays it, and continues with a later terminal event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cp-delegation-awaiting-replay-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const { feed } = createFeed(provider)
    const fixture = await createFixture(undefined, { events: feed })
    await fixture.service.delegate(delegationInput(fixture))
    await fixture.service.dispatchChild({
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
      dispatchedAt: '2026-08-25T18:02:00.000Z',
    })
    await fixture.service.recordChildProgress({
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      state: 'running',
      observedAt: '2026-08-25T18:02:10.000Z',
    })
    const interaction = {
      interactionId: 'int_01JBBCDEF0123456789ABCDEFG',
      kind: 'approval',
    }
    await fixture.service.recordChildProgress({
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      state: 'awaiting_input',
      observedAt: '2026-08-25T18:02:20.000Z',
      interaction,
    })
    expect(
      (await feed.list()).find(
        (event) =>
          event.type === 'delegation.progress' && event.details['state'] === 'awaiting_input'
      )
    ).toMatchObject({ details: { state: 'awaiting_input', interaction } })

    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    const { feed: restartedFeed } = createFeed(provider)
    const replayed = await restartedFeed.replay()
    expect(replayed).toMatchObject({ rejectedEventCount: 0 })
    const replayedEntries = restartedFeed
      .takeDeliveries()
      .flatMap((delivery) => (delivery.kind === 'evidence' ? delivery.packet.entries : []))
    expect(replayedEntries).toContainEqual(
      expect.objectContaining({ phase: 'awaiting_input', interaction })
    )

    const resumedService = new DelegationService({
      delegations: fixture.delegations,
      lifecycle: fixture.lifecycle,
      plans: fixture.plans,
      events: restartedFeed,
    })
    await resumedService.recordChildProgress({
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      state: 'completed',
      observedAt: '2026-08-25T18:03:00.000Z',
      terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
    })
    expect((await restartedFeed.list()).at(-1)).toMatchObject({
      type: 'delegation.completed',
      details: { terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG' },
    })
    expect(
      restartedFeed
        .takeDeliveries()
        .flatMap((delivery) => (delivery.kind === 'evidence' ? delivery.packet.entries : []))
    ).toContainEqual(expect.objectContaining({ phase: 'completed' }))
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite replay isolates raw legacy awaiting-input rows across parent inboxes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cp-legacy-delegation-replay-'))
  const path = join(directory, 'state.sqlite')
  const provider = new SqlitePersistenceProvider({ path })
  const otherParent = 'exe_01JABCDEF0123456789ABCDEFH'
  const otherDelegation = 'dlg_01JABCDEF0123456789ABCDEFH'
  const otherChild = 'exe_01JBBCDEF0123456789ABCDEFH'
  const otherAttempt = 'att_01JBBCDEF0123456789ABCDEFH'
  const otherArtifact = 'art_01JBBCDEF0123456789ABCDEFH'
  try {
    await provider.migrate()
    await insertLegacyAwaitingInput(provider, {
      type: 'delegation.progress',
      delegationId: ids.delegationId,
      parentExecutionId: ids.parentExecutionId,
      childExecutionId: ids.childExecutionId,
      occurredAt: '2026-08-25T18:04:00.000Z',
      details: { state: 'awaiting_input', childAttemptId: ids.childAttemptId },
    })
    await insertLegacyAwaitingInput(provider, {
      type: 'delegation.progress',
      delegationId: otherDelegation,
      parentExecutionId: otherParent,
      childExecutionId: otherChild,
      occurredAt: '2026-08-25T18:04:00.000Z',
      details: { state: 'awaiting_input', childAttemptId: otherAttempt },
    })

    await new SqliteDelegationEventPublisher(provider, ids.parentExecutionId).publish(
      {
        type: 'delegation.completed',
        delegationId: ids.delegationId,
        parentExecutionId: ids.parentExecutionId,
        childExecutionId: ids.childExecutionId,
        occurredAt: '2026-08-25T18:05:00.000Z',
        details: {
          childAttemptId: ids.childAttemptId,
          terminalResultRef: 'art_01JABCDEF0123456789ABCDEFG',
        },
      },
      `delegation:${ids.delegationId}:terminal`
    )
    await new SqliteDelegationEventPublisher(provider, otherParent).publish(
      {
        type: 'delegation.completed',
        delegationId: otherDelegation,
        parentExecutionId: otherParent,
        childExecutionId: otherChild,
        occurredAt: '2026-08-25T18:05:00.000Z',
        details: { childAttemptId: otherAttempt, terminalResultRef: otherArtifact },
      },
      `delegation:${otherDelegation}:terminal`
    )

    const { feed: parentFeed } = createFeed(provider)
    const { feed: otherFeed } = createFeed(provider, otherParent)
    const parentResult = await parentFeed.replay().then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    const otherResult = await otherFeed.replay().then(
      (value) => ({ value }),
      (error) => ({ error })
    )

    expect(parentResult.error).toBeUndefined()
    expect(otherResult.error).toBeUndefined()
    expect(parentResult.value).toMatchObject({ foldedEventCount: 1, rejectedEventCount: 0 })
    expect(otherResult.value).toMatchObject({ foldedEventCount: 1, rejectedEventCount: 0 })
    expect(
      parentFeed
        .takeDeliveries()
        .flatMap((delivery) => (delivery.kind === 'evidence' ? delivery.packet.entries : []))
    ).toContainEqual(
      expect.objectContaining({ phase: 'completed', delegationId: ids.delegationId })
    )
    expect(
      otherFeed
        .takeDeliveries()
        .flatMap((delivery) => (delivery.kind === 'evidence' ? delivery.packet.entries : []))
    ).toContainEqual(expect.objectContaining({ phase: 'completed', delegationId: otherDelegation }))
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
