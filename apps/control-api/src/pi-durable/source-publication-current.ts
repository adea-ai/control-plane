import {
  PiLeadPublicationRequestSchema,
  PiLeadPublicationResponseSchema,
  PiLeadSourceExecutionBindingSchema,
  PiLeadSourcePublicationSchema,
  type PiLeadSourceExecutionBinding,
  type PiLeadPublication,
  type ServicePrincipal,
} from '@control-plane/contracts'
import type { PiLeadPublicationService } from './publication-current.service.js'

/** Candidate metadata-only join, using the existing current publication service.
 * Both ports must be callback-free with respect to Adea's product reader: Adea
 * retains its own independent host audience/source locks during delivery checks.
 * No output, lease, reservation, runtime start, grants or payer is constructed.
 */
export function createSourcePiLeadPublicationReader(options: {
  core: Pick<PiLeadPublicationService, 'current'>
  readBinding(intentId: string): Promise<unknown | undefined>
  /** Hold current canonical CP host-service and source principal/grant/payer
   * authority together through synchronous acceptance. Must not call Adea.
   */
  withCurrentAuthorization<T>(
    input: {
      binding: PiLeadSourceExecutionBinding
      publication: PiLeadPublication
      principal: ServicePrincipal
    },
    accept: () => T
  ): Promise<T>
  now?: () => string
}) {
  if (
    typeof options.core?.current !== 'function' ||
    typeof options.readBinding !== 'function' ||
    typeof options.withCurrentAuthorization !== 'function'
  )
    throw new Error('PI_LEAD_SOURCE_PUBLICATION_REQUIRED')
  const now = options.now ?? (() => new Date().toISOString())
  return {
    async current(input: unknown, principal: ServicePrincipal) {
      const request = PiLeadPublicationRequestSchema.parse(input)
      const first = PiLeadPublicationResponseSchema.parse(
        await options.core.current(request, principal)
      ).data.publication
      if (
        first.workspaceId !== request.workspaceId ||
        first.dispatchId !== request.parameters.dispatchId ||
        first.preparationRef !== request.parameters.preparationRef
      )
        throw new Error('PI_LEAD_SOURCE_PUBLICATION_UNAVAILABLE')
      const rawBinding = await options.readBinding(first.intentId)
      if (!rawBinding) throw new Error('PI_LEAD_SOURCE_PUBLICATION_UNAVAILABLE')
      const binding = PiLeadSourceExecutionBindingSchema.parse(rawBinding)
      // The metadata read can await. Recheck current CP principal/grants/payer
      // after it rather than returning the earlier assertion as current authority.
      const current = PiLeadPublicationResponseSchema.parse(
        await options.core.current(request, principal)
      ).data.publication
      if (
        current.workspaceId !== request.workspaceId ||
        current.dispatchId !== request.parameters.dispatchId ||
        current.preparationRef !== request.parameters.preparationRef
      )
        throw new Error('PI_LEAD_SOURCE_PUBLICATION_UNAVAILABLE')
      return options.withCurrentAuthorization({ binding, publication: current, principal }, () => {
        // The fence can await before invoking acceptance. Recheck the fixed
        // deadline synchronously with construction; no read extends that deadline.
        const expiresAt = new Date(
          Math.min(Date.parse(current.expiresAt), Date.parse(binding.intentExpiresAt))
        ).toISOString()
        const at = Date.parse(now())
        if (
          !Number.isFinite(at) ||
          Date.parse(expiresAt) <= at ||
          Date.parse(expiresAt) > at + 30_000
        )
          throw new Error('PI_LEAD_SOURCE_PUBLICATION_UNAVAILABLE')
        return PiLeadSourcePublicationSchema.parse({
          schemaVersion: 'pi-lead-source-publication/v1',
          binding,
          publication: { ...current, expiresAt },
        })
      })
    },
  }
}
