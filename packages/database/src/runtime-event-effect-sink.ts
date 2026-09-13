import { ExecutionAttemptSchema, ExecutionSchema } from '@control-plane/domain'
import type {
  RuntimeEventEffectResult,
  RuntimeEventEffectSink,
  RuntimeProgressEffect,
  RuntimeTerminalEffect,
} from '@control-plane/events'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import {
  appendExecutionEventInTransaction,
  fromExecutionEventRow,
  type DatabaseTransaction,
} from './execution-event-repository.js'
import {
  fromAttemptRow,
  fromExecutionRow,
  toAttemptUpdate,
  toExecutionUpdate,
} from './execution-repository.js'
import { executionEvents } from './schema/events.js'
import { executionAttempts, executions } from './schema/executions.js'
import { runtimeEventReceipts } from './schema/runtime-event-receipts.js'

export class PostgresRuntimeEventEffectSink implements RuntimeEventEffectSink {
  constructor(readonly database: ControlPlaneDatabase) {}

  applyProgress(effect: RuntimeProgressEffect): Promise<RuntimeEventEffectResult> {
    return this.database.transaction(async (transaction) => {
      await lockCommand(transaction, effect.commandId)
      const replay = await replayReceipt(
        transaction,
        effect.commandId,
        'progress',
        effect.eventSequence,
        effect.frameHash
      )
      if (replay) return replay

      const [latest] = await transaction
        .select({ sequence: runtimeEventReceipts.messageSequence })
        .from(runtimeEventReceipts)
        .where(
          and(
            eq(runtimeEventReceipts.commandId, effect.commandId),
            eq(runtimeEventReceipts.messageKind, 'progress'),
            eq(runtimeEventReceipts.outcome, 'applied')
          )
        )
        .orderBy(desc(runtimeEventReceipts.messageSequence))
        .limit(1)
      if (effect.eventSequence <= (latest?.sequence ?? 0)) {
        await insertReceipt(transaction, {
          commandId: effect.commandId,
          messageKind: 'progress',
          messageSequence: effect.eventSequence,
          frameHash: effect.frameHash,
          outcome: 'out_of_order',
          recordedAt: effect.draft.recordedAt,
        })
        return { outcome: 'out_of_order' }
      }

      const event = await appendExecutionEventInTransaction(transaction, effect.draft)
      if (!event) throw new Error('RUNTIME_PROGRESS_EVENT_CONFLICT')
      await insertReceipt(transaction, {
        commandId: effect.commandId,
        messageKind: 'progress',
        messageSequence: effect.eventSequence,
        frameHash: effect.frameHash,
        outcome: 'applied',
        eventId: event.eventId,
        recordedAt: effect.draft.recordedAt,
      })
      return { outcome: 'applied', event }
    })
  }

