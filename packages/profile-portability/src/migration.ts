import { createHash } from 'node:crypto'
import { EvalRunSchema } from '@control-plane/production-readiness'
import {
  ContextPackageReferenceSchema,
  ContextPackageSchema,
  assertContextPackageIntegrity,
  assertContextPackageDerivedFrom,
  ContextAuthoringCommandRecordSchema,
  contextAuthoringCommandKey,
  type ContextPackage,
  type ContextPackageReference,
} from '@control-plane/context'
import {
  ExecutionPlanReferenceSchema,
  ExecutionPlanSchema,
  assertExecutionPlanDerivedFrom,
  assertExecutionPlanIntegrity,
  assertExecutionValidationCommandPlan,
  ExecutionValidationCommandRecordSchema,
  executionValidationCommandKey,
  type ExecutionPlan,
  type ExecutionPlanReference,
} from '@control-plane/execution-plan'
import type {
  DeploymentProfile,
  JsonValue,
  ObjectStore,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import { compareCodePointOrder, executionScopeOf } from '@control-plane/domain'
import {
  REFERENCE_RETENTION_NAMESPACES,
  appendSqliteCredentialAudit,
  assertSqliteStoredPlanReference,
  listSqliteCredentials,
  readSqliteCredential,
  writeSqliteCredential,
} from '@control-plane/sqlite-persistence'
import {
  PortableCredentialMetadataSchema,
  importedCredential,
  toPortableCredentialMetadata,
} from '@control-plane/credential-vault'
import {
  PORTABLE_CONTRACT_VERSION,
  PORTABLE_EXPORT_SCHEMA_VERSION,
  PortableArtifactReferenceSchema,
  PortableRecordSchema,
  PortableSecretReferenceSchema,
  assertPortableManifest,
  createPortableRecord,
  finalizePortableManifest,
  portableEvaluationRunKey,
  type PortableArtifactReference,
  type PortableExportManifest,
  type PortableRecord,
  type PortableSecretReference,
} from './manifest.js'

const PROHIBITED_FIELD =
  /(?:authorization|credentials?|password|passphrase|private[_-]?key|secret(?:[_-]?(?:value|key))?|api[_-]?key|access[_-]?key|token)$/i
const PRIVATE_PATH = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/

export interface PortableStateSnapshot {
  readonly records: readonly Omit<PortableRecord, 'contentDigest'>[]
  readonly artifacts: readonly PortableArtifactReference[]
  readonly secretReferences: readonly PortableSecretReference[]
  readonly activeWorkIds?: readonly string[]
  readonly unsupportedReferences?: readonly string[]
}

export interface PortableStateSource {
  readonly profile: DeploymentProfile
  readonly persistence: 'sqlite' | 'postgresql'
  readonly objectStore: 'filesystem' | 's3-compatible'
  readonly componentVersions: Readonly<Record<string, string>>
  snapshot(): Promise<PortableStateSnapshot>
}

export interface PortableExportOptions {
  readonly exportId: string
  readonly createdAt?: string
  readonly includeSelectedHistory?: boolean
  readonly requiredCapabilities?: readonly string[]
  readonly sensitiveValues?: readonly string[]
}

export type PortableMigrationErrorCode =
  | 'PORTABLE_ACTIVE_WORK'
  | 'PORTABLE_SENSITIVE_VALUE'
  | 'PORTABLE_PRIVATE_PATH'
  | 'PORTABLE_SCHEMA_INCOMPATIBLE'
  | 'PORTABLE_CAPABILITY_MISSING'
  | 'PORTABLE_DESTINATION_CONFLICT'
  | 'PORTABLE_PLAN_STALE'
  | 'PORTABLE_ARTIFACT_CONFLICT'
  | 'PORTABLE_ARTIFACT_SOURCE_REQUIRED'

export class PortableMigrationError extends Error {
  constructor(
    readonly code: PortableMigrationErrorCode,
    readonly details: readonly string[] = []
  ) {
    super('Portable profile migration failed')
    this.name = 'PortableMigrationError'
  }
}

export async function exportPortableState(
  source: PortableStateSource,
  options: PortableExportOptions
): Promise<PortableExportManifest> {
  const snapshot = await source.snapshot()
  const active = [...(snapshot.activeWorkIds ?? [])].toSorted()
  if (active.length > 0) throw new PortableMigrationError('PORTABLE_ACTIVE_WORK', active)
  const records = snapshot.records
    .filter(
      (record) => options.includeSelectedHistory === true || record.category !== 'selected-history'
    )
    .map((record) => createPortableRecord(record))
  const artifacts = snapshot.artifacts.map((artifact) =>
    PortableArtifactReferenceSchema.parse(artifact)
  )
  const secretReferences = snapshot.secretReferences.map((reference) =>
    PortableSecretReferenceSchema.parse(reference)
  )
  const manifest: Omit<PortableExportManifest, 'contentDigest'> = {
    schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
    contractVersion: PORTABLE_CONTRACT_VERSION,
    exportId: options.exportId,
    sourceProfile: source.profile,
    createdAt: options.createdAt ?? new Date().toISOString(),
    quiesced: true,
    includesSelectedHistory: options.includeSelectedHistory === true,
    componentVersions: source.componentVersions,
    compatibility: {
      minimumSchemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
      contractVersion: PORTABLE_CONTRACT_VERSION,
      requiredCapabilities: [...(options.requiredCapabilities ?? [])],
      sourcePersistence: source.persistence,
      sourceObjectStore: source.objectStore,
    },
    records,
    artifacts,
    secretReferences,
    unsupportedReferences: [...(snapshot.unsupportedReferences ?? [])],
  }
  assertSafeExport(manifest, options.sensitiveValues ?? [])
  return finalizePortableManifest(manifest)
}

export interface PortableRecordInspection {
  readonly record: PortableRecord
  readonly state: 'missing' | 'equivalent' | 'conflict'
}

export interface PortableImportTransaction {
  put(record: PortableRecord): Promise<void>
  recordProvenance(provenance: PortableMigrationProvenance): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}

export interface PortableReferenceLineageLookup {
  readonly contextPackage: (reference: ContextPackageReference) => Promise<ContextPackage>
  readonly executionPlan: (reference: ExecutionPlanReference) => Promise<{
    readonly plan: ExecutionPlan
    readonly contextPackage: ContextPackage
  }>
}

export interface PortableReferenceClaims {
  readonly contextPackages: readonly ContextPackageReference[]
  readonly executionPlans: readonly (ExecutionPlanReference & { readonly schemaVersion: number })[]
}

export interface PortableStateDestination {
  readonly profile: DeploymentProfile
  readonly capabilities: ReadonlySet<string>
  readonly secretProviders: ReadonlySet<string>
  inspect(records: readonly PortableRecord[]): Promise<readonly PortableRecordInspection[]>
  begin(): Promise<PortableImportTransaction>
}

export interface PortableMigrationProvenance {
  readonly exportId: string
  readonly manifestDigest: `sha256:${string}`
  readonly sourceProfile: DeploymentProfile
  readonly destinationProfile: DeploymentProfile
  readonly appliedAt: string
  readonly recordCount: number
  readonly artifactCount: number
}

export interface PortableImportPlan {
  readonly schemaVersion: 1
  readonly manifestDigest: `sha256:${string}`
  readonly sourceProfile: DeploymentProfile
  readonly destinationProfile: DeploymentProfile
  readonly records: readonly PortableRecordInspection[]
  readonly artifactActions: readonly {
    readonly artifact: PortableArtifactReference
    readonly action: 'preserve-reference' | 'copy' | 'already-present'
  }[]
  readonly unresolvedSecretReferences: readonly PortableSecretReference[]
  readonly unsupportedReferences: readonly string[]
  readonly conflicts: readonly string[]
  readonly applicable: boolean
}

export interface PortableImportOptions {
  readonly copyArtifacts?: boolean
  readonly sourceObjectStore?: ObjectStore
  readonly destinationObjectStore?: ObjectStore
}

export async function planPortableImport(
  manifestInput: unknown,
  destination: PortableStateDestination,
  options: PortableImportOptions = {}
): Promise<PortableImportPlan> {
  let manifest: PortableExportManifest
  try {
    manifest = assertPortableManifest(manifestInput)
  } catch {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE')
  }
  assertSafeExport(manifest, [])
  const missingCapabilities = manifest.compatibility.requiredCapabilities.filter(
    (capability) => !destination.capabilities.has(capability)
  )
  if (missingCapabilities.length > 0) {
    throw new PortableMigrationError('PORTABLE_CAPABILITY_MISSING', missingCapabilities)
  }
  const records = await destination.inspect(manifest.records)
  const recordIdentities = new Set(
    manifest.records.map((record) => `${record.category}:${record.logicalId}:${record.revision}`)
  )
  if (
    records.length !== manifest.records.length ||
    records.some(
      ({ record }) =>
        !recordIdentities.has(`${record.category}:${record.logicalId}:${record.revision}`)
    )
  ) {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE')
  }
  const conflicts = records
    .filter(({ state }) => state === 'conflict')
    .map(({ record }) => `${record.category}:${record.logicalId}:${record.revision}`)
    .toSorted()
  const unresolvedSecretReferences = manifest.secretReferences.filter(
    (reference) => !destination.secretProviders.has(reference.provider)
  )
  const artifactActions = await Promise.all(
    manifest.artifacts.map(async (artifact) => ({
      artifact,
      action: await artifactAction(artifact, options),
    }))
  )
  return {
    schemaVersion: 1,
    manifestDigest: manifest.contentDigest,
    sourceProfile: manifest.sourceProfile,
    destinationProfile: destination.profile,
    records,
    artifactActions,
    unresolvedSecretReferences,
    unsupportedReferences: manifest.unsupportedReferences,
    conflicts,
    applicable:
      conflicts.length === 0 &&
      unresolvedSecretReferences.length === 0 &&
      manifest.unsupportedReferences.length === 0,
  }
}

export interface PortableImportResult {
  readonly outcome: 'applied' | 'replayed'
  readonly provenance: PortableMigrationProvenance
  readonly copiedArtifacts: readonly string[]
}

export async function applyPortableImport(
  manifestInput: unknown,
  plan: PortableImportPlan,
  destination: PortableStateDestination,
  options: PortableImportOptions = {},
  now: () => string = () => new Date().toISOString()
): Promise<PortableImportResult> {
  const manifest = assertPortableManifest(manifestInput)
  if (
    plan.manifestDigest !== manifest.contentDigest ||
    plan.destinationProfile !== destination.profile
  ) {
    throw new PortableMigrationError('PORTABLE_PLAN_STALE')
  }
  if (!plan.applicable)
    throw new PortableMigrationError('PORTABLE_DESTINATION_CONFLICT', plan.conflicts)
  const refreshed = await planPortableImport(manifest, destination, options)
  if (!samePlanState(plan, refreshed)) throw new PortableMigrationError('PORTABLE_PLAN_STALE')
  const missing = refreshed.records
    .filter(({ state }) => state === 'missing')
    .map(({ record }) => record)
  const copiedArtifacts: string[] = []
  let transaction: PortableImportTransaction | undefined
  try {
    for (const { artifact, action } of refreshed.artifactActions) {
      if (action !== 'copy') continue
      await copyArtifact(artifact, options)
      copiedArtifacts.push(artifact.key)
    }
    transaction = await destination.begin()
    for (const record of missing) await transaction.put(PortableRecordSchema.parse(record))
    const provenance = {
      exportId: manifest.exportId,
      manifestDigest: manifest.contentDigest,
      sourceProfile: manifest.sourceProfile,
      destinationProfile: destination.profile,
      appliedAt: now(),
      recordCount: missing.length,
      artifactCount: copiedArtifacts.length,
    } satisfies PortableMigrationProvenance
    await transaction.recordProvenance(provenance)
    await transaction.commit()
    return {
      outcome: missing.length === 0 && copiedArtifacts.length === 0 ? 'replayed' : 'applied',
      provenance,
      copiedArtifacts,
    }
  } catch (error) {
    await transaction?.rollback().catch(() => undefined)
    await Promise.all(
      copiedArtifacts.map(async (key) =>
        options.destinationObjectStore?.delete(key).catch(() => undefined)
      )
    )
    throw error
  }
}

function assertSafeExport(input: unknown, sensitiveValues: readonly string[]): void {
  const serialized = JSON.stringify(input)
  const leaked = sensitiveValues.filter((value) => value.length > 0 && serialized.includes(value))
  if (leaked.length > 0) throw new PortableMigrationError('PORTABLE_SENSITIVE_VALUE')
  inspectSafe(input)
}

function inspectSafe(value: unknown, key = ''): void {
  if (PROHIBITED_FIELD.test(key))
    throw new PortableMigrationError('PORTABLE_SENSITIVE_VALUE', [key])
  if (typeof value === 'string' && PRIVATE_PATH.test(value)) {
    throw new PortableMigrationError('PORTABLE_PRIVATE_PATH')
  }
  if (Array.isArray(value)) {
    for (const child of value) inspectSafe(child, key)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [childKey, child] of Object.entries(value)) inspectSafe(child, childKey)
  }
}

