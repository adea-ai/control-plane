import { createHash } from 'node:crypto'
import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'
import { RuntimeCapabilitySchema, type RuntimeCapability } from './capabilities.js'
import {
  RuntimeAvailabilityStateSchema,
  RuntimeCapabilityVerificationSchema,
  RuntimeDiagnosticCodeSchema,
  RuntimeSemanticVersionSchema,
  RuntimeTimestampSchema,
  type RuntimeAvailabilityState,
  type RuntimeConnection,
} from './models.js'
import {
  RuntimeConnectionRegistry,
  RuntimeConnectionRegistryError,
  type RuntimeConnectionUpdate,
} from './registry.js'

const uniqueCapabilities = (capabilities: RuntimeCapability[]) =>
  new Set(capabilities.map((capability) => capability.name)).size === capabilities.length
const RuntimeDisplayLimitationSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0)
        return code >= 32 && code !== 127
      }),
    'Display text cannot contain control characters'
  )

export const RuntimeNodeHealthStatusSchema = z.enum(['online', 'offline', 'unknown', 'revoked'])
export const RuntimeReportedStateSchema = z.enum([
  'healthy',
  'degraded',
  'reconnecting',
  'offline',
  'unknown',
])

export const RuntimeHealthReportSchema = z
  .object({
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    reportSequence: z.number().int().positive(),
    observedAt: RuntimeTimestampSchema,
    discoveredAt: RuntimeTimestampSchema,
    nodeStatus: RuntimeNodeHealthStatusSchema,
    runtimeState: RuntimeReportedStateSchema,
    versions: z
      .object({
        adapter: RuntimeSemanticVersionSchema,
        driver: RuntimeSemanticVersionSchema,
        harness: RuntimeSemanticVersionSchema,
        protocol: RuntimeSemanticVersionSchema,
      })
      .strict(),
    capabilitySnapshot: z
      .object({
        version: z.number().int().positive(),
        observedAt: RuntimeTimestampSchema,
        ttlMs: z.number().int().positive().max(86_400_000),
        verification: RuntimeCapabilityVerificationSchema,
        source: z.enum(['adapter_driver_negotiation', 'runtime_declaration']),
        capabilities: z.array(RuntimeCapabilitySchema).max(64).refine(uniqueCapabilities),
      })
      .strict(),
    limitations: z.array(RuntimeDisplayLimitationSchema).max(64),
    diagnostics: z.array(RuntimeDiagnosticCodeSchema).max(64),
  })
  .strict()
  .refine(
    (report) =>
      report.capabilitySnapshot.verification !== 'verified' ||
      report.capabilitySnapshot.source === 'adapter_driver_negotiation',
    'Only negotiated capability claims can be verified'
  )
  .refine(
    (report) => Date.parse(report.capabilitySnapshot.observedAt) <= Date.parse(report.observedAt),
    'Capability snapshot cannot be newer than its health report'
  )
  .refine(
    (report) => Date.parse(report.discoveredAt) <= Date.parse(report.observedAt),
    'Discovery observation cannot be newer than its health report'
  )

export const RuntimeAvailabilityAssessmentSchema = z
  .object({
    nodeStatus: RuntimeNodeHealthStatusSchema,
    availabilityState: RuntimeAvailabilityStateSchema,
    executable: z.boolean(),
    capabilitySnapshotExpiresAt: RuntimeTimestampSchema.optional(),
    diagnostics: z.array(RuntimeDiagnosticCodeSchema).max(64),
  })
  .strict()

export const RuntimeAvailabilityChangeSchema = z
  .object({
    type: z.literal('runtime.availability_changed'),
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    nodeStatus: RuntimeNodeHealthStatusSchema,
    previousState: RuntimeAvailabilityStateSchema,
    currentState: RuntimeAvailabilityStateSchema,
    occurredAt: RuntimeTimestampSchema,
    diagnostics: z.array(RuntimeDiagnosticCodeSchema).max(64),
  })
  .strict()

export type RuntimeHealthReport = z.output<typeof RuntimeHealthReportSchema>
export type RuntimeAvailabilityAssessment = z.output<typeof RuntimeAvailabilityAssessmentSchema>
export type RuntimeAvailabilityChange = z.output<typeof RuntimeAvailabilityChangeSchema>

export interface RuntimeAvailabilityChangePublisher {
  publish(change: RuntimeAvailabilityChange): Promise<void>
}

export class RecordingRuntimeAvailabilityChangePublisher implements RuntimeAvailabilityChangePublisher {
  readonly events: RuntimeAvailabilityChange[] = []

