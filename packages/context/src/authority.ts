import {
  ContextAuthoringInputsSchema,
  ContextProviderPolicySchema,
  IdentifierSchemas,
  type ContextProviderPolicy,
} from '@control-plane/contracts'
import {
  ContextCommandGrantSchema,
  type ContextCommandGrant,
  type ContextCommandGrantRepository,
  type ContextProviderRegistration,
  type ContextProviderRegistrationRepository,
} from '@control-plane/domain'
import { z } from 'zod'
import type { ContextAuthoringAuthority } from './index.js'

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const SensitivitySchema = z.enum(['public', 'internal', 'confidential', 'restricted'])
const CapabilitySchema = z.enum(['boundedRetrieval', 'evidenceSearch', 'memoryRecall'])
const unique = <Value>(values: Value[]) => new Set(values).size === values.length

/**
 * Explicitly configured composition policy for {@link GrantsBackedContextAuthoringAuthority}.
 * Every field is required: the authority never applies permissive defaults, and an invalid
 * policy fails construction so misconfiguration cannot degrade into open authoring.
 */
export const ContextAuthoringPolicySchema = z.strictObject({
  /** Sensitivities the composition may include in authored context packages. */
  allowedSensitivities: z.array(SensitivitySchema).min(1).refine(unique),
  /**
   * Ordered capability allow-list. The requested provider capability is the first entry
   * that the current grant carries and the registration actually advertises.
   */
  allowedCapabilities: z.array(CapabilitySchema).min(1).max(3).refine(unique),
  /** Execution location requested from providers; must be offered by the registration. */
  executionLocation: z.enum(['cloud', 'runtime_node']),
  /**
   * Artifact IDs authorable into context packages. Artifact lifecycle evidence is read from
   * the composition's artifact repository; anything not listed here is denied outright.
   */
  allowedArtifactIds: z.array(IdentifierSchemas.artifactId).refine(unique),
  permissions: z.array(z.string().min(1).max(256)).refine(unique),
  /** Budget ceilings; the authoring service intersects them with the caller's request. */
  maximumBytes: z.number().int().positive(),
  maximumTokens: z.number().int().positive(),
  /** Context TTL ceiling. Policy expiry is the earlier of grant expiry and now plus this TTL. */
  maximumContextTtlSeconds: z.number().int().positive(),
  /** Provider resolution policy handed to the resolver with the derived provider request. */
  providerPolicy: ContextProviderPolicySchema,
})

export type ContextAuthoringPolicy = z.output<typeof ContextAuthoringPolicySchema>

/**
 * Structural view of the artifact repository the composition already owns (the ObjectStore
 * port). Authorization only needs descriptors, never artifact bytes, and no new store is
 * invented here: artifacts are read under a key equal to their artifact ID.
 */
export interface ContextAuthoringArtifactStore {
  head(key: string): Promise<{
    readonly key: string
    readonly size: number
    readonly contentType?: string
    readonly sha256: `sha256:${string}`
    readonly metadata: Readonly<Record<string, string>>
  }>
}

/**
 * Re-derived from the same contracts inputs as the authoring service request so the
 * authority never trusts an unparsed caller payload, without importing package internals.
 */
const AuthorityRequestSchema = ContextAuthoringInputsSchema.extend({
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId,
  projectStateRevision: z.number().int().nonnegative(),
})

const ArtifactRefSchema = z.object({
  artifactId: IdentifierSchemas.artifactId,
  contentDigest: DigestSchema,
  mediaType: z.string().min(1).max(256),
  sizeBytes: z.number().int().nonnegative(),
  sensitivity: SensitivitySchema,
})

const AuthoringDecisionSchema = z.object({
  workspaceId: IdentifierSchemas.workspaceId,
  projectId: IdentifierSchemas.projectId,
  principalRef: z.string().min(1).max(256),
  expiresAt: TimestampSchema,
  constraints: z.object({
    allowedSensitivities: z.array(SensitivitySchema).min(1).refine(unique),
    allowedStateItemIds: z.array(IdentifierSchemas.projectStateItemId).refine(unique),
    allowedArtifactIds: z.array(IdentifierSchemas.artifactId).refine(unique),
  }),
  permissions: z.array(z.string().min(1).max(256)).refine(unique),
  budgets: z.object({
    maximumBytes: z.number().int().positive(),
    maximumTokens: z.number().int().positive(),
  }),
  providerRequest: z
    .object({
      scopeDigest: DigestSchema,
      executionLocation: z.enum(['cloud', 'runtime_node']),
      capability: CapabilitySchema,
      policy: ContextProviderPolicySchema,
    })
    .optional(),
})

const PrincipalSchema = z.string().min(1).max(256)

interface CurrentGrant {
  readonly grant: ContextCommandGrant
  readonly registration: ContextProviderRegistration
}

