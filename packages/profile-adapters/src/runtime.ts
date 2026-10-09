import type { DeploymentComposition } from '@control-plane/deployment'
import {
  CapabilityRequirementSetSchema,
  RuntimeAdapterInspectionSchema,
  RuntimeApprovalRequestSchema,
  RuntimeCancelRequestSchema,
  RuntimeExecutionHandleSchema,
  RuntimeExecutionProgressSchema,
  RuntimeExecutionStatusSchema,
  RuntimeInputRequestSchema,
  RuntimeSessionOperationSchema,
  RuntimeSessionResultSchema,
  RuntimeStartRequestSchema,
  evaluateCapabilities,
  runtimeCapabilitiesEqual,
  type CapabilityRequirement,
  type RuntimeAdapter,
  type RuntimeAdapterInspection,
  type RuntimeApprovalRequest,
  type RuntimeCancelRequest,
  type RuntimeExecutionHandle,
  type RuntimeExecutionStatus,
  type RuntimeInputRequest,
  type RuntimeProgressOptions,
  type RuntimeSessionOperation,
  type RuntimeSessionResult,
  type RuntimeStartRequest,
} from '@control-plane/runtime-sdk'
import type { RuntimeAdapterWithTransport, RuntimeTransport } from '@control-plane/runtime-sdk'
import { bindProfileStorage, ExecutionProfiles, ProfileAdapterError } from './index.js'
import {
  assertProfileCompositionResidency,
  assertProfileGuards,
  type CurrentProfileRuntimeTopologyGuard,
  type ProfileRuntimeTopologyContext,
  type ProfileExecutionGuards,
  type TrustedProfilePlacement,
} from './guards.js'
import type { ExecutionProfile } from './index.js'

export interface ProfileRuntimeCandidate {
  /** Semantic runtime adapter, such as ACP or managed Pi. */
  readonly adapter: RuntimeAdapter
  /** The concrete RuntimeTransport instance used by that adapter. */
  readonly transport: RuntimeTransport
  /** Runtime placement comes from server-owned node/deployment configuration. */
  readonly placement: TrustedProfilePlacement
}

export interface BindProfileRuntimeInput {
  readonly profile: ExecutionProfile
  readonly deployment: DeploymentComposition
  readonly candidate: ProfileRuntimeCandidate
  readonly guards: ProfileExecutionGuards
  /** Must resolve exact adapter/transport object identity against server topology. */
  readonly topology: CurrentProfileRuntimeTopologyGuard
  readonly requiredCapabilities?: readonly CapabilityRequirement[]
}

export interface BoundProfileRuntime {
  readonly profile: ExecutionProfile
  readonly deploymentProfile: DeploymentComposition['profile']
  readonly transportKind: RuntimeTransport['kind']
  readonly inspection: RuntimeAdapterInspection
  readonly adapter: RuntimeAdapter
}

/**
 * Adapter limitations that deny hosted-profile qualification. The Node Pi
 * Durable adapter declares CLOUD_PROFILE_UNQUALIFIED; it is a denial, never
 * an authorization hint. Capability metadata still grants nothing.
 */
const HOSTED_RUNTIME_QUALIFICATION_DENIALS: ReadonlySet<string> = new Set([
  'CLOUD_PROFILE_UNQUALIFIED',
])

/**
 * Validates a single server-selected adapter/transport pair. It never searches
 * alternatives or treats inspection metadata as actor authorization.
 */
