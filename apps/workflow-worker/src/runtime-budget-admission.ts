import { createHash } from 'node:crypto'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import type { CommandAcceptanceRepository, Execution } from '@control-plane/domain'
import { executionPlanBudgetAllowance, type ExecutionPlan } from '@control-plane/execution-plan'
import { type RuntimeAttemptBudgetAuthority } from '@control-plane/runtime-sdk'
import {
  budgetOpeningEntryIdempotencyKey,
  DurableUsageLedger,
  DurableUsageBudgetSchema,
  DurableUsageEffectSchema,
  UsageLedgerEntrySchema,
  type DurableUsageStore,
  type DurableUsageTransaction,
  type UsageLedgerEntry,
} from '@control-plane/usage-ledger'
import { reserveAttemptEnvelope } from './runtime-attempt-reservation.js'
import { RuntimeBudgetAdmissionError } from './runtime-budget-admission-error.js'

export { RuntimeBudgetAdmissionError } from './runtime-budget-admission-error.js'

export type { RuntimeAttemptBudgetAuthority } from '@control-plane/runtime-sdk'

export interface RuntimeBudgetAdmissionPort {
  authorize(input: {
    readonly execution: Execution
    readonly executionPlan: ExecutionPlan
    readonly attemptId: string
  }): Promise<void>
  /** Validate and reserve the accepted attempt allocation atomically before runtime work. */
  reserve?(
    input: Parameters<RuntimeBudgetAdmissionPort['authorize']>[0]
  ): Promise<RuntimeAttemptBudgetAuthority | void>
}

export interface DurableRuntimeBudgetAdmissionOptions {
  readonly store: DurableUsageStore
  readonly commands: Pick<CommandAcceptanceRepository, 'getByExecutionId'>
}

/** Read-only preflight and atomic attempt reservation over the accepted plan allowance.
 * Reservation is allocation authority, not a charge or evidence of purchased funding.
 */
export class DurableRuntimeBudgetAdmission implements RuntimeBudgetAdmissionPort {
  readonly #store: DurableUsageStore
  readonly #commands: Pick<CommandAcceptanceRepository, 'getByExecutionId'>

  constructor(options: DurableRuntimeBudgetAdmissionOptions) {
    this.#store = options.store
    this.#commands = options.commands
  }

  async authorize(input: {
    readonly execution: Execution
    readonly executionPlan: ExecutionPlan
    readonly attemptId: string
  }): Promise<void> {
    await this.#admit(input, false)
  }

  async reserve(
    input: Parameters<RuntimeBudgetAdmissionPort['authorize']>[0]
  ): Promise<RuntimeAttemptBudgetAuthority> {
    const authority = await this.#admit(input, true)
    if (authority === undefined) denyAdmission()
    return authority
  }

  async #admit(
    input: Parameters<RuntimeBudgetAdmissionPort['authorize']>[0],
    reserveAttempt: boolean
  ): Promise<RuntimeAttemptBudgetAuthority | void> {
    try {
      if (
        !IdentifierSchemas.attemptId.safeParse(input.attemptId).success ||
        input.execution.latestAttemptId !== input.attemptId
      ) {
        denyAdmission()
      }
      const command = await this.#commands.getByExecutionId(input.execution.executionId)
      if (command === undefined) denyAdmission()

      const allowance = executionPlanBudgetAllowance(command, input.execution, input.executionPlan)
      const openingKey = budgetOpeningEntryIdempotencyKey(
        allowance.source.idempotencyKey,
        allowance.executionId
      )
      const openingFingerprint = fingerprintForOpenBudget(allowance)

      return await this.#store.transaction(allowance.workspaceId, async (transaction) => {
        const ledger = new DurableUsageLedger({
          store: transactionBoundReadOnlyStore(allowance.workspaceId, transaction),
        })
        const summary = await ledger.summary(allowance.workspaceId, allowance.executionId)
        const entries = await ledger.entries(allowance.workspaceId, allowance.executionId)
        const budgetResult = DurableUsageBudgetSchema.safeParse(
          await transaction.getBudget(allowance.executionId)
        )
        const effectResult = DurableUsageEffectSchema.safeParse(
          await transaction.getEffect(allowance.source.idempotencyKey)
        )
        if (!budgetResult.success || !effectResult.success) denyAdmission()

        const budget = budgetResult.data
        const effect = effectResult.data
        // Roots retain the full plan ceiling. Child openings may be clamped to
        // the parent’s available allowance, but can never exceed that ceiling.
        if (
          budget.workspaceId !== allowance.workspaceId ||
          budget.executionId !== allowance.executionId ||
          (budget.parentExecutionId ?? undefined) !== allowance.parentExecutionId ||
          budget.status !== 'open' ||
          budget.currency !== allowance.currency ||
          (allowance.parentExecutionId === undefined
            ? budget.maximumMicrounits !== allowance.maximumMicrounits ||
              budget.maximumTokens !== allowance.maximumTokens
            : budget.maximumMicrounits > allowance.maximumMicrounits ||
              budget.maximumTokens > allowance.maximumTokens)
        ) {
          denyAdmission()
        }

        const openingEntries = entries.filter((entry) => entry.source.idempotencyKey === openingKey)
        const opening = openingEntries[0]
        if (
          openingEntries.length !== 1 ||
          opening === undefined ||
          !isOpeningCredit(opening, allowance, budget.maximumMicrounits)
        ) {
          denyAdmission()
        }

        const openingSummary = {
          executionId: budget.executionId,
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
          effect.workspaceId !== allowance.workspaceId ||
          effect.executionId !== allowance.executionId ||
          effect.idempotencyKey !== allowance.source.idempotencyKey ||
          effect.fingerprint !== openingFingerprint ||
          canonicalJsonStringify(effect.result) !== canonicalJsonStringify(openingSummary) ||
          summary.executionId !== budget.executionId ||
          summary.currency !== budget.currency ||
          summary.maximumMicrounits !== budget.maximumMicrounits ||
          summary.maximumTokens !== budget.maximumTokens ||
          summary.settled
        ) {
          denyAdmission()
        }
        if (reserveAttempt) {
          return await reserveAttemptEnvelope({
            transaction,
            workspaceId: allowance.workspaceId,
            executionId: allowance.executionId,
            attemptId: input.attemptId,
            currency: allowance.currency,
            budget,
            availableMicrounits: summary.availableMicrounits,
            availableTokens: summary.availableTokens,
            executionPlan: input.executionPlan,
          })
        }
        return undefined
      })
    } catch {
      throw new RuntimeBudgetAdmissionError()
    }
  }
}

