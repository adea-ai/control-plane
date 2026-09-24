import { z } from 'zod'
import type { CatalogApprovalDecision } from './catalog-approval.js'

/**
 * Approval gating semantics (#188) as a pure, enforcement-point-agnostic
 * evaluator.
 *
 * The open owner question — whether approval gates execution or publication,
 * and how existing published versions are treated — changes WHERE this
 * evaluator is called, not what it decides. This module encodes the
 * recommended semantics so they are executable and reviewable:
 *
 * - **Default OFF**: without a policy (or with `required: false`) nothing is
 *   enforced — `not_required`. Enabling approval is an explicit, auditable
 *   configuration step; no policy is ever silently active.
 * - **Explicit decisions win**: a decision matching the version's current
 *   revision and digest yields `approved` or `rejected`. A recorded rejection
 *   blocks even a version that would otherwise be grandfathered.
 * - **Explicit cutover grandfathering**: versions published strictly before
 *   `requiredSince` are `grandfathered` — a dated boundary, never synthetic
 *   approval records. Without `requiredSince` there is no window and every
 *   version needs a decision.
 * - **Fail closed otherwise**: anything else is `missing`.
 *
 * A decision bound to a different revision or digest never counts (stale
 * evidence is not approval), mirroring the record layer's binding rules.
 */

const TimestampSchema = z.iso.datetime()

export const CatalogApprovalPolicySchema = z
  .object({
    /** Whether approval is required at the enforcement point. */
    required: z.boolean(),
    /**
     * Explicit cutover: versions published before this instant are
     * grandfathered. Absent means no grandfathering window.
     */
    requiredSince: TimestampSchema.optional(),
  })
  .strict()
export type CatalogApprovalPolicy = z.output<typeof CatalogApprovalPolicySchema>

export const CatalogApprovalVerdictSchema = z.enum([
  'not_required',
  'approved',
  'rejected',
  'grandfathered',
  'missing',
])
export type CatalogApprovalVerdict = z.output<typeof CatalogApprovalVerdictSchema>

export interface CatalogApprovalEvaluationInput {
  /** Absent policy means approval is not configured — nothing is enforced. */
  readonly policy?: CatalogApprovalPolicy
  readonly version: {
    readonly revision: number
    readonly contentDigest: string
    readonly publishedAt?: string | undefined
  }
  /** The latest recorded decision for this version, if any. */
  readonly approval?: CatalogApprovalDecision
}

export interface CatalogApprovalEvaluation {
  readonly verdict: CatalogApprovalVerdict
  /** Present when the verdict is not `approved` or `not_required`. */
  readonly reason?: string
}

export function evaluateCatalogApproval(
  input: CatalogApprovalEvaluationInput
): CatalogApprovalEvaluation {
  const policy = input.policy
  if (policy === undefined || !policy.required) return { verdict: 'not_required' }

  const approval = input.approval
  const bindingMatches =
    approval !== undefined &&
    approval.revision === input.version.revision &&
    approval.contentDigest === input.version.contentDigest

  if (bindingMatches) {
    return approval.decision === 'approved'
      ? { verdict: 'approved', reason: approval.actorPrincipalRef }
      : { verdict: 'rejected', reason: approval.actorPrincipalRef }
  }

  const requiredSince = policy.requiredSince
  if (
    requiredSince !== undefined &&
    input.version.publishedAt !== undefined &&
    Date.parse(input.version.publishedAt) < Date.parse(requiredSince)
  ) {
    return { verdict: 'grandfathered', reason: requiredSince }
  }

  return {
    verdict: 'missing',
    reason: approval === undefined ? 'NO_DECISION_RECORDED' : 'DECISION_BINDING_STALE',
  }
}