export async function bindProfileRuntime(
  input: BindProfileRuntimeInput
): Promise<BoundProfileRuntime> {
  const storage = bindProfileStorage(input.profile, input.deployment)
  const candidate: ProfileRuntimeCandidate = Object.freeze({
    adapter: input.candidate.adapter,
    transport: input.candidate.transport,
    placement: Object.freeze({ ...input.candidate.placement }),
  })
  const expectedTransport = expectedTransportKind(storage.profile, candidate.placement)
  if (candidate.transport.kind !== expectedTransport) {
    throw new ProfileAdapterError('PROFILE_RUNTIME_TRANSPORT_MISMATCH', {
      profile: storage.profile,
      actual: candidate.transport.kind,
      expected: expectedTransport,
    })
  }
  validatePlacement(storage.profile, candidate.placement)
  const topologyContext: ProfileRuntimeTopologyContext = Object.freeze({
    profile: storage.profile,
    deploymentProfile: storage.deploymentProfile,
    expectedTransportKind: expectedTransport,
    placement: candidate.placement,
  })
  await assertRuntimeTopology(input.topology, topologyContext, candidate)
  await assertProfileCompositionResidency({
    profile: storage.profile,
    deploymentProfile: storage.deploymentProfile,
    placement: candidate.placement,
    guard: input.guards.residency,
  })
  const requirements =
    input.requiredCapabilities === undefined
      ? undefined
      : parseRequirements(input.requiredCapabilities)
  const inspection = await inspectBoundRuntime(
    candidate,
    requirements,
    storage.profile,
    storage.deploymentProfile
  )
  await assertRuntimeTopology(input.topology, topologyContext, candidate)
  await assertProfileCompositionResidency({
    profile: storage.profile,
    deploymentProfile: storage.deploymentProfile,
    placement: candidate.placement,
    guard: input.guards.residency,
  })
  const adapter = new GuardedProfileRuntimeAdapter({
    profile: storage.profile,
    deploymentProfile: storage.deploymentProfile,
    candidate,
    guards: input.guards,
    topology: input.topology,
    topologyContext,
  })
  return Object.freeze({
    profile: storage.profile,
    deploymentProfile: storage.deploymentProfile,
    transportKind: candidate.transport.kind,
    inspection,
    adapter,
  })
}

class GuardedProfileRuntimeAdapter implements RuntimeAdapter {
  readonly #profile: ExecutionProfile
  readonly #deploymentProfile: DeploymentComposition['profile']
  readonly #candidate: ProfileRuntimeCandidate
  readonly #guards: ProfileExecutionGuards
  readonly #topology: CurrentProfileRuntimeTopologyGuard
  readonly #topologyContext: ProfileRuntimeTopologyContext

  constructor(input: {
    readonly profile: ExecutionProfile
    readonly deploymentProfile: DeploymentComposition['profile']
    readonly candidate: ProfileRuntimeCandidate
    readonly guards: ProfileExecutionGuards
    readonly topology: CurrentProfileRuntimeTopologyGuard
    readonly topologyContext: ProfileRuntimeTopologyContext
  }) {
    this.#profile = input.profile
    this.#deploymentProfile = input.deploymentProfile
    this.#candidate = input.candidate
    this.#guards = input.guards
    this.#topology = input.topology
    this.#topologyContext = input.topologyContext
  }

