import { z } from 'zod'
import {
  GraphSelectionSchema,
  GraphDefinitionContentSchema,
  GraphDefinitionVersionSchema,
  GraphReferenceSchema,
} from './graphs.js'
import { ServiceCallerAssertionSchema, ServiceScopeSchema } from './authentication.js'
import { CorrelationMetadataSchema } from './envelopes.js'
import { IdentifierSchemas } from './identifiers.js'
import { CursorSchema } from './pagination.js'
import { ContractVersionSchema } from './versioning.js'

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
const PayloadHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const ExternalReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/)
const CapabilityNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9.-]*$/)

const RequestContextSchema = z.object({
  caller: ServiceCallerAssertionSchema,
  contractVersion: ContractVersionSchema,
  requestId: IdentifierSchemas.requestId,
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId.optional(),
  correlation: CorrelationMetadataSchema,
})

const CommandContextSchema = RequestContextSchema.extend({
  commandId: IdentifierSchemas.commandId,
  idempotencyKey: IdempotencyKeySchema,
  payloadHash: PayloadHashSchema,
})

const ResponseContextSchema = z.object({
  contractVersion: ContractVersionSchema,
  requestId: IdentifierSchemas.requestId,
  correlation: CorrelationMetadataSchema,
})

const successResponse = <Data extends z.ZodType>(data: Data) =>
  ResponseContextSchema.extend({ data })

export const ProjectStateReferenceSchema = z.object({
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId,
  revision: z.number().int().nonnegative(),
})

export type ProjectStateReference = z.output<typeof ProjectStateReferenceSchema>

export const ContextPackagePublicReferenceSchema = z.object({
  contextPackageId: IdentifierSchemas.contextPackageId,
  contentDigest: DigestSchema,
  schemaVersion: z.number().int().positive(),
  compilerVersion: z.string().min(1).max(64),
})

export type ContextPackagePublicReference = z.output<typeof ContextPackagePublicReferenceSchema>

/** Caller selection only; policy, state, Artifact metadata and clocks are host-owned. */
export const ContextAuthoringInputsSchema = z.strictObject({
  objective: z.string().min(1).max(16_384),
  candidates: z
    .array(
      z.strictObject({
        itemId: IdentifierSchemas.projectStateItemId,
        itemRevision: z.number().int().positive(),
        required: z.boolean(),
        priority: z.number().int(),
      })
    )
    .max(10_000),
  successCriteria: z.array(z.string().min(1).max(4_096)).min(1).max(128),
  returnContract: z.strictObject({ contractRef: z.string().min(1).max(512) }),
  budgets: z.strictObject({
    maximumBytes: z.number().int().positive(),
    maximumTokens: z.number().int().positive(),
  }),
})

export type ContextAuthoringInputs = z.output<typeof ContextAuthoringInputsSchema>

export const PolicySnapshotPublicReferenceSchema = z.object({
  policySnapshotId: z.string().min(1).max(256),
  revision: z.number().int().positive(),
  contentDigest: DigestSchema,
})

export type PolicySnapshotPublicReference = z.output<typeof PolicySnapshotPublicReferenceSchema>

export const ExecutionPlanPublicReferenceSchema = z.object({
  executionPlanId: IdentifierSchemas.executionPlanId,
  contentDigest: DigestSchema,
})

export type ExecutionPlanPublicReference = z.output<typeof ExecutionPlanPublicReferenceSchema>

export const ServiceAuthenticationRequestSchema = RequestContextSchema.extend({
  operation: z.literal('authentication.verify'),
  requestedAt: TimestampSchema,
})

export const ServiceAuthenticationResponseSchema = successResponse(
  z.object({
    authenticated: z.literal(true),
    principal: z.object({
      kind: z.literal('agent_hq_service'),
      principalId: z.string().regex(/^svc_[a-z][a-z0-9-]*$/),
      scopes: z.array(ServiceScopeSchema).max(64),
      workspaceIds: z.array(IdentifierSchemas.workspaceId).max(256),
      projectIds: z.array(IdentifierSchemas.projectId).max(256),
    }),
  })
)

export const ProfileResolutionRequestSchema = RequestContextSchema.extend({
  operation: z.literal('profile.resolve'),
  requestedAt: TimestampSchema,
  parameters: z.object({
    profileId: IdentifierSchemas.profileId,
    profileVersionId: IdentifierSchemas.profileVersionId.optional(),
  }),
})

export const ProfileResolutionResponseSchema = successResponse(
  z.object({
    profile: z.object({
      profileId: IdentifierSchemas.profileId,
      profileVersionId: IdentifierSchemas.profileVersionId,
      version: z.number().int().positive(),
      revision: z.number().int().positive(),
      schemaVersion: z.number().int().positive(),
      contentDigest: DigestSchema,
      lifecycle: z.literal('published'),
    }),
    skillVersionIds: z.array(IdentifierSchemas.skillVersionId).max(128),
  })
)

