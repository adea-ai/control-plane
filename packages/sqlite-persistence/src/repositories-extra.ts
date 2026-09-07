import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  ContextPackageReferenceSchema,
  ContextAuthoringCommandScopeSchema,
  ContextAuthoringCommandRecordSchema,
  type ContextAuthoringCommandScope,
  type ContextAuthoringCommandRecord,
  type ContextAuthoringCommandRepository,
  assertContextPackageIntegrity,
  type ContextPackage,
  type ContextPackageReference,
  type ContextPackageRepository,
} from '@control-plane/context'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import {
  AgentProfileSchema,
  AgentProfileVersionSchema,
  AppliedStateMutationSchema,
  ProjectStateSchema,
  SkillSchema,
  SkillVersionSchema,
  type AgentProfile,
  type AgentProfileRepository,
  type AgentProfileVersion,
  type AppliedStateMutation,
  type ProjectState,
  type ProjectStateRepository,
  type Skill,
  type SkillRepository,
  type SkillVersion,
} from '@control-plane/domain'

const namespaces = {
  profiles: 'agent-profiles',
  profileVersions: 'agent-profile-versions',
  skills: 'skills',
  skillVersions: 'skill-versions',
  contextPackages: 'context-packages',
  projectStates: 'project-states',
  projectStateHistory: 'project-state-history',
  projectStateMutations: 'project-state-mutations',
} as const

export class SqliteVersionedCatalogRepository implements AgentProfileRepository, SkillRepository {
  constructor(readonly provider: PersistenceProvider) {}

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

export class SqliteContextAuthoringCommandRepository implements ContextAuthoringCommandRepository {
  constructor(readonly provider: PersistenceProvider) {}

  get(input: ContextAuthoringCommandScope): Promise<ContextAuthoringCommandRecord | undefined> {
    const scope = ContextAuthoringCommandScopeSchema.parse(input)
    return this.provider.transaction((transaction) => this.#read(transaction, scope))
  }

  commit(
    input: ContextAuthoringCommandRecord,
    packageInput: ContextPackage
  ): Promise<ContextAuthoringCommandRecord> {
    const record = ContextAuthoringCommandRecordSchema.parse(input)
    const package_ = assertContextPackageIntegrity(packageInput)
    if (
      record.scope.workspaceId !== package_.projectState.workspaceId ||
      record.scope.projectId !== package_.projectState.projectId ||
      record.contextPackage.contextPackageId !== package_.contextPackageId ||
      record.contextPackage.contentDigest !== package_.contentDigest
    )
      throw new Error('CONTEXT_AUTHORING_COMMAND_SCOPE_MISMATCH')
    return this.provider.transaction(async (transaction) => {
      const existing = await this.#read(transaction, record.scope)
      if (existing) {
        if (existing.payloadHash !== record.payloadHash)
          throw new Error('CONTEXT_AUTHORING_COMMAND_CONFLICT')
        return existing
      }
      const id = recordId(package_.contextPackageId)
      const stored = await transaction.get(namespaces.contextPackages, id)
      if (stored && !isDeepStrictEqual(assertContextPackageIntegrity(stored.value), package_))
        throw new Error('CONTEXT_PACKAGE_ID_CONFLICT')
      if (!stored)
        await transaction.put({ namespace: namespaces.contextPackages, id, value: json(package_) })
      await transaction.put({
        namespace: 'context-authoring-commands',
        id: authoringCommandId(record.scope),
        value: json(record),
      })
      return record
    })
  }

  async #read(
    transaction: PersistenceTransaction,
    scope: ContextAuthoringCommandScope
  ): Promise<ContextAuthoringCommandRecord | undefined> {
    const stored = await transaction.get('context-authoring-commands', authoringCommandId(scope))
    if (!stored) return undefined
    const record = ContextAuthoringCommandRecordSchema.parse(stored.value)
    if (!isDeepStrictEqual(record.scope, scope))
      throw new Error('CONTEXT_AUTHORING_COMMAND_SCOPE_MISMATCH')
    const storedPackage = await transaction.get(
      namespaces.contextPackages,
      recordId(record.contextPackage.contextPackageId)
    )
    if (!storedPackage) throw new Error('CONTEXT_AUTHORING_COMMAND_PACKAGE_MISSING')
    const package_ = assertContextPackageIntegrity(storedPackage.value)
    if (
      package_.contentDigest !== record.contextPackage.contentDigest ||
      package_.contextPackageId !== record.contextPackage.contextPackageId ||
      package_.projectState.workspaceId !== scope.workspaceId ||
      package_.projectState.projectId !== scope.projectId
    )
      throw new Error('CONTEXT_AUTHORING_COMMAND_SCOPE_MISMATCH')
    return record
  }
}

function authoringCommandId(scope: ContextAuthoringCommandScope): string {
  return recordId(
    JSON.stringify([
      scope.principalRef,
      scope.workspaceId,
      scope.projectId,
      scope.operation,
      scope.idempotencyKey,
    ])
  )
}

export class SqliteContextPackageRepository implements ContextPackageRepository {
  constructor(readonly provider: PersistenceProvider) {}

  put(input: ContextPackage): Promise<ContextPackageReference> {
    const package_ = assertContextPackageIntegrity(input)
    const reference = {
      contextPackageId: package_.contextPackageId,
      contentDigest: package_.contentDigest,
    }
    return this.provider.transaction(async (transaction) => {
      const id = recordId(package_.contextPackageId)
      const record = await transaction.get(namespaces.contextPackages, id)
      if (record === undefined) {
        await transaction.put({ namespace: namespaces.contextPackages, id, value: json(package_) })
      } else if (!isDeepStrictEqual(assertContextPackageIntegrity(record.value), package_)) {
        throw new Error('CONTEXT_PACKAGE_ID_CONFLICT')
      }
      return reference
    })
  }

