import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'
import { RuntimeCapabilityNameSchema } from './capabilities.js'
import { RuntimeEligibilityNodeStatusSchema } from './eligibility.js'
import {
  RuntimeConnectionSchema,
  RuntimeTimestampSchema,
  type RuntimeConnection,
} from './models.js'

const SessionOperationCapabilitySchema = RuntimeCapabilityNameSchema.refine((name) =>
  name.startsWith('session.')
)
const NormalizedCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/)
const SafeDisplayNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      !value.includes('/') &&
      !value.includes('\\') &&
      !value.includes('://') &&
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code >= 32 && code !== 127
      }),
    'Display names cannot contain paths, URLs, or control characters'
  )

export const OpaqueNativeSessionIdSchema = z
  .string()
  .regex(/^nses_[0-9A-HJKMNP-TV-Z]{26}$/, 'Expected a canonical opaque native-session ID')

export const ExternalSessionCapabilitySnapshotSchema = z
  .object({
    version: z.number().int().positive(),
    observedAt: RuntimeTimestampSchema,
    expiresAt: RuntimeTimestampSchema,
    operations: z
      .array(SessionOperationCapabilitySchema)
      .max(6)
      .refine((operations) => new Set(operations).size === operations.length),
  })
  .strict()
  .refine(
    (snapshot) => Date.parse(snapshot.expiresAt) > Date.parse(snapshot.observedAt),
    'Session capability expiry must follow its observation'
  )

export const ExternalSessionSafeMetadataSchema = z
  .object({
    origin: z.enum(['native_discovery', 'created_through_control_plane']),
    displayName: SafeDisplayNameSchema.optional(),
    limitations: z
      .array(NormalizedCodeSchema)
      .max(32)
      .refine((limitations) => new Set(limitations).size === limitations.length),
  })
  .strict()

export const ExternalSessionStateSchema = z.enum(['active', 'closed', 'removed', 'revoked'])

export const ExternalSessionSchema = z
  .object({
    externalSessionId: IdentifierSchemas.externalSessionId,
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    opaqueNativeSessionId: OpaqueNativeSessionIdSchema,
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId.optional(),
    state: ExternalSessionStateSchema,
    ownership: z
      .object({
        authority: z.literal('external_runtime'),
        imported: z.literal(false),
        concurrentNativeUse: z.literal('allowed'),
      })
      .strict(),
    capabilitySnapshot: ExternalSessionCapabilitySnapshotSchema,
    safeMetadata: ExternalSessionSafeMetadataSchema,
    lastObservedAt: RuntimeTimestampSchema,
    version: z.number().int().positive(),
    createdAt: RuntimeTimestampSchema,
    updatedAt: RuntimeTimestampSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (Date.parse(session.capabilitySnapshot.observedAt) > Date.parse(session.lastObservedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Capabilities cannot postdate session observation',
      })
    }
    if (
      Date.parse(session.updatedAt) < Date.parse(session.createdAt) ||
      Date.parse(session.lastObservedAt) < Date.parse(session.createdAt)
    ) {
      context.addIssue({ code: 'custom', message: 'Session timestamps cannot regress' })
    }
  })

const ExternalSessionRegistrationSchema = z
  .object({
    externalSessionId: IdentifierSchemas.externalSessionId,
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    opaqueNativeSessionId: OpaqueNativeSessionIdSchema,
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId.optional(),
    state: ExternalSessionStateSchema,
    ownership: ExternalSessionSchema.shape.ownership,
    capabilitySnapshot: ExternalSessionCapabilitySnapshotSchema,
    safeMetadata: ExternalSessionSafeMetadataSchema,
    lastObservedAt: RuntimeTimestampSchema,
  })
  .strict()