const GraphMutationContextSchema = CommandContextSchema.omit({ projectId: true })
const GraphLifecyclePayloadSchema = z
  .object({
    reference: GraphReferenceSchema,
    expectedRevision: z.number().int().positive(),
    reason: z.string().min(1).max(1024),
  })
  .strict()

export const GraphDefinitionPublishRequestSchema = GraphMutationContextSchema.extend({
  operation: z.literal('graph.publish'),
  issuedAt: TimestampSchema,
  payload: z.object({ definition: GraphDefinitionContentSchema }).strict(),
}).strict()
export const GraphDefinitionDeprecationRequestSchema = GraphMutationContextSchema.extend({
  operation: z.literal('graph.deprecate'),
  issuedAt: TimestampSchema,
  payload: GraphLifecyclePayloadSchema,
}).strict()
export const GraphDefinitionRevocationRequestSchema = GraphMutationContextSchema.extend({
  operation: z.literal('graph.revoke'),
  issuedAt: TimestampSchema,
  payload: GraphLifecyclePayloadSchema,
}).strict()
export const GraphDefinitionResolutionRequestSchema = RequestContextSchema.omit({ projectId: true })
  .extend({
    operation: z.literal('graph.resolve'),
    requestedAt: TimestampSchema,
    parameters: z.object({ reference: GraphReferenceSchema }).strict(),
  })
  .strict()
export const GraphDefinitionResponseSchema = successResponse(
  z.object({ definition: GraphDefinitionVersionSchema }).strict()
)
export type GraphDefinitionPublishRequest = z.input<typeof GraphDefinitionPublishRequestSchema>
export type GraphDefinitionDeprecationRequest = z.input<
  typeof GraphDefinitionDeprecationRequestSchema
>
export type GraphDefinitionRevocationRequest = z.input<
  typeof GraphDefinitionRevocationRequestSchema
>
export type GraphDefinitionResolutionRequest = z.input<
  typeof GraphDefinitionResolutionRequestSchema
>
export type GraphDefinitionResponse = z.output<typeof GraphDefinitionResponseSchema>

const CredentialReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)

/**
 * Write-only secret value. It is accepted once per create or rotate command, is never echoed,
 * persisted in plaintext, logged or returned, and rejects control characters so it cannot
 * inject headers or log lines when a connector uses it.
 */
export const CredentialSecretValueSchema = z
  .string()
  .min(8)
  .max(65_536)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0
        return code >= 0x20 && code !== 0x7f
      }),
    { message: 'Secret values cannot contain control characters' }
  )
  .meta({
    writeOnly: true,
    description: 'Write-only secret value; never returned, logged or persisted in plaintext',
  })

/** Public connector-credential metadata. It never contains secret material or references. */
export const CredentialPublicMetadataSchema = z
  .object({
    credentialId: IdentifierSchemas.credentialId,
    workspaceId: IdentifierSchemas.workspaceId,
    connectorRef: CredentialReferenceSchema,
    provider: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9.-]*$/),
    status: z.enum(['active', 'revoked', 'expired', 'secret_required']),
    revision: z.number().int().positive(),
    createdAt: TimestampSchema,
    createdBy: CredentialReferenceSchema.optional(),
    rotatedAt: TimestampSchema.optional(),
    expiresAt: TimestampSchema.optional(),
    revokedAt: TimestampSchema.optional(),
  })
  .strict()
export type CredentialPublicMetadata = z.output<typeof CredentialPublicMetadataSchema>

const CredentialCommandContextSchema = CommandContextSchema.omit({ projectId: true })
const CredentialReadContextSchema = RequestContextSchema.omit({ projectId: true })

