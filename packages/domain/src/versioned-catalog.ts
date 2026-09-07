import { createHash } from 'node:crypto'
import {
  AgentProfileDefinitionSchema,
  AgentProfilePinSchema,
  AgentProfileSchema,
  AgentProfileVersionSchema,
  SkillContentSchema,
  SkillManifestSchema,
  SkillSchema,
  SkillVersionSchema,
  type AgentProfile,
  type AgentProfileVersion,
  type Skill,
  type SkillManifest,
  type SkillVersion,
} from './catalog-models.js'

export type CatalogErrorCode =
  | 'CATALOG_RECORD_EXISTS'
  | 'CATALOG_RECORD_MISSING'
  | 'VERSION_ALREADY_EXISTS'
  | 'VERSION_NOT_DRAFT'
  | 'VERSION_NOT_PUBLISHED'
  | 'VERSION_REVISION_CONFLICT'
  | 'VERSION_NUMBER_CONFLICT'
  | 'SKILL_SEMANTIC_VERSION_CONFLICT'

export class CatalogError extends Error {
  constructor(readonly code: CatalogErrorCode) {
    super(code)
    this.name = 'CatalogError'
  }
}

export interface AgentProfileRepository {
  insertAgentProfile(profile: AgentProfile): Promise<boolean>
  getAgentProfile(profileId: string): Promise<AgentProfile | undefined>
  insertAgentProfileVersion(version: AgentProfileVersion): Promise<boolean>
  getAgentProfileVersion(profileVersionId: string): Promise<AgentProfileVersion | undefined>
  listAgentProfileVersions(profileId: string): Promise<readonly AgentProfileVersion[]>
  compareAndSetAgentProfileVersion(
    expectedRevision: number,
    version: AgentProfileVersion
  ): Promise<boolean>
}

export interface SkillRepository {
  insertSkill(skill: Skill): Promise<boolean>
  getSkill(skillId: string): Promise<Skill | undefined>
  insertSkillVersion(version: SkillVersion): Promise<boolean>
  getSkillVersion(skillVersionId: string): Promise<SkillVersion | undefined>
  listSkillVersions(skillId: string): Promise<readonly SkillVersion[]>
  compareAndSetSkillVersion(expectedRevision: number, version: SkillVersion): Promise<boolean>
}

export class InMemoryVersionedCatalogRepository implements AgentProfileRepository, SkillRepository {
  readonly #profiles = new Map<string, AgentProfile>()
  readonly #profileVersions = new Map<string, AgentProfileVersion>()
  readonly #skills = new Map<string, Skill>()
  readonly #skillVersions = new Map<string, SkillVersion>()

