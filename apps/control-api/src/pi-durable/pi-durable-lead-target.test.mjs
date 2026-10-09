import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { DurablePiDurableLeadService, PiDurableLeadError } from './pi-durable-lead.service.ts'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-08T09:00:00.000Z'
const deadlineAt = '2027-01-01T00:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const principalId = 'svc_target-test'
const hash = (value) =>
  createHash('sha256')
    .update(canonicalJsonStringify(value) ?? 'null')
    .digest('hex')
const target = {
  sessionId: id('ses'),
  taskId: '00000000-0000-4000-8000-0000000000f1',
  generation: 3,
}

function harness() {
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: [],
    skillRequiredCapabilities: [],
  })
  const workspaceId = plan.correlation.workspaceId
  const projectId = plan.correlation.projectId
  const startRequest = {
    executionId: id('exe'),
    attemptId: id('att'),
    idempotencyKey: 'target-message:one',
    executionPlan: plan,
    attemptBudget: {
      schemaVersion: 1,
      workspaceId,
      executionId: id('exe'),
      attemptId: id('att'),
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
      reservationKey: `runtime-attempt:${id('att')}`,
      currency: 'USD',
      maximumMicrounits: 10000,
      maximumTokens: 100,
    },
  }
  const admission = {
    schemaVersion: 'pi-lead-authority/v1',
    workspaceId,
    intentId,
    admissionDigest: `sha256:${'a'.repeat(64)}`,
    startRequest,
    admittedAttempt: {
      executionId: id('exe'),
      attemptId: id('att'),
      executionPlanId: plan.executionPlanId,
      executionPlanDigest: plan.contentDigest,
    },
    deadlineAt,
    allowedPrincipalIds: [principalId],
  }
  const principal = {
    kind: 'internal_service',
    principalId,
    projectIds: projectId ? [projectId] : [],
    scopes: ['execution:accept', 'execution:read', 'execution:cancel'],
    workspaceIds: [workspaceId],
  }
  const store = new Map()
  const receipts = {
    get: async (dispatchId) => store.get(dispatchId),
    insert: async (receipt) => {
      if (store.has(receipt.dispatchId)) return false
      store.set(receipt.dispatchId, receipt)
      return true
    },
    compareAndSet: async (expected, receipt) => {
      if (store.get(receipt.dispatchId)?.revision !== expected) return false
      store.set(receipt.dispatchId, receipt)
      return true
    },
    bindCommand: async (key, digest) => {
      if (store.has(`cmd:${key}`)) return store.get(`cmd:${key}`) === digest
      store.set(`cmd:${key}`, digest)
      return true
    },
  }
  const calls = { starts: 0, cancels: 0, childStops: [] }
  let confirmed = false
  const handle = {
    handleId: 'hEC01JABCDEF0123456789ABCDEFGH',
    attemptId: id('att'),
    externalSessionId: id('ses'),
    startedAt: at,
  }
  const adapter = {
    start: async () => {
      calls.starts += 1
      return handle
    },
    status: async () => ({
      handle,
      state: calls.cancels > 0 ? (confirmed ? 'cancelled' : 'cancelling') : 'running',
      observedAt: at,
    }),
    progress: async function* () {},
    cancel: async () => {
      calls.cancels += 1
      return { handle, state: confirmed ? 'cancelled' : 'cancelling', observedAt: at }
    },
  }
  const service = new DurablePiDurableLeadService({
    authority: {
      resolveIntent: async () => admission,
      assertCurrent: async () => undefined,
    },
    receipts,
    adapter,
    delegationService: {
      cancelChildren: async (input) => {
        calls.childStops.push(input)
        return { cancelled: [], state: 'cancelled' }
      },
    },
  })
  const envelope = (operation, payload, key = 'target-command:one') => ({
    caller: { servicePrincipalId: principalId },
    contractVersion: { major: 1, minor: 0 },
    requestId: id('req'),
    commandId: id('cmd'),
    workspaceId,
    ...(projectId ? { projectId } : {}),
    correlation: { traceId: id('trc') },
    idempotencyKey: key,
    payloadHash: hash(payload),
    operation,
    issuedAt: at,
    payload,
  })
  const read = (operation, parameters) => ({
    caller: { servicePrincipalId: principalId },
    contractVersion: { major: 1, minor: 0 },
    requestId: id('req'),
    workspaceId,
    ...(projectId ? { projectId } : {}),
    correlation: { traceId: id('trc') },
    operation,
    requestedAt: at,
    parameters,
  })
  const confirm = () => {
    confirmed = true
  }
  return { service, envelope, read, principal, calls, confirm }
}

