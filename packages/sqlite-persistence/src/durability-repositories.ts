import { createHash } from 'node:crypto'
import { compareCodePointOrder } from '@control-plane/contracts'
import { isDeepStrictEqual } from 'node:util'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import {
  ExecutionAttemptSchema,
  executionRetentionScope,
  executionScopesEqual,
  ExecutionSchema,
  ReconciliationCheckpointSchema,
  RuntimeCommandRecordSchema,
  RetentionAssessmentCounter,
  StatePromotionProposalSchema,
  type RetentionDeletionResult,
  type RetentionJournalSink,
  type RetentionHoldPolicy,
  type CredentialRevocationFence,
  RetentionJournalOperationSchema,
  evaluateRetentionEligibility,
  type RetentionAssessment,
  runtimeCommandRecordsShareIdentity,
  type ReconciliationCheckpoint,
  type ReconciliationCheckpointRepository,
  type RuntimeCommandCreateResult,
  type RuntimeCommandRecord,
  type RuntimeCommandRepository,
  type StatePromotionProposal,
  type StatePromotionProposalRepository,
} from '@control-plane/domain'
import {
  ExecutionEventDraftSchema,
  ExecutionEventSchema,
  hashExecutionEventPayloadV2,
  sanitizeExecutionEventDraft,
  type ExecutionEvent,
  type ExecutionEventDraft,
  type ExecutionEventRepository,
  type RuntimeEventEffectResult,
  type RuntimeEventEffectSink,
  type RuntimeProgressEffect,
  type RuntimeTerminalEffect,
} from '@control-plane/events'
import {
  RuntimeInventoryCheckpointSchema,
  type RuntimeInventoryCheckpoint,
  type RuntimeInventoryCheckpointRepository,
} from '@control-plane/runtime-sdk'
import { countSqliteMatchingActiveRetentionHolds } from './retention-hold-repository.js'

/** The command a stored event receipt belongs to, when the value carries one. */
function receiptCommandId(value: unknown): string | undefined {
  const candidate = value as { commandId?: unknown } | null
  return typeof candidate?.commandId === 'string' ? candidate.commandId : undefined
}

const terminalExecutionStates = new Set<string>(['completed', 'failed', 'cancelled', 'timed_out'])

const namespaces = {
  events: 'execution-events',
  executions: 'executions',
  retiredEventIds: 'retired-execution-event-ids',
  proposals: 'state-promotion-proposals',
  reconciliation: 'reconciliation-checkpoints',
  runtimeCommands: 'runtime-commands',
  runtimeInventory: 'runtime-inventory-checkpoints',
  runtimeEventReceipts: 'runtime-event-receipts',
} as const

type RecordTransaction = Parameters<Parameters<PersistenceProvider['transaction']>[0]>[0]

export class SqliteStatePromotionProposalRepository implements StatePromotionProposalRepository {
  constructor(readonly provider: PersistenceProvider) {}

  insert(input: StatePromotionProposal): Promise<boolean> {
    const proposal = StatePromotionProposalSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(proposal.proposalId)
      if ((await transaction.get(namespaces.proposals, id)) !== undefined) return false
      await transaction.put({ namespace: namespaces.proposals, id, value: json(proposal) })
      return true
    })
  }

  get(proposalId: string): Promise<StatePromotionProposal | undefined> {
    StatePromotionProposalSchema.shape.proposalId.parse(proposalId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.proposals, recordId(proposalId))
      return record === undefined ? undefined : StatePromotionProposalSchema.parse(record.value)
    })
  }

  compareAndSet(expectedRevision: number, input: StatePromotionProposal): Promise<boolean> {
    const proposal = StatePromotionProposalSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(proposal.proposalId)
      const record = await transaction.get(namespaces.proposals, id)
      if (record === undefined) return false
      const current = StatePromotionProposalSchema.parse(record.value)
      if (current.revision !== expectedRevision || !sameProposalIdentity(current, proposal)) {
        return false
      }
      await transaction.put({
        namespace: namespaces.proposals,
        id,
        expectedRevision: record.revision,
        value: json(proposal),
      })
      return true
    })
  }
}

export class SqliteExecutionEventRepository implements ExecutionEventRepository {
  constructor(readonly provider: PersistenceProvider) {}

