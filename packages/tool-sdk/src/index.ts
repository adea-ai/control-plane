import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SemanticVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
const CanonicalNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9.-]*$/)
const ErrorCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/)
const JsonObjectSchema = z.record(z.string(), z.json())
const unique = <Value>(values: Value[]) => new Set(values).size === values.length

export const ToolOwnershipSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('system') }).strict(),
  z.object({ scope: z.literal('workspace'), workspaceId: IdentifierSchemas.workspaceId }).strict(),
])

export const ToolDefinitionSchema = z
  .object({
    toolDefinitionId: IdentifierSchemas.toolDefinitionId,
    name: CanonicalNameSchema,
    displayName: z.string().min(1).max(128),
    description: z.string().min(1).max(2_048),
    ownership: ToolOwnershipSchema,
    createdAt: TimestampSchema,
  })
  .strict()

export const ToolExecutorTypeSchema = z.enum(['internal', 'connector', 'mcp', 'sandbox'])
export const ToolVersionLifecycleSchema = z.enum([
  'published',
  'deprecated',
  'revoked',
  'superseded',
])
export const ToolRiskClassSchema = z.enum(['low', 'medium', 'high', 'critical'])
export const ToolApprovalModeSchema = z.enum(['never', 'policy', 'always'])
export const ToolIdempotencySchema = z.enum(['inherent', 'provider_key', 'reconcile', 'none'])
export const ToolRetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().positive().max(8),
    retryableErrorCodes: z.array(ErrorCodeSchema).max(32).refine(unique),
  })
  .strict()

export const ToolOperationSchema = z
  .object({
    name: CanonicalNameSchema,
    requiredCapabilities: z.array(CanonicalNameSchema).max(64).refine(unique),
    riskClass: ToolRiskClassSchema,
    approvalMode: ToolApprovalModeSchema,
    idempotency: ToolIdempotencySchema,
    retryPolicy: ToolRetryPolicySchema.optional(),
  })
  .strict()

export const ToolExecutorReferenceSchema = z
  .object({
    type: ToolExecutorTypeSchema,
    reference: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  })
  .strict()

export const ToolLimitsSchema = z
  .object({
    maxInputBytes: z.number().int().positive().max(1_048_576),
    maxOutputBytes: z.number().int().positive().max(16_777_216),
    timeoutMs: z.number().int().positive().max(900_000),
    rateLimit: z
      .object({
        maxCalls: z.number().int().positive().max(100_000),
        windowMs: z.number().int().positive().max(86_400_000),
      })
      .strict()
      .optional(),
  })
  .strict()

export const ToolSourceSchema = z
  .object({
    kind: z.literal('mcp'),
    serverId: CanonicalNameSchema,
    sourceToolName: z.string().min(1).max(256),
    sourceToolVersion: z.string().min(1).max(128).optional(),
    schemaDigest: DigestSchema,
    /**
     * Pre-cutover digest of the same discovery snapshot (#612): the gateway
     * recomputes both forms so versions registered before the code-point
     * cutover still execute without spurious MCP_SCHEMA_CHANGED.
     */
    legacySchemaDigest: DigestSchema.optional(),
    discoveredAt: TimestampSchema,
  })
  .strict()

const ToolVersionFieldsSchema = z
  .object({
    toolVersionId: IdentifierSchemas.toolVersionId,
    toolDefinitionId: IdentifierSchemas.toolDefinitionId,
    semanticVersion: SemanticVersionSchema,
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema,
    operations: z
      .array(ToolOperationSchema)
      .min(1)
      .max(64)
      .refine((operations) => unique(operations.map(({ name }) => name))),
    executor: ToolExecutorReferenceSchema,
    source: ToolSourceSchema.optional(),
    limits: ToolLimitsSchema,
    createdAt: TimestampSchema,
    publishedAt: TimestampSchema,
  })
  .strict()

export const ToolVersionDraftSchema = ToolVersionFieldsSchema
export const ToolVersionSchema = ToolVersionFieldsSchema.extend({
  revision: z.number().int().positive(),
  lifecycle: ToolVersionLifecycleSchema,
  contentDigest: DigestSchema,
}).strict()

export const ToolGrantSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    profileId: IdentifierSchemas.profileId,
    toolDefinitionId: IdentifierSchemas.toolDefinitionId,
    toolVersionId: IdentifierSchemas.toolVersionId,
    operations: z.array(CanonicalNameSchema).min(1).max(64).refine(unique),
    expiresAt: TimestampSchema.optional(),
  })
  .strict()

export const ToolExecutionRequestSchema = z
  .object({
    requestId: IdentifierSchemas.requestId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    workspaceId: IdentifierSchemas.workspaceId,
    profileId: IdentifierSchemas.profileId,
    toolDefinitionId: IdentifierSchemas.toolDefinitionId,
    toolVersionId: IdentifierSchemas.toolVersionId,
    operation: CanonicalNameSchema,
    input: z.json(),
    grant: ToolGrantSchema,
    audit: z
      .object({
        principalRef: z.string().min(1).max(256),
        traceId: IdentifierSchemas.traceId,
      })
      .strict(),
  })
  .strict()

export const ToolExecutionResultSchema = z
  .object({
    toolDefinitionId: IdentifierSchemas.toolDefinitionId,
    toolVersionId: IdentifierSchemas.toolVersionId,
    operation: CanonicalNameSchema,
    output: z.json(),
    artifactRefs: z.array(IdentifierSchemas.artifactId).max(128),
    executor: ToolExecutorReferenceSchema,
    attempts: z.number().int().positive(),
    audit: z
      .object({
        principalRef: z.string().min(1).max(256),
        traceId: IdentifierSchemas.traceId,
        contentDigest: DigestSchema,
      })
      .strict(),
  })
  .strict()

const PolicyReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/)

export const ToolPolicyDecisionSchema = z
  .object({
    effect: z.enum(['allow', 'deny']),
    decisionId: z.string().min(1).max(256),
    policyVersion: z.string().min(1).max(256),
    reasonCode: ErrorCodeSchema,
    requiresApproval: z.boolean(),
    evaluatedAt: TimestampSchema,
  })
  .strict()

export const DurableToolCallRequestSchema = ToolExecutionRequestSchema.extend({
  toolCallId: IdentifierSchemas.toolCallId,
  idempotencyKey: z
    .string()
    .min(8)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  requestedAt: TimestampSchema,
  policySnapshotRef: PolicyReferenceSchema,
  approval: z
    .object({
      interactionId: IdentifierSchemas.interactionId,
      allowedPrincipalIds: z.array(z.string().min(3).max(128)).min(1).max(64).refine(unique),
      requestedAt: TimestampSchema,
      expiresAt: TimestampSchema,
    })
    .strict()
    .optional(),
}).strict()

export const ToolCallStatusSchema = z.enum([
  'requested',
  'awaiting_approval',
  'authorized',
  'executing',
  'succeeded',
  'denied',
  'failed',
  'reconciliation_required',
])

export const ToolCallSchema = z
  .object({
    toolCallId: IdentifierSchemas.toolCallId,
    requestDigest: DigestSchema,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    workspaceId: IdentifierSchemas.workspaceId,
    profileId: IdentifierSchemas.profileId,
    principalRef: z.string().min(1).max(256),
    toolDefinitionId: IdentifierSchemas.toolDefinitionId,
    toolVersionId: IdentifierSchemas.toolVersionId,
    operation: CanonicalNameSchema,
    inputDigest: DigestSchema,
    policySnapshotRef: PolicyReferenceSchema,
    policyDecision: ToolPolicyDecisionSchema.optional(),
    approvalInteractionId: IdentifierSchemas.interactionId.optional(),
    approvalPrincipalRef: z.string().min(1).max(256).optional(),
    executor: ToolExecutorReferenceSchema,
    idempotencyKey: z.string().min(8).max(256),
    status: ToolCallStatusSchema,
    result: ToolExecutionResultSchema.optional(),
    errorCode: ErrorCodeSchema.optional(),
    revision: z.number().int().positive(),
    requestedAt: TimestampSchema,
    authorizedAt: TimestampSchema.optional(),
    startedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional(),
    history: z
      .array(
        z
          .object({
            status: ToolCallStatusSchema,
            at: TimestampSchema,
            reasonCode: ErrorCodeSchema.optional(),
          })
          .strict()
      )
      .min(1)
      .max(64),
  })
  .strict()

export const ToolAuthorizationRequestSchema = z
  .object({
    requestId: IdentifierSchemas.requestId,
    toolCallId: IdentifierSchemas.toolCallId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    workspaceId: IdentifierSchemas.workspaceId,
    profileId: IdentifierSchemas.profileId,
    principalRef: z.string().min(1).max(256),
    toolDefinitionId: IdentifierSchemas.toolDefinitionId,
    toolVersionId: IdentifierSchemas.toolVersionId,
    operation: CanonicalNameSchema,
    inputDigest: DigestSchema,
    riskClass: ToolRiskClassSchema,
    requiredCapabilities: z.array(CanonicalNameSchema).max(64).refine(unique),
    policySnapshotRef: PolicyReferenceSchema,
    requestedAt: TimestampSchema,
  })
  .strict()

export type ToolDefinition = z.output<typeof ToolDefinitionSchema>
export type ToolVersion = z.output<typeof ToolVersionSchema>
export type ToolVersionDraft = z.input<typeof ToolVersionDraftSchema>
export type ToolGrant = z.output<typeof ToolGrantSchema>
export type ToolExecutionRequest = z.output<typeof ToolExecutionRequestSchema>
export type ToolExecutionResult = z.output<typeof ToolExecutionResultSchema>
export type ToolExecutorType = z.output<typeof ToolExecutorTypeSchema>
export type DurableToolCallRequest = z.output<typeof DurableToolCallRequestSchema>
export type ToolCall = z.output<typeof ToolCallSchema>
export type ToolCallStatus = z.output<typeof ToolCallStatusSchema>
export type ToolPolicyDecision = z.output<typeof ToolPolicyDecisionSchema>
export type ToolAuthorizationRequest = z.output<typeof ToolAuthorizationRequestSchema>

export interface ToolPolicyAuthorizer {
  authorize(request: ToolAuthorizationRequest): Promise<ToolPolicyDecision>
}

export interface ToolApprovalCoordinator {
  review(request: {
    readonly toolCallId: string
    readonly interactionId: string
    readonly executionId: string
    readonly attemptId: string
    readonly title: string
    readonly allowedPrincipalIds: readonly string[]
    readonly requestedAt: string
    readonly expiresAt: string
  }): Promise<{
    readonly state: 'pending' | 'approved' | 'denied' | 'expired' | 'revoked'
    readonly interactionId: string
    readonly decisionPrincipalRef?: string
  }>
}

export class ToolExecutorError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly effectState: 'none' | 'committed' | 'unknown' = 'unknown'
  ) {
    super(code)
    this.name = 'ToolExecutorError'
  }
}

export interface ToolExecutor {
  execute(
    request: ToolExecutionRequest,
    version: ToolVersion,
    signal: AbortSignal
  ): Promise<{ readonly output: unknown; readonly artifactRefs?: readonly string[] }>
}

export const packageName = 'tool-sdk'