export const CredentialCreateRequestSchema = CredentialCommandContextSchema.extend({
  operation: z.literal('credential.create'),
  issuedAt: TimestampSchema,
  payload: z
    .object({
      connectorRef: CredentialReferenceSchema,
      provider: CredentialPublicMetadataSchema.shape.provider,
      secret: CredentialSecretValueSchema,
      expiresAt: TimestampSchema.optional(),
    })
    .strict(),
}).strict()
export const CredentialRotateRequestSchema = CredentialCommandContextSchema.extend({
  operation: z.literal('credential.rotate'),
  issuedAt: TimestampSchema,
  payload: z
    .object({
      credentialId: IdentifierSchemas.credentialId,
      expectedRevision: z.number().int().positive(),
      secret: CredentialSecretValueSchema,
    })
    .strict(),
}).strict()
export const CredentialRevokeRequestSchema = CredentialCommandContextSchema.extend({
  operation: z.literal('credential.revoke'),
  issuedAt: TimestampSchema,
  payload: z.object({ credentialId: IdentifierSchemas.credentialId }).strict(),
}).strict()
export const CredentialGetRequestSchema = CredentialReadContextSchema.extend({
  operation: z.literal('credential.get'),
  requestedAt: TimestampSchema,
  parameters: z.object({ credentialId: IdentifierSchemas.credentialId }).strict(),
}).strict()
export const CredentialListRequestSchema = CredentialReadContextSchema.extend({
  operation: z.literal('credential.list'),
  requestedAt: TimestampSchema,
  parameters: z
    .object({
      limit: z.number().int().min(1).max(100).optional(),
      cursor: CursorSchema.optional(),
    })
    .strict(),
}).strict()
export const CredentialResponseSchema = successResponse(
  z.object({ credential: CredentialPublicMetadataSchema }).strict()
)
export const CredentialListResponseSchema = successResponse(
  z
    .object({
      credentials: z.array(CredentialPublicMetadataSchema).max(100),
      nextCursor: CursorSchema.optional(),
    })
    .strict()
)
export type CredentialCreateRequest = z.input<typeof CredentialCreateRequestSchema>
export type CredentialRotateRequest = z.input<typeof CredentialRotateRequestSchema>
export type CredentialRevokeRequest = z.input<typeof CredentialRevokeRequestSchema>
export type CredentialGetRequest = z.input<typeof CredentialGetRequestSchema>
export type CredentialListRequest = z.input<typeof CredentialListRequestSchema>
export type CredentialResponse = z.output<typeof CredentialResponseSchema>
export type CredentialListResponse = z.output<typeof CredentialListResponseSchema>

export const ProjectStateResolutionRequestSchema = RequestContextSchema.extend({
  operation: z.literal('project-state.resolve'),
  requestedAt: TimestampSchema,
  parameters: z.object({ revision: z.number().int().nonnegative().optional() }),
})

export const ProjectStateResolutionResponseSchema = successResponse(
  z.object({ projectState: ProjectStateReferenceSchema })
)

export const ContextPackageResolutionRequestSchema = RequestContextSchema.extend({
  operation: z.literal('context-package.resolve'),
  requestedAt: TimestampSchema,
  parameters: z.object({ contextPackageId: IdentifierSchemas.contextPackageId }),
})

export const ContextPackageResolutionResponseSchema = successResponse(
  z.object({ contextPackage: ContextPackagePublicReferenceSchema })
)

const MarketplacePluginReferenceContractSchema = z
  .object({
    pluginId: z.string().regex(/^plugin:[a-z0-9-]+:[a-z0-9][a-z0-9-]{1,127}$/),
    releaseId: z.string().regex(/^release:[a-f0-9]{64}$/),
    canonicalContentDigest: DigestSchema,
  })
  .strict()

const MarketplaceIdentitySchema = z.object({
  workspaceId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
})

const MarketplaceArtifactsSchema = z
  .object({
    'catalog.v1.json': z.string(),
    'catalog-latest.v1.json': z.string(),
    'catalog-summary.v1.json': z.string(),
    'categories.v1.json': z.string(),
    // The consumer browsing index. Optional because a release published before
    // #709 does not carry one; the registry omits it from the response rather
    // than failing, and a present index is still verified in full.
    'catalog-index.v1.json': z.string().optional(),
    'compatibility.v1.json': z.string(),
    'integrity.json': z.string(),
    'sources.lock.json': z.string(),
  })
  .strict()

export const MarketplaceCatalogRequestSchema = RequestContextSchema.extend({
  operation: z.literal('marketplace.catalog.read'),
  requestedAt: TimestampSchema,
  parameters: z.object({ workspaceIdentity: MarketplaceIdentitySchema }),
})

export const MarketplaceCatalogResponseSchema = successResponse(
  z.object({
    catalogId: z.string().regex(/^catalog:[a-f0-9]{64}$/),
    releaseId: z.string().regex(/^catalog:[a-f0-9]{64}$/),
    state: z.enum(['ready', 'stale']),
    artifacts: MarketplaceArtifactsSchema,
    installations: z.array(
      MarketplacePluginReferenceContractSchema.extend({
        installationInstanceId: z.string().min(1).max(256).optional(),
        packageDigest: DigestSchema.optional(),
        state: z.enum([
          'pending-authorization',
          'unavailable',
          'rejected-by-policy',
          'installed',
          'superseded',
        ]),
      })
    ),
  })
)

