import { createHash } from 'node:crypto'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import type { CommandAcceptanceRepository, Execution } from '@control-plane/domain'
import { executionPlanBudgetAllowance, type ExecutionPlan } from '@control-plane/execution-plan'
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

export interface RuntimeBudgetAdmissionPort {
  authorize(input: {
    readonly execution: Execution
    readonly executionPlan: ExecutionPlan
    readonly attemptId: string
  }): Promise<void>
}

export interface DurableRuntimeBudgetAdmissionOptions {
  readonly store: DurableUsageStore
  readonly commands: Pick<CommandAcceptanceRepository, 'getByExecutionId'>
}

/** Read-only preflight for the accepted plan allowance; it does not reserve or charge usage. */
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

      await this.#store.transaction(allowance.workspaceId, async (transaction) => {
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
      })
    } catch {
      throw new RuntimeBudgetAdmissionError()
    }
  }
}

export class RuntimeBudgetAdmissionError extends Error {
  readonly code = 'RUNTIME_BUDGET_ADMISSION_DENIED'

  constructor() {
    super('RUNTIME_BUDGET_ADMISSION_DENIED')
    this.name = 'RuntimeBudgetAdmissionError'
  }
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

function isOpeningCredit(
  entry: UsageLedgerEntry,
  allowance: ReturnType<typeof executionPlanBudgetAllowance>,
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

// Keep aligned with usage-ledger's private fingerprintFor('openBudget', input).
function fingerprintForOpenBudget(input: ReturnType<typeof executionPlanBudgetAllowance>): string {
  const payload = canonicalJsonStringify({ method: 'openBudget', input })
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`
}

function denyAdmission(): never {
  throw new RuntimeBudgetAdmissionError()
}
