import { z } from 'zod'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  AgentProfileDefinitionSchema,
  AgentProfileSchema,
  SkillSchema,
  type AgentProfile,
  type AgentProfileVersion,
  type Skill,
  type SkillVersion,
} from './catalog-models.js'
import {
  CatalogError,
  VersionedCatalog,
  type AgentProfileRepository,
  type SkillRepository,
} from './versioned-catalog.js'
import { workspaceCatalogVisibility } from './catalog-ownership.js'

/**
 * Workspace catalog administration: Skills and AgentProfiles owned by one workspace, plus
 * read-only system entries visible to it. Organization and private ownership are never
 * visible through this boundary. Publication reuses {@link VersionedCatalog}, so digests,
 * immutability and version uniqueness are identical to the operator bootstrap path.
 */

export type WorkspaceCatalogErrorCode =
  | 'CATALOG_ITEM_NOT_FOUND'
  | 'CATALOG_VERSION_NOT_FOUND'
  | 'CATALOG_ITEM_READ_ONLY'
  | 'CATALOG_DISPLAY_NAME_REQUIRED'
  | 'CATALOG_DISPLAY_NAME_CONFLICT'
  | 'CATALOG_SKILL_PIN_INVALID'
  | 'CATALOG_COMMAND_CONFLICT'

export class WorkspaceCatalogError extends Error {
  constructor(readonly code: WorkspaceCatalogErrorCode) {
    super(code)
    this.name = 'WorkspaceCatalogError'
  }
}

/** The owned Skill record shape shared by the operator bootstrap and the catalog API. */
export function workspaceSkillRecord(input: {
  readonly workspaceId: string
  readonly skillId: string
  readonly displayName: unknown
  readonly at: string
}): Skill {
  return SkillSchema.parse({
    skillId: input.skillId,
    displayName: input.displayName,
    ownership: { scope: 'workspace', workspaceId: input.workspaceId },
    createdAt: input.at,
    provenance: {
      source: 'workspace-authorized',
      ownerRef: input.workspaceId,
      trust: 'authorized',
    },
  })
}

/** The owned AgentProfile record shape shared by the operator bootstrap and the catalog API. */
export function workspaceAgentProfileRecord(input: {
  readonly workspaceId: string
  readonly profileId: string
  readonly displayName: unknown
  readonly at: string
}): AgentProfile {
  return AgentProfileSchema.parse({
    profileId: input.profileId,
    displayName: input.displayName,
    ownership: { scope: 'workspace', workspaceId: input.workspaceId },
    createdAt: input.at,
  })
}

export interface WorkspaceCatalogPageQuery {
  readonly workspaceId: string
  /** Exclusive lower bound on the stable record ID. */
  readonly after?: string | undefined
  readonly limit: number
}

/**
 * Listing port. Implementations return system and exact-workspace records only, ordered by
 * ascending stable ID, starting after `after`, and at most `limit` entries.
 */
export interface WorkspaceCatalogReader {
  listWorkspaceSkills(query: WorkspaceCatalogPageQuery): Promise<readonly Skill[]>
  listWorkspaceAgentProfiles(query: WorkspaceCatalogPageQuery): Promise<readonly AgentProfile[]>
}

export type WorkspaceCatalogStore = AgentProfileRepository & SkillRepository

export const WorkspaceCatalogOperationSchema = z.enum([
  'skill.publish',
  'skill.deprecate',
  'skill.revoke',
  'profile.publish',
  'profile.deprecate',
  'profile.revoke',
])
export type WorkspaceCatalogOperation = z.output<typeof WorkspaceCatalogOperationSchema>

export const WorkspaceCatalogCommandSchema = z
  .object({
    callerId: z.string().min(1).max(64),
    operation: WorkspaceCatalogOperationSchema,
    idempotencyKey: z.string().min(1).max(128),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type WorkspaceCatalogCommand = z.output<typeof WorkspaceCatalogCommandSchema>

export const WorkspaceCatalogCommandReceiptSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    command: WorkspaceCatalogCommandSchema,
    result: z.record(z.string(), z.unknown()),
  })
  .strict()
export type WorkspaceCatalogCommandReceipt = z.output<typeof WorkspaceCatalogCommandReceiptSchema>

/**
 * Commits a catalog mutation and its original result receipt atomically. Receipt identity is
 * workspace, caller, operation and idempotency key; a different payload hash under the same
 * identity fails with `CATALOG_COMMAND_CONFLICT`, and an identical retry returns the stored
 * result without re-running the action. Adapters serialize commands per workspace so the
 * catalog's read-then-write uniqueness checks cannot race.
 */
