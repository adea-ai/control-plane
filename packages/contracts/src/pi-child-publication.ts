import { z } from 'zod'
import { IdentifierSchemas } from './identifiers.js'
import { ReadRequestEnvelopeSchema, SuccessResponseEnvelopeSchema } from './envelopes.js'
import { ServiceCallerAssertionSchema } from './authentication.js'
import { PiLeadPublicationSchema } from './pi-lead-publication.js'

/** One short, plain-text conclusion attested by the canonical child result producer.
 * Arbitrary runtime JSON and artifact references are never publication content. */
export const PiChildConclusionSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((text) => text === text.trim() && !/[\p{Cc}\p{Cf}]/u.test(text))
  .refine((text) => new TextEncoder().encode(text).byteLength <= 1024)

/** A retained terminal inbox event plus the exact admitted parent and child attempt. */
export const PiChildPublicationSchema = z
  .strictObject({
    schemaVersion: z.literal('pi-child-publication/v1'),
    workspaceId: IdentifierSchemas.workspaceId,
    intentId: z.uuid(),
    dispatchId: PiLeadPublicationSchema.shape.dispatchId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    runtimeSessionId: IdentifierSchemas.externalSessionId,
    canonicalActorPrincipalId: PiLeadPublicationSchema.shape.canonicalActorPrincipalId,
    delegationId: IdentifierSchemas.delegationId,
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId,
    role: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    state: z.enum(['completed', 'failed', 'cancelled']),
    resultRef: IdentifierSchemas.artifactId.optional(),
    conclusion: PiChildConclusionSchema.optional(),
    failureCode: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
      .optional(),
    occurredAt: z.iso.datetime(),
    authorityRevision: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
  })
  .superRefine((value, context) => {
    if (
      value.state === 'completed'
        ? !value.resultRef || value.failureCode !== undefined
        : value.resultRef !== undefined
    )
      context.addIssue({ code: 'custom', message: 'Terminal outcome is inconsistent' })
    if (value.state !== 'failed' && value.failureCode !== undefined)
      context.addIssue({ code: 'custom', message: 'Failure code requires failure' })
    if (value.state !== 'completed' && value.conclusion !== undefined)
      context.addIssue({ code: 'custom', message: 'Only completion may carry a conclusion' })
  })
export const PiChildPublicationRequestSchema = ReadRequestEnvelopeSchema.omit({ projectId: true })
  .extend({
    caller: ServiceCallerAssertionSchema.strict(),
    operation: z.literal('pi-durable.child.publication.current'),
    parameters: z.strictObject({
      dispatchId: PiLeadPublicationSchema.shape.dispatchId,
      preparationRef: PiLeadPublicationSchema.shape.preparationRef,
      delegationId: IdentifierSchemas.delegationId,
    }),
  })
  .strict()
export const PiChildPublicationResponseSchema = SuccessResponseEnvelopeSchema.extend({
  data: z.strictObject({ publication: PiChildPublicationSchema }),
}).strict()
export type PiChildPublication = z.output<typeof PiChildPublicationSchema>
export type PiChildPublicationRequest = z.output<typeof PiChildPublicationRequestSchema>
export type PiChildPublicationResponse = z.output<typeof PiChildPublicationResponseSchema>
