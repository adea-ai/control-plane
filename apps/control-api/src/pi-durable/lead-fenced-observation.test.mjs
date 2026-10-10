import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  DurablePiDurableLeadService,
  SqlitePiDurableLeadReceiptStore,
  fencedReceiptGaps,
} from './pi-durable-lead.service.ts'

// M18.01.3 fenced receipt observation/cancel, driven through the real service with an
// in-memory receipt store and stub adapter/authority. The admission bindings supplied by
// `admissionBinding: true` are test-only: the production authority retains no admissionDigest.

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-08T09:00:00.000Z'
const deadlineAt = '2026-10-08T10:00:00.000Z'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const dispatchId = `dispatch_${'a'.repeat(32)}`
const executionId = id('exe')
const attemptId = id('att')
const admissionDigest = `sha256:${'1'.repeat(64)}`
const startDigest = `sha256:${'2'.repeat(64)}`
const caller = {
  kind: 'agent_hq_service',
  principalId: 'svc_adea',
  projectIds: [],
  scopes: ['execution:read', 'execution:cancel', 'execution:accept'],
  workspaceIds: [workspaceId],
}
const handle = {
  handleId: 'hEC01JABCDEF0123456789ABCDEFGH',
  attemptId,
  externalSessionId: id('ses'),
  startedAt: at,
}
const receiptBase = {
  schemaVersion: 'pi-lead-receipt/v1',
  dispatchId,
  intentId,
  workspaceId,
  admissionDigest,
  startDigest,
  deadlineAt,
  executionId,
  attemptId,
  allowedPrincipalIds: ['svc_adea'],
  revision: 2,
  state: 'dispatched',
  handle,
}
const hash = (value) => createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')

/** Fenced v2 result shaped like the node authority's output, with test-only overrides. */
function fenced(operation, options = {}) {
  const {
    retainedMatch = true,
    admissionBinding = false,
    retainedOverrides = {},
    fenceOverrides = {},
  } = options
  return {
    schemaVersion: 'pi-lead-fenced/v1',
    kind: 'fenced',
    operation,
    fenceVariant: 'v2',
    retainedMatch,
    fence: {
      intentId,
      workspaceId,
      fencedAt: at,
      reason: 'operator_intervention',
      actor: { kind: 'user', userId: '2b1a7e26-8c3f-4f4f-9a1e-77d19b7d5e11' },
      authorityRevision: 7,
      canonicalActorPrincipalId: 'user:2b1a7e26-8c3f-4f4f-9a1e-77d19b7d5e11',
      scopeRef: `adea-product:sha256:${'c'.repeat(64)}`,
      allowedPrincipalIds: ['svc_adea'],
      ...fenceOverrides,
    },
    retained: retainedMatch
      ? {
          intentId,
          workspaceId,
          executionId,
          attemptId,
          allowedPrincipalIds: ['svc_adea'],
          executionPlanId: id('pln'),
          executionPlanDigest: `sha256:${'3'.repeat(64)}`,
          ...(admissionBinding ? { admissionDigest, startDigest, deadlineAt } : {}),
          ...retainedOverrides,
        }
      : undefined,
  }
}

async function harness({
  fencedFor = (operation) => fenced(operation),
  statusHandle = handle,
  onEffect = async () => {},
} = {}) {
  const receipts = new SqlitePiDurableLeadReceiptStore(new DatabaseSync(':memory:'))
  await receipts.insert(receiptBase)
  const calls = {
    resolve: [],
    start: 0,
    status: 0,
    progress: 0,
    cancel: 0,
    cancelOptions: undefined,
    assertCurrent: 0,
  }
  const adapter = {
    start: async () => {
      calls.start += 1
      throw new Error('START_NOT_EXPECTED')
    },
    status: async () => {
      calls.status += 1
      await onEffect('status', receipts)
      return { handle: statusHandle, state: 'running', observedAt: at }
    },
    progress: async function* () {
      calls.progress += 1
      yield { handleId: handle.handleId, sequence: 1, occurredAt: at, type: 'status', data: {} }
    },
    cancel: async (_handle, options) => {
      calls.cancel += 1
      calls.cancelOptions = options
      await onEffect('cancel', receipts)
      return { handle, state: 'cancelling', observedAt: at }
    },
  }
  const authority = {
    // `n` counts every authority read in this harness, including the lookup.
    resolveIntent: async ({ operation }) => {
      calls.resolve.push(operation)
      return fencedFor(operation, calls.resolve.length)
    },
    assertCurrent: async () => {
      calls.assertCurrent += 1
    },
  }
  const service = new DurablePiDurableLeadService({ authority, receipts, adapter, now: () => at })
  return { service, receipts, calls }
}

