import { createHash } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import type { StructuredLogger } from '@control-plane/bootstrap'
import {
  IdentifierSchemas,
  WorkspaceAgentProfileDeprecationRequestSchema,
  WorkspaceAgentProfileGetRequestSchema,
  WorkspaceAgentProfileGetResponseSchema,
  WorkspaceAgentProfileLifecycleResponseSchema,
  WorkspaceAgentProfileListRequestSchema,
  WorkspaceAgentProfileListResponseSchema,
  WorkspaceAgentProfilePublishRequestSchema,
  WorkspaceAgentProfilePublishResponseSchema,
  WorkspaceAgentProfileRevocationRequestSchema,
  WorkspaceCatalogOwnershipSchema,
  WorkspaceSkillDeprecationRequestSchema,
  WorkspaceSkillGetRequestSchema,
  WorkspaceSkillGetResponseSchema,
  WorkspaceSkillLifecycleResponseSchema,
  WorkspaceSkillListRequestSchema,
  WorkspaceSkillListResponseSchema,
  WorkspaceSkillPublishRequestSchema,
  WorkspaceSkillPublishResponseSchema,
  WorkspaceSkillRevocationRequestSchema,
  canonicalJsonStringify,
  decodeCursor,
  encodeCursor,
  type WorkspaceAgentProfileGetResponse,
  type WorkspaceAgentProfileLifecycleResponse,
  type WorkspaceAgentProfileListResponse,
  type WorkspaceAgentProfilePublishResponse,
  type WorkspaceSkillGetResponse,
  type WorkspaceSkillLifecycleResponse,
  type WorkspaceSkillListResponse,
  type WorkspaceSkillPublishResponse,
} from '@control-plane/contracts'
import {
  CatalogError,
  WorkspaceCatalog,
  WorkspaceCatalogError,
  workspaceCatalogVisibility,
  type AgentProfile,
  type AgentProfileVersion,
  type CatalogLifecycleChange,
  type Skill,
  type SkillVersion,
  type WorkspaceCatalogCommandRepository,
  type WorkspaceCatalogOperation,
  type WorkspaceCatalogReader,
  type WorkspaceCatalogStore,
} from '@control-plane/domain'

export const WORKSPACE_CATALOG_SERVICE = Symbol('WORKSPACE_CATALOG_SERVICE')

export interface WorkspaceCatalogService {
  listSkills(input: unknown, principalId: string): Promise<WorkspaceSkillListResponse>
  getSkill(input: unknown, principalId: string): Promise<WorkspaceSkillGetResponse>
  publishSkill(input: unknown, principalId: string): Promise<WorkspaceSkillPublishResponse>
  deprecateSkill(input: unknown, principalId: string): Promise<WorkspaceSkillLifecycleResponse>
  revokeSkill(input: unknown, principalId: string): Promise<WorkspaceSkillLifecycleResponse>
  listProfiles(input: unknown, principalId: string): Promise<WorkspaceAgentProfileListResponse>
  getProfile(input: unknown, principalId: string): Promise<WorkspaceAgentProfileGetResponse>
  publishProfile(input: unknown, principalId: string): Promise<WorkspaceAgentProfilePublishResponse>
  deprecateProfile(
    input: unknown,
    principalId: string
  ): Promise<WorkspaceAgentProfileLifecycleResponse>
  revokeProfile(
    input: unknown,
    principalId: string
  ): Promise<WorkspaceAgentProfileLifecycleResponse>
}

export class UnavailableWorkspaceCatalogService implements WorkspaceCatalogService {
  listSkills = unavailable
  getSkill = unavailable
  publishSkill = unavailable
  deprecateSkill = unavailable
  revokeSkill = unavailable
  listProfiles = unavailable
  getProfile = unavailable
  publishProfile = unavailable
  deprecateProfile = unavailable
  revokeProfile = unavailable
}

export interface RepositoryWorkspaceCatalogServiceOptions {
  /** Workspace-unscoped catalog records; every use case binds the envelope workspace. */
  readonly catalog: WorkspaceCatalogStore & WorkspaceCatalogReader
  readonly commands: WorkspaceCatalogCommandRepository
  /** Audit sink: one structured event per committed or replayed mutation. */
  readonly logger: StructuredLogger
  readonly now?: () => Date
}

