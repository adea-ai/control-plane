import { ArtifactReferenceSchema, IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'
import {
  CapabilityRequirementSetSchema,
  RuntimeCapabilitySchema,
  evaluateCapabilities,
  type CapabilityEvaluation,
  type CapabilityRequirement,
} from './capabilities.js'

const TimestampSchema = z.iso.datetime()
const SemanticVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const IdempotencyKeySchema = z.string().min(1).max(256)
const HandleIdSchema = z.string().min(1).max(256)
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const RuntimeAdapterMetadataSchema = z
  .object({
    contractVersion: z.object({ major: z.literal(1), minor: z.number().int().nonnegative() }),
    adapterName: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    adapterVersion: SemanticVersionSchema,
    runtimeFamily: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    driverVersion: SemanticVersionSchema,
    harnessVersion: SemanticVersionSchema,
    transportKind: z.enum(['direct-local', 'remote-gateway']).optional(),
  })
  .strict()

const CapabilityEvaluationSchema = z
  .object({
    eligible: z.boolean(),
    mode: z.enum(['full', 'degraded', 'ineligible']),
    missingRequired: z.array(RuntimeCapabilitySchema.shape.name),
    insufficientRequired: z.array(RuntimeCapabilitySchema.shape.name),
    missingOptional: z.array(RuntimeCapabilitySchema.shape.name),
    degradedOptional: z.array(RuntimeCapabilitySchema.shape.name),
  })
  .strict()

export const RuntimeAdapterInspectionSchema = z
  .object({
    metadata: RuntimeAdapterMetadataSchema,
    health: z.enum(['healthy', 'degraded', 'unavailable']),
    capabilities: z.array(RuntimeCapabilitySchema).max(64),
    limitations: z.array(z.string().min(1).max(512)).max(64),
    observedAt: TimestampSchema,
    capabilityEvaluation: CapabilityEvaluationSchema.optional(),
  })
  .strict()

export const RuntimeExecutionHandleSchema = z
  .object({
    handleId: HandleIdSchema,
    attemptId: IdentifierSchemas.attemptId,
    externalSessionId: IdentifierSchemas.externalSessionId.optional(),
    startedAt: TimestampSchema,
  })
  .strict()

export const RuntimeUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    cost: z
      .object({
        amount: z.string().regex(/^\d+(?:\.\d+)?$/),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .optional(),
  })
  .strict()

export const RuntimeArtifactReferenceSchema = ArtifactReferenceSchema.omit({
  contractVersion: true,
})

export const RuntimeExecutionResultSchema = z
  .object({
    outcome: z.literal('completed'),
    output: z.json().optional(),
    usage: RuntimeUsageSchema,
    artifacts: z.array(RuntimeArtifactReferenceSchema).max(1024),
  })
  .strict()

export const RuntimeErrorSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Z][A-Z0-9_]*$/),
    classification: z.enum([
      'validation',
      'unsupported',
      'unavailable',
      'conflict',
      'timeout',
      'cancelled',
      'runtime',
      'infrastructure',
      'unknown',
    ]),
    message: z.string().min(1).max(4096),
    retryable: z.boolean(),
    details: z.record(z.string(), z.json()).optional(),
  })
  .strict()

export const RuntimeExecutionStateSchema = z.enum([
  'starting',
  'running',
  'awaiting_input',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'unknown',
])

export const RuntimeExecutionStatusSchema = z
  .object({
    handle: RuntimeExecutionHandleSchema,
    state: RuntimeExecutionStateSchema,
    observedAt: TimestampSchema,
    result: RuntimeExecutionResultSchema.optional(),
    // Observed usage survives unsuccessful termination without fabricating a result.
    terminalUsage: RuntimeUsageSchema.optional(),
    error: RuntimeErrorSchema.optional(),
  })
  .strict()
  .superRefine((status, context) => {
    if (
      status.terminalUsage !== undefined &&
      !['cancelled', 'failed', 'timed_out'].includes(status.state)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Terminal usage requires an unsuccessful terminal status',
      })
    }
    if ((status.state === 'completed') !== (status.result !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Completed status must contain exactly one result',
      })
    }
    const failed = status.state === 'failed' || status.state === 'timed_out'
    if (failed !== (status.error !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Failed status must contain exactly one error' })
    }
  })

export const RuntimeExecutionProgressSchema = z
  .object({
    handleId: HandleIdSchema,
    sequence: z.number().int().positive(),
    occurredAt: TimestampSchema,
    type: z.enum(['status', 'output', 'interaction', 'usage', 'artifact']),
    data: z.record(z.string(), z.json()),
  })
  .strict()

export const RuntimeExecutionPlanSnapshotSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    executionPlanId: IdentifierSchemas.executionPlanId,
    contentDigest: DigestSchema,
    runtimeRequirements: CapabilityRequirementSetSchema,
  })
  .catchall(z.unknown())

export const RuntimeStartRequestSchema = z
  .object({
    attemptId: IdentifierSchemas.attemptId,
    idempotencyKey: IdempotencyKeySchema,
    executionPlan: RuntimeExecutionPlanSnapshotSchema,
  })
  .strict()

export const RuntimeInputRequestSchema = z
  .object({
    interactionId: IdentifierSchemas.interactionId,
    idempotencyKey: IdempotencyKeySchema,
    text: z.string().min(1).max(1_000_000),
  })
  .strict()

export const RuntimeApprovalRequestSchema = z
  .object({
    interactionId: IdentifierSchemas.interactionId,
    idempotencyKey: IdempotencyKeySchema,
    decision: z.enum(['approve', 'deny']),
    reason: z.string().min(1).max(4096).optional(),
  })
  .strict()

