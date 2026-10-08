import { z } from 'zod'
import {
  ReadRequestEnvelopeSchema,
  StateChangingCommandEnvelopeSchema,
  SuccessResponseEnvelopeSchema,
} from './envelopes.js'
import { ServiceCallerAssertionSchema } from './authentication.js'
import { IdentifierSchemas } from './identifiers.js'

const Ref = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const ModelFundingSourceSchema = z.enum(['hq_managed', 'external_subscription', 'byo_api'])
export const ModelConnectionRefSchema = z.string().regex(/^mconn_[a-f0-9]{32}$/)
export const ModelSelectionRefSchema = z.string().regex(/^msel_[a-f0-9]{32}$/)
const Auth = z.enum(['api_key', 'provider_subscription', 'local_runtime'])
export const ModelExecutionTargetSchema = z.strictObject({
  location: z.enum(['local_device', 'remote_host', 'agent_hq_cloud']),
  harness: z.enum(['pi', 'pi_durable', 'cloudflare_agents', 'acp']),
  harnessVersion: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  providerBinding: z.enum([
    'pi_model_runtime',
    'pi_durable_models',
    'cloudflare_binding',
    'native_harness',
  ]),
})
const ConnectionIdentity = {
  credentialRef: IdentifierSchemas.credentialId,
  credentialRevision: Revision,
  provider: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9.-]*$/),
  accountRef: Ref,
  authKind: Auth,
  fundingSource: ModelFundingSourceSchema,
}
function fundingMatches(value: { authKind: string; fundingSource: string }) {
  return value.authKind === 'api_key'
    ? value.fundingSource === 'byo_api' || value.fundingSource === 'hq_managed'
    : value.fundingSource === 'external_subscription'
}
function bindingMatches(value: z.output<typeof ModelExecutionTargetSchema>) {
  return (
    value.providerBinding ===
    {
      pi: 'pi_model_runtime',
      pi_durable: 'pi_durable_models',
      cloudflare_agents: 'cloudflare_binding',
      acp: 'native_harness',
    }[value.harness]
  )
}
export const ModelConnectionSchema = z
  .strictObject({
    connectionRef: ModelConnectionRefSchema,
    revision: Revision,
    workspaceId: IdentifierSchemas.workspaceId,
    ownerRef: Ref,
    ...ConnectionIdentity,
    status: z.enum(['active', 'revoked']),
    models: z
      .array(Ref)
      .min(1)
      .max(256)
      .refine((values) => new Set(values).size === values.length),
    workspaceGrant: z.strictObject({
      grantRef: Ref,
      revision: Revision,
      status: z.enum(['active', 'revoked']),
      expiresAt: z.iso.datetime(),
    }),
  })
  .refine(fundingMatches, { message: 'Authentication and funding provenance must agree' })

/** Immutable, non-secret admission evidence. Never persist lease capabilities or provider objects. */
export const RuntimeProviderSelectionSchema = z
  .strictObject({
    schemaVersion: z.literal('model-selection/v1'),
    selectionRef: ModelSelectionRefSchema,
    selectionRevision: Revision,
    workspaceId: IdentifierSchemas.workspaceId,
    connectionRef: ModelConnectionRefSchema,
    connectionRevision: Revision,
    ...ConnectionIdentity,
    providerModel: Ref,
    ...ModelExecutionTargetSchema.shape,
    workspaceGrant: z.strictObject({ grantRef: Ref, revision: Revision }),
    configurationRevision: Revision,
  })
  .refine(fundingMatches, { message: 'Authentication and funding provenance must agree' })
  .refine(bindingMatches, { message: 'Harness requires its supported provider binding' })

export const ModelChoiceSchema = z.strictObject({
  connectionRef: ModelConnectionRefSchema,
  providerModel: Ref,
})
export const WorkspaceModelDefaultsSchema = z.strictObject({
  workspaceId: IdentifierSchemas.workspaceId,
  revision: Revision,
  lead: ModelChoiceSchema.optional(),
  child: ModelChoiceSchema.optional(),
  direct: ModelChoiceSchema.optional(),
})
export const ModelReadinessReasonSchema = z.enum([
  'READY',
  'CONNECTION_MISSING',
  'CONNECTION_REVOKED',
  'CREDENTIAL_MISSING',
  'CREDENTIAL_EXPIRED',
  'CREDENTIAL_REVOKED',
  'CREDENTIAL_REVISION_CHANGED',
  'WORKSPACE_GRANT_EXPIRED',
  'WORKSPACE_GRANT_REVOKED',
  'SELECTION_CHANGED',
  'MODEL_UNAVAILABLE',
  'QUOTA_EXHAUSTED',
  'INCOMPATIBLE_HARNESS',
  'INCOMPATIBLE_LOCATION',
  'AUTH_MODE_UNSUPPORTED',
  'PROVIDER_POLICY_DENIED',
  'READINESS_UNAVAILABLE',
])
export type ModelConnection = z.output<typeof ModelConnectionSchema>
export type RuntimeProviderSelection = z.output<typeof RuntimeProviderSelectionSchema>
export type ModelExecutionTarget = z.output<typeof ModelExecutionTargetSchema>
export type ModelChoice = z.output<typeof ModelChoiceSchema>
export type WorkspaceModelDefaults = z.output<typeof WorkspaceModelDefaultsSchema>
export type ModelReadinessReason = z.output<typeof ModelReadinessReasonSchema>

