import { createHash } from 'node:crypto'
import {
  DECISION_RESOLUTION_CONTRACT_VERSION,
  DecisionLayerResolutionSchema,
  DecisionResolutionRequestSchema,
  type AvailableRuntime,
  type DecisionLayerResolution,
  type DecisionPins,
  type DecisionResolutionDiagnostic,
  type DecisionResolutionRequest,
  type ResolutionSource,
} from '@control-plane/contracts'

/**
 * Decision-layer resolution (control-plane#558): precedence-based selection of
 * harness/model/skills/capabilities/runtime/sandbox/context-package/delegation.
 * Resolution is logistics — it selects among what harnesses expose; it never
 * authorizes. Callers must still pass the resolved selection through the
 * PolicyDecisionPoint authorize() per action. Fail-closed: any pin or default
 * that exceeds availability, entitlements, or grants denies the resolution
 * with a diagnostic — it never narrows silently.
 */

const OUTPUT_KEYS = [
  'harness',
  'model',
  'skills',
  'capabilities',
  'runtime',
  'sandbox',
  'contextPackage',
  'delegation',
] as const
export type DecisionOutputKey = (typeof OUTPUT_KEYS)[number]

/** Policy defaults are the last precedence layer and may pin any output. */
export type DecisionLayerPolicyDefaults = DecisionPins

type ResolutionOutputs = DecisionLayerResolution['resolution']
type ResolutionValue<Key extends DecisionOutputKey> = ResolutionOutputs[Key]
type PinValue<Key extends DecisionOutputKey> = NonNullable<DecisionPins[Key]>

type PinSelection<Key extends DecisionOutputKey> = {
  source: ResolutionSource
  pin: PinValue<Key> | undefined
}

const PRECEDENCE_LAYERS: ReadonlyArray<{
  source: ResolutionSource
  pick: (request: DecisionResolutionRequest, policyDefaults: DecisionPins) => DecisionPins
}> = [
  { source: 'explicit-pin', pick: (request) => request.explicitPins },
  { source: 'project-default', pick: (request) => request.projectDefaults },
  { source: 'profile-default', pick: (request) => request.profileDefaults },
  { source: 'policy-default', pick: (_request, policyDefaults) => policyDefaults },
]

export class DecisionResolutionDeniedError extends Error {
  readonly code: DecisionResolutionDiagnostic
  constructor(code: DecisionResolutionDiagnostic) {
    super(`DECISION_RESOLUTION_DENIED: ${code}`)
    this.name = 'DecisionResolutionDeniedError'
    this.code = code
  }
}

function pickPin<Key extends DecisionOutputKey>(
  key: Key,
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins
): PinSelection<Key> {
  for (const layer of PRECEDENCE_LAYERS) {
    const pin = layer.pick(request, policyDefaults)[key]
    if (pin !== undefined) return { source: layer.source, pin } as PinSelection<Key>
  }
  return { source: 'policy-default', pin: undefined }
}

function resolveRuntime(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins
): { runtime: AvailableRuntime; source: ResolutionSource } {
  const { source, pin } = pickPin('runtime', request, policyDefaults)
  if (pin !== undefined) {
    const match = request.availableRuntimes.find(
      (candidate) => candidate.runtimeDefinitionId === pin.runtimeDefinitionId
    )
    if (
      match === undefined ||
      !request.requiredCapabilities.every((capability) => match.capabilities.includes(capability))
    ) {
      throw new DecisionResolutionDeniedError('UNSUPPORTED_RUNTIME_PIN')
    }
    return { runtime: match, source }
  }

  const capable = request.availableRuntimes.filter((candidate) =>
    request.requiredCapabilities.every((capability) => candidate.capabilities.includes(capability))
  )
  const preferred =
    capable.find((candidate) => candidate.kind === 'local') ??
    capable.find((candidate) => candidate.kind === 'self-hosted') ??
    capable.find((candidate) => candidate.kind === 'cloud')
  if (preferred === undefined) throw new DecisionResolutionDeniedError('UNSUPPORTED_RUNTIME_PIN')
  return { runtime: preferred, source: 'policy-default' }
}

function resolveHarness(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins,
  runtime: AvailableRuntime
): { value: ResolutionValue<'harness'>; source: ResolutionSource } {
  const { source, pin } = pickPin('harness', request, policyDefaults)
  if (pin !== undefined) {
    if (!runtime.harnessIds.includes(pin.harnessId)) {
      throw new DecisionResolutionDeniedError('HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME')
    }
    return { value: pin, source }
  }
  const harnessId = runtime.harnessIds[0]
  if (harnessId === undefined) {
    throw new DecisionResolutionDeniedError('HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME')
  }
  return { value: { harnessId }, source: 'policy-default' }
}

function resolveModel(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins
): {
  value: ResolutionValue<'model'>
  source: ResolutionSource
} {
  const { source, pin } = pickPin('model', request, policyDefaults)
  if (pin !== undefined) {
    if (request.entitlements.modelAccess === 'none') {
      throw new DecisionResolutionDeniedError('MODEL_ACCESS_NOT_ENTITLED')
    }
    return { value: pin, source }
  }
  // No pin at any layer: a model is only resolvable when access is entitled
  // AND the policy names a default model; otherwise it is withheld (the
  // no-provider/no-model baseline stays a supported resolution).
  if (request.entitlements.modelAccess === 'none') {
    return { value: { withheld: 'MODEL_ACCESS_NOT_ENTITLED' }, source: 'policy-default' }
  }
  const policyModel = policyDefaults.model
  if (policyModel !== undefined) return { value: policyModel, source: 'policy-default' }
  return { value: { withheld: 'NO_DEFAULT_MODEL' }, source: 'policy-default' }
}

