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

function pickPin(
  key: DecisionOutputKey,
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins,
): { source: ResolutionSource; pin: DecisionPins[DecisionOutputKey] | undefined } {
  for (const layer of PRECEDENCE_LAYERS) {
    const pin = layer.pick(request, policyDefaults)[key]
    if (pin !== undefined) return { source: layer.source, pin }
  }
  return { source: 'policy-default', pin: undefined }
}

function requirePin<Value>(pin: NonNullable<DecisionPins[DecisionOutputKey]>): Value {
  return pin as Value
}

function resolveRuntime(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins,
): { runtime: AvailableRuntime; source: ResolutionSource } {
  const { source, pin } = pickPin('runtime', request, policyDefaults)
  if (pin !== undefined) {
    const pinned = requirePin<{ runtimeDefinitionId: string }>(pin)
    const match = request.availableRuntimes.find(
      (candidate) => candidate.runtimeDefinitionId === pinned.runtimeDefinitionId,
    )
    if (match === undefined) throw new DecisionResolutionDeniedError('UNSUPPORTED_RUNTIME_PIN')
    return { runtime: match, source }
  }

  const capable = request.availableRuntimes.filter((candidate) =>
    request.requiredCapabilities.every((capability) => candidate.capabilities.includes(capability)),
  )
  const preferred =
    capable.find((candidate) => candidate.kind === 'local') ??
    capable.find((candidate) => candidate.kind === 'self-hosted') ??
    capable.find((candidate) => candidate.kind === 'cloud') ??
    request.availableRuntimes[0]
  if (preferred === undefined) throw new DecisionResolutionDeniedError('UNSUPPORTED_RUNTIME_PIN')
  return { runtime: preferred, source: 'policy-default' }
}

function resolveHarness(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins,
  runtime: AvailableRuntime,
): { value: { harnessId: string }; source: ResolutionSource } {
  const { source, pin } = pickPin('harness', request, policyDefaults)
  if (pin !== undefined) {
    const pinned = requirePin<{ harnessId: string }>(pin)
    if (!runtime.harnessIds.includes(pinned.harnessId)) {
      throw new DecisionResolutionDeniedError('HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME')
    }
    return { value: pinned, source }
  }
  const harnessId = runtime.harnessIds[0]
  if (harnessId === undefined) {
    throw new DecisionResolutionDeniedError('HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME')
  }
  return { value: { harnessId }, source: 'policy-default' }
}

