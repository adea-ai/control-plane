// CP #1024: canonical interaction identity survives interrupted publication.
import { test, expect } from 'bun:test'
import { createFixture, delegationInput, ids } from './delegation-fixtures.mjs'
import { DelegationService } from './delegation.ts'

async function setup() {
  const f = await createFixture()
  await f.service.delegate(delegationInput(f))
  await f.service.dispatchChild({
    delegationId: ids.delegationId,
    childAttemptId: ids.childAttemptId,
    runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
    dispatchedAt: '2026-08-25T18:02:00.000Z',
  })
  await f.service.recordChildProgress({
    delegationId: ids.delegationId,
    childAttemptId: ids.childAttemptId,
    state: 'running',
    observedAt: '2026-08-25T18:02:05.000Z',
  })
  const input = {
    delegationId: ids.delegationId,
    childAttemptId: ids.childAttemptId,
    state: 'awaiting_input',
    observedAt: '2026-08-25T18:02:10.000Z',
    interaction: { interactionId: 'int_01JBBCDEF0123456789ABCDEFG', kind: 'input' },
  }
  return { f, input }
}
function service(f, publish) {
  return new DelegationService({ ...f, events: { publish } })
}

// Expected contract: recovery reads canonical retained input, with no callback resend.
test('crash before inbox acceptance is repaired by reconciliation', async () => {
  const { f, input } = await setup()
  await expect(
    service(f, async () => {
      throw new Error('before-inbox')
    }).recordChildProgress(input)
  ).rejects.toThrow('before-inbox')
  const retained = await f.delegations.get(ids.delegationId)
  const repaired = []
  await service(f, async (event, key) => {
    repaired.push({ event, key })
  }).reconcileChildPublications(ids.parentExecutionId)
  console.log(
    JSON.stringify({
      case: 'before-acceptance',
      state: retained.state,
      pendingProgress: retained.pendingProgress ?? null,
      repaired: repaired.length,
    })
  )
  expect(repaired).toHaveLength(1)
  expect(repaired[0].event.details.interaction).toEqual(input.interaction)
})

// An inbox Map models durable idempotency, not transport acknowledgement.
test('accepted inbox plus lost acknowledgement reuses its logical key', async () => {
  const { f, input } = await setup()
  const inbox = new Map()
  const attempts = []
  let loseAck = true
  const publish = async (event, key) => {
    attempts.push(key)
    inbox.set(key, structuredClone(event))
    if (loseAck) {
      loseAck = false
      throw new Error('after-inbox-before-ack')
    }
  }
  await expect(service(f, publish).recordChildProgress(input)).rejects.toThrow(
    'after-inbox-before-ack'
  )
  await service(f, publish).reconcileChildPublications(ids.parentExecutionId)
  // Identical callback redelivery must not create another logical inbox event.
  await service(f, publish).recordChildProgress(input)
  console.log(JSON.stringify({ case: 'accepted-lost-ack', attempts, logicalEvents: inbox.size }))
  expect(new Set(attempts).size).toBe(1)
  expect(inbox.size).toBe(1)
})

test('identical callback replay changes neither receipt identity nor revision', async () => {
  const { f, input } = await setup()
  const delivered = []
  const s = service(f, async (event, key) => {
    delivered.push({ event, key })
  })
  const first = await s.recordChildProgress(input)
  const replay = await s.recordChildProgress(input)
  console.log(
    JSON.stringify({
      case: 'identical-replay',
      keys: delivered.map((x) => x.key),
      firstRevision: first.record.revision,
      replayRevision: replay.record.revision,
    })
  )
  expect(new Set(delivered.map((x) => x.key)).size).toBe(1)
  expect(replay.record.revision).toBe(first.record.revision)
})

