import { createHash, randomBytes } from 'node:crypto'
import { compareCodePointOrder, IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'
import {
  DurableUsageBudgetSchema,
  DurableUsageEffectSchema,
  DurableUsageError,
  DurableUsageSourceSchema,
  type DurableUsageBudget,
  type DurableUsageEffect,
  type DurableUsageStore,
  type DurableUsageTransaction,
} from './durable-contract.js'
import { UsageLedgerEntrySchema, type UsageLedgerEntry } from './index.js'

const AmountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/)
const KeySchema = z.string().min(1).max(256)

const OpenBudgetInputSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    parentExecutionId: IdentifierSchemas.executionId.optional(),
    currency: CurrencySchema,
    maximumMicrounits: AmountSchema,
    maximumTokens: AmountSchema,
    source: DurableUsageSourceSchema,
  })
  .strict()

const ReserveInputSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId.optional(),
    reservationKey: KeySchema,
    maximumMicrounits: AmountSchema,
    maximumTokens: AmountSchema,
    source: DurableUsageSourceSchema,
  })
  .strict()

const ModelRequestInputSchema = ReserveInputSchema.extend({
  attemptId: IdentifierSchemas.attemptId,
  modelCallId: IdentifierSchemas.modelCallId,
  fundingSource: z.enum(['hq_managed', 'external_subscription']),
  priceSnapshotDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
})

const ModelRequestSettlementInputSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    reservationKey: KeySchema,
    modelCallId: IdentifierSchemas.modelCallId,
    costMicrounits: AmountSchema,
    tokens: AmountSchema,
    source: DurableUsageSourceSchema,
  })
  .strict()

export type ReserveDurableModelRequestInput = z.input<typeof ModelRequestInputSchema>
export type SettleDurableModelRequestInput = z.input<typeof ModelRequestSettlementInputSchema>

const ChargeInputSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    reservationKey: KeySchema,
    kind: z.enum(['model_usage', 'tool_charge', 'sandbox_usage']),
    quantity: z
      .object({
        unit: z.enum(['tokens', 'calls', 'milliseconds', 'bytes']),
        value: AmountSchema,
      })
      .strict(),
    costMicrounits: AmountSchema,
    fundingSource: z.enum(['hq_managed', 'external_subscription']),
    source: DurableUsageSourceSchema,
  })
  .strict()

const ReservationOperationInputSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    reservationKey: KeySchema,
    source: DurableUsageSourceSchema,
  })
  .strict()

const BudgetOperationInputSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    source: DurableUsageSourceSchema,
  })
  .strict()

const BudgetSummarySchema = z
  .object({
    executionId: IdentifierSchemas.executionId,
    currency: CurrencySchema,
    maximumMicrounits: AmountSchema,
    maximumTokens: AmountSchema,
    spentMicrounits: AmountSchema,
    reservedMicrounits: AmountSchema,
    availableMicrounits: AmountSchema,
    spentTokens: AmountSchema,
    reservedTokens: AmountSchema,
    availableTokens: AmountSchema,
    settled: z.boolean(),
  })
  .strict()

function settlementResultSchema(): z.ZodType<{
  releasedMicrounits: number
  settlement: UsageLedgerEntry
}> {
  return z
    .object({
      releasedMicrounits: AmountSchema,
      settlement: UsageLedgerEntrySchema,
    })
    .strict()
}

const PublicSummarySchema = z
  .object({
    executionId: IdentifierSchemas.executionId,
    currency: CurrencySchema,
    funding: z
      .object({
        hqManagedMicrounits: AmountSchema,
        externalSubscriptionEffects: AmountSchema,
      })
      .strict(),
    usage: z.record(z.string(), AmountSchema),
    settled: z.boolean(),
  })
  .strict()

const EntryAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BillableKinds = new Set(['model_usage', 'tool_charge', 'sandbox_usage'])

export type DurableUsageSource = z.output<typeof DurableUsageSourceSchema>

export interface DurableUsageLedgerOptions {
  readonly store: DurableUsageStore
  readonly now?: () => string
}

export type DurableUsageBudgetSummary = z.output<typeof BudgetSummarySchema>
export type DurableUsagePublicSummary = z.output<typeof PublicSummarySchema>

export interface OpenDurableUsageBudgetInput {
  readonly workspaceId: string
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly currency: string
  readonly maximumMicrounits: number
  readonly maximumTokens: number
  readonly source: DurableUsageSource
}

export interface ReserveDurableUsageInput {
  readonly workspaceId: string
  readonly executionId: string
  readonly attemptId?: string
  readonly reservationKey: string
  readonly maximumMicrounits: number
  readonly maximumTokens: number
  readonly source: DurableUsageSource
}

export interface ChargeDurableUsageInput {
  readonly workspaceId: string
  readonly executionId: string
  readonly attemptId: string
  readonly reservationKey: string
  readonly kind: 'model_usage' | 'tool_charge' | 'sandbox_usage'
  readonly quantity: {
    readonly unit: 'tokens' | 'calls' | 'milliseconds' | 'bytes'
    readonly value: number
  }
  readonly costMicrounits: number
  readonly fundingSource: 'hq_managed' | 'external_subscription'
  readonly source: DurableUsageSource
}

export interface SettleDurableUsageInput {
  readonly workspaceId: string
  readonly executionId: string
  readonly reservationKey: string
  readonly source: DurableUsageSource
}

export interface FinalizeDurableUsageBudgetInput {
  readonly workspaceId: string
  readonly executionId: string
  readonly source: DurableUsageSource
}

interface LoadedBudget {
  readonly budget: DurableUsageBudget
  readonly entries: readonly UsageLedgerEntry[]
}

interface ReplayIdentity {
  operationKey: string
  sourceId: string
  executionId: string
  operation: string
  reservationKey?: string
  kind?: string
  modelCallId?: string
}

/** A durable, transaction-backed usage ledger. Every mutation writes its budget,
 * immutable entry records, and workspace-scoped replay receipt in one store transaction.
 */
export class DurableUsageLedger {
  readonly #store: DurableUsageStore
  readonly #now: () => string

