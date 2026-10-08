import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { CredentialVaultError, type CredentialVault } from '@control-plane/credential-vault'
import { ModelConnectionSchema, type ModelConnection } from './selection.js'
import { ModelSelectionError, type ModelSelectionRepository } from './selection-service.js'

/** Current provider-account and workspace authority. Signed service scope alone cannot invent it. */
export interface ModelConnectionGrantAuthority {
  authorize(input: {
    workspaceId: string
    principalRef: string
    credentialRef: string
    credentialRevision: number
  }): Promise<
    Pick<ModelConnection, 'accountRef' | 'authKind' | 'fundingSource' | 'models' | 'workspaceGrant'>
  >
}
/** Reuses write-only credential administration. Caller supplies an existing opaque ID only. */
export class ModelConnectionAdministration {
  constructor(
    readonly options: {
      repository: ModelSelectionRepository
      vault: Pick<CredentialVault, 'metadata'>
      grants: ModelConnectionGrantAuthority
    }
  ) {}
  async connect(input: {
    workspaceId: string
    principalRef: string
    credentialRef: string
    credentialRevision: number
    connectionRef?: string
  }): Promise<ModelConnection> {
    try {
      const metadata = await this.options.vault.metadata(input.credentialRef, input.workspaceId)
      if (
        metadata.workspaceId !== input.workspaceId ||
        metadata.credentialId !== input.credentialRef
      )
        throw new ModelSelectionError('CREDENTIAL_MISSING')
      if (metadata.status !== 'active')
        throw new ModelSelectionError(
          metadata.status === 'revoked'
            ? 'CREDENTIAL_REVOKED'
            : metadata.status === 'expired'
              ? 'CREDENTIAL_EXPIRED'
              : 'CREDENTIAL_MISSING'
        )
      if (metadata.revision !== input.credentialRevision)
        throw new ModelSelectionError('CREDENTIAL_REVISION_CHANGED')
      const authority = await this.options.grants.authorize(input)
      const connection = ModelConnectionSchema.parse({
        ...authority,
        connectionRef: input.connectionRef ?? `mconn_${randomBytes(16).toString('hex')}`,
        revision: 1,
        workspaceId: metadata.workspaceId,
        ownerRef: input.principalRef,
        credentialRef: metadata.credentialId,
        credentialRevision: metadata.revision,
        provider: metadata.provider,
        status: 'active',
      })
      const existing = await this.options.repository.getConnection(
        input.workspaceId,
        connection.connectionRef
      )
      if (existing) {
        if (
          existing.ownerRef !== input.principalRef ||
          existing.credentialRef !== input.credentialRef ||
          existing.credentialRevision !== input.credentialRevision ||
          existing.status === 'revoked'
        )
          throw new ModelSelectionError('SELECTION_CHANGED')
        return existing
      }
      if (!(await this.options.repository.saveConnection(0, connection)))
        throw new ModelSelectionError('SELECTION_CHANGED')
      return connection
    } catch (error) {
      if (error instanceof ModelSelectionError) throw error
      if (error instanceof CredentialVaultError) {
        if (
          error.code === 'CREDENTIAL_MISSING' ||
          error.code === 'CREDENTIAL_EXPIRED' ||
          error.code === 'CREDENTIAL_REVOKED'
        )
          throw new ModelSelectionError(error.code)
        if (error.code === 'CREDENTIAL_REVISION_CONFLICT')
          throw new ModelSelectionError('CREDENTIAL_REVISION_CHANGED')
        if (error.code === 'POLICY_DENIED') throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
      }
      throw new ModelSelectionError('READINESS_UNAVAILABLE')
    }
  }
  async revoke(input: {
    workspaceId: string
    principalRef: string
    connectionRef: string
    expectedRevision: number
  }): Promise<ModelConnection> {
    const current = await this.options.repository.getConnection(
      input.workspaceId,
      input.connectionRef
    )
    if (!current) throw new ModelSelectionError('CONNECTION_MISSING')
    if (current.ownerRef !== input.principalRef)
      throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
    if (current.status === 'revoked') return current
    if (current.revision !== input.expectedRevision)
      throw new ModelSelectionError('SELECTION_CHANGED')
    const next = ModelConnectionSchema.parse({
      ...current,
      revision: current.revision + 1,
      status: 'revoked',
      workspaceGrant: {
        ...current.workspaceGrant,
        revision: current.workspaceGrant.revision + 1,
        status: 'revoked',
      },
    })
    if (!(await this.options.repository.saveConnection(current.revision, next)))
      throw new ModelSelectionError('SELECTION_CHANGED')
    return next
  }
}

export const ModelConnectInputSchema = z.strictObject({
  credentialRef: ModelConnectionSchema.shape.credentialRef,
  credentialRevision: ModelConnectionSchema.shape.credentialRevision,
})
