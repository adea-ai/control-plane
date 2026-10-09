import { z } from 'zod'
import { IdentifierSchemas } from './identifiers.js'
import { ReadRequestEnvelopeSchema, SuccessResponseEnvelopeSchema } from './envelopes.js'
import { ServiceCallerAssertionSchema } from './authentication.js'
import { ModelSelectionRefSchema } from './model-connections.js'

/** A lock-safe current delivery check. It grants no admission, spending or credential authority. */
export const PiLeadPublicationSchema = z.strictObject({
  schemaVersion: z.literal('pi-lead-publication/v1'),
  workspaceId: IdentifierSchemas.workspaceId,
  intentId: z.uuid(),
  dispatchId: z.string().regex(/^dispatch_[a-f0-9]{32}$/),
  preparationRef: z.string().regex(/^prep_[a-f0-9]{32}$/),
  executionId: IdentifierSchemas.executionId,
  attemptId: IdentifierSchemas.attemptId,
  runtimeSessionId: IdentifierSchemas.externalSessionId,
  selectionRef: ModelSelectionRefSchema,
  selectionRevision: z.number().int().positive(),
  canonicalActorPrincipalId: z
    .string()
    .regex(/^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  authorityRevision: z.number().int().positive(),
  resultContentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
})
export const PiLeadPublicationRequestSchema = ReadRequestEnvelopeSchema.omit({ projectId: true })
  .extend({
    caller: ServiceCallerAssertionSchema.strict(),
    operation: z.literal('pi-durable.lead.publication.current'),
    parameters: PiLeadPublicationSchema.pick({ dispatchId: true, preparationRef: true }),
  })
  .strict()
export const PiLeadPublicationResponseSchema = SuccessResponseEnvelopeSchema.extend({
  data: z.strictObject({ publication: PiLeadPublicationSchema }),
}).strict()
export type PiLeadPublication = z.output<typeof PiLeadPublicationSchema>
export type PiLeadPublicationRequest = z.output<typeof PiLeadPublicationRequestSchema>
export type PiLeadPublicationResponse = z.output<typeof PiLeadPublicationResponseSchema>