  constructor(options: DurableUsageLedgerOptions) {
    this.#store = options.store
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async openBudget(input: OpenDurableUsageBudgetInput): Promise<DurableUsageBudgetSummary> {
    const parsed = OpenBudgetInputSchema.safeParse(input)
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    const data = parsed.data
    if (data.parentExecutionId === data.executionId) throw usageError('INVALID_ENTRY')

    return this.#mutate(data, 'openBudget', BudgetSummarySchema, async (transaction) => {
      const existingRaw = await transaction.getBudget(data.executionId)
      if (existingRaw !== undefined) {
        await this.#loadValidatedTree(transaction, data.workspaceId, data.executionId)
        throw usageError('BUDGET_EXISTS')
      }

      let maximumMicrounits = data.maximumMicrounits
      let maximumTokens = data.maximumTokens
      const budgetWrites: DurableUsageBudget[] = []
      const entries: UsageLedgerEntry[] = []

      if (data.parentExecutionId !== undefined) {
        const parentLoaded = await this.#loadValidatedTree(
          transaction,
          data.workspaceId,
          data.parentExecutionId
        )
        const parent = mutableBudget(parentLoaded.budget)
        if (parent.status === 'settled') throw usageError('BUDGET_SETTLED')
        if (parent.currency !== data.currency) throw usageError('INVALID_ENTRY')

        const parentTotals = calculateTotals(parent)
        maximumMicrounits = Math.min(data.maximumMicrounits, parentTotals.availableMicrounits)
        maximumTokens = Math.min(data.maximumTokens, parentTotals.availableTokens)
        if (maximumMicrounits === 0 && maximumTokens === 0) {
          throw usageError('BUDGET_EXHAUSTED')
        }

        const reservationKey = `child:${data.executionId}`
        const fundingReservation = {
          reservationKey,
          childExecutionId: data.executionId,
          maximumMicrounits,
          maximumTokens,
          chargedMicrounits: 0,
          chargedTokens: 0,
          status: 'open' as const,
        }
        parent.reservations.push(fundingReservation)
        entries.push(
          this.#makeEntry(parent, data.source, 'openBudget', 'reservation', {
            ...(parent.parentExecutionId === undefined
              ? {}
              : { parentExecutionId: parent.parentExecutionId }),
            reservationKey,
            fundingSource: 'hq_managed',
            quantity: { unit: 'microunits', value: maximumMicrounits },
            currency: parent.currency,
            costMicrounits: maximumMicrounits,
            costExact: true,
          })
        )
        budgetWrites.push(parent)
      }

      const budget: DurableUsageBudget = {
        schemaVersion: 1,
        workspaceId: data.workspaceId,
        executionId: data.executionId,
        ...(data.parentExecutionId === undefined
          ? {}
          : { parentExecutionId: data.parentExecutionId }),
        currency: data.currency,
        maximumMicrounits,
        maximumTokens,
        status: 'open',
        nextSequence: 1,
        reservations: [],
      }
      const mutable = mutableBudget(budget)
      entries.push(
        this.#makeEntry(mutable, data.source, 'openBudget', 'credit', {
          ...(mutable.parentExecutionId === undefined
            ? {}
            : { parentExecutionId: mutable.parentExecutionId }),
          fundingSource: 'hq_managed',
          quantity: { unit: 'microunits', value: maximumMicrounits },
          currency: mutable.currency,
          costMicrounits: 0,
          costExact: true,
        })
      )
      budgetWrites.push(mutable)
      await this.#writeMutation(transaction, budgetWrites, entries)
      return calculateSummary(mutable)
    })
  }

  async reserve(input: ReserveDurableUsageInput): Promise<UsageLedgerEntry> {
    const parsed = ReserveInputSchema.safeParse(input)
    if (!parsed.success || parsed.data.reservationKey.startsWith('child:')) {
      throw usageError('INVALID_ENTRY')
    }
    const data = parsed.data

    return this.#mutate(data, 'reserve', UsageLedgerEntrySchema, async (transaction) => {
      const loaded = await this.#loadValidatedTree(transaction, data.workspaceId, data.executionId)
      const budget = mutableBudget(loaded.budget)
      if (budget.status === 'settled') throw usageError('BUDGET_SETTLED')
      if (
        budget.reservations.some(
          (reservation) => reservation.reservationKey === data.reservationKey
        )
      ) {
        throw usageError('IDEMPOTENCY_CONFLICT')
      }
      const totals = calculateTotals(budget)
      if (
        data.maximumMicrounits > totals.availableMicrounits ||
        data.maximumTokens > totals.availableTokens
      ) {
        throw usageError('BUDGET_EXHAUSTED')
      }

      budget.reservations.push({
        reservationKey: data.reservationKey,
        ...(data.attemptId === undefined ? {} : { attemptId: data.attemptId }),
        maximumMicrounits: data.maximumMicrounits,
        maximumTokens: data.maximumTokens,
        chargedMicrounits: 0,
        chargedTokens: 0,
        status: 'open',
      })
      const entry = this.#makeEntry(budget, data.source, 'reserve', 'reservation', {
        ...(data.attemptId === undefined ? {} : { attemptId: data.attemptId }),
        ...(budget.parentExecutionId === undefined
          ? {}
          : { parentExecutionId: budget.parentExecutionId }),
        reservationKey: data.reservationKey,
        fundingSource: 'hq_managed',
        quantity: { unit: 'microunits', value: data.maximumMicrounits },
        currency: budget.currency,
        costMicrounits: data.maximumMicrounits,
        costExact: true,
      })
      await this.#writeMutation(transaction, [budget], [entry])
      return entry
    })
  }

  async charge(input: ChargeDurableUsageInput): Promise<UsageLedgerEntry> {
    const parsed = ChargeInputSchema.safeParse(input)
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    const data = parsed.data

    return this.#mutate(data, 'charge', UsageLedgerEntrySchema, async (transaction) => {
      const loaded = await this.#loadValidatedTree(transaction, data.workspaceId, data.executionId)
      const budget = mutableBudget(loaded.budget)
      if (budget.status === 'settled') throw usageError('BUDGET_SETTLED')
      const reservation = budget.reservations.find(
        (item) => item.reservationKey === data.reservationKey
      )
      if (!reservation || reservation.childExecutionId !== undefined) {
        throw usageError('RESERVATION_NOT_FOUND')
      }
      if (reservation.status === 'settled') throw usageError('RESERVATION_SETTLED')
      if (data.kind === 'model_usage' && (reservation.modelRequests?.length ?? 0) > 0) {
        throw usageError('INVALID_ENTRY')
      }
      if (data.fundingSource === 'external_subscription' && data.costMicrounits !== 0) {
        throw usageError('INVALID_ENTRY')
      }

      const chargedMicrounits = safeAddOrThrow(
        reservation.chargedMicrounits,
        data.costMicrounits,
        'BUDGET_EXHAUSTED'
      )
      const chargedTokens =
        data.quantity.unit === 'tokens'
          ? safeAddOrThrow(reservation.chargedTokens, data.quantity.value, 'BUDGET_EXHAUSTED')
          : reservation.chargedTokens
      assertRequestCapacity(reservation, chargedMicrounits, chargedTokens)
      reservation.chargedMicrounits = chargedMicrounits
      reservation.chargedTokens = chargedTokens

      const entry = this.#makeEntry(budget, data.source, 'charge', data.kind, {
        ...(budget.parentExecutionId === undefined
          ? {}
          : { parentExecutionId: budget.parentExecutionId }),
        attemptId: data.attemptId,
        reservationKey: data.reservationKey,
        fundingSource: data.fundingSource,
        quantity: data.quantity,
        currency: budget.currency,
        costMicrounits: data.costMicrounits,
        costExact: data.fundingSource === 'hq_managed',
      })
      await this.#writeMutation(transaction, [budget], [entry])
      return entry
    })
  }

  async settle(
    input: SettleDurableUsageInput
  ): Promise<{ readonly releasedMicrounits: number; readonly settlement: UsageLedgerEntry }> {
    const parsed = ReservationOperationInputSchema.safeParse(input)
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    const data = parsed.data

    return this.#mutate(data, 'settle', settlementResultSchema(), async (transaction) => {
      const loaded = await this.#loadValidatedTree(transaction, data.workspaceId, data.executionId)
      const budget = mutableBudget(loaded.budget)
      if (budget.status === 'settled') throw usageError('BUDGET_SETTLED')
      const reservation = budget.reservations.find(
        (item) => item.reservationKey === data.reservationKey
      )
      if (!reservation) throw usageError('RESERVATION_NOT_FOUND')
      if (reservation.childExecutionId !== undefined) {
        throw usageError('SETTLEMENT_INCOMPLETE')
      }
      if (reservation.status === 'settled') throw usageError('RESERVATION_SETTLED')
      if (reservation.modelRequests?.some((request) => request.status === 'open')) {
        throw usageError('SETTLEMENT_INCOMPLETE')
      }

      const releasedMicrounits = reservation.maximumMicrounits - reservation.chargedMicrounits
      const release = this.#makeEntry(
        budget,
        data.source,
        'settle',
        'release',
        {
          ...(reservation.attemptId === undefined ? {} : { attemptId: reservation.attemptId }),
          ...(budget.parentExecutionId === undefined
            ? {}
            : { parentExecutionId: budget.parentExecutionId }),
          reservationKey: data.reservationKey,
          fundingSource: 'hq_managed',
          quantity: { unit: 'microunits', value: releasedMicrounits },
          currency: budget.currency,
          costMicrounits: 0,
          costExact: true,
        },
        0
      )
      const settlement = this.#makeEntry(
        budget,
        data.source,
        'settle',
        'settlement',
        {
          ...(reservation.attemptId === undefined ? {} : { attemptId: reservation.attemptId }),
          ...(budget.parentExecutionId === undefined
            ? {}
            : { parentExecutionId: budget.parentExecutionId }),
          reservationKey: data.reservationKey,
          fundingSource: 'hq_managed',
          quantity: { unit: 'microunits', value: reservation.chargedMicrounits },
          currency: budget.currency,
          costMicrounits: 0,
          costExact: true,
        },
        1
      )
      reservation.status = 'settled'
      const result = { releasedMicrounits, settlement }
      await this.#writeMutation(transaction, [budget], [release, settlement])
      return result
    })
  }

  /** Accounting hold within the admitted attempt envelope. The caller must
   * supply a trusted quote/funding decision; this is not provider-send permission.
   * Unknown outcomes remain open until explicit, authoritative reconciliation.
   */
  async reserveModelRequest(input: ReserveDurableModelRequestInput): Promise<UsageLedgerEntry> {
    return this.#reserveModelRequest(input, false)
  }

  /** One durable admission per physical send identity. A replay may have sent
   * already, so it must reconcile instead of invoking the provider again.
   * This fence still requires trusted funding/quote authority at the send boundary.
   */
  async reserveModelRequestForDispatch(
    input: ReserveDurableModelRequestInput
  ): Promise<UsageLedgerEntry> {
    return this.#reserveModelRequest(input, true)
  }

  async #reserveModelRequest(
    input: ReserveDurableModelRequestInput,
    rejectReplay: boolean
  ): Promise<UsageLedgerEntry> {
    const parsed = ModelRequestInputSchema.safeParse(input)
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    const data = parsed.data
    if (data.fundingSource === 'external_subscription' && data.maximumMicrounits !== 0) {
      throw usageError('INVALID_ENTRY')
    }
    return this.#mutate(
      data,
      'reserveModelRequest',
      UsageLedgerEntrySchema,
      async (transaction) => {
        const loaded = await this.#loadValidatedTree(
          transaction,
          data.workspaceId,
          data.executionId
        )
        const budget = mutableBudget(loaded.budget)
        const reservation = openAttemptReservation(budget, data)
        if (
          budget.reservations.some((value) =>
            value.modelRequests?.some((request) => request.modelCallId === data.modelCallId)
          )
        ) {
          throw usageError('IDEMPOTENCY_CONFLICT')
        }
        assertRequestCapacity(
          reservation,
          safeAddOrThrow(reservation.chargedMicrounits, data.maximumMicrounits, 'BUDGET_EXHAUSTED'),
          safeAddOrThrow(reservation.chargedTokens, data.maximumTokens, 'BUDGET_EXHAUSTED')
        )
        reservation.modelRequests ??= []
        if (reservation.modelRequests.length >= 2_048) throw usageError('BUDGET_EXHAUSTED')
        reservation.modelRequests.push({
          modelCallId: data.modelCallId,
          maximumMicrounits: data.maximumMicrounits,
          maximumTokens: data.maximumTokens,
          fundingSource: data.fundingSource,
          priceSnapshotDigest: data.priceSnapshotDigest,
          requestDigest: data.requestDigest,
          status: 'open',
          chargedMicrounits: 0,
          chargedTokens: 0,
        })
        const entry = this.#makeEntry(
          budget,
          data.source,
          'reserveModelRequest',
          'model_reservation',
          {
            ...modelEntryScope(budget, reservation, data.modelCallId),
            fundingSource: data.fundingSource,
            quantity: { unit: 'microunits', value: data.maximumMicrounits },
            costMicrounits: data.maximumMicrounits,
            costExact: data.fundingSource === 'hq_managed',
            reservedTokens: data.maximumTokens,
            priceSnapshotDigest: data.priceSnapshotDigest,
            requestDigest: data.requestDigest,
          }
        )
        await this.#writeMutation(transaction, [budget], [entry])
        return entry
      },
      rejectReplay
    )
  }

  async settleModelRequest(input: SettleDurableModelRequestInput): Promise<UsageLedgerEntry> {
    const parsed = ModelRequestSettlementInputSchema.safeParse(input)
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    const data = parsed.data
    return this.#mutate(data, 'settleModelRequest', UsageLedgerEntrySchema, async (transaction) => {
      const loaded = await this.#loadValidatedTree(transaction, data.workspaceId, data.executionId)
      const budget = mutableBudget(loaded.budget)
      const reservation = openAttemptReservation(budget, data)
      const request = reservation.modelRequests?.find(
        (value) => value.modelCallId === data.modelCallId
      )
      if (!request) throw usageError('RESERVATION_NOT_FOUND')
      if (request.status === 'settled') throw usageError('RESERVATION_SETTLED')
      if (data.costMicrounits > request.maximumMicrounits || data.tokens > request.maximumTokens) {
        throw usageError('BUDGET_EXHAUSTED')
      }
      if (request.fundingSource === 'external_subscription' && data.costMicrounits !== 0) {
        throw usageError('INVALID_ENTRY')
      }
      reservation.chargedMicrounits = safeAddOrThrow(
        reservation.chargedMicrounits,
        data.costMicrounits,
        'BUDGET_EXHAUSTED'
      )
      reservation.chargedTokens = safeAddOrThrow(
        reservation.chargedTokens,
        data.tokens,
        'BUDGET_EXHAUSTED'
      )
      request.status = 'settled'
      request.chargedMicrounits = data.costMicrounits
      request.chargedTokens = data.tokens
      const fields = {
        ...modelEntryScope(budget, reservation, data.modelCallId),
        fundingSource: request.fundingSource,
        costExact: request.fundingSource === 'hq_managed',
      }
      const charge = this.#makeEntry(budget, data.source, 'settleModelRequest', 'model_usage', {
        ...fields,
        quantity: { unit: 'tokens', value: data.tokens },
        costMicrounits: data.costMicrounits,
      })
      const release = this.#makeEntry(
        budget,
        data.source,
        'settleModelRequest',
        'model_release',
        {
          ...fields,
          quantity: { unit: 'microunits', value: request.maximumMicrounits - data.costMicrounits },
          costMicrounits: 0,
        },
        1
      )
      await this.#writeMutation(transaction, [budget], [charge, release])
      return charge
    })
  }

  async finalizeBudget(input: FinalizeDurableUsageBudgetInput): Promise<DurableUsageBudgetSummary> {
    const parsed = BudgetOperationInputSchema.safeParse(input)
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    const data = parsed.data

    return this.#mutate(data, 'finalizeBudget', BudgetSummarySchema, async (transaction) => {
      const loaded = await this.#loadValidatedTree(transaction, data.workspaceId, data.executionId)
      const budget = mutableBudget(loaded.budget)
      if (budget.status === 'settled') throw usageError('BUDGET_SETTLED')
      if (budget.reservations.some((reservation) => reservation.status !== 'settled')) {
        throw usageError('SETTLEMENT_INCOMPLETE')
      }

      const totals = calculateTotals(budget)
      const entries: UsageLedgerEntry[] = []
      const budgetWrites: DurableUsageBudget[] = [budget]

      if (budget.parentExecutionId !== undefined) {
        const parentLoaded = await this.#loadValidatedTree(
          transaction,
          data.workspaceId,
          budget.parentExecutionId
        )
        const parent = mutableBudget(parentLoaded.budget)
        if (parent.status === 'settled') throw usageError('STORE_STATE_INVALID')
        const fundingKey = `child:${budget.executionId}`
        const funding = parent.reservations.find(
          (reservation) =>
            reservation.reservationKey === fundingKey &&
            reservation.childExecutionId === budget.executionId
        )
        if (!funding || funding.status !== 'open') throw usageError('STORE_STATE_INVALID')
        if (
          totals.spentMicrounits > funding.maximumMicrounits ||
          totals.spentTokens > funding.maximumTokens
        ) {
          throw usageError('STORE_STATE_INVALID')
        }

        const releasedMicrounits = funding.maximumMicrounits - totals.spentMicrounits
        funding.chargedMicrounits = totals.spentMicrounits
        funding.chargedTokens = totals.spentTokens
        funding.status = 'settled'
        entries.push(
          this.#makeEntry(parent, data.source, 'finalizeBudget', 'release', {
            ...(parent.parentExecutionId === undefined
              ? {}
              : { parentExecutionId: parent.parentExecutionId }),
            reservationKey: fundingKey,
            fundingSource: 'hq_managed',
            quantity: { unit: 'microunits', value: releasedMicrounits },
            currency: parent.currency,
            costMicrounits: 0,
            costExact: true,
          })
        )
        entries.push(
          this.#makeEntry(
            parent,
            data.source,
            'finalizeBudget',
            'settlement',
            {
              ...(parent.parentExecutionId === undefined
                ? {}
                : { parentExecutionId: parent.parentExecutionId }),
              reservationKey: fundingKey,
              fundingSource: 'hq_managed',
              quantity: { unit: 'microunits', value: totals.spentMicrounits },
              currency: parent.currency,
              costMicrounits: 0,
              costExact: true,
            },
            1
          )
        )
        budgetWrites.push(parent)
      }

      budget.status = 'settled'
      entries.push(
        this.#makeEntry(budget, data.source, 'finalizeBudget', 'settlement', {
          ...(budget.parentExecutionId === undefined
            ? {}
            : { parentExecutionId: budget.parentExecutionId }),
          fundingSource: 'hq_managed',
          quantity: { unit: 'microunits', value: totals.spentMicrounits },
          currency: budget.currency,
          costMicrounits: 0,
          costExact: true,
        })
      )
      await this.#writeMutation(transaction, budgetWrites, entries)
      return calculateSummary(budget)
    })
  }

  /** Called inside the attempt writer's existing store transaction. An open
   * runtime allocation is a durable dispatch fence until explicit reconciliation.
   */
  async assertRuntimeAttemptReleased(
    workspaceId: string,
    executionId: string,
    attemptId: string
  ): Promise<void> {
    if (
      !IdentifierSchemas.workspaceId.safeParse(workspaceId).success ||
      !IdentifierSchemas.executionId.safeParse(executionId).success ||
      !IdentifierSchemas.attemptId.safeParse(attemptId).success
    )
      throw usageError('INVALID_ENTRY')
    await this.#store.transaction(workspaceId, async (transaction) => {
      // Legacy owners may not have an allocation; runtime admission separately
      // refuses to dispatch them. Never create funding as part of this read.
      if ((await transaction.getBudget(executionId)) === undefined) {
        if (
          (await transaction.listEntries(executionId)).length !== 0 ||
          (await transaction.getEffect(`runtime-attempt:${attemptId}:reserve`)) !== undefined
        ) {
          throw usageError('STORE_STATE_INVALID')
        }
        return
      }
      const loaded = await this.#loadValidatedTree(transaction, workspaceId, executionId)
      const reservation = loaded.budget.reservations.find(
        (value) => value.reservationKey === `runtime-attempt:${attemptId}`
      )
      if (
        reservation === undefined &&
        (await transaction.getEffect(`runtime-attempt:${attemptId}:reserve`)) !== undefined
      ) {
        throw usageError('STORE_STATE_INVALID')
      }
      if (
        reservation !== undefined &&
        (reservation.attemptId !== attemptId || reservation.childExecutionId !== undefined)
      ) {
        throw usageError('STORE_STATE_INVALID')
      }
      if (reservation?.status === 'open') throw usageError('SETTLEMENT_INCOMPLETE')
    })
  }

  async summary(workspaceId: string, executionId: string): Promise<DurableUsageBudgetSummary> {
    const parsed = z
      .object({
        workspaceId: IdentifierSchemas.workspaceId,
        executionId: IdentifierSchemas.executionId,
      })
      .strict()
      .safeParse({ workspaceId, executionId })
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    return this.#store.transaction(parsed.data.workspaceId, async (transaction) => {
      const loaded = await this.#loadValidatedTree(
        transaction,
        parsed.data.workspaceId,
        parsed.data.executionId
      )
      return deepFreeze(calculateSummary(loaded.budget))
    })
  }

  async entries(workspaceId: string, executionId: string): Promise<readonly UsageLedgerEntry[]> {
    const parsed = z
      .object({
        workspaceId: IdentifierSchemas.workspaceId,
        executionId: IdentifierSchemas.executionId,
      })
      .strict()
      .safeParse({ workspaceId, executionId })
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    return this.#store.transaction(parsed.data.workspaceId, async (transaction) => {
      const loaded = await this.#loadValidatedTree(
        transaction,
        parsed.data.workspaceId,
        parsed.data.executionId
      )
      return deepFreeze(loaded.entries.map((entry) => cloneEntry(entry)))
    })
  }

  async publicSummary(
    workspaceId: string,
    executionId: string
  ): Promise<DurableUsagePublicSummary> {
    const parsed = z
      .object({
        workspaceId: IdentifierSchemas.workspaceId,
        executionId: IdentifierSchemas.executionId,
      })
      .strict()
      .safeParse({ workspaceId, executionId })
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    return this.#store.transaction(parsed.data.workspaceId, async (transaction) => {
      const loaded = await this.#loadValidatedTree(
        transaction,
        parsed.data.workspaceId,
        parsed.data.executionId
      )
      const usage: Record<string, number> = {}
      let hqManagedMicrounits = 0
      let externalSubscriptionEffects = 0
      for (const entry of loaded.entries) {
        if (!BillableKinds.has(entry.kind)) continue
        usage[entry.quantity.unit] = safeAddOrThrow(
          usage[entry.quantity.unit] ?? 0,
          entry.quantity.value,
          'STORE_STATE_INVALID'
        )
        if (entry.fundingSource === 'hq_managed') {
          hqManagedMicrounits = safeAddOrThrow(
            hqManagedMicrounits,
            entry.costMicrounits,
            'STORE_STATE_INVALID'
          )
        } else {
          externalSubscriptionEffects = safeAddOrThrow(
            externalSubscriptionEffects,
            1,
            'STORE_STATE_INVALID'
          )
        }
      }
      const result = PublicSummarySchema.parse({
        executionId: loaded.budget.executionId,
        currency: loaded.budget.currency,
        funding: { hqManagedMicrounits, externalSubscriptionEffects },
        usage,
        settled: loaded.budget.status === 'settled',
      })
      return deepFreeze(result)
    })
  }

  async #mutate<
    Input extends { workspaceId: string; executionId: string; source: DurableUsageSource },
    Result,
  >(
    input: Input,
    method: string,
    resultSchema: z.ZodType<Result>,
    operation: (transaction: DurableUsageTransaction) => Promise<Result>,
    rejectReplay = false
  ): Promise<Result> {
    const fingerprint = fingerprintFor(method, input)
    return this.#store.transaction(input.workspaceId, async (transaction) => {
      const priorRaw = await transaction.getEffect(input.source.idempotencyKey)
      if (priorRaw !== undefined) {
        const prior = DurableUsageEffectSchema.safeParse(priorRaw)
        if (!prior.success) throw usageError('STORE_STATE_INVALID')
        assertEffectScope(prior.data, input.workspaceId, input.source.idempotencyKey)
        if (prior.data.fingerprint !== fingerprint) throw usageError('IDEMPOTENCY_CONFLICT')
        if (prior.data.executionId !== input.executionId) throw usageError('STORE_STATE_INVALID')
        let replayBudget: LoadedBudget
        try {
          replayBudget = await this.#loadValidatedTree(
            transaction,
            input.workspaceId,
            input.executionId
          )
        } catch (error) {
          if (isUsageError(error, 'BUDGET_NOT_FOUND')) throw usageError('STORE_STATE_INVALID')
          throw error
        }
        const replay = resultSchema.safeParse(prior.data.result)
        if (!replay.success) throw usageError('STORE_STATE_INVALID')
        assertResultExecution(replay.data, input.executionId)
        const replayInput = input as Input & {
          reservationKey?: string
          kind?: string
          modelCallId?: string
        }
        assertReplayEntries(replay.data, replayBudget.entries, {
          operationKey: input.source.idempotencyKey,
          sourceId: input.source.sourceId,
          executionId: input.executionId,
          operation: method,
          ...(replayInput.reservationKey === undefined
            ? {}
            : { reservationKey: replayInput.reservationKey }),
          ...(replayInput.kind === undefined ? {} : { kind: replayInput.kind }),
          ...(replayInput.modelCallId === undefined
            ? {}
            : { modelCallId: replayInput.modelCallId }),
        })
        assertReplaySummary(replay.data, replayBudget, {
          operationKey: input.source.idempotencyKey,
          sourceId: input.source.sourceId,
          executionId: input.executionId,
          operation: method,
        })
        if (rejectReplay) throw usageError('MODEL_REQUEST_DISPATCH_ALREADY_ADMITTED')
        return deepFreeze(replay.data)
      }

      const rawResult = await operation(transaction)
      const result = resultSchema.safeParse(rawResult)
      if (!result.success) throw usageError('STORE_STATE_INVALID')
      assertResultExecution(result.data, input.executionId)
      const effect = DurableUsageEffectSchema.safeParse({
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        executionId: input.executionId,
        idempotencyKey: input.source.idempotencyKey,
        fingerprint,
        result: result.data,
      })
      if (!effect.success) throw usageError('STORE_STATE_INVALID')
      await transaction.putEffect(effect.data)
      return deepFreeze(result.data)
    })
  }

  async #loadValidatedTree(
    transaction: DurableUsageTransaction,
    workspaceId: string,
    executionId: string
  ): Promise<LoadedBudget> {
    const cache = new Map<string, LoadedBudget>()
    const loadLocal = async (
      requestedExecutionId: string,
      relation: 'target' | 'linked'
    ): Promise<LoadedBudget | undefined> => {
      const cached = cache.get(requestedExecutionId)
      if (cached) return cached
      const rawBudget = await transaction.getBudget(requestedExecutionId)
      if (rawBudget === undefined) return undefined
      if (
        relation === 'target' &&
        rawBudget !== null &&
        typeof rawBudget === 'object' &&
        (rawBudget as Record<string, unknown>)['workspaceId'] !== workspaceId
      ) {
        throw usageError('BUDGET_NOT_FOUND')
      }
      const parsedBudget = DurableUsageBudgetSchema.safeParse(rawBudget)
      if (!parsedBudget.success) throw usageError('STORE_STATE_INVALID')
      if (parsedBudget.data.workspaceId !== workspaceId) {
        throw usageError(relation === 'target' ? 'BUDGET_NOT_FOUND' : 'STORE_STATE_INVALID')
      }
      if (parsedBudget.data.executionId !== requestedExecutionId) {
        throw usageError('STORE_STATE_INVALID')
      }
      const rawEntries = await transaction.listEntries(requestedExecutionId)
      if (!Array.isArray(rawEntries)) throw usageError('STORE_STATE_INVALID')
      const entries: UsageLedgerEntry[] = []
      for (const rawEntry of rawEntries) {
        const parsedEntry = UsageLedgerEntrySchema.safeParse(rawEntry)
        if (!parsedEntry.success) throw usageError('STORE_STATE_INVALID')
        entries.push(parsedEntry.data)
      }
      const orderedEntries = entries.toSorted((left, right) => left.sequence - right.sequence)
      validateLocalLedger(parsedBudget.data, orderedEntries)
      const loaded = { budget: parsedBudget.data, entries: orderedEntries }
      cache.set(requestedExecutionId, loaded)
      return loaded
    }

    const target = await loadLocal(executionId, 'target')
    if (!target) throw usageError('BUDGET_NOT_FOUND')

    let root = target
    const ancestorPath = new Set<string>([target.budget.executionId])
    while (root.budget.parentExecutionId !== undefined) {
      const parentExecutionId = root.budget.parentExecutionId
      if (ancestorPath.has(parentExecutionId)) throw usageError('STORE_STATE_INVALID')
      ancestorPath.add(parentExecutionId)
      const parent = await loadLocal(parentExecutionId, 'linked')
      if (!parent) throw usageError('STORE_STATE_INVALID')
      validateChildFunding(parent.budget, root.budget)
      root = parent
    }

    const visited = new Set<string>()
    const active = new Set<string>()
    const visitChildren = async (current: LoadedBudget): Promise<void> => {
      const currentId = current.budget.executionId
      if (active.has(currentId) || visited.has(currentId)) throw usageError('STORE_STATE_INVALID')
      active.add(currentId)
      for (const reservation of current.budget.reservations) {
        if (reservation.childExecutionId === undefined) continue
        const child = await loadLocal(reservation.childExecutionId, 'linked')
        if (!child) throw usageError('STORE_STATE_INVALID')
        validateChildFunding(current.budget, child.budget)
        await visitChildren(child)
      }
      active.delete(currentId)
      visited.add(currentId)
    }
    await visitChildren(root)
    return target
  }

  async #writeMutation(
    transaction: DurableUsageTransaction,
    budgets: readonly DurableUsageBudget[],
    entries: readonly UsageLedgerEntry[]
  ): Promise<void> {
    for (const budget of budgets) {
      const parsed = DurableUsageBudgetSchema.safeParse(budget)
      if (!parsed.success) throw usageError('STORE_STATE_INVALID')
      await transaction.putBudget(parsed.data)
    }
    for (const entry of entries) {
      const parsed = UsageLedgerEntrySchema.safeParse(entry)
      if (!parsed.success) throw usageError('INVALID_ENTRY')
      await transaction.appendEntry(parsed.data)
    }
    const validated = new Set<string>()
    for (const budget of budgets) {
      if (validated.has(budget.executionId)) continue
      await this.#loadValidatedTree(transaction, budget.workspaceId, budget.executionId)
      validated.add(budget.executionId)
    }
  }

  #makeEntry(
    budget: DurableUsageBudget,
    operationSource: DurableUsageSource,
    operation: string,
    kind: UsageLedgerEntry['kind'],
    fields: Omit<
      UsageLedgerEntry,
      'entryId' | 'sequence' | 'workspaceId' | 'executionId' | 'kind' | 'source' | 'recordedAt'
    >,
    ordinal = 0
  ): UsageLedgerEntry {
    if (budget.nextSequence >= Number.MAX_SAFE_INTEGER) throw usageError('STORE_STATE_INVALID')
    const parsed = UsageLedgerEntrySchema.safeParse({
      ...fields,
      entryId: createEntryId(),
      sequence: budget.nextSequence,
      workspaceId: budget.workspaceId,
      executionId: budget.executionId,
      kind,
      source: {
        sourceId: operationSource.sourceId,
        idempotencyKey: entryIdempotencyKey(
          operationSource.idempotencyKey,
          budget.executionId,
          operation,
          kind,
          ordinal
        ),
      },
      recordedAt: this.#now(),
    })
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    budget.nextSequence += 1
    return deepFreeze(parsed.data)
  }
}