  /**
   * Read-only eligibility assessment for the execution-events class (#194).
   * Bounded paging over the namespace, evaluating each expired candidate from
   * the shared predicate: the owning execution must be terminal and the
   * publication settled (pending, failed and quarantined deliveries remain
   * reconciliation work). Never deletes.
   */
  async assessExpiredEvents(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly retentionHoldPolicy?: RetentionHoldPolicy
    }
  ): Promise<RetentionAssessment> {
    if (Number.isNaN(now.getTime())) throw new Error('EVENT_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const counter = new RetentionAssessmentCounter(
      'execution-events',
      assessedAt,
      options.bound ?? 256
    )
    let afterId: string | undefined
    let done = false
    while (!done) {
      const page = await this.provider.transaction((transaction) =>
        transaction.scan(namespaces.events, {
          limit: 128,
          ...(afterId === undefined ? {} : { afterId }),
        })
      )
      if (page.length === 0) break
      afterId = page[page.length - 1]?.id
      const candidates = page
        .map((record) => ExecutionEventSchema.parse(record.value))
        .filter((event) => expiredAt(event.retentionExpiresAt, now))
      const verdicts = await this.provider.transaction(async (transaction) => {
        const resolved: ReturnType<typeof evaluateRetentionEligibility>[] = []
        for (const event of candidates) {
          const execution = await transaction.get(
            namespaces.executions,
            recordId(event.executionId)
          )
          const owner = execution === undefined ? undefined : ExecutionSchema.parse(execution.value)
          const state = owner?.state
          const scope =
            owner?.executionId === event.executionId &&
            executionScopesEqual(owner.correlation, event.correlation)
              ? executionRetentionScope(owner.correlation)
              : undefined
          const holds = await countSqliteMatchingActiveRetentionHolds(
            transaction,
            {
              classId: 'execution-events',
              ...(scope === undefined ? {} : { scope }),
            },
            options.retentionHoldPolicy
          )
          resolved.push(
            evaluateRetentionEligibility({
              retentionExpiresAt: event.retentionExpiresAt,
              now: assessedAt,
              policyRetainMs: options.policyRetainMs,
              ownerTerminal: state !== undefined && terminalExecutionStates.has(state),
              publicationSettled: event.publication.status === 'published',
              rejectionKeyReserved: true,
              pendingReferences: 0,
              holds,
            })
          )
        }
        return resolved
      })
      for (const verdict of verdicts) {
        if (!counter.add(verdict)) {
          done = true
          break
        }
      }
      if (page.length < 128) break
    }
    return counter.result()
  }

  /**
   * Deletes expired, eligible execution events (#194) while preserving their
   * deduplication identity: the event id and sequence are recorded as retired
   * in the same transaction that removes the row, so a retry cannot resurrect
   * the event and its sequence number is never reused. `dryRun` defaults true.
   */
  async deleteEligibleEvents(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      /** Journal sink; called with each candidate's effects before they apply. */
      readonly journal?: RetentionJournalSink
      readonly retentionHoldPolicy?: RetentionHoldPolicy
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('EVENT_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter(
      'execution-events',
      assessedAt,
      options.bound ?? 64
    )
    let deleted = 0
    let raced = 0
    let afterId: string | undefined
    let done = false
    while (!done) {
      const page = await this.provider.transaction((transaction) =>
        transaction.scan(namespaces.events, {
          limit: 128,
          ...(afterId === undefined ? {} : { afterId }),
        })
      )
      if (page.length === 0) break
      afterId = page[page.length - 1]?.id
      const candidates = page
        .map((record) => ({ record, event: ExecutionEventSchema.parse(record.value) }))
        .filter(({ event }) => expiredAt(event.retentionExpiresAt, now))
      for (const candidate of candidates) {
        const outcome = await this.provider.transaction(async (transaction) => {
          const stored = await transaction.get(namespaces.events, candidate.record.id)
          if (stored === undefined)
            return { verdict: undefined, admitted: false, removed: false, conflicted: false }
          const event = ExecutionEventSchema.parse(stored.value)
          const execution = await transaction.get(
            namespaces.executions,
            recordId(event.executionId)
          )
          const owner = execution === undefined ? undefined : ExecutionSchema.parse(execution.value)
          const state = owner?.state
          const scope =
            owner?.executionId === event.executionId &&
            executionScopesEqual(owner.correlation, event.correlation)
              ? executionRetentionScope(owner.correlation)
              : undefined
          const holds = await countSqliteMatchingActiveRetentionHolds(
            transaction,
            {
              classId: 'execution-events',
              ...(scope === undefined ? {} : { scope }),
            },
            options.retentionHoldPolicy
          )
          const verdict = evaluateRetentionEligibility({
            retentionExpiresAt: event.retentionExpiresAt,
            now: assessedAt,
            policyRetainMs: options.policyRetainMs,
            ownerTerminal: state !== undefined && terminalExecutionStates.has(state),
            publicationSettled: event.publication.status === 'published',
            rejectionKeyReserved: true,
            pendingReferences: 0,
            holds,
          })
          if (!counter.add(verdict)) {
            return { verdict, admitted: false, removed: false, conflicted: false }
          }
          if (verdict.verdict !== 'eligible' || dryRun) {
            return { verdict, admitted: true, removed: false, conflicted: false }
          }
          // The retirement identity is what a restored snapshot must regain.
          // Admit this candidate before journalling or mutating either record.
          if (options.journal !== undefined) {
            await options.journal([
              {
                kind: 'sqlite.put',
                namespace: namespaces.retiredEventIds,
                id: stored.id,
                value: {
                  eventId: event.eventId,
                  executionId: event.executionId,
                  sequence: event.sequence,
                  retiredAt: assessedAt,
                },
              },
              { kind: 'sqlite.delete', namespace: namespaces.events, id: stored.id },
            ])
          }
          const retired = await transaction.get(namespaces.retiredEventIds, stored.id)
          if (retired === undefined) {
            await transaction.put({
              namespace: namespaces.retiredEventIds,
              id: stored.id,
              value: {
                eventId: event.eventId,
                executionId: event.executionId,
                sequence: event.sequence,
                retiredAt: assessedAt,
              },
            })
          }
          const removed = await transaction.delete(namespaces.events, stored.id, stored.revision)
          return { verdict, admitted: true, removed, conflicted: !removed }
        })
        if (outcome.verdict !== undefined && !outcome.admitted) {
          done = true
          break
        }
        if (outcome.removed) deleted += 1
        if (outcome.conflicted) raced += 1
      }
      if (page.length < 128) break
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }

  /** Temporary safety containment until atomic full eligibility is implemented. */
  async deleteExpiredEvents(now: Date): Promise<number> {
    if (Number.isNaN(now.getTime())) throw new Error('EVENT_RETENTION_INVALID_TIMESTAMP')
    throw new Error('EVENT_RETENTION_ELIGIBILITY_REQUIRED')
  }

  append(input: ExecutionEventDraft): Promise<ExecutionEvent | undefined> {
    const draft = ExecutionEventDraftSchema.parse(input)
    return this.provider.transaction((transaction) => appendEvent(transaction, draft))
  }

  get(eventId: string): Promise<ExecutionEvent | undefined> {
    ExecutionEventSchema.shape.eventId.parse(eventId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.events, recordId(eventId))
      return record === undefined ? undefined : ExecutionEventSchema.parse(record.value)
    })
  }

  queryAfter(executionId: string, afterSequence: number, limit: number) {
    validLimit(limit)
    return this.provider.transaction(async (transaction) =>
      (await transaction.list(namespaces.events))
        .map((record) => ExecutionEventSchema.parse(record.value))
        .filter(
          (event) =>
            event.executionId === executionId &&
            event.sequence > afterSequence &&
            event.archivedAt === undefined
        )
        .toSorted((left, right) => left.sequence - right.sequence)
        .slice(0, limit)
    )
  }

  queryPending(limit: number, dueAt?: string) {
    validLimit(limit)
    if (dueAt !== undefined && Number.isNaN(Date.parse(dueAt))) throw new Error('INVALID_TIMESTAMP')
    return this.provider.transaction(async (transaction) =>
      (await transaction.list(namespaces.events))
        .map((record) => ExecutionEventSchema.parse(record.value))
        .filter(
          (event) =>
            ['pending', 'failed'].includes(event.publication.status) &&
            event.archivedAt === undefined &&
            (dueAt === undefined ||
              event.publication.nextAttemptAt === undefined ||
              event.publication.nextAttemptAt <= dueAt)
        )
        .toSorted((left, right) => compareCodePointOrder(left.recordedAt, right.recordedAt))
        .slice(0, limit)
    )
  }

  compareAndSetPublication(expectedVersion: number, input: ExecutionEvent): Promise<boolean> {
    const event = ExecutionEventSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(event.eventId)
      const record = await transaction.get(namespaces.events, id)
      if (record === undefined) return false
      const current = ExecutionEventSchema.parse(record.value)
      if (current.publication.version !== expectedVersion || !sameEventIdentity(current, event)) {
        return false
      }
      await transaction.put({
        namespace: namespaces.events,
        id,
        expectedRevision: record.revision,
        value: json(event),
      })
      return true
    })
  }

  archive(eventId: string, archivedAt: string): Promise<ExecutionEvent | undefined> {
    if (Number.isNaN(Date.parse(archivedAt))) throw new Error('INVALID_TIMESTAMP')
    return this.provider.transaction(async (transaction) => {
      const id = recordId(eventId)
      const record = await transaction.get(namespaces.events, id)
      if (record === undefined) return undefined
      const archived = ExecutionEventSchema.parse({
        ...ExecutionEventSchema.parse(record.value),
        archivedAt,
      })
      await transaction.put({
        namespace: namespaces.events,
        id,
        expectedRevision: record.revision,
        value: json(archived),
      })
      return archived
    })
  }

  /**
   * Bounded maintenance read for reconciliation: how many undelivered
   * (unarchived, pending or failed) events an execution still owes, capped at
   * `limit`. The count is a lower bound when the cap is reached.
   */
  summarizePendingDelivery(executionId: string, limit: number): Promise<PendingDeliverySummary> {
    ExecutionEventSchema.shape.executionId.parse(executionId)
    validLimit(limit)
    return this.provider.transaction(async (transaction) => {
      const pending = filterPendingDelivery(await listEvents(transaction), executionId)
      if (pending.length === 0) return { pendingCount: 0 }
      const oldest = pending[0]
      return {
        pendingCount: pending.slice(0, limit).length,
        ...(oldest === undefined ? {} : { oldestPendingAt: oldest.recordedAt }),
      }
    })
  }

  /**
   * Re-arms delivery for an execution's undelivered events that are not yet
   * due, without attempting delivery itself: publication versions move
   * forward via compare-and-set so a concurrent dispatcher never races.
   * Returns how many events were re-armed.
   */
  rearmPendingDelivery(executionId: string, dueAt: string, limit: number): Promise<number> {
    ExecutionEventSchema.shape.executionId.parse(executionId)
    if (Number.isNaN(Date.parse(dueAt))) throw new Error('INVALID_TIMESTAMP')
    validLimit(limit)
    return this.provider.transaction(async (transaction) => {
      const pending = filterPendingDelivery(await listEvents(transaction), executionId)
        .filter(
          (event) =>
            event.publication.nextAttemptAt === undefined || event.publication.nextAttemptAt > dueAt
        )
        .slice(0, limit)
      let rearmed = 0
      for (const event of pending) {
        const record = await transaction.get(namespaces.events, recordId(event.eventId))
        if (record === undefined) continue
        const updated = ExecutionEventSchema.parse({
          ...event,
          publication: {
            ...event.publication,
            version: event.publication.version + 1,
            nextAttemptAt: dueAt,
          },
        })
        try {
          await transaction.put({
            namespace: namespaces.events,
            id: recordId(event.eventId),
            expectedRevision: record.revision,
            value: json(updated),
          })
          rearmed += 1
        } catch (error) {
          // A concurrent publisher won the CAS; leave its schedule untouched.
          if (!(error instanceof Error && error.name === 'SqlitePersistenceError')) throw error
        }
      }
      return rearmed
    })
  }
}