export const MarketplaceInstallRequestSchema = CommandContextSchema.extend({
  operation: z.literal('marketplace.install.request'),
  issuedAt: TimestampSchema,
  payload: MarketplacePluginReferenceContractSchema.extend({
    requestedHarness: z.string().min(1).max(128),
    installationInstanceId: z.string().min(1).max(256).optional(),
    workspaceIdentity: MarketplaceIdentitySchema,
  }),
})

export const MarketplaceInstallResponseSchema = successResponse(
  MarketplacePluginReferenceContractSchema.extend({
    installationId: z.string().min(1).max(128),
    catalogId: z.string().regex(/^catalog:[a-f0-9]{64}$/),
    installationInstanceId: z.string().min(1).max(256).optional(),
    packageDigest: DigestSchema.optional(),
    requestedHarness: z.string().min(1).max(128),
    state: z.enum([
      'pending-authorization',
      'unavailable',
      'rejected-by-policy',
      'installed',
      'superseded',
    ]),
  })
)

export type MarketplaceCatalogRequest = z.input<typeof MarketplaceCatalogRequestSchema>
export type MarketplaceCatalogResponse = z.output<typeof MarketplaceCatalogResponseSchema>
export type MarketplaceInstallRequest = z.input<typeof MarketplaceInstallRequestSchema>
export type MarketplaceInstallResponse = z.output<typeof MarketplaceInstallResponseSchema>

export const MarketplaceInstallPlanRequestSchema = CommandContextSchema.extend({
  operation: z.literal('marketplace.install.plan'),
  issuedAt: TimestampSchema,
  payload: z.object({
    pluginId: z.string().regex(/^plugin:[a-z0-9-]+:[a-z0-9][a-z0-9-]{1,127}$/),
    releaseId: z.string().regex(/^release:[a-f0-9]{64}$/),
    instanceId: z.string().min(1).max(256),
    requestedHarness: z.string().min(1).max(128),
    workspaceIdentity: MarketplaceIdentitySchema,
  }),
})

// The published Agent Plugins package owns the complete plan schema. Control
// Plane checks the security-critical identity fields here and preserves the
// remaining plan fields as an opaque, versioned response for forward evolution.
export const MarketplaceInstallPlanResponseSchema = successResponse(
  z
    .object({
      planVersion: z.literal(2),
      pluginId: z.string().min(1),
      releaseId: z.string().min(1),
      instanceId: z.string().min(1),
      strategy: z.enum(['native-agent-plugin', 'component-adapter', 'unavailable']),
      compatibility: z.enum(['full', 'partial', 'unsupported']),
      allowedToActivate: z.literal(false),
      approvalRequired: z.literal(true),
    })
    .passthrough()
)

export type MarketplaceInstallPlanRequest = z.output<typeof MarketplaceInstallPlanRequestSchema>
export type MarketplaceInstallPlanResponse = z.output<typeof MarketplaceInstallPlanResponseSchema>

export const RuntimeReadModelSchema = z.object({
  runtimeNodeRefId: IdentifierSchemas.runtimeNodeRefId,
  runtimeConnectionId: IdentifierSchemas.runtimeConnectionId.optional(),
  runtimeDefinitionId: IdentifierSchemas.runtimeDefinitionId,
  family: z.string().min(1).max(64),
  location: z.enum(['local_device', 'remote_host', 'agent_hq_cloud']),
  status: z.enum(['available', 'degraded', 'unavailable', 'revoked']),
  observedAt: TimestampSchema,
  capabilities: z.array(CapabilityNameSchema).max(128),
  limitations: z.array(z.string().min(1).max(512)).max(64),
})

export type RuntimeReadModel = z.output<typeof RuntimeReadModelSchema>

export const RuntimeListRequestSchema = RequestContextSchema.extend({
  operation: z.literal('runtime.list'),
  requestedAt: TimestampSchema,
  parameters: z.object({
    status: z.enum(['available', 'degraded', 'unavailable', 'revoked']).optional(),
    requiredCapabilities: z.array(CapabilityNameSchema).max(128),
  }),
})

export const RuntimeListResponseSchema = successResponse(
  z.object({ runtimes: z.array(RuntimeReadModelSchema).max(1_000) })
)

const ExecutionValidationPayloadSchema = z.object({
  graph: GraphSelectionSchema.optional(),
  taskId: IdentifierSchemas.taskId,
  agentId: IdentifierSchemas.agentId,
  profileVersionId: IdentifierSchemas.profileVersionId,
  skillVersionIds: z.array(IdentifierSchemas.skillVersionId).max(128),
  projectState: ProjectStateReferenceSchema,
  policySnapshot: PolicySnapshotPublicReferenceSchema,
  runtimeRequirements: z.array(CapabilityNameSchema).max(128),
  outputContractRef: z.string().min(1).max(512),
})