async function artifactAction(
  artifact: PortableArtifactReference,
  options: PortableImportOptions
): Promise<'preserve-reference' | 'copy' | 'already-present'> {
  if (!options.copyArtifacts) return 'preserve-reference'
  if (options.sourceObjectStore === undefined || options.destinationObjectStore === undefined) {
    throw new PortableMigrationError('PORTABLE_ARTIFACT_SOURCE_REQUIRED', [artifact.key])
  }
  try {
    const existing = await options.destinationObjectStore.head(artifact.key)
    if (existing.sha256 !== artifact.sha256 || existing.size !== artifact.size) {
      throw new PortableMigrationError('PORTABLE_ARTIFACT_CONFLICT', [artifact.key])
    }
    return 'already-present'
  } catch (error) {
    if (error instanceof PortableMigrationError) throw error
    if (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'OBJECT_STORE_NOT_FOUND'
    ) {
      return 'copy'
    }
    throw error
  }
}

async function copyArtifact(
  artifact: PortableArtifactReference,
  options: PortableImportOptions
): Promise<void> {
  const source = options.sourceObjectStore
  const destination = options.destinationObjectStore
  if (source === undefined || destination === undefined) {
    throw new PortableMigrationError('PORTABLE_ARTIFACT_SOURCE_REQUIRED', [artifact.key])
  }
  const object = await source.get(artifact.key)
  if (object.sha256 !== artifact.sha256 || object.size !== artifact.size) {
    throw new PortableMigrationError('PORTABLE_ARTIFACT_CONFLICT', [artifact.key])
  }
  const written = await destination.put({
    key: object.key,
    body: object.body,
    ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
    metadata: object.metadata,
  })
  if (written.sha256 !== artifact.sha256 || written.size !== artifact.size) {
    await destination.delete(artifact.key).catch(() => undefined)
    throw new PortableMigrationError('PORTABLE_ARTIFACT_CONFLICT', [artifact.key])
  }
}