  async publish(changeInput: RuntimeAvailabilityChange): Promise<void> {
    this.events.push(structuredClone(RuntimeAvailabilityChangeSchema.parse(changeInput)))
  }
}

export interface RuntimeHealthIngestionPolicy {
  readonly adapterMajor: number
  readonly driverMajor: number
  readonly harnessMajor: number
  readonly protocolMajor: number
  readonly healthTtlMs: number
  readonly maximumCapabilityTtlMs: number
}

export interface RuntimeHealthIngestionOptions {
  readonly registry: RuntimeConnectionRegistry
  readonly changes: RuntimeAvailabilityChangePublisher
  readonly policy: RuntimeHealthIngestionPolicy
}

export type RuntimeHealthIngestionIgnoreReason =
  | 'replayed_report'
  | 'stale_report'
  | 'no_health_report'
  | 'already_current'

export interface RuntimeHealthIngestionResult {
  readonly applied: boolean
  readonly reason?: RuntimeHealthIngestionIgnoreReason
  readonly connection: RuntimeConnection
  readonly assessment: RuntimeAvailabilityAssessment
}

export type RuntimeHealthIngestionErrorCode =
  | 'HEALTH_REPORT_CONFLICT'
  | 'CAPABILITY_SNAPSHOT_CONFLICT'
  | 'CONNECTION_MISSING'
  | 'INGESTION_CONCURRENCY_EXHAUSTED'

export class RuntimeHealthIngestionError extends Error {
  constructor(readonly code: RuntimeHealthIngestionErrorCode) {
    super(code)
    this.name = 'RuntimeHealthIngestionError'
  }
}

export class RuntimeHealthIngestionService {
  readonly #registry: RuntimeConnectionRegistry
  readonly #changes: RuntimeAvailabilityChangePublisher
  readonly #policy: RuntimeHealthIngestionPolicy

  constructor(options: RuntimeHealthIngestionOptions) {
    this.#registry = options.registry
    this.#changes = options.changes
    this.#policy = parsePolicy(options.policy)
  }

