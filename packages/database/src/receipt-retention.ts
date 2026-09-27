import {
  ExecutionCancellationReceiptSchema,
  InteractionCommandReceiptSchema,
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import { isDeepStrictEqual } from 'node:util'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { executionEvents } from './schema/events.js'
import { executionAttempts, executions } from './schema/executions.js'
import { executionCancellations } from './schema/execution-cancellations.js'
import { interactionRequests } from './schema/interactions.js'
import { interactionCommands } from './schema/interaction-commands.js'
import { reconciliationCheckpoints } from './schema/reconciliation.js'

const terminalStates = new Set(['completed', 'failed', 'cancelled', 'timed_out'])
const completedCheckpointStates = new Set(['remediated', 'resolved'])

function receiptExpiry(
  acceptedAt: string | undefined,
  settledAt: string | undefined,
  retainMs: number | null
): string | undefined {
  if (acceptedAt === undefined || retainMs === null) return undefined
  const accepted = Date.parse(acceptedAt)
  if (Number.isNaN(accepted)) return undefined
  const settled = settledAt === undefined ? Number.NaN : Date.parse(settledAt)
  return new Date(
    Math.max(accepted, Number.isNaN(settled) ? accepted : settled) + retainMs
  ).toISOString()
}

/**
 * Retention deletion for the interaction and cancellation receipts (#194), one
 * class because they share one policy decision and one lifecycle.
 *
 * The ordering proof is confirmation plus owner settlement. A receipt is
 * reserved before its signal is dispatched and records acceptance afterwards;
 * an **unconfirmed** receipt is the identity that lets a lost-acknowledgement
 * retry be recognised, so it is never a candidate. A confirmed receipt becomes
 * eligible only after both acceptance and terminal settlement have aged through
 * the replay window. The receipt, owner and settlement rows are locked and
 * revalidated in the deletion transaction.
 *
 * The delete is guarded by the full receipt identity snapshot that was read,
 * so a receipt changed underneath the pass is reported as `raced` rather than
 * removed on stale evidence. `dryRun` defaults to true.
 */
export class PostgresReceiptRetention {
  constructor(readonly database: ControlPlaneDatabase) {}

  /** Sweeps both receipt tables, because they are one class. */
  async sweepEligibleInteractionReceipts(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('RECEIPT_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter(
      'interaction-receipts',
      assessedAt,
      options.bound ?? 64
    )
    const interactions = await this.#sweepTable('interaction', now, options, counter)
    const cancellations = await this.#sweepTable('cancellation', now, options, counter)
    return {
      dryRun,
      deleted: interactions.deleted + cancellations.deleted,
      raced: interactions.raced + cancellations.raced,
      ...counter.result(),
    }
  }

  async #sweepTable(
    kind: 'interaction' | 'cancellation',
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
    },
    counter: RetentionAssessmentCounter
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('RECEIPT_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    let deleted = 0
    let raced = 0
    const table = kind === 'interaction' ? interactionCommands : executionCancellations
    const candidates = await this.database
      .select({
        commandKey: table.commandKey,
        receipt: table.receipt,
      })
      .from(table)
      .where(
        options.policyRetainMs === null
          ? sql`true`
          : lt(table.createdAt, new Date(now.getTime() - options.policyRetainMs))
      )
      .orderBy(asc(table.createdAt))
      .limit(counter.bound + 1)
    for (const candidate of candidates) {
      const outcome = await this.database.transaction(async (transaction) => {
        // Discover the owner without a lock first, then lock it before the
        // receipt. This keeps the lock order consistent with execution
        // retention and avoids deleting from stale pre-scan facts.
        const [observed] = await transaction
          .select()
          .from(table)
          .where(eq(table.commandKey, candidate.commandKey))
        if (!observed)
          return {
            admitted: false,
            attemptedDelete: false,
            removed: false,
            vanished: true,
            changed: false,
            overflow: false,
          }

        const parsedReceipt =
          kind === 'interaction'
            ? InteractionCommandReceiptSchema.safeParse(observed.receipt)
            : ExecutionCancellationReceiptSchema.safeParse(observed.receipt)
        const observedReceipt = parsedReceipt.success ? parsedReceipt.data : undefined
        let ownerTerminal = false
        let ownerSettled = false
        let settledAt: string | undefined
        let ownerExecutionId: string | undefined
        let ownerWorkspaceId: string | undefined
        let ownerProjectId: string | undefined
        let interactionId: string | undefined
        if (
          observedReceipt !== undefined &&
          observed.workspaceId === observedReceipt.request.workspaceId &&
          observed.projectId === observedReceipt.request.projectId
        ) {
          const request = observedReceipt.request
          const payload = request.payload as {
            readonly executionId: string
            readonly attemptId?: string
            readonly interactionId?: string
          }
          ownerExecutionId = payload.executionId
          ownerWorkspaceId = request.workspaceId
          ownerProjectId = request.projectId
          interactionId = payload.interactionId
          if (kind === 'interaction') {
            const [interaction] =
              interactionId === undefined
                ? []
                : await transaction
                    .select({ executionId: interactionRequests.executionId })
                    .from(interactionRequests)
                    .where(eq(interactionRequests.interactionId, interactionId))
            if (interaction !== undefined) ownerExecutionId = interaction.executionId
            else ownerExecutionId = undefined
          }
          if (ownerExecutionId !== undefined) {
            const [owner] = await transaction
              .select()
              .from(executions)
              .where(eq(executions.executionId, ownerExecutionId))
              .for('update')
            let interactionMatches = true
            if (kind === 'interaction') {
              const [interaction] =
                interactionId === undefined
                  ? []
                  : await transaction
                      .select()
                      .from(interactionRequests)
                      .where(eq(interactionRequests.interactionId, interactionId))
                      .for('update')
              interactionMatches =
                interactionId !== undefined &&
                payload.attemptId !== undefined &&
                interaction !== undefined &&
                interaction.interactionId === interactionId &&
                interaction.executionId === payload.executionId &&
                interaction.executionId === ownerExecutionId &&
                interaction.attemptId === payload.attemptId
            }
            if (
              interactionMatches &&
              owner !== undefined &&
              owner.executionId === ownerExecutionId &&
              owner.workspaceId === ownerWorkspaceId &&
              owner.projectId === ownerProjectId
            ) {
              ownerTerminal = terminalStates.has(owner.state) && owner.terminalAt !== null
              const settlementInstants: string[] = []
              if (owner.terminalAt !== null) settlementInstants.push(owner.terminalAt.toISOString())
              if (ownerTerminal) {
                const attempts = await transaction
                  .select({
                    attemptId: executionAttempts.attemptId,
                    executionId: executionAttempts.executionId,
                    state: executionAttempts.state,
                    terminalAt: executionAttempts.terminalAt,
                  })
                  .from(executionAttempts)
                  .where(eq(executionAttempts.executionId, ownerExecutionId))
                  .for('update')
                const checkpoints = await transaction
                  .select({
                    state: reconciliationCheckpoints.state,
                    pendingEventCount: reconciliationCheckpoints.pendingEventCount,
                    resolvedAt: reconciliationCheckpoints.resolvedAt,
                    updatedAt: reconciliationCheckpoints.updatedAt,
                  })
                  .from(reconciliationCheckpoints)
                  .where(eq(reconciliationCheckpoints.executionId, ownerExecutionId))
                  .for('update')
                const events = await transaction
                  .select({
                    publicationStatus: executionEvents.publicationStatus,
                    archivedAt: executionEvents.archivedAt,
                    publishedAt: executionEvents.publishedAt,
                    quarantinedAt: executionEvents.quarantinedAt,
                  })
                  .from(executionEvents)
                  .where(eq(executionEvents.executionId, ownerExecutionId))
                  .for('update')
                const interactionAttemptSettled =
                  kind !== 'interaction' ||
                  (payload.attemptId !== undefined &&
                    attempts.some(
                      (attempt) =>
                        attempt.executionId === ownerExecutionId &&
                        attempt.attemptId === payload.attemptId &&
                        terminalStates.has(attempt.state) &&
                        attempt.terminalAt !== null
                    ))
                ownerSettled =
                  interactionAttemptSettled &&
                  attempts.length === owner.attemptCount &&
                  attempts.every((attempt) => {
                    if (!terminalStates.has(attempt.state) || attempt.terminalAt === null)
                      return false
                    settlementInstants.push(attempt.terminalAt.toISOString())
                    return true
                  }) &&
                  checkpoints.every((checkpoint) => {
                    if (
                      !completedCheckpointStates.has(checkpoint.state) ||
                      checkpoint.pendingEventCount > 0
                    )
                      return false
                    settlementInstants.push(
                      (checkpoint.resolvedAt ?? checkpoint.updatedAt).toISOString()
                    )
                    return true
                  }) &&
                  !events.some(
                    (event) =>
                      (event.archivedAt === null && event.publicationStatus !== 'published') ||
                      (event.publicationStatus === 'published' && event.publishedAt === null) ||
                      (event.publicationStatus === 'quarantined' &&
                        event.archivedAt !== null &&
                        event.quarantinedAt === null)
                  )
                if (ownerSettled) {
                  for (const event of events) {
                    if (event.publicationStatus === 'published' && event.publishedAt !== null)
                      settlementInstants.push(event.publishedAt.toISOString())
                    else if (
                      event.publicationStatus === 'quarantined' &&
                      event.quarantinedAt !== null
                    ) {
                      settlementInstants.push(event.quarantinedAt.toISOString())
                    }
                    if (event.archivedAt !== null)
                      settlementInstants.push(event.archivedAt.toISOString())
                  }
                }
                settledAt = settlementInstants.toSorted(
                  (left, right) => Date.parse(right) - Date.parse(left)
                )[0]
              }
            }
          }
        }

        // The receipt itself is locked after its owner so another writer cannot
        // change confirmation or payload between owner resolution and deletion.
        const [stored] = await transaction
          .select()
          .from(table)
          .where(eq(table.commandKey, candidate.commandKey))
          .for('update')
        if (!stored)
          return {
            admitted: false,
            attemptedDelete: false,
            removed: false,
            vanished: true,
            changed: false,
            overflow: false,
          }
        if (!isDeepStrictEqual(stored.receipt, observed.receipt))
          return {
            admitted: false,
            attemptedDelete: false,
            removed: false,
            vanished: false,
            changed: true,
            overflow: false,
          }
        const receipt = parsedReceipt.success ? parsedReceipt.data : undefined
        const acceptedAt = receipt?.acceptedAt
        const verdict = evaluateRetentionEligibility({
          retentionExpiresAt: receiptExpiry(acceptedAt, settledAt, options.policyRetainMs),
          now: assessedAt,
          policyRetainMs: options.policyRetainMs,
          confirmed: receipt !== undefined && acceptedAt !== undefined,
          ownerTerminal,
          publicationSettled: ownerSettled,
          rejectionKeyReserved: true,
          pendingReferences: 0,
          holds: 0,
        })
        if (!counter.add(verdict))
          return {
            admitted: false,
            attemptedDelete: false,
            removed: false,
            vanished: false,
            changed: false,
            overflow: true,
          }
        if (verdict.verdict !== 'eligible' || dryRun)
          return {
            admitted: true,
            attemptedDelete: false,
            removed: false,
            vanished: false,
            changed: false,
            overflow: false,
          }
        if (options.journal !== undefined) {
          await options.journal([
            kind === 'interaction'
              ? { kind: 'postgres.deleteInteractionReceipt', commandKey: candidate.commandKey }
              : { kind: 'postgres.deleteCancellationReceipt', commandKey: candidate.commandKey },
          ])
        }
        const removed = await transaction
          .delete(table)
          .where(
            and(
              eq(table.commandKey, candidate.commandKey),
              sql`${table.receipt} = ${JSON.stringify(stored.receipt)}::jsonb`
            )
          )
          .returning({ commandKey: table.commandKey })
        return {
          admitted: true,
          attemptedDelete: true,
          removed: removed.length === 1,
          vanished: false,
          changed: false,
          overflow: false,
        }
      })
      if (outcome.overflow) break
      if (outcome.vanished) {
        raced += 1
        continue
      }
      if (outcome.changed) {
        raced += 1
        continue
      }
      if (!outcome.admitted) break
      if (outcome.removed) deleted += 1
      else if (outcome.attemptedDelete) raced += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }
}
