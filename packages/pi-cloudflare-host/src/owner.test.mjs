import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { CloudflareOwnerJournal } from './owner.ts'

const pins = {
  schemaVersion: 1,
  adapterVersion: '0.1.0',
  runtimeVersion: '1.1.0',
  configurationDigest: `sha256:${'a'.repeat(64)}`,
  workspaceId: 'workspace-a',
  conversationId: 'conversation-a',
  agentId: 'agent-a',
}
const task = {
  schemaVersion: 1,
  canonicalActorPrincipalId: 'user:original-actor',
  request: {
    attemptId: 'attempt-a',
    idempotencyKey: 'replay-a',
    executionPlan: {
      schemaVersion: 1,
      executionPlanId: 'plan-a',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      runtimeRequirements: [],
    },
  },
}
function fixture() {
  const database = new Database(':memory:')
  let alarms = [],
    failAlarm = false
  const storage = {
    sql: {
      exec(query, ...bindings) {
        const rows = database.query(query).all(...bindings)
        return { toArray: () => rows }
      },
    },
    transactionSync: (fn) => database.transaction(fn)(),
    async setAlarm(time) {
      if (failAlarm) throw new Error('alarm unavailable')
      alarms.push(time)
    },
  }
  return {
    storage,
    database,
    alarms,
    failAlarm: () => {
      failAlarm = true
    },
    restoreAlarm: () => {
      failAlarm = false
    },
  }
}

test('reopen retains exact old plan bytes, replay identity and progress cursor', () => {
  const f = fixture()
  try {
    const first = new CloudflareOwnerJournal(f.storage, pins)
    first.admit(task, 42)
    const cursor = first.events('attempt-a')[0].sequence
    const reopened = new CloudflareOwnerJournal(f.storage, pins)
    expect(reopened.admit(task, 42).task).toEqual(task)
    expect(reopened.events('attempt-a', cursor)).toEqual([])
    expect(reopened.events('attempt-a')).toHaveLength(1)
    expect(() => first.get('attempt-a')).toThrow('CLOUDFLARE_OWNER_STALE')
  } finally {
    f.database.close()
  }
})

test('replay conflicts on changed pins or duplicate attempt/replay alias', () => {
  const f = fixture()
  try {
    const owner = new CloudflareOwnerJournal(f.storage, pins)
    owner.admit(task, 42)
    for (const changed of [
      { ...task, canonicalActorPrincipalId: 'user:another-actor' },
      { ...task, request: { ...task.request, attemptId: 'another-attempt' } },
      { ...task, request: { ...task.request, idempotencyKey: 'another-key' } },
      {
        ...task,
        request: {
          ...task.request,
          executionPlan: {
            ...task.request.executionPlan,
            contentDigest: `sha256:${'c'.repeat(64)}`,
          },
        },
      },
    ])
      expect(() => owner.admit(changed, 42)).toThrow('CLOUDFLARE_ADMISSION_REPLAY_CONFLICT')
    expect(owner.events('attempt-a')).toHaveLength(1)
  } finally {
    f.database.close()
  }
})

test('unknown runtime, configuration upgrade and cross-binding fail closed without mutating owner', () => {
  const f = fixture()
  try {
    const owner = new CloudflareOwnerJournal(f.storage, pins)
    owner.admit(task, 42)
    for (const changed of [
      { runtimeVersion: '9.0.0' },
      { schemaVersion: 2 },
      { configurationDigest: `sha256:${'c'.repeat(64)}` },
      { workspaceId: 'workspace-b' },
      { conversationId: 'conversation-b' },
      { agentId: 'agent-b' },
    ]) {
      expect(() => new CloudflareOwnerJournal(f.storage, { ...pins, ...changed })).toThrow()
    }
    expect(owner.get('attempt-a').state).toBe('accepted')
  } finally {
    f.database.close()
  }
})

test('running send becomes reconciliation required on reopen and never auto-retries', () => {
  const f = fixture()
  try {
    const owner = new CloudflareOwnerJournal(f.storage, pins)
    owner.admit(task, 42)
    owner.transition('attempt-a', 'accepted', 'running')
    const reopened = new CloudflareOwnerJournal(f.storage, pins)
    expect(reopened.get('attempt-a').state).toBe('reconciliation_required')
    expect(() => reopened.transition('attempt-a', 'reconciliation_required', 'running')).toThrow()
    expect(reopened.events('attempt-a').map((event) => event.state)).toEqual([
      'accepted',
      'running',
      'reconciliation_required',
    ])
    const secondWake = new CloudflareOwnerJournal(f.storage, pins)
    expect(secondWake.events('attempt-a')).toHaveLength(3)
  } finally {
    f.database.close()
  }
})

test('cancelled/completed outcomes survive repeated wake', () => {
  const f = fixture()
  try {
    const owner = new CloudflareOwnerJournal(f.storage, pins)
    owner.admit(task, 42)
    owner.transition('attempt-a', 'accepted', 'cancelled')
    const reopened = new CloudflareOwnerJournal(f.storage, pins)
    expect(reopened.admit(task, 42).state).toBe('cancelled')
    expect(() => reopened.transition('attempt-a', 'cancelled', 'running')).toThrow()
  } finally {
    f.database.close()
  }
})

test('failed asynchronous alarm leaves durable wake intent recoverable', async () => {
  const f = fixture()
  try {
    const owner = new CloudflareOwnerJournal(f.storage, pins)
    owner.admit(task, 42)
    f.failAlarm()
    await expect(owner.repairAlarm()).rejects.toThrow('alarm unavailable')
    f.restoreAlarm()
    const reopened = new CloudflareOwnerJournal(f.storage, pins)
    await reopened.repairAlarm()
    expect(f.alarms).toEqual([42])
    expect(reopened.get('attempt-a').state).toBe('accepted')
  } finally {
    f.database.close()
  }
})

test('failed admission rolls back task, event and wake intent together', () => {
  const f = fixture()
  try {
    const owner = new CloudflareOwnerJournal(f.storage, pins)
    expect(() => owner.admit(task, -1)).toThrow('CLOUDFLARE_WAKE_TIME_INVALID')
    expect(() => owner.get('attempt-a')).toThrow('CLOUDFLARE_TASK_MISSING')
    expect(f.database.query('SELECT * FROM cp_pi_events').all()).toEqual([])
    expect(f.database.query('SELECT * FROM cp_pi_wake').all()).toEqual([])
  } finally {
    f.database.close()
  }
})
