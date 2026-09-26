import { createHash } from 'node:crypto'
import { compareCodePointOrder } from '@control-plane/contracts'
import { isDeepStrictEqual } from 'node:util'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import {
  CommandInboxRecordSchema,
  CommandInboxScopeSchema,
  CommandInboxError,
  ExecutionCancellationReceiptSchema,
  ExecutionAttemptSchema,
  ExecutionSchema,
  InteractionCommandReceiptSchema,
  InteractionRequestSchema,
  ReconciliationCheckpointSchema,
  type CommandAcceptanceRepository,
  type CommandAcceptanceResult,
  type CommandInboxRecord,
  type CommandInboxScope,
  type Execution,
  type ExecutionAttempt,
  type ExecutionRepository,
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  type RetentionAssessment,
  type RetentionDeletionResult,
  type RetentionEligibilityVerdict,
  type RetentionJournalSink,
  RetentionJournalOperationSchema,
} from '@control-plane/domain'
import { assertContextPackageIntegrity } from '@control-plane/context'
import {
  ExecutionPlanReferenceSchema,
  ExecutionValidationCommandScopeSchema,
  ExecutionValidationCommandRecordSchema,
  executionValidationCommandKey,
  assertExecutionValidationCommandPlan,
  type ExecutionValidationCommandScope,
  type ExecutionValidationCommandRecord,
  type ExecutionValidationCommandRepository,
  assertExecutionPlanIntegrity,
  ExecutionPlanError,
  type ExecutionPlan,
  type ExecutionPlanReference,
  type ExecutionPlanRepository,
} from '@control-plane/execution-plan'
import { ExecutionEventSchema } from '@control-plane/events'

const namespaces = {
  commands: 'command-inbox',
  retiredCommands: 'retired-command-keys',
  commandByExecution: 'command-by-execution',
  executions: 'executions',
  attempts: 'execution-attempts',
  plans: 'execution-plans',
  contextPackages: 'context-packages',
  events: 'execution-events',
  reconciliation: 'reconciliation-checkpoints',
} as const

export async function assertSqliteStoredPlanReference(
  transaction: PersistenceTransaction,
  referenceInput: ExecutionPlanReference & { readonly schemaVersion?: number }
): Promise<ExecutionPlan> {
  const reference = ExecutionPlanReferenceSchema.parse(referenceInput)
  const stored = await transaction.get(namespaces.plans, recordId(reference.executionPlanId))
  if (stored === undefined) throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
  const plan = assertExecutionPlanIntegrity(stored.value)
  if (
    plan.contentDigest !== reference.contentDigest ||
    (referenceInput.schemaVersion !== undefined &&
      referenceInput.schemaVersion !== plan.schemaVersion)
  ) {
    throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
  }
  const context = await transaction.get(
    namespaces.contextPackages,
    recordId(plan.contextPackage.contextPackageId)
  )
  if (context === undefined) throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
  const package_ = assertContextPackageIntegrity(context.value)
  if (package_.contentDigest !== plan.contextPackage.contentDigest)
    throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
  return plan
}

function workflowJobPlanId(value: unknown): string | undefined {
  const input = (value as { input?: unknown } | null)?.input as
    | { executionPlan?: { executionPlanId?: unknown } }
    | undefined
  const executionPlanId = input?.executionPlan?.executionPlanId
  return typeof executionPlanId === 'string' ? executionPlanId : undefined
}

const executionStates = new Set<string>([
  'accepted',
  'queued',
  'starting',
  'running',
  'awaiting_input',
  'cancelling',
  'reconciliation_required',
])
const terminalExecutionStates = new Set<string>(['completed', 'failed', 'cancelled', 'timed_out'])

export interface SqliteReconciliationCandidateScan {
  /** ISO timestamp; executions updated before it are stale enough to reconcile. */
  readonly staleBefore: string
  readonly limit: number
  /** Keyset cursor from the previous page; keeps repeated scans bounded. */
  readonly afterExecutionId?: string
}

export class SqliteCommandAcceptanceRepository implements CommandAcceptanceRepository {
  constructor(readonly provider: PersistenceProvider) {}