interface RequestIdentity {
  readonly contractVersion: { readonly major: number; readonly minor: number }
  readonly requestId: string
  readonly correlation: unknown
  readonly workspaceId: string
  readonly caller: { readonly servicePrincipalId: string }
}

interface CommandIdentity extends RequestIdentity {
  readonly commandId: string
  readonly idempotencyKey: string
  readonly operation: string
  readonly payload: unknown
}

/**
 * HTTP guards own credential scopes and workspace claims; this service binds every read and
 * write to the envelope workspace. Other workspaces' items are indistinguishable from missing
 * ones, system items are read-only, and organization/private items are never visible.
 */
export class RepositoryWorkspaceCatalogService implements WorkspaceCatalogService {
  readonly #now: () => Date

  constructor(readonly options: RepositoryWorkspaceCatalogServiceOptions) {
    this.#now = options.now ?? (() => new Date())
  }

  async listSkills(input: unknown, principalId: string) {
    const request = WorkspaceSkillListRequestSchema.parse(input)
    assertCaller(request, principalId)
    const listing = await this.#catalog(request.workspaceId).listSkills(this.options.catalog, {
      after: cursorPosition(request.parameters.cursor, IdentifierSchemas.skillId),
      limit: request.parameters.limit ?? 50,
    })
    return WorkspaceSkillListResponseSchema.parse({
      ...responseIdentity(request),
      data: {
        items: listing.items.map(({ skill, latestVersion }) => ({
          skill: skillRecord(skill, request.workspaceId),
          ...(latestVersion === undefined ? {} : { latestVersion: skillSummary(latestVersion) }),
        })),
        page: listing.nextAfter === undefined ? {} : { nextCursor: cursor(listing.nextAfter) },
      },
    })
  }

  async getSkill(input: unknown, principalId: string) {
    const request = WorkspaceSkillGetRequestSchema.parse(input)
    assertCaller(request, principalId)
    try {
      const { skill, versions, version } = await this.#catalog(request.workspaceId).getSkill(
        request.parameters.skillId,
        request.parameters.skillVersionId
      )
      return WorkspaceSkillGetResponseSchema.parse({
        ...responseIdentity(request),
        data: {
          skill: skillRecord(skill, request.workspaceId),
          versions: versions.map(skillSummary),
          ...(version === undefined ? {} : { version: skillDetail(version) }),
        },
      })
    } catch (error) {
      throw publicError(error)
    }
  }

  async publishSkill(input: unknown, principalId: string) {
    const request = WorkspaceSkillPublishRequestSchema.parse(input)
    const at = this.#now().toISOString()
    const data = await this.#command(request, principalId, 'skill.publish', async (store) => {
      const { skill, version } = await new WorkspaceCatalog(
        store,
        request.workspaceId
      ).publishSkillVersion({ ...request.payload, at })
      return {
        skill: skillRecord(skill, request.workspaceId),
        version: skillDetail(version),
      }
    })
    return WorkspaceSkillPublishResponseSchema.parse({ ...responseIdentity(request), data })
  }

  deprecateSkill(input: unknown, principalId: string) {
    return this.#skillLifecycle(WorkspaceSkillDeprecationRequestSchema.parse(input), principalId)
  }

  revokeSkill(input: unknown, principalId: string) {
    return this.#skillLifecycle(WorkspaceSkillRevocationRequestSchema.parse(input), principalId)
  }

  async listProfiles(input: unknown, principalId: string) {
    const request = WorkspaceAgentProfileListRequestSchema.parse(input)
    assertCaller(request, principalId)
    const listing = await this.#catalog(request.workspaceId).listAgentProfiles(
      this.options.catalog,
      {
        after: cursorPosition(request.parameters.cursor, IdentifierSchemas.profileId),
        limit: request.parameters.limit ?? 50,
      }
    )
    return WorkspaceAgentProfileListResponseSchema.parse({
      ...responseIdentity(request),
      data: {
        items: listing.items.map(({ profile, latestVersion }) => ({
          profile: profileRecord(profile, request.workspaceId),
          ...(latestVersion === undefined ? {} : { latestVersion: profileSummary(latestVersion) }),
        })),
        page: listing.nextAfter === undefined ? {} : { nextCursor: cursor(listing.nextAfter) },
      },
    })
  }

  async getProfile(input: unknown, principalId: string) {
    const request = WorkspaceAgentProfileGetRequestSchema.parse(input)
    assertCaller(request, principalId)
    try {
      const { profile, versions, version } = await this.#catalog(
        request.workspaceId
      ).getAgentProfile(request.parameters.profileId, request.parameters.profileVersionId)
      return WorkspaceAgentProfileGetResponseSchema.parse({
        ...responseIdentity(request),
        data: {
          profile: profileRecord(profile, request.workspaceId),
          versions: versions.map(profileSummary),
          ...(version === undefined ? {} : { version: profileDetail(version) }),
        },
      })
    } catch (error) {
      throw publicError(error)
    }
  }

  async publishProfile(input: unknown, principalId: string) {
    const request = WorkspaceAgentProfilePublishRequestSchema.parse(input)
    const at = this.#now().toISOString()
    const data = await this.#command(request, principalId, 'profile.publish', async (store) => {
      const { profile, version } = await new WorkspaceCatalog(
        store,
        request.workspaceId
      ).publishAgentProfileVersion({ ...request.payload, at })
      return {
        profile: profileRecord(profile, request.workspaceId),
        version: profileDetail(version),
      }
    })
    return WorkspaceAgentProfilePublishResponseSchema.parse({ ...responseIdentity(request), data })
  }

  deprecateProfile(input: unknown, principalId: string) {
    return this.#profileLifecycle(
      WorkspaceAgentProfileDeprecationRequestSchema.parse(input),
      principalId
    )
  }

  revokeProfile(input: unknown, principalId: string) {
    return this.#profileLifecycle(
      WorkspaceAgentProfileRevocationRequestSchema.parse(input),
      principalId
    )
  }

  async #skillLifecycle(
    request:
      | ReturnType<typeof WorkspaceSkillDeprecationRequestSchema.parse>
      | ReturnType<typeof WorkspaceSkillRevocationRequestSchema.parse>,
    principalId: string
  ) {
    const change = lifecycleChange(request.operation)
    const at = this.#now().toISOString()
    const { payload } = request
    const data = await this.#command(request, principalId, `skill.${change}`, async (store) => {
      const { skill, changed } = await new WorkspaceCatalog(
        store,
        request.workspaceId
      ).changeSkillLifecycle(
        change,
        payload.skillId,
        'skillVersionId' in payload
          ? {
              versionId: payload.skillVersionId,
              expectedRevision: payload.expectedRevision,
              reason: payload.reason,
            }
          : { reason: payload.reason },
        at
      )
      return {
        skill: skillRecord(skill, request.workspaceId),
        changed: changed.map(skillSummary),
      }
    })
    return WorkspaceSkillLifecycleResponseSchema.parse({ ...responseIdentity(request), data })
  }

  async #profileLifecycle(
    request:
      | ReturnType<typeof WorkspaceAgentProfileDeprecationRequestSchema.parse>
      | ReturnType<typeof WorkspaceAgentProfileRevocationRequestSchema.parse>,
    principalId: string
  ) {
    const change = lifecycleChange(request.operation)
    const at = this.#now().toISOString()
    const { payload } = request
    const data = await this.#command(request, principalId, `profile.${change}`, async (store) => {
      const { profile, changed } = await new WorkspaceCatalog(
        store,
        request.workspaceId
      ).changeAgentProfileLifecycle(
        change,
        payload.profileId,
        'profileVersionId' in payload
          ? {
              versionId: payload.profileVersionId,
              expectedRevision: payload.expectedRevision,
              reason: payload.reason,
            }
          : { reason: payload.reason },
        at
      )
      return {
        profile: profileRecord(profile, request.workspaceId),
        changed: changed.map(profileSummary),
      }
    })
    return WorkspaceAgentProfileLifecycleResponseSchema.parse({
      ...responseIdentity(request),
      data,
    })
  }

  async #command(
    request: CommandIdentity,
    principalId: string,
    operation: WorkspaceCatalogOperation,
    action: (store: WorkspaceCatalogStore) => Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    assertCaller(request, principalId)
    if (containsCredentialMaterial(request.payload)) {
      throw new UnprocessableEntityException({
        code: 'CATALOG_CREDENTIAL_INPUT_REJECTED',
        message: 'Catalog input cannot contain credentials',
      })
    }
    // Server-computed: the envelope payloadHash is caller-asserted and never trusted alone.
    const payloadHash = createHash('sha256')
      .update(
        canonicalJsonStringify([
          request.workspaceId,
          principalId,
          request.operation,
          request.payload,
        ]) ?? ''
      )
      .digest('hex')
    let executed = false
    try {
      const result = await this.options.commands.executeCommand(
        request.workspaceId,
        { callerId: principalId, operation, idempotencyKey: request.idempotencyKey, payloadHash },
        async (store) => {
          executed = true
          return action(store)
        }
      )
      this.#audit(request, principalId, operation, result, !executed)
      return result
    } catch (error) {
      throw publicError(error, true)
    }
  }

  #audit(
    request: CommandIdentity,
    principalId: string,
    operation: WorkspaceCatalogOperation,
    result: Record<string, unknown>,
    replayed: boolean
  ): void {
    // Identifiers, lifecycle and digests only; instructions and definitions never enter logs.
    const versions = [
      ...(isRecord(result['version']) ? [result['version']] : []),
      ...(Array.isArray(result['changed']) ? result['changed'].filter(isRecord) : []),
    ].map((version) => ({
      versionId: version['skillVersionId'] ?? version['profileVersionId'],
      revision: version['revision'],
      lifecycle: version['lifecycle'],
      contentDigest: version['contentDigest'],
    }))
    const item = isRecord(result['skill'])
      ? result['skill']['skillId']
      : isRecord(result['profile'])
        ? result['profile']['profileId']
        : undefined
    this.options.logger.write({
      level: 'info',
      event: `catalog.${operation}`,
      details: {
        workspaceId: request.workspaceId,
        principalId,
        requestId: request.requestId,
        commandId: request.commandId,
        itemId: item,
        versions,
        replayed,
      },
    })
  }

  #catalog(workspaceId: string): WorkspaceCatalog {
    return new WorkspaceCatalog(this.options.catalog, workspaceId)
  }
}

