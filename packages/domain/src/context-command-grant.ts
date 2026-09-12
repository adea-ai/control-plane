import { z } from 'zod'
import { IdentifierSchemas } from '@control-plane/contracts'
import { ContextCommandRecordSchema, type ContextCommandRecord } from './context-command.js'

export const ContextCommandGrantSchema = z
  .object({
    authorizationRef: z
      .string()
      .min(16)
      .max(128)
      .regex(/^authz:[A-Za-z0-9._:-]+$/),
    workspaceId: IdentifierSchemas.workspaceId,
    nodeId: IdentifierSchemas.runtimeNodeRefId,
    providerRef: z.string().regex(/^pvr_[0-9A-HJKMNP-TV-Z]{26}$/),
    principalRef: z.string().min(1).max(256),
    mappedProjectRef: z.string().min(1).max(1024),
    scopeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    capabilities: z
      .array(z.enum(['boundedRetrieval', 'evidenceSearch', 'memoryRecall']))
      .min(1)
      .max(3),
    maximumTokens: z.number().int().nonnegative(),
    includeEvidence: z.boolean(),
    includeMemory: z.boolean(),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    status: z.enum(['active', 'revoked']),
  })
  .strict()
  .refine(
    (grant) => Date.parse(grant.expiresAt) > Date.parse(grant.issuedAt),
    'Grant expiry must follow issuance'
  )

export type ContextCommandGrant = z.output<typeof ContextCommandGrantSchema>

/** Trusted administrative writes only; no caller-supplied grant is accepted by authorize. */
export interface ContextCommandGrantRepository {
  create(grant: ContextCommandGrant): Promise<void>
  get(workspaceId: string, authorizationRef: string): Promise<ContextCommandGrant | undefined>
  revoke(workspaceId: string, authorizationRef: string): Promise<void>
}

export class ContextCommandGrantAuthority {
  constructor(
    readonly repository: Pick<ContextCommandGrantRepository, 'get'>,
    readonly now = () => new Date()
  ) {}

  async authorize(input: ContextCommandRecord): Promise<void> {
    const command = ContextCommandRecordSchema.parse(input)
    const envelope = command.commandEnvelope
    const raw = await this.repository.get(
      command.scope.workspaceId,
      String(envelope['authorizationRef'])
    )
    const parsed = ContextCommandGrantSchema.safeParse(raw)
    if (!parsed.success) throw new Error('CONTEXT_GRANT_DENIED')
    const grant = parsed.data
    const parameters = (envelope['payload'] as { parameters: Record<string, unknown> }).parameters
    const now = this.now().getTime()
    if (
      grant.status !== 'active' ||
      !Number.isFinite(now) ||
      now < Date.parse(grant.issuedAt) ||
      now >= Date.parse(grant.expiresAt) ||
      Date.parse(command.issuedAt) < Date.parse(grant.issuedAt) ||
      Date.parse(command.expiresAt) > Date.parse(grant.expiresAt) ||
      grant.authorizationRef !== envelope['authorizationRef'] ||
      grant.workspaceId !== command.scope.workspaceId ||
      grant.nodeId !== command.nodeId ||
      grant.providerRef !== command.scope.providerRef ||
      grant.principalRef !== command.scope.principalRef ||
      grant.mappedProjectRef !== parameters['mappedProjectRef'] ||
      grant.scopeDigest !== parameters['scopeDigest'] ||
      !grant.capabilities.some((capability) => capability === parameters['capability']) ||
      typeof parameters['maximumTokens'] !== 'number' ||
      !Number.isSafeInteger(parameters['maximumTokens']) ||
      parameters['maximumTokens'] < 0 ||
      parameters['maximumTokens'] > grant.maximumTokens ||
      typeof parameters['includeEvidence'] !== 'boolean' ||
      typeof parameters['includeMemory'] !== 'boolean' ||
      (parameters['includeEvidence'] && !grant.includeEvidence) ||
      (parameters['includeMemory'] && !grant.includeMemory)
    )
      throw new Error('CONTEXT_GRANT_DENIED')
  }
}
