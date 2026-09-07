import {
  ContextPackageSchema,
  ContextAuthoringCommandRecordSchema,
  contextAuthoringCommandKey,
} from '@control-plane/context'
import {
  agentProfileVersions,
  agentProfiles,
  contextPackages,
  contextAuthoringCommands,
  executionPlans,
  executions,
  profileMigrations,
  projectStateRevisions,
  projectStates,
  skillVersions,
  skills,
  type ControlPlaneDatabase,
} from '@control-plane/database'
import {
  AgentProfileSchema,
  AgentProfileVersionSchema,
  ProjectStateSchema,
  SkillSchema,
  SkillVersionSchema,
} from '@control-plane/domain'
import { ExecutionPlanSchema } from '@control-plane/execution-plan'
import { and, eq } from 'drizzle-orm'
import {
  createPortableRecord,
  type PortableArtifactReference,
  type PortableRecord,
  type PortableSecretReference,
} from './manifest.js'
import {
  PortableMigrationError,
  portableJson,
  type PortableImportTransaction,
  type PortableMigrationProvenance,
  type PortableRecordInspection,
  type PortableStateDestination,
  type PortableStateSnapshot,
  type PortableStateSource,
} from './migration.js'

type PostgresProfile = 'cloud' | 'hosted-server'
type PostgresObjectStore = 'filesystem' | 's3-compatible'

export interface PostgresPortableStateSourceOptions {
  readonly database: ControlPlaneDatabase
  readonly profile: PostgresProfile
  readonly objectStore: PostgresObjectStore
  readonly componentVersions: Readonly<Record<string, string>>
  readonly artifacts?: readonly PortableArtifactReference[]
  readonly secretReferences?: readonly PortableSecretReference[]
  readonly unsupportedReferences?: readonly string[]
}

/** Reads the supported portable subset from accepted PostgreSQL domain tables. */
export class PostgresPortableStateSource implements PortableStateSource {
  readonly profile: PostgresProfile
  readonly persistence = 'postgresql' as const
  readonly objectStore: PostgresObjectStore
  readonly componentVersions: Readonly<Record<string, string>>
  readonly #database: ControlPlaneDatabase
  readonly #artifacts: readonly PortableArtifactReference[]
  readonly #secretReferences: readonly PortableSecretReference[]
  readonly #unsupportedReferences: readonly string[]

  constructor(options: PostgresPortableStateSourceOptions) {
    this.#database = options.database
    this.profile = options.profile
    this.objectStore = options.objectStore
    this.componentVersions = { ...options.componentVersions }
    this.#artifacts = [...(options.artifacts ?? [])]
    this.#secretReferences = [...(options.secretReferences ?? [])]
    this.#unsupportedReferences = [...(options.unsupportedReferences ?? [])]
  }

