import { IdentifierSchemas, canonicalJsonStringify } from '@control-plane/contracts'
import type { PersistenceProvider } from '@control-plane/deployment'
import {
  WorkspaceCatalogCommandReceiptSchema,
  WorkspaceCatalogCommandSchema,
  WorkspaceCatalogError,
  type WorkspaceCatalogCommand,
  type WorkspaceCatalogCommandRepository,
  type WorkspaceCatalogStore,
} from '@control-plane/domain'
import { SqliteVersionedCatalogRepository } from './catalog-repository.js'
import { json, recordId } from './record-storage.js'

const commandNamespace = 'workspace-catalog-commands'

/**
 * Local and Hosted `simple` receipts. The catalog mutation and its receipt share one SQLite
 * transaction, which also serializes concurrent commands.
 */
export class SqliteWorkspaceCatalogCommandRepository implements WorkspaceCatalogCommandRepository {
  constructor(readonly provider: PersistenceProvider) {}

  executeCommand(
    workspaceIdInput: string,
    input: WorkspaceCatalogCommand,
    action: (store: WorkspaceCatalogStore) => Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    const workspaceId = IdentifierSchemas.workspaceId.parse(workspaceIdInput)
    const command = WorkspaceCatalogCommandSchema.parse(input)
    const id = recordId(
      canonicalJsonStringify([
        workspaceId,
        command.callerId,
        command.operation,
        command.idempotencyKey,
      ])
    )
    return this.provider.transaction(async (transaction) => {
      const existing = await transaction.get(commandNamespace, id)
      if (existing !== undefined) {
        const parsed = WorkspaceCatalogCommandReceiptSchema.safeParse(existing.value)
        if (
          !parsed.success ||
          parsed.data.workspaceId !== workspaceId ||
          parsed.data.command.callerId !== command.callerId ||
          parsed.data.command.operation !== command.operation ||
          parsed.data.command.idempotencyKey !== command.idempotencyKey
        ) {
          throw new Error('SQLITE_WORKSPACE_CATALOG_RECEIPT_CORRUPT')
        }
        if (parsed.data.command.payloadHash !== command.payloadHash) {
          throw new WorkspaceCatalogError('CATALOG_COMMAND_CONFLICT')
        }
        return parsed.data.result
      }
      // Repositories run inside the owned transaction, never a nested provider transaction.
      const scoped: PersistenceProvider = {
        profile: this.provider.profile,
        dialect: this.provider.dialect,
        migrate: async () => {
          throw new Error('SQLITE_WORKSPACE_CATALOG_LIFECYCLE_INVALID')
        },
        health: () => this.provider.health(),
        close: () => {},
        transaction: (operation) => operation(transaction),
      }
      const receipt = WorkspaceCatalogCommandReceiptSchema.parse({
        workspaceId,
        command,
        result: json(await action(new SqliteVersionedCatalogRepository(scoped))),
      })
      await transaction.put({ namespace: commandNamespace, id, value: json(receipt) })
      return receipt.result
    })
  }
}