const ExternalSessionUpdateSchema = z
  .object({
    externalSessionId: IdentifierSchemas.externalSessionId,
    expectedVersion: z.number().int().positive(),
    observedAt: RuntimeTimestampSchema,
    state: ExternalSessionStateSchema.optional(),
    capabilitySnapshot: ExternalSessionCapabilitySnapshotSchema.optional(),
    safeMetadata: ExternalSessionSafeMetadataSchema.optional(),
  })
  .strict()
  .refine(
    (update) =>
      update.state !== undefined ||
      update.capabilitySnapshot !== undefined ||
      update.safeMetadata !== undefined,
    'Session update must change observed state'
  )

const ExternalSessionListScopeSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId.optional(),
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId.optional(),
  })
  .strict()

export type ExternalSession = z.output<typeof ExternalSessionSchema>
export type ExternalSessionListScope = z.output<typeof ExternalSessionListScopeSchema>

export interface ExternalSessionRepository {
  insert(session: ExternalSession): Promise<boolean>
  get(externalSessionId: string): Promise<ExternalSession | undefined>
  findByNativeIdentity(
    runtimeConnectionId: string,
    opaqueNativeSessionId: string
  ): Promise<ExternalSession | undefined>
  list(scope: ExternalSessionListScope): Promise<readonly ExternalSession[]>
  compareAndSet(expectedVersion: number, session: ExternalSession): Promise<boolean>
}

export class InMemoryExternalSessionRepository implements ExternalSessionRepository {
  readonly #sessions = new Map<string, ExternalSession>()

  async insert(session: ExternalSession): Promise<boolean> {
    if (
      this.#sessions.has(session.externalSessionId) ||
      [...this.#sessions.values()].some(
        (candidate) =>
          candidate.runtimeConnectionId === session.runtimeConnectionId &&
          candidate.opaqueNativeSessionId === session.opaqueNativeSessionId
      )
    ) {
      return false
    }
    this.#sessions.set(session.externalSessionId, clone(session))
    return true
  }