test('changed kind under the same child interaction identity conflicts', async () => {
  const { f, input } = await setup()
  const delivered = []
  const s = service(f, async (event, key) => {
    delivered.push({ event, key })
  })
  await s.recordChildProgress(input)
  const before = await f.delegations.get(ids.delegationId)
  const changed = { ...input, interaction: { ...input.interaction, kind: 'approval' } }
  let rejected = false
  try {
    await s.recordChildProgress(changed)
  } catch {
    rejected = true
  }
  const after = await f.delegations.get(ids.delegationId)
  console.log(
    JSON.stringify({
      case: 'changed-interaction',
      rejected,
      beforeRevision: before.revision,
      afterRevision: after.revision,
      published: delivered.length,
    })
  )
  expect(rejected).toBe(true)
  expect(after).toEqual(before)
  expect(delivered).toHaveLength(1)
})

test('a later observation of the same interaction replays its original envelope', async () => {
  const { f, input } = await setup()
  const delivered = []
  const s = service(f, async (event, key) => {
    delivered.push({ event, key })
  })
  const first = await s.recordChildProgress(input)
  const replay = await s.recordChildProgress({ ...input, observedAt: '2026-08-25T18:03:00.000Z' })
  expect(replay.record).toEqual(first.record)
  expect(new Set(delivered.map((x) => x.key)).size).toBe(1)
  expect(delivered.every((x) => x.event.occurredAt === input.observedAt)).toBe(true)
})

test('a different interaction is a genuine new wait, even at the same observation time', async () => {
  const { f, input } = await setup()
  const delivered = []
  const s = service(f, async (event, key) => {
    delivered.push({ event, key })
  })
  await s.recordChildProgress(input)
  const next = {
    ...input,
    interaction: { ...input.interaction, interactionId: 'int_01JCBCDEF0123456789ABCDEFG' },
  }
  await s.recordChildProgress(next)
  expect(new Set(delivered.map((x) => x.key)).size).toBe(2)
  expect(delivered.map((x) => x.event.details.interaction)).toEqual([
    input.interaction,
    next.interaction,
  ])
  const before = await f.delegations.get(ids.delegationId)
  await s.recordChildProgress(input)
  expect(await f.delegations.get(ids.delegationId)).toEqual(before)
})

test('an old interaction replay never moves a running child back to awaiting input', async () => {
  const { f, input } = await setup()
  const s = service(f, async () => {})
  await s.recordChildProgress(input)
  await s.recordChildProgress({
    ...input,
    interaction: undefined,
    state: 'running',
    observedAt: '2026-08-25T18:03:00.000Z',
  })
  const before = await f.delegations.get(ids.delegationId)
  const replay = await s.recordChildProgress(input)
  expect(replay.record).toEqual(before)
  expect(replay.record.state).toBe('running')
})

test('an interaction replay from a different child attempt stays fenced', async () => {
  const { f, input } = await setup()
  const delivered = []
  const s = service(f, async (event, key) => {
    delivered.push({ event, key })
  })
  await s.recordChildProgress(input)
  const before = await f.delegations.get(ids.delegationId)
  await expect(
    s.recordChildProgress({ ...input, childAttemptId: 'att_01JCBCDEF0123456789ABCDEFG' })
  ).rejects.toMatchObject({ code: 'DELEGATION_ATTEMPT_MISMATCH' })
  expect(await f.delegations.get(ids.delegationId)).toEqual(before)
  expect(delivered).toHaveLength(1)
})

test('an advisory wake failure does not reopen the durable publication', async () => {
  const { f, input } = await setup()
  const delivered = []
  const s = new DelegationService({
    ...f,
    events: {
      async publish(event, key) {
        delivered.push({ event, key })
      },
    },
    onEventRetained: async () => {
      throw new Error('wake failed')
    },
  })
  await s.recordChildProgress(input)
  await s.reconcileChildPublications(ids.parentExecutionId)
  await s.recordChildProgress(input)
  expect(delivered).toHaveLength(1)
})

