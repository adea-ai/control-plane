import {
  PiChildPublicationRequestSchema,
  PiChildPublicationResponseSchema,
  PiChildPublicationSchema,
  canonicalJsonStringify,
  type ServicePrincipal,
} from '@control-plane/contracts'
import {
  DelegationEventSchema,
  DelegationRecordSchema,
  type DelegationEvent,
  type DelegationRecord,
} from '@control-plane/orchestration'
import type { PiLeadPublicationPorts } from './publication-current.service.js'

export const PI_CHILD_PUBLICATION_SERVICE = Symbol('PI_CHILD_PUBLICATION_SERVICE')
type Binding = NonNullable<Awaited<ReturnType<PiLeadPublicationPorts['readRetained']>>>['binding']
export interface PiChildPublicationPorts {
  /** Metadata-only read of the retained parent receipt. No product callback. */
  readRetained: PiLeadPublicationPorts['readRetained']
  /** Canonical delegation record and independently retained J1 parent inbox. */
  listChildren(parentExecutionId: string): Promise<readonly DelegationRecord[]>
  listParentEvents(parentExecutionId: string): Promise<readonly DelegationEvent[]>
  /** CP-only current principal/grant/revocation check; never calls Adea while it holds locks. */
  assertCurrent: PiLeadPublicationPorts['assertCurrent']
  now?: () => string
}

/** A result reference is evidence of completion, not readable result content or a grant. */
export class PiChildPublicationService {
  constructor(private readonly ports?: PiChildPublicationPorts) {}

  async current(input: unknown, principal: ServicePrincipal) {
    const request = PiChildPublicationRequestSchema.parse(input)
    if (!this.ports || request.caller.servicePrincipalId !== principal.principalId)
      throw new Error('PI_CHILD_PUBLICATION_UNAVAILABLE')
    const query = {
      workspaceId: request.workspaceId,
      dispatchId: request.parameters.dispatchId,
      preparationRef: request.parameters.preparationRef,
    }
    const first = await this.#retained(query, request.parameters.delegationId)
    // An awaited inbox or repository read may race a new attempt or revocation. Re-read exact
    // retained evidence, then perform the independent CP grant check as the final await.
    const second = await this.#retained(query, request.parameters.delegationId)
    if (canonicalJsonStringify(first) !== canonicalJsonStringify(second))
      throw new Error('PI_CHILD_PUBLICATION_UNAVAILABLE')
    const authority = await this.ports.assertCurrent(structuredClone(first.binding), principal)
    const publication = PiChildPublicationSchema.parse({
      schemaVersion: 'pi-child-publication/v1',
      workspaceId: first.binding.workspaceId,
      intentId: first.binding.intentId,
      dispatchId: first.binding.dispatchId,
      executionId: first.binding.executionId,
      attemptId: first.binding.attemptId,
      runtimeSessionId: first.binding.runtimeSessionId,
      canonicalActorPrincipalId: first.binding.canonicalActorPrincipalId,
      delegationId: first.record.delegationId,
      childExecutionId: first.record.childExecutionId,
      childAttemptId: first.record.childAttemptId,
      role: first.record.role,
      state: first.record.state,
      ...(first.record.terminalResultRef ? { resultRef: first.record.terminalResultRef } : {}),
      ...(first.record.terminalConclusion ? { conclusion: first.record.terminalConclusion } : {}),
      ...(first.record.failureCode ? { failureCode: first.record.failureCode } : {}),
      occurredAt: first.event.occurredAt,
      authorityRevision: authority.authorityRevision,
      expiresAt: authority.expiresAt,
    })
    const at = Date.parse(this.ports.now?.() ?? new Date().toISOString())
    if (
      !Number.isFinite(at) ||
      Date.parse(publication.expiresAt) <= at ||
      Date.parse(publication.expiresAt) > at + 30_000
    )
      throw new Error('PI_CHILD_PUBLICATION_UNAVAILABLE')
    return PiChildPublicationResponseSchema.parse({
      contractVersion: request.contractVersion,
      requestId: request.requestId,
      correlation: request.correlation,
      data: { publication },
    })
  }

  async #retained(
    query: { workspaceId: string; dispatchId: string; preparationRef: string },
    delegationId: string
  ): Promise<{ binding: Binding; record: DelegationRecord; event: DelegationEvent }> {
    if (!this.ports) throw new Error('PI_CHILD_PUBLICATION_UNAVAILABLE')
    const parent = await this.ports.readRetained(query)
    if (
      !parent ||
      parent.binding.workspaceId !== query.workspaceId ||
      parent.binding.dispatchId !== query.dispatchId ||
      parent.binding.preparationRef !== query.preparationRef
    )
      throw new Error('PI_CHILD_PUBLICATION_UNAVAILABLE')
    const records = await this.ports.listChildren(parent.binding.executionId)
    const matchingRecords = records.filter((item) => item.delegationId === delegationId)
    if (matchingRecords.length !== 1) throw new Error('PI_CHILD_PUBLICATION_UNAVAILABLE')
    const recordRaw = matchingRecords[0]!
    const record = DelegationRecordSchema.parse(recordRaw)
    const terminalPublication = record.terminalPublication
    if (
      record.parentExecutionId !== parent.binding.executionId ||
      record.parentAttemptId !== parent.binding.attemptId ||
      !record.childAttemptId ||
      !['completed', 'failed', 'cancelled'].includes(record.state) ||
      terminalPublication?.status !== 'published' ||
      terminalPublication.idempotencyKey !== `delegation:${delegationId}:terminal`
    )
      throw new Error('PI_CHILD_PUBLICATION_UNAVAILABLE')
    const events = await this.ports.listParentEvents(parent.binding.executionId)
    const matched = events
      .map((candidate) => DelegationEventSchema.parse(candidate))
      .filter(
        (event) =>
          event.delegationId === delegationId &&
          ['delegation.completed', 'delegation.failed', 'delegation.cancelled'].includes(event.type)
      )
    const expectedType = `delegation.${record.state}`
    if (
      matched.length < 1 ||
      matched.some(
        (event) =>
          event.type !== expectedType ||
          event.parentExecutionId !== record.parentExecutionId ||
          event.childExecutionId !== record.childExecutionId ||
          event.details.state !== record.state ||
          event.details.childAttemptId !== record.childAttemptId ||
          event.details.terminalResultRef !== record.terminalResultRef ||
          event.details.conclusion !== record.terminalConclusion ||
          event.details.failureCode !== record.failureCode ||
          event.details.reason !== terminalPublication.reason ||
          event.details.resolution !== terminalPublication.resolution ||
          event.occurredAt !== record.updatedAt ||
          canonicalJsonStringify(event) !== canonicalJsonStringify(matched[0])
      )
    )
      throw new Error('PI_CHILD_PUBLICATION_UNAVAILABLE')
    return { binding: parent.binding, record, event: matched[0]! }
  }
}