  async inspect(
    requirements?: readonly CapabilityRequirement[]
  ): Promise<RuntimeAdapterInspection> {
    await assertRuntimeTopology(this.#topology, this.#topologyContext, this.#candidate)
    await assertProfileCompositionResidency({
      profile: this.#profile,
      deploymentProfile: this.#deploymentProfile,
      placement: this.#candidate.placement,
      guard: this.#guards.residency,
    })
    const inspection = await inspectBoundRuntime(
      this.#candidate,
      requirements === undefined ? undefined : parseRequirements(requirements),
      this.#profile,
      this.#deploymentProfile
    )
    await assertRuntimeTopology(this.#topology, this.#topologyContext, this.#candidate)
    await assertProfileCompositionResidency({
      profile: this.#profile,
      deploymentProfile: this.#deploymentProfile,
      placement: this.#candidate.placement,
      guard: this.#guards.residency,
    })
    return inspection
  }

  async start(requestInput: RuntimeStartRequest): Promise<RuntimeExecutionHandle> {
    const request = RuntimeStartRequestSchema.parse(requestInput)
    const requirements = parseRequirements(request.executionPlan.runtimeRequirements)
    assertEligible(await this.inspect(requirements), requirements)
    const target = {
      kind: 'plan' as const,
      ...(request.attemptBudget === undefined
        ? {}
        : { workspaceId: request.attemptBudget.workspaceId }),
      ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
      attemptId: request.attemptId,
      executionPlanId: request.executionPlan.executionPlanId,
      contentDigest: request.executionPlan.contentDigest,
      schemaVersion: request.executionPlan.schemaVersion,
    }
    await this.#assertCurrent('runtime.start', target)
    const handle = parseHandle(await this.#candidate.adapter.start(request))
    if (handle.attemptId !== request.attemptId) {
      throw new ProfileAdapterError('PROFILE_RUNTIME_BINDING_MISMATCH', {
        reason: 'START_HANDLE_ATTEMPT_MISMATCH',
      })
    }
    await this.#assertCurrent('runtime.start', target)
    await this.#assertCurrent('runtime.start', handleTarget(handle))
    return handle
  }

  async *progress(handle: RuntimeExecutionHandle, options: RuntimeProgressOptions = {}) {
    const parsedHandle = parseHandle(handle)
    if (options.signal?.aborted) return
    if (
      options.afterSequence !== undefined &&
      (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0)
    ) {
      throw new ProfileAdapterError('PROFILE_RUNTIME_PROGRESS_INVALID', {
        reason: 'CURSOR_INVALID',
      })
    }
    let lastSequence = options.afterSequence ?? 0
    await this.#assertCurrent('runtime.progress', handleTarget(parsedHandle))
    for await (const eventInput of this.#candidate.adapter.progress(parsedHandle, options)) {
      if (options.signal?.aborted) return
      let event: ReturnType<typeof RuntimeExecutionProgressSchema.parse>
      try {
        event = RuntimeExecutionProgressSchema.parse(eventInput)
      } catch {
        throw new ProfileAdapterError('PROFILE_RUNTIME_PROGRESS_INVALID', {
          reason: 'EVENT_SCHEMA_INVALID',
        })
      }
      if (event.handleId !== parsedHandle.handleId || event.sequence <= lastSequence) {
        throw new ProfileAdapterError('PROFILE_RUNTIME_PROGRESS_INVALID', {
          reason: 'EVENT_HANDLE_OR_SEQUENCE_MISMATCH',
        })
      }
      lastSequence = event.sequence
      await this.#assertCurrent('runtime.progress', handleTarget(parsedHandle))
      yield event
    }
  }

  async submitInput(handle: RuntimeExecutionHandle, request: RuntimeInputRequest) {
    const parsedHandle = parseHandle(handle)
    const parsedRequest = RuntimeInputRequestSchema.parse(request)
    await this.#assertCurrent('runtime.input', {
      kind: 'interaction',
      handleId: parsedHandle.handleId,
      attemptId: parsedHandle.attemptId,
      startedAt: parsedHandle.startedAt,
      ...(parsedHandle.externalSessionId === undefined
        ? {}
        : { externalSessionId: parsedHandle.externalSessionId }),
      interactionId: parsedRequest.interactionId,
    })
    const status = parseStatusForHandle(
      await this.#candidate.adapter.submitInput(parsedHandle, parsedRequest),
      parsedHandle
    )
    await this.#assertCurrent('runtime.input', handleTarget(parsedHandle))
    return status
  }

  async submitApproval(handle: RuntimeExecutionHandle, request: RuntimeApprovalRequest) {
    const parsedHandle = parseHandle(handle)
    const parsedRequest = RuntimeApprovalRequestSchema.parse(request)
    await this.#assertCurrent('runtime.approval', {
      kind: 'interaction',
      handleId: parsedHandle.handleId,
      attemptId: parsedHandle.attemptId,
      startedAt: parsedHandle.startedAt,
      ...(parsedHandle.externalSessionId === undefined
        ? {}
        : { externalSessionId: parsedHandle.externalSessionId }),
      interactionId: parsedRequest.interactionId,
    })
    const status = parseStatusForHandle(
      await this.#candidate.adapter.submitApproval(parsedHandle, parsedRequest),
      parsedHandle
    )
    await this.#assertCurrent('runtime.approval', handleTarget(parsedHandle))
    return status
  }

  async cancel(handle: RuntimeExecutionHandle, request: RuntimeCancelRequest) {
    const parsedHandle = parseHandle(handle)
    const parsedRequest = RuntimeCancelRequestSchema.parse(request)
    await this.#assertCurrent('runtime.cancel', handleTarget(parsedHandle))
    const status = parseStatusForHandle(
      await this.#candidate.adapter.cancel(parsedHandle, parsedRequest),
      parsedHandle
    )
    await this.#assertCurrent('runtime.cancel', handleTarget(parsedHandle))
    return status
  }

  async status(handle: RuntimeExecutionHandle) {
    const parsedHandle = parseHandle(handle)
    await this.#assertCurrent('runtime.status', handleTarget(parsedHandle))
    const status = parseStatusForHandle(
      await this.#candidate.adapter.status(parsedHandle),
      parsedHandle
    )
    await this.#assertCurrent('runtime.status', handleTarget(parsedHandle))
    return status
  }

  async reconcile(handle: RuntimeExecutionHandle) {
    const parsedHandle = parseHandle(handle)
    await this.#assertCurrent('runtime.reconcile', handleTarget(parsedHandle))
    const status = parseStatusForHandle(
      await this.#candidate.adapter.reconcile(parsedHandle),
      parsedHandle
    )
    await this.#assertCurrent('runtime.reconcile', handleTarget(parsedHandle))
    return status
  }

  async session(operation: RuntimeSessionOperation): Promise<RuntimeSessionResult> {
    const parsedOperation = RuntimeSessionOperationSchema.parse(operation)
    const target = {
      kind: 'session' as const,
      operation: parsedOperation.operation,
      ...('sessionId' in parsedOperation ? { sessionId: parsedOperation.sessionId } : {}),
    }
    await this.#assertCurrent('runtime.session', target)
    const result = RuntimeSessionResultSchema.parse(
      await this.#candidate.adapter.session(parsedOperation)
    )
    if (result.operation !== parsedOperation.operation) {
      throw new ProfileAdapterError('PROFILE_RUNTIME_BINDING_MISMATCH', {
        reason: 'SESSION_RESULT_OPERATION_MISMATCH',
      })
    }
    if (
      'sessionId' in parsedOperation &&
      'session' in result &&
      result.session.sessionId !== parsedOperation.sessionId
    ) {
      throw new ProfileAdapterError('PROFILE_RUNTIME_BINDING_MISMATCH', {
        reason: 'SESSION_RESULT_ID_MISMATCH',
      })
    }
    await this.#assertCurrent('runtime.session', target)
    return result
  }

  async cleanup(handle: RuntimeExecutionHandle): Promise<void> {
    const parsedHandle = parseHandle(handle)
    await this.#assertCurrent('runtime.cleanup', handleTarget(parsedHandle))
    await this.#candidate.adapter.cleanup(parsedHandle)
    await this.#assertCurrent('runtime.cleanup', handleTarget(parsedHandle))
  }

  async #assertCurrent(
    operation: Parameters<typeof assertProfileGuards>[1]['operation'],
    target: Parameters<typeof assertProfileGuards>[1]['target']
  ): Promise<void> {
    await assertProfileGuards(this.#guards, {
      profile: this.#profile,
      deploymentProfile: this.#deploymentProfile,
      operation,
      target,
      placement: this.#candidate.placement,
    })
    await assertRuntimeTopology(this.#topology, this.#topologyContext, this.#candidate)
  }
}