export const ExecutionRequestValidationRequestSchema = CommandContextSchema.extend({
  operation: z.literal('execution.validate'),
  issuedAt: TimestampSchema,
  payload: z.union([
    ExecutionValidationPayloadSchema.extend({
      contextPackage: ContextPackagePublicReferenceSchema,
      contextInputs: z.never().optional(),
    }),
    ExecutionValidationPayloadSchema.extend({
      contextPackage: z.never().optional(),
      contextInputs: ContextAuthoringInputsSchema,
    }),
  ]),
}).superRefine((request, context) => {
  if (
    request.payload.projectState.workspaceId !== request.workspaceId ||
    request.payload.projectState.projectId !== request.projectId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'projectState'],
      message: 'ProjectState scope must match the execution request scope',
    })
  }
})

export const ExecutionRequestValidationResponseSchema = successResponse(
  z.object({
    valid: z.literal(true),
    executionPlan: ExecutionPlanPublicReferenceSchema,
  })
)

export const ExecutionAcceptanceRequestSchema = CommandContextSchema.extend({
  projectId: IdentifierSchemas.projectId,
  operation: z.literal('execution.accept'),
  issuedAt: TimestampSchema,
  payload: z.object({
    taskId: IdentifierSchemas.taskId,
    agentId: IdentifierSchemas.agentId,
    executionPlan: ExecutionPlanPublicReferenceSchema.extend({
      schemaVersion: z.number().int().positive(),
    }),
    marketplacePluginReferences: z
      .array(
        z
          .object({
            canonicalContentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            pluginId: z.string().regex(/^plugin:[a-z0-9-]+:[a-z0-9][a-z0-9-]{1,127}$/),
            releaseId: z.string().regex(/^release:[a-f0-9]{64}$/),
          })
          .strict()
      )
      .max(128)
      .optional(),
    parentExecutionId: IdentifierSchemas.executionId.optional(),
    deadlineAt: TimestampSchema.optional(),
    retentionExpiresAt: TimestampSchema,
  }),
})

export const ExecutionAcceptanceResponseSchema = successResponse(
  z.object({
    commandId: IdentifierSchemas.commandId,
    executionId: IdentifierSchemas.executionId,
    executionPlan: ExecutionPlanPublicReferenceSchema.extend({
      schemaVersion: z.number().int().positive(),
    }),
    status: z.enum(['accepted', 'processing', 'completed', 'failed', 'reconciliation_required']),
    replayed: z.boolean(),
    resultReference: IdentifierSchemas.artifactId.optional(),
    errorReference: ExternalReferenceSchema.optional(),
  })
)

/** Requests execution-level cancellation; runtime routing and leases remain server-owned. */
export const ExecutionCancellationCommandSchema = CommandContextSchema.extend({
  projectId: IdentifierSchemas.projectId,
  operation: z.literal('execution.cancel'),
  issuedAt: TimestampSchema,
  payload: z.strictObject({ executionId: IdentifierSchemas.executionId }),
}).strict()

/** Confirms signal acceptance only, never that native work has stopped. */
export const ExecutionCancellationCommandResultSchema = successResponse(
  z.strictObject({
    commandId: IdentifierSchemas.commandId,
    executionId: IdentifierSchemas.executionId,
    status: z.literal('accepted'),
    replayed: z.boolean(),
  })
)
export type ExecutionCancellationCommand = z.input<typeof ExecutionCancellationCommandSchema>
export type ExecutionCancellationCommandResult = z.output<
  typeof ExecutionCancellationCommandResultSchema
>

export const InteractionResponseCommandSchema = CommandContextSchema.extend({
  projectId: IdentifierSchemas.projectId,
  operation: z.literal('interaction.respond'),
  issuedAt: TimestampSchema,
  payload: z
    .strictObject({
      executionId: IdentifierSchemas.executionId,
      attemptId: IdentifierSchemas.attemptId,
      interactionId: IdentifierSchemas.interactionId,
      expectedVersion: z.number().int().positive(),
      action: z.enum(['approve', 'deny', 'input', 'grant', 'resume', 'cancel']),
      value: z.json().optional(),
    })
    .superRefine((payload, context) => {
      if ((payload.action === 'input') !== (payload.value !== undefined))
        context.addIssue({ code: 'custom', message: 'Only input actions require a value' })
      if (
        payload.value !== undefined &&
        new TextEncoder().encode(JSON.stringify(payload.value)).byteLength > 8_192
      )
        context.addIssue({ code: 'custom', message: 'Interaction input exceeds 8 KiB' })
    }),
}).strict()

