import { z } from 'zod'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  ModelConnectionSchema,
  ModelExecutionTargetSchema,
  type ModelReadinessReason,
} from './selection.js'
import { ModelSelectionError, type ModelQualification } from './selection-service.js'
import type { ModelConnectionGrantAuthority } from './connection-administration.js'

const Ref = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
/** Authenticated current evidence from a host authority, never from an HTTP/model body. */
export const CurrentModelAccountEvidenceSchema = z.strictObject({
  schemaVersion: z.literal('model-account-authority/v1'),
  evidenceRef: Ref,
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  workspaceId: IdentifierSchemas.workspaceId,
  credentialRef: IdentifierSchemas.credentialId,
  credentialRevision: ModelConnectionSchema.shape.credentialRevision,
  provider: ModelConnectionSchema.shape.provider,
  accountRef: ModelConnectionSchema.shape.accountRef,
  authKind: ModelConnectionSchema.shape.authKind,
  fundingSource: ModelConnectionSchema.shape.fundingSource,
  models: ModelConnectionSchema.shape.models,
  workspaceGrant: ModelConnectionSchema.shape.workspaceGrant,
  allowedPrincipalRefs: z.array(Ref).min(1).max(64),
  targets: z.array(ModelExecutionTargetSchema).min(1).max(32),
  entitlement: z.enum(['allowed', 'denied', 'unknown']),
  quota: z.enum(['available', 'exhausted', 'unknown']),
  residencyAllowed: z.boolean(),
})
export type CurrentModelAccountEvidence = z.output<typeof CurrentModelAccountEvidenceSchema>

export interface CurrentModelAccountAuthority {
  /** Perform an authenticated current read on every call. Neither static qualification
   * records nor caller claims implement this contract. Unknown provider state denies.
   * No secret/lease/provider object may be returned. Hosts own provider integration.
   */
  readCurrent(input: {
    schemaVersion: 'model-account-authority/v1'
    workspaceId: string
    credentialRef: string
    credentialRevision: number
    requestedAt: string
  }): Promise<unknown | undefined>
}

/** Implements existing grant/qualification ports without creating entitlement or funds. */
export class CurrentModelAccountAuthorization
  implements ModelQualification, ModelConnectionGrantAuthority
{
  constructor(
    readonly authority: CurrentModelAccountAuthority,
    readonly now = () => new Date().toISOString()
  ) {
    if (typeof authority?.readCurrent !== 'function')
      throw new ModelSelectionError('READINESS_UNAVAILABLE')
  }
  async #read(input: { workspaceId: string; credentialRef: string; credentialRevision: number }) {
    const requestedAt = this.now()
    const requested = Date.parse(requestedAt)
    const parsed = CurrentModelAccountEvidenceSchema.safeParse(
      await this.authority.readCurrent({
        schemaVersion: 'model-account-authority/v1',
        ...input,
        requestedAt,
      })
    )
    const at = Date.parse(this.now())
    if (!parsed.success || !Number.isFinite(requested) || !Number.isFinite(at))
      throw new ModelSelectionError('READINESS_UNAVAILABLE')
    const value = parsed.data
    if (
      value.workspaceId !== input.workspaceId ||
      value.credentialRef !== input.credentialRef ||
      value.credentialRevision !== input.credentialRevision
    )
      throw new ModelSelectionError('SELECTION_CHANGED')
    // A previously stored snapshot cannot masquerade as this boundary's current read.
    if (
      Date.parse(value.observedAt) < requested ||
      Date.parse(value.observedAt) > at ||
      Date.parse(value.expiresAt) <= at
    )
      throw new ModelSelectionError('READINESS_UNAVAILABLE')
    return value
  }
  #reason(value: CurrentModelAccountEvidence): ModelReadinessReason {
    if (!Number.isFinite(Date.parse(this.now()))) return 'READINESS_UNAVAILABLE'
    if (value.workspaceGrant.status !== 'active') return 'WORKSPACE_GRANT_REVOKED'
    if (Date.parse(value.workspaceGrant.expiresAt) <= Date.parse(this.now()))
      return 'WORKSPACE_GRANT_EXPIRED'
    if (value.entitlement === 'denied') return 'PROVIDER_POLICY_DENIED'
    if (value.entitlement !== 'allowed' || value.quota === 'unknown') return 'READINESS_UNAVAILABLE'
    if (value.quota === 'exhausted') return 'QUOTA_EXHAUSTED'
    return value.residencyAllowed ? 'READY' : 'INCOMPATIBLE_LOCATION'
  }
  async authorize(input: Parameters<ModelConnectionGrantAuthority['authorize']>[0]) {
    try {
      const value = await this.#read({
        workspaceId: input.workspaceId,
        credentialRef: input.credentialRef,
        credentialRevision: input.credentialRevision,
      })
      const reason = this.#reason(value)
      if (reason !== 'READY') throw new ModelSelectionError(reason)
      if (!value.allowedPrincipalRefs.includes(input.principalRef))
        throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
      return {
        accountRef: value.accountRef,
        authKind: value.authKind,
        fundingSource: value.fundingSource,
        models: value.models,
        workspaceGrant: value.workspaceGrant,
      }
    } catch (error) {
      if (error instanceof ModelSelectionError) throw error
      throw new ModelSelectionError('READINESS_UNAVAILABLE')
    }
  }
  async evaluate({
    connection,
    providerModel,
    target,
  }: Parameters<ModelQualification['evaluate']>[0]): Promise<ModelReadinessReason> {
    try {
      const value = await this.#read({
        workspaceId: connection.workspaceId,
        credentialRef: connection.credentialRef,
        credentialRevision: connection.credentialRevision,
      })
      if (
        value.provider !== connection.provider ||
        value.accountRef !== connection.accountRef ||
        value.authKind !== connection.authKind ||
        value.fundingSource !== connection.fundingSource ||
        value.workspaceGrant.grantRef !== connection.workspaceGrant.grantRef ||
        value.workspaceGrant.revision !== connection.workspaceGrant.revision
      )
        return 'SELECTION_CHANGED'
      const reason = this.#reason(value)
      if (reason !== 'READY') return reason
      if (!value.allowedPrincipalRefs.includes(connection.ownerRef)) return 'PROVIDER_POLICY_DENIED'
      if (!value.models.includes(providerModel)) return 'MODEL_UNAVAILABLE'
      const harness = value.targets.filter(
        (item) =>
          item.harness === target.harness &&
          item.harnessVersion === target.harnessVersion &&
          item.providerBinding === target.providerBinding
      )
      if (!harness.length) return 'INCOMPATIBLE_HARNESS'
      // Target may also be a full selection snapshot; compare the target projection only.
      const exact = harness.filter((item) => item.location === target.location)
      if (!exact.length) return 'INCOMPATIBLE_LOCATION'
      return exact.length === 1 ? 'READY' : 'READINESS_UNAVAILABLE'
    } catch (error) {
      return error instanceof ModelSelectionError ? error.code : 'READINESS_UNAVAILABLE'
    }
  }
}