export interface PendingDeliverySummary {
  /** Lower bound of undelivered events, capped at the requested scan limit. */
  readonly pendingCount: number
  readonly oldestPendingAt?: string
}

async function listEvents(transaction: RecordTransaction): Promise<ExecutionEvent[]> {
  return (await transaction.list(namespaces.events)).map((record) =>
    ExecutionEventSchema.parse(record.value)
  )
}

function filterPendingDelivery(events: readonly ExecutionEvent[], executionId: string) {
  return events
    .filter(
      (event) =>
        event.executionId === executionId &&
        event.archivedAt === undefined &&
        ['pending', 'failed'].includes(event.publication.status)
    )
    .toSorted((left, right) => compareCodePointOrder(left.recordedAt, right.recordedAt))
}

export class SqliteRuntimeEventEffectSink implements RuntimeEventEffectSink {
  constructor(readonly provider: PersistenceProvider) {}

  applyProgress(effect: RuntimeProgressEffect): Promise<RuntimeEventEffectResult> {
    return this.provider.transaction(async (transaction) => {
      const key = receiptKey(effect.commandId, 'progress', effect.eventSequence)
      const replay = await replayReceipt(transaction, key, effect.frameHash, effect.legacyFrameHash)
      if (replay !== undefined) return replay
      const latest = (await transaction.list(namespaces.runtimeEventReceipts))
        .map((record) => receipt(record.value))
        .filter(
          (candidate) =>
            candidate.commandId === effect.commandId &&
            candidate.messageKind === 'progress' &&
            candidate.outcome === 'applied'
        )
        .reduce((maximum, candidate) => Math.max(maximum, candidate.messageSequence), 0)
      if (effect.eventSequence <= latest) {
        await writeReceipt(transaction, key, {
          commandId: effect.commandId,
          messageKind: 'progress',
          messageSequence: effect.eventSequence,
          frameHash: effect.frameHash,
          outcome: 'out_of_order',
        })
        return { outcome: 'out_of_order' }
      }
      const event = await appendEvent(transaction, ExecutionEventDraftSchema.parse(effect.draft))
      if (event === undefined) throw new Error('RUNTIME_PROGRESS_EVENT_CONFLICT')
      await writeReceipt(transaction, key, {
        commandId: effect.commandId,
        messageKind: 'progress',
        messageSequence: effect.eventSequence,
        frameHash: effect.frameHash,
        outcome: 'applied',
        eventId: event.eventId,
      })
      return { outcome: 'applied', event }
    })
  }