  async get(input: ContextPackageReference): Promise<ContextPackage | undefined> {
    const reference = ContextPackageReferenceSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(
        namespaces.contextPackages,
        recordId(reference.contextPackageId)
      )
      if (record === undefined) return undefined
      const package_ = assertContextPackageIntegrity(record.value)
      return package_.contentDigest === reference.contentDigest ? package_ : undefined
    })
  }

  async getById(contextPackageId: string): Promise<ContextPackage | undefined> {
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.contextPackages, recordId(contextPackageId))
      return record === undefined ? undefined : assertContextPackageIntegrity(record.value)
    })
  }
}

export class SqliteProjectStateRepository implements ProjectStateRepository {
  constructor(readonly provider: PersistenceProvider) {}

  create(input: ProjectState): Promise<boolean> {
    const state = ProjectStateSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = stateId(state.workspaceId, state.projectId)
      if ((await transaction.get(namespaces.projectStates, id)) !== undefined) return false
      await transaction.put({ namespace: namespaces.projectStates, id, value: json(state) })
      await transaction.put({
        namespace: namespaces.projectStateHistory,
        id: historyId(state.workspaceId, state.projectId, state.revision),
        value: json(state),
      })
      return true
    })
  }

  get(workspaceId: string, projectId: string): Promise<ProjectState | undefined> {
    return get(
      this.provider,
      namespaces.projectStates,
      `${workspaceId}\u001f${projectId}`,
      ProjectStateSchema.parse
    )
  }

  getAtRevision(
    workspaceId: string,
    projectId: string,
    revision: number
  ): Promise<ProjectState | undefined> {
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(
        namespaces.projectStateHistory,
        historyId(workspaceId, projectId, revision)
      )
      return record === undefined ? undefined : ProjectStateSchema.parse(record.value)
    })
  }

  getHistory(workspaceId: string, projectId: string): Promise<readonly ProjectState[]> {
    return this.provider.transaction(async (transaction) =>
      (await transaction.list(namespaces.projectStateHistory))
        .map((record) => ProjectStateSchema.parse(record.value))
        .filter((state) => state.workspaceId === workspaceId && state.projectId === projectId)
        .sort((left, right) => left.revision - right.revision)
    )
  }

  getMutation(
    workspaceId: string,
    projectId: string,
    mutationId: string
  ): Promise<AppliedStateMutation | undefined> {
    return get(
      this.provider,
      namespaces.projectStateMutations,
      `${workspaceId}\u001f${projectId}\u001f${mutationId}`,
      AppliedStateMutationSchema.parse
    )
  }

  compareAndSet(
    expectedRevision: number,
    stateInput: ProjectState,
    mutationInput: AppliedStateMutation
  ): Promise<boolean> {
    const state = ProjectStateSchema.parse(stateInput)
    const mutation = AppliedStateMutationSchema.parse(mutationInput)
    return this.provider.transaction(async (transaction) => {
      const id = stateId(state.workspaceId, state.projectId)
      const record = await transaction.get(namespaces.projectStates, id)
      if (record === undefined) return false
      const current = ProjectStateSchema.parse(record.value)
      if (
        current.revision !== expectedRevision ||
        state.revision !== expectedRevision + 1 ||
        mutation.resultingRevision !== state.revision
      ) {
        return false
      }
      const mutationId = recordId(
        `${state.workspaceId}\u001f${state.projectId}\u001f${mutation.mutationId}`
      )
      if ((await transaction.get(namespaces.projectStateMutations, mutationId)) !== undefined) {
        return false
      }
      await transaction.put({
        namespace: namespaces.projectStates,
        id,
        expectedRevision: record.revision,
        value: json(state),
      })
      await transaction.put({
        namespace: namespaces.projectStateHistory,
        id: historyId(state.workspaceId, state.projectId, state.revision),
        value: json(state),
      })
      await transaction.put({
        namespace: namespaces.projectStateMutations,
        id: mutationId,
        value: json(mutation),
      })
      return true
    })
  }
}

async function insert<Value>(
  provider: PersistenceProvider,
  namespace: string,
  identity: string,
  value: Value
): Promise<boolean> {
  return provider.transaction(async (transaction) => {
    const id = recordId(identity)
    if ((await transaction.get(namespace, id)) !== undefined) return false
    await transaction.put({ namespace, id, value: json(value) })
    return true
  })
}

async function get<Value>(
  provider: PersistenceProvider,
  namespace: string,
  identity: string,
  parse: (input: unknown) => Value
): Promise<Value | undefined> {
  return provider.transaction(async (transaction) => {
    const record = await transaction.get(namespace, recordId(identity))
    return record === undefined ? undefined : parse(record.value)
  })
}

async function list<Value>(
  provider: PersistenceProvider,
  namespace: string,
  parse: (input: unknown) => Value
): Promise<readonly Value[]> {
  return provider.transaction(async (transaction) =>
    (await transaction.list(namespace)).map((record) => parse(record.value))
  )
}

function stateId(workspaceId: string, projectId: string): string {
  return recordId(`${workspaceId}\u001f${projectId}`)
}

function historyId(workspaceId: string, projectId: string, revision: number): string {
  return recordId(`${workspaceId}\u001f${projectId}\u001f${revision}`)
}

function recordId(value: string): string {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
