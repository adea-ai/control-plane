import { z } from 'zod'
import { ServiceCallerAssertionSchema } from './authentication.js'
import { CorrelationMetadataSchema } from './envelopes.js'
import { IdentifierSchemas } from './identifiers.js'
import { CursorSchema } from './pagination.js'
import { ContractVersionSchema } from './versioning.js'

/**
 * Workspace catalog administration (additive within contract major 3). Adea manages Skills and
 * AgentProfiles owned by the envelope workspace and reads system entries visible to it.
 * Executable content (Skill manifest/content, AgentProfile definition) crosses the boundary
 * as JSON objects and is validated by the Control Plane's versioned catalog schemas
 * (`docs/profiles-and-skills.md`); this package stays free of domain dependencies.
 */

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
const PayloadHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const DisplayNameSchema = z.string().min(1).max(128)
const ReasonSchema = z.string().min(1).max(512)
const JsonObjectSchema = z.record(z.string(), z.unknown())

const CatalogReadContextSchema = z.object({
  caller: ServiceCallerAssertionSchema,
  contractVersion: ContractVersionSchema,
  requestId: IdentifierSchemas.requestId,
  workspaceId: IdentifierSchemas.workspaceId,
  correlation: CorrelationMetadataSchema,
  requestedAt: TimestampSchema,
})

const CatalogCommandContextSchema = z.object({
  caller: ServiceCallerAssertionSchema,
  contractVersion: ContractVersionSchema,
  requestId: IdentifierSchemas.requestId,
  workspaceId: IdentifierSchemas.workspaceId,
  correlation: CorrelationMetadataSchema,
  commandId: IdentifierSchemas.commandId,
  idempotencyKey: IdempotencyKeySchema,
  payloadHash: PayloadHashSchema,
  issuedAt: TimestampSchema,
})

const CatalogResponseContextSchema = z.object({
  contractVersion: ContractVersionSchema,
  requestId: IdentifierSchemas.requestId,
  correlation: CorrelationMetadataSchema,
})

const catalogResponse = <Data extends z.ZodType>(data: Data) =>
  CatalogResponseContextSchema.extend({ data })

/** Only system and the envelope workspace are visible through this API. */
export const WorkspaceCatalogOwnershipSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('system') }).strict(),
  z.object({ scope: z.literal('workspace'), workspaceId: IdentifierSchemas.workspaceId }).strict(),
])

export const WorkspaceCatalogLifecycleSchema = z.enum([
  'draft',
  'published',
  'deprecated',
  'revoked',
  'superseded',
])

const LifecycleMetadataSchema = z
  .object({
    publishedAt: TimestampSchema.optional(),
    deprecatedAt: TimestampSchema.optional(),
    revokedAt: TimestampSchema.optional(),
    supersededAt: TimestampSchema.optional(),
    reason: ReasonSchema.optional(),
  })
  .strict()

const PageParametersSchema = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()

