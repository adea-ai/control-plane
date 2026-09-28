import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'
import type { UsageLedgerEntry } from './index.js'

const AmountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const EffectKeySchema = z.string().min(1).max(256)

export const DurableUsageSourceSchema = z
  .object({ sourceId: EffectKeySchema, idempotencyKey: EffectKeySchema })
  .strict()

export const DurableUsageReservationSchema = z
  .object({
    reservationKey: EffectKeySchema,
    attemptId: IdentifierSchemas.attemptId.optional(),
    childExecutionId: IdentifierSchemas.executionId.optional(),
    maximumMicrounits: AmountSchema,
    maximumTokens: AmountSchema,
    chargedMicrounits: AmountSchema,
    chargedTokens: AmountSchema,
    status: z.enum(['open', 'settled']),
  })
  .strict()

export const DurableUsageBudgetSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    parentExecutionId: IdentifierSchemas.executionId.optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    maximumMicrounits: AmountSchema,
    maximumTokens: AmountSchema,
    status: z.enum(['open', 'settled']),
    nextSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reservations: z.array(DurableUsageReservationSchema),
  })
  .strict()
  .superRefine((budget, context) => {
    const keys = new Set()
    let allocatedMoney = 0
    let allocatedTokens = 0
    for (const reservation of budget.reservations) {
      if (keys.has(reservation.reservationKey)) {
        context.addIssue({ code: 'custom', message: 'Duplicate reservation identity' })
      }
      keys.add(reservation.reservationKey)
      if (
        reservation.chargedMicrounits > reservation.maximumMicrounits ||
        reservation.chargedTokens > reservation.maximumTokens
      ) {
        context.addIssue({ code: 'custom', message: 'Reservation exceeds funded authority' })
      }
      allocatedMoney +=
        reservation.status === 'open'
          ? reservation.maximumMicrounits
          : reservation.chargedMicrounits
      allocatedTokens +=
        reservation.status === 'open' ? reservation.maximumTokens : reservation.chargedTokens
      if (budget.status === 'settled' && reservation.status !== 'settled') {
        context.addIssue({ code: 'custom', message: 'Settled budget has an open reservation' })
      }
    }
    if (
      !Number.isSafeInteger(allocatedMoney) ||
      !Number.isSafeInteger(allocatedTokens) ||
      allocatedMoney > budget.maximumMicrounits ||
      allocatedTokens > budget.maximumTokens
    ) {
      context.addIssue({ code: 'custom', message: 'Budget exceeds funded authority' })
    }
  })

export const DurableUsageEffectSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    idempotencyKey: EffectKeySchema,
    fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    result: z.json(),
  })
  .strict()

export type DurableUsageBudget = z.output<typeof DurableUsageBudgetSchema>
export type DurableUsageEffect = z.output<typeof DurableUsageEffectSchema>

/** All reads/writes in a callback belong to one atomic workspace transaction.
 * Stores must serialize concurrent mutation, including parent/child funding,
 * and roll back budget, entries and effects together if the callback fails.
 * Implementations must verify execution/workspace ownership on new writes.
 */
export interface DurableUsageTransaction {
  getBudget(executionId: string): Promise<DurableUsageBudget | undefined>
  putBudget(budget: DurableUsageBudget): Promise<void>
  getEffect(idempotencyKey: string): Promise<DurableUsageEffect | undefined>
  putEffect(effect: DurableUsageEffect): Promise<void>
  appendEntry(entry: UsageLedgerEntry): Promise<void>
  listEntries(executionId: string): Promise<readonly UsageLedgerEntry[]>
}

export interface DurableUsageStore {
  transaction<Result>(
    workspaceId: string,
    operation: (transaction: DurableUsageTransaction) => Promise<Result>
  ): Promise<Result>
}

export class DurableUsageError extends Error {
  constructor(
    readonly code:
      | 'INVALID_ENTRY'
      | 'BUDGET_NOT_FOUND'
      | 'BUDGET_EXISTS'
      | 'BUDGET_EXHAUSTED'
      | 'BUDGET_SETTLED'
      | 'RESERVATION_NOT_FOUND'
      | 'RESERVATION_SETTLED'
      | 'IDEMPOTENCY_CONFLICT'
      | 'SETTLEMENT_INCOMPLETE'
      | 'STORE_STATE_INVALID'
      | 'USAGE_LEDGER_SCOPE_MISMATCH'
  ) {
    super(code)
    this.name = 'DurableUsageError'
  }
}