function resolveCapabilities(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins
): { value: ResolutionValue<'capabilities'>; source: ResolutionSource } {
  const granted = new Set(request.entitlements.grantedCapabilityNames)
  const { source, pin } = pickPin('capabilities', request, policyDefaults)
  if (pin !== undefined) {
    if (!pin.capabilityNames.every((capability) => granted.has(capability))) {
      throw new DecisionResolutionDeniedError('CAPABILITY_BEYOND_GRANT')
    }
    return { value: pin, source }
  }
  if (!request.requiredCapabilities.every((capability) => granted.has(capability))) {
    throw new DecisionResolutionDeniedError('CAPABILITY_BEYOND_GRANT')
  }
  return { value: { capabilityNames: [...request.requiredCapabilities] }, source: 'policy-default' }
}

function resolveSandbox(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins,
  resolvedCapabilities: string[]
): { value: ResolutionValue<'sandbox'>; source: ResolutionSource } {
  const granted = new Set(request.entitlements.grantedCapabilityNames)
  // Sandbox selection intersects resolved capabilities with grants; it never
  // grants beyond them (adea M10 #33 boundary).
  const effective = resolvedCapabilities.filter((capability) => granted.has(capability))
  const { source, pin } = pickPin('sandbox', request, policyDefaults)
  if (pin !== undefined) {
    if (!pin.effectiveCapabilities.every((capability) => effective.includes(capability))) {
      throw new DecisionResolutionDeniedError('CAPABILITY_BEYOND_GRANT')
    }
    return { value: pin, source }
  }
  return {
    value: { mode: effective.length > 0 ? 'managed' : 'none', effectiveCapabilities: effective },
    source: 'policy-default',
  }
}

function resolveContextPackage(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins
): { value: ResolutionValue<'contextPackage'>; source: ResolutionSource } {
  const { source, pin } = pickPin('contextPackage', request, policyDefaults)
  if (pin !== undefined) {
    if (pin.mode === 'existing' && pin.contextPackageId === undefined) {
      throw new DecisionResolutionDeniedError('CONTEXT_PACKAGE_PIN_MISMATCH')
    }
    return { value: pin, source }
  }
  return { value: { mode: 'none' }, source: 'policy-default' }
}

function jsonSafe<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

/**
 * Resolve the eight decision-layer outputs for a request. Pure and
 * synchronous: the CP composition supplies defaults from its own stores
 * (project settings, synced AgentProfile, policy defaults); adea supplies
 * explicit pins from the developer surfaces. Throws
 * {@link DecisionResolutionDeniedError} fail-closed.
 */
export function resolveDecisionLayer(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionLayerPolicyDefaults
): DecisionLayerResolution {
  const parsed = DecisionResolutionRequestSchema.parse(request)
  if (parsed.contractVersion.major !== DECISION_RESOLUTION_CONTRACT_VERSION.major) {
    throw new Error('UNSUPPORTED_DECISION_RESOLUTION_CONTRACT_VERSION')
  }

  const capabilities = resolveCapabilities(parsed, policyDefaults)
  const runtimeSelection = resolveRuntime(parsed, policyDefaults)
  const harness = resolveHarness(parsed, policyDefaults, runtimeSelection.runtime)
  const model = resolveModel(parsed, policyDefaults)
  const sandbox = resolveSandbox(parsed, policyDefaults, capabilities.value.capabilityNames)
  const contextPackage = resolveContextPackage(parsed, policyDefaults)
  const delegation = pickPin('delegation', parsed, policyDefaults)
  const skills = pickPin('skills', parsed, policyDefaults)

  const resolution: ResolutionOutputs = {
    harness: harness.value,
    model: model.value,
    skills: skills.pin ?? { skillVersionIds: [] },
    capabilities: capabilities.value,
    runtime: runtimeSelection.runtime,
    sandbox: sandbox.value,
    contextPackage: contextPackage.value,
    delegation: delegation.pin ?? {
      fanOut: 'none',
      promotion: 'review-required',
    },
  }

  const trace = {
    harness: { source: harness.source, value: jsonSafe(resolution.harness) },
    model: { source: model.source, value: jsonSafe(resolution.model) },
    skills: { source: skills.source, value: jsonSafe(resolution.skills) },
    capabilities: { source: capabilities.source, value: jsonSafe(resolution.capabilities) },
    runtime: { source: runtimeSelection.source, value: jsonSafe(resolution.runtime) },
    sandbox: { source: sandbox.source, value: jsonSafe(resolution.sandbox) },
    contextPackage: { source: contextPackage.source, value: jsonSafe(resolution.contextPackage) },
    delegation: { source: delegation.source, value: jsonSafe(resolution.delegation) },
  }

  const diagnostics: DecisionResolutionDiagnostic[] = []
  if ('withheld' in resolution.model) diagnostics.push(resolution.model.withheld)

  const resolutionDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify({ resolution, trace }))
    .digest('hex')}`

  return DecisionLayerResolutionSchema.parse({
    schemaVersion: 1,
    requestId: parsed.requestId,
    workspaceId: parsed.workspaceId,
    contractVersion: DECISION_RESOLUTION_CONTRACT_VERSION,
    resolvedAt: parsed.requestedAt,
    resolution,
    trace,
    diagnostics,
    resolutionDigest,
  })
}