function samePlanState(left: PortableImportPlan, right: PortableImportPlan): boolean {
  return (
    JSON.stringify(left.records) === JSON.stringify(right.records) &&
    JSON.stringify(left.artifactActions) === JSON.stringify(right.artifactActions) &&
    JSON.stringify(left.unresolvedSecretReferences) ===
      JSON.stringify(right.unresolvedSecretReferences) &&
    JSON.stringify(left.unsupportedReferences) === JSON.stringify(right.unsupportedReferences)
  )
}

export function portableJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export const PortablePersistenceNamespaces = Object.freeze({
  'agent-profiles': 'agent-profile',
  'agent-profile-versions': 'agent-profile',
  skills: 'skill',
  'skill-versions': 'skill',
  'project-states': 'project-state',
  'project-state-history': 'project-state',
  'context-packages': 'context-package',
  'context-authoring-commands': 'context-authoring-command',
  'execution-plans': 'execution-plan',
  'execution-validation-commands': 'execution-validation-command',
  'evaluation-runs': 'evaluation-run',
} as const)

type PortablePersistenceNamespace = keyof typeof PortablePersistenceNamespaces

export interface PersistencePortableStateSourceOptions {
  readonly persistence: PersistenceProvider
  readonly componentVersions: Readonly<Record<string, string>>
  readonly artifacts?: readonly PortableArtifactReference[]
  readonly secretReferences?: readonly PortableSecretReference[]
  readonly activeWorkIds?: () => Promise<readonly string[]>
  readonly unsupportedReferences?: readonly string[]
}