/** Acknowledges durable signal acceptance, not execution completion. */
export const InteractionResponseCommandResultSchema = successResponse(
  z.strictObject({
    commandId: IdentifierSchemas.commandId,
    responseId: IdentifierSchemas.commandId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    interactionId: IdentifierSchemas.interactionId,
    status: z.literal('accepted'),
    replayed: z.boolean(),
  })
)

export type InteractionResponseCommand = z.input<typeof InteractionResponseCommandSchema>
export type InteractionResponseCommandResult = z.output<
  typeof InteractionResponseCommandResultSchema
>

export type ServiceAuthenticationRequest = z.input<typeof ServiceAuthenticationRequestSchema>
export type ServiceAuthenticationResponse = z.output<typeof ServiceAuthenticationResponseSchema>
export type ProfileResolutionRequest = z.input<typeof ProfileResolutionRequestSchema>
export type ProfileResolutionResponse = z.output<typeof ProfileResolutionResponseSchema>
export type ProjectStateResolutionRequest = z.input<typeof ProjectStateResolutionRequestSchema>
export type ProjectStateResolutionResponse = z.output<typeof ProjectStateResolutionResponseSchema>
export type ContextPackageResolutionRequest = z.input<typeof ContextPackageResolutionRequestSchema>
export type ContextPackageResolutionResponse = z.output<
  typeof ContextPackageResolutionResponseSchema
>
export type RuntimeListRequest = z.input<typeof RuntimeListRequestSchema>
export type RuntimeListResponse = z.output<typeof RuntimeListResponseSchema>
export type ExecutionRequestValidationRequest = z.input<
  typeof ExecutionRequestValidationRequestSchema
>
export type ExecutionRequestValidationResponse = z.output<
  typeof ExecutionRequestValidationResponseSchema
>
export type ExecutionAcceptanceRequest = z.input<typeof ExecutionAcceptanceRequestSchema>
export type ExecutionAcceptanceResponse = z.output<typeof ExecutionAcceptanceResponseSchema>

const contractVersion = { major: 3, minor: 0 } as const
const requestId = 'req_01JABCDEF0123456789ABCDEFG'
const commandId = 'cmd_01JABCDEF0123456789ABCDEFG'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
const traceId = 'trc_01JABCDEF0123456789ABCDEFG'
const caller = { servicePrincipalId: 'svc_agent-hq' }
const requestContext = {
  caller,
  contractVersion,
  requestId,
  workspaceId,
  projectId,
  correlation: { traceId },
}
const responseContext = { contractVersion, requestId, correlation: { traceId } }
const projectStateReference = { workspaceId, projectId, revision: 7 }
const contextPackageReference = {
  contextPackageId: 'ctx_01JABCDEF0123456789ABCDEFG',
  contentDigest: `sha256:${'b'.repeat(64)}`,
  schemaVersion: 1,
  compilerVersion: '1.0.0',
}

export interface ControlApiFixtureSet {
  readonly executionCancellation: {
    readonly request: ExecutionCancellationCommand
    readonly response: z.input<typeof ExecutionCancellationCommandResultSchema>
  }
  readonly interactionResponse: {
    readonly request: InteractionResponseCommand
    readonly response: z.input<typeof InteractionResponseCommandResultSchema>
  }
  readonly authentication: {
    readonly request: ServiceAuthenticationRequest
    readonly response: z.input<typeof ServiceAuthenticationResponseSchema>
  }
  readonly profileResolution: {
    readonly request: ProfileResolutionRequest
    readonly response: z.input<typeof ProfileResolutionResponseSchema>
  }
  readonly projectStateReference: z.input<typeof ProjectStateReferenceSchema>
  readonly contextPackageReference: z.input<typeof ContextPackagePublicReferenceSchema>
  readonly projectStateResolution: {
    readonly request: ProjectStateResolutionRequest
    readonly response: z.input<typeof ProjectStateResolutionResponseSchema>
  }
  readonly contextPackageResolution: {
    readonly request: ContextPackageResolutionRequest
    readonly response: z.input<typeof ContextPackageResolutionResponseSchema>
  }
  readonly runtimeList: {
    readonly request: RuntimeListRequest
    readonly response: z.input<typeof RuntimeListResponseSchema>
  }
  readonly executionValidation: {
    readonly request: ExecutionRequestValidationRequest
    readonly response: z.input<typeof ExecutionRequestValidationResponseSchema>
  }
  readonly executionAcceptance: {
    readonly request: ExecutionAcceptanceRequest
    readonly response: z.input<typeof ExecutionAcceptanceResponseSchema>
  }
}

