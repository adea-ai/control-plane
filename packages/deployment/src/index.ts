import type { JsonValue } from './json.js'

export type { JsonValue } from './json.js'
export * from './checkpoint.js'
export * from './process-runtime.js'
export * from './local-adapters.js'

export const DeploymentProfiles = Object.freeze({
  cloud: 'cloud',
  local: 'local',
  hostedSimple: 'hosted-simple',
  hostedServer: 'hosted-server',
} as const)

export type DeploymentProfile = (typeof DeploymentProfiles)[keyof typeof DeploymentProfiles]

export interface DeploymentComponentHealth {
  readonly ready: boolean
  readonly component: string
  readonly version: string
  readonly details?: Readonly<Record<string, string | number | boolean>>
}

export interface PersistenceRecord {
  readonly namespace: string
  readonly id: string
  readonly revision: number
  readonly value: JsonValue
  readonly updatedAt: string
}

export interface PersistenceWrite {
  readonly namespace: string
  readonly id: string
  readonly expectedRevision?: number
  readonly value: JsonValue
}

export interface PersistenceTransaction {
  get(namespace: string, id: string): Promise<PersistenceRecord | undefined>
  put(write: PersistenceWrite): Promise<PersistenceRecord>
  delete(namespace: string, id: string, expectedRevision?: number): Promise<boolean>
  list(namespace: string): Promise<readonly PersistenceRecord[]>
  /** Exclusive storage-ID cursor; does not imply ordering by fields inside value. */
  scan(namespace: string, options: PersistenceScan): Promise<readonly PersistenceRecord[]>
}

export interface PersistenceScan {
  readonly afterId?: string
  /** Maximum records returned, an integer from 1 through 128. */
  readonly limit: number
}

export interface PersistenceBackup {
  readonly schemaVersion: number
  readonly createdAt: string
  readonly digest: `sha256:${string}`
  readonly bytes: Uint8Array
}

export interface PersistenceProvider {
  readonly profile: DeploymentProfile
  readonly dialect: 'postgresql' | 'sqlite'
  migrate(): Promise<void>
  health(): Promise<DeploymentComponentHealth>
  transaction<Result>(
    operation: (transaction: PersistenceTransaction) => Promise<Result>
  ): Promise<Result>
  backup?(): Promise<PersistenceBackup>
  restore?(backup: PersistenceBackup): Promise<void>
  close(): void | Promise<void>
}

export interface WorkflowRuntime {
  readonly profile: DeploymentProfile
  start(): Promise<void>
  health(): Promise<DeploymentComponentHealth>
  stop(): Promise<void>
}

export interface CoordinationLease {
  readonly key: string
  readonly owner: string
  readonly expiresAt: string
  release(): Promise<void>
}

export interface CoordinationProvider {
  acquire(key: string, owner: string, ttlMs: number): Promise<CoordinationLease | undefined>
  close(): void | Promise<void>
}

export interface SecretReference {
  readonly provider: string
  readonly key: string
  readonly version?: string
}

export interface SecretUse {
  readonly purpose: string
  readonly workspaceId?: string
  readonly operation?: string
}

export interface SecretLease {
  readonly reference: SecretReference
  readonly expiresAt?: string
  readonly value: Uint8Array
  close(): void
}

export interface SecretsProvider {
  resolve(reference: SecretReference, use: SecretUse): Promise<SecretLease>
  health(): Promise<DeploymentComponentHealth>
  close(): void | Promise<void>
}

export interface ProcessLaunchRequest {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly environment?: Readonly<Record<string, string>>
}

export interface ProcessHandle {
  readonly pid: number
  readonly startedAt: string
  wait(): Promise<number>
  stop(signal?: NodeJS.Signals): Promise<void>
}

export interface ProcessRuntimeProvider {
  launch(request: ProcessLaunchRequest): Promise<ProcessHandle>
}

export interface ServiceEndpoint {
  readonly service: string
  readonly url: URL
  readonly private: boolean
}

export interface ServiceDiscovery {
  resolve(service: string): Promise<ServiceEndpoint>
}

export interface ObservabilityEvent {
  readonly name: string
  readonly occurredAt: string
  readonly attributes: Readonly<Record<string, string | number | boolean>>
}

export interface ObservabilityProvider {
  record(event: ObservabilityEvent): void | Promise<void>
  health(): Promise<DeploymentComponentHealth>
  close(): void | Promise<void>
}

export type ObjectStoreErrorCode =
  | 'OBJECT_STORE_INVALID_INPUT'
  | 'OBJECT_STORE_TOO_LARGE'
  | 'OBJECT_STORE_NOT_FOUND'
  | 'OBJECT_STORE_INTEGRITY_FAILURE'
  | 'OBJECT_STORE_PROVIDER_FAILURE'

export interface StoredObjectDescriptor {
  readonly key: string
  readonly size: number
  readonly contentType?: string
  readonly etag?: string
  readonly sha256: `sha256:${string}`
  readonly metadata: Readonly<Record<string, string>>
}

export interface StoredObject extends StoredObjectDescriptor {
  readonly body: Uint8Array
}

export interface PutObjectInput {
  readonly key: string
  readonly body: Uint8Array
  readonly contentType?: string
  readonly metadata?: Readonly<Record<string, string>>
}

export interface ObjectStore {
  put(input: PutObjectInput): Promise<StoredObjectDescriptor>
  get(key: string): Promise<StoredObject>
  head(key: string): Promise<StoredObjectDescriptor>
  delete(key: string): Promise<void>
  close(): void | Promise<void>
}

export interface DeploymentComposition {
  readonly profile: DeploymentProfile
  readonly persistence: PersistenceProvider
  readonly workflow: WorkflowRuntime
  readonly objectStore: ObjectStore
  readonly secrets: SecretsProvider
  readonly coordination: CoordinationProvider
  readonly processes: ProcessRuntimeProvider
  readonly discovery: ServiceDiscovery
  readonly observability: ObservabilityProvider
}