test('lifecycle commit interrupted before the waiting record is repaired from pending progress', async () => {
  const { f, input } = await setup()
  const interrupted = new DelegationService({
    ...f,
    delegations: {
      get: (id) => f.delegations.get(id),
      compareAndSet: (revision, record) =>
        record.state === 'awaiting_input'
          ? Promise.reject(new Error('before-waiting-record'))
          : f.delegations.compareAndSet(revision, record),
    },
  })
  await expect(interrupted.recordChildProgress(input)).rejects.toThrow('before-waiting-record')
  expect((await f.delegations.get(ids.delegationId)).pendingProgress).toEqual(input)
  const published = []
  await service(f, async (event, key) => {
    published.push({ event, key })
  }).reconcileChildPublications(ids.parentExecutionId)
  expect(published).toHaveLength(1)
  expect(published[0].event.details.interaction).toEqual(input.interaction)
  expect((await f.delegations.get(ids.delegationId)).pendingProgress).toBeUndefined()
})

test('a lost sender receipt after inbox acceptance retains one key across restart', async () => {
  const { f, input } = await setup()
  const inbox = new Map()
  const keys = []
  const events = {
    async publish(event, key) {
      keys.push(key)
      inbox.set(key, structuredClone(event))
    },
  }
  const interrupted = new DelegationService({
    ...f,
    events,
    delegations: {
      get: (id) => f.delegations.get(id),
      compareAndSet: (revision, record) =>
        record.interactionPublications?.some((x) => x.status === 'published')
          ? Promise.reject(new Error('before-sender-ack'))
          : f.delegations.compareAndSet(revision, record),
    },
  })
  await expect(interrupted.recordChildProgress(input)).rejects.toThrow('before-sender-ack')
  expect((await f.delegations.get(ids.delegationId)).interactionPublications[0].status).toBe(
    'pending'
  )
  const restarted = new DelegationService({ ...f, events })
  await restarted.reconcileChildPublications(ids.parentExecutionId)
  await restarted.recordChildProgress(input)
  expect(keys).toHaveLength(2)
  expect(new Set(keys).size).toBe(1)
  expect(inbox.size).toBe(1)
})

test('publication acknowledgement merges into concurrent terminal completion without restoring waiting state', async () => {
  const { f, input } = await setup()
  let enter, release
  const entered = new Promise((resolve) => {
    enter = resolve
  })
  const held = new Promise((resolve) => {
    release = resolve
  })
  const inbox = new Map()
  const events = {
    async publish(event, key) {
      inbox.set(key, event)
      if (event.details.state === 'awaiting_input') {
        enter()
        await held
      }
    },
  }
  const s = new DelegationService({ ...f, events })
  const waiting = s.recordChildProgress(input)
  await entered
  const completion = {
    ...input,
    interaction: undefined,
    state: 'completed',
    observedAt: '2026-08-25T18:04:00.000Z',
    terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
  }
  const completing = s.recordChildProgress(completion)
  for (let turn = 0; turn < 100; turn += 1) {
    if ((await f.delegations.get(ids.delegationId)).state === 'completed') break
  }
  expect((await f.delegations.get(ids.delegationId)).state).toBe('completed')
  release()
  await Promise.all([waiting, completing])
  const after = await f.delegations.get(ids.delegationId)
  expect(after.state).toBe('completed')
  expect(after.terminalPublication.status).toBe('published')
  expect(after.interactionPublications[0].status).toBe('published')
  await s.reconcileChildPublications(ids.parentExecutionId)
  await s.recordChildProgress(input)
  await s.recordChildProgress(completion)
  expect(await f.delegations.get(ids.delegationId)).toEqual(after)
  expect(inbox.size).toBe(2)
})

test('parent cancellation preserves pending interaction and terminal publication receipts', async () => {
  const { f, input } = await setup()
  await expect(
    service(f, async () => {
      throw new Error('offline-inbox')
    }).recordChildProgress(input)
  ).rejects.toThrow('offline-inbox')
  const inbox = new Map()
  const s = service(f, async (event, key) => {
    inbox.set(key, event)
  })
  await s.cancelChildren({
    parentExecutionId: ids.parentExecutionId,
    cancelledAt: '2026-08-25T18:04:00.000Z',
  })
  await s.reconcileChildPublications(ids.parentExecutionId)
  const cancelled = await f.delegations.get(ids.delegationId)
  expect(cancelled.state).toBe('cancelled')
  expect(cancelled.terminalPublication.status).toBe('published')
  expect(cancelled.interactionPublications[0].status).toBe('published')
  await s.reconcileChildPublications(ids.parentExecutionId)
  expect(await f.delegations.get(ids.delegationId)).toEqual(cancelled)
  expect(inbox.size).toBe(2)
})

