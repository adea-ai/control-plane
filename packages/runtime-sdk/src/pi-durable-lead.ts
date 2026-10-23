import { z } from 'zod'
import {
  ContractVersionSchema,
  IdentifierSchemas,
  ModelSelectionFundingViewSchema,
  ModelSelectionRefSchema,
  PublicContractManifest,
  ReadRequestEnvelopeSchema,
  StateChangingCommandEnvelopeSchema,
  SuccessResponseEnvelopeSchema,
  negotiateContractVersion,
} from '@control-plane/contracts'
import {
  RuntimeExecutionHandleSchema,
  RuntimeExecutionProgressSchema,
  RuntimeExecutionStatusSchema,
  RuntimeExecutionStateSchema,
  RuntimeObservedGenerationSchema,
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
/** Server-owned execution observation: the session the runtime assigned
 *  this execution, the authority-resolved plan task, and the generation the
 *  runtime observed for the attempt that owns it. All three come from
 *  server-held records (adapter handle + admitted plan + the runtime's own
 *  observed generation), never from caller claims. A caller-claimed
 *  generation is retained on the request and echoed back as a claim; it can
 *  never appear here, because a claimed value laundered as an observation is
 *  not an observation. The generation is additive in contract 3.1: a consumer
 *  that advertised an earlier version parses with the strict pre-3.1 shape, so
 *  a producer publishes it only to a negotiated consumer. */
export const PiDurableLeadObservedTargetSchema = z
  .strictObject({
    sessionId: z.string().trim().min(1).max(256),
    taskId: z.string().trim().min(1).max(256),
    /** The runtime-observed generation, when the runtime has observed one. */
    generation: RuntimeObservedGenerationSchema.optional(),
  })
  .readonly()
export type PiDurableLeadObservedTarget = z.output<typeof PiDurableLeadObservedTargetSchema>

/** The contract version that introduced the runtime-observed generation on the
 *  lead receipt and on the runtime execution status. The field is optional and
 *  additive within the major, but the pre-3.1 target and runtime-status shapes
 *  are strict: a consumer that predates this version rejects an unknown key and
 *  reports an invalid response. */
export const PI_DURABLE_OBSERVED_GENERATION_CONTRACT_VERSION = { major: 3, minor: 1 } as const

/** Whether a consumer that advertised `consumerVersion` negotiated a contract
 *  that includes the runtime-observed generation. The producer and the consumer
 *  negotiate the highest common major and the lower of the two minors, so an
 *  earlier same-major consumer (or a consumer of another major) never receives
 *  the field it cannot parse. A consumer that advertised a newer minor already
 *  understands it. */
export function supportsPiDurableObservedGeneration(consumerVersion: unknown): boolean {
  const consumer = ContractVersionSchema.safeParse(consumerVersion)
  if (!consumer.success) return false
  const negotiated = negotiateContractVersion([PublicContractManifest.current], [consumer.data])
  if (negotiated === undefined) return false
  return (
    negotiated.major === PI_DURABLE_OBSERVED_GENERATION_CONTRACT_VERSION.major &&
    negotiated.minor >= PI_DURABLE_OBSERVED_GENERATION_CONTRACT_VERSION.minor
  )
}

/** Every published observed generation must belong to the attempt the receipt
 *  owns. A generation observed for another attempt is a late old-attempt
 *  event: publishing it would fence the wrong attempt, so it is refused
 *  instead. The fence covers both places a generation is published — the
 *  observed target and the embedded runtime status — so no publication path
 *  can carry a foreign generation. */
function fenceForeignGeneration(
  receipt: {
    attemptId: string
    observedTarget?: { generation?: { attemptId: string } | undefined } | undefined
    status?: { observedGeneration?: { attemptId: string } | undefined } | undefined
  },
  context: z.RefinementCtx
): void {
  const foreign = (generation: { attemptId: string } | undefined): boolean =>
    generation !== undefined && generation.attemptId !== receipt.attemptId
  if (foreign(receipt.observedTarget?.generation))
    context.addIssue({
      code: 'custom',
      path: ['observedTarget', 'generation'],
      message: 'Observed generation must belong to the receipt attempt',
    })
  if (foreign(receipt.status?.observedGeneration))
    context.addIssue({
      code: 'custom',
      path: ['status', 'observedGeneration'],
      message: 'Observed generation must belong to the receipt attempt',
    })
}

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
/** Position after which the next page of children starts: the last returned child's sort key. */
export const PiDurableLeadChildrenCursorSchema = z
  .object({ acceptedAt: z.iso.datetime(), delegationId: IdentifierSchemas.delegationId })
  .strict()
  .readonly()
export type PiDurableLeadChildrenCursor = z.output<typeof PiDurableLeadChildrenCursorSchema>
export const PI_DURABLE_LEAD_CHILDREN_MAX_PAGE = 256
export const PiDurableLeadChildrenRequestSchema = PiDurableLeadReadEnvelopeSchema.extend({
  operation: z.literal('pi-durable.lead.children'),
  parameters: z
    .object({
      dispatchId: DispatchId,
      /** Resume strictly after this child (acceptance time, then delegation ID). */
      after: PiDurableLeadChildrenCursorSchema.optional(),
      /** Page size, 1..256; the default is the maximum. */
      limit: z.number().int().min(1).max(PI_DURABLE_LEAD_CHILDREN_MAX_PAGE).optional(),
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
    observedTarget: PiDurableLeadObservedTargetSchema.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    fenceForeignGeneration(receipt, context)
  })
const response = SuccessResponseEnvelopeSchema.extend({ correlation: Correlation }).strict()
const PlanDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const ChildAllowanceBinding = {
  schemaVersion: z.literal('pi-lead-child-allowance/v1'),
  /** The accepted plan the statement is read from; the same plan the lead attempt runs under. */
  executionPlanDigest: PlanDigest,
  /** Pinned profile version the plan was compiled from; matches a caller's opaque profile pin. */
  profile: z
    .strictObject({
      profileId: IdentifierSchemas.profileId,
      profileVersionId: IdentifierSchemas.profileVersionId,
      version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .readonly(),
}
/** What the accepted lead plan holds back for child executions. Disclosure only: never a funding,
 *  admission or spending capability. `not_stated` means the plan holds nothing back, so only
 *  balance the lead releases can fund children; it is not an error and not a missing disclosure. */
export const PiDurableLeadChildAllowanceSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...ChildAllowanceBinding,
    state: z.literal('stated'),
    currency: z.literal('USD'),
    maximumMicrounits: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maximumTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({ ...ChildAllowanceBinding, state: z.literal('not_stated') }),
])
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
    /** Absent from a control plane that predates this disclosure; absence is not `not_stated`. */
    childAllowance: PiDurableLeadChildAllowanceSchema.optional(),
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
          observedTarget: PiDurableLeadObservedTargetSchema.optional(),
        })
        .strict()
        .superRefine((receipt, context) => {
          // Same fence as the live receipt: an observed generation belongs to
          // the attempt that owns it.
          fenceForeignGeneration(receipt, context)
        })
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

const ChildReference = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:/-]+$/)
/** Terminal child outcome as retained by the delegation record; identifiers and bounded codes only. */
export const PiDurableLeadChildOutcomeSchema = z
  .object({
    state: z.enum(['completed', 'failed', 'cancelled']),
    resultRef: IdentifierSchemas.artifactId.optional(),
    failureCode: ChildReference.optional(),
    publication: z
      .object({
        status: z.enum(['pending', 'published']),
        resolution: z.enum(['continue_parent', 'manual_intervention', 'fail_parent']).optional(),
      })
      .strict(),
  })
  .strict()