/** Exports the supported provider-neutral record subset without reading provider internals. */
export class PersistencePortableStateSource implements PortableStateSource {
  readonly profile: DeploymentProfile
  readonly persistence: 'sqlite' | 'postgresql'
  readonly objectStore: 'filesystem' | 's3-compatible'
  readonly componentVersions: Readonly<Record<string, string>>
  readonly #provider: PersistenceProvider
  readonly #artifacts: readonly PortableArtifactReference[]
  readonly #secretReferences: readonly PortableSecretReference[]
  readonly #activeWorkIds: (() => Promise<readonly string[]>) | undefined
  readonly #unsupportedReferences: readonly string[]

  constructor(options: PersistencePortableStateSourceOptions) {
    this.#provider = options.persistence
    this.profile = options.persistence.profile
    this.persistence = options.persistence.dialect
    this.objectStore =
      this.profile === 'cloud' || this.profile === 'hosted-server' ? 's3-compatible' : 'filesystem'
    this.componentVersions = { ...options.componentVersions }
    this.#artifacts = [...(options.artifacts ?? [])]
    this.#secretReferences = [...(options.secretReferences ?? [])]
    this.#activeWorkIds = options.activeWorkIds
    this.#unsupportedReferences = [...(options.unsupportedReferences ?? [])]
  }

  async snapshot(): Promise<PortableStateSnapshot> {
    const records: Omit<PortableRecord, 'contentDigest'>[] = []
    const currentProjectRevisions = new Map<string, number>()
    await this.#provider.transaction(async (transaction) => {
      for (const [namespace, category] of Object.entries(PortablePersistenceNamespaces)) {
        for (const record of await transaction.list(namespace)) {
          const logicalIdentity = portableIdentity(
            namespace as PortablePersistenceNamespace,
            record.value,
            record.id
          )
          if (namespace === 'project-states') {
            currentProjectRevisions.set(logicalIdentity, semanticRevision(record.value))
          }
          if (namespace === 'project-state-history') {
            const scope = logicalIdentity.slice(0, logicalIdentity.lastIndexOf(':'))
            if (currentProjectRevisions.get(scope) === semanticRevision(record.value)) continue
          }
          records.push({
            category,
            logicalId: `${namespace}/${logicalIdentity}`,
            revision: semanticRevision(record.value),
            value: record.value,
          })
        }
      }
      // Credential metadata is projected: secret references and status never leave the source.
      for (const credential of await listSqliteCredentials(transaction)) {
        records.push(portableCredentialRecord(toPortableCredentialMetadata(credential)))
      }
    })
    return {
      records,
      artifacts: this.#artifacts,
      secretReferences: this.#secretReferences,
      activeWorkIds: (await this.#activeWorkIds?.()) ?? [],
      unsupportedReferences: this.#unsupportedReferences,
    }
  }
}

