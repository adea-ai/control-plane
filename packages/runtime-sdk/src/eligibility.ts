import { createHash } from 'node:crypto'
import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'
import {
  CapabilityRequirementSetSchema,
  RuntimeCapabilityNameSchema,
  evaluateCapabilities,
} from './capabilities.js'
import { RuntimeNodeHealthStatusSchema } from './health.js'
import {
  RuntimeConnectionLocationSchema,
  RuntimeConnectionSchema,
  RuntimeTimestampSchema,
} from './models.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const RuntimeFamilySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/)
const PolicyReasonCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/)
export const RuntimeEligibilityNodeStatusSchema = z.union([
  RuntimeNodeHealthStatusSchema,
  z.literal('not_applicable'),
])

export const RuntimeEligibilityInputSchema = z
  .object({
    eligibilityVersion: z.literal(1),
    evaluatedAt: RuntimeTimestampSchema,
    executionPlan: z
      .object({
        executionPlanId: IdentifierSchemas.executionPlanId,
        contentDigest: DigestSchema,
        runtimeRequirements: CapabilityRequirementSetSchema,
      })
      .strict(),
    candidate: z
      .object({
        family: RuntimeFamilySchema,
        nodeStatus: RuntimeEligibilityNodeStatusSchema,
        connection: RuntimeConnectionSchema,
      })
      .strict(),
    policy: z
      .object({
        snapshot: z
          .object({
            policyId: z.string().min(1).max(128),
            version: z.number().int().positive(),
            digest: DigestSchema,
          })
          .strict(),
        allowedFamilies: z.array(RuntimeFamilySchema).min(1).max(64),
        allowedLocations: z.array(RuntimeConnectionLocationSchema).min(1).max(8),
        deniedRuntimeConnectionIds: z.array(IdentifierSchemas.runtimeConnectionId).max(256),
        requireVerifiedCapabilities: z.boolean(),
        security: z
          .object({
            status: z.enum(['allowed', 'denied']),
            reasonCode: PolicyReasonCodeSchema.optional(),
          })
          .strict(),
      })
      .strict(),
    localProjectGrant: z
      .object({
        required: z.boolean(),
        status: z.enum(['not_required', 'granted', 'missing', 'revoked']),
        grantRef: z
          .string()
          .min(1)
          .max(256)
          .regex(/^grant:[A-Za-z0-9._:-]+$/)
          .optional(),
      })
      .strict(),
    entitlement: z
      .object({
        status: z.enum(['allowed', 'denied', 'unknown']),
        class: z.string().min(1).max(64),
      })
      .strict(),
    preference: z
      .object({
        runtimeConnectionId: IdentifierSchemas.runtimeConnectionId.optional(),
        family: RuntimeFamilySchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const managedCloud = input.candidate.connection.connectionType === 'managed_cloud'
    if (managedCloud !== (input.candidate.nodeStatus === 'not_applicable')) {
      context.addIssue({
        code: 'custom',
        path: ['candidate', 'nodeStatus'],
        message: 'Managed-cloud candidates must not invent RuntimeNode health',
      })
    }
  })

export const RuntimeEligibilityReasonCodeSchema = z.enum([
  'CAPABILITY_SNAPSHOT_MISSING',
  'CAPABILITY_SNAPSHOT_STALE',
  'CAPABILITY_SNAPSHOT_UNVERIFIED',
  'ENTITLEMENT_DENIED',
  'ENTITLEMENT_UNKNOWN',
  'LOCAL_PROJECT_GRANT_MISSING',
  'LOCAL_PROJECT_GRANT_REVOKED',
  'REQUIRED_CAPABILITY_INSUFFICIENT',
  'REQUIRED_CAPABILITY_MISSING',
  'RUNTIME_CONNECTION_POLICY_DENIED',
  'RUNTIME_EXPIRED',
  'RUNTIME_FAMILY_POLICY_DENIED',
  'RUNTIME_INCOMPATIBLE',
  'RUNTIME_LOCATION_POLICY_DENIED',
  'RUNTIME_NODE_OFFLINE',
  'RUNTIME_NODE_REVOKED',
  'RUNTIME_NODE_UNKNOWN',
  'RUNTIME_OFFLINE',
  'RUNTIME_REVOKED',
  'RUNTIME_STALE',
  'RUNTIME_UNAVAILABLE',
  'SECURITY_POLICY_DENIED',
])

export const RuntimeEligibilityDegradationCodeSchema = z.enum([
  'COMPATIBILITY_DEGRADED',
  'COMPATIBILITY_UNTESTED',
  'OPTIONAL_CAPABILITY_DEGRADED',
  'OPTIONAL_CAPABILITY_MISSING',
  'RUNTIME_HEALTH_DEGRADED',
])

const RuntimeEligibilityReasonSchema = z
  .object({
    code: RuntimeEligibilityReasonCodeSchema,
    capability: RuntimeCapabilityNameSchema.optional(),
  })
  .strict()
const RuntimeEligibilityDegradationSchema = z
  .object({
    code: RuntimeEligibilityDegradationCodeSchema,
    capability: RuntimeCapabilityNameSchema.optional(),
  })
  .strict()

export const RuntimeEligibilityDecisionSchema = z
  .object({
    eligible: z.boolean(),
    mode: z.enum(['full', 'degraded', 'ineligible']),
    reasons: z.array(RuntimeEligibilityReasonSchema),
    degradations: z.array(RuntimeEligibilityDegradationSchema),
    audit: z
      .object({
        eligibilityVersion: z.literal(1),
        executionPlanId: IdentifierSchemas.executionPlanId,
        runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
        policySnapshot: z
          .object({
            policyId: z.string().min(1).max(128),
            version: z.number().int().positive(),
            digest: DigestSchema,
          })
          .strict(),
        evaluatedAt: RuntimeTimestampSchema,
        inputDigest: DigestSchema,
      })
      .strict(),
  })
  .strict()

export type RuntimeEligibilityInput = z.output<typeof RuntimeEligibilityInputSchema>
export type RuntimeEligibilityDecision = z.output<typeof RuntimeEligibilityDecisionSchema>

export function evaluateRuntimeEligibility(inputValue: unknown): RuntimeEligibilityDecision {
  const input = RuntimeEligibilityInputSchema.parse(inputValue)
  const connection = input.candidate.connection
  const reasons: z.input<typeof RuntimeEligibilityReasonSchema>[] = []
  const degradations: z.input<typeof RuntimeEligibilityDegradationSchema>[] = []
  const reason = (
    code: z.output<typeof RuntimeEligibilityReasonCodeSchema>,
    capability?: z.output<typeof RuntimeCapabilityNameSchema>
  ) => reasons.push({ code, ...(capability === undefined ? {} : { capability }) })
  const degradation = (
    code: z.output<typeof RuntimeEligibilityDegradationCodeSchema>,
    capability?: z.output<typeof RuntimeCapabilityNameSchema>
  ) => degradations.push({ code, ...(capability === undefined ? {} : { capability }) })

  if (input.candidate.nodeStatus === 'offline') reason('RUNTIME_NODE_OFFLINE')
  if (input.candidate.nodeStatus === 'unknown') reason('RUNTIME_NODE_UNKNOWN')
  if (input.candidate.nodeStatus === 'revoked') reason('RUNTIME_NODE_REVOKED')

  if (connection.status === 'revoked' || connection.availabilityState === 'revoked') {
    reason('RUNTIME_REVOKED')
  } else if (connection.status === 'expired') {
    reason('RUNTIME_EXPIRED')
  } else if (
    connection.status === 'disconnected' ||
    connection.availabilityState === 'offline' ||
    connection.availabilityState === 'reconnecting'
  ) {
    reason('RUNTIME_OFFLINE')
  } else if (connection.availabilityState === 'stale') {
    reason('RUNTIME_STALE')
  } else if (
    connection.compatibilityState === 'incompatible' ||
    connection.availabilityState === 'incompatible'
  ) {
    reason('RUNTIME_INCOMPATIBLE')
  } else if (connection.status === 'unavailable' || connection.availabilityState === 'unknown') {
    reason('RUNTIME_UNAVAILABLE')
  }

  if (connection.compatibilityState === 'revoked') reason('RUNTIME_REVOKED')
  if (!input.policy.allowedFamilies.includes(input.candidate.family)) {
    reason('RUNTIME_FAMILY_POLICY_DENIED')
  }
  if (!input.policy.allowedLocations.includes(connection.location)) {
    reason('RUNTIME_LOCATION_POLICY_DENIED')
  }
  if (input.policy.deniedRuntimeConnectionIds.includes(connection.runtimeConnectionId)) {
    reason('RUNTIME_CONNECTION_POLICY_DENIED')
  }
  if (input.policy.security.status === 'denied') reason('SECURITY_POLICY_DENIED')

  if (input.localProjectGrant.required) {
    if (input.localProjectGrant.status === 'missing') reason('LOCAL_PROJECT_GRANT_MISSING')
    if (input.localProjectGrant.status === 'revoked') reason('LOCAL_PROJECT_GRANT_REVOKED')
    if (input.localProjectGrant.status === 'not_required') reason('LOCAL_PROJECT_GRANT_MISSING')
  }
  if (input.entitlement.status === 'denied') reason('ENTITLEMENT_DENIED')
  if (input.entitlement.status === 'unknown') reason('ENTITLEMENT_UNKNOWN')

  const snapshotVersion = connection.capabilitySnapshotVersion
  const snapshotObservedAt = connection.capabilitySnapshotObservedAt
  const snapshotExpiresAt = connection.capabilitySnapshotExpiresAt
  const snapshotVerification = connection.capabilityVerification
  const snapshotComplete =
    snapshotVersion !== undefined &&
    snapshotObservedAt !== undefined &&
    snapshotExpiresAt !== undefined &&
    snapshotVerification !== undefined
  if (!snapshotComplete) {
    reason('CAPABILITY_SNAPSHOT_MISSING')
  } else {
    if (Date.parse(snapshotExpiresAt) <= Date.parse(input.evaluatedAt)) {
      reason('CAPABILITY_SNAPSHOT_STALE')
    }
    if (
      input.policy.requireVerifiedCapabilities &&
      connection.capabilityVerification !== 'verified'
    ) {
      reason('CAPABILITY_SNAPSHOT_UNVERIFIED')
    }
  }

  const capabilities = evaluateCapabilities(
    connection.capabilities,
    input.executionPlan.runtimeRequirements
  )
  for (const capability of capabilities.missingRequired) {
    reason('REQUIRED_CAPABILITY_MISSING', capability)
  }
  for (const capability of capabilities.insufficientRequired) {
    reason('REQUIRED_CAPABILITY_INSUFFICIENT', capability)
  }
  for (const capability of capabilities.missingOptional) {
    degradation('OPTIONAL_CAPABILITY_MISSING', capability)
  }
  for (const capability of capabilities.degradedOptional) {
    degradation('OPTIONAL_CAPABILITY_DEGRADED', capability)
  }
  if (connection.health === 'degraded') degradation('RUNTIME_HEALTH_DEGRADED')
  if (connection.compatibilityState === 'degraded') degradation('COMPATIBILITY_DEGRADED')
  if (connection.compatibilityState === 'untested') degradation('COMPATIBILITY_UNTESTED')

  const normalizedReasons = uniqueSorted(reasons)
  const normalizedDegradations = uniqueSorted(degradations)
  const eligible = normalizedReasons.length === 0
  return RuntimeEligibilityDecisionSchema.parse({
    eligible,
    mode: eligible ? (normalizedDegradations.length > 0 ? 'degraded' : 'full') : 'ineligible',
    reasons: normalizedReasons,
    degradations: normalizedDegradations,
    audit: {
      eligibilityVersion: input.eligibilityVersion,
      executionPlanId: input.executionPlan.executionPlanId,
      runtimeConnectionId: connection.runtimeConnectionId,
      policySnapshot: input.policy.snapshot,
      evaluatedAt: input.evaluatedAt,
      inputDigest: digestEligibilityInput(input),
    },
  })
}

function uniqueSorted<Value extends { code: string; capability?: string | undefined }>(
  values: readonly Value[]
): Value[] {
  const unique = new Map(values.map((value) => [`${value.code}:${value.capability ?? ''}`, value]))
  return [...unique.values()].toSorted((left, right) =>
    `${left.code}:${left.capability ?? ''}`.localeCompare(`${right.code}:${right.capability ?? ''}`)
  )
}

function digestEligibilityInput(input: RuntimeEligibilityInput): string {
  const normalized = {
    ...input,
    executionPlan: {
      ...input.executionPlan,
      runtimeRequirements: [...input.executionPlan.runtimeRequirements].toSorted((left, right) =>
        left.capability.localeCompare(right.capability)
      ),
    },
    candidate: {
      ...input.candidate,
      connection: {
        ...input.candidate.connection,
        capabilities: [...input.candidate.connection.capabilities].toSorted((left, right) =>
          left.name.localeCompare(right.name)
        ),
        limitations: [...input.candidate.connection.limitations].toSorted(),
        diagnostics: [...(input.candidate.connection.diagnostics ?? [])].toSorted(),
      },
    },
    policy: {
      ...input.policy,
      allowedFamilies: [...input.policy.allowedFamilies].toSorted(),
      allowedLocations: [...input.policy.allowedLocations].toSorted(),
      deniedRuntimeConnectionIds: [...input.policy.deniedRuntimeConnectionIds].toSorted(),
    },
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`
}
