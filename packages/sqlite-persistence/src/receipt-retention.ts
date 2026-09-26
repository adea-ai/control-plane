import {
  ExecutionCancellationReceiptSchema,
  InteractionCommandReceiptSchema,
  RetentionAssessmentCounter,
  RetentionJournalOperationSchema,
  acceptedInstant,
  evaluateRetentionEligibility,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import type { PersistenceProvider } from '@control-plane/deployment'

const namespaces = {
  interactions: 'interaction-command-receipts',
  cancellations: 'execution-cancellation-receipts',
} as const

/**
 * Retention deletion for the interaction and cancellation receipts (#194), one
 * class because they share one policy decision and one lifecycle. Each receipt
 * is reserved before its signal is dispatched and records acceptance
 * afterwards: an **unconfirmed** receipt is the identity that lets a
 * lost-acknowledgement retry be recognised and is never a candidate, while a
 * confirmed receipt becomes one after the replay window, measured from its
 * acceptance instant. Deletion is revision-guarded and journalled.
 */
export class SqliteReceiptRetention {
  constructor(readonly provider: PersistenceProvider) {}

  /** Sweeps both receipt namespaces, because they are one class. */
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
    const interactions = await this.#sweepNamespace('interactions', now, options, counter)
    const cancellations = await this.#sweepNamespace('cancellations', now, options, counter)
    return {
      dryRun,
      deleted: interactions.deleted + cancellations.deleted,
      raced: interactions.raced + cancellations.raced,
      ...counter.result(),
    }
  }

  async #sweepNamespace(
    kind: 'interactions' | 'cancellations',
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
    const namespace = namespaces[kind]
    let afterId: string | undefined
    let done = false
    while (!done) {
      const page = await this.provider.transaction((transaction) =>
        transaction.scan(namespace, {
          limit: 128,
          ...(afterId === undefined ? {} : { afterId }),
        })
      )
      if (page.length === 0) break
      afterId = page[page.length - 1]?.id
      for (const record of page) {
        const outcome = await this.provider.transaction(async (transaction) => {
          const stored = await transaction.get(namespace, record.id)
          if (stored === undefined)
            return { verdict: undefined, admitted: false, removed: false }
          const accepted = acceptedInstant(stored.value)
          const verdict = evaluateRetentionEligibility({
            retentionExpiresAt:
              accepted === undefined || options.policyRetainMs === null
                ? undefined
                : new Date(Date.parse(accepted) + options.policyRetainMs).toISOString(),
            now: assessedAt,
            policyRetainMs: options.policyRetainMs,
            confirmed: accepted !== undefined,
            ownerTerminal: true,
            publicationSettled: true,
            rejectionKeyReserved: true,
            pendingReferences: 0,
            holds: 0,
          })
          if (!counter.add(verdict)) return { verdict, admitted: false, removed: false }
          if (verdict.verdict !== 'eligible' || dryRun)
            return { verdict, admitted: true, removed: false }
          if (options.journal !== undefined) {
            await options.journal(
              RetentionJournalOperationSchema.array().parse([
                { kind: 'sqlite.delete', namespace, id: stored.id },
              ])
            )
          }
          let removed = false
          try {
            removed = await transaction.delete(namespace, stored.id, stored.revision)
          } catch {
            return { verdict, admitted: true, removed: false }
          }
          return { verdict, admitted: true, removed }
        })
        if (outcome.verdict !== undefined && !outcome.admitted) {
          done = true
          break
        }
        if (outcome.removed) deleted += 1
      }
      if (page.length < 128) break
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }
}

/** Both receipt schemas, exported so tests can build fixtures that validate. */
export const receiptRetentionSchemas = {
  interaction: InteractionCommandReceiptSchema,
  cancellation: ExecutionCancellationReceiptSchema,
} as const
