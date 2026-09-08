import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'
import { RuntimeCapabilitySchema, type RuntimeCapability } from './capabilities.js'
import {
  RuntimeAvailabilityStateSchema,
  RuntimeCapabilityVerificationSchema,
  RuntimeCompatibilityStateSchema,
  RuntimeConnectionIdentityDigestSchema,
  RuntimeConnectionLocationSchema,
  RuntimeConnectionSchema,
  RuntimeConnectionStatusSchema,
  RuntimeConnectionTypeSchema,
  RuntimeDiagnosticCodeSchema,
  RuntimeHealthSchema,
  RuntimeOpaqueNativeRefSchema,
  RuntimeSemanticVersionSchema,
  RuntimeTimestampSchema,
  type RuntimeConnection,
} from './models.js'

const uniqueCapabilities = (capabilities: RuntimeCapability[]) =>
  new Set(capabilities.map((capability) => capability.name)).size === capabilities.length

export const RuntimeConnectionRegistrationSchema = z
  .object({
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    identityDigest: RuntimeConnectionIdentityDigestSchema,
    connectionType: RuntimeConnectionTypeSchema,
    runtimeNodeRefId: IdentifierSchemas.runtimeNodeRefId.optional(),
    runtimeDefinitionId: IdentifierSchemas.runtimeDefinitionId,
    location: RuntimeConnectionLocationSchema,
    opaqueNativeRef: RuntimeOpaqueNativeRefSchema.optional(),
    adapterVersion: RuntimeSemanticVersionSchema,
    driverVersion: RuntimeSemanticVersionSchema,
    harnessVersion: RuntimeSemanticVersionSchema,
    status: RuntimeConnectionStatusSchema.exclude(['disconnected', 'expired', 'revoked']),
    health: RuntimeHealthSchema,
    capabilities: z.array(RuntimeCapabilitySchema).max(64).refine(uniqueCapabilities),
    compatibilityState: RuntimeCompatibilityStateSchema.exclude(['revoked']),
    limitations: z.array(z.string().min(1).max(512)).max(64),
    lastDiscoveredAt: RuntimeTimestampSchema,
    lastHeartbeatAt: RuntimeTimestampSchema,
    lastHealthCheckAt: RuntimeTimestampSchema,
    expiresAt: RuntimeTimestampSchema.optional(),
  })
  .strict()

export const RuntimeConnectionUpdateSchema = z
  .object({
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    expectedVersion: z.number().int().positive(),
    observedAt: RuntimeTimestampSchema,
    adapterVersion: RuntimeSemanticVersionSchema.optional(),
    driverVersion: RuntimeSemanticVersionSchema.optional(),
    harnessVersion: RuntimeSemanticVersionSchema.optional(),
    status: RuntimeConnectionStatusSchema.exclude(['revoked']).optional(),
    health: RuntimeHealthSchema.optional(),
    capabilities: z.array(RuntimeCapabilitySchema).max(64).refine(uniqueCapabilities).optional(),
    compatibilityState: RuntimeCompatibilityStateSchema.exclude(['revoked']).optional(),
    availabilityState: RuntimeAvailabilityStateSchema.exclude(['revoked']).optional(),
    protocolVersion: RuntimeSemanticVersionSchema.optional(),
    capabilitySnapshotVersion: z.number().int().positive().optional(),
    capabilitySnapshotObservedAt: RuntimeTimestampSchema.optional(),
    capabilitySnapshotExpiresAt: RuntimeTimestampSchema.optional(),
    capabilityVerification: RuntimeCapabilityVerificationSchema.optional(),
    lastHealthReportSequence: z.number().int().positive().optional(),
    lastHealthReportDigest: RuntimeConnectionIdentityDigestSchema.optional(),
    limitations: z.array(z.string().min(1).max(512)).max(64).optional(),
    diagnostics: z.array(RuntimeDiagnosticCodeSchema).max(64).optional(),
    lastDiscoveredAt: RuntimeTimestampSchema.optional(),
    lastHeartbeatAt: RuntimeTimestampSchema.optional(),
    lastHealthCheckAt: RuntimeTimestampSchema.optional(),
    expiresAt: RuntimeTimestampSchema.optional(),
  })
  .strict()