const withBinding = (operation) => fenced(operation, { admissionBinding: true })

const envelope = (operation, payload) => ({
  caller: { servicePrincipalId: 'svc_adea' },
  contractVersion: { major: 1, minor: 0 },
  requestId: id('req'),
  workspaceId,
  correlation: { traceId: id('trc') },
  commandId: id('cmd'),
  idempotencyKey: 'transport-command:cancel-one',
  payloadHash: hash(payload),
  operation,
  issuedAt: at,
  payload,
})
const readRequest = (operation, parameters) => ({
  caller: { servicePrincipalId: 'svc_adea' },
  contractVersion: { major: 1, minor: 0 },
  requestId: id('req'),
  workspaceId,
  correlation: { traceId: id('trc') },
  operation,
  requestedAt: at,
  parameters,
})
const statusRequest = () => readRequest('pi-durable.lead.status', { dispatchId })
const progressRequest = () => readRequest('pi-durable.lead.progress', { dispatchId })
const cancelRequest = () => envelope('pi-durable.lead.cancel', { dispatchId })

test('v2 fenced status observes the retained handle, rechecking authority before and after the effect', async () => {
  const { service, calls } = await harness({ fencedFor: withBinding })
  const result = await service.status(statusRequest(), caller)
  expect(result.data.dispatchId).toBe(dispatchId)
  expect(result.data.state).toBe('running')
  expect(calls.status).toBe(1)
  // Lookup, pre-effect recheck, post-effect recheck. The admission assertion is never used.
  expect(calls.resolve).toEqual(['status', 'status', 'status'])
  expect(calls.assertCurrent).toBe(0)
  expect(calls.start).toBe(0)
})

test('v2 fenced progress returns bounded events and never starts or cancels', async () => {
  const { service, calls } = await harness({ fencedFor: withBinding })
  const result = await service.progress(progressRequest(), caller)
  expect(result.data.events).toHaveLength(1)
  expect(result.data.nextSequence).toBe(1)
  expect(calls.progress).toBe(1)
  expect(calls.start).toBe(0)
  expect(calls.cancel).toBe(0)
})

test('v2 fenced cancel uses the command idempotency key once and never starts', async () => {
  const { service, calls } = await harness({ fencedFor: withBinding })
  const request = cancelRequest()
  const result = await service.cancel(request, caller)
  expect(result.data.state).toBe('cancelling')
  expect(calls.cancel).toBe(1)
  expect(calls.cancelOptions).toEqual({ idempotencyKey: request.idempotencyKey, requestedAt: at })
  expect(calls.start).toBe(0)
})

