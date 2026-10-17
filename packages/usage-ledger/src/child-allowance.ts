import { z } from 'zod'
import type { DurableUsageBudget } from './durable-contract.js'

const PositiveAmountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const LimitsSchema = z
  .object({ maximumMicrounits: PositiveAmountSchema, maximumTokens: PositiveAmountSchema })
  .strict()

/**
 * What a parent plan states it holds back for its children, with the parent plan's own ceilings
 * that the statement was made against. Both are constants of the parent's accepted plan, so the
 * same statement is passed on every child opening and the opening replays identically.
 */
export const ChildAllowanceStatementSchema = z
  .object({ allowance: LimitsSchema, planCeiling: LimitsSchema })
  .strict()

export type ChildAllowanceStatement = z.output<typeof ChildAllowanceStatementSchema>

/**
 * The part of a parent's child allowance that no child has been funded from yet.
 *
 * The plan states the allowance against its own ceilings. A child is funded at the smaller of its
 * requested ceiling and what its parent has available, so its budget can be below its plan's
 * ceiling. The allowance then scales by the same ratio, rounded down: the plan keeps the share it
 * asked for, and a nonzero budget always keeps a nonzero part for the execution itself because the
 * allowance is below the ceiling. A root budget is never clamped, so its allowance is exactly as
 * stated.
 *
 * A child already funded counts at its full ceiling while its funding reservation is open and at
 * what it actually charged once settled. A settled child's charge is already out of the available
 * balance, so counting it here keeps only the unfunded part of the allowance.
 *
 * This is the one definition used both to hold the part back from a runtime attempt and to cap what
 * a new child may be funded, so the two cannot drift apart.
 */
export function unfundedChildAllowance(
  budget: DurableUsageBudget,
  statement: ChildAllowanceStatement
): { readonly microunits: number; readonly tokens: number } {
  let microunits = scaledShare(
    statement.allowance.maximumMicrounits,
    budget.maximumMicrounits,
    statement.planCeiling.maximumMicrounits
  )
  let tokens = scaledShare(
    statement.allowance.maximumTokens,
    budget.maximumTokens,
    statement.planCeiling.maximumTokens
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
 * The statement an accepted plan's limits make about what it holds back for children, in the form
 * the ledger caps child funding with, or `undefined` when the plan states no allowance.
 */
export function childAllowanceStatementOf(limits: {
  readonly budget: { readonly maximumMicrounits: number }
  readonly tokens: { readonly maximumTotal: number }
  readonly childExecutions: {
    readonly budgetAllowance?: {
      readonly maximumMicrounits: number
      readonly maximumTokens: number
    }
  }
}): ChildAllowanceStatement | undefined {
  const allowance = limits.childExecutions.budgetAllowance
  if (allowance === undefined) return undefined
  return {
    allowance: {
      maximumMicrounits: allowance.maximumMicrounits,
      maximumTokens: allowance.maximumTokens,
    },
    planCeiling: {
      maximumMicrounits: limits.budget.maximumMicrounits,
      maximumTokens: limits.tokens.maximumTotal,
    },
  }
}
