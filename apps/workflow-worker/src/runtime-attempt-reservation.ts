import type { ExecutionPlan } from '@control-plane/execution-plan'
import {
  RuntimeAttemptBudgetAuthoritySchema,
  type RuntimeAttemptBudgetAuthority,
} from '@control-plane/runtime-sdk'
import {
  DurableUsageLedger,
  type DurableUsageBudget,
  type DurableUsageTransaction,
} from '@control-plane/usage-ledger'
import { RuntimeBudgetAdmissionError } from './runtime-budget-admission-error.js'

type ChildAllowance = ExecutionPlan['constraints']['limits']['childExecutions']['budgetAllowance']

/**
 * The share of an execution's own funded budget that its plan holds back for children, in money
 * and tokens, after what children have already been funded from it.
 *
 * The plan states the allowance against its own ceilings. A child is funded at the smaller of its
 * requested ceiling and what its parent has available, so its budget can be below its plan's
 * ceiling. The allowance then scales by the same ratio, rounded down: the plan keeps the share it
 * asked for, and the attempt always keeps a nonzero part of a nonzero budget because the allowance
 * is below the ceiling. A root budget is never clamped, so its allowance is exactly as stated.
 *
 * A child already funded counts at its full ceiling while its reservation is open and at what it
 * actually charged once settled. A settled child's charge is already out of the available balance,
 * so counting it here keeps only the unfunded part of the allowance held back.
 */
export function childAllowanceHeldBack(
  budget: DurableUsageBudget,
  limits: ExecutionPlan['constraints']['limits']
): { readonly microunits: number; readonly tokens: number } {
  const allowance: ChildAllowance = limits.childExecutions.budgetAllowance
  if (allowance === undefined) return { microunits: 0, tokens: 0 }
  let microunits = scaledShare(
    allowance.maximumMicrounits,
    budget.maximumMicrounits,
    limits.budget.maximumMicrounits
  )
  let tokens = scaledShare(
    allowance.maximumTokens,
    budget.maximumTokens,
    limits.tokens.maximumTotal
  )
  for (const reservation of budget.reservations) {
    if (reservation.childExecutionId === undefined) continue
    const open = reservation.status === 'open'
    microunits -= open ? reservation.maximumMicrounits : reservation.chargedMicrounits
    tokens -= open ? reservation.maximumTokens : reservation.chargedTokens
  }
  return { microunits: Math.max(0, microunits), tokens: Math.max(0, tokens) }
}

function scaledShare(allowance: number, fundedMaximum: number, planCeiling: number): number {
  const funded = Math.min(fundedMaximum, planCeiling)
  return Number((BigInt(allowance) * BigInt(funded)) / BigInt(planCeiling))
}

/**
 * Reserve one runtime attempt's envelope inside an open admission transaction: everything still
 * available, less the part of the plan's child allowance no child has been funded from. Replaying
 * the same attempt reuses its first envelope and writes the same immutable effect.
 */
export async function reserveAttemptEnvelope(input: {
  readonly transaction: DurableUsageTransaction
  readonly workspaceId: string
  readonly executionId: string
  readonly attemptId: string
  readonly currency: string
  readonly budget: DurableUsageBudget
  readonly availableMicrounits: number
  readonly availableTokens: number
  readonly executionPlan: ExecutionPlan
}): Promise<RuntimeAttemptBudgetAuthority> {
  const { budget } = input
  const reservationKey = `runtime-attempt:${input.attemptId}`
  const existing = budget.reservations.find(
    (reservation) => reservation.reservationKey === reservationKey
  )
  if (
    existing !== undefined &&
    (existing.attemptId !== input.attemptId ||
      existing.childExecutionId !== undefined ||
      existing.status !== 'open')
  ) {
    throw new RuntimeBudgetAdmissionError()
  }
  // The plan may hold back part of the ceiling for children. Children already funded count
  // against that part, so only the still-unfunded rest stays out of the attempt envelope.
  const heldBack = childAllowanceHeldBack(budget, input.executionPlan.constraints.limits)
  const attemptMicrounits = Math.max(0, input.availableMicrounits - heldBack.microunits)
  const attemptTokens = Math.max(0, input.availableTokens - heldBack.tokens)
  if (
    existing === undefined &&
    ((budget.maximumMicrounits > 0 && attemptMicrounits === 0) ||
      (budget.maximumTokens > 0 && attemptTokens === 0))
  ) {
    throw new RuntimeBudgetAdmissionError()
  }
  // Reserve remaining allowance (children can be clamped), not an invented zero after another
  // attempt reserved or spent it. Exact replay reuses the same envelope and effect identity.
  const mutationLedger = new DurableUsageLedger({
    store: {
      transaction: async (workspaceId, operation) => {
        if (workspaceId !== input.workspaceId) throw new RuntimeBudgetAdmissionError()
        return operation(input.transaction)
      },
    },
  })
  const maximumMicrounits = existing?.maximumMicrounits ?? attemptMicrounits
  const maximumTokens = existing?.maximumTokens ?? attemptTokens
  await mutationLedger.reserve({
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    attemptId: input.attemptId,
    reservationKey,
    maximumMicrounits,
    maximumTokens,
    source: {
      sourceId: input.attemptId,
      idempotencyKey: `${reservationKey}:reserve`,
    },
  })
  // The transaction result is exposed only after the store confirms commit.
  // Replay returns the same reservation ceiling, without rewriting the plan.
  return RuntimeAttemptBudgetAuthoritySchema.parse({
    schemaVersion: 1 as const,
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    attemptId: input.attemptId,
    executionPlanId: input.executionPlan.executionPlanId,
    executionPlanDigest: input.executionPlan.contentDigest,
    reservationKey,
    currency: input.currency,
    maximumMicrounits,
    maximumTokens,
  })
}