  applyTerminal(effect: RuntimeTerminalEffect): Promise<RuntimeEventEffectResult> {
    return this.provider.transaction(async (transaction) => {
      const key = receiptKey(effect.commandId, 'terminal', effect.messageSequence)
      const replay = await replayReceipt(transaction, key, effect.frameHash, effect.legacyFrameHash)
      if (replay !== undefined) return replay
      const executionRecord = await transaction.get(
        'executions',
        recordId(effect.execution.executionId)
      )
      const attemptRecord = await transaction.get(
        'execution-attempts',
        recordId(effect.attempt.attemptId)
      )
      if (executionRecord === undefined || attemptRecord === undefined) {
        throw new Error('RUNTIME_TERMINAL_CONTEXT_MISSING')
      }
      const execution = ExecutionSchema.parse(executionRecord.value)
      const attempt = ExecutionAttemptSchema.parse(attemptRecord.value)
      const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out'])
      if (terminal.has(execution.state) || terminal.has(attempt.state)) {
        const event = await eventById(transaction, effect.draft.eventId)
        const duplicate =
          execution.state === effect.state && attempt.state === effect.state && event !== undefined
        await writeReceipt(transaction, key, {
          commandId: effect.commandId,
          messageKind: 'terminal',
          messageSequence: effect.messageSequence,
          frameHash: effect.frameHash,
          outcome: duplicate ? 'applied' : 'terminal_conflict',
          ...(event === undefined ? {} : { eventId: event.eventId }),
        })
        return duplicate ? { outcome: 'duplicate', event } : { outcome: 'terminal_conflict' }
      }
      const nextAttempt = ExecutionAttemptSchema.parse({
        ...attempt,
        state: effect.state,
        version: attempt.version + 1,
        terminalAt: effect.draft.occurredAt,
        updatedAt: effect.draft.occurredAt,
        ...(effect.failure === undefined ? {} : { failure: effect.failure }),
        ...(effect.resultReference === undefined
          ? {}
          : { terminalResultRef: effect.resultReference }),
      })
      const nextExecution = ExecutionSchema.parse({
        ...execution,
        state: effect.state,
        version: execution.version + 1,
        terminalAt: effect.draft.occurredAt,
        updatedAt: effect.draft.occurredAt,
        ...(effect.failure === undefined ? {} : { failure: effect.failure }),
        ...(effect.resultReference === undefined
          ? {}
          : { terminalResultRef: effect.resultReference }),
      })
      await transaction.put({
        namespace: 'execution-attempts',
        id: attemptRecord.id,
        expectedRevision: attemptRecord.revision,
        value: json(nextAttempt),
      })
      await transaction.put({
        namespace: 'executions',
        id: executionRecord.id,
        expectedRevision: executionRecord.revision,
        value: json(nextExecution),
      })
      const event = await appendEvent(transaction, ExecutionEventDraftSchema.parse(effect.draft))
      if (event === undefined) throw new Error('RUNTIME_TERMINAL_EVENT_CONFLICT')
      await writeReceipt(transaction, key, {
        commandId: effect.commandId,
        messageKind: 'terminal',
        messageSequence: effect.messageSequence,
        frameHash: effect.frameHash,
        outcome: 'applied',
        eventId: event.eventId,
      })
      return { outcome: 'applied', event }
    })
  }
}

