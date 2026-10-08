import { executionScopeFieldsFromRow } from './execution-scope.js'
import {
  CommandInboxScopeSchema,
  retiredCommandKeyCandidates,
  retiredCommandKeyFromMetadataV2,
  type RetentionJournalOperation,
} from '@control-plane/domain'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { commandInbox } from './schema/commands.js'
import { executionCancellations } from './schema/execution-cancellations.js'
import { interactionCommands } from './schema/interaction-commands.js'
import { contextPackages } from './schema/context-packages.js'
import { inboxMessages, outboxEvents } from './schema/messaging.js'
import { executionEvents, retiredExecutionEventIds } from './schema/events.js'
import { evaluationRuns, releaseAuditRecords } from './schema/evaluations.js'
import { executionPlans } from './schema/execution-plans.js'
import { executionAttempts, executions } from './schema/executions.js'
import { retiredCommandKeys } from './schema/retired-command-keys.js'
import { runtimeEventReceipts } from './schema/runtime-event-receipts.js'
import { runtimeCommands } from './schema/runtime-commands.js'

export interface RetentionReapplicationOutcome {
  /** Operations that changed something. */
  readonly applied: number
  /** Operations already satisfied in this restored copy. */
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

  /** Offline restore maintenance; never run on ordinary startup/migration. */
  async resetReferenceRetentionWindows(): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.update(executionPlans).set({ unreferencedSince: null })
      await transaction.update(contextPackages).set({ unreferencedSince: null })
    })
  }

  async apply(
    operations: readonly RetentionJournalOperation[]
  ): Promise<RetentionReapplicationOutcome> {
    let applied = 0
    let skipped = 0
    for (const operation of operations) {
      switch (operation.kind) {
        case 'postgres.retireCommandKey': {
          const restored = await this.#restoreCommandRetirement(operation)
          if (restored) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteRetiredCommandKey': {
          const removed = await this.database
            .delete(retiredCommandKeys)
            .where(eq(retiredCommandKeys.scopeKey, operation.scopeKey))
            .returning({ scopeKey: retiredCommandKeys.scopeKey })
          if (removed.length > 0) applied += 1
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
        case 'postgres.deleteEvaluationRun': {
          const removed = await this.database
            .delete(evaluationRuns)
            .where(sql`${evaluationRuns.evalRunId} = ${operation.evalRunId}`)
            .returning({ evalRunId: evaluationRuns.evalRunId })
          if (removed.length > 0) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteReleaseAuditRecord': {
          const removed = await this.database
            .delete(releaseAuditRecords)
            .where(sql`${releaseAuditRecords.releaseAuditId} = ${operation.releaseAuditId}`)
            .returning({ releaseAuditId: releaseAuditRecords.releaseAuditId })
          if (removed.length > 0) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteExecutionPlan': {
          const removed = await this.database
            .delete(executionPlans)
            .where(sql`${executionPlans.executionPlanId} = ${operation.executionPlanId}`)
            .returning({ executionPlanId: executionPlans.executionPlanId })
          if (removed.length > 0) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteInteractionReceipt': {
          const removed = await this.database
            .delete(interactionCommands)
            .where(sql`${interactionCommands.commandKey} = ${operation.commandKey}`)
            .returning({ commandKey: interactionCommands.commandKey })
          if (removed.length > 0) applied += 1
          else skipped += 1
          break
        }
        case 'postgres.deleteCancellationReceipt': {
          const removed = await this.database
            .delete(executionCancellations)
            .where(sql`${executionCancellations.commandKey} = ${operation.commandKey}`)
            .returning({ commandKey: executionCancellations.commandKey })
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

  async #restoreCommandRetirement(
    operation: Extract<RetentionJournalOperation, { kind: 'postgres.retireCommandKey' }>
  ): Promise<boolean> {
    const retiredAt = new Date(operation.retiredAt)
    if (!Number.isFinite(retiredAt.getTime()) || retiredAt.toISOString() !== operation.retiredAt)
      throw new Error('RETENTION_RETIRED_COMMAND_JOURNAL_INVALID')
    return this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(retiredCommandKeys)
        .where(eq(retiredCommandKeys.scopeKey, operation.scopeKey))
        .limit(1)
      if (existing?.metadataVersion === 2) {
        if (
          existing.commandId !== operation.commandId ||
          existing.executionId !== operation.executionId ||
          existing.retiredAt.toISOString() !== operation.retiredAt ||
          existing.metadataVersion !== 2 ||
          existing.identityDigest === null ||
          retiredCommandKeyFromMetadataV2(existing.identityDigest) !== existing.scopeKey
        )
          throw new Error('RETENTION_RETIRED_COMMAND_STORED_MISMATCH')
        return false
      }
      if (
        existing !== undefined &&
        (existing.metadataVersion !== 1 ||
          existing.identityDigest !== null ||
          existing.commandId !== operation.commandId ||
          existing.executionId !== operation.executionId ||
          existing.retiredAt.toISOString() !== operation.retiredAt)
      )
        throw new Error('RETENTION_RETIRED_COMMAND_STORED_MISMATCH')
      const [source] = await transaction
        .select({
          commandId: commandInbox.commandId,
          callerPrincipalId: commandInbox.callerPrincipalId,
          operation: commandInbox.operation,
          workspaceId: commandInbox.workspaceId,
          projectId: commandInbox.projectId,
          executionScope: commandInbox.executionScope,
          idempotencyKey: commandInbox.idempotencyKey,
          executionId: commandInbox.executionId,
        })
        .from(commandInbox)
        .where(eq(commandInbox.commandId, operation.commandId))
        .limit(1)
      if (
        source === undefined ||
        source.commandId !== operation.commandId ||
        source.executionId !== operation.executionId
      )
        throw new Error('RETENTION_RETIRED_COMMAND_SOURCE_MISSING')
      const keys = retiredCommandKeyCandidates(
        CommandInboxScopeSchema.parse({
          callerPrincipalId: source.callerPrincipalId,
          operation: source.operation,
          workspaceId: source.workspaceId,
          ...executionScopeFieldsFromRow(source),
          idempotencyKey: source.idempotencyKey,
        })
      )
      if (operation.scopeKey !== keys.legacyKey && operation.scopeKey !== keys.metadata.scopeKey)
        throw new Error('RETENTION_RETIRED_COMMAND_JOURNAL_MISMATCH')
      const [existingV2] = await transaction
        .select()
        .from(retiredCommandKeys)
        .where(eq(retiredCommandKeys.scopeKey, keys.metadata.scopeKey))
        .limit(1)
      if (existingV2 !== undefined) {
        if (
          existingV2.commandId !== operation.commandId ||
          existingV2.executionId !== operation.executionId ||
          existingV2.retiredAt.toISOString() !== operation.retiredAt ||
          existingV2.metadataVersion !== keys.metadata.metadataVersion ||
          existingV2.identityDigest !== keys.metadata.identityDigest ||
          retiredCommandKeyFromMetadataV2(existingV2.identityDigest ?? '') !== existingV2.scopeKey
        )
          throw new Error('RETENTION_RETIRED_COMMAND_STORED_MISMATCH')
        return false
      }
      await transaction.insert(retiredCommandKeys).values({
        scopeKey: keys.metadata.scopeKey,
        commandId: operation.commandId,
        executionId: operation.executionId,
        retiredAt,
        metadataVersion: keys.metadata.metadataVersion,
        identityDigest: keys.metadata.identityDigest,
      })
      return true
    })
  }
}
