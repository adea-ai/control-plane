import { createHash } from 'node:crypto'
import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'
import {
  RuntimeEligibilityDecisionSchema,
  RuntimeEligibilityReasonCodeSchema,
} from './eligibility.js'
import { RuntimeTimestampSchema } from './models.js'

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const RuntimeFamilySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/)
const WeightSchema = z.number().int().nonnegative().max(1_000_000)

export const RuntimeRoutingPolicySchema = z
  .object({
    policyId: z.string().min(1).max(128),
    version: z.number().int().positive(),
    digest: DigestSchema,
    weights: z
      .object({
        explicitConnection: WeightSchema,
        preferredFamily: WeightSchema,
        preferredDeployment: WeightSchema,
        locality: WeightSchema,
        health: WeightSchema,
        load: WeightSchema,
        queue: WeightSchema,
        entitlement: WeightSchema,
        cost: WeightSchema,
      })
      .strict(),
  })
  .strict()

export const RuntimeRoutingCandidateSchema = z
  .object({
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    family: RuntimeFamilySchema,
    deployment: z.enum(['managed', 'local']),
    eligibility: RuntimeEligibilityDecisionSchema,
    signals: z
      .object({
        locality: z.number().int().min(0).max(100),
        health: z.number().int().min(0).max(100),
        loadPermille: z.number().int().min(0).max(1_000),
        queueDepth: z.number().int().nonnegative().max(1_000_000),
        entitlementPriority: z.number().int().min(0).max(100),
        costClass: z.enum(['low', 'medium', 'high', 'unknown']),
      })
      .strict(),
  })
  .strict()
  .refine(
    (candidate) =>
      candidate.runtimeConnectionId === candidate.eligibility.audit.runtimeConnectionId,
    'Candidate and eligibility runtime identities must agree'
  )

export const RuntimeRoutingInputSchema = z
  .object({
    routingVersion: z.literal(1),
    executionPlanId: IdentifierSchemas.executionPlanId,
    evaluatedAt: RuntimeTimestampSchema,
    policy: RuntimeRoutingPolicySchema,
    preference: z
      .object({
        runtimeConnectionId: IdentifierSchemas.runtimeConnectionId.optional(),
        family: RuntimeFamilySchema.optional(),
        deployment: z.enum(['managed', 'local']).optional(),
      })
      .strict()
      .refine((preference) => Object.values(preference).some((value) => value !== undefined))
      .optional(),
    candidates: z
      .array(RuntimeRoutingCandidateSchema)
      .max(1_000)
      .refine(
        (candidates) =>
          new Set(candidates.map(({ runtimeConnectionId }) => runtimeConnectionId)).size ===
          candidates.length,
        'Routing candidate identities must be unique'
      ),
  })
  .strict()
  .refine(
    (input) =>
      input.candidates.every(
        ({ eligibility }) => eligibility.audit.executionPlanId === input.executionPlanId
      ),
    'Routing candidates must share the requested ExecutionPlan'
  )

export const RuntimeRoutingReasonCodeSchema = z.enum([
  'COST',
  'ENTITLEMENT',
  'EXPLICIT_CONNECTION',
  'HEALTH',
  'LOAD',
  'LOCALITY',
  'PREFERRED_DEPLOYMENT',
  'PREFERRED_FAMILY',
  'QUEUE',
])

const RuntimeRoutingReasonSchema = z
  .object({
    code: RuntimeRoutingReasonCodeSchema,
    contribution: z.number().int().nonnegative(),
  })
  .strict()
const RankedRuntimeSchema = z
  .object({
    rank: z.number().int().positive(),
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    score: z.number().int().nonnegative(),
    eligibilityMode: z.enum(['full', 'degraded']),
    reasons: z.array(RuntimeRoutingReasonSchema),
  })
  .strict()
const ExcludedRuntimeSchema = z
  .object({
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    eligibilityReasons: z.array(RuntimeEligibilityReasonCodeSchema),
  })
  .strict()

