import { z } from 'zod'
import { ServiceCallerAssertionSchema } from './authentication.js'
import { CorrelationMetadataSchema } from './envelopes.js'
import { IdentifierSchemas } from './identifiers.js'
import { ContractVersionSchema } from './versioning.js'

/**
 * Decision-layer contract (control-plane#558).
 *
 * The Control Plane owns the decision layer that resolves what runs: harness,
 * model, skills, tools/capabilities, runtime, sandbox, context package, and
 * delegation policy. Resolution is logistics — it selects among what harnesses
 * expose; it never implements routing inside a harness's model semantics
 * (owner standing directive, adea#400). Precedence for every output:
 * explicit user pin > project default > profile default > policy default.
 * Policy enforcement remains the PolicyDecisionPoint authorize() call; a
 * resolution selects, it never authorizes.
 */

export const DECISION_RESOLUTION_CONTRACT_VERSION = Object.freeze({ major: 1, minor: 0 })

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const CapabilityNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9.-]*$/)
const HarnessIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/)
const ModelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._/-]*$/i)

/** Where a resolved output value came from. Precedence order is list order. */
export const ResolutionSourceSchema = z.enum([
  'explicit-pin',
  'project-default',
  'profile-default',
  'policy-default',
])
export type ResolutionSource = z.output<typeof ResolutionSourceSchema>

/**
 * Sandbox selection stays inside M10-granted capabilities; it never grants.
 * `effectiveCapabilities` is always a subset of the resolved capability set
 * intersected with entitlement grants.
 */
export const SandboxResolutionSchema = z
  .object({
    mode: z.enum(['none', 'managed']),
    effectiveCapabilities: z.array(CapabilityNameSchema).max(64),
  })
  .strict()
export type SandboxResolution = z.output<typeof SandboxResolutionSchema>

export const DelegationResolutionSchema = z
  .object({
    fanOut: z.enum(['none', 'bounded']),
    maxChildren: z.number().int().min(0).max(8).optional(),
    promotion: z.enum(['review-required', 'auto-eligible']),
  })
  .strict()
  .superRefine((delegation, context) => {
    if (delegation.fanOut === 'bounded' && delegation.maxChildren === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['maxChildren'],
        message: 'maxChildren is required when fanOut is bounded',
      })
    }
  })
export type DelegationResolution = z.output<typeof DelegationResolutionSchema>

/**
 * Every output the decision layer resolves. Pins make any subset explicit;
 * unpinned outputs still resolve.
 */
export const DecisionPinsSchema = z
  .object({
    harness: z.strictObject({ harnessId: HarnessIdSchema }).optional(),
    model: z.strictObject({ modelId: ModelIdSchema }).optional(),
    skills: z
      .strictObject({ skillVersionIds: z.array(IdentifierSchemas.skillVersionId).max(64) })
      .optional(),
    capabilities: z
      .strictObject({ capabilityNames: z.array(CapabilityNameSchema).max(64) })
      .optional(),
    runtime: z.strictObject({ runtimeDefinitionId: IdentifierSchemas.runtimeDefinitionId }).optional(),
    sandbox: SandboxResolutionSchema.optional(),
    contextPackage: z
      .strictObject({
        mode: z.enum(['none', 'existing', 'author']),
        contextPackageId: IdentifierSchemas.contextPackageId.optional(),
      })
      .optional(),
    delegation: DelegationResolutionSchema.optional(),
  })
  .strict()
export type DecisionPins = z.output<typeof DecisionPinsSchema>

export const ModelAccessEntitlementSchema = z.enum(['byok', 'provisioned', 'free-tier', 'none'])
export type ModelAccessEntitlement = z.output<typeof ModelAccessEntitlementSchema>

export const AvailableRuntimeSchema = z
  .object({
    runtimeDefinitionId: IdentifierSchemas.runtimeDefinitionId,
    kind: z.enum(['local', 'self-hosted', 'cloud']),
    transport: z.enum(['direct-local', 'remote-gateway']),
    harnessIds: z.array(HarnessIdSchema).max(16),
    capabilities: z.array(CapabilityNameSchema).max(64),
  })
  .strict()
export type AvailableRuntime = z.output<typeof AvailableRuntimeSchema>

export const DecisionResolutionRequestSchema = z
  .object({
    contractVersion: ContractVersionSchema,
    caller: ServiceCallerAssertionSchema,
    requestId: IdentifierSchemas.requestId,
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId.optional(),
    correlation: CorrelationMetadataSchema,
    requestedAt: TimestampSchema,
    objective: z.string().min(1).max(4096),
    agentProfile: z.strictObject({
      profileId: IdentifierSchemas.profileId,
      profileVersionId: IdentifierSchemas.profileVersionId.optional(),
    }),
    availableRuntimes: z.array(AvailableRuntimeSchema).max(64),
    entitlements: z.strictObject({
      modelAccess: ModelAccessEntitlementSchema,
      grantedCapabilityNames: z.array(CapabilityNameSchema).max(64),
    }),
    requiredCapabilities: z.array(CapabilityNameSchema).max(64),
    costLatencyPreference: z.enum(['cost', 'balanced', 'latency']),
    projectDefaults: DecisionPinsSchema,
    profileDefaults: DecisionPinsSchema,
    explicitPins: DecisionPinsSchema,
  })
  .strict()
export type DecisionResolutionRequest = z.output<typeof DecisionResolutionRequestSchema>

/** Fail-closed denial codes; a denial never narrows silently. */
export const DecisionResolutionDiagnosticSchema = z.enum([
  'UNSUPPORTED_RUNTIME_PIN',
  'MODEL_ACCESS_NOT_ENTITLED',
  'NO_DEFAULT_MODEL',
  'CAPABILITY_BEYOND_GRANT',
  'HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME',
  'CONTEXT_PACKAGE_PIN_MISMATCH',
])
export type DecisionResolutionDiagnostic = z.output<typeof DecisionResolutionDiagnosticSchema>

/** One resolved output plus the precedence layer it came from. */
export const ResolvedOutputSchema = z
  .object({
    source: ResolutionSourceSchema,
    value: z.json(),
  })
  .strict()
export type ResolvedOutput = z.output<typeof ResolvedOutputSchema>

export const DecisionLayerResolutionSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    requestId: IdentifierSchemas.requestId,
    workspaceId: IdentifierSchemas.workspaceId,
    contractVersion: ContractVersionSchema,
    resolvedAt: TimestampSchema,
    resolution: z
      .strictObject({
        harness: z.strictObject({ harnessId: HarnessIdSchema }),
        model: z.union([
          z.strictObject({ modelId: ModelIdSchema }),
          z.strictObject({ withheld: DecisionResolutionDiagnosticSchema }),
        ]),
        skills: z.strictObject({
          skillVersionIds: z.array(IdentifierSchemas.skillVersionId).max(64),
        }),
        capabilities: z.strictObject({ capabilityNames: z.array(CapabilityNameSchema).max(64) }),
        runtime: AvailableRuntimeSchema,
        sandbox: SandboxResolutionSchema,
        contextPackage: z.strictObject({
          mode: z.enum(['none', 'existing', 'author']),
          contextPackageId: IdentifierSchemas.contextPackageId.optional(),
        }),
        delegation: DelegationResolutionSchema,
      })
      .strict(),
    trace: z.record(z.string(), ResolvedOutputSchema),
    diagnostics: z.array(DecisionResolutionDiagnosticSchema).max(16),
    resolutionDigest: DigestSchema,
  })
  .strict()
export type DecisionLayerResolution = z.output<typeof DecisionLayerResolutionSchema>
