import { z } from 'zod'
import {
  ContextCommandGrantSchema,
  type ContextCommandGrantRepository,
} from './context-command-grant.js'
import {
  ContextProviderRegistrationSchema,
  type ContextProviderRegistrationRepository,
} from './context-provider-registration.js'

export const ContextProviderAdministrationRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('grant'), grant: ContextCommandGrantSchema }).strict(),
  z
    .object({
      operation: z.literal('register'),
      expectedVersion: z.number().int().nonnegative(),
      registration: ContextProviderRegistrationSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('revoke'),
      workspaceId: ContextCommandGrantSchema.shape.workspaceId,
      authorizationRef: ContextCommandGrantSchema.shape.authorizationRef,
    })
    .strict(),
])

/** Operator-only port. The host must establish authority before invoking this service. */
export class ContextProviderAdministration {
  constructor(
    readonly grants: ContextCommandGrantRepository,
    readonly registrations: ContextProviderRegistrationRepository,
    readonly now = () => new Date()
  ) {}

  async apply(input: unknown): Promise<void> {
    const request = ContextProviderAdministrationRequestSchema.parse(input)
    if (request.operation === 'revoke') {
      await this.grants.revoke(request.workspaceId, request.authorizationRef)
      return
    }
    if (request.operation === 'grant') {
      const grant = request.grant
      const now = this.now().getTime()
      if (
        grant.status !== 'active' ||
        !Number.isFinite(now) ||
        now < Date.parse(grant.issuedAt) ||
        now >= Date.parse(grant.expiresAt)
      )
        throw new Error('CONTEXT_ADMIN_GRANT_INVALID')
      const current = await this.grants.get(grant.workspaceId, grant.authorizationRef)
      if (current) {
        if (JSON.stringify(ContextCommandGrantSchema.parse(current)) !== JSON.stringify(grant))
          throw new Error('CONTEXT_ADMIN_GRANT_CONFLICT')
        return
      }
      await this.grants.create(grant)
      return
    }
    const registration = request.registration
    const connection = registration.readModel.connection
    const raw = await this.grants.get(connection.workspaceId, registration.authorizationRef)
    const parsed = ContextCommandGrantSchema.safeParse(raw)
    if (!parsed.success) throw new Error('CONTEXT_ADMIN_GRANT_REQUIRED')
    const grant = parsed.data
    const now = this.now().getTime()
    if (
      grant.workspaceId !== connection.workspaceId ||
      grant.authorizationRef !== registration.authorizationRef ||
      grant.providerRef !== registration.providerRef ||
      grant.principalRef !== connection.principalRef ||
      grant.scopeDigest !== connection.scopeDigest ||
      grant.mappedProjectRef !== registration.mappedProjectRef ||
      (connection.state === 'revoked'
        ? grant.status !== 'revoked'
        : grant.status !== 'active' ||
          !Number.isFinite(now) ||
          now < Date.parse(grant.issuedAt) ||
          now >= Date.parse(grant.expiresAt))
    )
      throw new Error('CONTEXT_ADMIN_GRANT_MISMATCH')
    if (!(await this.registrations.save(request.expectedVersion, registration)))
      throw new Error('CONTEXT_ADMIN_REGISTRATION_CONFLICT')
  }
}
