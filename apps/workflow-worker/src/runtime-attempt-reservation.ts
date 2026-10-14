import type { ExecutionPlan } from '@control-plane/execution-plan'
import {
  RuntimeAttemptBudgetAuthoritySchema,
  type RuntimeAttemptBudgetAuthority,
} from '@control-plane/runtime-sdk'
import {
  childAllowanceStatementOf,
  DurableUsageLedger,
  unfundedChildAllowance,
  type DurableUsageBudget,
  type DurableUsageTransaction,
} from '@control-plane/usage-ledger'
import { RuntimeBudgetAdmissionError } from './runtime-budget-admission-error.js'

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
  const statement = childAllowanceStatementOf(input.executionPlan.constraints.limits)
  const heldBack =
    statement === undefined
      ? { microunits: 0, tokens: 0 }
      : unfundedChildAllowance(budget, statement)
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
