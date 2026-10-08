import {
  GraphReferenceSchema,
  GraphToolPinSchema,
  IdentifierSchemas,
} from '@control-plane/contracts'
import { z } from 'zod'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const MarketplacePluginReferenceSchema = z
  .object({
    pluginId: z.string().regex(/^plugin:[a-z0-9-]+:[a-z0-9][a-z0-9-]{1,127}$/),
    releaseId: z.string().regex(/^release:[a-f0-9]{64}$/),
    canonicalContentDigest: DigestSchema,
  })
  .strict()
const TimestampSchema = z.iso.datetime()
const SafeReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const JsonObjectSchema = z.record(z.string(), z.json())

const GraphCorrelationSchema = z
  .object({
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    workspaceId: IdentifierSchemas.workspaceId,
    workflowId: IdentifierSchemas.workflowId,
  })
  .strict()

export const GraphExecutionRequestSchema = GraphCorrelationSchema.extend({
  graph: GraphReferenceSchema,
  threadId: SafeReferenceSchema,
  input: JsonObjectSchema,
  idempotencyKey: SafeReferenceSchema,
}).strict()

export const GraphResumeRequestSchema = GraphCorrelationSchema.extend({
  graph: GraphReferenceSchema,
  threadId: SafeReferenceSchema,
  checkpointId: SafeReferenceSchema,
  response: z.json(),
  idempotencyKey: SafeReferenceSchema,
}).strict()

export const GraphContinueRequestSchema = GraphCorrelationSchema.extend({
  graph: GraphReferenceSchema,
  threadId: SafeReferenceSchema,
  checkpointId: SafeReferenceSchema,
  idempotencyKey: SafeReferenceSchema,
}).strict()

export const GraphCancellationRequestSchema = GraphCorrelationSchema.extend({
  graph: GraphReferenceSchema,
  threadId: SafeReferenceSchema,
  reason: z.enum(['user_request', 'parent_cancelled', 'deadline', 'policy', 'shutdown']),
  idempotencyKey: SafeReferenceSchema,
}).strict()

export const GraphEventSchema = GraphCorrelationSchema.extend({
  threadId: SafeReferenceSchema,
  checkpointId: SafeReferenceSchema.optional(),
  sequence: z.number().int().positive(),
  type: z.enum([
    'graph.started',
    'graph.node.started',
    'graph.node.completed',
    'graph.interrupted',
    'graph.resumed',
    'graph.completed',
    'graph.failed',
    'graph.cancelled',
  ]),
  node: SafeReferenceSchema.optional(),
  occurredAt: TimestampSchema,
  details: JsonObjectSchema.default({}),
}).strict()

const SegmentBaseSchema = z.object({
  state: JsonObjectSchema,
  checkpointId: SafeReferenceSchema.optional(),
  events: z.array(GraphEventSchema).max(10_000),
})

export const GraphSegmentResultSchema = z.discriminatedUnion('status', [
  SegmentBaseSchema.extend({
    status: z.literal('completed'),
    output: JsonObjectSchema,
  }).strict(),
  SegmentBaseSchema.extend({
    status: z.literal('continue'),
    checkpointId: SafeReferenceSchema,
  }).strict(),
  SegmentBaseSchema.extend({
    status: z.literal('awaiting_input'),
    checkpointId: SafeReferenceSchema,
    interrupt: z
      .object({
        interactionKey: SafeReferenceSchema,
        kind: z.enum(['input', 'approval', 'grant', 'runtime']),
        payload: z.json(),
      })
      .strict(),
  }).strict(),
  SegmentBaseSchema.extend({
    status: z.literal('failed'),
    failure: z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        retryable: z.boolean(),
      })
      .strict(),
  }).strict(),
  SegmentBaseSchema.extend({ status: z.literal('cancelled') }).strict(),
  SegmentBaseSchema.extend({ status: z.literal('reconciliation_required') }).strict(),
])

const GraphNodeOperationBaseSchema = GraphCorrelationSchema.extend({
  threadId: SafeReferenceSchema,
  node: SafeReferenceSchema,
  name: SafeReferenceSchema,
  input: JsonObjectSchema,
  idempotencyKey: SafeReferenceSchema,
})

export const GraphNodeOperationSchema = z.discriminatedUnion('kind', [
  GraphNodeOperationBaseSchema.extend({
    kind: z.enum(['runtime', 'model', 'delegation']),
  }).strict(),
  GraphNodeOperationBaseSchema.extend({
    kind: z.literal('tool'),
    toolPin: GraphToolPinSchema.optional(),
  }).strict(),
])