function resolveModel(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins,
): {
  value: { modelId: string } | { withheld: DecisionResolutionDiagnostic }
  source: ResolutionSource
} {
  const { source, pin } = pickPin('model', request, policyDefaults)
  if (pin !== undefined) {
    if (request.entitlements.modelAccess === 'none') {
      throw new DecisionResolutionDeniedError('MODEL_ACCESS_NOT_ENTITLED')
    }
    return { value: requirePin<{ modelId: string }>(pin), source }
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
  policyDefaults: DecisionPins,
): { value: { capabilityNames: string[] }; source: ResolutionSource } {
  const granted = new Set(request.entitlements.grantedCapabilityNames)
  const { source, pin } = pickPin('capabilities', request, policyDefaults)
  if (pin !== undefined) {
    const pinned = requirePin<{ capabilityNames: string[] }>(pin)
    if (!pinned.capabilityNames.every((capability) => granted.has(capability))) {
      throw new DecisionResolutionDeniedError('CAPABILITY_BEYOND_GRANT')
    }
    return { value: pinned, source }
  }
  if (!request.requiredCapabilities.every((capability) => granted.has(capability))) {
    throw new DecisionResolutionDeniedError('CAPABILITY_BEYOND_GRANT')
  }
  return { value: { capabilityNames: [...request.requiredCapabilities] }, source: 'policy-default' }
}

function resolveSandbox(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins,
  resolvedCapabilities: string[],
): { value: { mode: 'none' | 'managed'; effectiveCapabilities: string[] }; source: ResolutionSource } {
  const granted = new Set(request.entitlements.grantedCapabilityNames)
  // Sandbox selection intersects resolved capabilities with grants; it never
  // grants beyond them (adea M10 #33 boundary).
  const effective = resolvedCapabilities.filter((capability) => granted.has(capability))
  const { source, pin } = pickPin('sandbox', request, policyDefaults)
  if (pin !== undefined) {
    const pinned = requirePin<{ mode: 'none' | 'managed'; effectiveCapabilities: string[] }>(pin)
    if (!pinned.effectiveCapabilities.every((capability) => effective.includes(capability))) {
      throw new DecisionResolutionDeniedError('CAPABILITY_BEYOND_GRANT')
    }
    return { value: pinned, source }
  }
  return {
    value: { mode: effective.length > 0 ? 'managed' : 'none', effectiveCapabilities: effective },
    source: 'policy-default',
  }
}

function resolveContextPackage(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins,
): {
  value: { mode: 'none' | 'existing' | 'author'; contextPackageId?: string }
  source: ResolutionSource
} {
  const { source, pin } = pickPin('contextPackage', request, policyDefaults)
  if (pin !== undefined) {
    const pinned = requirePin<{ mode: 'none' | 'existing' | 'author'; contextPackageId?: string }>(pin)
    if (pinned.mode === 'existing' && pinned.contextPackageId === undefined) {
      throw new DecisionResolutionDeniedError('CONTEXT_PACKAGE_PIN_MISMATCH')
    }
    return { value: pinned, source }
  }
  return { value: { mode: 'none' }, source: 'policy-default' }
}

function digestResolution(
  resolution: DecisionLayerResolution['resolution'],
  trace: DecisionLayerResolution['trace'],
): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ resolution, trace })).digest('hex')}`
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
  policyDefaults: DecisionLayerPolicyDefaults,
): DecisionLayerResolution {
  const parsed = DecisionResolutionRequestSchema.parse({
    ...request,
    contractVersion: DECISION_RESOLUTION_CONTRACT_VERSION,
  })

  const runtimeSelection = resolveRuntime(parsed, policyDefaults)
  const harness = resolveHarness(parsed, policyDefaults, runtimeSelection.runtime)
  const model = resolveModel(parsed, policyDefaults)
  const capabilities = resolveCapabilities(parsed, policyDefaults)
  const sandbox = resolveSandbox(parsed, policyDefaults, capabilities.value.capabilityNames)
  const contextPackage = resolveContextPackage(parsed, policyDefaults)
  const delegationPin = pickPin('delegation', parsed, policyDefaults)
  const skillsPin = pickPin('skills', parsed, policyDefaults)

  const resolution = {
    harness: harness.value,
    model: model.value,
    skills:
      skillsPin.pin !== undefined
        ? requirePin<{ skillVersionIds: string[] }>(skillsPin.pin)
        : { skillVersionIds: [] },
    capabilities: capabilities.value,
    runtime: runtimeSelection.runtime,
    sandbox: sandbox.value,
    contextPackage: contextPackage.value,
    delegation:
      delegationPin.pin !== undefined
        ? requirePin<DecisionLayerResolution['resolution']['delegation']>(delegationPin.pin)
        : { fanOut: 'none' as const, promotion: 'review-required' as const },
  }

  const trace: DecisionLayerResolution['trace'] = {
    harness: { source: harness.source, value: harness.value },
    model: { source: model.source, value: model.value },
    skills: { source: skillsPin.source, value: resolution.skills },
    capabilities: { source: capabilities.source, value: capabilities.value },
    runtime: { source: runtimeSelection.source, value: runtimeSelection.runtime },
    sandbox: { source: sandbox.source, value: sandbox.value },
    contextPackage: { source: contextPackage.source, value: contextPackage.value },
    delegation: { source: delegationPin.source, value: resolution.delegation },
  }

  const diagnostics: DecisionResolutionDiagnostic[] = []
  if ('withheld' in resolution.model) diagnostics.push(resolution.model.withheld)

  return DecisionLayerResolutionSchema.parse({
    schemaVersion: 1,
    requestId: parsed.requestId,
    workspaceId: parsed.workspaceId,
    contractVersion: DECISION_RESOLUTION_CONTRACT_VERSION,
    resolvedAt: parsed.requestedAt,
    resolution,
    trace,
    diagnostics,
    resolutionDigest: digestResolution(resolution, trace),
  })
}
