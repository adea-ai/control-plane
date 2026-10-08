import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const Reference = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const Amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Produced from a trusted recorded spending decision, separately from plan allowances.
 * Neither this schema nor a fundingSource field authenticates a caller-supplied grant.
 */
export const RecordedModelSpendingAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(1),
    authorizationId: Reference,
    evidenceRef: Reference,
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    deploymentId: Reference,
    credentialRef: Reference,
    principalRef: Reference,
    alias: Reference,
    policySnapshotDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    currency: z.literal('USD'),
    fundingSource: z.enum(['hq_managed', 'external_subscription', 'byo_api']),
    maximumMicrounits: Amount,
    maximumTokens: Amount,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