  accept(
    commandInput: CommandInboxRecord,
    executionInput: Execution
  ): Promise<CommandAcceptanceResult> {
    const command = CommandInboxRecordSchema.parse(commandInput)
    const execution = ExecutionSchema.parse(executionInput)
    return this.provider.transaction(async (transaction) => {
      const commandId = recordId(scopeKey(command))
      await this.#assertNotRetired(transaction, commandId)
      const existingRecord = await transaction.get(namespaces.commands, commandId)
      if (existingRecord === undefined) {
        if (
          (await transaction.get(namespaces.executions, recordId(execution.executionId))) !==
          undefined
        ) {
          throw new Error('EXECUTION_ID_CONFLICT')
        }
        await assertSqliteStoredPlanReference(transaction, execution.executionPlan)
        await transaction.put({
          namespace: namespaces.commands,
          id: commandId,
          value: json(command),
        })
        await transaction.put({
          namespace: namespaces.executions,
          id: recordId(execution.executionId),
          value: json(execution),
        })
        await transaction.put({
          namespace: namespaces.commandByExecution,
          id: recordId(execution.executionId),
          value: commandId,
        })
        return { outcome: 'accepted', command, execution }
      }
      const existing = CommandInboxRecordSchema.parse(existingRecord.value)
      const existingExecution = await this.#execution(transaction, existing.executionId)
      if (existing.payloadHash === command.payloadHash) {
        return { outcome: 'duplicate', command: existing, execution: existingExecution }
      }
      const conflicted = CommandInboxRecordSchema.parse({
        ...existing,
        version: existing.version + 1,
        conflictCount: existing.conflictCount + 1,
        lastConflictAt: command.lastSeenAt,
        lastSeenAt: command.lastSeenAt,
      })
      await transaction.put({
        namespace: namespaces.commands,
        id: commandId,
        expectedRevision: existingRecord.revision,
        value: json(conflicted),
      })
      return { outcome: 'conflict', command: conflicted, execution: existingExecution }
    })
  }

  async get(scopeInput: CommandInboxScope): Promise<CommandInboxRecord | undefined> {
    const scope = CommandInboxScopeSchema.parse(scopeInput)
    return this.provider.transaction(async (transaction) => {
      await this.#assertNotRetired(transaction, recordId(scopeKey(scope)))
      const record = await transaction.get(namespaces.commands, recordId(scopeKey(scope)))
      return record === undefined ? undefined : CommandInboxRecordSchema.parse(record.value)
    })
  }