function parseHandle(input: RuntimeExecutionHandle): RuntimeExecutionHandle {
  try {
    return RuntimeExecutionHandleSchema.parse(input)
  } catch {
    throw new ProfileAdapterError('PROFILE_RUNTIME_BINDING_MISMATCH', {
      reason: 'HANDLE_INVALID',
    })
  }
}

function handleTarget(handle: RuntimeExecutionHandle) {
  return { kind: 'handle' as const, ...handle }
}

function parseStatusForHandle(
  input: RuntimeExecutionStatus,
  expectedHandle: RuntimeExecutionHandle
): RuntimeExecutionStatus {
  let status: RuntimeExecutionStatus
  try {
    status = RuntimeExecutionStatusSchema.parse(input)
  } catch {
    throw new ProfileAdapterError('PROFILE_RUNTIME_BINDING_MISMATCH', {
      reason: 'STATUS_INVALID',
    })
  }
  if (!sameHandle(status.handle, expectedHandle)) {
    throw new ProfileAdapterError('PROFILE_RUNTIME_BINDING_MISMATCH', {
      reason: 'STATUS_HANDLE_MISMATCH',
    })
  }
  return status
}

function sameHandle(left: RuntimeExecutionHandle, right: RuntimeExecutionHandle): boolean {
  return (
    left.handleId === right.handleId &&
    left.attemptId === right.attemptId &&
    left.startedAt === right.startedAt &&
    left.externalSessionId === right.externalSessionId
  )
}

