import { createHash } from 'node:crypto'
import {
  PiLeadPublicationSchema,
  PiLeadPublicationRequestSchema,
  PiLeadPublicationResponseSchema,
  canonicalJsonStringify,
  type PiLeadPublication,
  type ServicePrincipal,
} from '@control-plane/contracts'
import { RuntimeExecutionStatusSchema } from '@control-plane/runtime-sdk'

export const PI_LEAD_PUBLICATION_SERVICE = Symbol('PI_LEAD_PUBLICATION_SERVICE')
type Retained = Omit<PiLeadPublication, 'resultContentDigest' | 'expiresAt' | 'authorityRevision'>
export interface PiLeadPublicationPorts {
  /** Metadata-only canonical receipt/preparation/journal read; never calls product, starts or sends. */
  readRetained(input: { workspaceId: string; dispatchId: string; preparationRef: string }): Promise<
    | {
        binding: Retained
        status: unknown
      }
    | undefined
  >
  /** Mandatory lock-safe current CP principal/grant/revocation/payer/actor/attempt read.
   * Must NOT call Adea's product reader: its independent current audience locks are already held.
   * Admission, funding readiness and completed inference do not imply permission to publish.
   */
  assertCurrent(
    binding: Retained,
    principal: ServicePrincipal
  ): Promise<{
    authorityRevision: number
    expiresAt: string
  }>
  now?: () => string
}
export class PiLeadPublicationService {
  constructor(private readonly ports?: PiLeadPublicationPorts) {}
  async current(input: unknown, principal: ServicePrincipal) {
    const request = PiLeadPublicationRequestSchema.parse(input)
    if (!this.ports || request.caller.servicePrincipalId !== principal.principalId)
      throw new Error('PI_LEAD_PUBLICATION_UNAVAILABLE')
    const query = { workspaceId: request.workspaceId, ...request.parameters }
    const first = await this.ports.readRetained(query)
    if (!first) throw new Error('PI_LEAD_PUBLICATION_UNAVAILABLE')
    const status = RuntimeExecutionStatusSchema.parse(first.status)
    const output = status.result?.output
    if (
      first.binding.workspaceId !== query.workspaceId ||
      first.binding.dispatchId !== query.dispatchId ||
      first.binding.preparationRef !== query.preparationRef ||
      status.handle.externalSessionId !== first.binding.runtimeSessionId ||
      status.handle.attemptId !== first.binding.attemptId ||
      status.state !== 'completed' ||
      status.result?.outcome !== 'completed' ||
      !output ||
      typeof output !== 'object' ||
      Array.isArray(output) ||
      typeof output['text'] !== 'string'
    )
      throw new Error('PI_LEAD_PUBLICATION_UNAVAILABLE')
    const digest = `sha256:${createHash('sha256').update(output['text'], 'utf8').digest('hex')}`
    const second = await this.ports.readRetained(query)
    const pin = (value: NonNullable<typeof first>) => {
      const state = RuntimeExecutionStatusSchema.parse(value.status)
      return {
        binding: value.binding,
        handle: state.handle,
        state: state.state,
        result: state.result,
      }
    }
    if (!second || canonicalJsonStringify(pin(second)) !== canonicalJsonStringify(pin(first)))
      throw new Error('PI_LEAD_PUBLICATION_UNAVAILABLE')
    // Final independent CP check follows the last awaited journal read.
    const authority = await this.ports.assertCurrent(structuredClone(first.binding), principal)
    const publication = PiLeadPublicationSchema.parse({
      ...first.binding,
      ...authority,
      resultContentDigest: digest,
    })
    const at = Date.parse(this.ports.now?.() ?? new Date().toISOString())
    if (
      !Number.isFinite(at) ||
      Date.parse(publication.expiresAt) <= at ||
      Date.parse(publication.expiresAt) > at + 30_000
    )
      throw new Error('PI_LEAD_PUBLICATION_UNAVAILABLE')
    return PiLeadPublicationResponseSchema.parse({
      contractVersion: request.contractVersion,
      requestId: request.requestId,
      correlation: request.correlation,
      data: { publication },
    })
  }
}
