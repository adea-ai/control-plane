import type { PersistenceProvider } from '@control-plane/deployment'
import {
  AgentProfileSchema,
  AgentProfileVersionSchema,
  SkillSchema,
  SkillVersionSchema,
  type AgentProfile,
  type AgentProfileVersion,
  type Skill,
  type SkillVersion,
} from '@control-plane/domain/catalog-models'
import {
  CatalogApprovalDecisionSchema,
  type CatalogApprovalDecision,
  type CatalogApprovalRepository,
  type CatalogVersionKind,
} from '@control-plane/domain/catalog-approval'
import type {
  AgentProfileRepository,
  SkillRepository,
  WorkspaceCatalogPageQuery,
  WorkspaceCatalogReader,
} from '@control-plane/domain'
import { visiblePage } from '@control-plane/domain/catalog-ownership'
import { insert, get, list, recordId, json } from './record-storage.js'

const namespaces = {
  profiles: 'agent-profiles',
  profileVersions: 'agent-profile-versions',
  skills: 'skills',
  skillVersions: 'skill-versions',
  catalogApprovals: 'catalog-approvals',
} as const

export class SqliteVersionedCatalogRepository
  implements AgentProfileRepository, SkillRepository, WorkspaceCatalogReader
{
  constructor(readonly provider: PersistenceProvider) {}

  async listWorkspaceSkills(query: WorkspaceCatalogPageQuery): Promise<readonly Skill[]> {
    return visiblePage(
      await list(this.provider, namespaces.skills, SkillSchema.parse),
      (skill) => skill.skillId,
      query
    )
  }

  async listWorkspaceAgentProfiles(
    query: WorkspaceCatalogPageQuery
  ): Promise<readonly AgentProfile[]> {
    return visiblePage(
      await list(this.provider, namespaces.profiles, AgentProfileSchema.parse),
      (profile) => profile.profileId,
      query
    )
  }

  insertAgentProfile(input: AgentProfile): Promise<boolean> {
    const profile = AgentProfileSchema.parse(input)
    return insert(this.provider, namespaces.profiles, profile.profileId, profile)
  }

  getAgentProfile(profileId: string): Promise<AgentProfile | undefined> {
    AgentProfileSchema.shape.profileId.parse(profileId)
    return get(this.provider, namespaces.profiles, profileId, AgentProfileSchema.parse)
  }

  insertAgentProfileVersion(input: AgentProfileVersion): Promise<boolean> {
    const version = AgentProfileVersionSchema.parse(input)
    return insert(this.provider, namespaces.profileVersions, version.profileVersionId, version)
  }

  getAgentProfileVersion(profileVersionId: string): Promise<AgentProfileVersion | undefined> {
    AgentProfileVersionSchema.shape.profileVersionId.parse(profileVersionId)
    return get(
      this.provider,
      namespaces.profileVersions,
      profileVersionId,
      AgentProfileVersionSchema.parse
    )
  }

  listAgentProfileVersions(profileId: string): Promise<readonly AgentProfileVersion[]> {
    AgentProfileSchema.shape.profileId.parse(profileId)
    return list(this.provider, namespaces.profileVersions, AgentProfileVersionSchema.parse).then(
      (versions) => versions.filter((version) => version.profileId === profileId)
    )
  }

  compareAndSetAgentProfileVersion(
    expectedRevision: number,
    input: AgentProfileVersion
  ): Promise<boolean> {
    const version = AgentProfileVersionSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(
        namespaces.profileVersions,
        recordId(version.profileVersionId)
      )
      if (record === undefined) return false
      const current = AgentProfileVersionSchema.parse(record.value)
      if (
        current.revision !== expectedRevision ||
        current.profileVersionId !== version.profileVersionId ||
        current.profileId !== version.profileId ||
        current.version !== version.version
      ) {
        return false
      }
      if (
        version.lifecycle === 'published' &&
        (await transaction.list(namespaces.profileVersions)).some((candidateRecord) => {
          const candidate = AgentProfileVersionSchema.parse(candidateRecord.value)
          return (
            candidate.profileVersionId !== version.profileVersionId &&
            candidate.profileId === version.profileId &&
            candidate.version === version.version &&
            candidate.lifecycle !== 'draft'
          )
        })
      ) {
        return false
      }
      await transaction.put({
        namespace: namespaces.profileVersions,
        id: record.id,
        expectedRevision: record.revision,
        value: json(version),
      })
      return true
    })
  }

  insertSkill(input: Skill): Promise<boolean> {
    const skill = SkillSchema.parse(input)
    return insert(this.provider, namespaces.skills, skill.skillId, skill)
  }

  getSkill(skillId: string): Promise<Skill | undefined> {
    SkillSchema.shape.skillId.parse(skillId)
    return get(this.provider, namespaces.skills, skillId, SkillSchema.parse)
  }

  insertSkillVersion(input: SkillVersion): Promise<boolean> {
    const version = SkillVersionSchema.parse(input)
    return insert(this.provider, namespaces.skillVersions, version.skillVersionId, version)
  }

  getSkillVersion(skillVersionId: string): Promise<SkillVersion | undefined> {
    SkillVersionSchema.shape.skillVersionId.parse(skillVersionId)
    return get(this.provider, namespaces.skillVersions, skillVersionId, SkillVersionSchema.parse)
  }

  listSkillVersions(skillId: string): Promise<readonly SkillVersion[]> {
    SkillSchema.shape.skillId.parse(skillId)
    return list(this.provider, namespaces.skillVersions, SkillVersionSchema.parse).then(
      (versions) => versions.filter((version) => version.skillId === skillId)
    )
  }

  compareAndSetSkillVersion(expectedRevision: number, input: SkillVersion): Promise<boolean> {
    const version = SkillVersionSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(
        namespaces.skillVersions,
        recordId(version.skillVersionId)
      )
      if (record === undefined) return false
      const current = SkillVersionSchema.parse(record.value)
      if (
        current.revision !== expectedRevision ||
        current.skillVersionId !== version.skillVersionId ||
        current.skillId !== version.skillId ||
        current.manifest.semanticVersion !== version.manifest.semanticVersion
      ) {
        return false
      }
      if (
        version.lifecycle === 'published' &&
        (await transaction.list(namespaces.skillVersions)).some((candidateRecord) => {
          const candidate = SkillVersionSchema.parse(candidateRecord.value)
          return (
            candidate.skillVersionId !== version.skillVersionId &&
            candidate.skillId === version.skillId &&
            candidate.manifest.semanticVersion === version.manifest.semanticVersion &&
            candidate.lifecycle !== 'draft'
          )
        })
      ) {
        return false
      }
      await transaction.put({
        namespace: namespaces.skillVersions,
        id: record.id,
        expectedRevision: record.revision,
        value: json(version),
      })
      return true
    })
  }
}

/**
 * SQLite persistence for catalog approval decisions (#188): append-only per
 * (versionKind, versionId, revision); the approval record is deliberately
 * separate from the version lifecycle.
 */
export class SqliteCatalogApprovalRepository implements CatalogApprovalRepository {
  constructor(readonly provider: PersistenceProvider) {}

  insert(decision: CatalogApprovalDecision): Promise<boolean> {
    const parsed = CatalogApprovalDecisionSchema.parse(decision)
    return insert(
      this.provider,
      namespaces.catalogApprovals,
      `${parsed.versionKind}:${parsed.versionId}:${parsed.revision}`,
      parsed
    )
  }

  list(
    versionKind: CatalogVersionKind,
    versionId: string
  ): Promise<readonly CatalogApprovalDecision[]> {
    return list(
      this.provider,
      namespaces.catalogApprovals,
      CatalogApprovalDecisionSchema.parse
    ).then((decisions) =>
      decisions.filter(
        (decision) => decision.versionKind === versionKind && decision.versionId === versionId
      )
    )
  }
}