export const RuntimeRoutingDecisionSchema = z
  .object({
    outcome: z.enum([
      'selected',
      'preference_unavailable',
      'transient_unavailable',
      'no_candidate',
    ]),
    selected: RankedRuntimeSchema.optional(),
    ranked: z.array(RankedRuntimeSchema),
    excluded: z.array(ExcludedRuntimeSchema),
    audit: z
      .object({
        routingVersion: z.literal(1),
        executionPlanId: IdentifierSchemas.executionPlanId,
        policy: z
          .object({
            policyId: z.string().min(1).max(128),
            version: z.number().int().positive(),
            digest: DigestSchema,
          })
          .strict(),
        evaluatedAt: RuntimeTimestampSchema,
        inputDigest: DigestSchema,
        decisionDigest: DigestSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((decision, context) => {
    const hasSelection = decision.selected !== undefined
    if (hasSelection !== ['selected', 'preference_unavailable'].includes(decision.outcome)) {
      context.addIssue({ code: 'custom', message: 'Routing outcome and selection must agree' })
    }
    if (
      hasSelection &&
      decision.ranked[0]?.runtimeConnectionId !== decision.selected?.runtimeConnectionId
    ) {
      context.addIssue({ code: 'custom', message: 'Selected runtime must lead the ranking' })
    }
  })

export type RuntimeRoutingInput = z.output<typeof RuntimeRoutingInputSchema>
export type RuntimeRoutingDecision = z.output<typeof RuntimeRoutingDecisionSchema>

export function routeRuntimeConnections(inputValue: unknown): RuntimeRoutingDecision {
  const input = RuntimeRoutingInputSchema.parse(inputValue)
  const eligible = input.candidates.filter(({ eligibility }) => eligibility.eligible)
  const excluded = input.candidates
    .filter(({ eligibility }) => !eligibility.eligible)
    .map((candidate) => ({
      runtimeConnectionId: candidate.runtimeConnectionId,
      eligibilityReasons: candidate.eligibility.reasons.map(({ code }) => code).toSorted(),
    }))
    .toSorted((left, right) => left.runtimeConnectionId.localeCompare(right.runtimeConnectionId))
  const ranked = eligible
    .map((candidate) => scoreCandidate(input, candidate))
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        left.runtimeConnectionId.localeCompare(right.runtimeConnectionId)
    )
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }))

  const preferenceUnavailable =
    input.preference !== undefined &&
    ((input.preference.runtimeConnectionId !== undefined &&
      !eligible.some(
        ({ runtimeConnectionId }) => runtimeConnectionId === input.preference?.runtimeConnectionId
      )) ||
      (input.preference.family !== undefined &&
        !eligible.some(({ family }) => family === input.preference?.family)) ||
      (input.preference.deployment !== undefined &&
        !eligible.some(({ deployment }) => deployment === input.preference?.deployment)))
  const selected = ranked[0]
  const outcome = selected
    ? preferenceUnavailable
      ? 'preference_unavailable'
      : 'selected'
    : classifyEmptyOutcome(input, excluded)
  const decisionWithoutDigest = {
    outcome,
    ...(selected === undefined ? {} : { selected }),
    ranked,
    excluded,
    audit: {
      routingVersion: input.routingVersion,
      executionPlanId: input.executionPlanId,
      policy: {
        policyId: input.policy.policyId,
        version: input.policy.version,
        digest: input.policy.digest,
      },
      evaluatedAt: input.evaluatedAt,
      inputDigest: digest(normalizeRoutingInput(input)),
    },
  }
  return RuntimeRoutingDecisionSchema.parse({
    ...decisionWithoutDigest,
    audit: {
      ...decisionWithoutDigest.audit,
      decisionDigest: digest(decisionWithoutDigest),
    },
  })
}

export function toAttemptRoutingDecision(decisionValue: unknown) {
  const decision = RuntimeRoutingDecisionSchema.parse(decisionValue)
  if (!decision.selected) throw new Error('ROUTING_SELECTION_REQUIRED')
  const expectedDigest = digest({
    outcome: decision.outcome,
    selected: decision.selected,
    ranked: decision.ranked,
    excluded: decision.excluded,
    audit: {
      routingVersion: decision.audit.routingVersion,
      executionPlanId: decision.audit.executionPlanId,
      policy: decision.audit.policy,
      evaluatedAt: decision.audit.evaluatedAt,
      inputDigest: decision.audit.inputDigest,
    },
  })
  if (expectedDigest !== decision.audit.decisionDigest) {
    throw new Error('ROUTING_DECISION_DIGEST_MISMATCH')
  }
  return {
    routingVersion: decision.audit.routingVersion,
    policy: decision.audit.policy,
    evaluatedAt: decision.audit.evaluatedAt,
    inputDigest: decision.audit.inputDigest,
    decisionDigest: decision.audit.decisionDigest,
    selectedRank: decision.selected.rank,
    candidateCount: decision.ranked.length,
    reasonCodes: decision.selected.reasons.map(({ code }) => code).toSorted(),
  }
}

