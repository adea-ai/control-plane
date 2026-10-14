import { canonicalJsonStringify } from '@control-plane/contracts'
import type { CanonicalDelegationAdmission } from '@control-plane/orchestration'
import type { RuntimeAttemptBudgetAuthority } from '@control-plane/runtime-sdk'
import {
  budgetOpeningEntryIdempotencyKey,
  DurableUsageBudgetSchema,
  DurableUsageEffectSchema,
  DurableUsageLedger,
  type DurableUsageStore,
  type DurableUsageTransaction,
} from '@control-plane/usage-ledger'
import { reserveAttemptEnvelope } from './runtime-attempt-reservation.js'
import { RuntimeBudgetAdmissionError } from './runtime-budget-admission-error.js'
import { fingerprintForOpenBudget, isOpeningCredit } from './runtime-budget-admission.js'

export interface DurableChildRuntimeBudgetAdmissionOptions {
  readonly store: DurableUsageStore
}

/**
 * Reserves a delegated child's runtime attempt in the durable usage ledger. It is the production
 * implementation of the delegation bridge's `reserveBudget` seam.
 *
 * The child's own budget was opened inside the transactional child allocation, funded from its
 * parent's unreserved balance and clamped to it. Unlike a root execution, a delegated child has no
 * accepted command, so the evidence checked here is the delegation record, the allocator's opening
 * receipt and the parent's funding reservation. The attempt then reserves what the child has left,
 * less the part of its own plan's child allowance that no grandchild has been funded from. A child's
 * budget stays its own: nothing it reserves or spends changes its parent's attempt envelope.
 *
 * Reservation is allocation authority, not a charge or evidence of purchased funding. Replays reuse
 * the first envelope and write nothing new.
 */
export class DurableChildRuntimeBudgetAdmission {
  readonly #store: DurableUsageStore

  constructor(options: DurableChildRuntimeBudgetAdmissionOptions) {
    this.#store = options.store
  }

  /** Bound as `reserveBudget` on the delegation runtime bridge. */
  readonly reserve = async (
    admission: CanonicalDelegationAdmission
  ): Promise<RuntimeAttemptBudgetAuthority> => {
    try {
      return await this.#reserve(admission)
    } catch {
      throw new RuntimeBudgetAdmissionError()
    }
  }

  async #reserve(admission: CanonicalDelegationAdmission): Promise<RuntimeAttemptBudgetAuthority> {
    const { record, plan, attempt, identity } = admission
    const workspaceId = plan.correlation.workspaceId
    const executionId = record.childExecutionId
    if (
      attempt.attemptId !== identity.childAttemptId ||
      attempt.executionId !== executionId ||
      record.parentExecutionId !== identity.parentExecutionId ||
      record.childExecutionPlanId !== plan.executionPlanId ||
      record.childExecutionPlanDigest !== plan.contentDigest ||
      plan.parentExecutionPlan?.executionPlanId !== record.parentExecutionPlanId
    ) {
      deny()
    }
    const limits = plan.constraints.limits
    const openingSource = {
      sourceId: `child-budget:${record.delegationId}`,
      idempotencyKey: `child-budget-open:${record.delegationId}`,
    }
    const expectation = {
      workspaceId,
      executionId,
      parentExecutionId: record.parentExecutionId,
      currency: limits.budget.currency,
      source: openingSource,
    }
    // The allocator opened the budget from the child plan's ceilings, so the stored receipt's
    // fingerprint is over those requested ceilings, never the clamped funded amount.
    const openingFingerprint = fingerprintForOpenBudget({
      workspaceId,
      executionId,
      parentExecutionId: record.parentExecutionId,
      currency: limits.budget.currency,
      maximumMicrounits: limits.budget.maximumMicrounits,
      maximumTokens: limits.tokens.maximumTotal,
      source: openingSource,
    })