/**
 * Production {@link ContextAuthoringAuthority} backed by current scoped grants, the
 * registration read model and an explicitly configured composition policy.
 *
 * Authorization requires an active, unexpired grant for (workspaceId, principalRef) that is
 * reachable through an active registration; a revoked grant denies, and a retired
 * (revoked-state) registration does not authorize. The provider request is derived solely
 * from the grant's scope digest, the registration's advertised capabilities and the
 * configured policy — never from request payload fields. When no eligible provider binding
 * exists (disabled policy, revoked registration, unadvertised capability or unsupported
 * execution location) the decision degrades to the documented no-provider behavior by
 * omitting `providerRequest` instead of failing authoring. Artifact decisions map the
 * composition's artifact repository onto the port's state enum as-is: metadata markers and
 * classification are read from the store and never synthesized, and anything unverifiable
 * maps to an unavailable state.
 */
export class GrantsBackedContextAuthoringAuthority implements ContextAuthoringAuthority {
  readonly #grants: Pick<ContextCommandGrantRepository, 'get'>
  readonly #registrations: Pick<ContextProviderRegistrationRepository, 'list'>
  readonly #artifacts: ContextAuthoringArtifactStore | undefined
  readonly #policy: ContextAuthoringPolicy
  readonly #now: () => Date

  constructor(options: {
    grants: Pick<ContextCommandGrantRepository, 'get'>
    registrations: Pick<ContextProviderRegistrationRepository, 'list'>
    policy: ContextAuthoringPolicy
    artifacts?: ContextAuthoringArtifactStore
    now?: () => Date
  }) {
    this.#grants = options.grants
    this.#registrations = options.registrations
    this.#artifacts = options.artifacts
    this.#policy = ContextAuthoringPolicySchema.parse(options.policy)
    this.#now = options.now ?? (() => new Date())
  }