  async ingest(
    reportInput: unknown,
    evaluatedAtInput: string,
    attempt = 1
  ): Promise<RuntimeHealthIngestionResult> {
    const report = normalizeReport(reportInput)
    const evaluatedAt = RuntimeTimestampSchema.parse(evaluatedAtInput)
    const current = await this.#registry.get(report.runtimeConnectionId)
    if (!current) fail('CONNECTION_MISSING')
    const reportDigest = digest(report)
    const sequence = current.lastHealthReportSequence
    if (sequence !== undefined && report.reportSequence < sequence) {
      return ignored('stale_report', current, assessCurrent(current, report.nodeStatus))
    }
    if (sequence === report.reportSequence) {
      if (current.lastHealthReportDigest === reportDigest) {
        return ignored('replayed_report', current, assessCurrent(current, report.nodeStatus))
      }
      fail('HEALTH_REPORT_CONFLICT')
    }
    if (
      Date.parse(report.observedAt) <= Date.parse(current.lastHealthCheckAt) ||
      (current.capabilitySnapshotVersion !== undefined &&
        report.capabilitySnapshot.version < current.capabilitySnapshotVersion)
    ) {
      return ignored('stale_report', current, assessCurrent(current, report.nodeStatus))
    }
    if (
      current.capabilitySnapshotVersion === report.capabilitySnapshot.version &&
      current.capabilitySnapshotObservedAt !== undefined &&
      (current.capabilitySnapshotObservedAt !== report.capabilitySnapshot.observedAt ||
        !sameCapabilities(current.capabilities, report.capabilitySnapshot.capabilities))
    ) {
      fail('CAPABILITY_SNAPSHOT_CONFLICT')
    }

    const assessment = assessReport(report, evaluatedAt, this.#policy, current.status === 'revoked')
    if (current.status === 'revoked') {
      return ignored('already_current', current, assessment)
    }
    if (assessment.availabilityState === 'revoked') {
      const connection = await this.#registry.revoke({
        runtimeConnectionId: current.runtimeConnectionId,
        expectedVersion: current.version,
        observedAt: later(report.observedAt, evaluatedAt),
      })
      await this.#publishIfChanged(current, connection, assessment)
      return { applied: true, connection, assessment }
    }
    const capabilities = verifiedCapabilities(report.capabilitySnapshot)
    const update = connectionUpdate(
      current,
      report,
      reportDigest,
      capabilities,
      assessment,
      evaluatedAt
    )
    try {
      const connection = await this.#registry.update(update)
      await this.#publishIfChanged(current, connection, assessment)
      return { applied: true, connection, assessment }
    } catch (error) {
      if (
        error instanceof RuntimeConnectionRegistryError &&
        error.code === 'STALE_CONNECTION_VERSION' &&
        attempt < 3
      ) {
        return this.ingest(report, evaluatedAt, attempt + 1)
      }
      if (
        error instanceof RuntimeConnectionRegistryError &&
        error.code === 'STALE_CONNECTION_VERSION'
      ) {
        fail('INGESTION_CONCURRENCY_EXHAUSTED')
      }
      throw error
    }
  }

  async refresh(input: unknown): Promise<RuntimeHealthIngestionResult> {
    const refresh = z
      .object({
        runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
        nodeStatus: RuntimeNodeHealthStatusSchema,
        evaluatedAt: RuntimeTimestampSchema,
      })
      .strict()
      .parse(input)
    const current = await this.#registry.get(refresh.runtimeConnectionId)
    if (!current) fail('CONNECTION_MISSING')
    if (
      current.capabilitySnapshotExpiresAt === undefined ||
      current.availabilityState === undefined
    ) {
      return ignored('no_health_report', current, assessCurrent(current, refresh.nodeStatus))
    }
    const diagnostics = unique([
      ...staleDiagnostics(current, refresh.evaluatedAt, this.#policy),
      ...nodeDiagnostics(refresh.nodeStatus),
    ])
    if (diagnostics.length === 0) {
      return ignored('already_current', current, assessCurrent(current, refresh.nodeStatus))
    }
    if (current.availabilityState === 'revoked' || current.availabilityState === 'stale') {
      return ignored('already_current', current, assessCurrent(current, refresh.nodeStatus))
    }
    const assessment = RuntimeAvailabilityAssessmentSchema.parse({
      nodeStatus: refresh.nodeStatus,
      availabilityState: 'stale',
      executable: false,
      capabilitySnapshotExpiresAt: current.capabilitySnapshotExpiresAt,
      diagnostics,
    })
    const connection = await this.#registry.update({
      runtimeConnectionId: current.runtimeConnectionId,
      expectedVersion: current.version,
      observedAt: refresh.evaluatedAt,
      status: 'unavailable',
      health: 'unavailable',
      availabilityState: 'stale',
      compatibilityState: 'unavailable',
      diagnostics,
    })
    await this.#publishIfChanged(current, connection, assessment)
    return { applied: true, connection, assessment }
  }

  async #publishIfChanged(
    previous: RuntimeConnection,
    current: RuntimeConnection,
    assessment: RuntimeAvailabilityAssessment
  ): Promise<void> {
    if (eligibilityFingerprint(previous) === eligibilityFingerprint(current)) return
    await this.#changes.publish(
      RuntimeAvailabilityChangeSchema.parse({
        type: 'runtime.availability_changed',
        runtimeConnectionId: current.runtimeConnectionId,
        nodeStatus: assessment.nodeStatus,
        previousState: previous.availabilityState ?? 'unknown',
        currentState: assessment.availabilityState,
        occurredAt: current.updatedAt,
        diagnostics: assessment.diagnostics,
      })
    )
  }
}

export function runtimeAvailabilityIsExecutable(state: RuntimeAvailabilityState): boolean {
  return state === 'healthy' || state === 'degraded'
}

