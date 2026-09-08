import { createHash } from 'node:crypto'
import {
  InteractionCommandReceiptSchema,
  interactionCommandScopeKey,
  type InteractionCommandReceipt,
  type InteractionCommandRepository,
  type InteractionCommandScope,
} from '@control-plane/domain'
import { eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { interactionCommands } from './schema/interaction-commands.js'

const key = (scope: InteractionCommandScope) =>
  createHash('sha256').update(interactionCommandScopeKey(scope)).digest('hex')

export class PostgresInteractionCommandRepository implements InteractionCommandRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  get(scope: InteractionCommandScope): Promise<InteractionCommandReceipt | undefined> {
    return read(this.database, scope)
  }

  async reserve(
    input: InteractionCommandReceipt
  ): Promise<{ receipt: InteractionCommandReceipt; inserted: boolean }> {
    const receipt = InteractionCommandReceiptSchema.parse(input)
    if (receipt.acceptedAt !== undefined) throw new Error('INTERACTION_COMMAND_PRECONFIRMED')
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key(receipt.request)}, 0))`
      )
      const existing = await read(transaction, receipt.request)
      if (existing) return { receipt: existing, inserted: false }
      await transaction.insert(interactionCommands).values({
        commandKey: key(receipt.request),
        workspaceId: receipt.request.workspaceId,
        projectId: receipt.request.projectId,
        receipt,
      })
      return { receipt, inserted: true }
    })
  }

  async markAccepted(
    scope: InteractionCommandScope,
    at: string
  ): Promise<InteractionCommandReceipt> {
    InteractionCommandReceiptSchema.shape.acceptedAt.unwrap().parse(at)
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key(scope)}, 0))`
      )
      const current = await read(transaction, scope)
      if (!current) throw new Error('INTERACTION_COMMAND_MISSING')
      if (current.acceptedAt !== undefined) return current
      const receipt = InteractionCommandReceiptSchema.parse({ ...current, acceptedAt: at })
      await transaction
        .update(interactionCommands)
        .set({ receipt })
        .where(eq(interactionCommands.commandKey, key(scope)))
      return receipt
    })
  }
}

async function read(
  database: Pick<ControlPlaneDatabase, 'select'>,
  scope: InteractionCommandScope
): Promise<InteractionCommandReceipt | undefined> {
  const [row] = await database
    .select()
    .from(interactionCommands)
    .where(eq(interactionCommands.commandKey, key(scope)))
    .limit(1)
  if (!row) return undefined
  const receipt = InteractionCommandReceiptSchema.parse(row.receipt)
  if (
    interactionCommandScopeKey(receipt.request) !== interactionCommandScopeKey(scope) ||
    row.workspaceId !== receipt.request.workspaceId ||
    row.projectId !== receipt.request.projectId
  )
    throw new Error('INTERACTION_COMMAND_SCOPE_MISMATCH')
  return receipt
}