export class SqliteReconciliationCheckpointRepository implements ReconciliationCheckpointRepository {
  constructor(readonly provider: PersistenceProvider) {}

  getByObservationHash(hash: string): Promise<ReconciliationCheckpoint | undefined> {
    ReconciliationCheckpointSchema.shape.observationHash.parse(hash)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.reconciliation, recordId(hash))
      return record === undefined ? undefined : ReconciliationCheckpointSchema.parse(record.value)
    })
  }

  insert(input: ReconciliationCheckpoint): Promise<boolean> {
    const checkpoint = ReconciliationCheckpointSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(checkpoint.observationHash)
      if ((await transaction.get(namespaces.reconciliation, id)) !== undefined) return false
      await transaction.put({ namespace: namespaces.reconciliation, id, value: json(checkpoint) })
      return true
    })
  }

  compareAndSet(expectedVersion: number, input: ReconciliationCheckpoint): Promise<boolean> {
    const checkpoint = ReconciliationCheckpointSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(checkpoint.observationHash)
      const record = await transaction.get(namespaces.reconciliation, id)
      if (record === undefined) return false
      const current = ReconciliationCheckpointSchema.parse(record.value)
      if (current.version !== expectedVersion || current.checkpointId !== checkpoint.checkpointId) {
        return false
      }
      await transaction.put({
        namespace: namespaces.reconciliation,
        id,
        expectedRevision: record.revision,
        value: json(checkpoint),
      })
      return true
    })
  }
}

/** Mirrors the PG port's InventoryCredentialFenceInvalidError (same wire code). */
/** Structural authority for credential revocation checks (runtime-node identity port shape). */
export interface RuntimeNodeCredentialFenceAuthorityPort {
  isRevoked(credentialId: string, revocationVersion?: number): Promise<boolean>
}

/**
 * Builds the credential-fence validator from the SAME runtime-node credential authority the
 * channel authenticator trusts. The port-based check consults `isRevoked` only; the LIVE
 * transaction handle is passed through so provider-backed authorities can additionally read
 * durable invalidation state IN-TRANSACTION. Ordering under the store contract: the SQLite
 * provider serializes writers, so an invalidation applied through the same provider cannot commit
 * between this check and the fenced ACK write — it orders strictly before (visible to the check)
 * or strictly after (applies to the next fenced transition). Consumes no credentials and creates
 * none. No revocation re-check exists at commit time beyond this ordering guarantee.
 */
export function createRuntimeNodeCredentialFenceValidator(
  authority: RuntimeNodeCredentialFenceAuthorityPort
) {
  return async (transaction: PersistenceTransaction, fence: CredentialRevocationFence) => {
    void transaction
    if (await authority.isRevoked(fence.credentialId, fence.revocationVersion)) {
      throw new SqliteRuntimeCommandCredentialFenceInvalidError()
    }
  }
}

export class SqliteRuntimeCommandCredentialFenceInvalidError extends Error {
  readonly code = 'INVENTORY_CREDENTIAL_FENCE_INVALID' as const

  constructor() {
    super('INVENTORY_CREDENTIAL_FENCE_INVALID')
    this.name = 'SqliteRuntimeCommandCredentialFenceInvalidError'
  }
}

/** Mirrors the PG repository's trigger: inbound ACK/result transitions require the fence. */
function requiresRuntimeCommandCredentialFence(
  current: RuntimeCommandRecord,
  next: RuntimeCommandRecord
): boolean {
  return (
    next.status === 'acknowledged' ||
    next.status === 'succeeded' ||
    next.status === 'failed' ||
    next.status === 'cancelled' ||
    next.acknowledgementReference !== current.acknowledgementReference ||
    next.resultRecordedAt !== current.resultRecordedAt ||
    next.resultStatus !== current.resultStatus ||
    next.resultReference !== current.resultReference
  )
}

function validCredentialFenceShape(
  fence: CredentialRevocationFence | undefined
): fence is CredentialRevocationFence {
  return (
    typeof fence === 'object' &&
    fence !== null &&
    typeof fence.credentialId === 'string' &&
    fence.credentialId.length > 0 &&
    Number.isSafeInteger(fence.revocationVersion) &&
    fence.revocationVersion >= 1 &&
    Object.keys(fence).length === 2 &&
    Object.hasOwn(fence, 'credentialId') &&
    Object.hasOwn(fence, 'revocationVersion')
  )
}