function assessReport(
  report: RuntimeHealthReport,
  evaluatedAt: string,
  policy: RuntimeHealthIngestionPolicy,
  connectionRevoked: boolean
): RuntimeAvailabilityAssessment {
  const capabilitySnapshotExpiresAt = addMilliseconds(
    report.capabilitySnapshot.observedAt,
    Math.min(report.capabilitySnapshot.ttlMs, policy.maximumCapabilityTtlMs)
  )
  const versionDiagnostics = versionDiagnosticsFor(report, policy)
  const stale = staleDiagnostics(
    {
      capabilitySnapshotExpiresAt,
      lastHealthCheckAt: report.observedAt,
    },
    evaluatedAt,
    policy
  )
  let availabilityState: RuntimeAvailabilityState
  let generatedDiagnostics: string[]
  if (connectionRevoked || report.nodeStatus === 'revoked') {
    availabilityState = 'revoked'
    generatedDiagnostics = ['RUNTIME_REVOKED']
  } else if (versionDiagnostics.length > 0) {
    availabilityState = 'incompatible'
    generatedDiagnostics = versionDiagnostics
  } else if (stale.length > 0) {
    availabilityState = 'stale'
    generatedDiagnostics = [...stale, ...nodeDiagnostics(report.nodeStatus)]
  } else if (report.capabilitySnapshot.verification === 'unverified') {
    availabilityState = 'degraded'
    generatedDiagnostics = ['CAPABILITIES_UNVERIFIED']
  } else if (report.nodeStatus === 'offline') {
    availabilityState = 'offline'
    generatedDiagnostics = ['NODE_OFFLINE']
  } else if (report.nodeStatus === 'unknown') {
    availabilityState = 'unknown'
    generatedDiagnostics = ['NODE_STATUS_UNKNOWN']
  } else {
    availabilityState = report.runtimeState
    generatedDiagnostics = []
  }
  const diagnostics = unique([...generatedDiagnostics, ...report.diagnostics])
  return RuntimeAvailabilityAssessmentSchema.parse({
    nodeStatus: report.nodeStatus,
    availabilityState,
    executable: runtimeAvailabilityIsExecutable(availabilityState),
    capabilitySnapshotExpiresAt,
    diagnostics,
  })
}

function connectionUpdate(
  current: RuntimeConnection,
  report: RuntimeHealthReport,
  reportDigest: string,
  capabilities: RuntimeCapability[],
  assessment: RuntimeAvailabilityAssessment,
  evaluatedAt: string
): RuntimeConnectionUpdate {
  const state = assessment.availabilityState
  return {
    runtimeConnectionId: current.runtimeConnectionId,
    expectedVersion: current.version,
    observedAt: later(report.observedAt, evaluatedAt),
    adapterVersion: report.versions.adapter,
    driverVersion: report.versions.driver,
    harnessVersion: report.versions.harness,
    protocolVersion: report.versions.protocol,
    status: connectionStatus(state),
    health: connectionHealth(state),
    capabilities,
    compatibilityState: compatibilityState(state, report.capabilitySnapshot.verification),
    availabilityState: state === 'revoked' ? 'unknown' : state,
    capabilitySnapshotVersion: report.capabilitySnapshot.version,
    capabilitySnapshotObservedAt: report.capabilitySnapshot.observedAt,
    capabilitySnapshotExpiresAt: assessment.capabilitySnapshotExpiresAt,
    capabilityVerification: report.capabilitySnapshot.verification,
    lastHealthReportSequence: report.reportSequence,
    lastHealthReportDigest: reportDigest,
    limitations: report.limitations,
    diagnostics: assessment.diagnostics,
    lastDiscoveredAt: report.discoveredAt,
    lastHeartbeatAt: report.observedAt,
    lastHealthCheckAt: report.observedAt,
  }
}

function connectionStatus(
  state: RuntimeAvailabilityState
): RuntimeConnectionUpdate['status'] & string {
  if (state === 'healthy') return 'connected'
  if (state === 'degraded' || state === 'reconnecting') return 'degraded'
  if (state === 'offline') return 'disconnected'
  if (state === 'stale') return 'unavailable'
  return 'unavailable'
}

function connectionHealth(
  state: RuntimeAvailabilityState
): RuntimeConnectionUpdate['health'] & string {
  if (state === 'healthy') return 'healthy'
  if (state === 'degraded' || state === 'reconnecting') return 'degraded'
  return 'unavailable'
}

function compatibilityState(
  state: RuntimeAvailabilityState,
  verification: z.output<typeof RuntimeCapabilityVerificationSchema>
): RuntimeConnectionUpdate['compatibilityState'] & string {
  if (state === 'incompatible') return 'incompatible'
  if (state === 'stale' || state === 'offline' || state === 'unknown') return 'unavailable'
  if (state === 'degraded' || state === 'reconnecting' || verification === 'unverified') {
    return 'degraded'
  }
  return 'compatible'
}

function verifiedCapabilities(
  snapshot: RuntimeHealthReport['capabilitySnapshot']
): RuntimeCapability[] {
  if (snapshot.verification === 'verified') return snapshot.capabilities
  return snapshot.capabilities.map((capability) => ({
    name: capability.name,
    support: 'unsupported',
    limitations: ['UNVERIFIED_CAPABILITY'],
  }))
}

