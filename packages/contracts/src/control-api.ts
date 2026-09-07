import { z } from 'zod'
import { ServiceCallerAssertionSchema, ServiceScopeSchema } from './authentication.js'
import { CorrelationMetadataSchema } from './envelopes.js'
import { IdentifierSchemas } from './identifiers.js'
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
    workspaceIdentity: MarketplaceIdentitySchema,
  }),
})

export const MarketplaceInstallResponseSchema = successResponse(
  MarketplacePluginReferenceContractSchema.extend({
    installationId: z.string().min(1).max(128),
    catalogId: z.string().regex(/^catalog:[a-f0-9]{64}$/),
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

export const ExecutionRequestValidationRequestSchema = CommandContextSchema.extend({
  operation: z.literal('execution.validate'),
  issuedAt: TimestampSchema,
  payload: z.object({
    taskId: IdentifierSchemas.taskId,
    agentId: IdentifierSchemas.agentId,
    profileVersionId: IdentifierSchemas.profileVersionId,
    skillVersionIds: z.array(IdentifierSchemas.skillVersionId).max(128),
    projectState: ProjectStateReferenceSchema,
    contextPackage: ContextPackagePublicReferenceSchema,
    policySnapshot: PolicySnapshotPublicReferenceSchema,
    runtimeRequirements: z.array(CapabilityNameSchema).max(128),
    outputContractRef: z.string().min(1).max(512),
  }),
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
