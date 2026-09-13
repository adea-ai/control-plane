import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'
import {
  ExecutionAttemptSchema,
  ExecutionSchema,
  ReconciliationCheckpointSchema,
  RuntimeCommandRecordSchema,
  StatePromotionProposalSchema,
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
  hashExecutionEventPayload,
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

const namespaces = {
  events: 'execution-events',
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
        .toSorted((left, right) => left.recordedAt.localeCompare(right.recordedAt))
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
    .toSorted((left, right) => left.recordedAt.localeCompare(right.recordedAt))
}

export class SqliteRuntimeEventEffectSink implements RuntimeEventEffectSink {
  constructor(readonly provider: PersistenceProvider) {}

  applyProgress(effect: RuntimeProgressEffect): Promise<RuntimeEventEffectResult> {
    return this.provider.transaction(async (transaction) => {
      const key = receiptKey(effect.commandId, 'progress', effect.eventSequence)
      const replay = await replayReceipt(transaction, key, effect.frameHash)
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
      const replay = await replayReceipt(transaction, key, effect.frameHash)
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

export class SqliteRuntimeCommandRepository implements RuntimeCommandRepository {
  constructor(readonly provider: PersistenceProvider) {}

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

  compareAndSet(expectedVersion: number, input: RuntimeCommandRecord): Promise<boolean> {
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
            ? left.commandId.localeCompare(right.commandId)
            : left.issuedAt.localeCompare(right.issuedAt)
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
              ? right.commandId.localeCompare(left.commandId)
              : right.issuedAt.localeCompare(left.issuedAt)
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
  const sequence =
    (await transaction.list(namespaces.events))
      .map((record) => ExecutionEventSchema.parse(record.value))
      .filter((event) => event.executionId === sanitized.executionId)
      .reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1
  const event = ExecutionEventSchema.parse({
    ...sanitized,
    sequence,
    payloadBytes: Buffer.byteLength(JSON.stringify(sanitized.payload)),
    payloadHash: hashExecutionEventPayload(sanitized.payload),
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
  frameHash: string
): Promise<RuntimeEventEffectResult | undefined> {
  const record = await transaction.get(namespaces.runtimeEventReceipts, recordId(key))
  if (record === undefined) return undefined
  const stored = receipt(record.value)
  if (stored.frameHash !== frameHash) return { outcome: 'conflict' }
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

function recordId(value: string): string {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
