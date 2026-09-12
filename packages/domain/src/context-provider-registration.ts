import { z } from 'zod'
import { ContextProviderReadModelSchema } from '@control-plane/contracts'
import { ContextCommandGrantSchema } from './context-command-grant.js'

export const ContextProviderRegistrationSchema = z
  .object({
    version: z.number().int().positive(),
    readModel: ContextProviderReadModelSchema,
    providerRef: ContextCommandGrantSchema.shape.providerRef,
    mappedProjectRef: ContextCommandGrantSchema.shape.mappedProjectRef,
    authorizationRef: ContextCommandGrantSchema.shape.authorizationRef,
    maximumOutputBytes: z.number().int().positive().max(262144).optional(),
    expectedCorpusRevision: z.string().min(1).max(256).optional(),
    expectedMemoryRevision: z.string().min(1).max(256).optional(),
    expectedEmbeddingVersion: z.string().min(1).max(128).optional(),
    expectedRetrievalVersion: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (record) => record.readModel.definition.providerId === record.readModel.connection.providerId,
    'Provider identity mismatch'
  )
export type ContextProviderRegistration = z.output<typeof ContextProviderRegistrationSchema>

export function contextProviderRegistrationIdentity(record: ContextProviderRegistration): string {
  const connection = record.readModel.connection
  return JSON.stringify([
    connection.workspaceId,
    connection.connectionId,
    connection.providerId,
    connection.principalRef,
    connection.scopeDigest,
    record.providerRef,
    record.mappedProjectRef,
    record.authorizationRef,
  ])
}

export interface ContextProviderRegistrationRepository {
  save(expectedVersion: number, record: ContextProviderRegistration): Promise<boolean>
  list(scope: { workspaceId: string; principalRef: string }): Promise<ContextProviderRegistration[]>
}
