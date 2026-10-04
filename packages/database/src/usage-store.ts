import {
  DurableUsageBudgetSchema,
  DurableUsageEffectSchema,
  DurableUsageError,
  type DurableUsageBudget,
  type DurableUsageEffect,
  type DurableUsageStore,
  type DurableUsageTransaction,
} from '@control-plane/usage-ledger/durable-contract'
import { UsageLedgerEntrySchema, type UsageLedgerEntry } from '@control-plane/usage-ledger'
import { IdentifierSchemas } from '@control-plane/contracts'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { fromAttemptRow, fromExecutionRow } from './execution-repository.js'
import type { DomainTransaction } from './transaction.js'
import { acquirePostgresRetentionHoldClassMutex } from './retention-hold-repository.js'
import { executionAttempts, executions } from './schema/executions.js'
import { usageBudgetStates, usageOperationReceipts } from './schema/usage-budget-state.js'
import { fromUsageLedgerRow, toUsageLedgerRow } from './usage-ledger-repository.js'
import { usageLedgerEntries } from './schema/usage-ledger.js'

type BudgetStateRow = typeof usageBudgetStates.$inferSelect
type EffectReceiptRow = typeof usageOperationReceipts.$inferSelect

/** Convert a state row only when its indexed identity agrees with its payload. */
export function fromUsageBudgetStateRow(row: BudgetStateRow): DurableUsageBudget {
  const parsed = DurableUsageBudgetSchema.safeParse(row.state)
  if (
    !parsed.success ||
    row.schemaVersion !== 1 ||
    parsed.data.schemaVersion !== row.schemaVersion ||
    parsed.data.workspaceId !== row.workspaceId ||
    parsed.data.executionId !== row.executionId ||
    (parsed.data.parentExecutionId ?? null) !== row.parentExecutionId
  ) {
    throw storeStateInvalid()
  }
  return parsed.data
}

export function toUsageBudgetStateRow(
  budgetInput: DurableUsageBudget
): typeof usageBudgetStates.$inferInsert {
  const parsed = DurableUsageBudgetSchema.safeParse(budgetInput)
  if (!parsed.success) throw usageError('INVALID_ENTRY')
  return {
    executionId: parsed.data.executionId,
    workspaceId: parsed.data.workspaceId,
    parentExecutionId: parsed.data.parentExecutionId ?? null,
    schemaVersion: parsed.data.schemaVersion,
    state: parsed.data,
  }
}

/** Convert a receipt only when its scalar indexes agree with immutable JSON. */
export function fromUsageEffectReceiptRow(row: EffectReceiptRow): DurableUsageEffect {
  const parsed = DurableUsageEffectSchema.safeParse(row.receipt)
  if (
    !parsed.success ||
    row.schemaVersion !== 1 ||
    parsed.data.schemaVersion !== row.schemaVersion ||
    parsed.data.workspaceId !== row.workspaceId ||
    parsed.data.executionId !== row.executionId ||
    parsed.data.idempotencyKey !== row.idempotencyKey ||
    parsed.data.fingerprint !== row.fingerprint
  ) {
    throw storeStateInvalid()
  }
  return parsed.data
}

export function toUsageEffectReceiptRow(
  effectInput: DurableUsageEffect
): typeof usageOperationReceipts.$inferInsert {
  const parsed = DurableUsageEffectSchema.safeParse(effectInput)
  if (!parsed.success) throw usageError('INVALID_ENTRY')
  return {
    workspaceId: parsed.data.workspaceId,
    idempotencyKey: parsed.data.idempotencyKey,
    executionId: parsed.data.executionId,
    fingerprint: parsed.data.fingerprint,
    schemaVersion: parsed.data.schemaVersion,
    receipt: parsed.data,
  }
}

/**
 * PostgreSQL implementation of the durable usage store. The class-wide
 * retention mutex is deliberately acquired before the workspace lock and all
 * row locks; READ COMMITTED ensures a retry sees the winner after waiting.
 */
export class PostgresDurableUsageStore implements DurableUsageStore {
  constructor(readonly database: ControlPlaneDatabase) {}