function validateLocalLedger(
  budget: DurableUsageBudget,
  entries: readonly UsageLedgerEntry[]
): void {
  if (entries.length !== budget.nextSequence - 1) throw usageError('STORE_STATE_INVALID')
  const entryIds = new Set<string>()
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (
      !entry ||
      entry.sequence !== index + 1 ||
      entry.workspaceId !== budget.workspaceId ||
      entry.executionId !== budget.executionId ||
      entry.parentExecutionId !== budget.parentExecutionId ||
      entry.currency !== budget.currency ||
      entryIds.has(entry.entryId)
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
    entryIds.add(entry.entryId)
  }

  const creditEntries = entries.filter((entry) => entry.kind === 'credit')
  if (
    creditEntries.length !== 1 ||
    creditEntries[0]?.quantity.unit !== 'microunits' ||
    creditEntries[0]?.quantity.value !== budget.maximumMicrounits ||
    creditEntries[0]?.costMicrounits !== 0 ||
    creditEntries[0]?.fundingSource !== 'hq_managed' ||
    !creditEntries[0]?.costExact ||
    creditEntries[0]?.reservationKey !== undefined
  ) {
    throw usageError('STORE_STATE_INVALID')
  }

  const reservationEntries = entries.filter((entry) => entry.kind === 'reservation')
  if (reservationEntries.length !== budget.reservations.length) {
    throw usageError('STORE_STATE_INVALID')
  }
  for (const reservation of budget.reservations) {
    const matches = reservationEntries.filter(
      (entry) => entry.reservationKey === reservation.reservationKey
    )
    const entry = matches[0]
    if (
      matches.length !== 1 ||
      !entry ||
      entry.quantity.unit !== 'microunits' ||
      entry.quantity.value !== reservation.maximumMicrounits ||
      entry.costMicrounits !== reservation.maximumMicrounits ||
      entry.currency !== budget.currency ||
      entry.fundingSource !== 'hq_managed' ||
      !entry.costExact ||
      entry.attemptId !== reservation.attemptId ||
      (reservation.childExecutionId !== undefined &&
        reservation.reservationKey !== `child:${reservation.childExecutionId}`) ||
      (reservation.childExecutionId === undefined &&
        reservation.reservationKey.startsWith('child:'))
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
  }

  const chargeTotals = new Map<string, { microunits: number; tokens: number }>()
  validateModelRequestEntries(budget, entries)
  for (const entry of entries) {
    if (
      (entry.kind === 'release' || entry.kind === 'settlement') &&
      entry.reservationKey !== undefined &&
      !budget.reservations.some((item) => item.reservationKey === entry.reservationKey)
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
    if (!BillableKinds.has(entry.kind)) continue
    if (!entry.reservationKey) throw usageError('STORE_STATE_INVALID')
    const reservation = budget.reservations.find(
      (item) => item.reservationKey === entry.reservationKey
    )
    if (!reservation || reservation.childExecutionId !== undefined) {
      throw usageError('STORE_STATE_INVALID')
    }
    if (
      (entry.fundingSource === 'external_subscription' &&
        (entry.costMicrounits !== 0 || entry.costExact)) ||
      (entry.fundingSource === 'hq_managed' && !entry.costExact) ||
      (reservation.attemptId !== undefined && entry.attemptId !== reservation.attemptId)
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
    const current = chargeTotals.get(entry.reservationKey) ?? { microunits: 0, tokens: 0 }
    current.microunits = safeAddOrThrow(
      current.microunits,
      entry.costMicrounits,
      'STORE_STATE_INVALID'
    )
    if (entry.quantity.unit === 'tokens') {
      current.tokens = safeAddOrThrow(current.tokens, entry.quantity.value, 'STORE_STATE_INVALID')
    }
    chargeTotals.set(entry.reservationKey, current)
  }

  for (const reservation of budget.reservations) {
    const charges = chargeTotals.get(reservation.reservationKey) ?? { microunits: 0, tokens: 0 }
    if (
      reservation.childExecutionId === undefined &&
      (charges.microunits !== reservation.chargedMicrounits ||
        charges.tokens !== reservation.chargedTokens)
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
    const releases = entries.filter(
      (entry) => entry.kind === 'release' && entry.reservationKey === reservation.reservationKey
    )
    const settlements = entries.filter(
      (entry) => entry.kind === 'settlement' && entry.reservationKey === reservation.reservationKey
    )
    if (reservation.status === 'open') {
      if (releases.length !== 0 || settlements.length !== 0) {
        throw usageError('STORE_STATE_INVALID')
      }
      if (
        reservation.childExecutionId !== undefined &&
        (reservation.chargedMicrounits !== 0 || reservation.chargedTokens !== 0)
      ) {
        throw usageError('STORE_STATE_INVALID')
      }
    } else {
      const release = releases[0]
      const settlement = settlements[0]
      if (
        releases.length !== 1 ||
        settlements.length !== 1 ||
        !release ||
        !settlement ||
        release.quantity.unit !== 'microunits' ||
        release.quantity.value !== reservation.maximumMicrounits - reservation.chargedMicrounits ||
        release.costMicrounits !== 0 ||
        settlement.quantity.unit !== 'microunits' ||
        settlement.quantity.value !== reservation.chargedMicrounits ||
        settlement.costMicrounits !== 0 ||
        release.attemptId !== reservation.attemptId ||
        settlement.attemptId !== reservation.attemptId
      ) {
        throw usageError('STORE_STATE_INVALID')
      }
    }
  }

  const budgetSettlements = entries.filter(
    (entry) => entry.kind === 'settlement' && entry.reservationKey === undefined
  )
  if (
    (budget.status === 'open' && budgetSettlements.length !== 0) ||
    (budget.status === 'settled' && budgetSettlements.length !== 1)
  ) {
    throw usageError('STORE_STATE_INVALID')
  }
  if (budget.status === 'settled') {
    const settlement = budgetSettlements[0]
    const totals = calculateTotals(budget)
    if (
      !settlement ||
      settlement.quantity.unit !== 'microunits' ||
      settlement.quantity.value !== totals.spentMicrounits ||
      settlement.costMicrounits !== 0
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
  }
}

function validateChildFunding(parent: DurableUsageBudget, child: DurableUsageBudget): void {
  if (
    child.parentExecutionId !== parent.executionId ||
    parent.workspaceId !== child.workspaceId ||
    parent.currency !== child.currency
  ) {
    throw usageError('STORE_STATE_INVALID')
  }
  const key = `child:${child.executionId}`
  const matches = parent.reservations.filter(
    (reservation) =>
      reservation.reservationKey === key && reservation.childExecutionId === child.executionId
  )
  const funding = matches[0]
  if (matches.length !== 1 || !funding) throw usageError('STORE_STATE_INVALID')
  if (child.status === 'open') {
    if (
      funding.status !== 'open' ||
      funding.chargedMicrounits !== 0 ||
      funding.chargedTokens !== 0
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
    return
  }
  const childTotals = calculateTotals(child)
  if (
    funding.status !== 'settled' ||
    funding.chargedMicrounits !== childTotals.spentMicrounits ||
    funding.chargedTokens !== childTotals.spentTokens
  ) {
    throw usageError('STORE_STATE_INVALID')
  }
}

type AttemptReservation = DurableUsageBudget['reservations'][number]

function openAttemptReservation(
  budget: DurableUsageBudget,
  input: {
    reservationKey: string
    attemptId: string
  }
): AttemptReservation {
  if (budget.status === 'settled') throw usageError('BUDGET_SETTLED')
  const reservation = budget.reservations.find(
    (value) => value.reservationKey === input.reservationKey
  )
  if (
    !reservation ||
    reservation.attemptId !== input.attemptId ||
    reservation.childExecutionId !== undefined
  ) {
    throw usageError('RESERVATION_NOT_FOUND')
  }
  if (reservation.status === 'settled') throw usageError('RESERVATION_SETTLED')
  return reservation
}

function modelEntryScope(
  budget: DurableUsageBudget,
  reservation: AttemptReservation,
  modelCallId: NonNullable<UsageLedgerEntry['modelCallId']>
) {
  return {
    attemptId: reservation.attemptId,
    ...(budget.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: budget.parentExecutionId }),
    reservationKey: reservation.reservationKey,
    currency: budget.currency,
    modelCallId,
  }
}

function assertRequestCapacity(
  reservation: AttemptReservation,
  chargedMoney: number,
  chargedTokens: number
): void {
  let committedMoney = chargedMoney
  let committedTokens = chargedTokens
  for (const hold of reservation.modelRequests ?? []) {
    if (hold.status !== 'open') continue
    committedMoney = safeAddOrThrow(committedMoney, hold.maximumMicrounits, 'BUDGET_EXHAUSTED')
    committedTokens = safeAddOrThrow(committedTokens, hold.maximumTokens, 'BUDGET_EXHAUSTED')
  }
  if (
    committedMoney > reservation.maximumMicrounits ||
    committedTokens > reservation.maximumTokens
  ) {
    throw usageError('BUDGET_EXHAUSTED')
  }
}

function validateModelRequestEntries(
  budget: DurableUsageBudget,
  entries: readonly UsageLedgerEntry[]
): void {
  const requests = new Map<
    string,
    {
      reservation: AttemptReservation
      hold: NonNullable<AttemptReservation['modelRequests']>[number]
    }
  >()
  for (const reservation of budget.reservations) {
    for (const hold of reservation.modelRequests ?? [])
      requests.set(hold.modelCallId, { reservation, hold })
  }
  for (const entry of entries) {
    if (entry.modelCallId === undefined) continue
    const request = requests.get(entry.modelCallId)
    if (
      !request ||
      entry.reservationKey !== request.reservation.reservationKey ||
      entry.attemptId !== request.reservation.attemptId ||
      entry.fundingSource !== request.hold.fundingSource ||
      entry.costExact !== (request.hold.fundingSource === 'hq_managed')
    )
      throw usageError('STORE_STATE_INVALID')
  }
  for (const { reservation, hold } of requests.values()) {
    const matching = entries.filter((entry) => entry.modelCallId === hold.modelCallId)
    const holds = matching.filter((entry) => entry.kind === 'model_reservation')
    const opening = holds[0]
    if (
      holds.length !== 1 ||
      !opening ||
      opening.quantity.unit !== 'microunits' ||
      opening.quantity.value !== hold.maximumMicrounits ||
      opening.costMicrounits !== hold.maximumMicrounits ||
      opening.reservedTokens !== hold.maximumTokens ||
      opening.priceSnapshotDigest !== hold.priceSnapshotDigest ||
      opening.requestDigest !== hold.requestDigest
    )
      throw usageError('STORE_STATE_INVALID')
    // Legacy aggregate charges may precede the first per-request hold, but
    // cannot be introduced after switching this attempt to request accounting.
    if (
      entries.some(
        (entry) =>
          entry.reservationKey === reservation.reservationKey &&
          entry.kind === 'model_usage' &&
          entry.modelCallId === undefined &&
          entry.sequence > opening.sequence
      )
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
    const charges = matching.filter((entry) => entry.kind === 'model_usage')
    const releases = matching.filter((entry) => entry.kind === 'model_release')
    if (hold.status === 'open') {
      if (charges.length !== 0 || releases.length !== 0) throw usageError('STORE_STATE_INVALID')
    } else {
      const charge = charges[0]
      const release = releases[0]
      if (
        charges.length !== 1 ||
        releases.length !== 1 ||
        !charge ||
        !release ||
        charge.quantity.unit !== 'tokens' ||
        charge.quantity.value !== hold.chargedTokens ||
        charge.costMicrounits !== hold.chargedMicrounits ||
        charge.sequence <= opening.sequence ||
        release.quantity.unit !== 'microunits' ||
        release.quantity.value !== hold.maximumMicrounits - hold.chargedMicrounits ||
        release.costMicrounits !== 0 ||
        release.sequence <= charge.sequence
      )
        throw usageError('STORE_STATE_INVALID')
    }
  }
}

function calculateTotals(budget: DurableUsageBudget): {
  spentMicrounits: number
  reservedMicrounits: number
  availableMicrounits: number
  spentTokens: number
  reservedTokens: number
  availableTokens: number
} {
  let spentMicrounits = 0
  let reservedMicrounits = 0
  let spentTokens = 0
  let reservedTokens = 0
  for (const reservation of budget.reservations) {
    spentMicrounits = safeAddOrThrow(
      spentMicrounits,
      reservation.chargedMicrounits,
      'STORE_STATE_INVALID'
    )
    spentTokens = safeAddOrThrow(spentTokens, reservation.chargedTokens, 'STORE_STATE_INVALID')
    if (reservation.status === 'open') {
      reservedMicrounits = safeAddOrThrow(
        reservedMicrounits,
        reservation.maximumMicrounits - reservation.chargedMicrounits,
        'STORE_STATE_INVALID'
      )
      reservedTokens = safeAddOrThrow(
        reservedTokens,
        reservation.maximumTokens - reservation.chargedTokens,
        'STORE_STATE_INVALID'
      )
    }
  }
  const availableMicrounits = budget.maximumMicrounits - spentMicrounits - reservedMicrounits
  const availableTokens = budget.maximumTokens - spentTokens - reservedTokens
  if (availableMicrounits < 0 || availableTokens < 0) throw usageError('STORE_STATE_INVALID')
  return {
    spentMicrounits,
    reservedMicrounits,
    availableMicrounits,
    spentTokens,
    reservedTokens,
    availableTokens,
  }
}

function calculateSummary(budget: DurableUsageBudget): DurableUsageBudgetSummary {
  return {
    executionId: budget.executionId,
    currency: budget.currency,
    maximumMicrounits: budget.maximumMicrounits,
    maximumTokens: budget.maximumTokens,
    ...calculateTotals(budget),
    settled: budget.status === 'settled',
  }
}

function mutableBudget(budget: DurableUsageBudget): DurableUsageBudget {
  const parsed = DurableUsageBudgetSchema.safeParse(budget)
  if (!parsed.success) throw usageError('STORE_STATE_INVALID')
  return {
    ...parsed.data,
    reservations: parsed.data.reservations.map((reservation) => ({ ...reservation })),
  }
}

function safeAddOrThrow(
  left: number,
  right: number,
  code: 'BUDGET_EXHAUSTED' | 'STORE_STATE_INVALID'
): number {
  const result = left + right
  if (!Number.isSafeInteger(result) || result < 0) throw usageError(code)
  return result
}

function fingerprintFor(method: string, input: unknown): string {
  const payload = stableStringify({ method, input })
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`
}

/** Canonical opening-credit identity for admission verification; not a new effect. */
export function budgetOpeningEntryIdempotencyKey(
  operationIdempotencyKey: string,
  executionId: string
): string {
  return entryIdempotencyKey(operationIdempotencyKey, executionId, 'openBudget', 'credit', 0)
}

function entryIdempotencyKey(
  operationKey: string,
  executionId: string,
  operation: string,
  kind: string,
  ordinal: number
): string {
  const payload = stableStringify({ operationKey, executionId, operation, kind, ordinal })
  const digest = createHash('sha256').update(payload).digest('hex')
  return `usage:${digest}`
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw usageError('INVALID_ENTRY')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    const properties = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .toSorted(compareCodePointOrder)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    return `{${properties.join(',')}}`
  }
  throw usageError('INVALID_ENTRY')
}

function createEntryId(): string {
  let value = BigInt(`0x${randomBytes(16).toString('hex')}`)
  let encoded = ''
  for (let index = 0; index < 26; index += 1) {
    encoded = `${EntryAlphabet[Number(value & 31n)]}${encoded}`
    value >>= 5n
  }
  return `usg_${encoded}`
}

function cloneEntry(entry: UsageLedgerEntry): UsageLedgerEntry {
  const parsed = UsageLedgerEntrySchema.safeParse(entry)
  if (!parsed.success) throw usageError('STORE_STATE_INVALID')
  return parsed.data
}

function assertEffectScope(
  effect: DurableUsageEffect,
  workspaceId: string,
  idempotencyKey: string
): void {
  if (effect.workspaceId !== workspaceId || effect.idempotencyKey !== idempotencyKey) {
    throw usageError('STORE_STATE_INVALID')
  }
}

function assertResultExecution(result: unknown, executionId: string): void {
  if (result === null || typeof result !== 'object') throw usageError('STORE_STATE_INVALID')
  const record = result as Record<string, unknown>
  if (record['executionId'] !== undefined && record['executionId'] !== executionId) {
    throw usageError('STORE_STATE_INVALID')
  }
  const settlement = record['settlement']
  if (
    settlement !== undefined &&
    (settlement === null ||
      typeof settlement !== 'object' ||
      (settlement as Record<string, unknown>)['executionId'] !== executionId)
  ) {
    throw usageError('STORE_STATE_INVALID')
  }
}

function assertReplayEntries(
  result: unknown,
  immutableEntries: readonly UsageLedgerEntry[],
  identity: ReplayIdentity
): void {
  if (result === null || typeof result !== 'object') throw usageError('STORE_STATE_INVALID')
  const record = result as Record<string, unknown>
  const candidates: Array<{ candidate: unknown; kind: string; ordinal: number }> = []
  if (record['entryId'] !== undefined) {
    if (identity.operation === 'reserve') {
      candidates.push({ candidate: result, kind: 'reservation', ordinal: 0 })
    } else if (identity.operation === 'reserveModelRequest') {
      candidates.push({ candidate: result, kind: 'model_reservation', ordinal: 0 })
    } else if (identity.operation === 'settleModelRequest') {
      candidates.push({ candidate: result, kind: 'model_usage', ordinal: 0 })
    } else if (identity.operation === 'charge' && identity.kind !== undefined) {
      candidates.push({ candidate: result, kind: identity.kind, ordinal: 0 })
    } else {
      throw usageError('STORE_STATE_INVALID')
    }
  }
  if (record['settlement'] !== undefined) {
    if (identity.operation !== 'settle') throw usageError('STORE_STATE_INVALID')
    candidates.push({ candidate: record['settlement'], kind: 'settlement', ordinal: 1 })
  }
  for (const { candidate, kind, ordinal } of candidates) {
    const parsed = UsageLedgerEntrySchema.safeParse(candidate)
    if (!parsed.success) throw usageError('STORE_STATE_INVALID')
    const expectedKey = entryIdempotencyKey(
      identity.operationKey,
      identity.executionId,
      identity.operation,
      kind,
      ordinal
    )
    const stored = immutableEntries.filter((entry) => entry.source.idempotencyKey === expectedKey)
    if (
      stored.length !== 1 ||
      parsed.data.source.idempotencyKey !== expectedKey ||
      parsed.data.source.sourceId !== identity.sourceId ||
      parsed.data.kind !== kind ||
      (identity.reservationKey !== undefined &&
        parsed.data.reservationKey !== identity.reservationKey) ||
      (identity.modelCallId !== undefined && parsed.data.modelCallId !== identity.modelCallId) ||
      stableStringify(stored[0]) !== stableStringify(parsed.data)
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
  }

  if (identity.operation === 'settle') {
    const releaseKey = entryIdempotencyKey(
      identity.operationKey,
      identity.executionId,
      identity.operation,
      'release',
      0
    )
    const releases = immutableEntries.filter((entry) => entry.source.idempotencyKey === releaseKey)
    const release = releases[0]
    const settlement = record['settlement']
    if (
      releases.length !== 1 ||
      identity.reservationKey === undefined ||
      settlement === null ||
      typeof settlement !== 'object' ||
      release?.kind !== 'release' ||
      release.source.sourceId !== identity.sourceId ||
      release.reservationKey !== identity.reservationKey ||
      release.quantity.unit !== 'microunits' ||
      release.quantity.value !== record['releasedMicrounits']
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
  }
  if (identity.operation === 'settleModelRequest') {
    const releaseKey = entryIdempotencyKey(
      identity.operationKey,
      identity.executionId,
      identity.operation,
      'model_release',
      1
    )
    const releases = immutableEntries.filter((entry) => entry.source.idempotencyKey === releaseKey)
    const release = releases[0]
    if (
      releases.length !== 1 ||
      !release ||
      release.kind !== 'model_release' ||
      release.source.sourceId !== identity.sourceId ||
      release.modelCallId !== identity.modelCallId ||
      release.reservationKey !== identity.reservationKey
    )
      throw usageError('STORE_STATE_INVALID')
  }
}

function assertReplaySummary(
  result: unknown,
  loaded: LoadedBudget,
  identity: ReplayIdentity
): void {
  if (identity.operation !== 'openBudget' && identity.operation !== 'finalizeBudget') return
  const parsed = BudgetSummarySchema.safeParse(result)
  if (!parsed.success) throw usageError('STORE_STATE_INVALID')

  const { budget, entries } = loaded
  let expected: DurableUsageBudgetSummary
  if (identity.operation === 'openBudget') {
    // Opening is a historical zero-usage snapshot, not a projection of today's budget.
    // Future extensions must preserve original opened money/token authority separately;
    // replay must never substitute extended maxima for the opening maxima.
    const creditKey = entryIdempotencyKey(
      identity.operationKey,
      identity.executionId,
      identity.operation,
      'credit',
      0
    )
    const credits = entries.filter((entry) => entry.source.idempotencyKey === creditKey)
    const credit = credits[0]
    if (
      credits.length !== 1 ||
      !credit ||
      credit.sequence !== 1 ||
      credit.kind !== 'credit' ||
      credit.source.sourceId !== identity.sourceId ||
      credit.quantity.unit !== 'microunits' ||
      credit.quantity.value !== budget.maximumMicrounits ||
      credit.currency !== budget.currency ||
      credit.fundingSource !== 'hq_managed' ||
      credit.costMicrounits !== 0 ||
      !credit.costExact ||
      credit.reservationKey !== undefined
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
    expected = {
      executionId: budget.executionId,
      currency: budget.currency,
      maximumMicrounits: credit.quantity.value,
      maximumTokens: budget.maximumTokens,
      spentMicrounits: 0,
      reservedMicrounits: 0,
      availableMicrounits: credit.quantity.value,
      spentTokens: 0,
      reservedTokens: 0,
      availableTokens: budget.maximumTokens,
      settled: false,
    }
  } else {
    if (budget.status !== 'settled') throw usageError('STORE_STATE_INVALID')
    // A settled local budget is immutable; loading validated its ledger and child rollups,
    // so later parent activity does not change this operation's final summary.
    expected = calculateSummary(budget)
    const settlementKey = entryIdempotencyKey(
      identity.operationKey,
      identity.executionId,
      identity.operation,
      'settlement',
      0
    )
    const settlements = entries.filter((entry) => entry.source.idempotencyKey === settlementKey)
    const settlement = settlements[0]
    if (
      settlements.length !== 1 ||
      !settlement ||
      settlement.sequence !== budget.nextSequence - 1 ||
      settlement.kind !== 'settlement' ||
      settlement.source.sourceId !== identity.sourceId ||
      settlement.reservationKey !== undefined ||
      settlement.quantity.unit !== 'microunits' ||
      settlement.quantity.value !== expected.spentMicrounits ||
      settlement.currency !== budget.currency ||
      settlement.fundingSource !== 'hq_managed' ||
      settlement.costMicrounits !== 0 ||
      !settlement.costExact
    ) {
      throw usageError('STORE_STATE_INVALID')
    }
  }

  if (stableStringify(parsed.data) !== stableStringify(expected)) {
    throw usageError('STORE_STATE_INVALID')
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function usageError(code: ConstructorParameters<typeof DurableUsageError>[0]): DurableUsageError {
  return new DurableUsageError(code)
}

function isUsageError(
  error: unknown,
  code: ConstructorParameters<typeof DurableUsageError>[0]
): boolean {
  return error instanceof DurableUsageError && error.code === code
}
