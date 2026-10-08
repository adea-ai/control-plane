import { z } from 'zod'
import { IdentifierSchemas } from './identifiers.js'
import { ReadRequestEnvelopeSchema, SuccessResponseEnvelopeSchema } from './envelopes.js'
import { ServiceCallerAssertionSchema } from './authentication.js'
import {
  ModelConnectionSchema,
  ModelFundingSourceSchema,
  ModelReadinessReasonSchema,
  ModelSelectionRefSchema,
} from './model-connections.js'

const Ref = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
/** Explicit authenticated payer metadata; account owner/connection administrator is not a payer inference. */
export const ModelFundingOwnerSchema = z.strictObject({
  ownerRef: Ref,
  kind: z.enum(['provider_account', 'workspace_account', 'adea_account']),
  displayName: z.string().min(1).max(128),
  revision: Revision,
  evidenceRef: Ref,
})
const Binding = {
  schemaVersion: z.literal('model-funding-display/v1'),
  workspaceId: IdentifierSchemas.workspaceId,
  executionId: IdentifierSchemas.executionId,
  attemptId: IdentifierSchemas.attemptId,
  selectionRef: ModelSelectionRefSchema,
  selectionRevision: Revision,
}
/** Disclosure only. This response is never a credential, admission or spending capability. */
export const ModelSelectionFundingViewSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...Binding,
    state: z.literal('ready'),
    provider: ModelConnectionSchema.shape.provider,
    providerModel: z.string().min(1).max(256),
    accountRef: ModelConnectionSchema.shape.accountRef,
    authKind: ModelConnectionSchema.shape.authKind,
    fundingSource: ModelFundingSourceSchema,
    fundingOwner: ModelFundingOwnerSchema,
    authorizationRef: Ref,
    authorityRevision: Revision,
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...Binding,
    state: z.literal('blocked'),
    reasonCode: ModelReadinessReasonSchema.exclude(['READY']),
  }),
])
export const ModelSelectionFundingRequestSchema = ReadRequestEnvelopeSchema.omit({
  projectId: true,
})
  .extend({
    caller: ServiceCallerAssertionSchema,
    operation: z.literal('model-selection.funding.get'),
    parameters: z.strictObject({
      executionId: Binding.executionId,
      attemptId: Binding.attemptId,
      selectionRef: Binding.selectionRef,
      selectionRevision: Binding.selectionRevision,
    }),
  })
  .strict()
export const ModelSelectionFundingResponseSchema = SuccessResponseEnvelopeSchema.extend({
  data: z.strictObject({ funding: ModelSelectionFundingViewSchema }),
}).strict()
export type ModelFundingOwner = z.output<typeof ModelFundingOwnerSchema>
export type ModelSelectionFundingView = z.output<typeof ModelSelectionFundingViewSchema>
export type ModelSelectionFundingRequest = z.output<typeof ModelSelectionFundingRequestSchema>
export type ModelSelectionFundingResponse = z.output<typeof ModelSelectionFundingResponseSchema>
