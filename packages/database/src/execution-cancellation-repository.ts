import { createHash } from 'node:crypto'
import {
  ExecutionCancellationReceiptSchema,
  executionCancellationScopeKey,
  type ExecutionCancellationReceipt,
  type ExecutionCancellationRepository,
  type ExecutionCancellationScope,
} from '@control-plane/domain'
import { and, eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { executionCancellations } from './schema/execution-cancellations.js'

const key = (scope: ExecutionCancellationScope) =>
  createHash('sha256').update(executionCancellationScopeKey(scope)).digest('hex')

export class PostgresExecutionCancellationRepository implements ExecutionCancellationRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  get(scope: ExecutionCancellationScope): Promise<ExecutionCancellationReceipt | undefined> {
    return read(this.database, scope)
  }

  async reserve(
    input: ExecutionCancellationReceipt
  ): Promise<{ receipt: ExecutionCancellationReceipt; inserted: boolean }> {
    const receipt = ExecutionCancellationReceiptSchema.parse(input)
    if (receipt.acceptedAt !== undefined) throw new Error('EXECUTION_CANCELLATION_PRECONFIRMED')
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key(receipt.request)}, 0))`
      )
      const existing = await read(transaction, receipt.request)
      if (existing) return { receipt: existing, inserted: false }
      await transaction.insert(executionCancellations).values({
        commandKey: key(receipt.request),
        workspaceId: receipt.request.workspaceId,
        projectId: receipt.request.projectId,
        receipt,
      })
      return { receipt, inserted: true }
    })
  }

  async markAccepted(
    scope: ExecutionCancellationScope,
    at: string
  ): Promise<ExecutionCancellationReceipt> {
    ExecutionCancellationReceiptSchema.shape.acceptedAt.unwrap().parse(at)
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key(scope)}, 0))`
      )
      const current = await read(transaction, scope)
      if (!current) throw new Error('EXECUTION_CANCELLATION_MISSING')
      if (current.acceptedAt !== undefined) return current
      const receipt = ExecutionCancellationReceiptSchema.parse({ ...current, acceptedAt: at })
      await transaction
        .update(executionCancellations)
        .set({ receipt })
        .where(eq(executionCancellations.commandKey, key(scope)))
      return receipt
    })
  }

  /**
   * Bounded maintenance read for reconciliation: cancellation receipts recorded
   * against an execution, capped at `limit`. Lets remediation effects respect a
   * recorded operator cancel intent without scanning unbounded history.
   */
  async listByExecution(input: {
    readonly executionId: string
    readonly workspaceId: string
    readonly projectId: string
    readonly limit: number
  }): Promise<readonly ExecutionCancellationReceipt[]> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > CANCELLATION_SCAN_LIMIT
    ) {
      throw new Error('INVALID_LIMIT')
    }
    const rows = await this.database
      .select()
      .from(executionCancellations)
      .where(
        and(
          eq(executionCancellations.workspaceId, input.workspaceId),
          eq(executionCancellations.projectId, input.projectId),
          sql`${executionCancellations.receipt} -> 'request' -> 'payload' ->> 'executionId' = ${input.executionId}`
        )
      )
      .limit(input.limit)
    return rows.map(({ receipt }) => ExecutionCancellationReceiptSchema.parse(receipt))
  }
}

const CANCELLATION_SCAN_LIMIT = 100

async function read(
  database: Pick<ControlPlaneDatabase, 'select'>,
  scope: ExecutionCancellationScope
): Promise<ExecutionCancellationReceipt | undefined> {
  const [row] = await database
    .select()
    .from(executionCancellations)
    .where(eq(executionCancellations.commandKey, key(scope)))
    .limit(1)
  if (!row) return undefined
  const receipt = ExecutionCancellationReceiptSchema.parse(row.receipt)
  if (
    executionCancellationScopeKey(receipt.request) !== executionCancellationScopeKey(scope) ||
    row.workspaceId !== receipt.request.workspaceId ||
    row.projectId !== receipt.request.projectId
  )
    throw new Error('EXECUTION_CANCELLATION_SCOPE_MISMATCH')
  return receipt
}