/** Validate trusted admission composition before forwarding an immutable copy. */
export function validateRuntimeAttemptBudgetAuthority(
  authority: RuntimeAttemptBudgetAuthority,
  input: Parameters<RuntimeBudgetAdmissionPort['authorize']>[0]
): RuntimeAttemptBudgetAuthority {
  const candidate = { ...authority }
  if (
    Object.keys(candidate).length !== 10 ||
    candidate.schemaVersion !== 1 ||
    candidate.workspaceId !== input.execution.correlation.workspaceId ||
    candidate.executionId !== input.execution.executionId ||
    candidate.attemptId !== input.attemptId ||
    candidate.executionPlanId !== input.executionPlan.executionPlanId ||
    candidate.executionPlanDigest !== input.executionPlan.contentDigest ||
    candidate.reservationKey !== `runtime-attempt:${input.attemptId}` ||
    candidate.currency !== input.executionPlan.constraints.limits.budget.currency ||
    !Number.isSafeInteger(candidate.maximumMicrounits) ||
    candidate.maximumMicrounits < 0 ||
    candidate.maximumMicrounits > input.executionPlan.constraints.limits.budget.maximumMicrounits ||
    !Number.isSafeInteger(candidate.maximumTokens) ||
    candidate.maximumTokens < 0 ||
    candidate.maximumTokens > input.executionPlan.constraints.limits.tokens.maximumTotal
  ) {
    denyAdmission()
  }
  return Object.freeze(candidate)
}

function transactionBoundReadOnlyStore(
  workspaceId: string,
  transaction: DurableUsageTransaction
): DurableUsageStore {
  const readOnlyTransaction: DurableUsageTransaction = {
    getBudget: (executionId) => transaction.getBudget(executionId),
    getEffect: (idempotencyKey) => transaction.getEffect(idempotencyKey),
    listEntries: (executionId) => transaction.listEntries(executionId),
    putBudget: async () => denyAdmission(),
    putEffect: async () => denyAdmission(),
    appendEntry: async () => denyAdmission(),
  }
  return {
    transaction: async (requestedWorkspaceId, operation) => {
      if (requestedWorkspaceId !== workspaceId) denyAdmission()
      return operation(readOnlyTransaction)
    },
  }
}

export function isOpeningCredit(
  entry: UsageLedgerEntry,
  allowance: OpeningCreditExpectation,
  maximumMicrounits: number
): boolean {
  const parsed = UsageLedgerEntrySchema.safeParse(entry)
  if (!parsed.success) return false
  const opening = parsed.data
  return (
    opening.sequence === 1 &&
    opening.workspaceId === allowance.workspaceId &&
    opening.executionId === allowance.executionId &&
    (opening.parentExecutionId ?? undefined) === allowance.parentExecutionId &&
    opening.kind === 'credit' &&
    opening.source.sourceId === allowance.source.sourceId &&
    opening.source.idempotencyKey ===
      budgetOpeningEntryIdempotencyKey(allowance.source.idempotencyKey, allowance.executionId) &&
    opening.attemptId === undefined &&
    opening.reservationKey === undefined &&
    opening.fundingSource === 'hq_managed' &&
    opening.quantity.unit === 'microunits' &&
    opening.quantity.value === maximumMicrounits &&
    opening.currency === allowance.currency &&
    opening.costMicrounits === 0 &&
    opening.costExact &&
    opening.authorizationDecisionId === undefined
  )
}

/** Opening evidence a budget's first credit must match: where it was opened and by whom. */
export interface OpeningCreditExpectation {
  readonly workspaceId: string
  readonly executionId: string
  readonly parentExecutionId?: string | undefined
  readonly currency: string
  readonly source: { readonly sourceId: string; readonly idempotencyKey: string }
}

// Keep aligned with usage-ledger's private fingerprintFor('openBudget', input).
export function fingerprintForOpenBudget(input: unknown): string {
  const payload = canonicalJsonStringify({ method: 'openBudget', input })
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`
}

function denyAdmission(): never {
  throw new RuntimeBudgetAdmissionError()
}
