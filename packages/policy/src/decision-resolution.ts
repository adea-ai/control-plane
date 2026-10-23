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
export type DecisionLayerPolicyDefaults = DecisionPins & {
  /**
   * The deployment's per-model harness map (M12/#678). Absent leaves every
   * resolution exactly as it is today.
   */
  readonly harnessByModel?: Readonly<Record<string, string>>
}

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
  policyDefaults: DecisionLayerPolicyDefaults,
  model: ModelSelection
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
  const harnessPin = pickPin('harness', request, policyDefaults).pin?.harnessId
  if (capable.length === 0) {
    throw new DecisionResolutionDeniedError(
      harnessPin === undefined ? 'UNSUPPORTED_RUNTIME_PIN' : 'NO_COMPATIBLE_RUNTIME'
    )
  }
  // An accepted harness pin is a hard candidate filter applied before runtime
  // selection: only runtimes that expose that exact harness id qualify. No
  // other harness, runtime, or model is substituted; if none qualifies the
  // request is denied with NO_COMPATIBLE_RUNTIME.
  const eligible =
    harnessPin === undefined
      ? capable
      : capable.filter((candidate) => candidate.harnessIds.includes(harnessPin))
  if (eligible.length === 0) throw new DecisionResolutionDeniedError('NO_COMPATIBLE_RUNTIME')
  // The configured per-model map (M12/#678) is a hard candidate filter as
  // well, and it is applied before ranking: a runtime that cannot serve the
  // mapped harness is not a candidate, however it would have ranked.
  const ranked = filterByMappedHarness(eligible, request, policyDefaults, model)
  if (ranked.length === 0) throw new DecisionResolutionDeniedError('NO_COMPATIBLE_RUNTIME')
  const preferred =
    ranked.find((candidate) => candidate.kind === 'local') ??
    ranked.find((candidate) => candidate.kind === 'self-hosted') ??
    ranked.find((candidate) => candidate.kind === 'cloud')
  if (preferred === undefined) throw new DecisionResolutionDeniedError('UNSUPPORTED_RUNTIME_PIN')
  return { runtime: preferred, source: 'policy-default' }
}

/**
 * Narrow harness resolution against a single runtime (M12/#670 path 1). Same
 * semantics resolveDecisionLayer applies — an explicit pin must be exposed by
 * the runtime, otherwise the first exposed harness id is the default — so
 * routing layers can validate a chosen runtime without assembling a full
 * decision-resolution request.
 */
export function resolveRuntimeHarness(
  runtime: AvailableRuntime,
  pinnedHarnessId?: string
): { harnessId: string; source: ResolutionSource } {
  if (pinnedHarnessId !== undefined) {
    if (!runtime.harnessIds.includes(pinnedHarnessId)) {
      throw new DecisionResolutionDeniedError('HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME')
    }
    return { harnessId: pinnedHarnessId, source: 'explicit-pin' }
  }
  const harnessId = runtime.harnessIds[0]
  if (harnessId === undefined) {
    throw new DecisionResolutionDeniedError('HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME')
  }
  return { harnessId, source: 'policy-default' }
}

/**
 * The harness id a model is mapped to (M12/#678).
 *
 * A configured map is a policy, not a fallback. With no map the caller's pin
 * is used unchanged. With a map the execution must carry a model, the map
 * must name that model, and a pin that names another harness is a conflict
 * rather than a silent substitution.
 *
 * @throws {DecisionResolutionDeniedError} when the map cannot be satisfied.
 */
export function resolveMappedHarness(input: {
  readonly harnessByModel?: Readonly<Record<string, string>>
  readonly modelId?: string
  readonly pinnedHarnessId?: string
}): { readonly harnessId: string | undefined; readonly mapped: boolean } {
  const map = input.harnessByModel
  if (map === undefined) {
    return { harnessId: input.pinnedHarnessId, mapped: false }
  }
  if (input.modelId === undefined) {
    throw new DecisionResolutionDeniedError('HARNESS_MAP_MODEL_ABSENT')
  }
  // Own-property lookup: a model id such as `constructor` or `toString` is
  // unmapped, never an inherited object property.
  if (!Object.hasOwn(map, input.modelId)) {
    throw new DecisionResolutionDeniedError('HARNESS_MAP_MODEL_UNMAPPED')
  }
  const mapped = map[input.modelId]
  if (mapped === undefined) {
    throw new DecisionResolutionDeniedError('HARNESS_MAP_MODEL_UNMAPPED')
  }
  if (input.pinnedHarnessId !== undefined && input.pinnedHarnessId !== mapped) {
    throw new DecisionResolutionDeniedError('HARNESS_MAP_CONFLICTS_WITH_PIN')
  }
  return { harnessId: mapped, mapped: true }
}

function resolveHarness(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionLayerPolicyDefaults,
  runtime: AvailableRuntime,
  model: ResolutionValue<'model'>
): { value: ResolutionValue<'harness'>; source: ResolutionSource } {
  const { source, pin } = pickPin('harness', request, policyDefaults)
  // A configured per-model map (M12/#678) decides the harness for the
  // resolved model. The explicit pin stays independent: it may agree with the
  // map, and a disagreement is denied instead of silently substituting either
  // side.
  const mapped = resolveMappedHarness({
    ...(policyDefaults.harnessByModel === undefined
      ? {}
      : { harnessByModel: policyDefaults.harnessByModel }),
    ...('modelId' in model ? { modelId: model.modelId } : {}),
    ...(pin?.harnessId === undefined ? {} : { pinnedHarnessId: pin.harnessId }),
  })
  const resolved = resolveRuntimeHarness(runtime, mapped.harnessId)
  return {
    value: { harnessId: resolved.harnessId },
    source: pin === undefined ? resolved.source : source,
  }
}

