import { createHash } from 'node:crypto'
import {
  ExecutionAttemptSchema,
  ExecutionCancellationReceiptSchema,
  ExecutionSchema,
  InteractionCommandReceiptSchema,
  InteractionRequestSchema,
  ReconciliationCheckpointSchema,
  RetentionAssessmentCounter,
  RetentionJournalOperationSchema,
  evaluateRetentionEligibility,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import type { PersistenceProvider } from '@control-plane/deployment'
import { ExecutionEventSchema } from '@control-plane/events'

const namespaces = {
  interactions: 'interaction-command-receipts',
  cancellations: 'execution-cancellation-receipts',
  executions: 'executions',
} as const
const recordId = (id: string) => `r-${createHash('sha256').update(id).digest('hex')}`
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'timed_out'])
const completedCheckpointStates = new Set(['remediated', 'resolved'])

function receiptExpiry(
  acceptedAt: string | undefined,
  settledAt: string | undefined,
  retainMs: number | null
) {
  if (acceptedAt === undefined || retainMs === null) return undefined
  const accepted = Date.parse(acceptedAt)
  const settled = settledAt === undefined ? Number.NaN : Date.parse(settledAt)
  if (Number.isNaN(accepted)) return undefined
  return new Date(
    Math.max(accepted, Number.isNaN(settled) ? accepted : settled) + retainMs
  ).toISOString()
}