function lifecycleChange(operation: string): CatalogLifecycleChange {
  return operation.endsWith('.revoke') ? 'revoke' : 'deprecate'
}

function skillRecord(skill: Skill, workspaceId: string) {
  return {
    skillId: skill.skillId,
    displayName: skill.displayName,
    ownership: WorkspaceCatalogOwnershipSchema.parse(skill.ownership),
    readOnly: workspaceCatalogVisibility(skill.ownership, workspaceId) !== 'owned',
    createdAt: skill.createdAt,
  }
}

function profileRecord(profile: AgentProfile, workspaceId: string) {
  return {
    profileId: profile.profileId,
    displayName: profile.displayName,
    ownership: WorkspaceCatalogOwnershipSchema.parse(profile.ownership),
    readOnly: workspaceCatalogVisibility(profile.ownership, workspaceId) !== 'owned',
    createdAt: profile.createdAt,
  }
}

function skillSummary(version: SkillVersion) {
  return {
    skillId: version.skillId,
    skillVersionId: version.skillVersionId,
    semanticVersion: version.manifest.semanticVersion,
    revision: version.revision,
    lifecycle: version.lifecycle,
    contentDigest: version.manifest.contentDigest,
    createdAt: version.createdAt,
    lifecycleMetadata: version.lifecycleMetadata,
  }
}