const Read = ReadRequestEnvelopeSchema.omit({ projectId: true }).extend({
  caller: ServiceCallerAssertionSchema,
})
const Command = StateChangingCommandEnvelopeSchema.omit({ projectId: true }).extend({
  caller: ServiceCallerAssertionSchema,
})
export const ModelConnectionListRequestSchema = Read.extend({
  operation: z.literal('model-connections.list'),
  parameters: z.strictObject({ target: ModelExecutionTargetSchema }),
}).strict()
export const ModelDefaultsGetRequestSchema = Read.extend({
  operation: z.literal('model-defaults.get'),
  parameters: z.strictObject({}),
}).strict()
export const ModelDefaultsSetRequestSchema = Command.extend({
  operation: z.literal('model-defaults.set'),
  payload: z.strictObject({
    expectedRevision: z.number().int().nonnegative(),
    lead: ModelChoiceSchema.optional(),
    child: ModelChoiceSchema.optional(),
    direct: ModelChoiceSchema.optional(),
  }),
}).strict()
export const ModelSelectionResolveRequestSchema = Read.extend({
  operation: z.literal('model-selection.resolve'),
  parameters: z.strictObject({
    role: z.enum(['lead', 'child', 'direct']),
    target: ModelExecutionTargetSchema,
    override: ModelChoiceSchema.optional(),
  }),
}).strict()
export const ModelConnectionListResponseSchema = SuccessResponseEnvelopeSchema.extend({
  data: z.strictObject({
    connections: z
      .array(
        z.strictObject({
          connection: ModelConnectionSchema,
          models: z
            .array(
              z.strictObject({
                providerModel: ModelChoiceSchema.shape.providerModel,
                readiness: z.strictObject({
                  ready: z.boolean(),
                  reasonCode: ModelReadinessReasonSchema,
                }),
              })
            )
            .max(256),
        })
      )
      .max(128),
  }),
}).strict()
export const ModelDefaultsResponseSchema = SuccessResponseEnvelopeSchema.extend({
  data: z.strictObject({ defaults: WorkspaceModelDefaultsSchema.nullable() }),
}).strict()
export const ModelSelectionResponseSchema = SuccessResponseEnvelopeSchema.extend({
  data: z.strictObject({ selection: RuntimeProviderSelectionSchema }),
}).strict()

export const ModelConnectionCreateRequestSchema = Command.extend({
  operation: z.literal('model-connections.create'),
  payload: z.strictObject({
    credentialRef: ModelConnectionSchema.shape.credentialRef,
    credentialRevision: ModelConnectionSchema.shape.credentialRevision,
  }),
}).strict()
export const ModelConnectionRevokeRequestSchema = Command.extend({
  operation: z.literal('model-connections.revoke'),
  payload: z.strictObject({
    connectionRef: ModelChoiceSchema.shape.connectionRef,
    expectedRevision: z.number().int().positive(),
  }),
}).strict()
export const ModelConnectionResponseSchema = SuccessResponseEnvelopeSchema.extend({
  data: z.strictObject({ connection: ModelConnectionSchema }),
}).strict()

export type ModelConnectionListRequest = z.output<typeof ModelConnectionListRequestSchema>

export type ModelConnectionListResponse = z.output<typeof ModelConnectionListResponseSchema>

export type ModelDefaultsGetRequest = z.output<typeof ModelDefaultsGetRequestSchema>

export type ModelDefaultsSetRequest = z.output<typeof ModelDefaultsSetRequestSchema>

export type ModelSelectionResolveRequest = z.output<typeof ModelSelectionResolveRequestSchema>

export type ModelDefaultsResponse = z.output<typeof ModelDefaultsResponseSchema>

export type ModelSelectionResponse = z.output<typeof ModelSelectionResponseSchema>

export type ModelConnectionCreateRequest = z.output<typeof ModelConnectionCreateRequestSchema>

export type ModelConnectionRevokeRequest = z.output<typeof ModelConnectionRevokeRequestSchema>

export type ModelConnectionResponse = z.output<typeof ModelConnectionResponseSchema>