test('production-shaped fence without admission bindings fails closed for status, progress and cancel with no effect', async () => {
  const { service, calls } = await harness()
  // Exact receipt bindings the retained fence cannot prove.
  expect(fencedReceiptGaps(fenced('status'))).toEqual([
    'admissionDigest',
    'startDigest',
    'deadlineAt',
  ])
  await expect(service.status(statusRequest(), caller)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
  await expect(service.progress(progressRequest(), caller)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
  await expect(service.cancel(cancelRequest(), caller)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
  expect(calls.status + calls.progress + calls.cancel + calls.start).toBe(0)
})

test('fenced dispatch and lookup never reach the admission path (#resolve rejects every fenced result)', async () => {
  const { service, calls } = await harness({ fencedFor: withBinding })
  await expect(
    service.dispatch(envelope('pi-durable.lead.dispatch', { intentId }), caller)
  ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
  await expect(
    service.lookup(readRequest('pi-durable.lead.lookup', { intentId }), caller)
  ).rejects.toThrow('PI_LEAD_UNAVAILABLE')
  expect(calls.start).toBe(0)
  expect(calls.status + calls.progress + calls.cancel).toBe(0)
})

test('retained execution or attempt mismatch fails closed as a conflict before any effect', async () => {
  // Distinct from the receipt's executionId/attemptId (the `id()` fixtures above).
  const otherExecutionId = 'exe_01KABCDEF0123456789ABCDEFG'
  const otherAttemptId = 'att_01KABCDEF0123456789ABCDEFG'
  for (const retainedOverrides of [
    { executionId: otherExecutionId },
    { attemptId: otherAttemptId },
  ]) {
    const { service, calls } = await harness({
      fencedFor: (operation) => fenced(operation, { admissionBinding: true, retainedOverrides }),
    })
    await expect(service.status(statusRequest(), caller)).rejects.toThrow(
      'PI_LEAD_AUTHORITY_CONFLICT'
    )
    expect(calls.status).toBe(0)
  }
})

test('retained audience mismatch fails closed as a conflict before any effect', async () => {
  const { service, calls } = await harness({
    fencedFor: (operation) =>
      fenced(operation, {
        admissionBinding: true,
        retainedOverrides: { allowedPrincipalIds: ['svc_other'] },
      }),
  })
  await expect(service.cancel(cancelRequest(), caller)).rejects.toThrow(
    'PI_LEAD_AUTHORITY_CONFLICT'
  )
  expect(calls.cancel).toBe(0)
})

test('no retained marker (retainedMatch false) fails closed for observation and cancel', async () => {
  const { service, calls } = await harness({
    fencedFor: (operation) => fenced(operation, { retainedMatch: false, admissionBinding: true }),
  })
  await expect(service.status(statusRequest(), caller)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
  await expect(service.cancel(cancelRequest(), caller)).rejects.toThrow('PI_LEAD_UNAVAILABLE')
  expect(calls.status + calls.cancel).toBe(0)
})

test('authority drift before the effect fails closed without calling the adapter', async () => {
  const { service, calls } = await harness({
    // Lookup (read 1) matches; the pre-effect recheck (read 2) sees a superseded revision.
    fencedFor: (operation, n) =>
      fenced(operation, {
        admissionBinding: true,
        fenceOverrides: n === 1 ? {} : { authorityRevision: 8 },
      }),
  })
  await expect(service.status(statusRequest(), caller)).rejects.toThrow(
    'PI_LEAD_AUTHORITY_CONFLICT'
  )
  expect(calls.status).toBe(0)
})

test('authority drift after the effect fails closed and returns no observation', async () => {
  const { service, calls } = await harness({
    // Lookup and pre-effect recheck (reads 1-2) match; the post-effect recheck (read 3) drifts.
    fencedFor: (operation, n) =>
      fenced(operation, {
        admissionBinding: true,
        fenceOverrides: n <= 2 ? {} : { authorityRevision: 8 },
      }),
  })
  await expect(service.status(statusRequest(), caller)).rejects.toThrow(
    'PI_LEAD_AUTHORITY_CONFLICT'
  )
  expect(calls.status).toBe(1)
})

test('receipt generation change during the effect fails closed', async () => {
  const { service, calls } = await harness({
    fencedFor: withBinding,
    onEffect: async (operation, receipts) => {
      if (operation === 'cancel') await receipts.compareAndSet(2, { ...receiptBase, revision: 3 })
    },
  })
  await expect(service.cancel(cancelRequest(), caller)).rejects.toThrow('PI_LEAD_DISPATCH_CONFLICT')
  expect(calls.cancel).toBe(1)
})

test('a runtime handle that differs from the retained receipt handle fails closed', async () => {
  const { service, calls } = await harness({
    fencedFor: withBinding,
    statusHandle: { ...handle, handleId: 'hEC01JABCDEF0123456789ABCDEFGJ' },
  })
  await expect(service.status(statusRequest(), caller)).rejects.toThrow(
    'PI_LEAD_AUTHORITY_CONFLICT'
  )
  expect(calls.status).toBe(1)
})