export class SqliteRuntimeCommandRepository implements RuntimeCommandRepository {
  constructor(
    readonly provider: PersistenceProvider,
    /**
     * Canonical identity/revocation verification (the PG port locks through its SECURITY
     * DEFINER function inside the same transaction). It receives the LIVE in-transaction
     * handle so the check is tied to the same transaction/locking authority as the fenced
     * write — never a disconnected callback. When absent, every required or explicitly
     * fenced transition REJECTS (fail closed): a well-formed fence without a verifier must
     * never pass.
     */
    private readonly validateCredentialFence?: (
      transaction: PersistenceTransaction,
      fence: CredentialRevocationFence,
      scope: { readonly nodeId: string; readonly workspaceId: string }
    ) => Promise<void>
  ) {}

  /**
   * Deletes settled runtime commands and their event receipts (#194). A command
   * is a candidate only when a result was recorded (`resultStatus` plus
   * `resultRecordedAt`), which excludes expired and acknowledged-but-unresolved
   * commands — those are reconciliation work. Receipts are that command's own
   * deduplication records and go with it; a late replay of one of its frames
   * cannot re-apply an effect because inbound frames must reserve their channel
   * sequence first and the event id such a frame would append is deterministic
   * in `(commandId, type, sequence)`. Dry run by default, revision-guarded.
   */
  async deleteEligibleRuntimeCommands(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
      readonly retentionHoldPolicy?: RetentionHoldPolicy
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('RUNTIME_LEDGER_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter(
      'runtime-ledgers',
      assessedAt,
      options.bound ?? 64
    )
    let deleted = 0
    let raced = 0
    let afterId: string | undefined
    let done = false
    while (!done) {
      const page = await this.provider.transaction((transaction) =>
        transaction.scan(namespaces.runtimeCommands, {
          limit: 128,
          ...(afterId === undefined ? {} : { afterId }),
        })
      )
      if (page.length === 0) break
      afterId = page[page.length - 1]?.id
      const candidates = page.filter((record) => {
        const parsed = RuntimeCommandRecordSchema.safeParse(record.value)
        if (!parsed.success) return false
        const settledAt = parsed.data.resultRecordedAt
        return (
          parsed.data.resultStatus !== undefined &&
          settledAt !== undefined &&
          expiredAt(settledAt, now)
        )
      })
      for (const candidate of candidates) {
        const outcome = await this.provider.transaction(async (transaction) => {
          const stored = await transaction.get(namespaces.runtimeCommands, candidate.id)
          if (stored === undefined) return { verdict: undefined, admitted: false, removed: false }
          const command = RuntimeCommandRecordSchema.parse(stored.value)
          const settledAt = command.resultRecordedAt
          const executionRow = await transaction.get(
            namespaces.executions,
            recordId(command.executionId)
          )
          const execution =
            executionRow === undefined ? undefined : ExecutionSchema.parse(executionRow.value)
          const scope =
            execution?.executionId === command.executionId &&
            execution.correlation.workspaceId === command.workspaceId
              ? executionRetentionScope(execution.correlation)
              : undefined
          const holds = await countSqliteMatchingActiveRetentionHolds(
            transaction,
            {
              classId: 'runtime-ledgers',
              ...(scope === undefined ? {} : { scope }),
            },
            options.retentionHoldPolicy
          )
          const verdict = evaluateRetentionEligibility({
            retentionExpiresAt:
              settledAt === undefined || options.policyRetainMs === null
                ? undefined
                : new Date(Date.parse(settledAt) + options.policyRetainMs).toISOString(),
            now: assessedAt,
            policyRetainMs: options.policyRetainMs,
            ownerTerminal: command.resultStatus !== undefined && settledAt !== undefined,
            publicationSettled: true,
            rejectionKeyReserved: true,
            pendingReferences: 0,
            holds,
          })
          if (!counter.add(verdict)) return { verdict, admitted: false, removed: false }
          if (verdict.verdict !== 'eligible' || dryRun)
            return { verdict, admitted: true, removed: false }
          const receipts = (await transaction.list(namespaces.runtimeEventReceipts)).filter(
            (record) => receiptCommandId(record.value) === command.commandId
          )
          if (options.journal !== undefined) {
            await options.journal(
              RetentionJournalOperationSchema.array().parse([
                ...receipts.map((record) => ({
                  kind: 'sqlite.delete',
                  namespace: namespaces.runtimeEventReceipts,
                  id: record.id,
                })),
                { kind: 'sqlite.delete', namespace: namespaces.runtimeCommands, id: stored.id },
              ])
            )
          }
          for (const receiptRecord of receipts) {
            await transaction.delete(
              namespaces.runtimeEventReceipts,
              receiptRecord.id,
              receiptRecord.revision
            )
          }
          let removed = false
          try {
            removed = await transaction.delete(
              namespaces.runtimeCommands,
              stored.id,
              stored.revision
            )
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

  create(input: RuntimeCommandRecord): Promise<RuntimeCommandCreateResult> {
    const command = RuntimeCommandRecordSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(command.commandId)
      const record = await transaction.get(namespaces.runtimeCommands, id)
      if (record === undefined) {
        await transaction.put({ namespace: namespaces.runtimeCommands, id, value: json(command) })
        return { outcome: 'created', record: command }
      }
      const current = RuntimeCommandRecordSchema.parse(record.value)
      return {
        outcome: runtimeCommandRecordsShareIdentity(current, command) ? 'duplicate' : 'conflict',
        record: current,
      }
    })
  }

  get(commandId: string): Promise<RuntimeCommandRecord | undefined> {
    RuntimeCommandRecordSchema.shape.commandId.parse(commandId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.runtimeCommands, recordId(commandId))
      return record === undefined ? undefined : RuntimeCommandRecordSchema.parse(record.value)
    })
  }

  compareAndSet(
    expectedVersion: number,
    input: RuntimeCommandRecord,
    credentialFence?: CredentialRevocationFence
  ): Promise<boolean> {
    const command = RuntimeCommandRecordSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(command.commandId)
      const record = await transaction.get(namespaces.runtimeCommands, id)
      if (record === undefined) return false
      const current = RuntimeCommandRecordSchema.parse(record.value)
      if (
        current.version !== expectedVersion ||
        !runtimeCommandRecordsShareIdentity(current, command)
      ) {
        return false
      }
      // Atomic credential-revocation fence, mirroring the PG port: inbound
      // ACK/result transitions (or any explicitly fenced update) fail closed
      // unless the fence is present, well-formed, and host-verified — all
      // inside the same provider transaction.
      if (
        requiresRuntimeCommandCredentialFence(current, command) ||
        credentialFence !== undefined
      ) {
        if (
          !validCredentialFenceShape(credentialFence) ||
          this.validateCredentialFence === undefined
        ) {
          // Fail closed: a missing/malformed fence OR an absent verifier can
          // never authorize a fenced transition.
          throw new SqliteRuntimeCommandCredentialFenceInvalidError()
        }
        await this.validateCredentialFence(transaction, credentialFence, {
          nodeId: current.nodeId,
          workspaceId: current.workspaceId,
        })
      }
      await transaction.put({
        namespace: namespaces.runtimeCommands,
        id,
        expectedRevision: record.revision,
        value: json(command),
      })
      return true
    })
  }

