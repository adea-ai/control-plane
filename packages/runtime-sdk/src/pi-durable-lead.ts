import { z } from 'zod'
import {
  IdentifierSchemas,
  ModelSelectionFundingViewSchema,
  ModelSelectionRefSchema,
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
export const PiDurableLeadPreparationRefSchema = z.string().regex(/^prep_[a-f0-9]{32}$/)
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
/** Requested target reference: the session, task, and generation a caller
 *  asks to bind to an intent, echoed back on every receipt. UNTRUSTED by
 *  construction — the taskId is an opaque cross-system reference (Adea
 *  UUIDs and control-plane tsk_ ids share no namespace), and no lookup
 *  verifies the triple against session authority. Owners verify claimed
 *  vs retained vs independently observed bindings together; the shape
 *  alone proves nothing. */
export const PiDurableLeadRequestedTargetSchema = z
  .strictObject({
    sessionId: z.string().trim().min(1).max(256),
    taskId: z.string().trim().min(1).max(256),
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .readonly()
export type PiDurableLeadRequestedTarget = z.output<typeof PiDurableLeadRequestedTargetSchema>

export const PiDurableLeadPrepareRequestSchema = PiDurableLeadCommandEnvelopeSchema.extend({
  operation: z.literal('pi-durable.lead.prepare'),
  payload: z.object({ intentId: IntentId }).strict(),
})
export const PiDurableLeadDispatchRequestSchema = PiDurableLeadCommandEnvelopeSchema.extend({
  operation: z.literal('pi-durable.lead.dispatch'),
  payload: z
    .object({
      intentId: IntentId,
      preparationRef: PiDurableLeadPreparationRefSchema.optional(),
      requestedTarget: PiDurableLeadRequestedTargetSchema.optional(),
    })
    .strict(),
})
export const PiDurableLeadStatusRequestSchema = PiDurableLeadReadEnvelopeSchema.extend({
  operation: z.literal('pi-durable.lead.status'),
  parameters: z.object({ dispatchId: DispatchId }).strict(),
})
export const PiDurableLeadLookupRequestSchema = PiDurableLeadReadEnvelopeSchema.extend({
  operation: z.literal('pi-durable.lead.lookup'),
  parameters: z.object({ intentId: IntentId }).strict(),
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
    requestedTarget: PiDurableLeadRequestedTargetSchema.optional(),
  })
  .strict()
const response = SuccessResponseEnvelopeSchema.extend({ correlation: Correlation }).strict()
/** Disclosure bound to a prepared canonical attempt; never a spending or runtime capability. */
export const PiDurableLeadPreparationSchema = z
  .object({
    schemaVersion: z.literal('pi-lead-preparation/v1'),
    preparationRef: PiDurableLeadPreparationRefSchema,
    intentId: IntentId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    selectionRef: ModelSelectionRefSchema,
    selectionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    funding: ModelSelectionFundingViewSchema.options[0],
    expiresAt: z.iso.datetime(),
    replayed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ['executionId', 'attemptId', 'selectionRef', 'selectionRevision'] as const) {
      if (value[key] !== value.funding[key])
        context.addIssue({
          code: 'custom',
          path: ['funding', key],
          message: 'Funding disclosure must match the prepared attempt and selection',
        })
    }
    if (Date.parse(value.expiresAt) > Date.parse(value.funding.expiresAt))
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Preparation cannot outlive its funding disclosure',
      })
  })
export const PiDurableLeadPrepareResponseSchema = response.extend({
  data: PiDurableLeadPreparationSchema,
})
/** Stored dispatch metadata; lookup never creates an execution or runtime session. */
export const PiDurableLeadLookupResponseSchema = response.extend({
  data: z
    .object({
      schemaVersion: z.literal('pi-lead-lookup/v1'),
      workspaceId: IdentifierSchemas.workspaceId,
      intentId: IntentId,
      receipt: z
        .object({
          dispatchId: DispatchId,
          executionId: IdentifierSchemas.executionId,
          attemptId: IdentifierSchemas.attemptId,
          state: z.enum(['dispatching', 'dispatched', 'reconciliation_required']),
          runtimeSessionId: RuntimeExecutionHandleSchema.shape.externalSessionId
            .unwrap()
            .optional(),
          requestedTarget: PiDurableLeadRequestedTargetSchema.optional(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
})
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
  prepare: Object.freeze({
    route: 'prepare',
    operation: 'pi-durable.lead.prepare',
    scope: 'execution:accept',
    requestSchema: PiDurableLeadPrepareRequestSchema,
    responseSchema: PiDurableLeadPrepareResponseSchema,
  }),
  dispatch: Object.freeze({
    route: 'dispatch',
    operation: 'pi-durable.lead.dispatch',
    scope: 'execution:accept',
    requestSchema: PiDurableLeadDispatchRequestSchema,
    responseSchema: PiDurableLeadDispatchResponseSchema,
  }),
  lookup: Object.freeze({
    route: 'lookup',
    operation: 'pi-durable.lead.lookup',
    scope: 'execution:read',
    requestSchema: PiDurableLeadLookupRequestSchema,
    responseSchema: PiDurableLeadLookupResponseSchema,
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

export type PiDurableLeadPrepareRequest = z.output<typeof PiDurableLeadPrepareRequestSchema>
export type PiDurableLeadPrepareResponse = z.output<typeof PiDurableLeadPrepareResponseSchema>
export type PiDurableLeadPreparation = z.output<typeof PiDurableLeadPreparationSchema>
export type PiDurableLeadLookupRequest = z.output<typeof PiDurableLeadLookupRequestSchema>
export type PiDurableLeadLookupResponse = z.output<typeof PiDurableLeadLookupResponseSchema>
export type PiDurableLeadDispatchRequest = z.output<typeof PiDurableLeadDispatchRequestSchema>
export type PiDurableLeadDispatchResponse = z.output<typeof PiDurableLeadDispatchResponseSchema>
export type PiDurableLeadStatusRequest = z.output<typeof PiDurableLeadStatusRequestSchema>
export type PiDurableLeadStatusResponse = z.output<typeof PiDurableLeadStatusResponseSchema>
export type PiDurableLeadProgressRequest = z.output<typeof PiDurableLeadProgressRequestSchema>
export type PiDurableLeadProgressResponse = z.output<typeof PiDurableLeadProgressResponseSchema>
export type PiDurableLeadCancelRequest = z.output<typeof PiDurableLeadCancelRequestSchema>
export type PiDurableLeadCancelResponse = z.output<typeof PiDurableLeadCancelResponseSchema>