export const WorkspaceSkillRecordSchema = z
  .object({
    skillId: IdentifierSchemas.skillId,
    displayName: DisplayNameSchema,
    ownership: WorkspaceCatalogOwnershipSchema,
    readOnly: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict()

export const WorkspaceSkillVersionSummarySchema = z
  .object({
    skillId: IdentifierSchemas.skillId,
    skillVersionId: IdentifierSchemas.skillVersionId,
    semanticVersion: z.string().min(1).max(256),
    revision: z.number().int().positive(),
    lifecycle: WorkspaceCatalogLifecycleSchema,
    contentDigest: DigestSchema,
    createdAt: TimestampSchema,
    lifecycleMetadata: LifecycleMetadataSchema.extend({
      supersededByVersionId: IdentifierSchemas.skillVersionId.optional(),
    }).strict(),
  })
  .strict()

export const WorkspaceSkillVersionSchema = WorkspaceSkillVersionSummarySchema.extend({
  manifest: JsonObjectSchema,
  content: JsonObjectSchema,
}).strict()

export const WorkspaceAgentProfileRecordSchema = z
  .object({
    profileId: IdentifierSchemas.profileId,
    displayName: DisplayNameSchema,
    ownership: WorkspaceCatalogOwnershipSchema,
    readOnly: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict()

export const WorkspaceAgentProfileVersionSummarySchema = z
  .object({
    profileId: IdentifierSchemas.profileId,
    profileVersionId: IdentifierSchemas.profileVersionId,
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
    lifecycle: WorkspaceCatalogLifecycleSchema,
    contentDigest: DigestSchema,
    createdAt: TimestampSchema,
    lifecycleMetadata: LifecycleMetadataSchema.extend({
      supersededByVersionId: IdentifierSchemas.profileVersionId.optional(),
    }).strict(),
  })
  .strict()

export const WorkspaceAgentProfileVersionSchema = WorkspaceAgentProfileVersionSummarySchema.extend({
  definition: JsonObjectSchema,
}).strict()

export const WorkspaceSkillListRequestSchema = CatalogReadContextSchema.extend({
  operation: z.literal('catalog.skill.list'),
  parameters: PageParametersSchema,
}).strict()

export const WorkspaceSkillListResponseSchema = catalogResponse(
  z
    .object({
      items: z
        .array(
          z
            .object({
              skill: WorkspaceSkillRecordSchema,
              latestVersion: WorkspaceSkillVersionSummarySchema.optional(),
            })
            .strict()
        )
        .max(100),
      page: z.object({ nextCursor: CursorSchema.optional() }).strict(),
    })
    .strict()
)

export const WorkspaceSkillGetRequestSchema = CatalogReadContextSchema.extend({
  operation: z.literal('catalog.skill.get'),
  parameters: z
    .object({
      skillId: IdentifierSchemas.skillId,
      skillVersionId: IdentifierSchemas.skillVersionId.optional(),
    })
    .strict(),
}).strict()

export const WorkspaceSkillGetResponseSchema = catalogResponse(
  z
    .object({
      skill: WorkspaceSkillRecordSchema,
      versions: z.array(WorkspaceSkillVersionSummarySchema).max(1_000),
      version: WorkspaceSkillVersionSchema.optional(),
    })
    .strict()
)

export const WorkspaceSkillPublishRequestSchema = CatalogCommandContextSchema.extend({
  operation: z.literal('catalog.skill.publish'),
  payload: z
    .object({
      skillId: IdentifierSchemas.skillId,
      skillVersionId: IdentifierSchemas.skillVersionId,
      displayName: DisplayNameSchema.optional(),
      manifest: JsonObjectSchema,
      content: JsonObjectSchema,
    })
    .strict(),
}).strict()

export const WorkspaceSkillPublishResponseSchema = catalogResponse(
  z.object({ skill: WorkspaceSkillRecordSchema, version: WorkspaceSkillVersionSchema }).strict()
)

const SkillLifecycleTargetSchema = z.union([
  z
    .object({
      skillId: IdentifierSchemas.skillId,
      skillVersionId: IdentifierSchemas.skillVersionId,
      expectedRevision: z.number().int().positive(),
      reason: ReasonSchema,
    })
    .strict(),
  z.object({ skillId: IdentifierSchemas.skillId, reason: ReasonSchema }).strict(),
])

export const WorkspaceSkillDeprecationRequestSchema = CatalogCommandContextSchema.extend({
  operation: z.literal('catalog.skill.deprecate'),
  payload: SkillLifecycleTargetSchema,
}).strict()

export const WorkspaceSkillRevocationRequestSchema = CatalogCommandContextSchema.extend({
  operation: z.literal('catalog.skill.revoke'),
  payload: SkillLifecycleTargetSchema,
}).strict()

export const WorkspaceSkillLifecycleResponseSchema = catalogResponse(
  z
    .object({
      skill: WorkspaceSkillRecordSchema,
      changed: z.array(WorkspaceSkillVersionSummarySchema).max(1_000),
    })
    .strict()
)

export const WorkspaceAgentProfileListRequestSchema = CatalogReadContextSchema.extend({
  operation: z.literal('catalog.profile.list'),
  parameters: PageParametersSchema,
}).strict()

export const WorkspaceAgentProfileListResponseSchema = catalogResponse(
  z
    .object({
      items: z
        .array(
          z
            .object({
              profile: WorkspaceAgentProfileRecordSchema,
              latestVersion: WorkspaceAgentProfileVersionSummarySchema.optional(),
            })
            .strict()
        )
        .max(100),
      page: z.object({ nextCursor: CursorSchema.optional() }).strict(),
    })
    .strict()
)

export const WorkspaceAgentProfileGetRequestSchema = CatalogReadContextSchema.extend({
  operation: z.literal('catalog.profile.get'),
  parameters: z
    .object({
      profileId: IdentifierSchemas.profileId,
      profileVersionId: IdentifierSchemas.profileVersionId.optional(),
    })
    .strict(),
}).strict()

export const WorkspaceAgentProfileGetResponseSchema = catalogResponse(
  z
    .object({
      profile: WorkspaceAgentProfileRecordSchema,
      versions: z.array(WorkspaceAgentProfileVersionSummarySchema).max(1_000),
      version: WorkspaceAgentProfileVersionSchema.optional(),
    })
    .strict()
)

export const WorkspaceAgentProfilePublishRequestSchema = CatalogCommandContextSchema.extend({
  operation: z.literal('catalog.profile.publish'),
  payload: z
    .object({
      profileId: IdentifierSchemas.profileId,
      profileVersionId: IdentifierSchemas.profileVersionId,
      displayName: DisplayNameSchema.optional(),
      version: z.number().int().positive(),
      definition: JsonObjectSchema,
    })
    .strict(),
}).strict()

export const WorkspaceAgentProfilePublishResponseSchema = catalogResponse(
  z
    .object({
      profile: WorkspaceAgentProfileRecordSchema,
      version: WorkspaceAgentProfileVersionSchema,
    })
    .strict()
)

const ProfileLifecycleTargetSchema = z.union([
  z
    .object({
      profileId: IdentifierSchemas.profileId,
      profileVersionId: IdentifierSchemas.profileVersionId,
      expectedRevision: z.number().int().positive(),
      reason: ReasonSchema,
    })
    .strict(),
  z.object({ profileId: IdentifierSchemas.profileId, reason: ReasonSchema }).strict(),
])

export const WorkspaceAgentProfileDeprecationRequestSchema = CatalogCommandContextSchema.extend({
  operation: z.literal('catalog.profile.deprecate'),
  payload: ProfileLifecycleTargetSchema,
}).strict()

export const WorkspaceAgentProfileRevocationRequestSchema = CatalogCommandContextSchema.extend({
  operation: z.literal('catalog.profile.revoke'),
  payload: ProfileLifecycleTargetSchema,
}).strict()

export const WorkspaceAgentProfileLifecycleResponseSchema = catalogResponse(
  z
    .object({
      profile: WorkspaceAgentProfileRecordSchema,
      changed: z.array(WorkspaceAgentProfileVersionSummarySchema).max(1_000),
    })
    .strict()
)

export type WorkspaceCatalogOwnership = z.output<typeof WorkspaceCatalogOwnershipSchema>
export type WorkspaceSkillRecord = z.output<typeof WorkspaceSkillRecordSchema>
export type WorkspaceSkillVersionSummary = z.output<typeof WorkspaceSkillVersionSummarySchema>
export type WorkspaceSkillVersion = z.output<typeof WorkspaceSkillVersionSchema>
export type WorkspaceAgentProfileRecord = z.output<typeof WorkspaceAgentProfileRecordSchema>
export type WorkspaceAgentProfileVersionSummary = z.output<
  typeof WorkspaceAgentProfileVersionSummarySchema
>
export type WorkspaceAgentProfileVersion = z.output<typeof WorkspaceAgentProfileVersionSchema>
export type WorkspaceSkillListRequest = z.input<typeof WorkspaceSkillListRequestSchema>
export type WorkspaceSkillListResponse = z.output<typeof WorkspaceSkillListResponseSchema>
export type WorkspaceSkillGetRequest = z.input<typeof WorkspaceSkillGetRequestSchema>
export type WorkspaceSkillGetResponse = z.output<typeof WorkspaceSkillGetResponseSchema>
export type WorkspaceSkillPublishRequest = z.input<typeof WorkspaceSkillPublishRequestSchema>
export type WorkspaceSkillPublishResponse = z.output<typeof WorkspaceSkillPublishResponseSchema>
export type WorkspaceSkillDeprecationRequest = z.input<
  typeof WorkspaceSkillDeprecationRequestSchema
>
export type WorkspaceSkillRevocationRequest = z.input<typeof WorkspaceSkillRevocationRequestSchema>
export type WorkspaceSkillLifecycleResponse = z.output<typeof WorkspaceSkillLifecycleResponseSchema>
export type WorkspaceAgentProfileListRequest = z.input<
  typeof WorkspaceAgentProfileListRequestSchema
>
export type WorkspaceAgentProfileListResponse = z.output<
  typeof WorkspaceAgentProfileListResponseSchema
>
export type WorkspaceAgentProfileGetRequest = z.input<typeof WorkspaceAgentProfileGetRequestSchema>
export type WorkspaceAgentProfileGetResponse = z.output<
  typeof WorkspaceAgentProfileGetResponseSchema
>
export type WorkspaceAgentProfilePublishRequest = z.input<
  typeof WorkspaceAgentProfilePublishRequestSchema
>
export type WorkspaceAgentProfilePublishResponse = z.output<
  typeof WorkspaceAgentProfilePublishResponseSchema
>
export type WorkspaceAgentProfileDeprecationRequest = z.input<
  typeof WorkspaceAgentProfileDeprecationRequestSchema
>
export type WorkspaceAgentProfileRevocationRequest = z.input<
  typeof WorkspaceAgentProfileRevocationRequestSchema
>
export type WorkspaceAgentProfileLifecycleResponse = z.output<
  typeof WorkspaceAgentProfileLifecycleResponseSchema
>

/** Scopes required by the workspace catalog routes; credentials are deny-by-default. */
export const WorkspaceCatalogScopes = Object.freeze({
  read: 'catalog:read',
  publish: 'catalog:publish',
  manage: 'catalog:manage',
} as const)

const fixtureContext = {
  caller: { servicePrincipalId: 'svc_agent-hq' },
  contractVersion: { major: 3, minor: 0 },
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
} as const
const fixtureCommand = {
  ...fixtureContext,
  commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
  payloadHash: 'f'.repeat(64),
  issuedAt: '2026-10-06T12:00:00.000Z',
} as const
const fixtureResponse = {
  contractVersion: fixtureContext.contractVersion,
  requestId: fixtureContext.requestId,
  correlation: fixtureContext.correlation,
} as const
const fixtureSkill = {
  skillId: 'skl_01JABCDEF0123456789ABCDEFG',
  displayName: 'Release notes',
  ownership: { scope: 'workspace', workspaceId: fixtureContext.workspaceId },
  readOnly: false,
  createdAt: '2026-10-06T12:00:00.000Z',
} as const
const fixtureSkillManifest = {
  schemaVersion: 1,
  semanticVersion: '1.0.0',
  requiredCapabilities: [],
  requiredTools: [],
  dependencies: [],
  conflicts: [],
  supersedes: [],
  compatibleProfileSchemaVersions: [1],
  compatibleContractMajorVersions: [3],
}
const fixtureSkillContent = { instructions: 'Summarize merged changes.', artifactRefs: [] }
const fixtureSkillVersion = {
  skillId: fixtureSkill.skillId,
  skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
  semanticVersion: '1.0.0',
  revision: 2,
  lifecycle: 'published',
  contentDigest: `sha256:${'c'.repeat(64)}`,
  createdAt: '2026-10-06T12:00:00.000Z',
  lifecycleMetadata: { publishedAt: '2026-10-06T12:00:00.000Z' },
} as const
const fixtureProfile = {
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  displayName: 'Release manager',
  ownership: { scope: 'workspace', workspaceId: fixtureContext.workspaceId },
  readOnly: false,
  createdAt: '2026-10-06T12:00:00.000Z',
} as const
const fixtureProfileVersion = {
  profileId: fixtureProfile.profileId,
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  version: 1,
  revision: 2,
  schemaVersion: 1,
  lifecycle: 'published',
  contentDigest: `sha256:${'d'.repeat(64)}`,
  createdAt: '2026-10-06T12:00:00.000Z',
  lifecycleMetadata: { publishedAt: '2026-10-06T12:00:00.000Z' },
} as const

/** Deterministic provider/consumer fixtures; executable content is illustrative only. */
export const WorkspaceCatalogFixtures = Object.freeze({
  skillList: {
    request: {
      ...fixtureContext,
      operation: 'catalog.skill.list',
      requestedAt: '2026-10-06T12:00:00.000Z',
      parameters: { limit: 50 },
    } satisfies WorkspaceSkillListRequest,
    response: {
      ...fixtureResponse,
      data: { items: [{ skill: fixtureSkill, latestVersion: fixtureSkillVersion }], page: {} },
    } satisfies z.input<typeof WorkspaceSkillListResponseSchema>,
  },
  skillGet: {
    request: {
      ...fixtureContext,
      operation: 'catalog.skill.get',
      requestedAt: '2026-10-06T12:00:00.000Z',
      parameters: { skillId: fixtureSkill.skillId },
    } satisfies WorkspaceSkillGetRequest,
    response: {
      ...fixtureResponse,
      data: {
        skill: fixtureSkill,
        versions: [fixtureSkillVersion],
        version: {
          ...fixtureSkillVersion,
          manifest: { ...fixtureSkillManifest, contentDigest: fixtureSkillVersion.contentDigest },
          content: fixtureSkillContent,
        },
      },
    } satisfies z.input<typeof WorkspaceSkillGetResponseSchema>,
  },
  skillPublish: {
    request: {
      ...fixtureCommand,
      idempotencyKey: 'catalog-skill-publish-01JABCDEF0123456789ABCDEFG',
      operation: 'catalog.skill.publish',
      payload: {
        skillId: fixtureSkill.skillId,
        skillVersionId: fixtureSkillVersion.skillVersionId,
        displayName: fixtureSkill.displayName,
        manifest: fixtureSkillManifest,
        content: fixtureSkillContent,
      },
    } satisfies WorkspaceSkillPublishRequest,
  },
  skillDeprecation: {
    request: {
      ...fixtureCommand,
      idempotencyKey: 'catalog-skill-deprecate-01JABCDEF0123456789ABCDEFG',
      operation: 'catalog.skill.deprecate',
      payload: {
        skillId: fixtureSkill.skillId,
        skillVersionId: fixtureSkillVersion.skillVersionId,
        expectedRevision: 2,
        reason: 'Replaced by 2.0.0',
      },
    } satisfies WorkspaceSkillDeprecationRequest,
    response: {
      ...fixtureResponse,
      data: {
        skill: fixtureSkill,
        changed: [
          {
            ...fixtureSkillVersion,
            revision: 3,
            lifecycle: 'deprecated',
            lifecycleMetadata: {
              publishedAt: '2026-10-06T12:00:00.000Z',
              deprecatedAt: '2026-10-06T13:00:00.000Z',
              reason: 'Replaced by 2.0.0',
            },
          },
        ],
      },
    } satisfies z.input<typeof WorkspaceSkillLifecycleResponseSchema>,
  },
  profileList: {
    request: {
      ...fixtureContext,
      operation: 'catalog.profile.list',
      requestedAt: '2026-10-06T12:00:00.000Z',
      parameters: {},
    } satisfies WorkspaceAgentProfileListRequest,
    response: {
      ...fixtureResponse,
      data: {
        items: [{ profile: fixtureProfile, latestVersion: fixtureProfileVersion }],
        page: {},
      },
    } satisfies z.input<typeof WorkspaceAgentProfileListResponseSchema>,
  },
  profileGet: {
    request: {
      ...fixtureContext,
      operation: 'catalog.profile.get',
      requestedAt: '2026-10-06T12:00:00.000Z',
      parameters: {
        profileId: fixtureProfile.profileId,
        profileVersionId: fixtureProfileVersion.profileVersionId,
      },
    } satisfies WorkspaceAgentProfileGetRequest,
  },
  profileRevocation: {
    request: {
      ...fixtureCommand,
      idempotencyKey: 'catalog-profile-revoke-01JABCDEF0123456789ABCDEFG',
      operation: 'catalog.profile.revoke',
      payload: { profileId: fixtureProfile.profileId, reason: 'Retired by the workspace' },
    } satisfies WorkspaceAgentProfileRevocationRequest,
  },
})