test('capacity refuses new identities without evicting old replay receipts or changing lifecycle', async () => {
  const { f, input } = await setup()
  const record = await f.delegations.get(ids.delegationId)
  const publications = Array.from({ length: 1024 }, (_, i) => ({
    childAttemptId: input.childAttemptId,
    interaction: { interactionId: `int_${String(i).padStart(26, '0')}`, kind: 'input' },
    observedAt: input.observedAt,
    status: 'published',
  }))
  await f.delegations.compareAndSet(record.revision, {
    ...record,
    revision: record.revision + 1,
    interactionPublications: publications,
  })
  const before = await f.delegations.get(ids.delegationId)
  const s = service(f, async () => {
    throw new Error('must-not-publish')
  })
  await expect(s.recordChildProgress(input)).rejects.toMatchObject({
    code: 'DELEGATION_INTERACTION_PUBLICATION_LIMIT',
  })
  expect(await f.delegations.get(ids.delegationId)).toEqual(before)
  const replay = await s.recordChildProgress({ ...input, interaction: publications[0].interaction })
  expect(replay.record).toEqual(before)
  expect((await f.lifecycle.repository.getAttempt(ids.childAttemptId)).state).toBe('running')
})

test('a pending interaction replay with a later timestamp retains the first waiting envelope', async () => {
  const { f, input } = await setup()
  const interrupted = new DelegationService({
    ...f,
    delegations: {
      get: (id) => f.delegations.get(id),
      compareAndSet: (revision, record) =>
        record.state === 'awaiting_input'
          ? Promise.reject(new Error('interrupted-wait'))
          : f.delegations.compareAndSet(revision, record),
    },
  })
  await expect(interrupted.recordChildProgress(input)).rejects.toThrow('interrupted-wait')
  const published = []
  const restarted = service(f, async (event, key) => {
    published.push({ event, key })
  })
  await expect(
    restarted.recordChildProgress({
      ...input,
      interaction: { ...input.interaction, kind: 'approval' },
    })
  ).rejects.toMatchObject({ code: 'DELEGATION_STATE_CONFLICT' })
  await restarted.recordChildProgress({ ...input, observedAt: '2026-08-25T18:03:00.000Z' })
  expect(published).toHaveLength(1)
  expect(published[0].event.occurredAt).toBe(input.observedAt)
  expect((await f.delegations.get(ids.delegationId)).interactionPublications[0].observedAt).toBe(
    input.observedAt
  )
})

test('an offline interaction inbox cannot block cancellation after an interrupted waiting transition', async () => {
  const { f, input } = await setup()
  const interrupted = new DelegationService({
    ...f,
    delegations: {
      get: (id) => f.delegations.get(id),
      compareAndSet: (revision, record) =>
        record.state === 'awaiting_input'
          ? Promise.reject(new Error('interrupted-wait'))
          : f.delegations.compareAndSet(revision, record),
    },
  })
  await expect(interrupted.recordChildProgress(input)).rejects.toThrow('interrupted-wait')
  const offline = service(f, async () => {
    throw new Error('offline-inbox')
  })
  await expect(
    offline.cancelChildren({
      parentExecutionId: ids.parentExecutionId,
      cancelledAt: '2026-08-25T18:04:00.000Z',
    })
  ).rejects.toThrow('offline-inbox')
  const cancelled = await f.delegations.get(ids.delegationId)
  expect((await f.lifecycle.getExecution(ids.childExecutionId)).state).toBe('cancelled')
  expect((await f.lifecycle.repository.getAttempt(ids.childAttemptId)).state).toBe('cancelled')
  expect(cancelled.state).toBe('cancelled')
  expect(cancelled.interactionPublications[0].status).toBe('pending')
  expect(cancelled.terminalPublication.status).toBe('pending')
  const inbox = new Map()
  const restarted = service(f, async (event, key) => {
    inbox.set(key, event)
  })
  await restarted.reconcileChildPublications(ids.parentExecutionId)
  await restarted.reconcileChildPublications(ids.parentExecutionId)
  expect(inbox.size).toBe(2)
  expect((await f.delegations.get(ids.delegationId)).state).toBe('cancelled')
})