  listDispatchable(nodeId: string, at: string, limit: number): Promise<RuntimeCommandRecord[]> {
    RuntimeCommandRecordSchema.shape.nodeId.parse(nodeId)
    if (Number.isNaN(Date.parse(at))) throw new Error('INVALID_TIMESTAMP')
    validLimit(limit)
    return this.provider.transaction(async (transaction) =>
      (await transaction.list(namespaces.runtimeCommands))
        .map((record) => RuntimeCommandRecordSchema.parse(record.value))
        .filter(
          (command) =>
            command.nodeId === nodeId &&
            ['queued', 'dispatched', 'acknowledged'].includes(command.status)
        )
        .toSorted((left, right) =>
          left.issuedAt === right.issuedAt
            ? compareCodePointOrder(left.commandId, right.commandId)
            : compareCodePointOrder(left.issuedAt, right.issuedAt)
        )
        .slice(0, limit)
    )
  }

  /**
   * Bounded maintenance read for reconciliation: the most recent runtime
   * command issued for an attempt. At most one row is returned.
   */
  latestForAttempt(attemptId: string): Promise<RuntimeCommandRecord | undefined> {
    RuntimeCommandRecordSchema.shape.attemptId.parse(attemptId)
    return this.provider.transaction(
      async (transaction) =>
        (await transaction.list(namespaces.runtimeCommands))
          .map((record) => RuntimeCommandRecordSchema.parse(record.value))
          .filter((command) => command.attemptId === attemptId)
          .toSorted((left, right) =>
            left.issuedAt === right.issuedAt
              ? compareCodePointOrder(right.commandId, left.commandId)
              : compareCodePointOrder(right.issuedAt, left.issuedAt)
          )[0]
    )
  }
}

export class SqliteRuntimeInventoryCheckpointRepository implements RuntimeInventoryCheckpointRepository {
  constructor(readonly provider: PersistenceProvider) {}

  get(runtimeNodeRefId: string): Promise<RuntimeInventoryCheckpoint | undefined> {
    RuntimeInventoryCheckpointSchema.shape.runtimeNodeRefId.parse(runtimeNodeRefId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.runtimeInventory, recordId(runtimeNodeRefId))
      return record === undefined ? undefined : RuntimeInventoryCheckpointSchema.parse(record.value)
    })
  }

  compareAndSet(
    expectedRevision: number | undefined,
    input: RuntimeInventoryCheckpoint
  ): Promise<boolean> {
    const checkpoint = RuntimeInventoryCheckpointSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(checkpoint.runtimeNodeRefId)
      const record = await transaction.get(namespaces.runtimeInventory, id)
      if (record === undefined) {
        if (expectedRevision !== undefined) return false
        await transaction.put({
          namespace: namespaces.runtimeInventory,
          id,
          value: json(checkpoint),
        })
        return true
      }
      const current = RuntimeInventoryCheckpointSchema.parse(record.value)
      if (current.revision !== expectedRevision || current.workspaceId !== checkpoint.workspaceId) {
        return false
      }
      await transaction.put({
        namespace: namespaces.runtimeInventory,
        id,
        expectedRevision: record.revision,
        value: json(checkpoint),
      })
      return true
    })
  }
}

function sameProposalIdentity(
  left: StatePromotionProposal,
  right: StatePromotionProposal
): boolean {
  return (
    left.proposalId === right.proposalId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.baseRevision === right.baseRevision &&
    left.sourceExecutionId === right.sourceExecutionId &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt &&
    isDeepStrictEqual(left.operations, right.operations)
  )
}

