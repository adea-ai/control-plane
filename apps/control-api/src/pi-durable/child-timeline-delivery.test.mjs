import { test, expect } from 'bun:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPiChildTimelineDelivery,
  createPiChildTimelineHttpNotify,
  PI_CHILD_TIMELINE_MAX_INBOX_EVENTS,
} from './child-timeline-delivery.ts'
import { SqlitePiDurableLeadReceiptStore } from './pi-durable-lead.service.ts'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const workspaceId = id('wsp')
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const parentExecutionId = id('exe')
const receipt = {
  schemaVersion: 'pi-lead-receipt/v1',
  dispatchId: `dispatch_${'a'.repeat(32)}`,
  intentId,
  workspaceId,
  admissionDigest: `sha256:${'1'.repeat(64)}`,
  startDigest: `sha256:${'2'.repeat(64)}`,
  deadlineAt: '2026-10-20T16:00:00.000Z',
  executionId: parentExecutionId,
  attemptId: id('att'),
  allowedPrincipalIds: ['svc_adea'],
  revision: 2,
  state: 'dispatched',
  handle: {
    handleId: 'hEC01JABCDEF0123456789ABCDEFGH',
    attemptId: id('att'),
    externalSessionId: id('ses'),
    startedAt: '2026-10-20T15:00:00.000Z',
  },
}
const event = (type = 'delegation.completed', parent = parentExecutionId) => ({
  type,
  delegationId: id('dlg'),
  parentExecutionId: parent,
  childExecutionId: id('exe'),
  occurredAt: '2026-10-20T15:01:00.000Z',
  details: { state: type.replace('delegation.', ''), childAttemptId: id('att') },
})

test('terminal inbox retries after failure and SQLite process reopen without resending a child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-child-timeline-'))
  const filename = join(directory, 'receipts.sqlite')
  let database = new DatabaseSync(filename)
  const deliveries = []
  let fail = true
  const notify = async (input) => {
    if (fail) throw new Error('offline')
    deliveries.push(input)
  }
  const parentInbox = { list: async () => [event(), event()] }
  try {
    const receipts = new SqlitePiDurableLeadReceiptStore(database)
    expect(await receipts.insert(receipt)).toBe(true)
    const first = createPiChildTimelineDelivery({
      database,
      parentInbox,
      principalId: 'svc_adea',
      notify,
    })
    expect(await first.reconcile()).toEqual({
      delivered: 0,
      blocked: [receipt.dispatchId],
      rejected: 0,
    })
    database.close()
    database = new DatabaseSync(filename)
    fail = false
    const reopened = createPiChildTimelineDelivery({
      database,
      parentInbox,
      principalId: 'svc_adea',
      notify,
    })
    expect(await reopened.reconcile()).toEqual({ delivered: 1, blocked: [], rejected: 0 })
    expect(await reopened.reconcile()).toEqual({ delivered: 1, blocked: [], rejected: 0 })
    expect(deliveries).toEqual([
      { workspaceId, intentId, principalId: 'svc_adea' },
      { workspaceId, intentId, principalId: 'svc_adea' },
    ])
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('nonterminal, unknown parent, and undispatched receipts cannot wake Adea', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    const receipts = new SqlitePiDurableLeadReceiptStore(database)
    await receipts.insert({ ...receipt, state: 'dispatching', revision: 1, handle: undefined })
    const notified = []
    const delivery = createPiChildTimelineDelivery({
      database,
      parentInbox: {
        list: async () => [
          { ...event('delegation.progress'), details: { state: 'running' } },
          event(),
          event('delegation.failed', `${parentExecutionId.slice(0, -1)}H`),
        ],
      },
      principalId: 'svc_adea',
      notify: async (input) => notified.push(input),
    })
    expect(await delivery.reconcile()).toEqual({ delivered: 0, blocked: [], rejected: 0 })
    expect(notified).toEqual([])
  } finally {
    database.close()
  }
})

test('HTTP wake uses only selectors and existing scoped credential, and fails closed on denial', async () => {
  const calls = []
  const send = createPiChildTimelineHttpNotify({
    endpoint: 'https://adea.example/api/internal/pi-durable/child-receipt/reconcile',
    credentials: {
      async getExistingCredential(input) {
        calls.push(input)
        return 'aaa.bbb.ccc'
      },
    },
    async fetch(url, init) {
      calls.push({ url: String(url), init })
      return new Response(null, { status: 204 })
    },
  })
  await send({ workspaceId, intentId, principalId: 'svc_adea' })
  expect(calls[0]).toEqual({
    audience: 'adea-lead-product',
    workspaceId,
    principalId: 'svc_adea',
    scope: 'execution:read',
  })
  expect(JSON.parse(calls[1].init.body)).toEqual({ workspaceId, intentId, principalId: 'svc_adea' })
  expect(calls[1].init.redirect).toBe('error')
  expect(calls[1].init.headers.authorization).toBe('Bearer aaa.bbb.ccc')
  const refused = createPiChildTimelineHttpNotify({
    endpoint: 'https://adea.example/api/internal/pi-durable/child-receipt/reconcile',
    credentials: { getExistingCredential: async () => 'aaa.bbb.ccc' },
    fetch: async () => new Response(null, { status: 404 }),
  })
  await expect(refused({ workspaceId, intentId, principalId: 'svc_adea' })).rejects.toThrow(
    'PI_CHILD_TIMELINE_UNAVAILABLE'
  )
  expect(() =>
    createPiChildTimelineHttpNotify({
      endpoint: 'http://adea.example/api/internal/pi-durable/child-receipt/reconcile',
      credentials: { getExistingCredential: async () => 'aaa.bbb.ccc' },
    })
  ).toThrow('PI_CHILD_TIMELINE_CONFIGURATION_REQUIRED')
})

test('an oversized retained inbox is refused instead of replayed', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    const receipts = new SqlitePiDurableLeadReceiptStore(database)
    await receipts.insert(receipt)
    const notified = []
    const oversized = Array.from({ length: PI_CHILD_TIMELINE_MAX_INBOX_EVENTS + 1 }, (_, n) => ({
      ...event(),
      delegationId: `dlg_${'0'.repeat(25)}${'0123456789ABCDEFGHJKMNPQRSTVWXYZ'[n % 32]}`,
    }))
    const delivery = createPiChildTimelineDelivery({
      database,
      parentInbox: { list: async () => oversized },
      principalId: 'svc_adea',
      notify: async (input) => notified.push(input),
    })
    await expect(delivery.reconcile()).rejects.toThrow('PI_CHILD_TIMELINE_SCAN_LIMIT')
    expect(notified).toEqual([])
  } finally {
    database.close()
  }
})

test('one malformed retained row does not abort the pass or the settlements behind it', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    const receipts = new SqlitePiDurableLeadReceiptStore(database)
    await receipts.insert(receipt)
    const notified = []
    const delivery = createPiChildTimelineDelivery({
      database,
      parentInbox: {
        list: async () => [
          { type: 'delegation.completed', delegationId: 'not-a-canonical-delegation-id' },
          event(),
        ],
      },
      principalId: 'svc_adea',
      notify: async (input) => notified.push(input),
    })
    expect(await delivery.reconcile()).toEqual({ delivered: 1, blocked: [], rejected: 1 })
    expect(notified).toEqual([{ workspaceId, intentId, principalId: 'svc_adea' }])
  } finally {
    database.close()
  }
})
