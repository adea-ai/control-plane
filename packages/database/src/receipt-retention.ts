import {
  RetentionAssessmentCounter,
  acceptedInstant,
  evaluateRetentionEligibility,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { executionCancellations } from './schema/execution-cancellations.js'
import { interactionCommands } from './schema/interaction-commands.js'

/**
 * Retention deletion for the interaction and cancellation receipts (#194), one
 * class because they share one policy decision and one lifecycle.
 *
 * The ordering proof is confirmation. A receipt is reserved before its signal is
 * dispatched and records acceptance afterwards; an **unconfirmed** receipt is
 * the identity that lets a lost-acknowledgement retry be recognised, so it is
 * never a candidate. A confirmed receipt becomes one after the replay window,
 * measured from its acceptance instant, which is the horizon the coverage matrix
 * describes as "after confirmation, terminal reconciliation and replay-window
 * expiry".
 *
 * The delete is guarded by the acceptance instant that was read, so a receipt
 * confirmed underneath the pass is reported as `raced` rather than removed on
 * stale evidence. `dryRun` defaults to true.
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
      const acceptedAt = acceptedInstant(candidate.receipt)
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt:
          acceptedAt === undefined || options.policyRetainMs === null
            ? undefined
            : new Date(Date.parse(acceptedAt) + options.policyRetainMs).toISOString(),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        confirmed: acceptedAt !== undefined,
        ownerTerminal: true,
        publicationSettled: true,
        rejectionKeyReserved: true,
        pendingReferences: 0,
        holds: 0,
      })
      if (!counter.add(verdict)) break
      if (verdict.verdict !== 'eligible' || dryRun || acceptedAt === undefined) continue
      if (options.journal !== undefined) {
        await options.journal([
          kind === 'interaction'
            ? { kind: 'postgres.deleteInteractionReceipt', commandKey: candidate.commandKey }
            : { kind: 'postgres.deleteCancellationReceipt', commandKey: candidate.commandKey },
        ])
      }
      const removed = await this.database
        .delete(table)
        .where(
          and(
            eq(table.commandKey, candidate.commandKey),
            sql`${table.receipt}->>'acceptedAt' = ${acceptedAt}`
          )
        )
        .returning({ commandKey: table.commandKey })
      if (removed.length === 1) deleted += 1
      else raced += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }
}
