import { createHash } from 'node:crypto'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import {
  ExecutionSchema,
  InteractionCommandReceiptSchema,
  interactionCommandScopeKey,
  type InteractionCommandRepository,
  type InteractionCommandReceipt,
  type InteractionCommandScope,
} from '@control-plane/domain'

const namespace = 'interaction-command-receipts'
const recordId = (scope: InteractionCommandScope) =>
  `r-${createHash('sha256').update(interactionCommandScopeKey(scope)).digest('hex')}`
const json = (receipt: InteractionCommandReceipt) =>
  JSON.parse(JSON.stringify(receipt)) as JsonValue
const storedId = (id: string) => `r-${createHash('sha256').update(id).digest('hex')}`

async function requireExecutionOwner(
  transaction: PersistenceTransaction,
  receipt: InteractionCommandReceipt
): Promise<void> {
  const executionId = receipt.request.payload.executionId
  const row = await transaction.get('executions', storedId(executionId))
  if (row === undefined) throw new Error('SQLITE_INTERACTION_COMMAND_EXECUTION_MISSING')
  const parsed = ExecutionSchema.safeParse(row.value)
  if (!parsed.success || parsed.data.executionId !== executionId)
    throw new Error('SQLITE_INTERACTION_COMMAND_EXECUTION_MALFORMED')
  if (
    parsed.data.correlation.workspaceId !== receipt.request.workspaceId ||
    parsed.data.correlation.projectId !== receipt.request.projectId
  )
    throw new Error('SQLITE_INTERACTION_COMMAND_SCOPE_MISMATCH')
}

export class SqliteInteractionCommandRepository implements InteractionCommandRepository {
  constructor(readonly provider: PersistenceProvider) {}

  async get(scope: InteractionCommandScope): Promise<InteractionCommandReceipt | undefined> {
    return this.provider.transaction(async (transaction) => {
      const row = await transaction.get(namespace, recordId(scope))
      return row === undefined ? undefined : InteractionCommandReceiptSchema.parse(row.value)
    })
  }

  async reserve(
    input: InteractionCommandReceipt
  ): Promise<{ receipt: InteractionCommandReceipt; inserted: boolean }> {
    const receipt = InteractionCommandReceiptSchema.parse(input)
    if (receipt.acceptedAt !== undefined) throw new Error('INTERACTION_RECEIPT_ALREADY_ACCEPTED')
    return this.provider.transaction(async (transaction) => {
      const id = recordId(receipt.request)
      const existing = await transaction.get(namespace, id)
      if (existing)
        return { receipt: InteractionCommandReceiptSchema.parse(existing.value), inserted: false }
      await requireExecutionOwner(transaction, receipt)
      await transaction.put({ namespace, id, value: json(receipt) })
      return { receipt, inserted: true }
    })
  }

  async markAccepted(
    scope: InteractionCommandScope,
    at: string
  ): Promise<InteractionCommandReceipt> {
    InteractionCommandReceiptSchema.shape.acceptedAt.unwrap().parse(at)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(scope)
      const row = await transaction.get(namespace, id)
      if (!row) throw new Error('INTERACTION_RECEIPT_MISSING')
      const current = InteractionCommandReceiptSchema.parse(row.value)
      if (current.acceptedAt !== undefined) return current
      const accepted = InteractionCommandReceiptSchema.parse({ ...current, acceptedAt: at })
      await transaction.put({
        namespace,
        id,
        expectedRevision: row.revision,
        value: json(accepted),
      })
      return accepted
    })
  }
}
