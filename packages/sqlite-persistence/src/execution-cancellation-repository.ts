import { createHash } from 'node:crypto'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'
import {
  ExecutionCancellationReceiptSchema,
  executionCancellationScopeKey,
  type ExecutionCancellationRepository,
  type ExecutionCancellationReceipt,
  type ExecutionCancellationScope,
} from '@control-plane/domain'

const namespace = 'execution-cancellation-receipts'
const recordId = (scope: ExecutionCancellationScope) =>
  `r-${createHash('sha256').update(executionCancellationScopeKey(scope)).digest('hex')}`
const json = (receipt: ExecutionCancellationReceipt) =>
  JSON.parse(JSON.stringify(receipt)) as JsonValue

function read(value: unknown, scope: ExecutionCancellationScope): ExecutionCancellationReceipt {
  const receipt = ExecutionCancellationReceiptSchema.parse(value)
  if (executionCancellationScopeKey(receipt.request) !== executionCancellationScopeKey(scope))
    throw new Error('EXECUTION_CANCELLATION_RECEIPT_SCOPE_MISMATCH')
  return receipt
}

export class SqliteExecutionCancellationRepository implements ExecutionCancellationRepository {
  constructor(readonly provider: PersistenceProvider) {}

  async get(scope: ExecutionCancellationScope): Promise<ExecutionCancellationReceipt | undefined> {
    return this.provider.transaction(async (transaction) => {
      const row = await transaction.get(namespace, recordId(scope))
      return row === undefined ? undefined : read(row.value, scope)
    })
  }

  async reserve(input: ExecutionCancellationReceipt) {
    const receipt = ExecutionCancellationReceiptSchema.parse(input)
    if (receipt.acceptedAt !== undefined)
      throw new Error('EXECUTION_CANCELLATION_RECEIPT_ALREADY_ACCEPTED')
    return this.provider.transaction(async (transaction) => {
      const id = recordId(receipt.request)
      const existing = await transaction.get(namespace, id)
      if (existing) return { receipt: read(existing.value, receipt.request), inserted: false }
      await transaction.put({ namespace, id, value: json(receipt) })
      return { receipt, inserted: true }
    })
  }

  async markAccepted(scope: ExecutionCancellationScope, at: string) {
    ExecutionCancellationReceiptSchema.shape.acceptedAt.unwrap().parse(at)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(scope)
      const row = await transaction.get(namespace, id)
      if (!row) throw new Error('EXECUTION_CANCELLATION_RECEIPT_MISSING')
      const current = read(row.value, scope)
      if (current.acceptedAt !== undefined) return current
      const accepted = ExecutionCancellationReceiptSchema.parse({ ...current, acceptedAt: at })
      await transaction.put({
        namespace,
        id,
        expectedRevision: row.revision,
        value: json(accepted),
      })
      return accepted
    })
  }

  /**
   * Bounded maintenance read for reconciliation: cancellation receipts recorded
   * against an execution, capped at `limit`. Lets remediation effects respect a
   * recorded operator cancel intent without scanning unbounded history.
   */
  listByExecution(input: {
    readonly executionId: string
    readonly workspaceId: string
    readonly projectId: string
    readonly limit: number
  }): Promise<readonly ExecutionCancellationReceipt[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('INVALID_LIMIT')
    }
    return this.provider.transaction(async (transaction) =>
      (await transaction.list(namespace))
        .map((record) => ExecutionCancellationReceiptSchema.parse(record.value))
        .filter(
          (receipt) =>
            receipt.request.workspaceId === input.workspaceId &&
            receipt.request.projectId === input.projectId &&
            receipt.request.payload.executionId === input.executionId
        )
        .slice(0, input.limit)
    )
  }
}