function skillDetail(version: SkillVersion) {
  return { ...skillSummary(version), manifest: version.manifest, content: version.content }
}

function profileSummary(version: AgentProfileVersion) {
  return {
    profileId: version.profileId,
    profileVersionId: version.profileVersionId,
    version: version.version,
    revision: version.revision,
    schemaVersion: version.definition.schemaVersion,
    lifecycle: version.lifecycle,
    contentDigest: version.contentDigest,
    createdAt: version.createdAt,
    lifecycleMetadata: version.lifecycleMetadata,
  }
}

function profileDetail(version: AgentProfileVersion) {
  return { ...profileSummary(version), definition: version.definition }
}

function responseIdentity(request: RequestIdentity) {
  return {
    contractVersion: request.contractVersion,
    requestId: request.requestId,
    correlation: request.correlation,
  }
}

function cursor(id: string): string {
  return encodeCursor({ sortKey: id, id })
}

function cursorPosition(
  value: string | undefined,
  identifier: { safeParse(input: unknown): { success: boolean } }
): string | undefined {
  if (value === undefined) return undefined
  try {
    const position = decodeCursor(value)
    if (position.id === position.sortKey && identifier.safeParse(position.id).success) {
      return position.id
    }
  } catch {
    // Fall through to the normalized rejection; cursor contents are never echoed.
  }
  throw new BadRequestException({
    code: 'CATALOG_CURSOR_INVALID',
    message: 'Catalog page cursor is invalid',
  })
}