async function assertRuntimeTopology(
  guard: CurrentProfileRuntimeTopologyGuard,
  context: ProfileRuntimeTopologyContext,
  candidate: ProfileRuntimeCandidate
): Promise<void> {
  if (candidate.transport.kind !== context.expectedTransportKind) {
    throw new ProfileAdapterError('PROFILE_RUNTIME_TRANSPORT_MISMATCH', {
      profile: context.profile,
      actual: candidate.transport.kind,
      expected: context.expectedTransportKind,
    })
  }
  await guard.assertCurrent(context, {
    adapter: candidate.adapter,
    transport: candidate.transport,
  })
}

async function inspectBoundRuntime(
  candidate: ProfileRuntimeCandidate,
  requirements: readonly CapabilityRequirement[] | undefined,
  profile: ExecutionProfile,
  deploymentProfile: DeploymentComposition['profile']
): Promise<RuntimeAdapterInspection> {
  let adapterInspection: RuntimeAdapterInspection
  let transportInspection: RuntimeAdapterInspection
  try {
    const [adapterResult, transportResult] = await Promise.all([
      candidate.adapter.inspect(requirements),
      candidate.transport.inspect(requirements),
    ])
    adapterInspection = RuntimeAdapterInspectionSchema.parse(adapterResult)
    transportInspection = RuntimeAdapterInspectionSchema.parse(transportResult)
  } catch {
    throw new ProfileAdapterError('PROFILE_RUNTIME_UNAVAILABLE', { profile, deploymentProfile })
  }

  const declaredTransport = (candidate.adapter as Partial<RuntimeAdapterWithTransport>)
    .transportKind
  if (
    (declaredTransport !== undefined && declaredTransport !== candidate.transport.kind) ||
    (adapterInspection.metadata.transportKind !== undefined &&
      adapterInspection.metadata.transportKind !== candidate.transport.kind) ||
    (transportInspection.metadata.transportKind !== undefined &&
      transportInspection.metadata.transportKind !== candidate.transport.kind)
  ) {
    throw new ProfileAdapterError('PROFILE_RUNTIME_TRANSPORT_MISMATCH', {
      profile,
      transportKind: candidate.transport.kind,
    })
  }
  if (!inspectionsMatch(adapterInspection, transportInspection)) {
    throw new ProfileAdapterError('PROFILE_RUNTIME_BINDING_MISMATCH', {
      profile,
      adapterName: adapterInspection.metadata.adapterName,
      transportAdapterName: transportInspection.metadata.adapterName,
    })
  }
  if (adapterInspection.health !== 'healthy' || transportInspection.health !== 'healthy') {
    throw new ProfileAdapterError('PROFILE_RUNTIME_UNAVAILABLE', {
      profile,
      health: adapterInspection.health,
    })
  }
  // The hosted profile requires a positively qualified managed-cloud adapter:
  // an adapter that declares the cloud-profile-unqualified denial fails
  // closed even when it is healthy and advertises capabilities.
  if (profile === ExecutionProfiles.hosted) {
    const denial = adapterInspection.limitations.find((limitation) =>
      HOSTED_RUNTIME_QUALIFICATION_DENIALS.has(limitation)
    )
    if (denial !== undefined) {
      throw new ProfileAdapterError('PROFILE_RUNTIME_NOT_QUALIFIED', {
        profile,
        limitation: denial,
      })
    }
  }

  assertEligible(adapterInspection, requirements ?? [])
  const { capabilityEvaluation: _reportedEvaluation, ...inspectionWithoutEvaluation } =
    adapterInspection
  return RuntimeAdapterInspectionSchema.parse({
    ...inspectionWithoutEvaluation,
    ...(requirements === undefined
      ? {}
      : {
          capabilityEvaluation: evaluateCapabilities(adapterInspection.capabilities, requirements),
        }),
  })
}