export const ControlApiFixtures: ControlApiFixtureSet = Object.freeze({
  executionCancellation: {
    request: {
      ...requestContext,
      commandId,
      idempotencyKey: 'cancellation-01JABCDEF0123456789ABCDEFG',
      payloadHash: 'f'.repeat(64),
      operation: 'execution.cancel',
      issuedAt: '2026-08-23T12:00:00.000Z',
      payload: { executionId: 'exe_01JABCDEF0123456789ABCDEFG' },
    },
    response: {
      ...responseContext,
      data: {
        commandId,
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        status: 'accepted',
        replayed: false,
      },
    },
  },
  interactionResponse: {
    request: {
      ...requestContext,
      commandId,
      idempotencyKey: 'interaction-01JABCDEF0123456789ABCDEFG',
      payloadHash: 'f'.repeat(64),
      operation: 'interaction.respond',
      issuedAt: '2026-08-23T12:00:00.000Z',
      payload: {
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        interactionId: 'int_01JABCDEF0123456789ABCDEFG',
        expectedVersion: 1,
        action: 'input',
        value: 'continue',
      },
    },
    response: {
      ...responseContext,
      data: {
        commandId,
        responseId: commandId,
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        interactionId: 'int_01JABCDEF0123456789ABCDEFG',
        status: 'accepted',
        replayed: false,
      },
    },
  },
  authentication: {
    request: {
      ...requestContext,
      operation: 'authentication.verify',
      requestedAt: '2026-08-23T12:00:00.000Z',
    },
    response: {
      ...responseContext,
      data: {
        authenticated: true,
        principal: {
          kind: 'agent_hq_service',
          principalId: 'svc_agent-hq',
          scopes: [
            'profile:resolve',
            'runtime:read',
            'execution:validate',
            'execution:accept',
            'system:authenticate',
          ],
          workspaceIds: [workspaceId],
          projectIds: [projectId],
        },
      },
    },
  },
  profileResolution: {
    request: {
      ...requestContext,
      operation: 'profile.resolve',
      requestedAt: '2026-08-23T12:00:00.000Z',
      parameters: { profileId: 'prf_01JABCDEF0123456789ABCDEFG' },
    },
    response: {
      ...responseContext,
      data: {
        profile: {
          profileId: 'prf_01JABCDEF0123456789ABCDEFG',
          profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
          version: 3,
          revision: 2,
          schemaVersion: 1,
          contentDigest: `sha256:${'a'.repeat(64)}`,
          lifecycle: 'published',
        },
        skillVersionIds: ['skv_01JABCDEF0123456789ABCDEFG'],
      },
    },
  },
  projectStateReference,
  contextPackageReference,
  projectStateResolution: {
    request: {
      ...requestContext,
      operation: 'project-state.resolve',
      requestedAt: '2026-08-23T12:00:00.000Z',
      parameters: { revision: 7 },
    },
    response: { ...responseContext, data: { projectState: projectStateReference } },
  },
  contextPackageResolution: {
    request: {
      ...requestContext,
      operation: 'context-package.resolve',
      requestedAt: '2026-08-23T12:00:00.000Z',
      parameters: { contextPackageId: contextPackageReference.contextPackageId },
    },
    response: { ...responseContext, data: { contextPackage: contextPackageReference } },
  },
  runtimeList: {
    request: {
      ...requestContext,
      operation: 'runtime.list',
      requestedAt: '2026-08-23T12:00:00.000Z',
      parameters: { status: 'available', requiredCapabilities: ['tool.call'] },
    },
    response: {
      ...responseContext,
      data: {
        runtimes: [
          {
            runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
            runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
            runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
            family: 'mock',
            location: 'agent_hq_cloud',
            status: 'available',
            observedAt: '2026-08-23T12:00:00.000Z',
            capabilities: ['tool.call'],
            limitations: [],
          },
        ],
      },
    },
  },
  executionValidation: {
    request: {
      ...requestContext,
      commandId,
      idempotencyKey: 'intent-01JABCDEF0123456789ABCDEFG',
      payloadHash: 'c'.repeat(64),
      operation: 'execution.validate',
      issuedAt: '2026-08-23T12:00:00.000Z',
      payload: {
        taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
        agentId: 'agt_01JABCDEF0123456789ABCDEFG',
        profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
        skillVersionIds: ['skv_01JABCDEF0123456789ABCDEFG'],
        projectState: projectStateReference,
        contextPackage: contextPackageReference,
        policySnapshot: {
          policySnapshotId: 'policy-snapshot-2026-08-23',
          revision: 4,
          contentDigest: `sha256:${'d'.repeat(64)}`,
        },
        runtimeRequirements: ['tool.call'],
        outputContractRef: 'agent-hq://contracts/task-result/v1',
      },
    },
    response: {
      ...responseContext,
      data: {
        valid: true,
        executionPlan: {
          executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'e'.repeat(64)}`,
        },
      },
    },
  },
  executionAcceptance: {
    request: {
      ...requestContext,
      commandId,
      idempotencyKey: 'intent-01JABCDEF0123456789ABCDEFG',
      payloadHash: 'f'.repeat(64),
      operation: 'execution.accept',
      issuedAt: '2026-08-23T12:00:00.000Z',
      payload: {
        taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
        agentId: 'agt_01JABCDEF0123456789ABCDEFG',
        executionPlan: {
          executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'e'.repeat(64)}`,
          schemaVersion: 1,
        },
        deadlineAt: '2026-08-23T13:00:00.000Z',
        retentionExpiresAt: '2026-09-22T12:00:00.000Z',
      },
    },
    response: {
      ...responseContext,
      data: {
        commandId,
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        executionPlan: {
          executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'e'.repeat(64)}`,
          schemaVersion: 1,
        },
        status: 'accepted',
        replayed: false,
      },
    },
  },
} satisfies ControlApiFixtureSet)

const credentialFixtureMetadata = {
  credentialId: 'crd_01JABCDEF0123456789ABCDEFG',
  workspaceId,
  connectorRef: 'connector:github',
  provider: 'github',
  status: 'active',
  revision: 1,
  createdAt: '2026-10-06T12:00:00.000Z',
  createdBy: 'svc_agent-hq',
} as const
const credentialCommandContext = {
  caller,
  contractVersion,
  requestId,
  workspaceId,
  correlation: { traceId },
  commandId,
  payloadHash: 'f'.repeat(64),
  issuedAt: '2026-10-06T12:00:00.000Z',
}
const credentialReadContext = {
  caller,
  contractVersion,
  requestId,
  workspaceId,
  correlation: { traceId },
  requestedAt: '2026-10-06T12:00:00.000Z',
}

/**
 * Deterministic credential API fixtures. The secret values are inert placeholders that tests use
 * as canaries; they are not real credentials.
 */
export const CredentialApiFixtures = Object.freeze({
  create: {
    request: {
      ...credentialCommandContext,
      idempotencyKey: 'credential-create-01JABCDEF0123456789ABCDEFG',
      operation: 'credential.create',
      payload: {
        connectorRef: 'connector:github',
        provider: 'github',
        secret: 'fixture-placeholder-not-a-secret-0001',
      },
    },
    response: { ...responseContext, data: { credential: credentialFixtureMetadata } },
  },
  rotate: {
    request: {
      ...credentialCommandContext,
      idempotencyKey: 'credential-rotate-01JABCDEF0123456789ABCDEFG',
      operation: 'credential.rotate',
      payload: {
        credentialId: credentialFixtureMetadata.credentialId,
        expectedRevision: 1,
        secret: 'fixture-placeholder-not-a-secret-0002',
      },
    },
    response: {
      ...responseContext,
      data: {
        credential: {
          ...credentialFixtureMetadata,
          revision: 2,
          rotatedAt: '2026-10-06T12:05:00.000Z',
        },
      },
    },
  },
  revoke: {
    request: {
      ...credentialCommandContext,
      idempotencyKey: 'credential-revoke-01JABCDEF0123456789ABCDEFG',
      operation: 'credential.revoke',
      payload: { credentialId: credentialFixtureMetadata.credentialId },
    },
    response: {
      ...responseContext,
      data: {
        credential: {
          ...credentialFixtureMetadata,
          status: 'revoked',
          revokedAt: '2026-10-06T12:10:00.000Z',
        },
      },
    },
  },
  get: {
    request: {
      ...credentialReadContext,
      operation: 'credential.get',
      parameters: { credentialId: credentialFixtureMetadata.credentialId },
    },
    response: { ...responseContext, data: { credential: credentialFixtureMetadata } },
  },
  list: {
    request: { ...credentialReadContext, operation: 'credential.list', parameters: { limit: 50 } },
    response: { ...responseContext, data: { credentials: [credentialFixtureMetadata] } },
  },
} satisfies {
  readonly create: {
    readonly request: CredentialCreateRequest
    readonly response: z.input<typeof CredentialResponseSchema>
  }
  readonly rotate: {
    readonly request: CredentialRotateRequest
    readonly response: z.input<typeof CredentialResponseSchema>
  }
  readonly revoke: {
    readonly request: CredentialRevokeRequest
    readonly response: z.input<typeof CredentialResponseSchema>
  }
  readonly get: {
    readonly request: CredentialGetRequest
    readonly response: z.input<typeof CredentialResponseSchema>
  }
  readonly list: {
    readonly request: CredentialListRequest
    readonly response: z.input<typeof CredentialListResponseSchema>
  }
})
