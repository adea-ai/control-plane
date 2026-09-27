import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import { ExecutionSchema, ExecutionAttemptSchema } from '@control-plane/domain'
import type { PersistenceProvider, PersistenceTransaction } from '@control-plane/deployment'
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
import { json, recordId } from './record-storage.js'

export const SQLITE_USAGE_NAMESPACES = Object.freeze({
  budgets: 'usage-budgets',
  effects: 'usage-effects',
  entries: 'usage-ledger-entries',
  sequences: 'usage-entry-sequences',
})

/** Native provider transactions serialize admission, parent funding, entries,
 * and replay receipts across provider instances. No projection lives in memory.
 */
export class SqliteDurableUsageStore implements DurableUsageStore {
  constructor(readonly provider: PersistenceProvider) {
    if (provider.dialect !== 'sqlite') throw new DurableUsageError('STORE_STATE_INVALID')
  }

  transaction<Result>(
    workspaceId: string,
    operation: (transaction: DurableUsageTransaction) => Promise<Result>
  ): Promise<Result> {
    IdentifierSchemas.workspaceId.parse(workspaceId)
    return this.provider.transaction((transaction) =>
      operation(new SqliteUsageTransaction(transaction, workspaceId))
    )
  }
}

class SqliteUsageTransaction implements DurableUsageTransaction {
  constructor(
    readonly transaction: PersistenceTransaction,
    readonly workspaceId: string
  ) {}

  async getBudget(executionId: string): Promise<DurableUsageBudget | undefined> {
    IdentifierSchemas.executionId.parse(executionId)
    const record = await this.transaction.get(
      SQLITE_USAGE_NAMESPACES.budgets,
      scopedId(this.workspaceId, executionId)
    )
    if (record === undefined) return undefined
    const parsed = DurableUsageBudgetSchema.safeParse(record.value)
    if (!parsed.success) throw new DurableUsageError('STORE_STATE_INVALID')
    if (parsed.data.workspaceId !== this.workspaceId || parsed.data.executionId !== executionId)
      throw new DurableUsageError('STORE_STATE_INVALID')
    return parsed.data
  }

  async putBudget(value: DurableUsageBudget): Promise<void> {
    const budget = DurableUsageBudgetSchema.parse(value)
    await this.#owner(budget.executionId, budget.workspaceId, budget.parentExecutionId, true)
    const id = scopedId(this.workspaceId, budget.executionId)
    const current = await this.transaction.get(SQLITE_USAGE_NAMESPACES.budgets, id)
    // Refuse to overwrite corrupt state, even if a caller bypasses the service.
    if (current !== undefined) await this.getBudget(budget.executionId)
    await this.transaction.put({
      namespace: SQLITE_USAGE_NAMESPACES.budgets,
      id,
      ...(current === undefined ? {} : { expectedRevision: current.revision }),
      value: json(budget),
    })
  }

  async getEffect(idempotencyKey: string): Promise<DurableUsageEffect | undefined> {
    DurableUsageEffectSchema.shape.idempotencyKey.parse(idempotencyKey)
    const record = await this.transaction.get(
      SQLITE_USAGE_NAMESPACES.effects,
      scopedId(this.workspaceId, idempotencyKey)
    )
    if (record === undefined) return undefined
    const parsed = DurableUsageEffectSchema.safeParse(record.value)
    if (!parsed.success) throw new DurableUsageError('STORE_STATE_INVALID')
    if (
      parsed.data.workspaceId !== this.workspaceId ||
      parsed.data.idempotencyKey !== idempotencyKey
    )
      throw new DurableUsageError('STORE_STATE_INVALID')
    return parsed.data
  }

  async putEffect(value: DurableUsageEffect): Promise<void> {
    const effect = DurableUsageEffectSchema.parse(value)
    if (effect.workspaceId !== this.workspaceId)
      throw new DurableUsageError('USAGE_LEDGER_SCOPE_MISMATCH')
    const current = await this.getEffect(effect.idempotencyKey)
    if (current !== undefined) {
      if (canonicalJsonStringify(current) !== canonicalJsonStringify(effect))
        throw new DurableUsageError('IDEMPOTENCY_CONFLICT')
      return
    }
    // Only already accepted, scope-matching executions may create a receipt.
    await this.#owner(effect.executionId, effect.workspaceId)
    await this.transaction.put({
      namespace: SQLITE_USAGE_NAMESPACES.effects,
      id: scopedId(this.workspaceId, effect.idempotencyKey),
      value: json(effect),
    })
  }