  /** Reserve a rejection key before a future retention worker removes payloads.
   * This does not delete domain records or authorize external cleanup.
   */
  retireExpiredCommand(scopeInput: CommandInboxScope, retiredAt: string): Promise<boolean> {
    const scope = CommandInboxScopeSchema.parse(scopeInput)
    const timestamp = new Date(retiredAt)
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== retiredAt)
      throw new Error('COMMAND_RETIREMENT_INVALID_TIMESTAMP')
    return this.provider.transaction(async (transaction) => {
      const id = recordId(scopeKey(scope))
      if (await transaction.get(namespaces.retiredCommands, id)) return true
      const stored = await transaction.get(namespaces.commands, id)
      if (!stored) return false
      const command = CommandInboxRecordSchema.parse(stored.value)
      if (scopeKey(command) !== scopeKey(scope))
        throw new Error('COMMAND_RETIREMENT_SCOPE_MISMATCH')
      const execution = await this.#execution(transaction, command.executionId)
      if (
        !['completed', 'failed'].includes(command.status) ||
        !['completed', 'failed', 'cancelled', 'timed_out'].includes(execution.state) ||
        timestamp.getTime() <= Date.parse(command.retentionExpiresAt)
      )
        return false
      await transaction.put({
        namespace: namespaces.retiredCommands,
        id,
        value: { retiredAt, commandId: command.commandId, executionId: command.executionId },
      })
      return true
    })
  }

  /**
   * Read-only eligibility assessment for the command-inbox class (#194).
   * Pages the namespace within `bound` expired candidates and evaluates each
   * with the shared predicate. It never deletes: eligibility is revalidated
   * per candidate at claim time because owner state, references and holds can
   * all change between a scan and a claim.
   */
  async assessExpiredInbox(
    now: Date,
    options: { readonly policyRetainMs: number | null; readonly bound?: number }
  ): Promise<RetentionAssessment> {
    if (Number.isNaN(now.getTime())) throw new Error('COMMAND_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const counter = new RetentionAssessmentCounter(
      'command-inbox',
      assessedAt,
      options.bound ?? 256
    )
    let afterId: string | undefined
    let done = false
    while (!done) {
      const page = await this.provider.transaction((transaction) =>
        transaction.scan(namespaces.commands, {
          limit: 128,
          ...(afterId === undefined ? {} : { afterId }),
        })
      )
      if (page.length === 0) break
      afterId = page[page.length - 1]?.id
      const candidates = page
        .map((record) => CommandInboxRecordSchema.parse(record.value))
        .filter((command) => expiredAt(command.retentionExpiresAt, now))
      const facts = await this.provider.transaction(async (transaction) => {
        const resolved: RetentionEligibilityVerdict[] = []
        for (const command of candidates) {
          const tombstone = await transaction.get(
            namespaces.retiredCommands,
            recordId(scopeKey(command))
          )
          const execution = await transaction.get(
            namespaces.executions,
            recordId(command.executionId)
          )
          const state =
            execution === undefined ? undefined : ExecutionSchema.parse(execution.value).state
          resolved.push(
            evaluateRetentionEligibility({
              retentionExpiresAt: command.retentionExpiresAt,
              now: assessedAt,
              policyRetainMs: options.policyRetainMs,
              ownerTerminal:
                ['completed', 'failed'].includes(command.status) &&
                state !== undefined &&
                terminalExecutionStates.has(state),
              publicationSettled: true,
              rejectionKeyReserved: tombstone !== undefined,
              pendingReferences: command.reconciliationRequiredAt === undefined ? 0 : 1,
              holds: 0,
            })
          )
        }
        return resolved
      })
      for (const verdict of facts) {
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
   * Deletes expired, eligible command-inbox records and their by-execution
   * index entry (#194), keeping the reserved rejection key so a replay of the
   * same scoped idempotency key still fails closed with COMMAND_RETENTION_EXPIRED.
   *
   * Safety ordering, per candidate, inside one transaction:
   *   1. re-read the record and re-derive every fact (the scan is not evidence),
   *   2. evaluate the shared predicate against the fresh facts,
   *   3. delete the record with its expected revision, then its index entry.
   * A candidate whose revision moved is reported as `raced`, never forced.
   * `dryRun` defaults to true: deletion is opt-in per call site.
   */
  async deleteEligibleInbox(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      /** Journal sink; called with each candidate's effects before they apply. */
      readonly journal?: RetentionJournalSink
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('COMMAND_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter('command-inbox', assessedAt, options.bound ?? 64)
    let deleted = 0
    let raced = 0
    let afterId: string | undefined
    let done = false
    while (!done) {
      const page = await this.provider.transaction((transaction) =>
        transaction.scan(namespaces.commands, {
          limit: 128,
          ...(afterId === undefined ? {} : { afterId }),
        })
      )
      if (page.length === 0) break
      afterId = page[page.length - 1]?.id
      const candidates = page.filter((record) => {
        const parsed = CommandInboxRecordSchema.safeParse(record.value)
        return parsed.success && expiredAt(parsed.data.retentionExpiresAt, now)
      })
      for (const candidate of candidates) {
        const outcome = await this.provider.transaction(async (transaction) => {
          const stored = await transaction.get(namespaces.commands, candidate.id)
          if (stored === undefined)
            return { verdict: undefined, admitted: false, removed: false, conflicted: false }
          const command = CommandInboxRecordSchema.parse(stored.value)
          const tombstone = await transaction.get(
            namespaces.retiredCommands,
            recordId(scopeKey(command))
          )
          const execution = await transaction.get(
            namespaces.executions,
            recordId(command.executionId)
          )
          const state =
            execution === undefined ? undefined : ExecutionSchema.parse(execution.value).state
          const verdict = evaluateRetentionEligibility({
            retentionExpiresAt: command.retentionExpiresAt,
            now: assessedAt,
            policyRetainMs: options.policyRetainMs,
            ownerTerminal:
              ['completed', 'failed'].includes(command.status) &&
              state !== undefined &&
              terminalExecutionStates.has(state),
            publicationSettled: true,
            rejectionKeyReserved: tombstone !== undefined,
            pendingReferences: command.reconciliationRequiredAt === undefined ? 0 : 1,
            holds: 0,
          })
          if (!counter.add(verdict)) {
            return { verdict, admitted: false, removed: false, conflicted: false }
          }
          if (verdict.verdict !== 'eligible' || dryRun) {
            return { verdict, admitted: true, removed: false, conflicted: false }
          }
          // Journal only after this candidate has been admitted to the bounded
          // pass. The trusted journal records an approved deletion intent for
          // restoration to replay before this transaction applies it.
          if (options.journal !== undefined) {
            const retirementId = recordId(scopeKey(command))
            await options.journal(
              RetentionJournalOperationSchema.array().parse([
                ...(tombstone === undefined
                  ? []
                  : [
                      {
                        kind: 'sqlite.put' as const,
                        namespace: namespaces.retiredCommands,
                        id: retirementId,
                        value: tombstone.value,
                      },
                    ]),
                { kind: 'sqlite.delete', namespace: namespaces.commands, id: candidate.id },
                {
                  kind: 'sqlite.delete',
                  namespace: namespaces.commandByExecution,
                  id: recordId(command.executionId),
                },
              ])
            )
          }
          const removed = await transaction.delete(
            namespaces.commands,
            candidate.id,
            stored.revision
          )
          if (!removed) return { verdict, admitted: true, removed: false, conflicted: true }
          await transaction.delete(
            namespaces.commandByExecution,
            recordId(command.executionId),
            undefined
          )
          return { verdict, admitted: true, removed: true, conflicted: false }
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
  async deleteExpiredInbox(now: Date): Promise<number> {
    if (Number.isNaN(now.getTime())) throw new Error('COMMAND_RETENTION_INVALID_TIMESTAMP')
    throw new Error('COMMAND_RETENTION_ELIGIBILITY_REQUIRED')
  }

  async #assertNotRetired(transaction: PersistenceTransaction, id: string): Promise<void> {
    if (await transaction.get(namespaces.retiredCommands, id))
      throw new CommandInboxError('COMMAND_RETENTION_EXPIRED')
  }

  async getByExecutionId(executionId: string): Promise<CommandInboxRecord | undefined> {
    ExecutionSchema.shape.executionId.parse(executionId)
    return this.provider.transaction(async (transaction) => {
      const index = await transaction.get(namespaces.commandByExecution, recordId(executionId))
      if (index === undefined || typeof index.value !== 'string') return undefined
      const record = await transaction.get(namespaces.commands, index.value)
      return record === undefined ? undefined : CommandInboxRecordSchema.parse(record.value)
    })
  }

  async getExecution(executionId: string): Promise<Execution | undefined> {
    ExecutionSchema.shape.executionId.parse(executionId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.executions, recordId(executionId))
      return record === undefined ? undefined : ExecutionSchema.parse(record.value)
    })
  }

  compareAndSet(expectedVersion: number, commandInput: CommandInboxRecord): Promise<boolean> {
    const command = CommandInboxRecordSchema.parse(commandInput)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(scopeKey(command))
      const record = await transaction.get(namespaces.commands, id)
      if (record === undefined) return false
      const current = CommandInboxRecordSchema.parse(record.value)
      if (current.version !== expectedVersion || !sameImmutableCommand(current, command))
        return false
      await transaction.put({
        namespace: namespaces.commands,
        id,
        expectedRevision: record.revision,
        value: json(command),
      })
      return true
    })
  }

  async #execution(
    transaction: Parameters<Parameters<PersistenceProvider['transaction']>[0]>[0],
    executionId: string
  ): Promise<Execution> {
    const record = await transaction.get(namespaces.executions, recordId(executionId))
    if (record === undefined) throw new Error('COMMAND_EXECUTION_INVARIANT_VIOLATION')
    return ExecutionSchema.parse(record.value)
  }
}

export class SqliteExecutionRepository implements ExecutionRepository {
  constructor(readonly provider: PersistenceProvider) {}

  /**
   * Deletes terminal executions and their settled attempts (#194) once the
   * retention duration has passed since the terminal instant, and only when
   * nothing that must outlive them still references them: the acceptance
   * record, either command receipt, any execution event, a reconciliation
   * checkpoint or a non-terminal attempt all retain the execution. This class is therefore the last to
   * become eligible, which is the ordering proof it needs. `dryRun` defaults
   * to true and a record whose revision moved is reported as `raced`.
   */
  async deleteEligibleExecutions(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('EXECUTION_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter('executions', assessedAt, options.bound ?? 64)
    let deleted = 0
    let raced = 0
    let afterId: string | undefined
    let done = false
    while (!done) {
      const page = await this.provider.transaction((transaction) =>
        transaction.scan(namespaces.executions, {
          limit: 128,
          ...(afterId === undefined ? {} : { afterId }),
        })
      )
      if (page.length === 0) break
      afterId = page[page.length - 1]?.id
      const candidates = page
        .map((record) => ({ record, execution: ExecutionSchema.parse(record.value) }))
        .filter(
          ({ execution }) =>
            terminalExecutionStates.has(execution.state) && execution.terminalAt !== undefined
        )
      for (const candidate of candidates) {
        const outcome = await this.provider.transaction(async (transaction) => {
          const stored = await transaction.get(namespaces.executions, candidate.record.id)
          if (stored === undefined)
            return { verdict: undefined, admitted: false, removed: false, conflicted: false }
          const execution = ExecutionSchema.parse(stored.value)
          if (!terminalExecutionStates.has(execution.state) || execution.terminalAt === undefined) {
            return { verdict: undefined, admitted: false, removed: false, conflicted: false }
          }
          // Reference checks: every namespace that carries execution identity
          // has to be free of this execution before it can be removed.
          const acceptance = await transaction.get(
            namespaces.commandByExecution,
            recordId(execution.executionId)
          )
          const events = (await transaction.list(namespaces.events)).some(
            (record) =>
              ExecutionEventSchema.parse(record.value).executionId === execution.executionId
          )
          const checkpoints = (await transaction.list(namespaces.reconciliation)).some(
            (record) =>
              ReconciliationCheckpointSchema.parse(record.value).executionId ===
              execution.executionId
          )
          const attempts = (await transaction.list(namespaces.attempts))
            .map((record) => ExecutionAttemptSchema.parse(record.value))
            .filter((attempt) => attempt.executionId === execution.executionId)
          // Runtime commands are deleted by their own class, so an execution
          // that still has them is retained rather than removed first.
          const runtimeCommands = (await transaction.list('runtime-commands')).some(
            (record) =>
              (record.value as { executionId?: unknown } | null)?.executionId ===
              execution.executionId
          )
          const cancellationReceipts = (
            await transaction.list('execution-cancellation-receipts')
          ).some((record) => {
            const parsed = ExecutionCancellationReceiptSchema.safeParse(record.value)
            if (parsed.success)
              return parsed.data.request.payload.executionId === execution.executionId
            return (
              (record.value as { request?: { payload?: { executionId?: unknown } } } | null)
                ?.request?.payload?.executionId === execution.executionId
            )
          })
          const interactionReceipts = await transaction.list('interaction-command-receipts')
          let interactionReceiptReference = false
          for (const record of interactionReceipts) {
            const parsed = InteractionCommandReceiptSchema.safeParse(record.value)
            const request = parsed.success ? parsed.data.request : undefined
            const raw = record.value as {
              request?: { payload?: { executionId?: unknown; interactionId?: unknown } }
            } | null
            if (
              request?.payload.executionId === execution.executionId ||
              raw?.request?.payload?.executionId === execution.executionId
            ) {
              interactionReceiptReference = true
              break
            }
            const interactionId =
              request?.payload.interactionId ?? raw?.request?.payload?.interactionId
            if (typeof interactionId !== 'string') continue
            const interactionRow = await transaction.get(
              'interaction-requests',
              recordId(interactionId)
            )
            if (interactionRow === undefined) continue
            const interaction = InteractionRequestSchema.safeParse(interactionRow.value)
            if (
              (interaction.success && interaction.data.executionId === execution.executionId) ||
              (!interaction.success &&
                (interactionRow.value as { executionId?: unknown } | null)?.executionId ===
                  execution.executionId)
            ) {
              interactionReceiptReference = true
              break
            }
          }
          const interactionRequestReference = (await transaction.list('interaction-requests')).some(
            (record) => {
              const parsed = InteractionRequestSchema.safeParse(record.value)
              if (parsed.success) return parsed.data.executionId === execution.executionId
              return (
                (record.value as { executionId?: unknown } | null)?.executionId ===
                execution.executionId
              )
            }
          )
          const activeAttempts = attempts.filter(
            (attempt) => !terminalExecutionStates.has(attempt.state)
          )
          const verdict = evaluateRetentionEligibility({
            retentionExpiresAt:
              options.policyRetainMs === null
                ? undefined
                : new Date(Date.parse(execution.terminalAt) + options.policyRetainMs).toISOString(),
            now: assessedAt,
            policyRetainMs: options.policyRetainMs,
            ownerTerminal: true,
            publicationSettled: true,
            rejectionKeyReserved: true,
            pendingReferences:
              acceptance !== undefined ||
              events ||
              checkpoints ||
              runtimeCommands ||
              cancellationReceipts ||
              interactionReceiptReference ||
              interactionRequestReference ||
              activeAttempts.length > 0
                ? 1
                : 0,
            holds: 0,
          })
          if (!counter.add(verdict)) {
            return { verdict, admitted: false, removed: false, conflicted: false }
          }
          if (verdict.verdict !== 'eligible' || dryRun) {
            return { verdict, admitted: true, removed: false, conflicted: false }
          }
          if (options.journal !== undefined) {
            await options.journal(
              RetentionJournalOperationSchema.array().parse([
                ...attempts.map((attempt) => ({
                  kind: 'sqlite.delete',
                  namespace: namespaces.attempts,
                  id: recordId(attempt.attemptId),
                })),
                { kind: 'sqlite.delete', namespace: namespaces.executions, id: stored.id },
              ])
            )
          }
          let conflicted = false
          for (const attempt of attempts) {
            const attemptRecord = await transaction.get(
              namespaces.attempts,
              recordId(attempt.attemptId)
            )
            if (attemptRecord === undefined) continue
            try {
              await transaction.delete(
                namespaces.attempts,
                recordId(attempt.attemptId),
                attemptRecord.revision
              )
            } catch {
              conflicted = true
            }
          }
          let removed = false
          try {
            removed = await transaction.delete(namespaces.executions, stored.id, stored.revision)
          } catch {
            conflicted = true
          }
          return { verdict, admitted: true, removed, conflicted: conflicted || !removed }
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

  insertExecution(executionInput: Execution): Promise<boolean> {
    const execution = ExecutionSchema.parse(executionInput)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(execution.executionId)
      if ((await transaction.get(namespaces.executions, id)) !== undefined) return false
      await assertSqliteStoredPlanReference(transaction, execution.executionPlan)
      await transaction.put({ namespace: namespaces.executions, id, value: json(execution) })
      return true
    })
  }

  async getExecution(executionId: string): Promise<Execution | undefined> {
    ExecutionSchema.shape.executionId.parse(executionId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.executions, recordId(executionId))
      return record === undefined ? undefined : ExecutionSchema.parse(record.value)
    })
  }

  compareAndSetExecution(expectedVersion: number, executionInput: Execution): Promise<boolean> {
    const execution = ExecutionSchema.parse(executionInput)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(execution.executionId)
      const record = await transaction.get(namespaces.executions, id)
      if (record === undefined) return false
      const current = ExecutionSchema.parse(record.value)
      if (current.version !== expectedVersion || !sameImmutableExecution(current, execution))
        return false
      await transaction.put({
        namespace: namespaces.executions,
        id,
        expectedRevision: record.revision,
        value: json(execution),
      })
      return true
    })
  }

  insertAttempt(
    expectedExecutionVersion: number,
    executionInput: Execution,
    attemptInput: ExecutionAttempt
  ): Promise<boolean> {
    const execution = ExecutionSchema.parse(executionInput)
    const attempt = ExecutionAttemptSchema.parse(attemptInput)
    return this.provider.transaction(async (transaction) => {
      const executionId = recordId(execution.executionId)
      const currentRecord = await transaction.get(namespaces.executions, executionId)
      if (currentRecord === undefined) return false
      const current = ExecutionSchema.parse(currentRecord.value)
      if (
        current.version !== expectedExecutionVersion ||
        !sameImmutableExecution(current, execution) ||
        attempt.executionId !== execution.executionId ||
        (await transaction.get(namespaces.attempts, recordId(attempt.attemptId))) !== undefined
      ) {
        return false
      }
      await transaction.put({
        namespace: namespaces.executions,
        id: executionId,
        expectedRevision: currentRecord.revision,
        value: json(execution),
      })
      await transaction.put({
        namespace: namespaces.attempts,
        id: recordId(attempt.attemptId),
        value: json(attempt),
      })
      return true
    })
  }

  async getAttempt(attemptId: string): Promise<ExecutionAttempt | undefined> {
    ExecutionAttemptSchema.shape.attemptId.parse(attemptId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.attempts, recordId(attemptId))
      return record === undefined ? undefined : ExecutionAttemptSchema.parse(record.value)
    })
  }

  listAttempts(executionId: string): Promise<readonly ExecutionAttempt[]> {
    ExecutionSchema.shape.executionId.parse(executionId)
    return this.provider.transaction(async (transaction) =>
      (await transaction.list(namespaces.attempts))
        .map((record) => ExecutionAttemptSchema.parse(record.value))
        .filter((attempt) => attempt.executionId === executionId)
        .toSorted((left, right) => left.sequence - right.sequence)
    )
  }

  compareAndSetAttempt(expectedVersion: number, attemptInput: ExecutionAttempt): Promise<boolean> {
    const attempt = ExecutionAttemptSchema.parse(attemptInput)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(attempt.attemptId)
      const record = await transaction.get(namespaces.attempts, id)
      if (record === undefined) return false
      const current = ExecutionAttemptSchema.parse(record.value)
      if (current.version !== expectedVersion || !sameImmutableAttempt(current, attempt))
        return false
      await transaction.put({
        namespace: namespaces.attempts,
        id,
        expectedRevision: record.revision,
        value: json(attempt),
      })
      return true
    })
  }

  /**
   * Bounded maintenance scan for reconciliation candidates: non-terminal
   * executions that went stale, plus terminal executions that still hold
   * undelivered (unarchived, pending or failed) events. Keyset-ordered by
   * execution id so repeated pages never revisit rows.
   */
  listReconciliationCandidates(
    input: SqliteReconciliationCandidateScan
  ): Promise<readonly string[]> {
    if (Number.isNaN(Date.parse(input.staleBefore))) throw new Error('INVALID_STALE_BEFORE')
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new Error('INVALID_LIMIT')
    }
    return this.provider.transaction(async (transaction) => {
      const undelivered = new Set(
        (await transaction.list(namespaces.events))
          .map((record) => ExecutionEventSchema.parse(record.value))
          .filter(
            (event) =>
              event.archivedAt === undefined &&
              ['pending', 'failed'].includes(event.publication.status)
          )
          .map((event) => event.executionId)
      )
      return (await transaction.list(namespaces.executions))
        .map((record) => ExecutionSchema.parse(record.value))
        .filter((execution) => isReconciliationCandidate(execution, input, undelivered))
        .map((execution) => execution.executionId)
        .toSorted((left, right) => compareCodePointOrder(left, right))
        .slice(0, input.limit)
    })
  }
}