  async insertAgentProfile(profile: AgentProfile): Promise<boolean> {
    if (this.#profiles.has(profile.profileId)) return false
    this.#profiles.set(profile.profileId, clone(profile))
    return true
  }

  async getAgentProfile(profileId: string): Promise<AgentProfile | undefined> {
    return cloneOptional(this.#profiles.get(profileId))
  }

  async insertAgentProfileVersion(version: AgentProfileVersion): Promise<boolean> {
    if (this.#profileVersions.has(version.profileVersionId)) return false
    this.#profileVersions.set(version.profileVersionId, clone(version))
    return true
  }

  async getAgentProfileVersion(profileVersionId: string): Promise<AgentProfileVersion | undefined> {
    return cloneOptional(this.#profileVersions.get(profileVersionId))
  }

  async listAgentProfileVersions(profileId: string): Promise<readonly AgentProfileVersion[]> {
    return [...this.#profileVersions.values()]
      .filter((version) => version.profileId === profileId)
      .map(clone)
  }

  async compareAndSetAgentProfileVersion(
    expectedRevision: number,
    version: AgentProfileVersion
  ): Promise<boolean> {
    const current = this.#profileVersions.get(version.profileVersionId)
    if (current?.revision !== expectedRevision) return false
    if (
      version.lifecycle === 'published' &&
      [...this.#profileVersions.values()].some(
        (candidate) =>
          candidate.profileVersionId !== version.profileVersionId &&
          candidate.profileId === version.profileId &&
          candidate.version === version.version &&
          candidate.lifecycle !== 'draft'
      )
    ) {
      return false
    }
    this.#profileVersions.set(version.profileVersionId, clone(version))
    return true
  }

  async insertSkill(skill: Skill): Promise<boolean> {
    if (this.#skills.has(skill.skillId)) return false
    this.#skills.set(skill.skillId, clone(skill))
    return true
  }

  async getSkill(skillId: string): Promise<Skill | undefined> {
    return cloneOptional(this.#skills.get(skillId))
  }

  async insertSkillVersion(version: SkillVersion): Promise<boolean> {
    if (this.#skillVersions.has(version.skillVersionId)) return false
    this.#skillVersions.set(version.skillVersionId, clone(version))
    return true
  }

  async getSkillVersion(skillVersionId: string): Promise<SkillVersion | undefined> {
    return cloneOptional(this.#skillVersions.get(skillVersionId))
  }

  async listSkillVersions(skillId: string): Promise<readonly SkillVersion[]> {
    return [...this.#skillVersions.values()]
      .filter((version) => version.skillId === skillId)
      .map(clone)
  }

  async compareAndSetSkillVersion(
    expectedRevision: number,
    version: SkillVersion
  ): Promise<boolean> {
    const current = this.#skillVersions.get(version.skillVersionId)
    if (current?.revision !== expectedRevision) return false
    if (
      version.lifecycle === 'published' &&
      [...this.#skillVersions.values()].some(
        (candidate) =>
          candidate.skillVersionId !== version.skillVersionId &&
          candidate.skillId === version.skillId &&
          candidate.manifest.semanticVersion === version.manifest.semanticVersion &&
          candidate.lifecycle !== 'draft'
      )
    ) {
      return false
    }
    this.#skillVersions.set(version.skillVersionId, clone(version))
    return true
  }
}

export interface CompatibilityEnvironment {
  readonly capabilities: readonly string[]
  readonly tools: readonly string[]
  readonly contractMajorVersion: number
}

export type ResolutionState =
  | 'available'
  | 'deprecated'
  | 'superseded'
  | 'revoked'
  | 'unpublished'
  | 'missing'
  | 'incompatible'

export type CatalogResolution<Version> =
  | {
      readonly state: Exclude<ResolutionState, 'missing' | 'incompatible'>
      readonly version: Version
    }
  | { readonly state: 'missing' }
  | {
      readonly state: 'incompatible'
      readonly reasons: readonly string[]
      readonly version: Version
    }

export class VersionedCatalog {
  readonly #profiles: AgentProfileRepository
  readonly #skills: SkillRepository

  constructor(profiles: AgentProfileRepository, skills: SkillRepository) {
    this.#profiles = profiles
    this.#skills = skills
  }

  async createAgentProfile(input: unknown): Promise<AgentProfile> {
    const profile = AgentProfileSchema.parse(input)
    if (!(await this.#profiles.insertAgentProfile(profile))) {
      throw new CatalogError('CATALOG_RECORD_EXISTS')
    }
    return profile
  }

  async createSkill(input: unknown): Promise<Skill> {
    const skill = SkillSchema.parse(input)
    if (!(await this.#skills.insertSkill(skill))) throw new CatalogError('CATALOG_RECORD_EXISTS')
    return skill
  }

  async createAgentProfileDraft(input: {
    readonly profileVersionId: string
    readonly profileId: string
    readonly version: number
    readonly definition: unknown
    readonly createdAt: string
  }): Promise<AgentProfileVersion> {
    if (!(await this.#profiles.getAgentProfile(input.profileId))) {
      throw new CatalogError('CATALOG_RECORD_MISSING')
    }
    const definition = AgentProfileDefinitionSchema.parse(input.definition)
    const version = AgentProfileVersionSchema.parse({
      ...input,
      revision: 1,
      lifecycle: 'draft',
      contentDigest: digest(definition),
      definition,
      lifecycleMetadata: {},
    })
    if (!(await this.#profiles.insertAgentProfileVersion(version))) {
      throw new CatalogError('VERSION_ALREADY_EXISTS')
    }
    return version
  }

  async createSkillDraft(input: {
    readonly skillVersionId: string
    readonly skillId: string
    readonly manifest: Omit<SkillManifest, 'contentDigest'>
    readonly content: unknown
    readonly createdAt: string
  }): Promise<SkillVersion> {
    if (!(await this.#skills.getSkill(input.skillId)))
      throw new CatalogError('CATALOG_RECORD_MISSING')
    const content = SkillContentSchema.parse(input.content)
    const manifest = SkillManifestSchema.parse({
      ...input.manifest,
      contentDigest: digest(content),
    })
    const version = SkillVersionSchema.parse({
      skillVersionId: input.skillVersionId,
      skillId: input.skillId,
      revision: 1,
      lifecycle: 'draft',
      manifest,
      content,
      createdAt: input.createdAt,
      lifecycleMetadata: {},
    })
    if (!(await this.#skills.insertSkillVersion(version))) {
      throw new CatalogError('VERSION_ALREADY_EXISTS')
    }
    return version
  }

  async updateAgentProfileDraft(input: {
    readonly profileVersionId: string
    readonly expectedRevision: number
    readonly definition: unknown
  }): Promise<AgentProfileVersion> {
    const current = await this.#requiredProfileVersion(input.profileVersionId)
    this.#assertDraft(current)
    const definition = AgentProfileDefinitionSchema.parse(input.definition)
    const next = AgentProfileVersionSchema.parse({
      ...current,
      revision: current.revision + 1,
      contentDigest: digest(definition),
      definition,
    })
    await this.#saveProfileVersion(input.expectedRevision, next)
    return next
  }

  async publishAgentProfileVersion(input: {
    readonly profileVersionId: string
    readonly expectedRevision: number
    readonly publishedAt: string
  }): Promise<AgentProfileVersion> {
    const current = await this.#requiredProfileVersion(input.profileVersionId)
    this.#assertDraft(current)
    const conflicts = (await this.#profiles.listAgentProfileVersions(current.profileId)).some(
      (version) => version.version === current.version && version.lifecycle !== 'draft'
    )
    if (conflicts) throw new CatalogError('VERSION_NUMBER_CONFLICT')
    const next = AgentProfileVersionSchema.parse({
      ...current,
      revision: current.revision + 1,
      lifecycle: 'published',
      lifecycleMetadata: { publishedAt: input.publishedAt },
    })
    await this.#saveProfileVersion(input.expectedRevision, next)
    return next
  }

  async publishSkillVersion(input: {
    readonly skillVersionId: string
    readonly expectedRevision: number
    readonly publishedAt: string
  }): Promise<SkillVersion> {
    const current = await this.#requiredSkillVersion(input.skillVersionId)
    this.#assertDraft(current)
    const conflicts = (await this.#skills.listSkillVersions(current.skillId)).some(
      (version) =>
        version.manifest.semanticVersion === current.manifest.semanticVersion &&
        version.lifecycle !== 'draft'
    )
    if (conflicts) throw new CatalogError('SKILL_SEMANTIC_VERSION_CONFLICT')
    const next = SkillVersionSchema.parse({
      ...current,
      revision: current.revision + 1,
      lifecycle: 'published',
      lifecycleMetadata: { publishedAt: input.publishedAt },
    })
    await this.#saveSkillVersion(input.expectedRevision, next)
    return next
  }

  deprecateAgentProfileVersion = (id: string, revision: number, at: string, reason: string) =>
    this.#transitionProfile(id, revision, 'deprecated', { deprecatedAt: at, reason })

  revokeAgentProfileVersion = (id: string, revision: number, at: string, reason: string) =>
    this.#transitionProfile(id, revision, 'revoked', { revokedAt: at, reason })

  deprecateSkillVersion = (id: string, revision: number, at: string, reason: string) =>
    this.#transitionSkill(id, revision, 'deprecated', { deprecatedAt: at, reason })

  revokeSkillVersion = (id: string, revision: number, at: string, reason: string) =>
    this.#transitionSkill(id, revision, 'revoked', { revokedAt: at, reason })

  async supersedeAgentProfileVersion(
    id: string,
    revision: number,
    at: string,
    supersededByVersionId: string
  ): Promise<AgentProfileVersion> {
    const current = await this.#requiredProfileVersion(id)
    const successor = await this.#requiredProfileVersion(supersededByVersionId)
    if (successor.profileId !== current.profileId || successor.lifecycle !== 'published') {
      throw new CatalogError('VERSION_NOT_PUBLISHED')
    }
    return this.#transitionProfile(id, revision, 'superseded', {
      supersededAt: at,
      supersededByVersionId,
    })
  }

  async supersedeSkillVersion(
    id: string,
    revision: number,
    at: string,
    supersededByVersionId: string
  ): Promise<SkillVersion> {
    const current = await this.#requiredSkillVersion(id)
    const successor = await this.#requiredSkillVersion(supersededByVersionId)
    if (successor.skillId !== current.skillId || successor.lifecycle !== 'published') {
      throw new CatalogError('VERSION_NOT_PUBLISHED')
    }
    return this.#transitionSkill(id, revision, 'superseded', {
      supersededAt: at,
      supersededByVersionId,
    })
  }

  async resolveSkill(input: {
    skillId: string
    skillVersionId: string
    contentDigest: string
  }): Promise<CatalogResolution<SkillVersion>> {
    const version = await this.#skills.getSkillVersion(input.skillVersionId)
    if (!version || version.skillId !== input.skillId) return { state: 'missing' }
    if (version.manifest.contentDigest !== input.contentDigest) {
      return { state: 'incompatible', reasons: ['SKILL_CONTENT_DIGEST_MISMATCH'], version }
    }
    return { state: lifecycleResolution(version.lifecycle), version }
  }

  async resolveAgentProfile(
    pinInput: unknown,
    environment?: CompatibilityEnvironment
  ): Promise<CatalogResolution<AgentProfileVersion>> {
    const pin = AgentProfilePinSchema.parse(pinInput)
    const version = await this.#profiles.getAgentProfileVersion(pin.profileVersionId)
    if (!version || version.profileId !== pin.profileId) return { state: 'missing' }
    if (environment) {
      const reasons = await this.#compatibilityReasons(version, environment)
      if (reasons.length > 0) return { state: 'incompatible', reasons, version }
    }
    return { state: lifecycleResolution(version.lifecycle), version }
  }

  async #compatibilityReasons(
    profile: AgentProfileVersion,
    environment: CompatibilityEnvironment
  ): Promise<string[]> {
    const reasons: string[] = []
    for (const capability of profile.definition.capabilityRequirements) {
      if (!environment.capabilities.includes(capability))
        reasons.push(`MISSING_CAPABILITY:${capability}`)
    }
    for (const grant of profile.definition.executionConstraints.tools.grants) {
      if (!environment.tools.includes(grant.tool.toolId)) {
        reasons.push(`MISSING_TOOL:${grant.tool.toolId}`)
      }
    }
    for (const reference of profile.definition.skills) {
      const resolution = await this.resolveSkill(reference)
      if (resolution.state === 'missing') reasons.push(`SKILL_MISSING:${reference.skillVersionId}`)
      else if (resolution.state === 'revoked')
        reasons.push(`SKILL_REVOKED:${reference.skillVersionId}`)
      else if (resolution.state === 'unpublished')
        reasons.push(`SKILL_UNPUBLISHED:${reference.skillVersionId}`)
      else if (resolution.state === 'incompatible') reasons.push(...resolution.reasons)
      else {
        if (
          !resolution.version.manifest.compatibleProfileSchemaVersions.includes(
            profile.definition.schemaVersion
          )
        ) {
          reasons.push(`SKILL_PROFILE_SCHEMA_INCOMPATIBLE:${reference.skillVersionId}`)
        }
        if (
          !resolution.version.manifest.compatibleContractMajorVersions.includes(
            environment.contractMajorVersion
          )
        ) {
          reasons.push(`SKILL_CONTRACT_INCOMPATIBLE:${reference.skillVersionId}`)
        }
      }
    }
    return reasons.sort()
  }

  async #transitionProfile(
    id: string,
    expectedRevision: number,
    lifecycle: 'deprecated' | 'revoked' | 'superseded',
    metadata: object
  ): Promise<AgentProfileVersion> {
    const current = await this.#requiredProfileVersion(id)
    if (!['published', 'deprecated'].includes(current.lifecycle)) {
      throw new CatalogError('VERSION_NOT_PUBLISHED')
    }
    const next = AgentProfileVersionSchema.parse({
      ...current,
      revision: current.revision + 1,
      lifecycle,
      lifecycleMetadata: { ...current.lifecycleMetadata, ...metadata },
    })
    await this.#saveProfileVersion(expectedRevision, next)
    return next
  }

  async #transitionSkill(
    id: string,
    expectedRevision: number,
    lifecycle: 'deprecated' | 'revoked' | 'superseded',
    metadata: object
  ): Promise<SkillVersion> {
    const current = await this.#requiredSkillVersion(id)
    if (!['published', 'deprecated'].includes(current.lifecycle)) {
      throw new CatalogError('VERSION_NOT_PUBLISHED')
    }
    const next = SkillVersionSchema.parse({
      ...current,
      revision: current.revision + 1,
      lifecycle,
      lifecycleMetadata: { ...current.lifecycleMetadata, ...metadata },
    })
    await this.#saveSkillVersion(expectedRevision, next)
    return next
  }

  #assertDraft(version: AgentProfileVersion | SkillVersion): void {
    if (version.lifecycle !== 'draft') throw new CatalogError('VERSION_NOT_DRAFT')
  }

  async #requiredProfileVersion(id: string): Promise<AgentProfileVersion> {
    const version = await this.#profiles.getAgentProfileVersion(id)
    if (!version) throw new CatalogError('CATALOG_RECORD_MISSING')
    return version
  }

  async #requiredSkillVersion(id: string): Promise<SkillVersion> {
    const version = await this.#skills.getSkillVersion(id)
    if (!version) throw new CatalogError('CATALOG_RECORD_MISSING')
    return version
  }

  async #saveProfileVersion(expectedRevision: number, next: AgentProfileVersion): Promise<void> {
    if (!(await this.#profiles.compareAndSetAgentProfileVersion(expectedRevision, next))) {
      throw new CatalogError('VERSION_REVISION_CONFLICT')
    }
  }

  async #saveSkillVersion(expectedRevision: number, next: SkillVersion): Promise<void> {
    if (!(await this.#skills.compareAndSetSkillVersion(expectedRevision, next))) {
      throw new CatalogError('VERSION_REVISION_CONFLICT')
    }
  }
}

function lifecycleResolution(
  lifecycle: AgentProfileVersion['lifecycle']
): Exclude<ResolutionState, 'missing' | 'incompatible'> {
  if (lifecycle === 'published') return 'available'
  if (lifecycle === 'draft') return 'unpublished'
  return lifecycle
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : clone(value)
}