  async appendEntry(value: UsageLedgerEntry): Promise<void> {
    const entry = UsageLedgerEntrySchema.parse(value)
    await this.#owner(entry.executionId, entry.workspaceId, entry.parentExecutionId, true)
    if (entry.attemptId !== undefined) {
      const stored = await this.transaction.get('execution-attempts', recordId(entry.attemptId))
      const attempt = ExecutionAttemptSchema.safeParse(stored?.value)
      if (
        !attempt.success ||
        attempt.data.attemptId !== entry.attemptId ||
        attempt.data.executionId !== entry.executionId
      )
        throw new DurableUsageError('USAGE_LEDGER_SCOPE_MISMATCH')
    }
    const id = recordId(entry.entryId)
    const sequenceId = scopedId(this.workspaceId, entry.executionId, entry.sequence)
    const existing = await this.transaction.get(SQLITE_USAGE_NAMESPACES.entries, id)
    const sequence = await this.transaction.get(SQLITE_USAGE_NAMESPACES.sequences, sequenceId)
    const index = {
      workspaceId: this.workspaceId,
      executionId: entry.executionId,
      sequence: entry.sequence,
      entryId: entry.entryId,
    }
    if (existing !== undefined || sequence !== undefined) {
      if (
        existing === undefined ||
        sequence === undefined ||
        canonicalJsonStringify(existing.value) !== canonicalJsonStringify(entry) ||
        canonicalJsonStringify(sequence.value) !== canonicalJsonStringify(index)
      )
        throw new DurableUsageError('IDEMPOTENCY_CONFLICT')
      return
    }
    await this.transaction.put({
      namespace: SQLITE_USAGE_NAMESPACES.entries,
      id,
      value: json(entry),
    })
    await this.transaction.put({
      namespace: SQLITE_USAGE_NAMESPACES.sequences,
      id: sequenceId,
      value: json(index),
    })
  }

  async listEntries(executionId: string): Promise<readonly UsageLedgerEntry[]> {
    IdentifierSchemas.executionId.parse(executionId)
    const entries: UsageLedgerEntry[] = []
    const entryIds = new Set<string>()
    const indexes = await this.transaction.list(SQLITE_USAGE_NAMESPACES.sequences)
    for (const record of indexes) {
      const value = record.value as {
        workspaceId?: unknown
        executionId?: unknown
        sequence?: unknown
        entryId?: unknown
      } | null
      // The stable storage key still identifies an index whose scope fields
      // were damaged. Neither side of the index/entry pair may disappear silently.
      const keyedHere =
        typeof value?.sequence === 'number' &&
        Number.isSafeInteger(value.sequence) &&
        value.sequence > 0 &&
        record.id === scopedId(this.workspaceId, executionId, value.sequence)
      if (
        !keyedHere &&
        !(value?.workspaceId === this.workspaceId && value.executionId === executionId)
      )
        continue
      if (typeof value?.entryId !== 'string') throw new DurableUsageError('STORE_STATE_INVALID')
      const stored = await this.transaction.get(
        SQLITE_USAGE_NAMESPACES.entries,
        recordId(value.entryId)
      )
      const parsed = UsageLedgerEntrySchema.safeParse(stored?.value)
      if (!parsed.success) throw new DurableUsageError('STORE_STATE_INVALID')
      const entry = parsed.data
      const expected = {
        workspaceId: this.workspaceId,
        executionId,
        sequence: entry.sequence,
        entryId: entry.entryId,
      }
      if (
        entry.workspaceId !== this.workspaceId ||
        entry.executionId !== executionId ||
        record.id !== scopedId(this.workspaceId, executionId, entry.sequence) ||
        canonicalJsonStringify(record.value) !== canonicalJsonStringify(expected) ||
        entryIds.has(entry.entryId)
      )
        throw new DurableUsageError('STORE_STATE_INVALID')
      entryIds.add(entry.entryId)
      entries.push(entry)
    }
    const records = await this.transaction.list(SQLITE_USAGE_NAMESPACES.entries)
    for (const record of records) {
      const value = record.value as { workspaceId?: unknown; executionId?: unknown } | null
      if (value?.workspaceId !== this.workspaceId || value.executionId !== executionId) continue
      const parsed = UsageLedgerEntrySchema.safeParse(record.value)
      if (
        !parsed.success ||
        record.id !== recordId(parsed.data.entryId) ||
        !entryIds.has(parsed.data.entryId)
      )
        throw new DurableUsageError('STORE_STATE_INVALID')
    }
    const ordered = entries.toSorted((left, right) => left.sequence - right.sequence)
    const budget = await this.getBudget(executionId)
    // Raw deletion is not supported yet. A durable budget's high-water mark
    // therefore also detects damage that erases attribution on both sides.
    if (
      budget !== undefined &&
      (ordered.length !== budget.nextSequence - 1 ||
        ordered.some((entry, index) => entry.sequence !== index + 1))
    )
      throw new DurableUsageError('STORE_STATE_INVALID')
    return ordered
  }

  async #owner(
    executionId: string,
    workspaceId: string,
    parentExecutionId?: string,
    exactParent = false
  ): Promise<void> {
    if (workspaceId !== this.workspaceId) throw new DurableUsageError('USAGE_LEDGER_SCOPE_MISMATCH')
    const record = await this.transaction.get('executions', recordId(executionId))
    const parsed = ExecutionSchema.safeParse(record?.value)
    if (
      !parsed.success ||
      parsed.data.executionId !== executionId ||
      parsed.data.correlation.workspaceId !== this.workspaceId
    )
      throw new DurableUsageError('USAGE_LEDGER_SCOPE_MISMATCH')
    if (
      (exactParent || parentExecutionId !== undefined) &&
      parsed.data.parentExecutionId !== parentExecutionId
    )
      throw new DurableUsageError('USAGE_LEDGER_SCOPE_MISMATCH')
  }
}

function scopedId(workspaceId: string, identity: string, sequence?: number): string {
  return recordId(
    JSON.stringify([workspaceId, identity, ...(sequence === undefined ? [] : [sequence])])
  )
}