  async snapshot(): Promise<PortableStateSnapshot> {
    const [
      profileRows,
      profileVersionRows,
      skillRows,
      skillVersionRows,
      stateRows,
      stateHistoryRows,
      contextRows,
      authoringRows,
      planRows,
      executionRows,
    ] = await Promise.all([
      this.#database.select().from(agentProfiles),
      this.#database.select().from(agentProfileVersions),
      this.#database.select().from(skills),
      this.#database.select().from(skillVersions),
      this.#database.select().from(projectStates),
      this.#database.select().from(projectStateRevisions),
      this.#database.select().from(contextPackages),
      this.#database.select().from(contextAuthoringCommands),
      this.#database.select().from(executionPlans),
      this.#database
        .select({ executionId: executions.executionId, state: executions.state })
        .from(executions),
    ])
    const currentStateRevisions = new Map(
      stateRows.map((row) => [scopeId(row.workspaceId, row.projectId), row.revision])
    )
    const records: Array<Omit<PortableRecord, 'contentDigest'>> = [
      ...profileRows.map((row) => ({
        category: 'agent-profile' as const,
        logicalId: `agent-profiles/${row.profileId}`,
        revision: 0,
        value: portableJson(
          AgentProfileSchema.parse({ ...row, createdAt: row.createdAt.toISOString() })
        ),
      })),
      ...profileVersionRows.map((row) => ({
        category: 'agent-profile' as const,
        logicalId: `agent-profile-versions/${row.profileVersionId}`,
        revision: row.revision,
        value: portableJson(
          AgentProfileVersionSchema.parse({ ...row, createdAt: row.createdAt.toISOString() })
        ),
      })),
      ...skillRows.map((row) => ({
        category: 'skill' as const,
        logicalId: `skills/${row.skillId}`,
        revision: 0,
        value: portableJson(SkillSchema.parse({ ...row, createdAt: row.createdAt.toISOString() })),
      })),
      ...skillVersionRows.map((row) => ({
        category: 'skill' as const,
        logicalId: `skill-versions/${row.skillVersionId}`,
        revision: row.revision,
        value: portableJson(
          SkillVersionSchema.parse({ ...row, createdAt: row.createdAt.toISOString() })
        ),
      })),
      ...stateRows.map((row) => ({
        category: 'project-state' as const,
        logicalId: `project-states/${scopeId(row.workspaceId, row.projectId)}`,
        revision: row.revision,
        value: portableJson(ProjectStateSchema.parse(row.state)),
      })),
      ...stateHistoryRows
        .filter(
          (row) =>
            currentStateRevisions.get(scopeId(row.workspaceId, row.projectId)) !== row.revision
        )
        .map((row) => ({
          category: 'selected-history' as const,
          logicalId: `project-state-history/${historyId(
            row.workspaceId,
            row.projectId,
            row.revision
          )}`,
          revision: row.revision,
          value: portableJson(ProjectStateSchema.parse(row.state)),
        })),
      ...contextRows.map((row) => ({
        category: 'context-package' as const,
        logicalId: `context-packages/${row.contextPackageId}`,
        revision: 0,
        value: portableJson(ContextPackageSchema.parse(row.contextPackage)),
      })),
      ...authoringRows.map((row) => {
        const record = ContextAuthoringCommandRecordSchema.parse(row.record)
        if (
          row.commandKey !== contextAuthoringCommandKey(record.scope) ||
          row.workspaceId !== record.scope.workspaceId ||
          row.projectId !== record.scope.projectId ||
          row.contextPackageId !== record.contextPackage.contextPackageId
        )
          throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [row.commandKey])
        return {
          category: 'context-authoring-command' as const,
          logicalId: `context-authoring-commands/${row.commandKey}`,
          revision: 0,
          value: portableJson(record),
        }
      }),
      ...planRows.map((row) => ({
        category: 'execution-plan' as const,
        logicalId: `execution-plans/${row.executionPlanId}`,
        revision: 0,
        value: portableJson(ExecutionPlanSchema.parse(row.plan)),
      })),
    ]
    const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out'])
    return {
      records,
      artifacts: this.#artifacts,
      secretReferences: this.#secretReferences,
      activeWorkIds: executionRows
        .filter(({ state }) => !terminal.has(state))
        .map(({ executionId }) => executionId)
        .sort(),
      unsupportedReferences: this.#unsupportedReferences,
    }
  }
}

export interface PostgresPortableStateDestinationOptions {
  readonly database: ControlPlaneDatabase
  readonly profile: PostgresProfile
  readonly capabilities: ReadonlySet<string>
  readonly secretProviders: ReadonlySet<string>
}

/** Applies the supported portable subset in one serializable PostgreSQL transaction. */
export class PostgresPortableStateDestination implements PortableStateDestination {
  readonly profile: PostgresProfile
  readonly capabilities: ReadonlySet<string>
  readonly secretProviders: ReadonlySet<string>
  readonly #database: ControlPlaneDatabase

  constructor(options: PostgresPortableStateDestinationOptions) {
    this.#database = options.database
    this.profile = options.profile
    this.capabilities = new Set(options.capabilities)
    this.secretProviders = new Set(options.secretProviders)
  }

  async inspect(records: readonly PortableRecord[]): Promise<readonly PortableRecordInspection[]> {
    const snapshot = await new PostgresPortableStateSource({
      database: this.#database,
      profile: this.profile,
      objectStore: 's3-compatible',
      componentVersions: {},
    }).snapshot()
    if ((snapshot.activeWorkIds?.length ?? 0) > 0) {
      throw new PortableMigrationError('PORTABLE_ACTIVE_WORK', snapshot.activeWorkIds)
    }
    const existing = new Map(
      snapshot.records.map((record) => {
        const portable = createPortableRecord(record)
        return [portable.logicalId, portable]
      })
    )
    return records.map((record) => {
      const current = existing.get(record.logicalId)
      return {
        record,
        state:
          current === undefined
            ? 'missing'
            : current.contentDigest === record.contentDigest
              ? 'equivalent'
              : 'conflict',
      }
    })
  }