export const RuntimeCancelRequestSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema, requestedAt: TimestampSchema })
  .strict()

export const RuntimeSessionOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), idempotencyKey: IdempotencyKeySchema }).strict(),
  z.object({ operation: z.literal('list') }).strict(),
  z
    .object({
      operation: z.enum(['resume', 'load', 'close']),
      sessionId: IdentifierSchemas.externalSessionId,
      idempotencyKey: IdempotencyKeySchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('history'),
      sessionId: IdentifierSchemas.externalSessionId,
      afterSequence: z.number().int().nonnegative().optional(),
    })
    .strict(),
])

const RuntimeSessionSchema = z
  .object({
    sessionId: IdentifierSchemas.externalSessionId,
    state: z.enum(['active', 'closed']),
    observedAt: TimestampSchema,
  })
  .strict()

export const RuntimeSessionResultSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.enum(['create', 'resume', 'load', 'close']),
      session: RuntimeSessionSchema,
    })
    .strict(),
  z.object({ operation: z.literal('list'), sessions: z.array(RuntimeSessionSchema) }).strict(),
  z
    .object({
      operation: z.literal('history'),
      session: RuntimeSessionSchema,
      completeness: z.enum(['complete', 'partial', 'unavailable']),
      limitations: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(32),
      entries: z.array(
        z
          .object({
            sequence: z.number().int().positive(),
            occurredAt: TimestampSchema,
            data: z.record(z.string(), z.json()),
          })
          .strict()
      ),
    })
    .strict(),
])

export type RuntimeAdapterInspection = z.output<typeof RuntimeAdapterInspectionSchema>
export type RuntimeExecutionHandle = z.output<typeof RuntimeExecutionHandleSchema>
export type RuntimeExecutionProgress = z.output<typeof RuntimeExecutionProgressSchema>
export type RuntimeExecutionStatus = z.output<typeof RuntimeExecutionStatusSchema>
export type RuntimeExecutionResult = z.output<typeof RuntimeExecutionResultSchema>
export type RuntimeExecutionPlanSnapshot = Readonly<
  {
    schemaVersion: number
    executionPlanId: string
    contentDigest: string
    runtimeRequirements: readonly Readonly<CapabilityRequirement>[]
  } & Record<string, unknown>
>
export type RuntimeStartRequest = Readonly<
  Omit<z.input<typeof RuntimeStartRequestSchema>, 'executionPlan'> & {
    executionPlan: RuntimeExecutionPlanSnapshot
  }
>
export type RuntimeInputRequest = z.input<typeof RuntimeInputRequestSchema>
export type RuntimeApprovalRequest = z.input<typeof RuntimeApprovalRequestSchema>
export type RuntimeCancelRequest = z.input<typeof RuntimeCancelRequestSchema>
export type RuntimeSessionOperation = z.input<typeof RuntimeSessionOperationSchema>
export type RuntimeSessionResult = z.output<typeof RuntimeSessionResultSchema>
export type RuntimeError = z.output<typeof RuntimeErrorSchema>

export const RuntimeAdapterContract = Object.freeze({
  version: Object.freeze({ major: 1, minor: 0 }),
  lifecycle: Object.freeze([
    'inspect',
    'start',
    'progress',
    'interact',
    'cancel',
    'status',
    'reconcile',
    'cleanup',
  ]),
  idempotentOperations: Object.freeze([
    'start',
    'submitInput',
    'submitApproval',
    'cancel',
    'session.create',
    'session.close',
    'cleanup',
  ]),
  terminalStates: Object.freeze(['completed', 'failed', 'cancelled', 'timed_out']),
})

export interface RuntimeProgressOptions {
  readonly afterSequence?: number
  readonly signal?: AbortSignal
}

export interface RuntimeAdapter {
  inspect(requirements?: readonly CapabilityRequirement[]): Promise<RuntimeAdapterInspection>
  start(request: RuntimeStartRequest): Promise<RuntimeExecutionHandle>
  progress(
    handle: RuntimeExecutionHandle,
    options?: RuntimeProgressOptions
  ): AsyncIterable<RuntimeExecutionProgress>
  submitInput(
    handle: RuntimeExecutionHandle,
    request: RuntimeInputRequest
  ): Promise<RuntimeExecutionStatus>
  submitApproval(
    handle: RuntimeExecutionHandle,
    request: RuntimeApprovalRequest
  ): Promise<RuntimeExecutionStatus>
  cancel(
    handle: RuntimeExecutionHandle,
    request: RuntimeCancelRequest
  ): Promise<RuntimeExecutionStatus>
  status(handle: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus>
  reconcile(handle: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus>
  session(operation: RuntimeSessionOperation): Promise<RuntimeSessionResult>
  cleanup(handle: RuntimeExecutionHandle): Promise<void>
}

export class RuntimeAdapterError extends Error {
  readonly code: string
  readonly classification: RuntimeError['classification']
  readonly retryable: boolean
  readonly details?: Readonly<Record<string, z.util.JSONType>>

  constructor(errorInput: RuntimeError) {
    const error = RuntimeErrorSchema.parse(errorInput)
    super(error.message)
    this.name = 'RuntimeAdapterError'
    this.code = error.code
    this.classification = error.classification
    this.retryable = error.retryable
    if (error.details) this.details = error.details
  }

  toJSON(): RuntimeError {
    return RuntimeErrorSchema.parse({
      code: this.code,
      classification: this.classification,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    })
  }
}

export function inspectRuntimeCapabilities(
  capabilities: RuntimeAdapterInspection['capabilities'],
  requirements: readonly CapabilityRequirement[]
): CapabilityEvaluation {
  return evaluateCapabilities(capabilities, CapabilityRequirementSetSchema.parse(requirements))
}