function versionDiagnosticsFor(
  report: RuntimeHealthReport,
  policy: RuntimeHealthIngestionPolicy
): string[] {
  return [
    ...(major(report.versions.adapter) === policy.adapterMajor ? [] : ['ADAPTER_MAJOR_MISMATCH']),
    ...(major(report.versions.driver) === policy.driverMajor ? [] : ['DRIVER_MAJOR_MISMATCH']),
    ...(major(report.versions.harness) === policy.harnessMajor ? [] : ['HARNESS_MAJOR_MISMATCH']),
    ...(major(report.versions.protocol) === policy.protocolMajor
      ? []
      : ['PROTOCOL_MAJOR_MISMATCH']),
  ]
}

function staleDiagnostics(
  connection: Pick<RuntimeConnection, 'capabilitySnapshotExpiresAt' | 'lastHealthCheckAt'>,
  evaluatedAt: string,
  policy: RuntimeHealthIngestionPolicy
): string[] {
  const diagnostics = []
  if (
    connection.capabilitySnapshotExpiresAt !== undefined &&
    Date.parse(evaluatedAt) > Date.parse(connection.capabilitySnapshotExpiresAt)
  ) {
    diagnostics.push('CAPABILITY_SNAPSHOT_STALE')
  }
  if (Date.parse(evaluatedAt) > Date.parse(connection.lastHealthCheckAt) + policy.healthTtlMs) {
    diagnostics.push('HEALTH_REPORT_STALE')
  }
  return diagnostics
}

function nodeDiagnostics(nodeStatus: z.output<typeof RuntimeNodeHealthStatusSchema>): string[] {
  if (nodeStatus === 'offline') return ['NODE_OFFLINE']
  if (nodeStatus === 'unknown') return ['NODE_STATUS_UNKNOWN']
  if (nodeStatus === 'revoked') return ['RUNTIME_REVOKED']
  return []
}

function assessCurrent(
  connection: RuntimeConnection,
  nodeStatus: z.output<typeof RuntimeNodeHealthStatusSchema>
): RuntimeAvailabilityAssessment {
  const availabilityState = connection.availabilityState ?? 'unknown'
  return RuntimeAvailabilityAssessmentSchema.parse({
    nodeStatus,
    availabilityState,
    executable: runtimeAvailabilityIsExecutable(availabilityState),
    ...(connection.capabilitySnapshotExpiresAt
      ? { capabilitySnapshotExpiresAt: connection.capabilitySnapshotExpiresAt }
      : {}),
    diagnostics: connection.diagnostics ?? [],
  })
}

function normalizeReport(input: unknown): RuntimeHealthReport {
  const report = RuntimeHealthReportSchema.parse(input)
  return {
    ...report,
    capabilitySnapshot: {
      ...report.capabilitySnapshot,
      capabilities: [...report.capabilitySnapshot.capabilities].sort((left, right) =>
        left.name.localeCompare(right.name)
      ),
    },
    diagnostics: [...report.diagnostics].sort(),
  }
}

function parsePolicy(policy: RuntimeHealthIngestionPolicy): RuntimeHealthIngestionPolicy {
  const parsed = z
    .object({
      adapterMajor: z.number().int().nonnegative(),
      driverMajor: z.number().int().nonnegative(),
      harnessMajor: z.number().int().nonnegative(),
      protocolMajor: z.number().int().nonnegative(),
      healthTtlMs: z.number().int().positive(),
      maximumCapabilityTtlMs: z.number().int().positive(),
    })
    .strict()
    .parse(policy)
  return parsed
}

function eligibilityFingerprint(connection: RuntimeConnection): string {
  return JSON.stringify({
    availabilityState: connection.availabilityState ?? 'unknown',
    status: connection.status,
    health: connection.health,
    compatibilityState: connection.compatibilityState,
    capabilities: connection.capabilities,
    adapterVersion: connection.adapterVersion,
    driverVersion: connection.driverVersion,
    harnessVersion: connection.harnessVersion,
    protocolVersion: connection.protocolVersion,
    capabilitySnapshotExpiresAt: connection.capabilitySnapshotExpiresAt,
  })
}

function sameCapabilities(left: RuntimeCapability[], right: RuntimeCapability[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString()
}

function later(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function major(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '', 10)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function ignored(
  reason: RuntimeHealthIngestionIgnoreReason,
  connection: RuntimeConnection,
  assessment: RuntimeAvailabilityAssessment
): RuntimeHealthIngestionResult {
  return { applied: false, reason, connection, assessment }
}

function fail(code: RuntimeHealthIngestionErrorCode): never {
  throw new RuntimeHealthIngestionError(code)
}