  begin(): Promise<PortableImportTransaction> {
    const records: PortableRecord[] = []
    let provenance: PortableMigrationProvenance | undefined
    let settled = false
    return Promise.resolve({
      put: async (record) => {
        if (settled) throw new Error('PORTABLE_TRANSACTION_SETTLED')
        records.push(createPortableRecord(record))
      },
      recordProvenance: async (value) => {
        if (settled) throw new Error('PORTABLE_TRANSACTION_SETTLED')
        provenance = { ...value }
      },
      commit: async () => {
        if (settled || provenance === undefined) throw new Error('PORTABLE_TRANSACTION_INVALID')
        const committedProvenance = provenance
        await this.#database.transaction(
          async (transaction) => {
            for (const record of [...records].sort(byWriteOrder)) {
              await writeRecord(transaction, record)
            }
            const [existing] = await transaction
              .select()
              .from(profileMigrations)
              .where(eq(profileMigrations.exportId, committedProvenance.exportId))
              .limit(1)
            if (existing === undefined) {
              await transaction.insert(profileMigrations).values({
                ...committedProvenance,
                provenance: { ...committedProvenance },
                appliedAt: new Date(committedProvenance.appliedAt),
              })
            } else if (
              existing.manifestDigest !== committedProvenance.manifestDigest ||
              existing.sourceProfile !== committedProvenance.sourceProfile ||
              existing.destinationProfile !== committedProvenance.destinationProfile
            ) {
              throw new PortableMigrationError('PORTABLE_DESTINATION_CONFLICT', [
                `profile-migrations:${committedProvenance.exportId}`,
              ])
            }
          },
          { isolationLevel: 'serializable', accessMode: 'read write', deferrable: false }
        )
        settled = true
      },
      rollback: async () => {
        settled = true
        records.length = 0
        provenance = undefined
      },
    })
  }
}

type DatabaseTransaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]