function isReconciliationCandidate(
  execution: Execution,
  input: SqliteReconciliationCandidateScan,
  undelivered: ReadonlySet<string>
): boolean {
  if (input.afterExecutionId !== undefined && execution.executionId <= input.afterExecutionId) {
    return false
  }
  if (Date.parse(execution.updatedAt) >= Date.parse(input.staleBefore)) return false
  if (executionStates.has(execution.state)) return true
  return terminalExecutionStates.has(execution.state) && undelivered.has(execution.executionId)
}

export class SqliteExecutionPlanRepository implements ExecutionPlanRepository {
  constructor(readonly provider: PersistenceProvider) {}

  /**
   * Deletes execution plans past their window and free of references (#194). A
   * plan is retained while an execution, an acceptance record or a validation
   * command pins it, so plans are freed bottom-up after the executions class
   * has removed the executions that carried them. Age runs from `compiledAt`
   * and the delete is revision-guarded. Dry run by default.
   */
  async deleteEligibleExecutionPlans(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('EXECUTION_PLAN_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter(
      'execution-plans',
      assessedAt,
      options.bound ?? 64
    )
    let deleted = 0
    let raced = 0
    let afterId: string | undefined
    let done = false
    while (!done) {
      const page = await this.provider.transaction((transaction) =>
        transaction.scan(namespaces.plans, {
          limit: 128,
          ...(afterId === undefined ? {} : { afterId }),
        })
      )
      if (page.length === 0) break
      afterId = page[page.length - 1]?.id
      for (const record of page) {
        const outcome = await this.provider.transaction(async (transaction) => {
          const stored = await transaction.get(namespaces.plans, record.id)
          if (stored === undefined) return { verdict: undefined, admitted: false, removed: false }
          const plan = assertExecutionPlanIntegrity(stored.value)
          if (!expiredAt(plan.compiledAt, now))
            return { verdict: undefined, admitted: false, removed: false }
          // BEGIN IMMEDIATE serializes this fresh reference scan with every
          // writer that creates a plan reference in this provider.
          const references = new Set<string>()
          for (const reference of await transaction.list(namespaces.executions)) {
            references.add(ExecutionSchema.parse(reference.value).executionPlan.executionPlanId)
          }
          for (const reference of await transaction.list(namespaces.commands)) {
            references.add(
              CommandInboxRecordSchema.parse(reference.value).executionPlan.executionPlanId
            )
          }
          for (const reference of await transaction.list('execution-validation-commands')) {
            references.add(
              ExecutionValidationCommandRecordSchema.parse(reference.value).executionPlan
                .executionPlanId
            )
          }
          for (const job of await transaction.list('workflow-jobs')) {
            const executionPlanId = workflowJobPlanId(job.value)
            if (executionPlanId !== undefined) references.add(executionPlanId)
          }
          const verdict = evaluateRetentionEligibility({
            retentionExpiresAt:
              options.policyRetainMs === null
                ? undefined
                : new Date(Date.parse(plan.compiledAt) + options.policyRetainMs).toISOString(),
            now: assessedAt,
            policyRetainMs: options.policyRetainMs,
            ownerTerminal: true,
            publicationSettled: true,
            rejectionKeyReserved: true,
            pendingReferences: references.has(plan.executionPlanId) ? 1 : 0,
            holds: 0,
          })
          if (!counter.add(verdict)) return { verdict, admitted: false, removed: false }
          if (verdict.verdict !== 'eligible' || dryRun)
            return { verdict, admitted: true, removed: false }
          if (options.journal !== undefined) {
            await options.journal(
              RetentionJournalOperationSchema.array().parse([
                { kind: 'sqlite.delete', namespace: namespaces.plans, id: stored.id },
              ])
            )
          }
          let removed = false
          try {
            removed = await transaction.delete(namespaces.plans, stored.id, stored.revision)
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

  put(input: ExecutionPlan): Promise<ExecutionPlanReference> {
    const plan = assertExecutionPlanIntegrity(input)
    const reference = {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
    }
    return this.provider.transaction(async (transaction) => {
      const id = recordId(plan.executionPlanId)
      const record = await transaction.get(namespaces.plans, id)
      if (record === undefined) {
        const context = await transaction.get(
          namespaces.contextPackages,
          recordId(plan.contextPackage.contextPackageId)
        )
        if (context === undefined) {
          throw new ExecutionPlanError(
            'MISSING_CONTEXT_PACKAGE',
            plan.contextPackage.contextPackageId
          )
        }
        const package_ = assertContextPackageIntegrity(context.value)
        if (package_.contentDigest !== plan.contextPackage.contentDigest) {
          throw new ExecutionPlanError(
            'MISSING_CONTEXT_PACKAGE',
            plan.contextPackage.contextPackageId
          )
        }
        await transaction.put({ namespace: namespaces.plans, id, value: json(plan) })
        return reference
      }
      const existing = assertExecutionPlanIntegrity(record.value)
      if (!isDeepStrictEqual(existing, plan)) throw new Error('EXECUTION_PLAN_ID_CONFLICT')
      return reference
    })
  }

  async get(input: ExecutionPlanReference): Promise<ExecutionPlan | undefined> {
    const reference = ExecutionPlanReferenceSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.plans, recordId(reference.executionPlanId))
      if (record === undefined) return undefined
      const plan = assertExecutionPlanIntegrity(record.value)
      return plan.contentDigest === reference.contentDigest ? plan : undefined
    })
  }
}

export class SqliteExecutionValidationCommandRepository implements ExecutionValidationCommandRepository {
  constructor(readonly provider: PersistenceProvider) {}

  get(
    input: ExecutionValidationCommandScope
  ): Promise<ExecutionValidationCommandRecord | undefined> {
    const scope = ExecutionValidationCommandScopeSchema.parse(input)
    return this.provider.transaction((transaction) => this.#read(transaction, scope))
  }

  commit(
    input: ExecutionValidationCommandRecord,
    planInput: ExecutionPlan
  ): Promise<ExecutionValidationCommandRecord> {
    const plan = assertExecutionPlanIntegrity(planInput)
    const record = assertExecutionValidationCommandPlan(input, plan)
    return this.provider.transaction(async (transaction) => {
      const existing = await this.#read(transaction, record.scope)
      if (existing) {
        if (existing.payloadHash !== record.payloadHash)
          throw new Error('EXECUTION_VALIDATION_COMMAND_CONFLICT')
        return existing
      }
      const id = recordId(plan.executionPlanId)
      const stored = await transaction.get(namespaces.plans, id)
      if (stored && !isDeepStrictEqual(assertExecutionPlanIntegrity(stored.value), plan)) {
        throw new Error('EXECUTION_PLAN_ID_CONFLICT')
      }
      const context = await transaction.get(
        namespaces.contextPackages,
        recordId(plan.contextPackage.contextPackageId)
      )
      if (context === undefined) {
        throw new ExecutionPlanError(
          'MISSING_CONTEXT_PACKAGE',
          plan.contextPackage.contextPackageId
        )
      }
      const package_ = assertContextPackageIntegrity(context.value)
      if (package_.contentDigest !== plan.contextPackage.contentDigest) {
        throw new ExecutionPlanError(
          'MISSING_CONTEXT_PACKAGE',
          plan.contextPackage.contextPackageId
        )
      }
      if (!stored) {
        await transaction.put({ namespace: namespaces.plans, id, value: json(plan) })
      }
      await transaction.put({
        namespace: 'execution-validation-commands',
        id: `r-${executionValidationCommandKey(record.scope)}`,
        value: json(record),
      })
      return record
    })
  }

  async #read(
    transaction: PersistenceTransaction,
    scope: ExecutionValidationCommandScope
  ): Promise<ExecutionValidationCommandRecord | undefined> {
    const stored = await transaction.get(
      'execution-validation-commands',
      `r-${executionValidationCommandKey(scope)}`
    )
    if (!stored) return undefined
    const record = ExecutionValidationCommandRecordSchema.parse(stored.value)
    if (!isDeepStrictEqual(record.scope, scope))
      throw new Error('EXECUTION_VALIDATION_COMMAND_SCOPE_MISMATCH')
    const storedPlan = await transaction.get(
      namespaces.plans,
      recordId(record.executionPlan.executionPlanId)
    )
    if (!storedPlan) throw new Error('EXECUTION_VALIDATION_COMMAND_PLAN_MISSING')
    return assertExecutionValidationCommandPlan(
      record,
      assertExecutionPlanIntegrity(storedPlan.value)
    )
  }
}

function scopeKey(scope: CommandInboxScope): string {
  return [
    scope.callerPrincipalId,
    scope.operation,
    scope.workspaceId,
    scope.projectId,
    scope.idempotencyKey,
  ].join('\u001f')
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

function sameImmutableCommand(left: CommandInboxRecord, right: CommandInboxRecord): boolean {
  return (
    scopeKey(left) === scopeKey(right) &&
    left.commandId === right.commandId &&
    left.requestId === right.requestId &&
    left.taskId === right.taskId &&
    left.agentId === right.agentId &&
    left.payloadHash === right.payloadHash &&
    left.executionId === right.executionId &&
    isDeepStrictEqual(left.executionPlan, right.executionPlan) &&
    left.receivedAt === right.receivedAt &&
    left.retentionExpiresAt === right.retentionExpiresAt
  )
}

function sameImmutableExecution(left: Execution, right: Execution): boolean {
  return (
    left.executionId === right.executionId &&
    isDeepStrictEqual(left.correlation, right.correlation) &&
    isDeepStrictEqual(left.executionPlan, right.executionPlan) &&
    left.parentExecutionId === right.parentExecutionId &&
    left.acceptedAt === right.acceptedAt &&
    left.createdAt === right.createdAt
  )
}

function sameImmutableAttempt(left: ExecutionAttempt, right: ExecutionAttempt): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.executionId === right.executionId &&
    left.sequence === right.sequence &&
    left.createdAt === right.createdAt
  )
}