function inspectionsMatch(
  left: RuntimeAdapterInspection,
  right: RuntimeAdapterInspection
): boolean {
  const metadataMatches =
    left.metadata.contractVersion.major === right.metadata.contractVersion.major &&
    left.metadata.contractVersion.minor === right.metadata.contractVersion.minor &&
    left.metadata.adapterName === right.metadata.adapterName &&
    left.metadata.adapterVersion === right.metadata.adapterVersion &&
    left.metadata.runtimeFamily === right.metadata.runtimeFamily &&
    left.metadata.driverVersion === right.metadata.driverVersion &&
    left.metadata.harnessVersion === right.metadata.harnessVersion
  return (
    metadataMatches &&
    left.health === right.health &&
    runtimeCapabilitiesEqual(left.capabilities, right.capabilities) &&
    JSON.stringify(left.agentPlugins) === JSON.stringify(right.agentPlugins) &&
    JSON.stringify(left.limitations) === JSON.stringify(right.limitations)
  )
}

function assertEligible(
  inspection: RuntimeAdapterInspection,
  requirements: readonly CapabilityRequirement[]
): void {
  const result = evaluateCapabilities(inspection.capabilities, requirements)
  if (!result.eligible) {
    throw new ProfileAdapterError('PROFILE_RUNTIME_CAPABILITY_UNAVAILABLE', {
      missingRequired: result.missingRequired.join(','),
      insufficientRequired: result.insufficientRequired.join(','),
    })
  }
}

function parseRequirements(
  input: readonly CapabilityRequirement[]
): readonly CapabilityRequirement[] {
  try {
    return CapabilityRequirementSetSchema.parse(input)
  } catch {
    throw new ProfileAdapterError('PROFILE_RUNTIME_CAPABILITY_UNAVAILABLE', {
      reason: 'CAPABILITY_REQUIREMENTS_INVALID',
    })
  }
}

function expectedTransportKind(
  profile: ExecutionProfile,
  placement: TrustedProfilePlacement
): RuntimeTransport['kind'] {
  if (profile === ExecutionProfiles.local) return 'direct-local'
  if (profile === ExecutionProfiles.selfHosted)
    return placement.coLocated ? 'direct-local' : 'remote-gateway'
  // Hosted execution is managed-cloud by definition: the semantic adapter is
  // reached over the authenticated remote gateway, never in-process.
  return 'remote-gateway'
}

function validatePlacement(profile: ExecutionProfile, placement: TrustedProfilePlacement): void {
  if (
    placement.controlPlaneHostId.length === 0 ||
    placement.runtimeHostId.length === 0 ||
    placement.coLocated !== (placement.controlPlaneHostId === placement.runtimeHostId)
  ) {
    throw new ProfileAdapterError('PROFILE_PLACEMENT_MISMATCH', { profile })
  }
  if (
    (profile === ExecutionProfiles.local &&
      (placement.runtimeLocation !== 'local_device' || !placement.coLocated)) ||
    (profile === ExecutionProfiles.selfHosted && placement.runtimeLocation !== 'remote_host') ||
    (profile === ExecutionProfiles.hosted &&
      (placement.runtimeLocation !== 'agent_hq_cloud' || placement.coLocated))
  ) {
    throw new ProfileAdapterError('PROFILE_PLACEMENT_MISMATCH', {
      profile,
      runtimeLocation: placement.runtimeLocation,
    })
  }
}
