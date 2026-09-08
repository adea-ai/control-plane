import { createHash } from 'node:crypto'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'
import {
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

export class SqliteInteractionCommandRepository implements InteractionCommandRepository {
  constructor(readonly provider: PersistenceProvider) {}

  async get(scope: InteractionCommandScope): Promise<InteractionCommandReceipt | undefined> {
    return this.provider.transaction(async (transaction) => {
      const row = await transaction.get(namespace, recordId(scope))
      return row === undefined ? undefined : InteractionCommandReceiptSchema.parse(row.value)
    })
  }

  async reserve(input: InteractionCommandReceipt): Promise<InteractionCommandReceipt> {
    const receipt = InteractionCommandReceiptSchema.parse(input)
    if (receipt.acceptedAt !== undefined) throw new Error('INTERACTION_RECEIPT_ALREADY_ACCEPTED')
    return this.provider.transaction(async (transaction) => {
      const id = recordId(receipt.request)
      const existing = await transaction.get(namespace, id)
      if (existing) return InteractionCommandReceiptSchema.parse(existing.value)
      await transaction.put({ namespace, id, value: json(receipt) })
      return receipt
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
