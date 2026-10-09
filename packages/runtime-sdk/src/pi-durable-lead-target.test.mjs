import { expect, test } from 'bun:test'
import { PublicContractManifest } from '@control-plane/contracts'
import {
  PiDurableLeadDispatchRequestSchema,
  PiDurableLeadLookupResponseSchema,
  PiDurableLeadObservedTargetSchema,
  PiDurableLeadPrepareRequestSchema,
  PiDurableLeadReceiptResponseSchema,
  PiDurableLeadRequestedTargetSchema,
} from './pi-durable-lead.ts'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-08T09:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const requestedTarget = {
  sessionId: id('ses'),
  taskId: '00000000-0000-4000-8000-0000000000f1',
  generation: 3,
}
const envelope = (operation) => ({
  caller: { servicePrincipalId: 'svc_target-test' },
  contractVersion: PublicContractManifest.current,
  requestId: id('req'),
  commandId: id('cmd'),
  workspaceId: id('wsp'),
  correlation: { traceId: id('trc') },
  operation,
  issuedAt: at,
  idempotencyKey: 'target:test:0001',
  payloadHash: 'a'.repeat(64),
})

/**
 * control-plane#935: target-bound execution observation. The target triple
 * (session+task+generation) travels on prepare/dispatch requests and is
 * echoed on every receipt, so the owner can verify claimed, retained, and
 * observed bindings together. Absent target stays valid (legacy and
 * untargeted flows); malformed targets fail closed. No new authority is
 * implied by the shape alone — verification happens where receipts meet
 * admissions.
 */
test('935: target shape validates session, task, and generation', () => {
  expect(PiDurableLeadRequestedTargetSchema.parse(requestedTarget)).toEqual(requestedTarget)
  for (const bad of [
    { ...requestedTarget, sessionId: '   ' },
    { ...requestedTarget, sessionId: 'x'.repeat(257) },
    // taskId is an opaque cross-system reference: any non-empty string
    // up to 256 chars passes; only shape violations fail.
    { ...requestedTarget, taskId: '' },
    { ...requestedTarget, taskId: 'x'.repeat(257) },
    { ...requestedTarget, generation: -1 },
    { ...requestedTarget, generation: 1.5 },
    { ...requestedTarget, extra: 'nope' },
    'session-only',
    null,
  ])
    expect(() => PiDurableLeadRequestedTargetSchema.parse(bad)).toThrow()
})

test('935: prepare and dispatch accept an optional target', () => {
  // Prepare binds no target: the target binds once, at dispatch where
  // effects begin. A prepare carrying one is rejected, not ignored.
  expect(
    PiDurableLeadPrepareRequestSchema.safeParse({
      ...envelope('pi-durable.lead.prepare'),
      payload: { intentId, requestedTarget },
    }).success
  ).toBe(false)
  const untargeted = PiDurableLeadPrepareRequestSchema.parse({
    ...envelope('pi-durable.lead.prepare'),
    payload: { intentId },
  })
  expect(untargeted.payload).not.toHaveProperty('requestedTarget')
  const dispatch = PiDurableLeadDispatchRequestSchema.parse({
    ...envelope('pi-durable.lead.dispatch'),
    payload: { intentId, requestedTarget },
  })
  expect(dispatch.payload).toMatchObject({ intentId, requestedTarget })
})

test('935: observedTarget carries only server-owned session and task', () => {
  expect(
    PiDurableLeadObservedTargetSchema.parse({ sessionId: id('ses'), taskId: id('tsk') })
  ).toEqual({ sessionId: id('ses'), taskId: id('tsk') })
  // No generation field exists: nothing here may launder a caller-claimed
  // generation as observed. Nominal task/session shapes stay open.
  for (const bad of [{}, { sessionId: id('ses') }, { taskId: id('tsk') }, null])
    expect(() => PiDurableLeadObservedTargetSchema.parse(bad)).toThrow()
})

test('935: receipts echo the retained target when present', () => {
  const receipt = {
    schemaVersion: 'pi-lead-dispatch/v1',
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    intentId,
    executionId: id('exe'),
    attemptId: id('att'),
    runtimeSessionId: id('ses'),
    requestedTarget,
  }
  expect(PiDurableLeadReceiptResponseSchema.parse(receipt)).toMatchObject({ requestedTarget })
  const untargeted = PiDurableLeadReceiptResponseSchema.parse({
    schemaVersion: 'pi-lead-dispatch/v1',
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    intentId,
    executionId: id('exe'),
    attemptId: id('att'),
    runtimeSessionId: id('ses'),
  })
  expect(untargeted).not.toHaveProperty('requestedTarget')
  const lookup = PiDurableLeadLookupResponseSchema.parse({
    contractVersion: PublicContractManifest.current,
    requestId: id('req'),
    correlation: { traceId: id('trc') },
    data: {
      schemaVersion: 'pi-lead-lookup/v1',
      workspaceId: id('wsp'),
      intentId,
      receipt: {
        dispatchId: `dispatch_${'a'.repeat(32)}`,
        executionId: id('exe'),
        attemptId: id('att'),
        state: 'dispatched',
        requestedTarget,
      },
    },
  })
  expect(lookup.data.receipt).toMatchObject({ requestedTarget })
})