  applyTerminal(effect: RuntimeTerminalEffect): Promise<RuntimeEventEffectResult> {
    return this.database.transaction(async (transaction) => {
      await lockCommand(transaction, effect.commandId)
      await lockExecution(transaction, effect.execution.executionId)
      const replay = await replayReceipt(
        transaction,
        effect.commandId,
        'terminal',
        effect.messageSequence,
        effect.frameHash
      )
      if (replay) return replay

      const [executionRow] = await transaction
        .select()
        .from(executions)
        .where(eq(executions.executionId, effect.execution.executionId))
        .limit(1)
      const [attemptRow] = await transaction
        .select()
        .from(executionAttempts)
        .where(eq(executionAttempts.attemptId, effect.attempt.attemptId))
        .limit(1)
      if (!executionRow || !attemptRow) throw new Error('RUNTIME_TERMINAL_CONTEXT_MISSING')
      const execution = fromExecutionRow(executionRow)
      const attempt = fromAttemptRow(attemptRow)
      const terminal = ['completed', 'failed', 'cancelled', 'timed_out']
      if (terminal.includes(execution.state) || terminal.includes(attempt.state)) {
        const event = await findEvent(transaction, effect.draft.eventId)
        const duplicate =
          execution.state === effect.state && attempt.state === effect.state && event !== undefined
        await insertReceipt(transaction, {
          commandId: effect.commandId,
          messageKind: 'terminal',
          messageSequence: effect.messageSequence,
          frameHash: effect.frameHash,
          outcome: duplicate ? 'applied' : 'terminal_conflict',
          ...(event ? { eventId: event.eventId } : {}),
          recordedAt: effect.draft.recordedAt,
        })
        return duplicate ? { outcome: 'duplicate', event } : { outcome: 'terminal_conflict' }
      }

      const nextAttempt = ExecutionAttemptSchema.parse({
        ...attempt,
        state: effect.state,
        version: attempt.version + 1,
        terminalAt: effect.draft.occurredAt,
        updatedAt: effect.draft.occurredAt,
        ...(effect.failure ? { failure: effect.failure } : {}),
        ...(effect.resultReference ? { terminalResultRef: effect.resultReference } : {}),
      })
      const nextExecution = ExecutionSchema.parse({
        ...execution,
        state: effect.state,
        version: execution.version + 1,
        terminalAt: effect.draft.occurredAt,
        updatedAt: effect.draft.occurredAt,
        ...(effect.failure ? { failure: effect.failure } : {}),
        ...(effect.resultReference ? { terminalResultRef: effect.resultReference } : {}),
      })
      const updatedAttempt = await transaction
        .update(executionAttempts)
        .set(toAttemptUpdate(nextAttempt))
        .where(
          and(
            eq(executionAttempts.attemptId, attempt.attemptId),
            eq(executionAttempts.version, attempt.version)
          )
        )
        .returning({ attemptId: executionAttempts.attemptId })
      const updatedExecution = await transaction
        .update(executions)
        .set(toExecutionUpdate(nextExecution))
        .where(
          and(
            eq(executions.executionId, execution.executionId),
            eq(executions.version, execution.version)
          )
        )
        .returning({ executionId: executions.executionId })
      if (updatedAttempt.length !== 1 || updatedExecution.length !== 1) {
        throw new Error('RUNTIME_TERMINAL_CONCURRENT_UPDATE')
      }
      const event = await appendExecutionEventInTransaction(transaction, effect.draft)
      if (!event) throw new Error('RUNTIME_TERMINAL_EVENT_CONFLICT')
      await insertReceipt(transaction, {
        commandId: effect.commandId,
        messageKind: 'terminal',
        messageSequence: effect.messageSequence,
        frameHash: effect.frameHash,
        outcome: 'applied',
        eventId: event.eventId,
        recordedAt: effect.draft.recordedAt,
      })
      return { outcome: 'applied', event }
    })
  }
}

async function replayReceipt(
  transaction: DatabaseTransaction,
  commandId: string,
  messageKind: 'progress' | 'terminal',
  messageSequence: number,
  frameHash: string
): Promise<RuntimeEventEffectResult | undefined> {
  const [receipt] = await transaction
    .select()
    .from(runtimeEventReceipts)
    .where(
      and(
        eq(runtimeEventReceipts.commandId, commandId),
        eq(runtimeEventReceipts.messageKind, messageKind),
        eq(runtimeEventReceipts.messageSequence, messageSequence)
      )
    )
    .limit(1)
  if (!receipt) return undefined
  if (receipt.frameHash !== frameHash) return { outcome: 'conflict' }
  const event = receipt.eventId ? await findEvent(transaction, receipt.eventId) : undefined
  return { outcome: 'duplicate', ...(event ? { event } : {}) }
}

async function insertReceipt(
  transaction: DatabaseTransaction,
  input: {
    commandId: string
    messageKind: 'progress' | 'terminal'
    messageSequence: number
    frameHash: string
    outcome: 'applied' | 'out_of_order' | 'terminal_conflict'
    eventId?: string
    recordedAt: string
  }
): Promise<void> {
  await transaction.insert(runtimeEventReceipts).values({
    ...input,
    eventId: input.eventId ?? null,
    recordedAt: new Date(input.recordedAt),
  })
}

async function findEvent(transaction: DatabaseTransaction, eventId: string) {
  const [row] = await transaction
    .select()
    .from(executionEvents)
    .where(eq(executionEvents.eventId, eventId))
    .limit(1)
  return row ? fromExecutionEventRow(row) : undefined
}

async function lockCommand(transaction: DatabaseTransaction, commandId: string): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${commandId}))`)
}

async function lockExecution(transaction: DatabaseTransaction, executionId: string): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`execution:${executionId}`}))`
  )
}
