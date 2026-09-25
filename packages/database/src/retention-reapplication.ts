import type { RetentionJournalOperation } from '@control-plane/domain'
import { and, isNull, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { commandInbox } from './schema/commands.js'
import { contextPackages } from './schema/context-packages.js'
import { inboxMessages, outboxEvents } from './schema/messaging.js'
import { executionEvents, retiredExecutionEventIds } from './schema/events.js'
import { executionAttempts, executions } from './schema/executions.js'
import { retiredCommandKeys } from './schema/retired-command-keys.js'
import { runtimeEventReceipts } from './schema/runtime-event-receipts.js'
import { runtimeCommands } from './schema/runtime-commands.js'

export interface RetentionReapplicationOutcome {
  /** Operations that changed something. */
  readonly applied: number
  /** Operations that were already satisfied, including effects that never happened. */
  readonly skipped: number
}

/**
 * Reapplies a deletion journal to a restored PostgreSQL copy (#194).
 *
 * The journal is at-least-once: an entry may describe an effect that never
 * happened because the process died between the append and the storage change.
 * Every branch below is therefore idempotent — inserts are insert-if-absent and
 * deletes are by primary identity — and each operation kind is handled
 * explicitly, so journal content is never turned into SQL.
 */
export class PostgresRetentionReapplication {
  constructor(readonly database: ControlPlaneDatabase) {}

  async apply(
    operations: readonly RetentionJournalOperation[]
  ): Promise<RetentionReapplicationOutcome> {
    let applied = 0
    let skipped = 0
    for (const operation of operations) {
      switch (operation.kind) {
        case 'postgres.retireCommandKey': {
          const inserted = await this.database
            .insert(retiredCommandKeys)
            .values({
              scopeKey: operation.scopeKey,
              commandId: operation.commandId,
              executionId: operation.executionId,
              retiredAt: new Date(operation.retiredAt),
            })
            .onConflictDoNothing()
            .returning({ scopeKey: retiredCommandKeys.scopeKey })
          if (inserted.length === 1) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteCommand': {
          const removed = await this.database
            .delete(commandInbox)
            .where(sql`${commandInbox.commandId} = ${operation.commandId}`)
            .returning({ commandId: commandInbox.commandId })
          if (removed.length > 0) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteRuntimeCommand': {
          // Receipts are the command's children and are removed with it.
          await this.database
            .delete(runtimeEventReceipts)
            .where(sql`${runtimeEventReceipts.commandId} = ${operation.commandId}`)
          const removed = await this.database
            .delete(runtimeCommands)
            .where(sql`${runtimeCommands.commandId} = ${operation.commandId}`)
            .returning({ commandId: runtimeCommands.commandId })
          if (removed.length > 0) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.compactInboxMessage': {
          // The payload is replaced rather than nulled: the column is NOT NULL,
          // and the row itself is the deduplication identity that must survive.
          const compacted = await this.database
            .update(inboxMessages)
            .set({
              payload: { compacted: true, version: 1 },
              deletedAt: new Date(operation.compactedAt),
              revision: sql`${inboxMessages.revision} + 1`,
            })
            .where(and(sql`${inboxMessages.id} = ${operation.id}`, isNull(inboxMessages.deletedAt)))
            .returning({ id: inboxMessages.id })
          if (compacted.length > 0) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteOutboxEvent': {
          const removed = await this.database
            .delete(outboxEvents)
            .where(sql`${outboxEvents.id} = ${operation.id}`)
            .returning({ id: outboxEvents.id })
          if (removed.length > 0) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteContextPackage': {
          const removed = await this.database
            .delete(contextPackages)
            .where(sql`${contextPackages.contextPackageId} = ${operation.contextPackageId}`)
            .returning({ contextPackageId: contextPackages.contextPackageId })
          if (removed.length > 0) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteAttempt': {
          const removed = await this.database
            .delete(executionAttempts)
            .where(sql`${executionAttempts.attemptId} = ${operation.attemptId}`)
            .returning({ attemptId: executionAttempts.attemptId })
          if (removed.length > 0) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteExecution': {
          const removed = await this.database
            .delete(executions)
            .where(sql`${executions.executionId} = ${operation.executionId}`)
            .returning({ executionId: executions.executionId })
          if (removed.length > 0) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.retireEventId': {
          const inserted = await this.database
            .insert(retiredExecutionEventIds)
            .values({
              eventId: operation.eventId,
              executionId: operation.executionId,
              sequence: operation.sequence,
              retiredAt: new Date(operation.retiredAt),
            })
            .onConflictDoNothing()
            .returning({ eventId: retiredExecutionEventIds.eventId })
          if (inserted.length === 1) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteEvent': {
          const removed = await this.database
            .delete(executionEvents)
            .where(sql`${executionEvents.eventId} = ${operation.eventId}`)
            .returning({ eventId: executionEvents.eventId })
          if (removed.length > 0) applied += 1
          else skipped += 1
          break
        }
        default:
          // Operations for another backend are not this store's to apply.
          skipped += 1
      }
    }
    return { applied, skipped }
  }
}
