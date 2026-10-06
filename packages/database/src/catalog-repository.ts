import { and, eq, asc, or, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type {
  AgentProfile,
  AgentProfileRepository,
  AgentProfileVersion,
  Skill,
  SkillRepository,
  SkillVersion,
  WorkspaceCatalogPageQuery,
  WorkspaceCatalogReader,
} from '@control-plane/domain'
import type { ControlPlaneDatabase } from './connection.js'
import { agentProfileVersions, agentProfiles, skillVersions, skills } from './schema/catalog.js'

type CatalogTransaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]
export type CatalogDatabase = ControlPlaneDatabase | CatalogTransaction

export class PostgresCatalogRepository
  implements AgentProfileRepository, SkillRepository, WorkspaceCatalogReader
{
  constructor(private readonly database: CatalogDatabase) {}

  /** System and exact-workspace Skills, ascending by ID; never organization or private. */
  async listWorkspaceSkills(query: WorkspaceCatalogPageQuery): Promise<readonly Skill[]> {
    const rows = await this.database
      .select()
      .from(skills)
      .where(visibleTo(skills.ownership, skills.skillId, query))
      .orderBy(sql`${skills.skillId} collate "C"`)
      .limit(query.limit)
    return rows.map((row) => parse<Skill>({ ...row, createdAt: row.createdAt.toISOString() }))
  }

  async listWorkspaceAgentProfiles(
    query: WorkspaceCatalogPageQuery
  ): Promise<readonly AgentProfile[]> {
    const rows = await this.database
      .select()
      .from(agentProfiles)
      .where(visibleTo(agentProfiles.ownership, agentProfiles.profileId, query))
      .orderBy(sql`${agentProfiles.profileId} collate "C"`)
      .limit(query.limit)
    return rows.map((row) =>
      parse<AgentProfile>({ ...row, createdAt: row.createdAt.toISOString() })
    )
  }

  async insertAgentProfile(profile: AgentProfile): Promise<boolean> {
    const result = await this.database
      .insert(agentProfiles)
      .values({ ...profile, createdAt: new Date(profile.createdAt) })
      .onConflictDoNothing()
      .returning({ profileId: agentProfiles.profileId })
    return result.length === 1
  }
  async getAgentProfile(profileId: string): Promise<AgentProfile | undefined> {
    const [row] = await this.database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.profileId, profileId))
      .limit(1)
    return row ? parse<AgentProfile>({ ...row, createdAt: row.createdAt.toISOString() }) : undefined
  }
  async insertAgentProfileVersion(version: AgentProfileVersion): Promise<boolean> {
    const result = await this.database
      .insert(agentProfileVersions)
      .values(profileVersionRow(version))
      .onConflictDoNothing()
      .returning({ id: agentProfileVersions.profileVersionId })
    return result.length === 1
  }
  async getAgentProfileVersion(id: string): Promise<AgentProfileVersion | undefined> {
    const [row] = await this.database
      .select()
      .from(agentProfileVersions)
      .where(eq(agentProfileVersions.profileVersionId, id))
      .limit(1)
    return row
      ? parse<AgentProfileVersion>({ ...row, createdAt: row.createdAt.toISOString() })
      : undefined
  }
  async listAgentProfileVersions(profileId: string): Promise<readonly AgentProfileVersion[]> {
    const rows = await this.database
      .select()
      .from(agentProfileVersions)
      .where(eq(agentProfileVersions.profileId, profileId))
      .orderBy(asc(agentProfileVersions.version))
    return rows.map((row) =>
      parse<AgentProfileVersion>({ ...row, createdAt: row.createdAt.toISOString() })
    )
  }
  async compareAndSetAgentProfileVersion(
    expectedRevision: number,
    version: AgentProfileVersion
  ): Promise<boolean> {
    const result = await this.database
      .update(agentProfileVersions)
      .set(profileVersionRow(version))
      .where(
        and(
          eq(agentProfileVersions.profileVersionId, version.profileVersionId),
          eq(agentProfileVersions.revision, expectedRevision)
        )
      )
      .returning({ id: agentProfileVersions.profileVersionId })
    return result.length === 1
  }

  async insertSkill(skill: Skill): Promise<boolean> {
    const result = await this.database
      .insert(skills)
      .values({ ...skill, createdAt: new Date(skill.createdAt) })
      .onConflictDoNothing()
      .returning({ skillId: skills.skillId })
    return result.length === 1
  }
  async getSkill(skillId: string): Promise<Skill | undefined> {
    const [row] = await this.database
      .select()
      .from(skills)
      .where(eq(skills.skillId, skillId))
      .limit(1)
    return row ? parse<Skill>({ ...row, createdAt: row.createdAt.toISOString() }) : undefined
  }
  async insertSkillVersion(version: SkillVersion): Promise<boolean> {
    const result = await this.database
      .insert(skillVersions)
      .values(skillVersionRow(version))
      .onConflictDoNothing()
      .returning({ id: skillVersions.skillVersionId })
    return result.length === 1
  }
  async getSkillVersion(id: string): Promise<SkillVersion | undefined> {
    const [row] = await this.database
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillVersionId, id))
      .limit(1)
    return row ? parse<SkillVersion>({ ...row, createdAt: row.createdAt.toISOString() }) : undefined
  }
  async listSkillVersions(skillId: string): Promise<readonly SkillVersion[]> {
    const rows = await this.database
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
      .orderBy(asc(skillVersions.createdAt))
    return rows.map((row) =>
      parse<SkillVersion>({ ...row, createdAt: row.createdAt.toISOString() })
    )
  }
  async compareAndSetSkillVersion(
    expectedRevision: number,
    version: SkillVersion
  ): Promise<boolean> {
    const result = await this.database
      .update(skillVersions)
      .set(skillVersionRow(version))
      .where(
        and(
          eq(skillVersions.skillVersionId, version.skillVersionId),
          eq(skillVersions.revision, expectedRevision)
        )
      )
      .returning({ id: skillVersions.skillVersionId })
    return result.length === 1
  }
}

function visibleTo(
  ownership: PgColumn,
  id: PgColumn,
  query: WorkspaceCatalogPageQuery
): SQL | undefined {
  // Exact-shape matches mirror workspaceCatalogVisibility(): extra keys are never visible.
  const visible = or(
    sql`${ownership} = '{"scope":"system"}'::jsonb`,
    sql`${ownership} = jsonb_build_object('scope', 'workspace', 'workspaceId', ${query.workspaceId}::text)`
  )
  // Binary collation keeps page order identical to the SQLite and in-memory adapters.
  return query.after === undefined
    ? visible
    : and(visible, sql`${id} collate "C" > ${query.after}::text collate "C"`)
}

function profileVersionRow(version: AgentProfileVersion) {
  return { ...version, createdAt: new Date(version.createdAt) }
}

function skillVersionRow(version: SkillVersion) {
  return { ...version, createdAt: new Date(version.createdAt) }
}

function parse<Value>(value: unknown): Value {
  return structuredClone(value) as Value
}
