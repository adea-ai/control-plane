import {
  UsageLedgerEntrySchema,
  usageEntriesShareIdentity,
  type UsageLedgerAppendResult,
  type UsageLedgerEntry,
  type UsageLedgerRepository,
} from '@control-plane/usage-ledger'
import { and, asc, eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { executions } from './schema/executions.js'
import { usageLedgerEntries } from './schema/usage-ledger.js'

export class PostgresUsageLedgerRepository implements UsageLedgerRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async append(value: UsageLedgerEntry): Promise<UsageLedgerAppendResult> {
    const entry = UsageLedgerEntrySchema.parse(value)
    return this.database.transaction(async (transaction) => {
      const [execution] = await transaction
        .select({ workspaceId: executions.workspaceId })
        .from(executions)
        .where(eq(executions.executionId, entry.executionId))
        .limit(1)
      if (execution === undefined || execution.workspaceId !== entry.workspaceId) {
        throw new Error('USAGE_LEDGER_SCOPE_MISMATCH')
      }

      const inserted = await transaction
        .insert(usageLedgerEntries)
        .values(toUsageLedgerRow(entry))
        .onConflictDoNothing()
        .returning({ entryId: usageLedgerEntries.entryId })
      if (inserted.length === 1) return { outcome: 'created', entry }

      const current = await this.#findByIdempotency(
        entry.workspaceId,
        entry.source.idempotencyKey,
        transaction
      )
      if (current === undefined) throw new Error('USAGE_LEDGER_APPEND_RACE')
      return {
        outcome: usageEntriesShareIdentity(current, entry) ? 'duplicate' : 'conflict',
        entry: current,
      }
    })
  }

  async list(workspaceId: string, executionId: string): Promise<readonly UsageLedgerEntry[]> {
    const rows = await this.database
      .select()
      .from(usageLedgerEntries)
      .where(
        and(
          eq(usageLedgerEntries.workspaceId, workspaceId),
          eq(usageLedgerEntries.executionId, executionId)
        )
      )
      .orderBy(asc(usageLedgerEntries.sequence))
    return rows.map(fromUsageLedgerRow)
  }

  async #findByIdempotency(
    workspaceId: string,
    idempotencyKey: string,
    database: ControlPlaneDatabase = this.database
  ): Promise<UsageLedgerEntry | undefined> {
    const [row] = await database
      .select()
      .from(usageLedgerEntries)
      .where(
        and(
          eq(usageLedgerEntries.workspaceId, workspaceId),
          eq(usageLedgerEntries.idempotencyKey, idempotencyKey)
        )
      )
      .orderBy(asc(usageLedgerEntries.sequence))
    if (row === undefined || row.idempotencyKey !== idempotencyKey) return undefined
    return fromUsageLedgerRow(row)
  }
}

type UsageLedgerRow = typeof usageLedgerEntries.$inferSelect

export function toUsageLedgerRow(entry: UsageLedgerEntry): typeof usageLedgerEntries.$inferInsert {
  return {
    entryId: entry.entryId,
    sequence: entry.sequence,
    workspaceId: entry.workspaceId,
    executionId: entry.executionId,
    attemptId: entry.attemptId ?? null,
    parentExecutionId: entry.parentExecutionId ?? null,
    kind: entry.kind,
    sourceId: entry.source.sourceId,
    idempotencyKey: entry.source.idempotencyKey,
    reservationKey: entry.reservationKey ?? null,
    modelCallId: entry.modelCallId ?? null,
    reservedTokens: entry.reservedTokens ?? null,
    priceSnapshotDigest: entry.priceSnapshotDigest ?? null,
    requestDigest: entry.requestDigest ?? null,
    fundingSource: entry.fundingSource,
    quantity: entry.quantity,
    currency: entry.currency,
    costMicrounits: entry.costMicrounits,
    costExact: entry.costExact,
    authorizationDecisionId: entry.authorizationDecisionId ?? null,
    recordedAt: new Date(entry.recordedAt),
  }
}

export function fromUsageLedgerRow(row: UsageLedgerRow): UsageLedgerEntry {
  return UsageLedgerEntrySchema.parse({
    entryId: row.entryId,
    sequence: row.sequence,
    workspaceId: row.workspaceId,
    executionId: row.executionId,
    ...(row.attemptId === null ? {} : { attemptId: row.attemptId }),
    ...(row.parentExecutionId === null ? {} : { parentExecutionId: row.parentExecutionId }),
    kind: row.kind,
    source: { sourceId: row.sourceId, idempotencyKey: row.idempotencyKey },
    ...(row.reservationKey === null ? {} : { reservationKey: row.reservationKey }),
    ...(row.modelCallId === null ? {} : { modelCallId: row.modelCallId }),
    ...(row.reservedTokens === null ? {} : { reservedTokens: row.reservedTokens }),
    ...(row.priceSnapshotDigest === null ? {} : { priceSnapshotDigest: row.priceSnapshotDigest }),
    ...(row.requestDigest === null ? {} : { requestDigest: row.requestDigest }),
    fundingSource: row.fundingSource,
    quantity: row.quantity,
    currency: row.currency,
    costMicrounits: row.costMicrounits,
    costExact: row.costExact,
    ...(row.authorizationDecisionId === null
      ? {}
      : { authorizationDecisionId: row.authorizationDecisionId }),
    recordedAt: row.recordedAt.toISOString(),
  })
}
