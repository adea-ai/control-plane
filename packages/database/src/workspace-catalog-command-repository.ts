import { IdentifierSchemas } from '@control-plane/contracts'
import {
  WorkspaceCatalogCommandReceiptSchema,
  WorkspaceCatalogCommandSchema,
  WorkspaceCatalogError,
  type WorkspaceCatalogCommand,
  type WorkspaceCatalogCommandRepository,
  type WorkspaceCatalogStore,
} from '@control-plane/domain'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { PostgresCatalogRepository } from './catalog-repository.js'
import type { ControlPlaneDatabase } from './connection.js'
import { workspaceCatalogCommands } from './schema/catalog.js'

/**
 * Cloud and Hosted `server` receipts for the workspace catalog API. One transaction claims the
 * receipt, runs the catalog mutation against transaction-bound repositories and completes the
 * receipt. A per-workspace advisory lock serializes commands so the catalog's read-then-write
 * version uniqueness checks cannot interleave.
 */
export class PostgresWorkspaceCatalogCommandRepository implements WorkspaceCatalogCommandRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async executeCommand(
    workspaceIdInput: string,
    input: WorkspaceCatalogCommand,
    action: (store: WorkspaceCatalogStore) => Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    const workspaceId = IdentifierSchemas.workspaceId.parse(workspaceIdInput)
    const command = WorkspaceCatalogCommandSchema.parse(input)
    const scope = and(
      eq(workspaceCatalogCommands.workspaceId, workspaceId),
      eq(workspaceCatalogCommands.callerId, command.callerId),
      eq(workspaceCatalogCommands.operation, command.operation),
      eq(workspaceCatalogCommands.idempotencyKey, command.idempotencyKey)
    )
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-catalog:${workspaceId}`}, 0))`
      )
      const [claim] = await transaction
        .insert(workspaceCatalogCommands)
        .values({
          workspaceId,
          callerId: command.callerId,
          operation: command.operation,
          idempotencyKey: command.idempotencyKey,
          payloadHash: command.payloadHash,
          receipt: null,
        })
        .onConflictDoNothing()
        .returning({ idempotencyKey: workspaceCatalogCommands.idempotencyKey })

      if (claim === undefined) {
        const [existing] = await transaction
          .select()
          .from(workspaceCatalogCommands)
          .where(scope)
          .limit(1)
        const parsed = WorkspaceCatalogCommandReceiptSchema.safeParse(existing?.receipt)
        if (
          existing === undefined ||
          !parsed.success ||
          parsed.data.workspaceId !== existing.workspaceId ||
          parsed.data.command.callerId !== existing.callerId ||
          parsed.data.command.operation !== existing.operation ||
          parsed.data.command.idempotencyKey !== existing.idempotencyKey ||
          parsed.data.command.payloadHash !== existing.payloadHash
        ) {
          throw new Error('POSTGRES_WORKSPACE_CATALOG_RECEIPT_CORRUPT')
        }
        if (existing.payloadHash !== command.payloadHash) {
          throw new WorkspaceCatalogError('CATALOG_COMMAND_CONFLICT')
        }
        return parsed.data.result
      }

      const result = JSON.parse(
        JSON.stringify(await action(new PostgresCatalogRepository(transaction)))
      ) as unknown
      const receipt = WorkspaceCatalogCommandReceiptSchema.parse({ workspaceId, command, result })
      const [completed] = await transaction
        .update(workspaceCatalogCommands)
        .set({ receipt })
        .where(and(scope, isNull(workspaceCatalogCommands.receipt)))
        .returning({ idempotencyKey: workspaceCatalogCommands.idempotencyKey })
      if (completed === undefined) throw new Error('POSTGRES_WORKSPACE_CATALOG_CLAIM_LOST')
      return receipt.result
    })
  }
}