    return await this.#store.transaction(workspaceId, async (transaction) => {
      const ledger = new DurableUsageLedger({
        store: readOnlyStore(workspaceId, transaction),
      })
      const summary = await ledger.summary(workspaceId, executionId)
      const entries = await ledger.entries(workspaceId, executionId)
      const budgetResult = DurableUsageBudgetSchema.safeParse(
        await transaction.getBudget(executionId)
      )
      const effectResult = DurableUsageEffectSchema.safeParse(
        await transaction.getEffect(openingSource.idempotencyKey)
      )
      const parentResult = DurableUsageBudgetSchema.safeParse(
        await transaction.getBudget(record.parentExecutionId)
      )
      if (!budgetResult.success || !effectResult.success || !parentResult.success) deny()
      const budget = budgetResult.data
      const effect = effectResult.data
      // A child is funded at the smaller of its requested ceilings and what its parent had
      // available, so its budget can be below, never above, its plan.
      if (
        budget.workspaceId !== workspaceId ||
        budget.executionId !== executionId ||
        (budget.parentExecutionId ?? undefined) !== record.parentExecutionId ||
        budget.status !== 'open' ||
        budget.currency !== limits.budget.currency ||
        budget.maximumMicrounits > limits.budget.maximumMicrounits ||
        budget.maximumTokens > limits.tokens.maximumTotal
      ) {
        deny()
      }
      const funding = parentResult.data.reservations.filter(
        (reservation) => reservation.childExecutionId === executionId
      )
      if (
        parentResult.data.workspaceId !== workspaceId ||
        funding.length !== 1 ||
        funding[0]?.status !== 'open' ||
        funding[0].maximumMicrounits !== budget.maximumMicrounits ||
        funding[0].maximumTokens !== budget.maximumTokens
      ) {
        deny()
      }
      const openingKey = budgetOpeningEntryIdempotencyKey(openingSource.idempotencyKey, executionId)
      const openingEntries = entries.filter((entry) => entry.source.idempotencyKey === openingKey)
      const opening = openingEntries[0]
      if (
        openingEntries.length !== 1 ||
        opening === undefined ||
        !isOpeningCredit(opening, expectation, budget.maximumMicrounits)
      ) {
        deny()
      }
      const openingSummary = {
        executionId,
        currency: budget.currency,
        maximumMicrounits: budget.maximumMicrounits,
        maximumTokens: budget.maximumTokens,
        spentMicrounits: 0,
        reservedMicrounits: 0,
        availableMicrounits: budget.maximumMicrounits,
        spentTokens: 0,
        reservedTokens: 0,
        availableTokens: budget.maximumTokens,
        settled: false,
      }
      if (
        effect.workspaceId !== workspaceId ||
        effect.executionId !== executionId ||
        effect.idempotencyKey !== openingSource.idempotencyKey ||
        effect.fingerprint !== openingFingerprint ||
        canonicalJsonStringify(effect.result) !== canonicalJsonStringify(openingSummary) ||
        summary.maximumMicrounits !== budget.maximumMicrounits ||
        summary.maximumTokens !== budget.maximumTokens ||
        summary.settled
      ) {
        deny()
      }
      return await reserveAttemptEnvelope({
        transaction,
        workspaceId,
        executionId,
        attemptId: attempt.attemptId,
        currency: budget.currency,
        budget,
        availableMicrounits: summary.availableMicrounits,
        availableTokens: summary.availableTokens,
        executionPlan: plan,
      })
    })
  }
}

function readOnlyStore(workspaceId: string, transaction: DurableUsageTransaction) {
  const readOnly: DurableUsageTransaction = {
    getBudget: (executionId) => transaction.getBudget(executionId),
    getEffect: (idempotencyKey) => transaction.getEffect(idempotencyKey),
    listEntries: (executionId) => transaction.listEntries(executionId),
    putBudget: async () => deny(),
    putEffect: async () => deny(),
    appendEntry: async () => deny(),
  }
  return {
    transaction: async <T>(
      requestedWorkspaceId: string,
      operation: (transaction: DurableUsageTransaction) => Promise<T>
    ) => {
      if (requestedWorkspaceId !== workspaceId) deny()
      return operation(readOnly)
    },
  } as DurableUsageStore
}

function deny(): never {
  throw new RuntimeBudgetAdmissionError()
}