test('a terminal callback commits despite an interrupted wait and an offline inbox', async () => {
  const { f, input } = await setup()
  const interrupted = new DelegationService({
    ...f,
    delegations: {
      get: (id) => f.delegations.get(id),
      compareAndSet: (revision, record) =>
        record.state === 'awaiting_input'
          ? Promise.reject(new Error('interrupted-wait'))
          : f.delegations.compareAndSet(revision, record),
    },
  })
  await expect(interrupted.recordChildProgress(input)).rejects.toThrow('interrupted-wait')
  const offline = service(f, async () => {
    throw new Error('offline-inbox')
  })
  const completion = {
    ...input,
    interaction: undefined,
    state: 'completed',
    observedAt: '2026-08-25T18:04:00.000Z',
    terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
  }
  await expect(offline.recordChildProgress(completion)).rejects.toThrow('offline-inbox')
  const completed = await f.delegations.get(ids.delegationId)
  expect(completed.state).toBe('completed')
  expect((await f.lifecycle.getExecution(ids.childExecutionId)).state).toBe('completed')
  expect(completed.interactionPublications[0].status).toBe('pending')
  expect(completed.terminalPublication.status).toBe('pending')
  const published = []
  const restarted = service(f, async (event, key) => {
    published.push({ event, key })
  })
  await restarted.reconcileChildPublications(ids.parentExecutionId)
  expect(published.map((x) => x.event.details.state)).toEqual(['awaiting_input', 'completed'])
  const after = await f.delegations.get(ids.delegationId)
  await restarted.recordChildProgress(completion)
  await restarted.recordChildProgress(input)
  expect(await f.delegations.get(ids.delegationId)).toEqual(after)
  expect(published).toHaveLength(2)
})

test('reconciliation commits a retained cancellation intent before an offline waiting publication', async () => {
  const { f, input } = await setup()
  const offline = service(f, async () => {
    throw new Error('offline-inbox')
  })
  await expect(offline.recordChildProgress(input)).rejects.toThrow('offline-inbox')
  const record = await f.delegations.get(ids.delegationId)
  await f.delegations.compareAndSet(record.revision, {
    ...record,
    revision: record.revision + 1,
    pendingCancellationAt: '2026-08-25T18:04:00.000Z',
  })
  await expect(offline.reconcileChildPublications(ids.parentExecutionId)).rejects.toThrow(
    'offline-inbox'
  )
  const cancelled = await f.delegations.get(ids.delegationId)
  expect(cancelled.state).toBe('cancelled')
  expect(cancelled.pendingCancellationAt).toBeUndefined()
  expect((await f.lifecycle.getExecution(ids.childExecutionId)).state).toBe('cancelled')
  expect(cancelled.terminalPublication.status).toBe('pending')
  const published = []
  const restarted = service(f, async (event) => {
    published.push(event)
  })
  await restarted.reconcileChildPublications(ids.parentExecutionId)
  expect(published.map((event) => event.details.state)).toEqual(['awaiting_input', 'cancelled'])
})