function sameEventIdentity(left: ExecutionEvent, right: ExecutionEvent): boolean {
  return (
    left.eventId === right.eventId &&
    left.executionId === right.executionId &&
    left.sequence === right.sequence &&
    left.type === right.type &&
    left.schemaVersion === right.schemaVersion &&
    left.payloadHash === right.payloadHash &&
    left.recordedAt === right.recordedAt &&
    isDeepStrictEqual(left.correlation, right.correlation)
  )
}

async function appendEvent(
  transaction: RecordTransaction,
  draft: ExecutionEventDraft
): Promise<ExecutionEvent | undefined> {
  const sanitized = sanitizeExecutionEventDraft(draft)
  const id = recordId(sanitized.eventId)
  if ((await transaction.get(namespaces.events, id)) !== undefined) return undefined
  // Deleted owners do not erase retained event replay identities.
  if ((await transaction.get(namespaces.retiredEventIds, id)) !== undefined) return undefined
  const ownerRow = await transaction.get(namespaces.executions, recordId(sanitized.executionId))
  const owner = ownerRow === undefined ? undefined : ExecutionSchema.parse(ownerRow.value)
  // Preserve historical project-only insertion while preventing an explicit
  // owner from being disguised by a legacy incoming correlation.
  if (
    sanitized.correlation.executionScope !== undefined ||
    owner?.correlation.executionScope !== undefined
  ) {
    if (owner === undefined || !executionScopesEqual(owner.correlation, sanitized.correlation))
      throw new Error('SQLITE_EXECUTION_EVENT_SCOPE_MISMATCH')
  }
  const historicalSequence = (await transaction.list(namespaces.retiredEventIds))
    .map((record) => record.value as { executionId?: unknown; sequence?: unknown })
    .filter(
      (value): value is { executionId: string; sequence: number } =>
        value.executionId === sanitized.executionId && Number.isSafeInteger(value.sequence)
    )
    .reduce((maximum, value) => Math.max(maximum, value.sequence), 0)
  const sequence =
    Math.max(
      historicalSequence,
      (await transaction.list(namespaces.events))
        .map((record) => ExecutionEventSchema.parse(record.value))
        .filter((event) => event.executionId === sanitized.executionId)
        .reduce((maximum, event) => Math.max(maximum, event.sequence), 0)
    ) + 1
  const event = ExecutionEventSchema.parse({
    ...sanitized,
    sequence,
    payloadBytes: Buffer.byteLength(JSON.stringify(sanitized.payload)),
    payloadHash: hashExecutionEventPayloadV2(sanitized.payload),
    publication: { status: 'pending', attempts: 0, version: 1 },
  })
  await transaction.put({ namespace: namespaces.events, id, value: json(event) })
  return event
}

interface RuntimeEventReceipt {
  readonly commandId: string
  readonly messageKind: 'progress' | 'terminal'
  readonly messageSequence: number
  readonly frameHash: string
  readonly outcome: 'applied' | 'out_of_order' | 'terminal_conflict'
  readonly eventId?: string
}

function receipt(value: JsonValue): RuntimeEventReceipt {
  const candidate = value as unknown as RuntimeEventReceipt
  if (
    typeof candidate.commandId !== 'string' ||
    !['progress', 'terminal'].includes(candidate.messageKind) ||
    !Number.isSafeInteger(candidate.messageSequence) ||
    typeof candidate.frameHash !== 'string' ||
    !['applied', 'out_of_order', 'terminal_conflict'].includes(candidate.outcome)
  ) {
    throw new Error('RUNTIME_EVENT_RECEIPT_INVALID')
  }
  return structuredClone(candidate)
}

function receiptKey(
  commandId: string,
  messageKind: 'progress' | 'terminal',
  sequence: number
): string {
  return `${commandId}\u001f${messageKind}\u001f${sequence}`
}

async function writeReceipt(
  transaction: RecordTransaction,
  key: string,
  value: RuntimeEventReceipt
): Promise<void> {
  await transaction.put({
    namespace: namespaces.runtimeEventReceipts,
    id: recordId(key),
    value: json(value),
  })
}

async function replayReceipt(
  transaction: RecordTransaction,
  key: string,
  frameHash: string,
  legacyFrameHash?: string
): Promise<RuntimeEventEffectResult | undefined> {
  const record = await transaction.get(namespaces.runtimeEventReceipts, recordId(key))
  if (record === undefined) return undefined
  const stored = receipt(record.value)
  // Pre-cutover receipts stored the legacy form; accept either (#612).
  if (stored.frameHash !== frameHash && stored.frameHash !== legacyFrameHash) {
    return { outcome: 'conflict' }
  }
  const event =
    stored.eventId === undefined ? undefined : await eventById(transaction, stored.eventId)
  return { outcome: 'duplicate', ...(event === undefined ? {} : { event }) }
}

async function eventById(
  transaction: RecordTransaction,
  eventId: string
): Promise<ExecutionEvent | undefined> {
  const record = await transaction.get(namespaces.events, recordId(eventId))
  return record === undefined ? undefined : ExecutionEventSchema.parse(record.value)
}

function validLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error('INVALID_LIMIT')
  }
}

const canonicalInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** Canonical stored instant strictly before `now`; anything else is not a candidate. */
function expiredAt(value: string, now: Date): boolean {
  return canonicalInstant.test(value) && Date.parse(value) < now.getTime()
}

function recordId(value: string): string {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