export interface PersistencePortableStateDestinationOptions {
  readonly persistence: PersistenceProvider
  readonly capabilities: ReadonlySet<string>
  readonly secretProviders: ReadonlySet<string>
}

/** Imports the supported record subset atomically through PersistenceProvider transactions. */
export class PersistencePortableStateDestination implements PortableStateDestination {
  readonly profile: DeploymentProfile
  readonly capabilities: ReadonlySet<string>
  readonly secretProviders: ReadonlySet<string>
  readonly #provider: PersistenceProvider

  constructor(options: PersistencePortableStateDestinationOptions) {
    this.#provider = options.persistence
    this.profile = options.persistence.profile
    this.capabilities = new Set(options.capabilities)
    this.secretProviders = new Set(options.secretProviders)
  }

  inspect(records: readonly PortableRecord[]): Promise<readonly PortableRecordInspection[]> {
    return this.#provider.transaction(async (transaction) =>
      Promise.all(
        records.map(async (record) => {
          if (record.category === 'credential-metadata') {
            const credentialId = credentialLogicalId(record)
            const existing = await readSqliteCredential(transaction, credentialId)
            if (existing === undefined) return { record, state: 'missing' as const }
            return {
              record,
              state:
                createPortableRecord(
                  portableCredentialRecord(toPortableCredentialMetadata(existing))
                ).contentDigest === record.contentDigest
                  ? ('equivalent' as const)
                  : ('conflict' as const),
            }
          }
          const identity = persistenceIdentity(record)
          const existing = await transaction.get(identity.namespace, identity.id)
          if (existing === undefined) return { record, state: 'missing' as const }
          const existingPortable = createPortableRecord({
            category: record.category,
            logicalId: record.logicalId,
            revision: semanticRevision(existing.value),
            value: existing.value,
          })
          return {
            record,
            state:
              existingPortable.contentDigest === record.contentDigest
                ? ('equivalent' as const)
                : ('conflict' as const),
          }
        })
      )
    )
  }

  begin(): Promise<PortableImportTransaction> {
    const staged: PortableRecord[] = []
    let provenance: PortableMigrationProvenance | undefined
    let settled = false
    return Promise.resolve({
      put: async (record) => {
        if (settled) throw new Error('PORTABLE_TRANSACTION_SETTLED')
        staged.push(PortableRecordSchema.parse(record))
      },
      recordProvenance: async (value) => {
        if (settled) throw new Error('PORTABLE_TRANSACTION_SETTLED')
        provenance = { ...value }
      },
      commit: async () => {
        if (settled || provenance === undefined) throw new Error('PORTABLE_TRANSACTION_INVALID')
        const committedProvenance = provenance
        await this.#provider.transaction(async (transaction) => {
          for (const record of staged) {
            if (record.category === 'credential-metadata') {
              credentialLogicalId(record)
              const credential = importedCredential(record.value)
              const written = await writeSqliteCredential(transaction, credential)
              if (written !== 'inserted') {
                throw new PortableMigrationError('PORTABLE_PLAN_STALE', [record.logicalId])
              }
              await appendSqliteCredentialAudit(transaction, {
                action: 'credential.imported',
                credentialId: credential.metadata.credentialId,
                workspaceId: credential.metadata.workspaceId,
                revision: credential.metadata.revision,
                reasonCode: 'SECRET_REENTRY_REQUIRED',
                at: committedProvenance.appliedAt,
              })
              continue
            }
            const identity = persistenceIdentity(record)
            if ((await transaction.get(identity.namespace, identity.id)) !== undefined) {
              throw new PortableMigrationError('PORTABLE_PLAN_STALE', [record.logicalId])
            }
            await transaction.put({
              namespace: identity.namespace,
              id: identity.id,
              value: record.value,
            })
            if (identity.namespace === 'project-states' && isJsonObject(record.value)) {
              const historyIdentity = portableIdentity(
                'project-state-history',
                record.value,
                record.logicalId
              )
              const historyId = sqliteRecordId(historyIdentity.replaceAll(':', '\u001f'))
              if ((await transaction.get('project-state-history', historyId)) === undefined) {
                await transaction.put({
                  namespace: 'project-state-history',
                  id: historyId,
                  value: record.value,
                })
              }
            }
          }
          await validateAndResetImportedReferences(transaction, staged)
          const existingProvenance = await transaction.get(
            'profile-migrations',
            committedProvenance.exportId
          )
          if (existingProvenance === undefined) {
            await transaction.put({
              namespace: 'profile-migrations',
              id: committedProvenance.exportId,
              value: portableJson(committedProvenance),
            })
          } else if (!sameMigrationIdentity(existingProvenance.value, committedProvenance)) {
            throw new PortableMigrationError('PORTABLE_DESTINATION_CONFLICT', [
              `profile-migrations:${committedProvenance.exportId}`,
            ])
          }
        })
        settled = true
      },
      rollback: async () => {
        settled = true
        staged.length = 0
        provenance = undefined
      },
    })
  }
}

