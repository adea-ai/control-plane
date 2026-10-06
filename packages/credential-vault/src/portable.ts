import { CredentialPublicMetadataSchema } from '@control-plane/contracts'
import { z } from 'zod'
import { StoredCredentialSchema, type StoredCredential } from './repository.js'

/**
 * Portable credential metadata for profile export/import. It deliberately omits status, secret
 * revisions and every provider reference: secrets never move between profiles and must be
 * re-entered at the destination through a credential rotation.
 */
export const PortableCredentialMetadataSchema = CredentialPublicMetadataSchema.pick({
  credentialId: true,
  workspaceId: true,
  connectorRef: true,
  provider: true,
  revision: true,
  createdAt: true,
  createdBy: true,
  rotatedAt: true,
  expiresAt: true,
  revokedAt: true,
}).strict()

export type PortableCredentialMetadata = z.output<typeof PortableCredentialMetadataSchema>

export function toPortableCredentialMetadata(input: StoredCredential): PortableCredentialMetadata {
  const { metadata } = StoredCredentialSchema.parse(input)
  return PortableCredentialMetadataSchema.parse({
    credentialId: metadata.credentialId,
    workspaceId: metadata.workspaceId,
    connectorRef: metadata.connectorRef,
    provider: metadata.provider,
    revision: metadata.revision,
    createdAt: metadata.createdAt,
    ...(metadata.createdBy === undefined ? {} : { createdBy: metadata.createdBy }),
    ...(metadata.rotatedAt === undefined ? {} : { rotatedAt: metadata.rotatedAt }),
    ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
    ...(metadata.revokedAt === undefined ? {} : { revokedAt: metadata.revokedAt }),
  })
}

/**
 * Destination state for imported metadata: revoked credentials stay revoked; every other
 * credential waits in `secret_required` until an operator rotates a new secret in.
 */
export function importedCredential(input: unknown): StoredCredential {
  const portable = PortableCredentialMetadataSchema.parse(input)
  return StoredCredentialSchema.parse({
    metadata: {
      ...portable,
      status: portable.revokedAt === undefined ? 'secret_required' : 'revoked',
    },
    secretRevisions: [],
  })
}
