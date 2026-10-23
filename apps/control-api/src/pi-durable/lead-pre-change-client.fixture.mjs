import { z } from 'zod'
import {
  IdentifierSchemas,
  StateChangingCommandEnvelopeSchema,
  SuccessResponseEnvelopeSchema,
} from '@control-plane/contracts'
import {
  PiDurableLeadRequestedTargetSchema,
  RuntimeExecutionHandleSchema,
  RuntimeExecutionResultSchema,
  RuntimeExecutionStateSchema,
  RuntimeErrorSchema,
  RuntimeUsageSchema,
} from '@control-plane/runtime-sdk'

/**
 * The installed consumer's validation shapes, copied verbatim from the
 * pre-change contract (`adea-ai/control-plane` at `4e126a7c3`,
 * `packages/runtime-sdk/src/adapter.ts` and `packages/runtime-sdk/src/pi-durable-lead.ts`).
 *
 * They are the real strict shapes of the pre-3.1 SDK, not a reconstruction: a
 * response that carries the 3.1 runtime-observed generation is rejected by
 * them exactly as the installed SDK rejects it and maps the parse failure to
 * an invalid response. The compatibility proof parses a current server
 * response with these shapes.
 */

const TimestampSchema = z.iso.datetime()
const DispatchId = z.string().regex(/^dispatch_[a-f0-9]{32}$/)
const IntentId = z.uuid()
const Correlation = StateChangingCommandEnvelopeSchema.shape.correlation.strict()

/** Pre-3.1 observed target: the session and the task, and no generation. */
export const PreChangeObservedTargetSchema = z
  .strictObject({
    sessionId: z.string().trim().min(1).max(256),
    taskId: z.string().trim().min(1).max(256),
  })
  .readonly()

/** Pre-3.1 runtime execution status: no observed generation. */
export const PreChangeRuntimeExecutionStatusSchema = z
  .object({
    handle: RuntimeExecutionHandleSchema,
    state: RuntimeExecutionStateSchema,
    observedAt: TimestampSchema,
    result: RuntimeExecutionResultSchema.optional(),
    terminalUsage: RuntimeUsageSchema.optional(),
    error: RuntimeErrorSchema.optional(),
  })
  .strict()

/** Pre-3.1 dispatch receipt. */
export const PreChangeReceiptResponseSchema = z
  .object({
    schemaVersion: z.literal('pi-lead-dispatch/v1'),
    dispatchId: DispatchId,
    intentId: IntentId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    runtimeSessionId: RuntimeExecutionHandleSchema.shape.externalSessionId.unwrap(),
    requestedTarget: PiDurableLeadRequestedTargetSchema.optional(),
    observedTarget: PreChangeObservedTargetSchema.optional(),
  })
  .strict()

const response = SuccessResponseEnvelopeSchema.extend({ correlation: Correlation }).strict()

/** Pre-3.1 lead status response, as the installed SDK validates it. */
export const PreChangeStatusResponseSchema = response.extend({
  data: PreChangeReceiptResponseSchema.extend({
    state: RuntimeExecutionStateSchema,
    status: PreChangeRuntimeExecutionStatusSchema,
  }),
})

/** Pre-3.1 lead dispatch response, as the installed SDK validates it. */
export const PreChangeDispatchResponseSchema = response.extend({
  data: PreChangeReceiptResponseSchema.extend({
    state: RuntimeExecutionStateSchema,
    replayed: z.boolean(),
  }),
})