async function validateAndResetImportedReferences(
  transaction: PersistenceTransaction,
  staged: readonly PortableRecord[]
): Promise<void> {
  if (staged.length === 0) return
  const claims = await collectImportedPortableReferenceClaims(staged, {
    contextPackage: (reference) => readStoredContextPackage(transaction, reference),
    executionPlan: async (reference) => {
      const stored = await readStoredExecutionPlan(transaction, reference)
      return { plan: stored.plan, contextPackage: stored.context }
    },
  })

  for (const reference of claims.contextPackages) {
    await transaction.delete(
      REFERENCE_RETENTION_NAMESPACES.contextPackages,
      sqliteRecordId(reference.contextPackageId)
    )
  }
  for (const reference of claims.executionPlans) {
    await transaction.delete(
      REFERENCE_RETENTION_NAMESPACES.executionPlans,
      sqliteRecordId(reference.executionPlanId)
    )
  }
}

/** Validate every newly staged portable reference and collect exact immutable targets once. */
export async function collectImportedPortableReferenceClaims(
  staged: readonly PortableRecord[],
  lookup: PortableReferenceLineageLookup
): Promise<PortableReferenceClaims> {
  const contextReferences = new Map<string, ContextPackageReference>()
  const planReferences = new Map<
    string,
    ExecutionPlanReference & { readonly schemaVersion: number }
  >()

  const addContext = (reference: ContextPackageReference, logicalId: string) => {
    const parsed = ContextPackageReferenceSchema.parse(reference)
    const previous = contextReferences.get(parsed.contextPackageId)
    if (previous && previous.contentDigest !== parsed.contentDigest) {
      throw new PortableMigrationError('PORTABLE_PLAN_STALE', [logicalId])
    }
    contextReferences.set(parsed.contextPackageId, parsed)
  }
  const addPlan = (plan: ExecutionPlan, logicalId: string) => {
    const reference = ExecutionPlanReferenceSchema.parse({
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
    })
    const previous = planReferences.get(reference.executionPlanId)
    if (
      previous &&
      (previous.contentDigest !== reference.contentDigest ||
        previous.schemaVersion !== plan.schemaVersion)
    ) {
      throw new PortableMigrationError('PORTABLE_PLAN_STALE', [logicalId])
    }
    planReferences.set(reference.executionPlanId, {
      ...reference,
      schemaVersion: plan.schemaVersion,
    })
  }

  for (const record of staged) {
    if (record.category === 'context-package') {
      const package_ = parseImportedContextPackage(record)
      addContext(
        { contextPackageId: package_.contextPackageId, contentDigest: package_.contentDigest },
        record.logicalId
      )
      if (package_.parentContextPackage) {
        const parent = await lookup.contextPackage(package_.parentContextPackage)
        try {
          assertContextPackageDerivedFrom(parent, package_)
        } catch {
          throw new PortableMigrationError('PORTABLE_PLAN_STALE', [record.logicalId])
        }
        addContext(
          { contextPackageId: parent.contextPackageId, contentDigest: parent.contentDigest },
          record.logicalId
        )
      }
      continue
    }

    if (record.category === 'execution-plan') {
      const plan = parseImportedExecutionPlan(record)
      addPlan(plan, record.logicalId)
      const contextPackage = await lookup.contextPackage(plan.contextPackage)
      assertPlanContextScope(plan, contextPackage)
      addContext(
        {
          contextPackageId: contextPackage.contextPackageId,
          contentDigest: contextPackage.contentDigest,
        },
        record.logicalId
      )

      if (plan.parentExecutionPlan) {
        const parent = await lookup.executionPlan(plan.parentExecutionPlan)
        try {
          assertExecutionPlanDerivedFrom(parent.plan, plan, parent.contextPackage, contextPackage)
        } catch {
          throw new PortableMigrationError('PORTABLE_PLAN_STALE', [record.logicalId])
        }
        addPlan(parent.plan, record.logicalId)
        addContext(
          {
            contextPackageId: parent.contextPackage.contextPackageId,
            contentDigest: parent.contextPackage.contentDigest,
          },
          record.logicalId
        )
      }
      continue
    }

    if (record.category === 'context-authoring-command') {
      const command = ContextAuthoringCommandRecordSchema.parse(record.value)
      if (
        record.revision !== 0 ||
        record.logicalId !==
          `context-authoring-commands/${contextAuthoringCommandKey(command.scope)}`
      ) {
        throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
      }
      const package_ = await lookup.contextPackage(command.contextPackage)
      if (
        package_.projectState.workspaceId !== command.scope.workspaceId ||
        package_.projectState.projectId !== command.scope.projectId
      ) {
        throw new PortableMigrationError('PORTABLE_PLAN_STALE', [record.logicalId])
      }
      addContext(
        { contextPackageId: package_.contextPackageId, contentDigest: package_.contentDigest },
        record.logicalId
      )
      continue
    }

    if (record.category === 'execution-validation-command') {
      const command = ExecutionValidationCommandRecordSchema.parse(record.value)
      if (
        record.revision !== 0 ||
        record.logicalId !==
          `execution-validation-commands/${executionValidationCommandKey(command.scope)}`
      ) {
        throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
      }
      const target = await lookup.executionPlan(command.executionPlan)
      assertPlanContextScope(target.plan, target.contextPackage)
      try {
        assertExecutionValidationCommandPlan(command, target.plan)
      } catch {
        throw new PortableMigrationError('PORTABLE_PLAN_STALE', [record.logicalId])
      }
      addPlan(target.plan, record.logicalId)
      addContext(
        {
          contextPackageId: target.contextPackage.contextPackageId,
          contentDigest: target.contextPackage.contentDigest,
        },
        record.logicalId
      )
    }
  }

  return {
    contextPackages: [...contextReferences.values()].toSorted((left, right) =>
      compareCodePointOrder(left.contextPackageId, right.contextPackageId)
    ),
    executionPlans: [...planReferences.values()].toSorted((left, right) =>
      compareCodePointOrder(left.executionPlanId, right.executionPlanId)
    ),
  }
}