  async get(externalSessionId: string): Promise<ExternalSession | undefined> {
    return cloneOptional(this.#sessions.get(externalSessionId))
  }

  async findByNativeIdentity(
    runtimeConnectionId: string,
    opaqueNativeSessionId: string
  ): Promise<ExternalSession | undefined> {
    return cloneOptional(
      [...this.#sessions.values()].find(
        (session) =>
          session.runtimeConnectionId === runtimeConnectionId &&
          session.opaqueNativeSessionId === opaqueNativeSessionId
      )
    )
  }

  async list(scope: ExternalSessionListScope): Promise<readonly ExternalSession[]> {
    return [...this.#sessions.values()]
      .filter(
        (session) =>
          session.workspaceId === scope.workspaceId &&
          (scope.projectId === undefined || session.projectId === scope.projectId) &&
          (scope.runtimeConnectionId === undefined ||
            session.runtimeConnectionId === scope.runtimeConnectionId)
      )
      .toSorted((left, right) => left.externalSessionId.localeCompare(right.externalSessionId))
      .map(clone)
  }

  async compareAndSet(expectedVersion: number, session: ExternalSession): Promise<boolean> {
    if (this.#sessions.get(session.externalSessionId)?.version !== expectedVersion) return false
    this.#sessions.set(session.externalSessionId, clone(session))
    return true
  }
}

export type ExternalSessionRegistryErrorCode =
  | 'CAPABILITY_SNAPSHOT_CONFLICT'
  | 'CAPABILITY_SNAPSHOT_REGRESSION'
  | 'SESSION_IDENTITY_CONFLICT'
  | 'SESSION_MISSING'
  | 'SESSION_REVOKED'
  | 'STALE_SESSION_VERSION'
  | 'TIMESTAMP_REGRESSION'

export class ExternalSessionRegistryError extends Error {
  constructor(
    readonly code: ExternalSessionRegistryErrorCode,
    readonly currentVersion?: number
  ) {
    super(code)
    this.name = 'ExternalSessionRegistryError'
  }
}

export class ExternalSessionRegistry {
  constructor(readonly repository: ExternalSessionRepository) {}

  async register(inputValue: unknown): Promise<ExternalSession> {
    const input = normalizeRegistration(ExternalSessionRegistrationSchema.parse(inputValue))
    const existing = await this.repository.findByNativeIdentity(
      input.runtimeConnectionId,
      input.opaqueNativeSessionId
    )
    if (existing) {
      if (sameRegistration(existing, input)) return existing
      fail('SESSION_IDENTITY_CONFLICT')
    }
    const session = ExternalSessionSchema.parse({
      ...input,
      version: 1,
      createdAt: input.lastObservedAt,
      updatedAt: input.lastObservedAt,
    })
    if (!(await this.repository.insert(session))) {
      const raced = await this.repository.findByNativeIdentity(
        input.runtimeConnectionId,
        input.opaqueNativeSessionId
      )
      if (raced && sameRegistration(raced, input)) return raced
      fail('SESSION_IDENTITY_CONFLICT')
    }
    return session
  }

  async get(externalSessionIdValue: string): Promise<ExternalSession> {
    const externalSessionId = IdentifierSchemas.externalSessionId.parse(externalSessionIdValue)
    const session = await this.repository.get(externalSessionId)
    if (!session) fail('SESSION_MISSING')
    return ExternalSessionSchema.parse(session)
  }

  async list(scopeValue: unknown): Promise<readonly ExternalSession[]> {
    const scope = ExternalSessionListScopeSchema.parse(scopeValue)
    return Promise.all(
      (await this.repository.list(scope)).map((session) =>
        Promise.resolve(ExternalSessionSchema.parse(session))
      )
    )
  }

  async update(inputValue: unknown): Promise<ExternalSession> {
    const input = ExternalSessionUpdateSchema.parse(inputValue)
    const current = await this.get(input.externalSessionId)
    if (current.version !== input.expectedVersion) {
      fail('STALE_SESSION_VERSION', current.version)
    }
    if (current.state === 'revoked' && input.state !== 'revoked') fail('SESSION_REVOKED')
    if (Date.parse(input.observedAt) < Date.parse(current.lastObservedAt)) {
      fail('TIMESTAMP_REGRESSION')
    }
    const capabilitySnapshot =
      input.capabilitySnapshot === undefined
        ? undefined
        : normalizeSnapshot(input.capabilitySnapshot)
    if (capabilitySnapshot !== undefined) {
      if (
        capabilitySnapshot.version < current.capabilitySnapshot.version ||
        Date.parse(capabilitySnapshot.observedAt) <
          Date.parse(current.capabilitySnapshot.observedAt)
      ) {
        fail('CAPABILITY_SNAPSHOT_REGRESSION')
      }
      if (
        capabilitySnapshot.version === current.capabilitySnapshot.version &&
        JSON.stringify(capabilitySnapshot) !== JSON.stringify(current.capabilitySnapshot)
      ) {
        fail('CAPABILITY_SNAPSHOT_CONFLICT')
      }
    }
    const next = ExternalSessionSchema.parse({
      ...current,
      state: input.state ?? current.state,
      capabilitySnapshot: capabilitySnapshot ?? current.capabilitySnapshot,
      safeMetadata:
        input.safeMetadata === undefined
          ? current.safeMetadata
          : normalizeSafeMetadata(input.safeMetadata),
      lastObservedAt: input.observedAt,
      version: current.version + 1,
      updatedAt: input.observedAt,
    })
    if (!(await this.repository.compareAndSet(input.expectedVersion, next))) {
      const latest = await this.repository.get(input.externalSessionId)
      fail('STALE_SESSION_VERSION', latest?.version)
    }
    return next
  }
}

export const ExternalSessionAssessmentStateSchema = z.enum([
  'active',
  'closed',
  'stale',
  'offline',
  'runtime_missing',
  'capability_changed',
  'removed',
  'revoked',
])
export const ExternalSessionOperationUnavailableReasonSchema = z.enum([
  'CAPABILITY_NOT_ADVERTISED',
  'CAPABILITY_NO_LONGER_ADVERTISED',
  'RUNTIME_MISSING',
  'RUNTIME_OFFLINE',
  'SESSION_CAPABILITIES_STALE',
  'SESSION_CLOSED',
  'SESSION_REMOVED',
  'SESSION_REVOKED',
])
const ExternalSessionOperationAvailabilitySchema = z.union([
  z.object({ available: z.literal(true) }).strict(),
  z
    .object({
      available: z.literal(false),
      reason: ExternalSessionOperationUnavailableReasonSchema,
    })
    .strict(),
])

export const ExternalSessionAssessmentSchema = z
  .object({
    state: ExternalSessionAssessmentStateSchema,
    recoverable: z.boolean(),
    evaluatedAt: RuntimeTimestampSchema.optional(),
    operations: z
      .object({
        reference: ExternalSessionOperationAvailabilitySchema,
        resume: ExternalSessionOperationAvailabilitySchema,
        load: ExternalSessionOperationAvailabilitySchema,
        close: ExternalSessionOperationAvailabilitySchema,
        history: ExternalSessionOperationAvailabilitySchema,
      })
      .strict(),
  })
  .strict()

const ExternalSessionAssessmentContextSchema = z
  .object({
    connection: RuntimeConnectionSchema.optional(),
    nodeStatus: RuntimeEligibilityNodeStatusSchema,
    evaluatedAt: RuntimeTimestampSchema,
  })
  .strict()
  .refine(
    (context) =>
      context.connection === undefined ||
      (context.connection.connectionType === 'managed_cloud') ===
        (context.nodeStatus === 'not_applicable'),
    'Managed-cloud sessions must not invent RuntimeNode health'
  )

export type ExternalSessionAssessment = z.output<typeof ExternalSessionAssessmentSchema>

export function assessExternalSession(
  sessionValue: unknown,
  contextValue: unknown
): ExternalSessionAssessment {
  const session = ExternalSessionSchema.parse(sessionValue)
  const context = ExternalSessionAssessmentContextSchema.parse(contextValue)
  if (
    context.connection !== undefined &&
    context.connection.runtimeConnectionId !== session.runtimeConnectionId
  ) {
    throw new Error('SESSION_RUNTIME_CONNECTION_MISMATCH')
  }
  const base = classifySessionState(session, context)
  const operations = Object.fromEntries(
    (['resume', 'load', 'close', 'history'] as const).map((operation) => [
      operation,
      operationAvailability(session, context.connection, base.state, operation),
    ])
  )
  return ExternalSessionAssessmentSchema.parse({
    ...base,
    evaluatedAt: context.evaluatedAt,
    operations: { reference: { available: true }, ...operations },
  })
}

function classifySessionState(
  session: ExternalSession,
  context: z.output<typeof ExternalSessionAssessmentContextSchema>
): { state: z.output<typeof ExternalSessionAssessmentStateSchema>; recoverable: boolean } {
  if (session.state === 'revoked') return { state: 'revoked', recoverable: false }
  if (session.state === 'removed') return { state: 'removed', recoverable: true }
  if (session.state === 'closed') return { state: 'closed', recoverable: false }
  const connection = context.connection
  if (!connection) return { state: 'runtime_missing', recoverable: true }
  if (
    connection.status === 'revoked' ||
    connection.availabilityState === 'revoked' ||
    context.nodeStatus === 'revoked'
  ) {
    return { state: 'revoked', recoverable: false }
  }
  if (
    ['offline', 'unknown'].includes(context.nodeStatus) ||
    ['disconnected', 'expired', 'unavailable'].includes(connection.status) ||
    ['offline', 'reconnecting', 'unknown', 'incompatible'].includes(
      connection.availabilityState ?? 'unknown'
    )
  ) {
    return { state: 'offline', recoverable: true }
  }
  if (
    Date.parse(session.capabilitySnapshot.expiresAt) <= Date.parse(context.evaluatedAt) ||
    connection.capabilitySnapshotExpiresAt === undefined ||
    Date.parse(connection.capabilitySnapshotExpiresAt) <= Date.parse(context.evaluatedAt)
  ) {
    return { state: 'stale', recoverable: true }
  }
  const changed = session.capabilitySnapshot.operations.some(
    (operation) => !runtimeAdvertises(connection, operation)
  )
  return changed
    ? { state: 'capability_changed', recoverable: true }
    : { state: 'active', recoverable: true }
}

function operationAvailability(
  session: ExternalSession,
  connection: RuntimeConnection | undefined,
  state: z.output<typeof ExternalSessionAssessmentStateSchema>,
  operation: 'resume' | 'load' | 'close' | 'history'
) {
  if (state === 'revoked') return unavailable('SESSION_REVOKED')
  if (state === 'removed') return unavailable('SESSION_REMOVED')
  if (state === 'runtime_missing') return unavailable('RUNTIME_MISSING')
  if (state === 'offline') return unavailable('RUNTIME_OFFLINE')
  if (state === 'stale') return unavailable('SESSION_CAPABILITIES_STALE')
  if (state === 'closed' && operation !== 'history') return unavailable('SESSION_CLOSED')
  const capability = `session.${operation}` as z.output<typeof SessionOperationCapabilitySchema>
  if (!session.capabilitySnapshot.operations.includes(capability)) {
    return unavailable('CAPABILITY_NOT_ADVERTISED')
  }
  if (!connection || !runtimeAdvertises(connection, capability)) {
    return unavailable('CAPABILITY_NO_LONGER_ADVERTISED')
  }
  return { available: true as const }
}

function runtimeAdvertises(
  connection: RuntimeConnection,
  operation: z.output<typeof SessionOperationCapabilitySchema>
): boolean {
  return connection.capabilities.some(
    (capability) => capability.name === operation && capability.support !== 'unsupported'
  )
}

function unavailable(reason: z.output<typeof ExternalSessionOperationUnavailableReasonSchema>) {
  return { available: false as const, reason }
}

function normalizeRegistration(
  input: z.output<typeof ExternalSessionRegistrationSchema>
): z.output<typeof ExternalSessionRegistrationSchema> {
  return {
    ...input,
    capabilitySnapshot: normalizeSnapshot(input.capabilitySnapshot),
    safeMetadata: normalizeSafeMetadata(input.safeMetadata),
  }
}

function normalizeSnapshot(
  snapshot: z.output<typeof ExternalSessionCapabilitySnapshotSchema>
): z.output<typeof ExternalSessionCapabilitySnapshotSchema> {
  return { ...snapshot, operations: [...snapshot.operations].toSorted() }
}

function normalizeSafeMetadata(
  metadata: z.output<typeof ExternalSessionSafeMetadataSchema>
): z.output<typeof ExternalSessionSafeMetadataSchema> {
  return { ...metadata, limitations: [...metadata.limitations].toSorted() }
}

function sameRegistration(
  session: ExternalSession,
  input: z.output<typeof ExternalSessionRegistrationSchema>
): boolean {
  const registered = {
    externalSessionId: session.externalSessionId,
    runtimeConnectionId: session.runtimeConnectionId,
    opaqueNativeSessionId: session.opaqueNativeSessionId,
    workspaceId: session.workspaceId,
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
    state: session.state,
    ownership: session.ownership,
    capabilitySnapshot: session.capabilitySnapshot,
    safeMetadata: session.safeMetadata,
    lastObservedAt: session.lastObservedAt,
  }
  return JSON.stringify(registered) === JSON.stringify(input)
}

function fail(code: ExternalSessionRegistryErrorCode, currentVersion?: number): never {
  throw new ExternalSessionRegistryError(code, currentVersion)
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : clone(value)
}