  async authorize(
    principalRef: string,
    request: unknown
  ): Promise<z.output<typeof AuthoringDecisionSchema> | undefined> {
    const principal = PrincipalSchema.safeParse(principalRef)
    if (!principal.success) return undefined
    const parsed = AuthorityRequestSchema.safeParse(request)
    if (!parsed.success) return undefined
    const scoped = parsed.data
    const nowMs = this.#now().getTime()
    const current = await this.#currentGrant(principal.data, scoped.workspaceId, nowMs)
    if (!current) return undefined
    const { grant } = current
    const ttlCeiling = new Date(nowMs + this.#policy.maximumContextTtlSeconds * 1000)
    const expiresAt =
      ttlCeiling.getTime() <= Date.parse(grant.expiresAt)
        ? ttlCeiling.toISOString()
        : grant.expiresAt
    return AuthoringDecisionSchema.parse({
      workspaceId: scoped.workspaceId,
      projectId: scoped.projectId,
      principalRef: principal.data,
      expiresAt,
      constraints: {
        allowedSensitivities: [...this.#policy.allowedSensitivities],
        // The grant authorizes exactly the requested candidate scope, never more.
        allowedStateItemIds: [...new Set(scoped.candidates.map((item) => item.itemId))].toSorted(),
        allowedArtifactIds: [...this.#policy.allowedArtifactIds].toSorted(),
      },
      permissions: [...this.#policy.permissions].toSorted(),
      budgets: {
        maximumBytes: this.#policy.maximumBytes,
        maximumTokens: this.#policy.maximumTokens,
      },
      providerRequest: this.#providerRequest(grant, current.registration),
    })
  }

  async resolveArtifact(input: {
    principalRef: string
    workspaceId: string
    projectId: string
    artifactId: string
  }): Promise<
    | (z.output<typeof ArtifactRefSchema> & {
        workspaceId: string
        projectId: string
        authorized: boolean
        state: 'available' | 'missing' | 'revoked' | 'unverified' | 'quarantined'
      })
    | undefined
  > {
    const principal = PrincipalSchema.safeParse(input.principalRef)
    const scope = z
      .object({
        workspaceId: IdentifierSchemas.workspaceId,
        projectId: IdentifierSchemas.projectId,
        artifactId: IdentifierSchemas.artifactId,
      })
      .safeParse(input)
    if (!principal.success || !scope.success) return undefined
    if (this.#artifacts === undefined) return undefined
    let descriptor
    try {
      descriptor = await this.#artifacts.head(scope.data.artifactId)
    } catch (error) {
      if (notFound(error)) return undefined
      throw error
    }
    if (descriptor.key !== scope.data.artifactId) return undefined
    const current = await this.#currentGrant(
      principal.data,
      scope.data.workspaceId,
      this.#now().getTime()
    )
    const metadata = descriptor.metadata
    const sensitivity = SensitivitySchema.safeParse(metadata['sensitivity'])
    const contentType =
      typeof descriptor.contentType === 'string' ? descriptor.contentType : undefined
    // Lifecycle markers are read from the store as-is; an unrecognized marker, an
    // unclassifiable payload or a missing media type leaves the artifact unavailable.
    const marker = metadata['artifact-state']
    const state =
      marker === 'revoked'
        ? 'revoked'
        : marker === 'quarantined'
          ? 'quarantined'
          : marker !== undefined || !sensitivity.success || contentType === undefined
            ? 'unverified'
            : 'available'
    const declaredWorkspace = metadata['workspace-id']
    const declaredProject = metadata['project-id']
    // Only a verifiable descriptor may present itself as a reference; every unavailable
    // state fails in the authoring service before its reference fields are consumed.
    const reference = {
      artifactId: scope.data.artifactId,
      contentDigest: descriptor.sha256,
      mediaType: contentType ?? '',
      sizeBytes: descriptor.size,
      sensitivity: sensitivity.success ? sensitivity.data : 'public',
    }
    return {
      ...(state === 'available' ? ArtifactRefSchema.parse(reference) : reference),
      workspaceId: scope.data.workspaceId,
      projectId: scope.data.projectId,
      authorized:
        current !== undefined &&
        (declaredWorkspace === undefined || declaredWorkspace === scope.data.workspaceId) &&
        (declaredProject === undefined || declaredProject === scope.data.projectId),
      state,
    }
  }

  /**
   * Finds the active, unexpired grant for (workspaceId, principalRef) through the current
   * registration read model. Registrations whose connection state is not active are retired
   * and never authorize; a grant that is revoked, expired, or issued to another principal or
   * workspace is skipped. Health and state are read from the store as-is.
   */
  async #currentGrant(
    principalRef: string,
    workspaceId: string,
    nowMs: number
  ): Promise<CurrentGrant | undefined> {
    if (!Number.isFinite(nowMs)) return undefined
    const registrations = await this.#registrations.list({ workspaceId, principalRef })
    for (const registration of registrations) {
      const connection = registration.readModel.connection
      if (
        connection.state !== 'active' ||
        connection.workspaceId !== workspaceId ||
        connection.principalRef !== principalRef
      )
        continue
      const stored = await this.#grants.get(workspaceId, registration.authorizationRef)
      const grant = ContextCommandGrantSchema.safeParse(stored)
      if (!grant.success) continue
      const issuedAt = Date.parse(grant.data.issuedAt)
      const expiresAt = Date.parse(grant.data.expiresAt)
      if (
        grant.data.status !== 'active' ||
        grant.data.principalRef !== principalRef ||
        grant.data.workspaceId !== workspaceId ||
        !Number.isFinite(issuedAt) ||
        !Number.isFinite(expiresAt) ||
        nowMs < issuedAt ||
        nowMs >= expiresAt
      )
        continue
      return { grant: grant.data, registration }
    }
    return undefined
  }

  /**
   * Composition-owned provider request from the grant's scope digest, the registration's
   * advertised capabilities and the configured policy. Returns undefined — never a synthetic
   * request — when no eligible provider binding exists, which degrades authoring to the
   * documented no-provider path.
   */
  #providerRequest(
    grant: ContextCommandGrant,
    registration: ContextProviderRegistration
  ): z.output<typeof AuthoringDecisionSchema>['providerRequest'] {
    const policy = this.#policy
    if (policy.providerPolicy.mode === 'disabled') return undefined
    const connection = registration.readModel.connection
    if (
      connection.state !== 'active' ||
      connection.scopeDigest !== grant.scopeDigest ||
      connection.providerId !== registration.readModel.definition.providerId ||
      registration.providerRef !== grant.providerRef ||
      registration.mappedProjectRef !== grant.mappedProjectRef ||
      registration.authorizationRef !== grant.authorizationRef ||
      !connection.executionLocations.includes(policy.executionLocation)
    )
      return undefined
    const capability = policy.allowedCapabilities.find(
      (candidate) =>
        grant.capabilities.includes(candidate) &&
        registration.readModel.definition.capabilities[candidate] === true
    )
    if (capability === undefined) return undefined
    const providerPolicy: ContextProviderPolicy = {
      ...policy.providerPolicy,
      maximumTokens: Math.min(policy.providerPolicy.maximumTokens, grant.maximumTokens),
      includeEvidence: policy.providerPolicy.includeEvidence && grant.includeEvidence,
      includeMemory: policy.providerPolicy.includeMemory && grant.includeMemory,
    }
    return {
      scopeDigest: grant.scopeDigest,
      executionLocation: policy.executionLocation,
      capability,
      policy: providerPolicy,
    }
  }
}

function notFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'OBJECT_STORE_NOT_FOUND'
  )
}