function parseImportedContextPackage(record: PortableRecord) {
  let package_: ReturnType<typeof ContextPackageSchema.parse>
  try {
    package_ = ContextPackageSchema.parse(record.value)
  } catch {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  }
  if (package_.parentContextPackage?.contextPackageId === package_.contextPackageId) {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  }
  try {
    package_ = assertContextPackageIntegrity(package_)
    if (package_.schemaVersion !== 1 || executionScopeOf(package_.projectState).kind !== 'project')
      throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  } catch {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  }
  if (
    record.revision !== 0 ||
    record.logicalId !== `context-packages/${package_.contextPackageId}`
  ) {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  }
  return package_
}

function parseImportedExecutionPlan(record: PortableRecord) {
  let plan: ReturnType<typeof ExecutionPlanSchema.parse>
  try {
    plan = ExecutionPlanSchema.parse(record.value)
  } catch {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  }
  if (plan.parentExecutionPlan?.executionPlanId === plan.executionPlanId) {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  }
  try {
    plan = assertExecutionPlanIntegrity(plan)
    if (plan.schemaVersion !== 1 || executionScopeOf(plan.correlation).kind !== 'project')
      throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  } catch {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  }
  if (record.revision !== 0 || record.logicalId !== `execution-plans/${plan.executionPlanId}`) {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  }
  return plan
}

async function readStoredContextPackage(
  transaction: PersistenceTransaction,
  input: unknown
): Promise<ReturnType<typeof ContextPackageSchema.parse>> {
  const reference = ContextPackageReferenceSchema.parse(input)
  const stored = await transaction.get(
    'context-packages',
    sqliteRecordId(reference.contextPackageId)
  )
  if (stored === undefined) {
    throw new PortableMigrationError('PORTABLE_PLAN_STALE', [reference.contextPackageId])
  }
  let package_: ReturnType<typeof ContextPackageSchema.parse>
  try {
    package_ = assertContextPackageIntegrity(ContextPackageSchema.parse(stored.value))
    if (package_.schemaVersion !== 1 || executionScopeOf(package_.projectState).kind !== 'project')
      throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [reference.contextPackageId])
  } catch {
    throw new PortableMigrationError('PORTABLE_PLAN_STALE', [reference.contextPackageId])
  }
  if (
    package_.contextPackageId !== reference.contextPackageId ||
    package_.contentDigest !== reference.contentDigest
  ) {
    throw new PortableMigrationError('PORTABLE_PLAN_STALE', [reference.contextPackageId])
  }
  return package_
}

async function readStoredExecutionPlan(
  transaction: PersistenceTransaction,
  input: unknown
): Promise<{
  readonly plan: ReturnType<typeof ExecutionPlanSchema.parse>
  readonly context: ReturnType<typeof ContextPackageSchema.parse>
}> {
  const reference = ExecutionPlanReferenceSchema.parse(input)
  let plan: ReturnType<typeof ExecutionPlanSchema.parse>
  try {
    plan = await assertSqliteStoredPlanReference(transaction, reference)
  } catch {
    throw new PortableMigrationError('PORTABLE_PLAN_STALE', [reference.executionPlanId])
  }
  if (
    plan.executionPlanId !== reference.executionPlanId ||
    plan.contentDigest !== reference.contentDigest
  ) {
    throw new PortableMigrationError('PORTABLE_PLAN_STALE', [reference.executionPlanId])
  }
  const context = await readStoredContextPackage(transaction, plan.contextPackage)
  assertPlanContextScope(plan, context)
  return { plan, context }
}

