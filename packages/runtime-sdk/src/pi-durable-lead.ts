import { z } from 'zod'
import {
  IdentifierSchemas,
  ReadRequestEnvelopeSchema,
  StateChangingCommandEnvelopeSchema,
  SuccessResponseEnvelopeSchema,
} from '@control-plane/contracts'
import {
  RuntimeExecutionHandleSchema,
  RuntimeExecutionProgressSchema,
  RuntimeExecutionStatusSchema,
  RuntimeExecutionStateSchema,
} from './adapter.js'

const IntentId = z.uuid()
const DispatchId = z.string().regex(/^dispatch_[a-f0-9]{32}$/)
const Caller = StateChangingCommandEnvelopeSchema.shape.caller.unwrap().strict()
const Correlation = StateChangingCommandEnvelopeSchema.shape.correlation.strict()
export const PiDurableLeadCommandEnvelopeSchema = StateChangingCommandEnvelopeSchema.extend({
  caller: Caller,
  correlation: Correlation,
}).strict()
export const PiDurableLeadReadEnvelopeSchema = ReadRequestEnvelopeSchema.extend({
  caller: Caller,
  correlation: Correlation,
}).strict()
export const PiDurableLeadDispatchRequestSchema = PiDurableLeadCommandEnvelopeSchema.extend({
  operation: z.literal('pi-durable.lead.dispatch'),
  payload: z.object({ intentId: IntentId }).strict(),
})
export const PiDurableLeadStatusRequestSchema = PiDurableLeadReadEnvelopeSchema.extend({
  operation: z.literal('pi-durable.lead.status'),
  parameters: z.object({ dispatchId: DispatchId }).strict(),
})
export const PiDurableLeadProgressRequestSchema = PiDurableLeadReadEnvelopeSchema.extend({
  operation: z.literal('pi-durable.lead.progress'),
  parameters: z
    .object({
      dispatchId: DispatchId,
      afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict(),
})
export const PiDurableLeadCancelRequestSchema = PiDurableLeadCommandEnvelopeSchema.extend({
  operation: z.literal('pi-durable.lead.cancel'),
  payload: z.object({ dispatchId: DispatchId }).strict(),
})

export const PiDurableLeadReceiptResponseSchema = z
  .object({
    schemaVersion: z.literal('pi-lead-dispatch/v1'),
    dispatchId: DispatchId,
    intentId: IntentId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    runtimeSessionId: RuntimeExecutionHandleSchema.shape.externalSessionId.unwrap(),
  })
  .strict()
const response = SuccessResponseEnvelopeSchema.extend({ correlation: Correlation }).strict()
export const PiDurableLeadDispatchResponseSchema = response.extend({
  data: PiDurableLeadReceiptResponseSchema.extend({
    state: RuntimeExecutionStateSchema,
    replayed: z.boolean(),
  }),
})
export const PiDurableLeadStatusResponseSchema = response.extend({
  data: PiDurableLeadReceiptResponseSchema.extend({
    state: RuntimeExecutionStateSchema,
    status: RuntimeExecutionStatusSchema,
  }),
})
export const PiDurableLeadProgressResponseSchema = response.extend({
  data: PiDurableLeadReceiptResponseSchema.extend({
    events: z.array(RuntimeExecutionProgressSchema).max(256),
    nextSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
})
export const PiDurableLeadCancelResponseSchema = PiDurableLeadStatusResponseSchema

/** Existing versioned authenticated envelopes; payloads contain opaque references only. */
export const PiDurableLeadHttpContract = Object.freeze({
  schemaVersion: 'pi-lead-dispatch/v1',
  basePath: '/v3/pi-durable/lead-dispatches',
  method: 'POST',
  dispatch: Object.freeze({
    route: 'dispatch',
    operation: 'pi-durable.lead.dispatch',
    scope: 'execution:accept',
    requestSchema: PiDurableLeadDispatchRequestSchema,
    responseSchema: PiDurableLeadDispatchResponseSchema,
  }),
  status: Object.freeze({
    route: 'status',
    operation: 'pi-durable.lead.status',
    scope: 'execution:read',
    requestSchema: PiDurableLeadStatusRequestSchema,
    responseSchema: PiDurableLeadStatusResponseSchema,
  }),
  progress: Object.freeze({
    route: 'progress',
    operation: 'pi-durable.lead.progress',
    scope: 'execution:read',
    requestSchema: PiDurableLeadProgressRequestSchema,
    responseSchema: PiDurableLeadProgressResponseSchema,
  }),
  cancel: Object.freeze({
    route: 'cancel',
    operation: 'pi-durable.lead.cancel',
    scope: 'execution:cancel',
    requestSchema: PiDurableLeadCancelRequestSchema,
    responseSchema: PiDurableLeadCancelResponseSchema,
  }),
})

export type PiDurableLeadDispatchRequest = z.output<typeof PiDurableLeadDispatchRequestSchema>
export type PiDurableLeadDispatchResponse = z.output<typeof PiDurableLeadDispatchResponseSchema>
export type PiDurableLeadStatusRequest = z.output<typeof PiDurableLeadStatusRequestSchema>
export type PiDurableLeadStatusResponse = z.output<typeof PiDurableLeadStatusResponseSchema>
export type PiDurableLeadProgressRequest = z.output<typeof PiDurableLeadProgressRequestSchema>
export type PiDurableLeadProgressResponse = z.output<typeof PiDurableLeadProgressResponseSchema>
export type PiDurableLeadCancelRequest = z.output<typeof PiDurableLeadCancelRequestSchema>
export type PiDurableLeadCancelResponse = z.output<typeof PiDurableLeadCancelResponseSchema>