export interface WorkspaceCatalogCommandRepository {
  executeCommand(
    workspaceId: string,
    command: WorkspaceCatalogCommand,
    action: (store: WorkspaceCatalogStore) => Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>>
}

export interface WorkspaceSkillListing {
  readonly items: readonly { readonly skill: Skill; readonly latestVersion?: SkillVersion }[]
  readonly nextAfter?: string
}

export interface WorkspaceAgentProfileListing {
  readonly items: readonly {
    readonly profile: AgentProfile
    readonly latestVersion?: AgentProfileVersion
  }[]
  readonly nextAfter?: string
}

export type CatalogLifecycleChange = 'deprecate' | 'revoke'

export interface CatalogLifecycleTarget {
  readonly versionId?: string | undefined
  readonly expectedRevision?: number | undefined
  readonly reason: string
}

/** Read and write use cases bound to one workspace. */
export class WorkspaceCatalog {
  readonly #workspaceId: string

  constructor(
    readonly store: WorkspaceCatalogStore,
    workspaceId: string
  ) {
    this.#workspaceId = IdentifierSchemas.workspaceId.parse(workspaceId)
  }

  async listSkills(
    reader: WorkspaceCatalogReader,
    page: { readonly after?: string | undefined; readonly limit: number }
  ): Promise<WorkspaceSkillListing> {
    const records = await reader.listWorkspaceSkills({
      workspaceId: this.#workspaceId,
      after: page.after,
      limit: page.limit + 1,
    })
    const visible = records.filter(
      (skill) => workspaceCatalogVisibility(skill.ownership, this.#workspaceId) !== undefined
    )
    const items = await Promise.all(
      visible.slice(0, page.limit).map(async (skill) => {
        const latestVersion = latest(
          await this.store.listSkillVersions(skill.skillId),
          (version) => version.skillVersionId
        )
        return latestVersion === undefined ? { skill } : { skill, latestVersion }
      })
    )
    const last = items.at(-1)
    return visible.length > page.limit && last !== undefined
      ? { items, nextAfter: last.skill.skillId }
      : { items }
  }

  async listAgentProfiles(
    reader: WorkspaceCatalogReader,
    page: { readonly after?: string | undefined; readonly limit: number }
  ): Promise<WorkspaceAgentProfileListing> {
    const records = await reader.listWorkspaceAgentProfiles({
      workspaceId: this.#workspaceId,
      after: page.after,
      limit: page.limit + 1,
    })
    const visible = records.filter(
      (profile) => workspaceCatalogVisibility(profile.ownership, this.#workspaceId) !== undefined
    )
    const items = await Promise.all(
      visible.slice(0, page.limit).map(async (profile) => {
        const latestVersion = latest(
          await this.store.listAgentProfileVersions(profile.profileId),
          (version) => version.profileVersionId
        )
        return latestVersion === undefined ? { profile } : { profile, latestVersion }
      })
    )
    const last = items.at(-1)
    return visible.length > page.limit && last !== undefined
      ? { items, nextAfter: last.profile.profileId }
      : { items }
  }

  async getSkill(skillId: string, skillVersionId?: string) {
    const skill = await this.#visibleSkill(skillId)
    const versions = sortVersions(
      (await this.store.listSkillVersions(skill.skillId)).filter(
        (version) => version.lifecycle !== 'draft'
      ),
      (version) => version.skillVersionId
    )
    const version =
      skillVersionId === undefined
        ? versions.at(-1)
        : versions.find((candidate) => candidate.skillVersionId === skillVersionId)
    if (skillVersionId !== undefined && version === undefined) {
      throw new WorkspaceCatalogError('CATALOG_VERSION_NOT_FOUND')
    }
    return { skill, versions, version }
  }

  async getAgentProfile(profileId: string, profileVersionId?: string) {
    const profile = await this.#visibleProfile(profileId)
    const versions = sortVersions(
      (await this.store.listAgentProfileVersions(profile.profileId)).filter(
        (version) => version.lifecycle !== 'draft'
      ),
      (version) => version.profileVersionId
    )
    const version =
      profileVersionId === undefined
        ? versions.at(-1)
        : versions.find((candidate) => candidate.profileVersionId === profileVersionId)
    if (profileVersionId !== undefined && version === undefined) {
      throw new WorkspaceCatalogError('CATALOG_VERSION_NOT_FOUND')
    }
    return { profile, versions, version }
  }

  async publishSkillVersion(input: {
    readonly skillId: string
    readonly skillVersionId: string
    readonly displayName?: string | undefined
    readonly manifest: unknown
    readonly content: unknown
    readonly at: string
  }): Promise<{ readonly skill: Skill; readonly version: SkillVersion }> {
    const catalog = new VersionedCatalog(this.store, this.store)
    const existing = await this.store.getSkill(input.skillId)
    const skill =
      existing === undefined
        ? await catalog.createSkill(
            workspaceSkillRecord({
              workspaceId: this.#workspaceId,
              skillId: input.skillId,
              displayName: requiredDisplayName(input.displayName),
              at: input.at,
            })
          )
        : this.#ownedForWrite(existing, existing.displayName, input.displayName)
    const version = await catalog.publishNewSkillVersion({
      skillId: skill.skillId,
      skillVersionId: input.skillVersionId,
      manifest: input.manifest,
      content: input.content,
      at: input.at,
    })
    return { skill, version }
  }

  async publishAgentProfileVersion(input: {
    readonly profileId: string
    readonly profileVersionId: string
    readonly displayName?: string | undefined
    readonly version: number
    readonly definition: unknown
    readonly at: string
  }): Promise<{ readonly profile: AgentProfile; readonly version: AgentProfileVersion }> {
    const definition = AgentProfileDefinitionSchema.parse(input.definition)
    for (const pin of definition.skills) {
      const pinned = await this.store.getSkillVersion(pin.skillVersionId)
      const owner = pinned === undefined ? undefined : await this.store.getSkill(pinned.skillId)
      if (
        pinned === undefined ||
        owner === undefined ||
        pinned.skillId !== pin.skillId ||
        pinned.manifest.contentDigest !== pin.contentDigest ||
        pinned.lifecycle !== 'published' ||
        workspaceCatalogVisibility(owner.ownership, this.#workspaceId) === undefined
      ) {
        throw new WorkspaceCatalogError('CATALOG_SKILL_PIN_INVALID')
      }
    }
    const catalog = new VersionedCatalog(this.store, this.store)
    const existing = await this.store.getAgentProfile(input.profileId)
    const profile =
      existing === undefined
        ? await catalog.createAgentProfile(
            workspaceAgentProfileRecord({
              workspaceId: this.#workspaceId,
              profileId: input.profileId,
              displayName: requiredDisplayName(input.displayName),
              at: input.at,
            })
          )
        : this.#ownedForWrite(existing, existing.displayName, input.displayName)
    const version = await catalog.publishNewAgentProfileVersion({
      profileId: profile.profileId,
      profileVersionId: input.profileVersionId,
      version: input.version,
      definition,
      at: input.at,
    })
    return { profile, version }
  }

  /**
   * Version target: the exact version at `expectedRevision`. Item target (no version ID): every
   * eligible version — published for deprecation, published or deprecated for revocation —
   * at its current revision, in creation order. An item with nothing eligible changes nothing.
   */
  async changeSkillLifecycle(
    change: CatalogLifecycleChange,
    skillId: string,
    target: CatalogLifecycleTarget,
    at: string
  ): Promise<{ readonly skill: Skill; readonly changed: readonly SkillVersion[] }> {
    const existing = await this.store.getSkill(skillId)
    if (existing === undefined) throw new WorkspaceCatalogError('CATALOG_ITEM_NOT_FOUND')
    const skill = this.#ownedForWrite(existing, existing.displayName, undefined)
    const catalog = new VersionedCatalog(this.store, this.store)
    const transition =
      change === 'deprecate' ? catalog.deprecateSkillVersion : catalog.revokeSkillVersion
    const targets = this.#lifecycleTargets(
      await this.store.listSkillVersions(skill.skillId),
      (version) => version.skillVersionId,
      change,
      target
    )
    const changed: SkillVersion[] = []
    for (const { id, revision } of targets) {
      changed.push(await transition(id, revision, at, target.reason))
    }
    return { skill, changed }
  }

  async changeAgentProfileLifecycle(
    change: CatalogLifecycleChange,
    profileId: string,
    target: CatalogLifecycleTarget,
    at: string
  ): Promise<{ readonly profile: AgentProfile; readonly changed: readonly AgentProfileVersion[] }> {
    const existing = await this.store.getAgentProfile(profileId)
    if (existing === undefined) throw new WorkspaceCatalogError('CATALOG_ITEM_NOT_FOUND')
    const profile = this.#ownedForWrite(existing, existing.displayName, undefined)
    const catalog = new VersionedCatalog(this.store, this.store)
    const transition =
      change === 'deprecate'
        ? catalog.deprecateAgentProfileVersion
        : catalog.revokeAgentProfileVersion
    const targets = this.#lifecycleTargets(
      await this.store.listAgentProfileVersions(profile.profileId),
      (version) => version.profileVersionId,
      change,
      target
    )
    const changed: AgentProfileVersion[] = []
    for (const { id, revision } of targets) {
      changed.push(await transition(id, revision, at, target.reason))
    }
    return { profile, changed }
  }

  #lifecycleTargets<Version extends SkillVersion | AgentProfileVersion>(
    versions: readonly Version[],
    idOf: (version: Version) => string,
    change: CatalogLifecycleChange,
    target: CatalogLifecycleTarget
  ): readonly { readonly id: string; readonly revision: number }[] {
    if (target.versionId !== undefined) {
      const version = versions.find((candidate) => idOf(candidate) === target.versionId)
      if (version === undefined || target.expectedRevision === undefined) {
        throw new WorkspaceCatalogError('CATALOG_VERSION_NOT_FOUND')
      }
      return [{ id: idOf(version), revision: target.expectedRevision }]
    }
    const eligible = change === 'deprecate' ? ['published'] : ['published', 'deprecated']
    return sortVersions(
      versions.filter((version) => eligible.includes(version.lifecycle)),
      idOf
    ).map((version) => ({ id: idOf(version), revision: version.revision }))
  }

