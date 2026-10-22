import { expect, test } from 'bun:test'
import { z } from 'zod'
import { PublicContractManifest } from '@control-plane/contracts'
import {
  PI_DURABLE_OBSERVED_GENERATION_CONTRACT_VERSION,
  PiDurableLeadDispatchRequestSchema,
  PiDurableLeadLookupResponseSchema,
  PiDurableLeadObservedTargetSchema,
  PiDurableLeadPrepareRequestSchema,
  PiDurableLeadReceiptResponseSchema,
  PiDurableLeadRequestedTargetSchema,
  PiDurableLeadStatusResponseSchema,
  supportsPiDurableObservedGeneration,
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

test('935: observedTarget carries only server-owned session, task, and observed generation', () => {
  expect(
    PiDurableLeadObservedTargetSchema.parse({ sessionId: id('ses'), taskId: id('tsk') })
  ).toEqual({ sessionId: id('ses'), taskId: id('tsk') })
  // The generation the observation may carry is the runtime's own observed
  // identity for the attempt — never a counter the caller claims.
  const observedGeneration = {
    schemaVersion: 'runtime-observed-generation/v1',
    attemptId: id('att'),
    turnKey: `pi-turn:${id('att')}:initial`,
    inferenceId: 'pi-generation:1',
    inferenceKey: `pi-turn:${id('att')}:initial:pi-generation:1`,
  }
  expect(
    PiDurableLeadObservedTargetSchema.parse({
      sessionId: id('ses'),
      taskId: id('tsk'),
      generation: observedGeneration,
    })
  ).toEqual({ sessionId: id('ses'), taskId: id('tsk'), generation: observedGeneration })
  // A claimed generation can never be laundered into an observation: the
  // requested shape is a number, the observed shape is an identity.
  expect(() =>
    PiDurableLeadObservedTargetSchema.parse({
      sessionId: id('ses'),
      taskId: id('tsk'),
      generation: 3,
    })
  ).toThrow()
  // Nominal task/session shapes stay open.
  for (const bad of [{}, { sessionId: id('ses') }, { taskId: id('tsk') }, null])
    expect(() => PiDurableLeadObservedTargetSchema.parse(bad)).toThrow()
})

test('935: a receipt refuses an observed generation that belongs to another attempt', () => {
  const receipt = {
    schemaVersion: 'pi-lead-dispatch/v1',
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    intentId,
    executionId: id('exe'),
    attemptId: id('att'),
    runtimeSessionId: id('ses'),
  }
  const generation = {
    schemaVersion: 'runtime-observed-generation/v1',
    attemptId: id('att'),
    turnKey: `pi-turn:${id('att')}:initial`,
    inferenceId: 'pi-generation:1',
    inferenceKey: `pi-turn:${id('att')}:initial:pi-generation:1`,
  }
  expect(
    PiDurableLeadReceiptResponseSchema.parse({
      ...receipt,
      observedTarget: { sessionId: id('ses'), taskId: id('tsk'), generation },
    })
  ).toMatchObject({ observedTarget: { generation } })
  // A generation observed for another attempt is a late event: the receipt
  // that owns the attempt refuses to publish it.
  expect(() =>
    PiDurableLeadReceiptResponseSchema.parse({
      ...receipt,
      observedTarget: {
        sessionId: id('ses'),
        taskId: id('tsk'),
        generation: { ...generation, attemptId: 'att_01JABCDEF0123456789ABCDEFH' },
      },
    })
  ).toThrow()
})

test('935: a status receipt refuses a late generation observed for another attempt', () => {
  // The embedded runtime status publishes the generation too. A late
  // old-attempt event is refused there as well, so no publication path can
  // carry a foreign generation.
  const generation = {
    schemaVersion: 'runtime-observed-generation/v1',
    attemptId: id('att'),
    turnKey: `pi-turn:${id('att')}:initial`,
    inferenceId: 'pi-generation:1',
    inferenceKey: `pi-turn:${id('att')}:initial:pi-generation:1`,
  }
  const response = {
    contractVersion: PublicContractManifest.current,
    requestId: id('req'),
    correlation: { traceId: id('trc') },
    data: {
      schemaVersion: 'pi-lead-dispatch/v1',
      dispatchId: `dispatch_${'a'.repeat(32)}`,
      intentId,
      executionId: id('exe'),
      attemptId: id('att'),
      runtimeSessionId: id('ses'),
      state: 'running',
      status: {
        handle: {
          handleId: 'hEC01JABCDEF0123456789ABCDEFGH',
          attemptId: id('att'),
          externalSessionId: id('ses'),
          startedAt: at,
        },
        state: 'running',
        observedAt: at,
        observedGeneration: generation,
      },
    },
  }
  expect(PiDurableLeadStatusResponseSchema.parse(response)).toMatchObject({
    data: { status: { observedGeneration: generation } },
  })
  expect(() =>
    PiDurableLeadStatusResponseSchema.parse({
      ...response,
      data: {
        ...response.data,
        status: {
          ...response.data.status,
          observedGeneration: { ...generation, attemptId: 'att_01JABCDEF0123456789ABCDEFH' },
        },
      },
    })
  ).toThrow()
})

test('935: an observed generation whose key does not bind to its turn is refused', () => {
  // The published identity is self-verifying: the inference key is the
  // turn's key extended by the inference id. A key naming another turn or
  // inference is not an observation of this one.
  const generation = {
    schemaVersion: 'runtime-observed-generation/v1',
    attemptId: id('att'),
    turnKey: `pi-turn:${id('att')}:initial`,
    inferenceId: 'pi-generation:1',
    inferenceKey: `pi-turn:${id('att')}:initial:pi-generation:1`,
  }
  for (const broken of [
    { ...generation, inferenceKey: `pi-turn:${id('att')}:other:pi-generation:1` },
    { ...generation, inferenceKey: `pi-turn:${id('att')}:initial:pi-generation:2` },
    { ...generation, inferenceId: 'pi generation:1' },
  ])
    expect(() =>
      PiDurableLeadObservedTargetSchema.parse({
        sessionId: id('ses'),
        taskId: id('tsk'),
        generation: broken,
      })
    ).toThrow()
  expect(
    PiDurableLeadObservedTargetSchema.parse({
      sessionId: id('ses'),
      taskId: id('tsk'),
      generation,
    })
  ).toMatchObject({ generation })
})

test('935: the observed generation is published only to a negotiated consumer', () => {
  // The generation is additive in contract 3.1. A consumer that advertised an
  // earlier same-major version parses with the strict pre-3.1 shape, so the
  // producer withholds the field from it.
  expect(supportsPiDurableObservedGeneration({ major: 3, minor: 1 })).toBe(true)
  expect(supportsPiDurableObservedGeneration({ major: 3, minor: 2 })).toBe(true)
  expect(supportsPiDurableObservedGeneration({ major: 3, minor: 0 })).toBe(false)
  expect(supportsPiDurableObservedGeneration({ major: 2, minor: 0 })).toBe(false)
  expect(supportsPiDurableObservedGeneration({ major: 1, minor: 0 })).toBe(false)
  expect(supportsPiDurableObservedGeneration(undefined)).toBe(false)
  expect(supportsPiDurableObservedGeneration({ major: 3 })).toBe(false)
  // The contract version that introduces the field is the one the gate names.
  expect(PI_DURABLE_OBSERVED_GENERATION_CONTRACT_VERSION).toEqual({ major: 3, minor: 1 })
})

test('935: the pre-3.1 strict observed target rejects the generation', () => {
  // The pre-change shape, copied from the pre-3.1 contract: strict, so an
  // unknown key is a parse failure for the installed consumer. This is why
  // the field is negotiated rather than published unconditionally.
  const preChangeObservedTarget = z
    .strictObject({
      sessionId: z.string().trim().min(1).max(256),
      taskId: z.string().trim().min(1).max(256),
    })
    .readonly()
  expect(preChangeObservedTarget.parse({ sessionId: id('ses'), taskId: id('tsk') })).toEqual({
    sessionId: id('ses'),
    taskId: id('tsk'),
  })
  expect(() =>
    preChangeObservedTarget.parse({
      sessionId: id('ses'),
      taskId: id('tsk'),
      generation: {
        schemaVersion: 'runtime-observed-generation/v1',
        attemptId: id('att'),
        turnKey: `pi-turn:${id('att')}:initial`,
        inferenceId: 'pi-generation:1',
        inferenceKey: `pi-turn:${id('att')}:initial:pi-generation:1`,
      },
    })
  ).toThrow()
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