const GraphApprovalPayloadSchema = z
  .record(z.string(), z.json())
  .superRefine((payload, context) => {
    if (Object.keys(payload).length > 64) {
      context.addIssue({ code: 'custom', message: 'Approval payload has too many fields' })
      return
    }
    const serialized = JSON.stringify(payload)
    if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > 16_384) {
      context.addIssue({ code: 'custom', message: 'Approval payload exceeds the size limit' })
    }
  })

export const GraphNodeApprovalRequiredSchema = z
  .object({
    interactionKey: SafeReferenceSchema,
    kind: z.literal('approval'),
    payload: GraphApprovalPayloadSchema,
  })
  .strict()

export const ExecutionWorkflowInputSchema = z
  .object({
    executionId: IdentifierSchemas.executionId,
    workflowId: IdentifierSchemas.workflowId,
    executionPlan: z
      .object({
        executionPlanId: IdentifierSchemas.executionPlanId,
        contentDigest: DigestSchema,
        schemaVersion: z.number().int().positive(),
      })
      .strict(),
    deadlineAt: TimestampSchema,
    marketplacePluginReferences: z.array(MarketplacePluginReferenceSchema).max(128).optional(),
    graph: z
      .object({
        workspaceId: IdentifierSchemas.workspaceId,
        reference: GraphReferenceSchema,
        threadId: SafeReferenceSchema,
        input: JsonObjectSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.workflowId !== `wfl_${input.executionId.slice(4)}`) {
      context.addIssue({
        code: 'custom',
        path: ['workflowId'],
        message: 'Workflow identity must derive from the execution identity',
      })
    }
  })

export { GraphReferenceSchema } from '@control-plane/contracts'
export type { GraphReference } from '@control-plane/contracts'
export type GraphExecutionRequest = z.output<typeof GraphExecutionRequestSchema>
export type GraphResumeRequest = z.output<typeof GraphResumeRequestSchema>
export type GraphContinueRequest = z.output<typeof GraphContinueRequestSchema>
export type GraphCancellationRequest = z.output<typeof GraphCancellationRequestSchema>
export type GraphEvent = z.output<typeof GraphEventSchema>
export type GraphSegmentResult = z.output<typeof GraphSegmentResultSchema>
export type GraphNodeOperation = z.output<typeof GraphNodeOperationSchema>
export type GraphNodeApprovalRequired = z.output<typeof GraphNodeApprovalRequiredSchema>
export type ExecutionWorkflowInput = z.output<typeof ExecutionWorkflowInputSchema>

/** Typed signal for a durable tool effect that must wait for its recorded approval. */
export class GraphNodeApprovalRequiredError extends Error {
  readonly #interaction: GraphNodeApprovalRequired

  constructor(interaction: unknown) {
    super('Graph node requires approval')
    this.name = 'GraphNodeApprovalRequiredError'
    this.#interaction = GraphNodeApprovalRequiredSchema.parse(interaction)
  }

  get interaction(): GraphNodeApprovalRequired {
    return this.#interaction
  }
}

/** An effect may have committed; retries and terminal cleanup require reconciliation. */
export class GraphNodeEffectUnconfirmedError extends Error {
  constructor() {
    super('GRAPH_TOOL_RECONCILIATION_REQUIRED')
    this.name = 'GraphNodeEffectUnconfirmedError'
  }
}

export interface GraphNodeOperationPort {
  invoke(operation: GraphNodeOperation): Promise<Readonly<Record<string, unknown>>>
  cancel(executionId: string, threadId: string, idempotencyKey: string): Promise<boolean>
}

export interface GraphEventPublisher {
  publish(event: GraphEvent, idempotencyKey: string): Promise<void>
}

export interface OrchestrationPort {
  run(request: GraphExecutionRequest): Promise<GraphSegmentResult>
  resume(request: GraphResumeRequest): Promise<GraphSegmentResult>
  continue(request: GraphContinueRequest): Promise<GraphSegmentResult>
  cancel(request: GraphCancellationRequest): Promise<boolean>
}

export type OrchestrationErrorCode =
  | 'INVALID_GRAPH_REQUEST'
  | 'GRAPH_NOT_FOUND'
  | 'GRAPH_VERSION_MISMATCH'
  | 'GRAPH_FAILED'
  | 'GRAPH_CANCELLED'
  | 'CHECKPOINT_MISSING'
  | 'RESUME_FAILED'

export class OrchestrationError extends Error {
  constructor(
    readonly code: OrchestrationErrorCode,
    readonly retryable: boolean,
    override readonly cause?: unknown
  ) {
    super(code)
    this.name = 'OrchestrationError'
  }
}

export function createGraphEvent(input: unknown): GraphEvent {
  return GraphEventSchema.parse(input)
}

export * from './graph-catalog.js'
export * from './delegation.js'
export * from './parallel-delegation.js'
export * from './child-progress-evidence.js'

export const packageName = 'orchestration'