/**
 * Canonical, authorized view of one child job of a lead dispatch. It is read from retained
 * delegation records only: no prompt, objective, plan, digest, credential or native payload.
 * `awaitingInput` is the child's own approval/input state; it is observation, never a grant.
 */
export const PiDurableLeadChildSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId.optional(),
    role: ChildReference,
    state: z.enum([
      'requested',
      'dispatched',
      'running',
      'awaiting_input',
      'completed',
      'failed',
      'cancelled',
      'manual_intervention',
    ]),
    awaitingInput: z.boolean(),
    stopRequested: z.boolean(),
    acceptedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    outcome: PiDurableLeadChildOutcomeSchema.optional(),
  })
  .strict()
/**
 * One page of the dispatch's children, ordered by acceptance time then delegation ID.
 * `totalChildren` counts every child of this dispatch at the time of the read, so a consumer
 * can tell a complete set from a page. `complete` is true only when this page ends the set;
 * otherwise `next` is the cursor for the following page. A page is never silently cut short.
 */
export const PiDurableLeadChildrenResponseSchema = response.extend({
  data: PiDurableLeadReceiptResponseSchema.extend({
    children: z.array(PiDurableLeadChildSchema).max(PI_DURABLE_LEAD_CHILDREN_MAX_PAGE),
    totalChildren: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    complete: z.boolean(),
    next: PiDurableLeadChildrenCursorSchema.optional(),
  }).superRefine((value, context) => {
    if (value.complete === (value.next !== undefined))
      context.addIssue({
        code: 'custom',
        path: ['next'],
        message: 'A page is complete exactly when it has no next cursor',
      })
    if (value.children.length > value.totalChildren)
      context.addIssue({
        code: 'custom',
        path: ['totalChildren'],
        message: 'A page cannot hold more children than the dispatch has',
      })
  }),
})