function assertPlanContextScope(
  plan: ReturnType<typeof ExecutionPlanSchema.parse>,
  context: ReturnType<typeof ContextPackageSchema.parse>
): void {
  if (
    plan.contextPackage.contextPackageId !== context.contextPackageId ||
    plan.contextPackage.contentDigest !== context.contentDigest ||
    plan.contextPackage.schemaVersion !== context.schemaVersion ||
    plan.contextPackage.compilerVersion !== context.compiler.version ||
    plan.correlation.projectId === undefined ||
    context.projectState.projectId === undefined ||
    plan.correlation.workspaceId !== context.projectState.workspaceId ||
    plan.correlation.projectId !== context.projectState.projectId
  ) {
    throw new PortableMigrationError('PORTABLE_PLAN_STALE', [plan.executionPlanId])
  }
}

function sameMigrationIdentity(
  existing: JsonValue,
  expected: PortableMigrationProvenance
): boolean {
  return (
    isJsonObject(existing) &&
    existing['exportId'] === expected.exportId &&
    existing['manifestDigest'] === expected.manifestDigest &&
    existing['sourceProfile'] === expected.sourceProfile &&
    existing['destinationProfile'] === expected.destinationProfile
  )
}

function persistenceIdentity(record: PortableRecord): {
  readonly namespace: PortablePersistenceNamespace
  readonly id: string
} {
  const separator = record.logicalId.indexOf('/')
  const namespace = record.logicalId.slice(0, separator) as PortablePersistenceNamespace
  const id = record.logicalId.slice(separator + 1)
  if (
    separator <= 0 ||
    id.length === 0 ||
    PortablePersistenceNamespaces[namespace] !== record.category
  ) {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  }
  return {
    namespace,
    id:
      namespace === 'context-authoring-commands' ||
      namespace === 'execution-validation-commands' ||
      namespace === 'evaluation-runs'
        ? `r-${id}`
        : sqliteRecordId(
            namespace === 'project-states' || namespace === 'project-state-history'
              ? id.replaceAll(':', '\u001f')
              : id
          ),
  }
}

function portableIdentity(
  namespace: PortablePersistenceNamespace,
  value: JsonValue,
  fallback: string
): string {
  if (namespace === 'evaluation-runs') {
    const key = portableEvaluationRunKey(EvalRunSchema.parse(value).evalRunId)
    if (`r-${key}` !== fallback)
      throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [key])
    return key
  }
  if (namespace === 'execution-validation-commands') {
    const key = executionValidationCommandKey(
      ExecutionValidationCommandRecordSchema.parse(value).scope
    )
    if (`r-${key}` !== fallback)
      throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [key])
    return key
  }
  if (namespace === 'context-authoring-commands') {
    const key = contextAuthoringCommandKey(ContextAuthoringCommandRecordSchema.parse(value).scope)
    if (`r-${key}` !== fallback)
      throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [key])
    return key
  }
  if (!isJsonObject(value)) return fallback
  if (namespace === 'agent-profiles' && typeof value['profileId'] === 'string') {
    return value['profileId']
  }
  if (namespace === 'agent-profile-versions' && typeof value['profileVersionId'] === 'string') {
    return value['profileVersionId']
  }
  if (namespace === 'skills' && typeof value['skillId'] === 'string') return value['skillId']
  if (namespace === 'skill-versions' && typeof value['skillVersionId'] === 'string') {
    return value['skillVersionId']
  }
  if (
    (namespace === 'project-states' || namespace === 'project-state-history') &&
    typeof value['workspaceId'] === 'string' &&
    typeof value['projectId'] === 'string'
  ) {
    return namespace === 'project-state-history' && typeof value['revision'] === 'number'
      ? `${value['workspaceId']}:${value['projectId']}:${String(value['revision'])}`
      : `${value['workspaceId']}:${value['projectId']}`
  }
  if (namespace === 'context-packages' && typeof value['contextPackageId'] === 'string') {
    return value['contextPackageId']
  }
  if (namespace === 'execution-plans' && typeof value['executionPlanId'] === 'string') {
    return value['executionPlanId']
  }
  return fallback
}

export function portableCredentialRecord(
  credential: unknown
): Omit<PortableRecord, 'contentDigest'> {
  const parsed = PortableCredentialMetadataSchema.parse(credential)
  return {
    category: 'credential-metadata',
    logicalId: `credentials/${parsed.credentialId}`,
    revision: parsed.revision,
    value: portableJson(parsed),
  }
}

function credentialLogicalId(record: PortableRecord): string {
  const parsed = PortableCredentialMetadataSchema.safeParse(record.value)
  if (
    !parsed.success ||
    record.logicalId !== `credentials/${parsed.data.credentialId}` ||
    record.revision !== parsed.data.revision
  ) {
    throw new PortableMigrationError('PORTABLE_SCHEMA_INCOMPATIBLE', [record.logicalId])
  }
  return parsed.data.credentialId
}

function sqliteRecordId(value: string): string {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

function semanticRevision(value: JsonValue): number {
  if (
    isJsonObject(value) &&
    Number.isSafeInteger(value['revision']) &&
    (value['revision'] as number) >= 0
  ) {
    return value['revision'] as number
  }
  return 0
}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