const codeOf = async (work) => {
  try {
    await work()
  } catch (error) {
    if (error instanceof PiDurableLeadError) return error.code
    throw error
  }
  throw new Error('expected PiDurableLeadError')
}

/**
 * control-plane#935: target-bound execution observation at the lead
 * service. Dispatch retains the request target on the immutable receipt;
 * lookup and status echo it; redelivery naming another target conflicts
 * at the command digest instead of rebinding. Cancellation routes the
 * canonical child stop with the admitted parent's execution identity.
 */
test('935: dispatch retains the target; lookup and status echo it', async () => {
  const { service, envelope, read, principal } = harness()
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, target }),
    principal
  )
  expect(dispatched.data.target).toEqual(target)
  const lookup = await service.lookup(read('pi-durable.lead.lookup', { intentId }), principal)
  expect(lookup.data.receipt).toMatchObject({ target })
  const status = await service.status(
    read('pi-durable.lead.status', { dispatchId: dispatched.data.dispatchId }),
    principal
  )
  expect(status.data).toMatchObject({ target })
})

test('935: redelivery cannot rebind the retained target', async () => {
  const { service, envelope, principal } = harness()
  await service.dispatch(envelope('pi-durable.lead.dispatch', { intentId, target }), principal)
  const other = { ...target, generation: 9 }
  // Same idempotency key with a changed target: command conflict, never a
  // silent rebinding.
  expect(
    await codeOf(() =>
      service.dispatch(envelope('pi-durable.lead.dispatch', { intentId, target: other }), principal)
    )
  ).toBe('PI_LEAD_COMMAND_CONFLICT')
  // Fresh key with a changed target: returns the ORIGINAL retained receipt
  // unchanged — the claim never moves under the same dispatch.
  const replayed = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, target: other }, 'target-command:two'),
    principal
  )
  expect(replayed.data.target).toEqual(target)
})

test('935: cancellation reports pending until the engine confirms', async () => {
  const { service, envelope, read, principal, calls, confirm } = harness()
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, target }),
    principal
  )
  // The fake engine never confirms: the intent stays pending, and every
  // status read says so — never settled, never lost.
  await service.cancel(
    envelope(
      'pi-durable.lead.cancel',
      { dispatchId: dispatched.data.dispatchId },
      'target-cancel:pending'
    ),
    principal
  )
  expect(calls.cancels).toBe(1)
  const pending = await service.status(
    read('pi-durable.lead.status', { dispatchId: dispatched.data.dispatchId }),
    principal
  )
  expect(pending.data.state).toBe('cancelling')
  expect(pending.data).toMatchObject({ target })
  confirm()
  const settled = await service.status(
    read('pi-durable.lead.status', { dispatchId: dispatched.data.dispatchId }),
    principal
  )
  expect(settled.data.state).toBe('cancelled')
  expect(settled.data).toMatchObject({ target })
})

test('935: cancel routes the canonical child stop with the admitted execution', async () => {
  const { service, envelope, principal, calls } = harness()
  const dispatched = await service.dispatch(
    envelope('pi-durable.lead.dispatch', { intentId, target }),
    principal
  )
  await service.cancel(
    envelope(
      'pi-durable.lead.cancel',
      { dispatchId: dispatched.data.dispatchId },
      'target-cancel:one'
    ),
    principal
  )
  expect(calls.cancels).toBe(1)
  expect(calls.childStops).toHaveLength(1)
  expect(calls.childStops[0]).toMatchObject({
    parentExecutionId: dispatched.data.executionId,
  })
})
