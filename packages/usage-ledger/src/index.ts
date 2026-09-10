import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const SourceSchema = z
  .object({
    sourceId: z.string().min(1).max(256),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict()

const MoneySchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    maximumMicrounits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

export const UsageLedgerEntrySchema = z
  .object({
    entryId: z.string().regex(/^usg_[0-9A-HJKMNP-TV-Z]{26}$/),
    sequence: z.number().int().positive(),
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId.optional(),
    parentExecutionId: IdentifierSchemas.executionId.optional(),
    kind: z.enum([
      'reservation',
      'model_usage',
      'tool_charge',
      'sandbox_usage',
      'adjustment',
      'release',
      'settlement',
      'refund',
      'credit',
    ]),
    source: SourceSchema,
    reservationKey: z.string().min(1).max(256).optional(),
    fundingSource: z.enum(['hq_managed', 'external_subscription']),
    quantity: z
      .object({
        unit: z.enum(['tokens', 'calls', 'milliseconds', 'bytes', 'microunits']),
        value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    costMicrounits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    costExact: z.boolean(),
    authorizationDecisionId: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    recordedAt: z.iso.datetime(),
  })
  .strict()

export type UsageLedgerEntry = z.output<typeof UsageLedgerEntrySchema>

export type UsageLedgerAppendResult =
  | { readonly outcome: 'created'; readonly entry: UsageLedgerEntry }
  | { readonly outcome: 'duplicate'; readonly entry: UsageLedgerEntry }
  | { readonly outcome: 'conflict'; readonly entry: UsageLedgerEntry }

export interface UsageLedgerRepository {
  append(entry: UsageLedgerEntry): Promise<UsageLedgerAppendResult>
  list(workspaceId: string, executionId: string): Promise<readonly UsageLedgerEntry[]>
}

export function usageEntriesShareIdentity(
  left: UsageLedgerEntry,
  right: UsageLedgerEntry
): boolean {
  return (
    stableStringify({ ...left, entryId: undefined, sequence: undefined, recordedAt: undefined }) ===
    stableStringify({ ...right, entryId: undefined, sequence: undefined, recordedAt: undefined })
  )
}

export class UsageLedgerError extends Error {
  constructor(
    readonly code:
      | 'INVALID_ENTRY'
      | 'BUDGET_NOT_FOUND'
      | 'BUDGET_EXISTS'
      | 'BUDGET_EXHAUSTED'
      | 'RESERVATION_NOT_FOUND'
      | 'RESERVATION_SETTLED'
      | 'IDEMPOTENCY_CONFLICT'
  ) {
    super(code)
    this.name = 'UsageLedgerError'
  }
}

interface ReservationProjection {
  maximumMicrounits: number
  chargedMicrounits: number
  settled: boolean
}

interface BudgetProjection {
  readonly workspaceId: string
  readonly executionId: string
  readonly parentExecutionId?: string
  readonly currency: string
  maximumMicrounits: number
  maximumTokens: number
  readonly reservations: Map<string, ReservationProjection>
  settled: boolean
}

interface StoredEffect {
  readonly digest: string
  readonly entry: UsageLedgerEntry
}

export class InMemoryUsageLedger {
  readonly #now: () => string
  readonly #budgets = new Map<string, BudgetProjection>()
  readonly #entries = new Map<string, UsageLedgerEntry[]>()
  readonly #effects = new Map<string, StoredEffect>()
  #sequence = 0

  constructor(options: { readonly now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  openBudget(input: {
    readonly workspaceId: string
    readonly executionId: string
    readonly parentExecutionId?: string
    readonly currency: string
    readonly maximumMicrounits: number
    readonly maximumTokens?: number
    readonly source: z.output<typeof SourceSchema>
  }): Readonly<ReturnType<InMemoryUsageLedger['summary']>> {
    const parsed = z
      .object({
        workspaceId: IdentifierSchemas.workspaceId,
        executionId: IdentifierSchemas.executionId,
        parentExecutionId: IdentifierSchemas.executionId.optional(),
        currency: MoneySchema.shape.currency,
        maximumMicrounits: MoneySchema.shape.maximumMicrounits,
        maximumTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        source: SourceSchema,
      })
      .strict()
      .safeParse(input)
    if (!parsed.success) throw new UsageLedgerError('INVALID_ENTRY')
    if (this.#budgets.has(parsed.data.executionId)) throw new UsageLedgerError('BUDGET_EXISTS')

    let maximumMicrounits = parsed.data.maximumMicrounits
    let maximumTokens = parsed.data.maximumTokens ?? Number.MAX_SAFE_INTEGER
    if (parsed.data.parentExecutionId !== undefined) {
      const parent = this.#budget(parsed.data.parentExecutionId)
      if (parent.workspaceId !== parsed.data.workspaceId) {
        throw new UsageLedgerError('BUDGET_NOT_FOUND')
      }
      if (parent.currency !== parsed.data.currency) throw new UsageLedgerError('INVALID_ENTRY')
      maximumMicrounits = Math.min(maximumMicrounits, available(parent))
      maximumTokens = Math.min(
        maximumTokens,
        parent.maximumTokens - usedTokens(parent.executionId, this.#entries)
      )
      if (maximumMicrounits <= 0) throw new UsageLedgerError('BUDGET_EXHAUSTED')
      this.reserve({
        workspaceId: parsed.data.workspaceId,
        executionId: parent.executionId,
        reservationKey: `child:${parsed.data.executionId}`,
        maximumMicrounits,
        source: parsed.data.source,
      })
    }
    this.#budgets.set(parsed.data.executionId, {
      workspaceId: parsed.data.workspaceId,
      executionId: parsed.data.executionId,
      ...(parsed.data.parentExecutionId === undefined
        ? {}
        : { parentExecutionId: parsed.data.parentExecutionId }),
      currency: parsed.data.currency,
      maximumMicrounits,
      maximumTokens,
      reservations: new Map(),
      settled: false,
    })
    return this.summary(parsed.data.workspaceId, parsed.data.executionId)
  }

  reserve(input: {
    readonly workspaceId: string
    readonly executionId: string
    readonly attemptId?: string
    readonly reservationKey: string
    readonly maximumMicrounits: number
    readonly source: z.output<typeof SourceSchema>
  }): UsageLedgerEntry {
    const budget = this.#budget(input.executionId)
    if (budget.workspaceId !== input.workspaceId) throw new UsageLedgerError('BUDGET_NOT_FOUND')
    const existing = budget.reservations.get(input.reservationKey)
    if (existing) {
      return this.#duplicateOrConflict(input.workspaceId, input.source, input)
    }
    if (input.maximumMicrounits > available(budget)) throw new UsageLedgerError('BUDGET_EXHAUSTED')
    const entry = this.#append(
      {
        workspaceId: input.workspaceId,
        executionId: input.executionId,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        reservationKey: input.reservationKey,
        source: input.source,
        kind: 'reservation',
        fundingSource: 'hq_managed',
        quantity: { unit: 'microunits', value: input.maximumMicrounits },
        currency: budget.currency,
        costMicrounits: input.maximumMicrounits,
        costExact: true,
      },
      input
    )
    budget.reservations.set(input.reservationKey, {
      maximumMicrounits: input.maximumMicrounits,
      chargedMicrounits: 0,
      settled: false,
    })
    return entry
  }

  charge(input: {
    readonly workspaceId: string
    readonly executionId: string
    readonly attemptId: string
    readonly reservationKey: string
    readonly kind: 'model_usage' | 'tool_charge' | 'sandbox_usage'
    readonly source: z.output<typeof SourceSchema>
    readonly quantity: {
      readonly unit: 'tokens' | 'calls' | 'milliseconds' | 'bytes'
      readonly value: number
    }
    readonly costMicrounits: number
    readonly fundingSource: 'hq_managed' | 'external_subscription'
  }): UsageLedgerEntry {
    const budget = this.#budget(input.executionId)
    if (budget.workspaceId !== input.workspaceId) throw new UsageLedgerError('BUDGET_NOT_FOUND')
    const prior = this.#effect(input.workspaceId, input.source)
    if (prior) return this.#assertDuplicate(prior, input)
    const reservation = this.#reservation(budget, input.reservationKey)
    if (reservation.settled) throw new UsageLedgerError('RESERVATION_SETTLED')
    if (input.fundingSource === 'external_subscription' && input.costMicrounits !== 0) {
      throw new UsageLedgerError('INVALID_ENTRY')
    }
    if (
      !Number.isSafeInteger(input.costMicrounits) ||
      input.costMicrounits < 0 ||
      reservation.chargedMicrounits + input.costMicrounits > reservation.maximumMicrounits
    ) {
      throw new UsageLedgerError('BUDGET_EXHAUSTED')
    }
    if (
      input.quantity.unit === 'tokens' &&
      usedTokens(input.executionId, this.#entries) + input.quantity.value > budget.maximumTokens
    ) {
      throw new UsageLedgerError('BUDGET_EXHAUSTED')
    }
    const entry = this.#append(
      {
        ...input,
        currency: budget.currency,
        costExact: input.fundingSource === 'hq_managed',
      },
      input
    )
    reservation.chargedMicrounits += input.costMicrounits
    return entry
  }

  extendBudget(input: {
    readonly workspaceId: string
    readonly executionId: string
    readonly additionalMicrounits: number
    readonly authorizationDecisionId: string
    readonly source: z.output<typeof SourceSchema>
  }): UsageLedgerEntry {
    const budget = this.#budget(input.executionId)
    if (budget.workspaceId !== input.workspaceId) throw new UsageLedgerError('BUDGET_NOT_FOUND')
    const prior = this.#effect(input.workspaceId, input.source)
    if (prior) return this.#assertDuplicate(prior, input)
    validatePositiveAmount(input.additionalMicrounits)
    const entry = this.#append(
      {
        workspaceId: budget.workspaceId,
        executionId: budget.executionId,
        kind: 'adjustment',
        source: input.source,
        fundingSource: 'hq_managed',
        quantity: { unit: 'microunits', value: input.additionalMicrounits },
        currency: budget.currency,
        costMicrounits: 0,
        costExact: true,
        authorizationDecisionId: input.authorizationDecisionId,
      },
      input
    )
    budget.maximumMicrounits += input.additionalMicrounits
    return entry
  }

  extendReservation(input: {
    readonly workspaceId: string
    readonly executionId: string
    readonly reservationKey: string
    readonly additionalMicrounits: number
    readonly authorizationDecisionId: string
    readonly source: z.output<typeof SourceSchema>
  }): UsageLedgerEntry {
    const budget = this.#budget(input.executionId)
    if (budget.workspaceId !== input.workspaceId) throw new UsageLedgerError('BUDGET_NOT_FOUND')
    const prior = this.#effect(input.workspaceId, input.source)
    if (prior) return this.#assertDuplicate(prior, input)
    const reservation = this.#reservation(budget, input.reservationKey)
    validatePositiveAmount(input.additionalMicrounits)
    if (reservation.settled) throw new UsageLedgerError('RESERVATION_SETTLED')
    if (input.additionalMicrounits > available(budget))
      throw new UsageLedgerError('BUDGET_EXHAUSTED')
    const entry = this.#append(
      {
        workspaceId: budget.workspaceId,
        executionId: budget.executionId,
        kind: 'adjustment',
        source: input.source,
        reservationKey: input.reservationKey,
        fundingSource: 'hq_managed',
        quantity: { unit: 'microunits', value: input.additionalMicrounits },
        currency: budget.currency,
        costMicrounits: 0,
        costExact: true,
        authorizationDecisionId: input.authorizationDecisionId,
      },
      input
    )
    reservation.maximumMicrounits += input.additionalMicrounits
    return entry
  }

  settle(input: {
    readonly workspaceId: string
    readonly executionId: string
    readonly reservationKey: string
    readonly source: z.output<typeof SourceSchema>
  }): { readonly releasedMicrounits: number; readonly settlement: UsageLedgerEntry } {
    const budget = this.#budget(input.executionId)
    if (budget.workspaceId !== input.workspaceId) throw new UsageLedgerError('BUDGET_NOT_FOUND')
    const reservation = this.#reservation(budget, input.reservationKey)
    const releasedMicrounits = reservation.maximumMicrounits - reservation.chargedMicrounits
    const prior = this.#effect(input.workspaceId, input.source)
    if (prior) {
      return {
        releasedMicrounits,
        settlement: this.#assertDuplicate(prior, input),
      }
    }
    if (reservation.settled) throw new UsageLedgerError('RESERVATION_SETTLED')
    this.#append(
      {
        workspaceId: budget.workspaceId,
        executionId: budget.executionId,
        kind: 'release',
        source: { ...input.source, idempotencyKey: `${input.source.idempotencyKey}:release` },
        reservationKey: input.reservationKey,
        fundingSource: 'hq_managed',
        quantity: { unit: 'microunits', value: releasedMicrounits },
        currency: budget.currency,
        costMicrounits: releasedMicrounits,
        costExact: true,
      },
      { ...input, phase: 'release' }
    )
    const settlement = this.#append(
      {
        workspaceId: budget.workspaceId,
        executionId: budget.executionId,
        kind: 'settlement',
        source: input.source,
        reservationKey: input.reservationKey,
        fundingSource: 'hq_managed',
        quantity: { unit: 'microunits', value: reservation.chargedMicrounits },
        currency: budget.currency,
        costMicrounits: 0,
        costExact: true,
      },
      input
    )
    reservation.settled = true
    budget.settled = [...budget.reservations.values()].every((value) => value.settled)
    return { releasedMicrounits, settlement }
  }

  entries(workspaceId: string, executionId: string): readonly UsageLedgerEntry[] {
    this.#assertWorkspace(workspaceId, executionId)
    return (this.#entries.get(executionId) ?? []).map((entry) => entry)
  }

  summary(
    workspaceId: string,
    executionId: string
  ): {
    readonly executionId: string
    readonly currency: string
    readonly maximumMicrounits: number
    readonly maximumTokens: number
    readonly spentMicrounits: number
    readonly reservedMicrounits: number
    readonly availableMicrounits: number
    readonly settled: boolean
  } {
    const budget = this.#budget(executionId)
    if (budget.workspaceId !== workspaceId) throw new UsageLedgerError('BUDGET_NOT_FOUND')
    const spentMicrounits = spent(budget)
    const reservedMicrounits = reserved(budget)
    return deepFreeze({
      executionId,
      currency: budget.currency,
      maximumMicrounits: budget.maximumMicrounits,
      maximumTokens: budget.maximumTokens,
      spentMicrounits,
      reservedMicrounits,
      availableMicrounits: budget.maximumMicrounits - spentMicrounits - reservedMicrounits,
      settled: budget.settled,
    })
  }

  publicSummary(
    workspaceId: string,
    executionId: string
  ): {
    readonly executionId: string
    readonly currency: string
    readonly funding: {
      readonly hqManagedMicrounits: number
      readonly externalSubscriptionEffects: number
    }
    readonly usage: Readonly<Record<string, number>>
    readonly settled: boolean
  } {
    const budget = this.#budget(executionId)
    if (budget.workspaceId !== workspaceId) throw new UsageLedgerError('BUDGET_NOT_FOUND')
    const billable = (this.#entries.get(executionId) ?? []).filter((entry) =>
      ['model_usage', 'tool_charge', 'sandbox_usage'].includes(entry.kind)
    )
    const usage: Record<string, number> = {}
    let hqManagedMicrounits = 0
    let externalSubscriptionEffects = 0
    for (const entry of billable) {
      usage[entry.quantity.unit] = (usage[entry.quantity.unit] ?? 0) + entry.quantity.value
      if (entry.fundingSource === 'hq_managed') hqManagedMicrounits += entry.costMicrounits
      else externalSubscriptionEffects += 1
    }
    return deepFreeze({
      executionId,
      currency: budget.currency,
      funding: { hqManagedMicrounits, externalSubscriptionEffects },
      usage,
      settled: budget.settled,
    })
  }

  #assertWorkspace(workspaceId: string, executionId: string): void {
    const budget = this.#budget(executionId)
    if (budget.workspaceId !== workspaceId) throw new UsageLedgerError('BUDGET_NOT_FOUND')
  }

  #budget(executionId: string): BudgetProjection {
    const budget = this.#budgets.get(executionId)
    if (!budget) throw new UsageLedgerError('BUDGET_NOT_FOUND')
    return budget
  }

  #reservation(budget: BudgetProjection, key: string): ReservationProjection {
    const reservation = budget.reservations.get(key)
    if (!reservation) throw new UsageLedgerError('RESERVATION_NOT_FOUND')
    return reservation
  }

  #effect(workspaceId: string, source: z.output<typeof SourceSchema>): StoredEffect | undefined {
    return this.#effects.get(`${workspaceId}:${source.idempotencyKey}`)
  }

  #duplicateOrConflict(
    workspaceId: string,
    source: z.output<typeof SourceSchema>,
    identity: unknown
  ): UsageLedgerEntry {
    const prior = this.#effect(workspaceId, source)
    if (!prior) throw new UsageLedgerError('IDEMPOTENCY_CONFLICT')
    return this.#assertDuplicate(prior, identity)
  }

  #assertDuplicate(prior: StoredEffect, identity: unknown): UsageLedgerEntry {
    if (prior.digest !== stableStringify(identity))
      throw new UsageLedgerError('IDEMPOTENCY_CONFLICT')
    return prior.entry
  }

  #append(
    value: Record<string, unknown> & {
      readonly source: z.output<typeof SourceSchema>
      readonly workspaceId: string
    },
    identity: unknown
  ): UsageLedgerEntry {
    const prior = this.#effect(value.workspaceId, value.source)
    if (prior) return this.#assertDuplicate(prior, identity)
    this.#sequence += 1
    const entry = UsageLedgerEntrySchema.safeParse({
      ...value,
      entryId: `usg_${this.#sequence.toString(32).padStart(26, '0').toUpperCase()}`,
      sequence: this.#sequence,
      recordedAt: this.#now(),
    })
    if (!entry.success) throw new UsageLedgerError('INVALID_ENTRY')
    const frozen = deepFreeze(entry.data)
    const list = this.#entries.get(frozen.executionId) ?? []
    list.push(frozen)
    this.#entries.set(frozen.executionId, list)
    this.#effects.set(`${frozen.workspaceId}:${frozen.source.idempotencyKey}`, {
      digest: stableStringify(identity),
      entry: frozen,
    })
    return frozen
  }
}

function spent(budget: BudgetProjection): number {
  return [...budget.reservations.values()].reduce(
    (total, item) => total + item.chargedMicrounits,
    0
  )
}

function reserved(budget: BudgetProjection): number {
  return [...budget.reservations.values()].reduce(
    (total, item) => total + (item.settled ? 0 : item.maximumMicrounits - item.chargedMicrounits),
    0
  )
}

function available(budget: BudgetProjection): number {
  return budget.maximumMicrounits - spent(budget) - reserved(budget)
}

function usedTokens(
  executionId: string,
  entries: ReadonlyMap<string, readonly UsageLedgerEntry[]>
): number {
  return (entries.get(executionId) ?? [])
    .filter((entry) => entry.kind === 'model_usage' && entry.quantity.unit === 'tokens')
    .reduce((total, entry) => total + entry.quantity.value, 0)
}

function validatePositiveAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new UsageLedgerError('INVALID_ENTRY')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