const RuntimeConnectionTransitionSchema = z
  .object({
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    expectedVersion: z.number().int().positive(),
    observedAt: RuntimeTimestampSchema,
  })
  .strict()

export type RuntimeConnectionRegistration = z.input<typeof RuntimeConnectionRegistrationSchema>
export type RuntimeConnectionUpdate = z.input<typeof RuntimeConnectionUpdateSchema>

export const RuntimeConnectionScanSchema = z
  .object({
    runtimeNodeRefId: IdentifierSchemas.runtimeNodeRefId,
    afterConnectionId: IdentifierSchemas.runtimeConnectionId.optional(),
    limit: z.number().int().min(1).max(128),
  })
  .strict()
export type RuntimeConnectionScan = z.output<typeof RuntimeConnectionScanSchema>
export interface RuntimeConnectionScanner {
  scanByRuntimeNode(input: RuntimeConnectionScan): Promise<readonly RuntimeConnection[]>
}

export interface RuntimeConnectionRepository {
  insert(connection: RuntimeConnection): Promise<boolean>
  get(runtimeConnectionId: string): Promise<RuntimeConnection | undefined>
  getByIdentityDigest(identityDigest: string): Promise<RuntimeConnection | undefined>
  compareAndSet(expectedVersion: number, connection: RuntimeConnection): Promise<boolean>
  listByRuntimeNode(runtimeNodeRefId: string): Promise<readonly RuntimeConnection[]>
}

export type RuntimeConnectionRegistryErrorCode =
  | 'CONNECTION_MISSING'
  | 'CONNECTION_REVOKED'
  | 'CONNECTION_NOT_EXPIRED'
  | 'STABLE_IDENTITY_CONFLICT'
  | 'STALE_CONNECTION_VERSION'
  | 'STALE_OBSERVATION'
  | 'OBSERVATION_CONFLICT'

export class RuntimeConnectionRegistryError extends Error {
  constructor(readonly code: RuntimeConnectionRegistryErrorCode) {
    super(code)
    this.name = 'RuntimeConnectionRegistryError'
  }
}

export class RuntimeConnectionRegistry {
  constructor(readonly repository: RuntimeConnectionRepository) {}

  async register(input: RuntimeConnectionRegistration): Promise<RuntimeConnection> {
    const registration = RuntimeConnectionRegistrationSchema.parse(input)
    const existing = await this.repository.getByIdentityDigest(registration.identityDigest)
    if (existing) return this.#registerExisting(existing, registration)
    const createdAt = registration.lastDiscoveredAt
    const connection = RuntimeConnectionSchema.parse({
      ...registration,
      version: 1,
      createdAt,
      updatedAt: latest(
        registration.lastDiscoveredAt,
        registration.lastHeartbeatAt,
        registration.lastHealthCheckAt
      ),
    })
    if (await this.repository.insert(connection)) return connection
    return this.register(registration)
  }

  async get(runtimeConnectionId: string): Promise<RuntimeConnection | undefined> {
    const parsedId = IdentifierSchemas.runtimeConnectionId.parse(runtimeConnectionId)
    const connection = await this.repository.get(parsedId)
    return connection ? clone(connection) : undefined
  }

  async listByRuntimeNode(runtimeNodeRefId: string): Promise<readonly RuntimeConnection[]> {
    const parsedId = IdentifierSchemas.runtimeNodeRefId.parse(runtimeNodeRefId)
    return (await this.repository.listByRuntimeNode(parsedId)).map(clone)
  }

  async update(input: RuntimeConnectionUpdate): Promise<RuntimeConnection> {
    const update = RuntimeConnectionUpdateSchema.parse(input)
    const current = await this.#required(update.runtimeConnectionId)
    this.#assertMutable(current)
    this.#assertVersion(current, update.expectedVersion)
    const observed = Date.parse(update.observedAt)
    const currentObserved = Date.parse(current.updatedAt)
    const values = mutableUpdate(update)
    if (observed < currentObserved) fail('STALE_OBSERVATION')
    if (observed === currentObserved) {
      if (matches(current, values)) return current
      fail('OBSERVATION_CONFLICT')
    }
    const next = RuntimeConnectionSchema.parse({
      ...current,
      ...values,
      version: current.version + 1,
      updatedAt: update.observedAt,
    })
    if (!(await this.repository.compareAndSet(current.version, next))) {
      fail('STALE_CONNECTION_VERSION')
    }
    return next
  }

