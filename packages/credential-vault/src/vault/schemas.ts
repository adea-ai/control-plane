import { IdentifierSchemas } from '@control-plane/contracts'
import { PolicySnapshotReferenceSchema } from '@control-plane/policy'
import { z } from 'zod'

/**
 * Public schemas and types. Moved verbatim from the pre-Effect implementation
 * (see legacy.ts) and re-exported from the package root; signatures unchanged.
 */

const TimestampSchema = z.iso.datetime()
const ReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)

export const CredentialMetadataSchema = z
  .object({
    credentialId: IdentifierSchemas.credentialId,
    workspaceId: IdentifierSchemas.workspaceId,
    connectorRef: ReferenceSchema,
    provider: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9.-]*$/),
    status: z.enum(['active', 'revoked', 'expired']),
    revision: z.number().int().positive(),
    createdAt: TimestampSchema,
    rotatedAt: TimestampSchema.optional(),
    expiresAt: TimestampSchema.optional(),
    revokedAt: TimestampSchema.optional(),
  })
  .strict()

export const CredentialLeaseSchema = z
  .object({
    credentialLeaseId: IdentifierSchemas.credentialLeaseId,
    credentialId: IdentifierSchemas.credentialId,
    credentialRevision: z.number().int().positive(),
    workspaceId: IdentifierSchemas.workspaceId,
    principalRef: ReferenceSchema,
    operation: ReferenceSchema,
    resourceRef: ReferenceSchema,
    capabilityRef: z.string().regex(/^lease:\/\/crl_[0-9A-HJKMNP-TV-Z]{26}\/[a-f0-9]{64}$/),
    status: z.enum(['active', 'consumed', 'expired', 'revoked']),
    policySnapshot: PolicySnapshotReferenceSchema,
    policyDecisionId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    consumedAt: TimestampSchema.optional(),
  })
  .strict()

export type CredentialMetadata = z.output<typeof CredentialMetadataSchema>
export type CredentialLease = z.output<typeof CredentialLeaseSchema>

export { TimestampSchema }
