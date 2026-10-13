import { z } from 'zod'
import { PiLeadPublicationSchema } from './pi-lead-publication.js'
import { PiLeadSourceExecutionBindingSchema } from './pi-lead-source-authority.js'

/** Additive metadata-only candidate delivery proof. Host audience and current
 * source CP grants/payer must independently authorize delivery; no output or
 * caller-provided execution authority is accepted by this contract.
 */
export const PiLeadSourcePublicationSchema = z
  .strictObject({
    schemaVersion: z.literal('pi-lead-source-publication/v1'),
    binding: PiLeadSourceExecutionBindingSchema,
    publication: PiLeadPublicationSchema,
  })
  .superRefine(({ binding, publication }, context) => {
    if (
      publication.workspaceId !== binding.authority.source.workspaceId ||
      publication.intentId !== binding.authority.intentId ||
      publication.canonicalActorPrincipalId !== binding.authority.host.canonicalActorPrincipalId ||
      publication.executionId !== binding.executionId ||
      publication.attemptId !== binding.attemptId ||
      publication.runtimeSessionId !== binding.runtimeSessionId ||
      publication.selectionRef !== binding.selectionRef ||
      publication.selectionRevision !== binding.selectionRevision ||
      Date.parse(publication.expiresAt) > Date.parse(binding.intentExpiresAt)
    )
      context.addIssue({ code: 'custom', message: 'Host/source publication binding mismatch' })
  })
export type PiLeadSourcePublication = z.output<typeof PiLeadSourcePublicationSchema>