test('direct terminal delivery repairs the earlier waiting publication before the terminal notification', async () => {
  const { f, input } = await setup()
  await expect(
    service(f, async () => {
      throw new Error('offline-inbox')
    }).recordChildProgress(input)
  ).rejects.toThrow('offline-inbox')
  const published = []
  const online = service(f, async (event) => {
    published.push(event)
  })
  await online.recordChildProgress({
    ...input,
    interaction: undefined,
    state: 'completed',
    observedAt: '2026-08-25T18:04:00.000Z',
    terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
  })
  expect(published.map((event) => event.details.state)).toEqual(['awaiting_input', 'completed'])
  expect((await f.delegations.get(ids.delegationId)).state).toBe('completed')
})

test('conflicting old interaction cannot mutate a newer interrupted wait', async () => {
  const { f, input } = await setup()
  await service(f, async () => {}).recordChildProgress(input)
  const newer = {
    ...input,
    interaction: { ...input.interaction, interactionId: 'int_01JCBCDEF0123456789ABCDEFG' },
  }
  const interrupted = new DelegationService({
    ...f,
    delegations: {
      get: (id) => f.delegations.get(id),
      compareAndSet: (revision, record) =>
        record.pendingProgress === undefined
          ? Promise.reject(new Error('interrupted-new-wait'))
          : f.delegations.compareAndSet(revision, record),
    },
  })
  await expect(interrupted.recordChildProgress(newer)).rejects.toThrow('interrupted-new-wait')
  const before = await f.delegations.get(ids.delegationId)
  await expect(
    service(f, async () => {}).recordChildProgress({
      ...input,
      interaction: { ...input.interaction, kind: 'approval' },
    })
  ).rejects.toMatchObject({ code: 'DELEGATION_STATE_CONFLICT' })
  expect(await f.delegations.get(ids.delegationId)).toEqual(before)
})

test('a later running notification follows its retained waiting evidence', async () => {
  const { f, input } = await setup()
  await expect(
    service(f, async () => {
      throw new Error('offline-inbox')
    }).recordChildProgress(input)
  ).rejects.toThrow('offline-inbox')
  const delivered = []
  const s = service(f, async (event) => {
    delivered.push(event)
  })
  await s.recordChildProgress({
    ...input,
    interaction: undefined,
    state: 'running',
    observedAt: '2026-08-25T18:03:00.000Z',
  })
  await s.reconcileChildPublications(ids.parentExecutionId)
  expect(delivered.map((event) => event.details.state)).toEqual(['awaiting_input', 'running'])
  expect((await f.delegations.get(ids.delegationId)).state).toBe('running')
})

test('a new waiting interaction is delivered after earlier retained waiting evidence', async () => {
  const { f, input } = await setup()
  await expect(
    service(f, async () => {
      throw new Error('offline-inbox')
    }).recordChildProgress(input)
  ).rejects.toThrow('offline-inbox')
  const delivered = []
  const s = service(f, async (event) => {
    delivered.push(event)
  })
  const newer = {
    ...input,
    interaction: { ...input.interaction, interactionId: 'int_01JCBCDEF0123456789ABCDEFG' },
    observedAt: '2026-08-25T18:03:00.000Z',
  }
  await s.recordChildProgress(newer)
  await s.reconcileChildPublications(ids.parentExecutionId)
  expect(delivered.map((event) => event.details.interaction)).toEqual([
    input.interaction,
    newer.interaction,
  ])
})

test('replaying a newer pending wait drains the older receipt before retrying its own envelope', async () => {
  const { f, input } = await setup()
  const offline = service(f, async () => {
    throw new Error('offline-inbox')
  })
  await expect(offline.recordChildProgress(input)).rejects.toThrow('offline-inbox')
  const newer = {
    ...input,
    interaction: { ...input.interaction, interactionId: 'int_01JCBCDEF0123456789ABCDEFG' },
    observedAt: '2026-08-25T18:03:00.000Z',
  }
  await expect(offline.recordChildProgress(newer)).rejects.toThrow('offline-inbox')
  const published = []
  await service(f, async (event) => {
    published.push(event)
  }).recordChildProgress(newer)
  expect(published.map((event) => event.details.interaction)).toEqual([
    input.interaction,
    newer.interaction,
  ])
})
