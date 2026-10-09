import { expect, test } from 'bun:test'
import { PublicContractManifest } from '@control-plane/contracts'
import {
  PiDurableLeadDispatchRequestSchema,
  PiDurableLeadLookupResponseSchema,
  PiDurableLeadPrepareRequestSchema,
  PiDurableLeadReceiptResponseSchema,
  PiDurableLeadTargetSchema,
} from './pi-durable-lead.ts'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-08T09:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const target = {
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
  expect(PiDurableLeadTargetSchema.parse(target)).toEqual(target)
  for (const bad of [
    { ...target, sessionId: '   ' },
    { ...target, sessionId: 'x'.repeat(257) },
    { ...target, taskId: 'not-a-uuid' },
    { ...target, generation: -1 },
    { ...target, generation: 1.5 },
    { ...target, extra: 'nope' },
    'session-only',
    null,
  ])
    expect(() => PiDurableLeadTargetSchema.parse(bad)).toThrow()
})

test('935: prepare and dispatch accept an optional target', () => {
  // Prepare binds no target: the target binds once, at dispatch where
  // effects begin. A prepare carrying one is rejected, not ignored.
  expect(
    PiDurableLeadPrepareRequestSchema.safeParse({
      ...envelope('pi-durable.lead.prepare'),
      payload: { intentId, target },
    }).success
  ).toBe(false)
  const untargeted = PiDurableLeadPrepareRequestSchema.parse({
    ...envelope('pi-durable.lead.prepare'),
    payload: { intentId },
  })
  expect(untargeted.payload).not.toHaveProperty('target')
  const dispatch = PiDurableLeadDispatchRequestSchema.parse({
    ...envelope('pi-durable.lead.dispatch'),
    payload: { intentId, target },
  })
  expect(dispatch.payload).toMatchObject({ intentId, target })
})

test('935: receipts echo the retained target when present', () => {
  const receipt = {
    schemaVersion: 'pi-lead-dispatch/v1',
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    intentId,
    executionId: id('exe'),
    attemptId: id('att'),
    runtimeSessionId: id('ses'),
    target,
  }
  expect(PiDurableLeadReceiptResponseSchema.parse(receipt)).toMatchObject({ target })
  const untargeted = PiDurableLeadReceiptResponseSchema.parse({
    schemaVersion: 'pi-lead-dispatch/v1',
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    intentId,
    executionId: id('exe'),
    attemptId: id('att'),
    runtimeSessionId: id('ses'),
  })
  expect(untargeted).not.toHaveProperty('target')
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
        target,
      },
    },
  })
  expect(lookup.data.receipt).toMatchObject({ target })
})
