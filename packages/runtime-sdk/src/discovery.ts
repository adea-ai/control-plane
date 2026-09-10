import {
  ExternalSessionDiscoveryReadModelSchema,
  RuntimeConnectionDiscoveryReadModelSchema,
  type ExternalSessionDiscoveryReadModel,
  type RuntimeConnectionDiscoveryReadModel,
} from '@control-plane/contracts'
import { RuntimeCapabilityNameSchema, type RuntimeCapabilityName } from './capabilities.js'
import { RuntimeNodeHealthStatusSchema } from './health.js'
import {
  RuntimeConnectionSchema,
  RuntimeNodeRefSchema,
  RuntimeTimestampSchema,
  type RuntimeConnection,
} from './models.js'
import {
  ExternalSessionAssessmentSchema,
  ExternalSessionSchema,
  type ExternalSession,
  type ExternalSessionAssessment,
} from './sessions.js'

export interface RuntimeConnectionDiscoveryProjectionInput {
  readonly connection: RuntimeConnection
  readonly family: string
  readonly node?: unknown
  readonly nodeHealth: 'online' | 'offline' | 'unknown' | 'revoked' | 'not_applicable'
  readonly evaluatedAt: string
  readonly localProjectGrant: {
    readonly required: boolean
    readonly state: 'not_required' | 'granted' | 'missing' | 'revoked'
  }
  readonly entitlement: {
    readonly state: 'allowed' | 'denied' | 'unknown'
    readonly class?: string
  }
  readonly requiredCapabilities?: readonly RuntimeCapabilityName[]
}