function assertCaller(request: RequestIdentity, principalId: string): void {
  if (!principalId || request.caller.servicePrincipalId !== principalId) {
    throw new ForbiddenException({
      code: 'CATALOG_CALLER_MISMATCH',
      message: 'Catalog caller is not authorized',
    })
  }
}

const credentialKeys = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'credential',
  'idtoken',
  'passwd',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'secretkey',
  'secretvalue',
  'signingkey',
  'token',
])
const credentialValues = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/,
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^@\s/:]+:[^@\s]+@/i,
]

/**
 * Credential-shaped keys or recognizable secret values. Instruction text is otherwise free-form,
 * so mentions of prompts, local endpoints or paths are allowed in Skill and profile content.
 */
function containsCredentialMaterial(value: unknown): boolean {
  if (typeof value === 'string') return credentialValues.some((pattern) => pattern.test(value))
  if (Array.isArray(value)) return value.some(containsCredentialMaterial)
  if (!isRecord(value)) return false
  return Object.entries(value).some(
    ([key, nested]) =>
      credentialKeys.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase()) ||
      containsCredentialMaterial(nested)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publicError(error: unknown, command = false): unknown {
  if (error instanceof WorkspaceCatalogError) {
    switch (error.code) {
      case 'CATALOG_ITEM_NOT_FOUND':
        return new NotFoundException({
          code: error.code,
          message: 'Catalog item was not found in this workspace',
        })
      case 'CATALOG_VERSION_NOT_FOUND':
        return new NotFoundException({
          code: error.code,
          message: 'Catalog version was not found in this workspace',
        })
      case 'CATALOG_ITEM_READ_ONLY':
        return new ForbiddenException({
          code: error.code,
          message: 'System catalog items are read-only for workspaces',
        })
      case 'CATALOG_DISPLAY_NAME_REQUIRED':
      case 'CATALOG_SKILL_PIN_INVALID':
        return new UnprocessableEntityException({
          code: error.code,
          message: 'Catalog input is not publishable',
        })
      case 'CATALOG_DISPLAY_NAME_CONFLICT':
      case 'CATALOG_COMMAND_CONFLICT':
        return new ConflictException({
          code: error.code,
          message: 'Catalog command conflicts with retained state',
        })
    }
  }
  if (error instanceof CatalogError) {
    return error.code === 'CATALOG_RECORD_MISSING'
      ? new NotFoundException({
          code: 'CATALOG_VERSION_NOT_FOUND',
          message: 'Catalog version was not found in this workspace',
        })
      : new ConflictException({
          code: error.code,
          message: 'Catalog command conflicts with retained state',
        })
  }
  // Executable content is validated inside the command; its schema failures are 422, while
  // envelope failures were already rejected as 400 before the command began.
  if (command && isSchemaError(error)) {
    return new UnprocessableEntityException({
      code: 'CATALOG_CONTENT_INVALID',
      message: 'Catalog content does not satisfy its versioned schema',
    })
  }
  return error
}

function isSchemaError(error: unknown): boolean {
  return isRecord(error) && Array.isArray(error['issues']) && error['name'] === 'ZodError'
}

async function unavailable(): Promise<never> {
  throw new ServiceUnavailableException({
    code: 'WORKSPACE_CATALOG_NOT_CONFIGURED',
    message: 'Workspace catalog administration is not configured',
  })
}