/** Existing versioned authenticated envelopes; payloads contain opaque references only. */
export const PiDurableLeadHttpContract = Object.freeze({
  schemaVersion: 'pi-lead-dispatch/v1',
  basePath: '/v3/pi-durable/lead-dispatches',
  method: 'POST',
  prepare: Object.freeze({
    route: 'prepare',
    operation: 'pi-durable.lead.prepare',
    scope: 'execution:accept',
    requestSchema: PiDurableLeadPrepareRequestSchema as typeof PiDurableLeadPrepareRequestSchema,
    responseSchema: PiDurableLeadPrepareResponseSchema as typeof PiDurableLeadPrepareResponseSchema,
  }),
  dispatch: Object.freeze({
    route: 'dispatch',
    operation: 'pi-durable.lead.dispatch',
    scope: 'execution:accept',
    requestSchema: PiDurableLeadDispatchRequestSchema as typeof PiDurableLeadDispatchRequestSchema,
    responseSchema:
      PiDurableLeadDispatchResponseSchema as typeof PiDurableLeadDispatchResponseSchema,
  }),
  lookup: Object.freeze({
    route: 'lookup',
    operation: 'pi-durable.lead.lookup',
    scope: 'execution:read',
    requestSchema: PiDurableLeadLookupRequestSchema as typeof PiDurableLeadLookupRequestSchema,
    responseSchema: PiDurableLeadLookupResponseSchema as typeof PiDurableLeadLookupResponseSchema,
  }),
  status: Object.freeze({
    route: 'status',
    operation: 'pi-durable.lead.status',
    scope: 'execution:read',
    requestSchema: PiDurableLeadStatusRequestSchema as typeof PiDurableLeadStatusRequestSchema,
    responseSchema: PiDurableLeadStatusResponseSchema as typeof PiDurableLeadStatusResponseSchema,
  }),
  progress: Object.freeze({
    route: 'progress',
    operation: 'pi-durable.lead.progress',
    scope: 'execution:read',
    requestSchema: PiDurableLeadProgressRequestSchema as typeof PiDurableLeadProgressRequestSchema,
    responseSchema:
      PiDurableLeadProgressResponseSchema as typeof PiDurableLeadProgressResponseSchema,
  }),
  children: Object.freeze({
    route: 'children',
    operation: 'pi-durable.lead.children',
    scope: 'execution:read',
    requestSchema: PiDurableLeadChildrenRequestSchema as typeof PiDurableLeadChildrenRequestSchema,
    responseSchema:
      PiDurableLeadChildrenResponseSchema as typeof PiDurableLeadChildrenResponseSchema,
  }),
  cancel: Object.freeze({
    route: 'cancel',
    operation: 'pi-durable.lead.cancel',
    scope: 'execution:cancel',
    requestSchema: PiDurableLeadCancelRequestSchema as typeof PiDurableLeadCancelRequestSchema,
    responseSchema: PiDurableLeadCancelResponseSchema as typeof PiDurableLeadCancelResponseSchema,
  }),
})

export type PiDurableLeadPrepareRequest = z.output<typeof PiDurableLeadPrepareRequestSchema>
export type PiDurableLeadPrepareResponse = z.output<typeof PiDurableLeadPrepareResponseSchema>
export type PiDurableLeadPreparation = z.output<typeof PiDurableLeadPreparationSchema>
export type PiDurableLeadChildAllowance = z.output<typeof PiDurableLeadChildAllowanceSchema>
export type PiDurableLeadLookupRequest = z.output<typeof PiDurableLeadLookupRequestSchema>
export type PiDurableLeadLookupResponse = z.output<typeof PiDurableLeadLookupResponseSchema>
export type PiDurableLeadDispatchRequest = z.output<typeof PiDurableLeadDispatchRequestSchema>
export type PiDurableLeadDispatchResponse = z.output<typeof PiDurableLeadDispatchResponseSchema>
export type PiDurableLeadStatusRequest = z.output<typeof PiDurableLeadStatusRequestSchema>
export type PiDurableLeadStatusResponse = z.output<typeof PiDurableLeadStatusResponseSchema>
export type PiDurableLeadProgressRequest = z.output<typeof PiDurableLeadProgressRequestSchema>
export type PiDurableLeadProgressResponse = z.output<typeof PiDurableLeadProgressResponseSchema>
export type PiDurableLeadChildrenRequest = z.output<typeof PiDurableLeadChildrenRequestSchema>
export type PiDurableLeadChildrenResponse = z.output<typeof PiDurableLeadChildrenResponseSchema>
export type PiDurableLeadChild = z.output<typeof PiDurableLeadChildSchema>
export type PiDurableLeadCancelRequest = z.output<typeof PiDurableLeadCancelRequestSchema>
export type PiDurableLeadCancelResponse = z.output<typeof PiDurableLeadCancelResponseSchema>