/**
 * The model a request resolves to, before any denial is raised.
 *
 * A model the caller is not entitled to is denied rather than resolved: it has
 * no id, so the configured per-model map has nothing to select on. The denial
 * is raised by the caller at the point in the sequence where it was raised
 * before, so the resolution order — and the diagnostic a request earns — is
 * unchanged.
 */
type ModelSelection = {
  readonly value: ResolutionValue<'model'>
  readonly source: ResolutionSource
  readonly denial: DecisionResolutionDiagnostic | undefined
}

/**
 * The arguments the configured per-model map is consulted with: the map, the
 * resolved model id, and the harness pin the map has to agree with.
 *
 * The harness resolution builds the same arguments inline. That block is
 * reserved for Fleet2 F2W1, so it is left exactly as it is and the arguments
 * are built again here, for the candidate filter that runs before ranking.
 */
function harnessMapArguments(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionLayerPolicyDefaults,
  model: ResolutionValue<'model'>
): {
  readonly harnessByModel?: Readonly<Record<string, string>>
  readonly modelId?: string
  readonly pinnedHarnessId?: string
} {
  const modelId = 'modelId' in model ? model.modelId : undefined
  const harnessPin = pickPin('harness', request, policyDefaults).pin?.harnessId
  return {
    ...(policyDefaults.harnessByModel === undefined
      ? {}
      : { harnessByModel: policyDefaults.harnessByModel }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(harnessPin === undefined ? {} : { pinnedHarnessId: harnessPin }),
  }
}

/**
 * The harness the configured per-model map names for the resolved model, or
 * undefined when no map is configured. The map's own denials — a model the map
 * does not name, a pin the map contradicts — are raised here.
 */
function resolveMappedHarnessId(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionLayerPolicyDefaults,
  model: ModelSelection
): string | undefined {
  if (policyDefaults.harnessByModel === undefined) return undefined
  const mapped = resolveMappedHarness(harnessMapArguments(request, policyDefaults, model.value))
  return mapped.mapped ? mapped.harnessId : undefined
}

/**
 * The candidates that can serve the mapped harness, applied before ranking.
 *
 * A request whose model was denied has no model id, and the caller denies
 * that request right after the runtime is selected, so there is nothing here
 * for the map to select on and the candidates pass through unchanged.
 */
function filterByMappedHarness(
  candidates: readonly AvailableRuntime[],
  request: DecisionResolutionRequest,
  policyDefaults: DecisionLayerPolicyDefaults,
  model: ModelSelection
): AvailableRuntime[] {
  if (model.denial !== undefined) return [...candidates]
  const mappedHarnessId = resolveMappedHarnessId(request, policyDefaults, model)
  if (mappedHarnessId === undefined) return [...candidates]
  return candidates.filter((candidate) => candidate.harnessIds.includes(mappedHarnessId))
}

function selectModel(
  request: DecisionResolutionRequest,
  policyDefaults: DecisionPins
): ModelSelection {
  const { source, pin } = pickPin('model', request, policyDefaults)
  if (pin !== undefined) {
    if (request.entitlements.modelAccess === 'none') {
      // The pin names a model the caller is not entitled to. The request is
      // denied; the caller raises the denial in the resolution sequence.
      return {
        value: { withheld: 'MODEL_ACCESS_NOT_ENTITLED' },
        source,
        denial: 'MODEL_ACCESS_NOT_ENTITLED',
      }
    }
    return { value: pin, source, denial: undefined }
  }
  // No pin at any layer: a model is only resolvable when access is entitled
  // AND the policy names a default model; otherwise it is withheld (the
  // no-provider/no-model baseline stays a supported resolution).
  if (request.entitlements.modelAccess === 'none') {
    return {
      value: { withheld: 'MODEL_ACCESS_NOT_ENTITLED' },
      source: 'policy-default',
      denial: undefined,
    }
  }
  const policyModel = policyDefaults.model
  if (policyModel !== undefined) {
    return { value: policyModel, source: 'policy-default', denial: undefined }
  }
  return { value: { withheld: 'NO_DEFAULT_MODEL' }, source: 'policy-default', denial: undefined }
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
  // The model is selected before the runtime: a configured per-model map
  // (M12/#678) needs the resolved model to name the harness a candidate
  // runtime has to expose. The selection never raises a denial — the model
  // denial is raised below, where it was raised before.
  const model = selectModel(parsed, policyDefaults)
  const runtimeSelection = resolveRuntime(parsed, policyDefaults, model)
  if (model.denial !== undefined) {
    throw new DecisionResolutionDeniedError(model.denial)
  }
  const harness = resolveHarness(parsed, policyDefaults, runtimeSelection.runtime, model.value)
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

/**
 * Hard candidate filter for runtime routing (#678). Applied before candidate
 * ranking: when an accepted harness id is given, only runtimes that expose that
 * exact id survive, in their original order. No other harness, runtime, or
 * alias is substituted. An empty result is a typed denial, never a fallback.
 * Without a pin the input passes through unchanged.
 */
export function selectRuntimesExposingHarness<
  Runtime extends { readonly harnessIds: readonly string[] },
>(runtimes: readonly Runtime[], acceptedHarnessId?: string): Runtime[] {
  if (acceptedHarnessId === undefined) return [...runtimes]
  const eligible = runtimes.filter((runtime) => runtime.harnessIds.includes(acceptedHarnessId))
  if (eligible.length === 0) throw new DecisionResolutionDeniedError('NO_COMPATIBLE_RUNTIME')
  return eligible
}