  static async acquireTransactionLocks(
    transaction: DomainTransaction,
    workspaceIdInput: string
  ): Promise<void> {
    const workspaceId = IdentifierSchemas.workspaceId.safeParse(workspaceIdInput)
    if (!workspaceId.success) throw usageError('INVALID_ENTRY')
    await acquirePostgresRetentionHoldClassMutex(transaction, 'executions')
    await transaction.execute(
      // A separate namespace keeps this lock independent from the retention class lock.
      sql`select pg_advisory_xact_lock(hashtextextended(${`usage-ledger:workspace:${workspaceId.data}`}, 0))`
    )
  }

  static async withTransaction<Result>(
    transaction: DomainTransaction,
    workspaceIdInput: string,
    operation: (store: DurableUsageStore) => Promise<Result>
  ): Promise<Result> {
    const workspaceId = IdentifierSchemas.workspaceId.safeParse(workspaceIdInput)
    if (!workspaceId.success) throw usageError('INVALID_ENTRY')
    await PostgresDurableUsageStore.acquireTransactionLocks(transaction, workspaceId.data)
    const lease = new PostgresUsageStoreLease()
    let result: Result
    let invalid = false
    try {
      result = await operation(
        new BoundPostgresDurableUsageStore(transaction, workspaceId.data, lease)
      )
    } finally {
      invalid = await lease.revokeAndDrain()
    }
    if (invalid) throw storeStateInvalid()
    return result
  }

  async transaction<Result>(
    workspaceIdInput: string,
    operation: (transaction: DurableUsageTransaction) => Promise<Result>
  ): Promise<Result> {
    const workspaceId = IdentifierSchemas.workspaceId.safeParse(workspaceIdInput)
    if (!workspaceId.success) throw usageError('INVALID_ENTRY')

    return this.database.transaction(
      async (transaction) => {
        await PostgresDurableUsageStore.acquireTransactionLocks(transaction, workspaceId.data)
        const lease = new PostgresUsageStoreLease()
        let result: Result
        let invalid = false
        try {
          result = await operation(
            leasePostgresUsageTransaction(
              new PostgresDurableUsageTransaction(transaction, workspaceId.data),
              lease
            )
          )
        } finally {
          invalid = await lease.revokeAndDrain()
        }
        if (invalid) throw storeStateInvalid()
        return result
      },
      { accessMode: 'read write', deferrable: false, isolationLevel: 'read committed' }
    )
  }
}

class BoundPostgresDurableUsageStore implements DurableUsageStore {
  #active = false
  readonly #existingTransaction: DomainTransaction
  readonly #workspaceId: string
  readonly #lease: PostgresUsageStoreLease

  constructor(
    existingTransaction: DomainTransaction,
    workspaceId: string,
    lease: PostgresUsageStoreLease
  ) {
    this.#existingTransaction = existingTransaction
    this.#workspaceId = workspaceId
    this.#lease = lease
  }

