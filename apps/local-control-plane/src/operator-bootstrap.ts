import type { PersistenceProvider } from '@control-plane/deployment'
import { isDeepStrictEqual } from 'node:util'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  AgentProfileDefinitionSchema,
  AgentProfileSchema,
  SkillSchema,
  SkillManifestSchema,
  InMemoryVersionedCatalogRepository,
  InMemoryProjectStateRepository,
  InMemoryStatePromotionProposalRepository,
  RecordingProjectStateEventPublisher,
  ProjectStateService,
  VersionedCatalog,
  type Skill,
  type SkillVersion,
} from '@control-plane/domain'
import {
  SqliteVersionedCatalogRepository,
  SqliteProjectStateRepository,
} from '@control-plane/sqlite-persistence'

export async function bootstrapLocalOperator(persistence: PersistenceProvider, input: unknown) {
  if (persistence.dialect !== 'sqlite') throw new Error('LOCAL_OPERATOR_BOOTSTRAP_TARGET_INVALID')
  const request = fields(input, [
    'schemaVersion',
    'workspaceId',
    'projectId',
    'at',
    'profile',
    'skills',
  ])
  if (request['schemaVersion'] !== 1) throw new Error('LOCAL_OPERATOR_BOOTSTRAP_INPUT_INVALID')
  const workspaceId = IdentifierSchemas.workspaceId.parse(request['workspaceId'])
  const projectId = IdentifierSchemas.projectId.parse(request['projectId'])
  const projectStates = new InMemoryProjectStateRepository()
  const state = await new ProjectStateService(
    projectStates,
    new InMemoryStatePromotionProposalRepository(),
    new RecordingProjectStateEventPublisher()
  ).initialize({ workspaceId, projectId, at: request['at'] })
  const at = state.createdAt
  const ownership = { scope: 'workspace', workspaceId }
  const staged = new InMemoryVersionedCatalogRepository()
  const catalog = new VersionedCatalog(staged, staged)
  const profileInput = fields(request['profile'], [
    'profileId',
    'profileVersionId',
    'displayName',
    'version',
    'definition',
  ])
  const profile = await catalog.createAgentProfile(
    AgentProfileSchema.parse({
      profileId: profileInput['profileId'],
      displayName: profileInput['displayName'],
      ownership,
      createdAt: at,
    })
  )
  const definition = AgentProfileDefinitionSchema.parse(profileInput['definition'])
  const versionNumber = profileInput['version']
  if (typeof versionNumber !== 'number') throw new Error('LOCAL_OPERATOR_BOOTSTRAP_INPUT_INVALID')
  const profileDraft = await catalog.createAgentProfileDraft({
    profileId: profile.profileId,
    profileVersionId: IdentifierSchemas.profileVersionId.parse(profileInput['profileVersionId']),
    version: versionNumber,
    definition,
    createdAt: at,
  })
  const profileVersion = await catalog.publishAgentProfileVersion({
    profileVersionId: profileDraft.profileVersionId,
    expectedRevision: profileDraft.revision,
    publishedAt: at,
  })
  if (!Array.isArray(request['skills']) || request['skills'].length > 32)
    throw new Error('LOCAL_OPERATOR_BOOTSTRAP_INPUT_INVALID')
  const skills: { skill: Skill; version: SkillVersion }[] = []
  for (const value of request['skills']) {
    const item = fields(value, ['skillId', 'skillVersionId', 'displayName', 'manifest', 'content'])
    const skill = await catalog.createSkill(
      SkillSchema.parse({
        skillId: item['skillId'],
        displayName: item['displayName'],
        ownership,
        createdAt: at,
      })
    )
    const draft = await catalog.createSkillDraft({
      skillId: skill.skillId,
      skillVersionId: IdentifierSchemas.skillVersionId.parse(item['skillVersionId']),
      manifest: SkillManifestSchema.omit({ contentDigest: true }).parse(item['manifest']),
      content: item['content'],
      createdAt: at,
    })
    const version = await catalog.publishSkillVersion({
      skillVersionId: draft.skillVersionId,
      expectedRevision: draft.revision,
      publishedAt: at,
    })
    skills.push({ skill, version })
  }
  for (const pin of definition.skills) {
    if (
      !skills.some(
        ({ skill, version }) =>
          skill.skillId === pin.skillId &&
          version.skillVersionId === pin.skillVersionId &&
          version.manifest.contentDigest === pin.contentDigest
      )
    )
      throw new Error('LOCAL_OPERATOR_BOOTSTRAP_SKILL_PIN_MISMATCH')
  }
  await persistence.transaction(async (transaction) => {
    // Bind existing repositories to this one transaction: publication, ownership and
    // initial state either all commit or all roll back. No nested database transaction.
    const scoped: PersistenceProvider = {
      profile: persistence.profile,
      dialect: persistence.dialect,
      migrate: async () => {
        throw new Error('LOCAL_OPERATOR_BOOTSTRAP_LIFECYCLE_INVALID')
      },
      health: () => persistence.health(),
      close: () => {},
      transaction: (operation) => operation(transaction),
    }
    const records = new SqliteVersionedCatalogRepository(scoped)
    const publication = new VersionedCatalog(records, records)
    if (missingOrSame(await records.getAgentProfile(profile.profileId), profile))
      await publication.createAgentProfile(profile)
    if (
      missingOrSame(
        await records.getAgentProfileVersion(profileVersion.profileVersionId),
        profileVersion
      )
    ) {
      const draft = await publication.createAgentProfileDraft({
        profileId: profile.profileId,
        profileVersionId: profileVersion.profileVersionId,
        version: profileVersion.version,
        definition: profileVersion.definition,
        createdAt: at,
      })
      await publication.publishAgentProfileVersion({
        profileVersionId: draft.profileVersionId,
        expectedRevision: draft.revision,
        publishedAt: at,
      })
    }
    for (const { skill, version } of skills) {
      if (missingOrSame(await records.getSkill(skill.skillId), skill))
        await publication.createSkill(skill)
      if (missingOrSame(await records.getSkillVersion(version.skillVersionId), version)) {
        const draft = await publication.createSkillDraft({
          skillId: skill.skillId,
          skillVersionId: version.skillVersionId,
          manifest: version.manifest,
          content: version.content,
          createdAt: at,
        })
        await publication.publishSkillVersion({
          skillVersionId: draft.skillVersionId,
          expectedRevision: draft.revision,
          publishedAt: at,
        })
      }
    }
    const states = new SqliteProjectStateRepository(scoped)
    const current = await states.get(workspaceId, projectId)
    if (current === undefined) await states.create(state)
    else if (!isDeepStrictEqual(await states.getAtRevision(workspaceId, projectId, 0), state))
      throw new Error('LOCAL_OPERATOR_BOOTSTRAP_CONFLICT')
  })
  return {
    workspaceId,
    projectId,
    projectStateRevision: 0,
    profileVersionId: profileVersion.profileVersionId,
    profileContentDigest: profileVersion.contentDigest,
    skills: skills.map(({ version }) => ({
      skillVersionId: version.skillVersionId,
      contentDigest: version.manifest.contentDigest,
    })),
  }
}

function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(input, key))
  )
    throw new Error('LOCAL_OPERATOR_BOOTSTRAP_INPUT_INVALID')
  return input as Record<string, unknown>
}

function missingOrSame(current: unknown, expected: unknown): boolean {
  if (current === undefined) return true
  if (!isDeepStrictEqual(current, expected)) throw new Error('LOCAL_OPERATOR_BOOTSTRAP_CONFLICT')
  return false
}