/**
 * Retention deletion for the interaction and cancellation receipts (#194), one
 * class because they share one policy decision and one lifecycle. Each receipt
 * is reserved before its signal is dispatched and records acceptance
 * afterwards: an **unconfirmed** receipt is the identity that lets a
 * lost-acknowledgement retry be recognised and is never a candidate. A
 * confirmed receipt becomes eligible only after both its acceptance and its
 * owning execution's terminal settlement have aged through the replay window.
 * Owner facts and deletion are checked in the same SQLite transaction.
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
          if (stored === undefined) return { verdict: undefined, admitted: false, removed: false }
          const parsedReceipt =
            kind === 'interactions'
              ? InteractionCommandReceiptSchema.safeParse(stored.value)
              : ExecutionCancellationReceiptSchema.safeParse(stored.value)
          const receipt = parsedReceipt.success ? parsedReceipt.data : undefined
          const accepted = receipt?.acceptedAt
          let ownerTerminal = false
          let ownerSettled = false
          let terminalAt: string | undefined
          if (receipt !== undefined) {
            const request = receipt.request
            const payload = request.payload as {
              readonly executionId: string
              readonly attemptId?: string
              readonly interactionId?: string
            }
            let executionId = payload.executionId
            let relationshipValid = true
            if (kind === 'interactions') {
              const interactionId = payload.interactionId
              const interactionRow = await transaction.get(
                'interaction-requests',
                recordId(interactionId ?? '')
              )
              const interaction =
                interactionRow === undefined
                  ? undefined
                  : InteractionRequestSchema.safeParse(interactionRow.value)
              relationshipValid =
                interactionId !== undefined &&
                payload.attemptId !== undefined &&
                interaction?.success === true &&
                interaction.data.interactionId === interactionId &&
                interaction.data.executionId === request.payload.executionId &&
                interaction.data.attemptId === payload.attemptId
              if (interaction?.success) executionId = interaction.data.executionId
            }
            if (relationshipValid) {
              const ownerRow = await transaction.get(namespaces.executions, recordId(executionId))
              const owner =
                ownerRow === undefined ? undefined : ExecutionSchema.safeParse(ownerRow.value)
              if (
                owner?.success &&
                owner.data.executionId === executionId &&
                owner.data.correlation.workspaceId === request.workspaceId &&
                owner.data.correlation.projectId === request.projectId
              ) {
                terminalAt = owner.data.terminalAt
                ownerTerminal = terminalStates.has(owner.data.state) && terminalAt !== undefined
                if (ownerTerminal) {
                  const attemptRows = await transaction.list('execution-attempts')
                  const attempts = []
                  let malformedAttempt = false
                  const settlementInstants = [terminalAt]
                  for (const attemptRow of attemptRows) {
                    const parsedAttempt = ExecutionAttemptSchema.safeParse(attemptRow.value)
                    if (parsedAttempt.success && parsedAttempt.data.executionId === executionId) {
                      attempts.push(parsedAttempt.data)
                      if (parsedAttempt.data.terminalAt !== undefined)
                        settlementInstants.push(parsedAttempt.data.terminalAt)
                    } else if (
                      !parsedAttempt.success &&
                      (attemptRow.value as { executionId?: unknown } | null)?.executionId ===
                        executionId
                    ) {
                      malformedAttempt = true
                    }
                  }
                  const checkpointRows = await transaction.list('reconciliation-checkpoints')
                  let pendingReconciliation = false
                  let pendingTerminalEvents = false
                  for (const checkpointRow of checkpointRows) {
                    const parsedCheckpoint = ReconciliationCheckpointSchema.safeParse(
                      checkpointRow.value
                    )
                    if (
                      parsedCheckpoint.success &&
                      parsedCheckpoint.data.executionId === executionId &&
                      (!completedCheckpointStates.has(parsedCheckpoint.data.state) ||
                        parsedCheckpoint.data.pendingEventCount > 0)
                    ) {
                      pendingReconciliation = true
                    } else if (
                      parsedCheckpoint.success &&
                      parsedCheckpoint.data.executionId === executionId
                    ) {
                      settlementInstants.push(
                        parsedCheckpoint.data.resolvedAt ?? parsedCheckpoint.data.updatedAt
                      )
                    } else if (
                      !parsedCheckpoint.success &&
                      (checkpointRow.value as { executionId?: unknown } | null)?.executionId ===
                        executionId
                    ) {
                      pendingReconciliation = true
                    }
                  }
                  const eventRows = await transaction.list('execution-events')
                  for (const eventRow of eventRows) {
                    const parsedEvent = ExecutionEventSchema.safeParse(eventRow.value)
                    if (parsedEvent.success && parsedEvent.data.executionId === executionId) {
                      if (
                        parsedEvent.data.archivedAt === undefined &&
                        parsedEvent.data.publication.status !== 'published'
                      ) {
                        pendingTerminalEvents = true
                      }
                      if (parsedEvent.data.publication.status === 'published') {
                        if (parsedEvent.data.publication.publishedAt === undefined) {
                          pendingTerminalEvents = true
                        } else {
                          settlementInstants.push(parsedEvent.data.publication.publishedAt)
                        }
                      } else if (
                        parsedEvent.data.publication.status === 'quarantined' &&
                        parsedEvent.data.archivedAt !== undefined
                      ) {
                        if (parsedEvent.data.publication.quarantinedAt === undefined) {
                          pendingTerminalEvents = true
                        } else {
                          settlementInstants.push(parsedEvent.data.publication.quarantinedAt)
                        }
                      }
                      if (parsedEvent.data.archivedAt !== undefined)
                        settlementInstants.push(parsedEvent.data.archivedAt)
                    } else if (
                      !parsedEvent.success &&
                      (eventRow.value as { executionId?: unknown } | null)?.executionId ===
                        executionId
                    ) {
                      pendingTerminalEvents = true
                    }
                  }
                  const latestSettlement = settlementInstants
                    .filter((instant): instant is string => instant !== undefined)
                    .toSorted((left, right) => Date.parse(right) - Date.parse(left))[0]
                  const interactionAttemptSettled =
                    kind !== 'interactions' ||
                    (payload.attemptId !== undefined &&
                      attempts.some(
                        (attempt) =>
                          attempt.executionId === executionId &&
                          attempt.attemptId === payload.attemptId &&
                          terminalStates.has(attempt.state) &&
                          attempt.terminalAt !== undefined
                      ))
                  ownerSettled =
                    interactionAttemptSettled &&
                    !malformedAttempt &&
                    attempts.length === owner.data.attemptCount &&
                    attempts.every((attempt) => terminalStates.has(attempt.state)) &&
                    !pendingReconciliation &&
                    !pendingTerminalEvents
                  if (latestSettlement !== undefined) terminalAt = latestSettlement
                }
              }
            }
          }
          const verdict = evaluateRetentionEligibility({
            retentionExpiresAt: receiptExpiry(accepted, terminalAt, options.policyRetainMs),
            now: assessedAt,
            policyRetainMs: options.policyRetainMs,
            confirmed: receipt !== undefined && accepted !== undefined,
            ownerTerminal,
            publicationSettled: ownerSettled,
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