  disconnect(input: unknown): Promise<RuntimeConnection> {
    return this.#transition(input, 'disconnected', 'unavailable')
  }

  async expire(input: unknown): Promise<RuntimeConnection> {
    const transition = RuntimeConnectionTransitionSchema.parse(input)
    const current = await this.#required(transition.runtimeConnectionId)
    if (!current.expiresAt || Date.parse(transition.observedAt) < Date.parse(current.expiresAt)) {
      fail('CONNECTION_NOT_EXPIRED')
    }
    return this.#transition(transition, 'expired', 'unavailable')
  }

  revoke(input: unknown): Promise<RuntimeConnection> {
    return this.#transition(input, 'revoked', 'unavailable', 'revoked')
  }

  async #registerExisting(
    existing: RuntimeConnection,
    registration: z.output<typeof RuntimeConnectionRegistrationSchema>
  ): Promise<RuntimeConnection> {
    this.#assertMutable(existing)
    if (!runtimeConnectionsShareStableIdentity(existing, registration))
      fail('STABLE_IDENTITY_CONFLICT')
    const discovered = Date.parse(registration.lastDiscoveredAt)
    const currentDiscovered = Date.parse(existing.lastDiscoveredAt)
    if (discovered < currentDiscovered) fail('STALE_OBSERVATION')
    if (discovered === currentDiscovered) {
      if (registrationMatches(existing, registration)) return existing
      fail('OBSERVATION_CONFLICT')
    }
    const next = RuntimeConnectionSchema.parse({
      ...existing,
      ...registration,
      version: existing.version + 1,
      updatedAt: latest(
        registration.lastDiscoveredAt,
        registration.lastHeartbeatAt,
        registration.lastHealthCheckAt
      ),
    })
    if (await this.repository.compareAndSet(existing.version, next)) return next
    return this.register(registration)
  }

  async #transition(
    input: unknown,
    status: 'disconnected' | 'expired' | 'revoked',
    health: 'unavailable',
    compatibilityState?: 'revoked'
  ): Promise<RuntimeConnection> {
    const transition = RuntimeConnectionTransitionSchema.parse(input)
    const current = await this.#required(transition.runtimeConnectionId)
    this.#assertMutable(current)
    this.#assertVersion(current, transition.expectedVersion)
    if (Date.parse(transition.observedAt) < Date.parse(current.updatedAt)) fail('STALE_OBSERVATION')
    const next = RuntimeConnectionSchema.parse({
      ...current,
      status,
      health,
      ...(compatibilityState ? { compatibilityState } : {}),
      ...(status === 'revoked' ? { availabilityState: 'revoked' } : {}),
      version: current.version + 1,
      updatedAt: transition.observedAt,
    })
    if (!(await this.repository.compareAndSet(current.version, next))) {
      fail('STALE_CONNECTION_VERSION')
    }
    return next
  }

  async #required(runtimeConnectionId: string): Promise<RuntimeConnection> {
    const connection = await this.repository.get(runtimeConnectionId)
    if (!connection) fail('CONNECTION_MISSING')
    return connection
  }

  #assertMutable(connection: RuntimeConnection): void {
    if (connection.status === 'revoked') fail('CONNECTION_REVOKED')
  }

  #assertVersion(connection: RuntimeConnection, expectedVersion: number): void {
    if (connection.version !== expectedVersion) fail('STALE_CONNECTION_VERSION')
  }
}