export function projectRuntimeConnectionDiscovery(
  inputValue: RuntimeConnectionDiscoveryProjectionInput
): RuntimeConnectionDiscoveryReadModel {
  const connection = RuntimeConnectionSchema.parse(inputValue.connection)
  const evaluatedAt = RuntimeTimestampSchema.parse(inputValue.evaluatedAt)
  const nodeHealth =
    inputValue.nodeHealth === 'not_applicable'
      ? 'not_applicable'
      : RuntimeNodeHealthStatusSchema.parse(inputValue.nodeHealth)
  const node =
    inputValue.node === undefined ? undefined : RuntimeNodeRefSchema.parse(inputValue.node)
  const local = connection.connectionType !== 'managed_cloud'
  if (local !== (node !== undefined) || local !== (nodeHealth !== 'not_applicable')) {
    throw new Error('RUNTIME_DISCOVERY_NODE_SCOPE_MISMATCH')
  }
  if (node && node.runtimeNodeRefId !== connection.runtimeNodeRefId) {
    throw new Error('RUNTIME_DISCOVERY_NODE_ID_MISMATCH')
  }
  const requiredCapabilities = (inputValue.requiredCapabilities ?? []).map((capability) =>
    RuntimeCapabilityNameSchema.parse(capability)
  )
  const freshness = connectionFreshness(connection, evaluatedAt)
  const reasons = runtimeReasons({
    connection,
    nodeHealth,
    freshness: freshness.state,
    localProjectGrant: inputValue.localProjectGrant,
    entitlement: inputValue.entitlement,
    requiredCapabilities,
  })
  const degradations = runtimeDegradations(connection)
  const eligibilityState =
    reasons.length > 0 ? 'ineligible' : degradations.length > 0 ? 'degraded' : 'eligible'
  const status = publicStatus(connection, reasons, degradations)
  const limitations = uniqueCodes([
    ...connection.limitations,
    ...(connection.diagnostics ?? []),
    ...connection.capabilities.flatMap((capability) => capability.limitations ?? []),
  ])
  const remediation = remediationFor(reasons)

  return RuntimeConnectionDiscoveryReadModelSchema.parse({
    runtimeConnectionId: connection.runtimeConnectionId,
    runtimeDefinitionId: connection.runtimeDefinitionId,
    family: inputValue.family,
    connectionType: connection.connectionType,
    location: connection.location,
    status,
    ...(node === undefined
      ? {}
      : {
          node: {
            runtimeNodeRefId: node.runtimeNodeRefId,
            location: node.location,
            status: node.status,
            health: nodeHealth,
            observedAt: node.observedAt,
          },
        }),
    connection: {
      status: connection.status,
      health: connection.health,
      availability: connection.availabilityState ?? 'unknown',
    },
    freshness,
    versions: {
      adapter: connection.adapterVersion,
      driver: connection.driverVersion,
      harness: connection.harnessVersion,
      ...(connection.protocolVersion === undefined ? {} : { protocol: connection.protocolVersion }),
    },
    capabilities: connection.capabilities
      .filter((capability) => capability.support !== 'unsupported')
      .map((capability) => capability.name)
      .toSorted(),
    capabilityDetails: connection.capabilities
      .map((capability) => ({
        name: capability.name,
        support: capability.support,
        ...(capability.limitations === undefined
          ? {}
          : { limitations: uniqueCodes(capability.limitations) }),
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
    compatibility: {
      state: connection.compatibilityState,
      limitations: uniqueCodes([
        ...connection.limitations,
        ...(connection.compatibilityState === 'compatible'
          ? []
          : [`RUNTIME_${connection.compatibilityState}`]),
      ]),
    },
    access: {
      localProjectGrant: inputValue.localProjectGrant,
      entitlement: inputValue.entitlement,
    },
    eligibility: {
      state: eligibilityState,
      reasons,
      degradations,
      remediation,
    },
    observedAt: connection.lastHealthCheckAt,
    limitations,
  })
}

export function projectExternalSessionDiscovery(inputValue: {
  readonly session: ExternalSession
  readonly assessment: ExternalSessionAssessment
}): ExternalSessionDiscoveryReadModel {
  const session = ExternalSessionSchema.parse(inputValue.session)
  const assessment = ExternalSessionAssessmentSchema.parse(inputValue.assessment)
  const freshnessState =
    assessment.evaluatedAt !== undefined &&
    Date.parse(session.capabilitySnapshot.expiresAt) <= Date.parse(assessment.evaluatedAt)
      ? 'expired'
      : assessment.state === 'stale'
        ? 'stale'
        : 'fresh'
  const limitations = uniqueCodes([
    ...session.safeMetadata.limitations,
    ...Object.values(assessment.operations).flatMap((operation) =>
      operation.available ? [] : [operation.reason]
    ),
  ])
  return ExternalSessionDiscoveryReadModelSchema.parse({
    externalSessionId: session.externalSessionId,
    runtimeConnectionId: session.runtimeConnectionId,
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
    state: assessment.state,
    recoverable: assessment.recoverable,
    display: {
      origin: session.safeMetadata.origin,
      ...(session.safeMetadata.displayName === undefined
        ? {}
        : { displayName: session.safeMetadata.displayName }),
    },
    freshness: {
      state: freshnessState,
      observedAt: session.capabilitySnapshot.observedAt,
      expiresAt: session.capabilitySnapshot.expiresAt,
    },
    capabilitySummary: {
      version: session.capabilitySnapshot.version,
      operations: session.capabilitySnapshot.operations,
      controls: assessment.operations,
    },
    limitations,
  })
}

function connectionFreshness(connection: RuntimeConnection, evaluatedAt: string) {
  const observedAt = connection.capabilitySnapshotObservedAt ?? connection.lastHealthCheckAt
  const expiresAt = connection.capabilitySnapshotExpiresAt ?? connection.expiresAt
  const state =
    expiresAt === undefined
      ? 'unknown'
      : Date.parse(expiresAt) <= Date.parse(evaluatedAt)
        ? connection.status === 'expired'
          ? 'expired'
          : 'stale'
        : connection.availabilityState === 'stale'
          ? 'stale'
          : 'fresh'
  return { state, observedAt, ...(expiresAt === undefined ? {} : { expiresAt }) }
}

function runtimeReasons(input: {
  readonly connection: RuntimeConnection
  readonly nodeHealth: 'online' | 'offline' | 'unknown' | 'revoked' | 'not_applicable'
  readonly freshness: string
  readonly localProjectGrant: RuntimeConnectionDiscoveryProjectionInput['localProjectGrant']
  readonly entitlement: RuntimeConnectionDiscoveryProjectionInput['entitlement']
  readonly requiredCapabilities: readonly RuntimeCapabilityName[]
}): string[] {
  const reasons: string[] = []
  if (input.nodeHealth === 'offline') reasons.push('RUNTIME_NODE_OFFLINE')
  if (input.nodeHealth === 'unknown') reasons.push('RUNTIME_NODE_UNKNOWN')
  if (input.nodeHealth === 'revoked') reasons.push('RUNTIME_NODE_REVOKED')
  const availability = input.connection.availabilityState ?? 'unknown'
  if (input.connection.status === 'revoked' || availability === 'revoked') {
    reasons.push('RUNTIME_REVOKED')
  } else if (['disconnected', 'expired', 'unavailable'].includes(input.connection.status)) {
    reasons.push('RUNTIME_OFFLINE')
  } else if (['offline', 'reconnecting', 'unknown'].includes(availability)) {
    reasons.push('RUNTIME_OFFLINE')
  }
  if (input.freshness === 'stale' || input.freshness === 'expired') reasons.push('RUNTIME_STALE')
  if (['incompatible', 'capability_missing'].includes(input.connection.compatibilityState)) {
    reasons.push('RUNTIME_INCOMPATIBLE')
  }
  if (input.localProjectGrant.required && input.localProjectGrant.state === 'missing') {
    reasons.push('LOCAL_PROJECT_GRANT_MISSING')
  }
  if (input.localProjectGrant.required && input.localProjectGrant.state === 'revoked') {
    reasons.push('LOCAL_PROJECT_GRANT_REVOKED')
  }
  if (input.entitlement.state === 'denied') reasons.push('ENTITLEMENT_DENIED')
  if (input.entitlement.state === 'unknown') reasons.push('ENTITLEMENT_UNKNOWN')
  const capabilities = new Map(
    input.connection.capabilities.map((capability) => [capability.name, capability.support])
  )
  for (const requirement of input.requiredCapabilities) {
    const support = capabilities.get(requirement)
    if (support === undefined || support === 'unsupported') {
      reasons.push('REQUIRED_CAPABILITY_MISSING')
    } else if (support === 'degraded') {
      reasons.push('REQUIRED_CAPABILITY_INSUFFICIENT')
    }
  }
  return uniqueCodes(reasons)
}

function runtimeDegradations(connection: RuntimeConnection): string[] {
  return uniqueCodes([
    ...(connection.health === 'degraded' ? ['RUNTIME_HEALTH_DEGRADED'] : []),
    ...(connection.compatibilityState === 'degraded' ? ['COMPATIBILITY_DEGRADED'] : []),
    ...(connection.compatibilityState === 'untested' ? ['COMPATIBILITY_UNTESTED'] : []),
    ...(connection.capabilities.some((capability) => capability.support === 'degraded')
      ? ['CAPABILITY_SUPPORT_DEGRADED']
      : []),
  ])
}

function publicStatus(
  connection: RuntimeConnection,
  reasons: readonly string[],
  degradations: readonly string[]
): 'available' | 'degraded' | 'unavailable' | 'revoked' {
  if (connection.status === 'revoked' || reasons.includes('RUNTIME_REVOKED')) return 'revoked'
  if (reasons.length > 0) return 'unavailable'
  return degradations.length > 0 ? 'degraded' : 'available'
}

function remediationFor(reasons: readonly string[]) {
  const remediation = new Map<string, string>()
  const add = (code: string, label: string) => remediation.set(code, label)
  if (reasons.some((reason) => reason.startsWith('LOCAL_PROJECT_GRANT_'))) {
    add('GRANT_PROJECT_ACCESS', 'Grant runtime access to this project')
  }
  if (reasons.some((reason) => ['RUNTIME_STALE', 'RUNTIME_OFFLINE'].includes(reason))) {
    add('REFRESH_RUNTIME', 'Refresh runtime health and capabilities')
  }
  if (
    reasons.some(
      (reason) => reason.startsWith('REQUIRED_CAPABILITY_') || reason === 'RUNTIME_INCOMPATIBLE'
    )
  ) {
    add('SELECT_COMPATIBLE_RUNTIME', 'Select a compatible runtime')
  }
  if (reasons.some((reason) => reason.startsWith('ENTITLEMENT_'))) {
    add('VERIFY_ENTITLEMENT', 'Verify workspace runtime entitlement')
  }
  if (reasons.some((reason) => reason.includes('REVOKED'))) {
    add('CONTACT_ADMINISTRATOR', 'Contact a workspace administrator')
  }
  return [...remediation]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([code, label]) => ({ code, label }))
}

function uniqueCodes(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeCode))].toSorted()
}

function normalizeCode(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 128)
  return /^[A-Z]/.test(normalized) ? normalized : `RUNTIME_${normalized || 'LIMITATION'}`
}