async function writeRecord(
  transaction: DatabaseTransaction,
  record: PortableRecord
): Promise<void> {
  const [namespace, id] = identity(record.logicalId)
  if (namespace === 'agent-profiles') {
    const value = AgentProfileSchema.parse(record.value)
    await inserted(
      transaction
        .insert(agentProfiles)
        .values({ ...value, createdAt: new Date(value.createdAt) })
        .onConflictDoNothing()
        .returning({ id: agentProfiles.profileId }),
      record
    )
    return
  }
  if (namespace === 'agent-profile-versions') {
    const value = AgentProfileVersionSchema.parse(record.value)
    await inserted(
      transaction
        .insert(agentProfileVersions)
        .values({ ...value, createdAt: new Date(value.createdAt) })
        .onConflictDoNothing()
        .returning({ id: agentProfileVersions.profileVersionId }),
      record
    )
    return
  }
  if (namespace === 'skills') {
    const value = SkillSchema.parse(record.value)
    await inserted(
      transaction
        .insert(skills)
        .values({ ...value, createdAt: new Date(value.createdAt) })
        .onConflictDoNothing()
        .returning({ id: skills.skillId }),
      record
    )
    return
  }
  if (namespace === 'skill-versions') {
    const value = SkillVersionSchema.parse(record.value)
    await inserted(
      transaction
        .insert(skillVersions)
        .values({ ...value, createdAt: new Date(value.createdAt) })
        .onConflictDoNothing()
        .returning({ id: skillVersions.skillVersionId }),
      record
    )
    return
  }
  if (namespace === 'project-states') {
    const value = ProjectStateSchema.parse(record.value)
    await inserted(
      transaction
        .insert(projectStates)
        .values({
          workspaceId: value.workspaceId,
          projectId: value.projectId,
          revision: value.revision,
          state: value,
          createdAt: new Date(value.createdAt),
          updatedAt: new Date(value.updatedAt),
        })
        .onConflictDoNothing()
        .returning({ id: projectStates.projectId }),
      record
    )
    await transaction
      .insert(projectStateRevisions)
      .values({
        workspaceId: value.workspaceId,
        projectId: value.projectId,
        revision: value.revision,
        state: value,
        recordedAt: new Date(value.updatedAt),
      })
      .onConflictDoNothing()
    return
  }
  if (namespace === 'project-state-history') {
    const value = ProjectStateSchema.parse(record.value)
    const current = await transaction
      .select({ projectId: projectStates.projectId })
      .from(projectStates)
      .where(
        and(
          eq(projectStates.workspaceId, value.workspaceId),
          eq(projectStates.projectId, value.projectId)
        )
      )
      .limit(1)
    if (current.length === 0) throw new PortableMigrationError('PORTABLE_PLAN_STALE', [id])
    await inserted(
      transaction
        .insert(projectStateRevisions)
        .values({
          workspaceId: value.workspaceId,
          projectId: value.projectId,
          revision: value.revision,
          state: value,
          recordedAt: new Date(value.updatedAt),
        })
        .onConflictDoNothing()
        .returning({ id: projectStateRevisions.projectId }),
      record
    )
    return
  }
  if (namespace === 'context-packages') {
    const value = ContextPackageSchema.parse(record.value)
    await inserted(
      transaction
        .insert(contextPackages)
        .values({
          contextPackageId: value.contextPackageId,
          contentDigest: value.contentDigest,
          schemaVersion: value.schemaVersion,
          workspaceId: value.projectState.workspaceId,
          projectId: value.projectState.projectId,
          contextPackage: value,
          compiledAt: new Date(value.compiledAt),
        })
        .onConflictDoNothing()
        .returning({ id: contextPackages.contextPackageId }),
      record
    )
    return
  }
  if (namespace === 'context-authoring-commands') {
    const value = ContextAuthoringCommandRecordSchema.parse(record.value)
    if (id !== contextAuthoringCommandKey(value.scope))
      throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
    await inserted(
      transaction
        .insert(contextAuthoringCommands)
        .values({
          commandKey: id,
          workspaceId: value.scope.workspaceId,
          projectId: value.scope.projectId,
          contextPackageId: value.contextPackage.contextPackageId,
          record: value,
        })
        .onConflictDoNothing()
        .returning({ id: contextAuthoringCommands.commandKey }),
      record
    )
    return
  }
  if (namespace === 'execution-plans') {
    const value = ExecutionPlanSchema.parse(record.value)
    await inserted(
      transaction
        .insert(executionPlans)
        .values({
          executionPlanId: value.executionPlanId,
          contentDigest: value.contentDigest,
          schemaVersion: value.schemaVersion,
          workspaceId: value.correlation.workspaceId,
          projectId: value.correlation.projectId,
          taskId: value.correlation.taskId,
          agentId: value.correlation.agentId,
          plan: value,
          compiledAt: new Date(value.compiledAt),
        })
        .onConflictDoNothing()
        .returning({ id: executionPlans.executionPlanId }),
      record
    )
    return
  }
  throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
}

async function inserted(
  result: Promise<readonly unknown[]>,
  record: PortableRecord
): Promise<void> {
  if ((await result).length === 0) {
    throw new PortableMigrationError('PORTABLE_PLAN_STALE', [record.logicalId])
  }
}

function identity(logicalId: string): readonly [string, string] {
  const separator = logicalId.indexOf('/')
  if (separator <= 0 || separator === logicalId.length - 1) {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [logicalId])
  }
  return [logicalId.slice(0, separator), logicalId.slice(separator + 1)]
}

function scopeId(workspaceId: string, projectId: string): string {
  return `${workspaceId}:${projectId}`
}

function historyId(workspaceId: string, projectId: string, revision: number): string {
  return `${scopeId(workspaceId, projectId)}:${String(revision)}`
}

function byWriteOrder(left: PortableRecord, right: PortableRecord): number {
  const order = [
    'agent-profiles',
    'agent-profile-versions',
    'skills',
    'skill-versions',
    'project-states',
    'project-state-history',
    'context-packages',
    'context-authoring-commands',
    'execution-plans',
  ]
  return (
    order.indexOf(identity(left.logicalId)[0]) - order.indexOf(identity(right.logicalId)[0]) ||
    left.logicalId.localeCompare(right.logicalId)
  )
}