export class InMemoryRuntimeConnectionRepository
  implements RuntimeConnectionRepository, RuntimeConnectionScanner
{
  readonly #connections = new Map<string, RuntimeConnection>()
  readonly #identities = new Map<string, string>()

  async insert(connectionInput: RuntimeConnection): Promise<boolean> {
    const connection = RuntimeConnectionSchema.parse(connectionInput)
    if (
      this.#connections.has(connection.runtimeConnectionId) ||
      this.#identities.has(connection.identityDigest)
    ) {
      return false
    }
    this.#connections.set(connection.runtimeConnectionId, clone(connection))
    this.#identities.set(connection.identityDigest, connection.runtimeConnectionId)
    return true
  }

  async get(runtimeConnectionId: string): Promise<RuntimeConnection | undefined> {
    return cloneOptional(this.#connections.get(runtimeConnectionId))
  }

  async getByIdentityDigest(identityDigest: string): Promise<RuntimeConnection | undefined> {
    const runtimeConnectionId = this.#identities.get(identityDigest)
    return runtimeConnectionId ? this.get(runtimeConnectionId) : undefined
  }

  async compareAndSet(
    expectedVersion: number,
    connectionInput: RuntimeConnection
  ): Promise<boolean> {
    const connection = RuntimeConnectionSchema.parse(connectionInput)
    const current = this.#connections.get(connection.runtimeConnectionId)
    if (!current || current.version !== expectedVersion) return false
    if (!runtimeConnectionsShareStableIdentity(current, connection)) return false
    this.#connections.set(connection.runtimeConnectionId, clone(connection))
    return true
  }

  async listByRuntimeNode(runtimeNodeRefId: string): Promise<readonly RuntimeConnection[]> {
    return [...this.#connections.values()]
      .filter((connection) => connection.runtimeNodeRefId === runtimeNodeRefId)
      .sort((left, right) => left.runtimeConnectionId.localeCompare(right.runtimeConnectionId))
      .map(clone)
  }

  async scanByRuntimeNode(input: RuntimeConnectionScan): Promise<readonly RuntimeConnection[]> {
    const { runtimeNodeRefId, afterConnectionId, limit } = RuntimeConnectionScanSchema.parse(input)
    return (await this.listByRuntimeNode(runtimeNodeRefId))
      .filter(
        (row) => afterConnectionId === undefined || row.runtimeConnectionId > afterConnectionId
      )
      .slice(0, limit)
  }
}

export function runtimeConnectionsShareStableIdentity(
  left: RuntimeConnection,
  right: Pick<
    RuntimeConnection,
    | 'runtimeConnectionId'
    | 'identityDigest'
    | 'connectionType'
    | 'runtimeNodeRefId'
    | 'runtimeDefinitionId'
    | 'location'
    | 'opaqueNativeRef'
  >
): boolean {
  return (
    left.runtimeConnectionId === right.runtimeConnectionId &&
    left.identityDigest === right.identityDigest &&
    left.connectionType === right.connectionType &&
    left.runtimeNodeRefId === right.runtimeNodeRefId &&
    left.runtimeDefinitionId === right.runtimeDefinitionId &&
    left.location === right.location &&
    left.opaqueNativeRef === right.opaqueNativeRef
  )
}

function registrationMatches(
  connection: RuntimeConnection,
  registration: z.output<typeof RuntimeConnectionRegistrationSchema>
): boolean {
  return matches(connection, registration)
}

function matches(connection: RuntimeConnection, values: Record<string, unknown>): boolean {
  return Object.entries(values).every(
    ([key, value]) =>
      JSON.stringify(connection[key as keyof RuntimeConnection]) === JSON.stringify(value)
  )
}

function mutableUpdate(
  update: z.output<typeof RuntimeConnectionUpdateSchema>
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const key of [
    'adapterVersion',
    'driverVersion',
    'harnessVersion',
    'status',
    'health',
    'capabilities',
    'compatibilityState',
    'availabilityState',
    'protocolVersion',
    'capabilitySnapshotVersion',
    'capabilitySnapshotObservedAt',
    'capabilitySnapshotExpiresAt',
    'capabilityVerification',
    'lastHealthReportSequence',
    'lastHealthReportDigest',
    'limitations',
    'diagnostics',
    'lastDiscoveredAt',
    'lastHeartbeatAt',
    'lastHealthCheckAt',
    'expiresAt',
  ] as const) {
    if (update[key] !== undefined) values[key] = update[key]
  }
  return values
}

function latest(...timestamps: string[]): string {
  const [value] = [...timestamps].sort((left, right) => Date.parse(right) - Date.parse(left))
  if (!value) throw new Error('RUNTIME_CONNECTION_TIMESTAMP_REQUIRED')
  return value
}

function fail(code: RuntimeConnectionRegistryErrorCode): never {
  throw new RuntimeConnectionRegistryError(code)
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : clone(value)
}