function scoreCandidate(
  input: RuntimeRoutingInput,
  candidate: z.output<typeof RuntimeRoutingCandidateSchema>
) {
  const { preference, policy } = input
  const costValue = { low: 3, medium: 2, high: 1, unknown: 0 }[candidate.signals.costClass]
  const contributions = [
    {
      code: 'EXPLICIT_CONNECTION' as const,
      contribution:
        preference?.runtimeConnectionId === candidate.runtimeConnectionId
          ? policy.weights.explicitConnection
          : 0,
    },
    {
      code: 'PREFERRED_FAMILY' as const,
      contribution: preference?.family === candidate.family ? policy.weights.preferredFamily : 0,
    },
    {
      code: 'PREFERRED_DEPLOYMENT' as const,
      contribution:
        preference?.deployment === candidate.deployment ? policy.weights.preferredDeployment : 0,
    },
    {
      code: 'LOCALITY' as const,
      contribution: candidate.signals.locality * policy.weights.locality,
    },
    { code: 'HEALTH' as const, contribution: candidate.signals.health * policy.weights.health },
    {
      code: 'LOAD' as const,
      contribution: (1_000 - candidate.signals.loadPermille) * policy.weights.load,
    },
    {
      code: 'QUEUE' as const,
      contribution:
        Math.max(0, 1_000 - Math.min(candidate.signals.queueDepth, 1_000)) * policy.weights.queue,
    },
    {
      code: 'ENTITLEMENT' as const,
      contribution: candidate.signals.entitlementPriority * policy.weights.entitlement,
    },
    { code: 'COST' as const, contribution: costValue * policy.weights.cost },
  ].filter(({ contribution }) => contribution > 0)
  return {
    rank: 1,
    runtimeConnectionId: candidate.runtimeConnectionId,
    score: contributions.reduce((total, { contribution }) => total + contribution, 0),
    eligibilityMode: candidate.eligibility.mode as 'full' | 'degraded',
    reasons: contributions,
  }
}

const transientReasons = new Set<z.output<typeof RuntimeEligibilityReasonCodeSchema>>([
  'CAPABILITY_SNAPSHOT_MISSING',
  'CAPABILITY_SNAPSHOT_STALE',
  'RUNTIME_EXPIRED',
  'RUNTIME_NODE_OFFLINE',
  'RUNTIME_NODE_UNKNOWN',
  'RUNTIME_OFFLINE',
  'RUNTIME_STALE',
  'RUNTIME_UNAVAILABLE',
])

function classifyEmptyOutcome(
  input: RuntimeRoutingInput,
  excluded: readonly z.output<typeof ExcludedRuntimeSchema>[]
): 'transient_unavailable' | 'no_candidate' {
  if (input.candidates.length === 0 || excluded.length === 0) return 'no_candidate'
  const reasons = excluded.flatMap(({ eligibilityReasons }) => eligibilityReasons)
  return reasons.length > 0 && reasons.every((reason) => transientReasons.has(reason))
    ? 'transient_unavailable'
    : 'no_candidate'
}

function normalizeRoutingInput(input: RuntimeRoutingInput) {
  return {
    ...input,
    candidates: [...input.candidates]
      .map((candidate) => ({
        ...candidate,
        eligibility: {
          ...candidate.eligibility,
          reasons: [...candidate.eligibility.reasons].toSorted(compareCoded),
          degradations: [...candidate.eligibility.degradations].toSorted(compareCoded),
        },
      }))
      .toSorted((left, right) => left.runtimeConnectionId.localeCompare(right.runtimeConnectionId)),
  }
}

function compareCoded(
  left: { code: string; capability?: string | undefined },
  right: { code: string; capability?: string | undefined }
) {
  return `${left.code}:${left.capability ?? ''}`.localeCompare(
    `${right.code}:${right.capability ?? ''}`
  )
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}