  transaction<Result>(
    workspaceIdInput: string,
    operation: (transaction: DurableUsageTransaction) => Promise<Result>
  ): Promise<Result> {
    try {
      this.#lease.assertActive()
      const workspaceId = IdentifierSchemas.workspaceId.safeParse(workspaceIdInput)
      if (!workspaceId.success) throw usageError('INVALID_ENTRY')
      if (workspaceId.data !== this.#workspaceId) throw scopeMismatch()
      if (this.#active) throw storeStateInvalid()

      this.#lease.beginOperation()
      this.#active = true
      return observePostgresUsageOperation(this.#runTransaction(operation))
    } catch (error) {
      return observePostgresUsageOperation(Promise.reject(error))
    }
  }

  async #runTransaction<Result>(
    operation: (transaction: DurableUsageTransaction) => Promise<Result>
  ): Promise<Result> {
    const transactionLease = new PostgresUsageStoreLease()
    let result: Result
    let pending = false
    try {
      result = await operation(
        leasePostgresUsageTransaction(
          new PostgresDurableUsageTransaction(this.#existingTransaction, this.#workspaceId),
          this.#lease,
          transactionLease
        )
      )
    } catch (error) {
      this.#lease.poison()
      throw error
    } finally {
      pending = await transactionLease.revokeAndDrain()
      this.#lease.endOperation()
      this.#active = false
      if (pending) {
        this.#lease.poison()
      }
    }
    if (pending) throw storeStateInvalid()
    return result
  }
}

class PostgresUsageStoreLease {
  #active = true
  #poisoned = false
  #pending = 0
  readonly #drainers: Array<() => void> = []

  assertActive(): void {
    if (!this.#active || this.#poisoned) throw storeStateInvalid()
  }

  poison(): void {
    this.#poisoned = true
  }

  beginOperation(): void {
    this.assertActive()
    this.#pending += 1
  }

  endOperation(): void {
    this.#pending -= 1
    if (this.#pending === 0) {
      for (const resolve of this.#drainers.splice(0)) resolve()
    }
  }

  async revokeAndDrain(): Promise<boolean> {
    const hadPendingOperations = this.#pending > 0
    this.#active = false
    if (hadPendingOperations) await new Promise<void>((resolve) => this.#drainers.push(resolve))
    return hadPendingOperations || this.#poisoned
  }
}

function leasePostgresUsageTransaction(
  transaction: DurableUsageTransaction,
  outerLease: PostgresUsageStoreLease,
  operationLease = outerLease
): DurableUsageTransaction {
  return {
    getBudget: (executionId) =>
      runWithPostgresUsageStoreLeases(outerLease, operationLease, () =>
        transaction.getBudget(executionId)
      ),
    putBudget: (budget) =>
      runWithPostgresUsageStoreLeases(outerLease, operationLease, () =>
        transaction.putBudget(budget)
      ),
    getEffect: (idempotencyKey) =>
      runWithPostgresUsageStoreLeases(outerLease, operationLease, () =>
        transaction.getEffect(idempotencyKey)
      ),
    putEffect: (effect) =>
      runWithPostgresUsageStoreLeases(outerLease, operationLease, () =>
        transaction.putEffect(effect)
      ),
    appendEntry: (entry) =>
      runWithPostgresUsageStoreLeases(outerLease, operationLease, () =>
        transaction.appendEntry(entry)
      ),
    listEntries: (executionId) =>
      runWithPostgresUsageStoreLeases(outerLease, operationLease, () =>
        transaction.listEntries(executionId)
      ),
  }
}

function runWithPostgresUsageStoreLeases<Result>(
  outerLease: PostgresUsageStoreLease,
  operationLease: PostgresUsageStoreLease,
  operation: () => Promise<Result>
): Promise<Result> {
  const promise = (async () => {
    outerLease.beginOperation()
    try {
      operationLease.beginOperation()
    } catch (error) {
      outerLease.endOperation()
      throw error
    }
    try {
      const result = await operation()
      outerLease.assertActive()
      operationLease.assertActive()
      return result
    } finally {
      operationLease.endOperation()
      outerLease.endOperation()
    }
  })()
  return observePostgresUsageOperation(promise)
}

function observePostgresUsageOperation<Result>(promise: Promise<Result>): Promise<Result> {
  void promise.catch(() => undefined)
  return promise
}

class PostgresDurableUsageTransaction implements DurableUsageTransaction {
  readonly #owners = new Map<
    string,
    { workspaceId: string; parentExecutionId?: string; latestAttemptId?: string } | null
  >()
  readonly #transaction: DomainTransaction
  readonly #workspaceId: string

  constructor(transaction: DomainTransaction, workspaceId: string) {
    this.#transaction = transaction
    this.#workspaceId = workspaceId
  }

  async getBudget(executionIdInput: string): Promise<DurableUsageBudget | undefined> {
    const executionId = parseExecutionId(executionIdInput)
    const owner = await this.#readOwner(executionId)
    if (!owner || owner.workspaceId !== this.#workspaceId) return undefined

    const [row] = await this.#transaction
      .select()
      .from(usageBudgetStates)
      .where(eq(usageBudgetStates.executionId, executionId))
      .limit(1)
    if (!row) return undefined

    const budget = fromUsageBudgetStateRow(row)
    this.#assertBudgetOwner(budget, owner)
    const entries = await this.#readEntries(executionId)
    assertBudgetHighWater(budget, entries)
    return budget
  }

  async putBudget(budgetInput: DurableUsageBudget): Promise<void> {
    const parsed = DurableUsageBudgetSchema.safeParse(budgetInput)
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    const budget = parsed.data
    if (budget.workspaceId !== this.#workspaceId) throw scopeMismatch()

    const owner = await this.#readOwner(budget.executionId)
    if (!owner || owner.workspaceId !== this.#workspaceId) throw scopeMismatch()
    this.#assertBudgetOwner(budget, owner)
    if (budget.parentExecutionId !== undefined) {
      const parent = await this.#readOwner(budget.parentExecutionId)
      if (!parent || parent.workspaceId !== this.#workspaceId) throw scopeMismatch()
    }

    const [currentRow] = await this.#transaction
      .select()
      .from(usageBudgetStates)
      .where(eq(usageBudgetStates.executionId, budget.executionId))
      .limit(1)
      .for('update')

    if (currentRow) {
      const current = fromUsageBudgetStateRow(currentRow)
      this.#assertBudgetOwner(current, owner)
      if (
        current.workspaceId !== budget.workspaceId ||
        current.executionId !== budget.executionId ||
        (current.parentExecutionId ?? null) !== (budget.parentExecutionId ?? null)
      ) {
        throw scopeMismatch()
      }
      assertBudgetHighWater(current, await this.#readEntries(budget.executionId))
      const [updated] = await this.#transaction
        .update(usageBudgetStates)
        .set({
          workspaceId: budget.workspaceId,
          parentExecutionId: budget.parentExecutionId ?? null,
          schemaVersion: budget.schemaVersion,
          state: budget,
        })
        .where(eq(usageBudgetStates.executionId, budget.executionId))
        .returning({ executionId: usageBudgetStates.executionId })
      if (!updated) throw storeStateInvalid()
      return
    }

    if ((await this.#readEntries(budget.executionId)).length !== 0) throw storeStateInvalid()
    const [inserted] = await this.#transaction
      .insert(usageBudgetStates)
      .values(toUsageBudgetStateRow(budget))
      .onConflictDoNothing()
      .returning({ executionId: usageBudgetStates.executionId })
    if (!inserted) throw storeStateInvalid()
  }

  async getEffect(idempotencyKeyInput: string): Promise<DurableUsageEffect | undefined> {
    const idempotencyKey = parseEffectKey(idempotencyKeyInput)
    const [row] = await this.#transaction
      .select()
      .from(usageOperationReceipts)
      .where(
        and(
          eq(usageOperationReceipts.workspaceId, this.#workspaceId),
          eq(usageOperationReceipts.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1)
    if (!row) return undefined

    const effect = fromUsageEffectReceiptRow(row)
    const owner = await this.#readOwner(effect.executionId)
    if (!owner || owner.workspaceId !== this.#workspaceId) throw storeStateInvalid()
    return effect
  }

  async putEffect(effectInput: DurableUsageEffect): Promise<void> {
    const parsed = DurableUsageEffectSchema.safeParse(effectInput)
    if (!parsed.success) throw usageError('INVALID_ENTRY')
    const effect = parsed.data
    if (effect.workspaceId !== this.#workspaceId) throw scopeMismatch()
    const owner = await this.#readOwner(effect.executionId)
    if (!owner || owner.workspaceId !== this.#workspaceId) throw scopeMismatch()

    const [inserted] = await this.#transaction
      .insert(usageOperationReceipts)
      .values(toUsageEffectReceiptRow(effect))
      .onConflictDoNothing()
      .returning({ idempotencyKey: usageOperationReceipts.idempotencyKey })
    if (inserted) return

    const [row] = await this.#transaction
      .select()
      .from(usageOperationReceipts)
      .where(
        and(
          eq(usageOperationReceipts.workspaceId, this.#workspaceId),
          eq(usageOperationReceipts.idempotencyKey, effect.idempotencyKey)
        )
      )
      .limit(1)
    if (!row) throw storeStateInvalid()
    const existing = fromUsageEffectReceiptRow(row)
    if (canonicalJson(existing) !== canonicalJson(effect)) {
      throw usageError('IDEMPOTENCY_CONFLICT')
    }
  }

  async appendEntry(entryInput: UsageLedgerEntry): Promise<void> {
    const parsed = UsageLedgerEntrySchema.safeParse(entryInput)
    if (!parsed.success || !Number.isSafeInteger(parsed.data.sequence)) {
      throw usageError('INVALID_ENTRY')
    }
    const entry = parsed.data
    if (entry.workspaceId !== this.#workspaceId) throw scopeMismatch()

    const owner = await this.#readOwner(entry.executionId)
    if (!owner || owner.workspaceId !== this.#workspaceId) throw scopeMismatch()
    if (
      entry.kind === 'reservation' &&
      entry.attemptId !== undefined &&
      entry.reservationKey === `runtime-attempt:${entry.attemptId}` &&
      owner.latestAttemptId !== entry.attemptId
    )
      throw scopeMismatch()
    if ((entry.parentExecutionId ?? null) !== (owner.parentExecutionId ?? null)) {
      throw scopeMismatch()
    }
    if (entry.parentExecutionId !== undefined) {
      const parent = await this.#readOwner(entry.parentExecutionId)
      if (!parent || parent.workspaceId !== this.#workspaceId) throw scopeMismatch()
    }
    if (entry.attemptId !== undefined)
      await this.#assertAttemptOwner(entry.attemptId, entry.executionId)

    const [budgetRow] = await this.#transaction
      .select()
      .from(usageBudgetStates)
      .where(eq(usageBudgetStates.executionId, entry.executionId))
      .limit(1)
      .for('update')
    if (!budgetRow) throw storeStateInvalid()
    const budget = fromUsageBudgetStateRow(budgetRow)
    this.#assertBudgetOwner(budget, owner)

    const currentEntries = await this.#readEntries(entry.executionId)
    const duplicate = currentEntries.find(
      (existing) => existing.source.idempotencyKey === entry.source.idempotencyKey
    )
    if (duplicate) {
      if (canonicalJson(duplicate) !== canonicalJson(entry)) {
        throw usageError('IDEMPOTENCY_CONFLICT')
      }
      return
    }

    if (
      entry.sequence !== currentEntries.length + 1 ||
      entry.sequence >= budget.nextSequence ||
      entry.currency !== budget.currency
    ) {
      throw storeStateInvalid()
    }

    const [inserted] = await this.#transaction
      .insert(usageLedgerEntries)
      .values(toUsageLedgerRow(entry))
      .onConflictDoNothing()
      .returning({ entryId: usageLedgerEntries.entryId })
    if (inserted) return

    // A conflicting id or sequence without the same workspace-global key is
    // persisted-state inconsistency, not an idempotent retry.
    const afterConflict = await this.#readEntries(entry.executionId)
    const sameKey = afterConflict.find(
      (existing) => existing.source.idempotencyKey === entry.source.idempotencyKey
    )
    if (sameKey && canonicalJson(sameKey) === canonicalJson(entry)) return
    if (sameKey) throw usageError('IDEMPOTENCY_CONFLICT')
    throw storeStateInvalid()
  }

  async listEntries(executionIdInput: string): Promise<readonly UsageLedgerEntry[]> {
    const executionId = parseExecutionId(executionIdInput)
    const owner = await this.#readOwner(executionId)
    if (!owner || owner.workspaceId !== this.#workspaceId) return []
    const entries = await this.#readEntries(executionId)
    const [budgetRow] = await this.#transaction
      .select()
      .from(usageBudgetStates)
      .where(eq(usageBudgetStates.executionId, executionId))
      .limit(1)
    if (!budgetRow) {
      if (entries.length !== 0) throw storeStateInvalid()
      return entries
    }
    const budget = fromUsageBudgetStateRow(budgetRow)
    this.#assertBudgetOwner(budget, owner)
    assertBudgetHighWater(budget, entries)
    return entries
  }

  async #readOwner(
    executionId: string
  ): Promise<
    { workspaceId: string; parentExecutionId?: string; latestAttemptId?: string } | undefined
  > {
    const cached = this.#owners.get(executionId)
    if (cached !== undefined) return cached ?? undefined
    const [row] = await this.#transaction
      .select()
      .from(executions)
      .where(eq(executions.executionId, executionId))
      .limit(1)
      .for('key share')
    if (!row) {
      this.#owners.set(executionId, null)
      return undefined
    }
    let owner: ReturnType<typeof fromExecutionRow>
    try {
      owner = fromExecutionRow(row)
    } catch {
      throw storeStateInvalid()
    }
    const result = {
      workspaceId: owner.correlation.workspaceId,
      ...(owner.latestAttemptId === undefined ? {} : { latestAttemptId: owner.latestAttemptId }),
      ...(owner.parentExecutionId === undefined
        ? {}
        : { parentExecutionId: owner.parentExecutionId }),
    }
    this.#owners.set(executionId, result)
    return result
  }

  async #assertAttemptOwner(
    attemptId: string,
    executionId: string,
    scopeError:
      | 'STORE_STATE_INVALID'
      | 'USAGE_LEDGER_SCOPE_MISMATCH' = 'USAGE_LEDGER_SCOPE_MISMATCH'
  ): Promise<void> {
    const [row] = await this.#transaction
      .select()
      .from(executionAttempts)
      .where(eq(executionAttempts.attemptId, attemptId))
      .limit(1)
      .for('key share')
    if (!row) throw usageError(scopeError)
    let attempt: ReturnType<typeof fromAttemptRow>
    try {
      attempt = fromAttemptRow(row)
    } catch {
      throw storeStateInvalid()
    }
    if (attempt.executionId !== executionId) throw usageError(scopeError)
  }

  #assertBudgetOwner(
    budget: DurableUsageBudget,
    owner: { workspaceId: string; parentExecutionId?: string; latestAttemptId?: string }
  ): void {
    if (
      budget.workspaceId !== owner.workspaceId ||
      (budget.parentExecutionId ?? null) !== (owner.parentExecutionId ?? null)
    ) {
      throw storeStateInvalid()
    }
  }

  async #readEntries(executionId: string): Promise<UsageLedgerEntry[]> {
    const rows = await this.#transaction
      .select()
      .from(usageLedgerEntries)
      .where(eq(usageLedgerEntries.executionId, executionId))
      .orderBy(asc(usageLedgerEntries.sequence))
    const entries: UsageLedgerEntry[] = []
    for (const row of rows) {
      if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) throw storeStateInvalid()
      let entry: UsageLedgerEntry
      try {
        entry = fromUsageLedgerRow(row)
      } catch {
        throw storeStateInvalid()
      }
      if (
        entry.workspaceId !== this.#workspaceId ||
        entry.executionId !== executionId ||
        entry.sequence !== entries.length + 1 ||
        (entry.parentExecutionId ?? null) !==
          (this.#owners.get(executionId)?.parentExecutionId ?? null)
      ) {
        throw storeStateInvalid()
      }
      if (entry.attemptId !== undefined) {
        await this.#assertAttemptOwner(entry.attemptId, executionId, 'STORE_STATE_INVALID')
      }
      entries.push(entry)
    }
    return entries
  }
}

function assertBudgetHighWater(
  budget: DurableUsageBudget,
  entries: readonly UsageLedgerEntry[]
): void {
  if (entries.length !== budget.nextSequence - 1) throw storeStateInvalid()
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.sequence !== index + 1) throw storeStateInvalid()
  }
}

function parseExecutionId(input: string): string {
  const parsed = IdentifierSchemas.executionId.safeParse(input)
  if (!parsed.success) throw usageError('INVALID_ENTRY')
  return parsed.data
}

function parseEffectKey(input: string): string {
  // Effect keys intentionally are not identifiers; validate their contract here.
  if (typeof input !== 'string' || input.length < 1 || input.length > 256) {
    throw usageError('INVALID_ENTRY')
  }
  return input
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  const keys = Object.keys(object).toSorted()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

function usageError(code: ConstructorParameters<typeof DurableUsageError>[0]): DurableUsageError {
  return new DurableUsageError(code)
}

function storeStateInvalid(): DurableUsageError {
  return usageError('STORE_STATE_INVALID')
}

function scopeMismatch(): DurableUsageError {
  return usageError('USAGE_LEDGER_SCOPE_MISMATCH')
}