  async #visibleSkill(skillId: string): Promise<Skill> {
    const skill = await this.store.getSkill(skillId)
    if (
      skill === undefined ||
      workspaceCatalogVisibility(skill.ownership, this.#workspaceId) === undefined
    ) {
      throw new WorkspaceCatalogError('CATALOG_ITEM_NOT_FOUND')
    }
    return skill
  }

  async #visibleProfile(profileId: string): Promise<AgentProfile> {
    const profile = await this.store.getAgentProfile(profileId)
    if (
      profile === undefined ||
      workspaceCatalogVisibility(profile.ownership, this.#workspaceId) === undefined
    ) {
      throw new WorkspaceCatalogError('CATALOG_ITEM_NOT_FOUND')
    }
    return profile
  }

  #ownedForWrite<Item extends Skill | AgentProfile>(
    record: Item,
    currentName: string,
    requestedName: string | undefined
  ): Item {
    const visibility = workspaceCatalogVisibility(record.ownership, this.#workspaceId)
    // Other workspaces' and non-workspace entries are indistinguishable from missing ones.
    if (visibility === undefined) throw new WorkspaceCatalogError('CATALOG_ITEM_NOT_FOUND')
    if (visibility === 'system') throw new WorkspaceCatalogError('CATALOG_ITEM_READ_ONLY')
    if (requestedName !== undefined && requestedName !== currentName) {
      throw new WorkspaceCatalogError('CATALOG_DISPLAY_NAME_CONFLICT')
    }
    return record
  }
}

/** Domain catalog errors that represent a conflict with retained state. */
export function isCatalogConflict(error: unknown): boolean {
  return (
    (error instanceof CatalogError && error.code !== 'CATALOG_RECORD_MISSING') ||
    (error instanceof WorkspaceCatalogError &&
      (error.code === 'CATALOG_DISPLAY_NAME_CONFLICT' || error.code === 'CATALOG_COMMAND_CONFLICT'))
  )
}

function requiredDisplayName(value: string | undefined): string {
  if (value === undefined) throw new WorkspaceCatalogError('CATALOG_DISPLAY_NAME_REQUIRED')
  return value
}

function sortVersions<Version extends SkillVersion | AgentProfileVersion>(
  versions: readonly Version[],
  idOf: (version: Version) => string
): Version[] {
  // Creation time, then the opaque ID: a deterministic order shared by every adapter.
  return versions.toSorted((left, right) =>
    left.createdAt === right.createdAt
      ? compare(idOf(left), idOf(right))
      : compare(left.createdAt, right.createdAt)
  )
}

function latest<Version extends SkillVersion | AgentProfileVersion>(
  versions: readonly Version[],
  idOf: (version: Version) => string
): Version | undefined {
  return sortVersions(
    versions.filter((version) => version.lifecycle !== 'draft'),
    idOf
  ).at(-1)
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
