import { createHash } from 'node:crypto'
import { compareCodePointOrder } from '@control-plane/contracts'
import { isDeepStrictEqual } from 'node:util'
import {
  DurableUsageLedger,
  budgetOpeningEntryIdempotencyKey,
  type DurableUsageBudgetSummary,
} from '@control-plane/usage-ledger'
import { DurableUsageError } from '@control-plane/usage-ledger/durable-contract'
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
  type RetentionHoldPolicy,
  RetentionJournalOperationSchema,
  retiredCommandKeyCandidates,
  retiredCommandKeyFromMetadataV2,
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
  executionBudgetAdmissionSource,
  executionPlanBudgetAllowance,
} from '@control-plane/execution-plan'
import { ExecutionEventSchema } from '@control-plane/events'
import { observeReferenceRetentionWindow } from '@control-plane/domain'
import {
  clearReferenceRetentionWindow,
  getReferenceRetentionWindow,
  setReferenceRetentionWindow,
} from './retention-reference-metadata.js'
import { countSqliteMatchingActiveRetentionHolds } from './retention-hold-repository.js'
import { SqliteDurableUsageStore } from './usage-store.js'

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
    plan.executionPlanId !== reference.executionPlanId ||
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
  if (
    package_.contextPackageId !== plan.contextPackage.contextPackageId ||
    package_.contentDigest !== plan.contextPackage.contentDigest
  )
    throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
  await clearReferenceRetentionWindow(
    transaction,
    'contextPackages',
    recordId(plan.contextPackage.contextPackageId)
  )
  await clearReferenceRetentionWindow(transaction, 'executionPlans', recordId(plan.executionPlanId))
  return plan
}

function workflowJobPlanId(value: unknown): string | undefined {
  const input = (value as { input?: unknown } | null)?.input as
    | { executionPlan?: { executionPlanId?: unknown } }
    | undefined
  const executionPlanId = input?.executionPlan?.executionPlanId
  return typeof executionPlanId === 'string' ? executionPlanId : undefined
}

function executionPlanParentId(value: unknown): string | undefined {
  const plan = value as { parentExecutionPlan?: { executionPlanId?: unknown } } | null
  const parentId = plan?.parentExecutionPlan?.executionPlanId
  return typeof parentId === 'string' ? parentId : undefined
}

async function assertSqliteStoredParentPlanReference(
  transaction: PersistenceTransaction,
  referenceInput: ExecutionPlanReference
): Promise<ExecutionPlan> {
  const reference = ExecutionPlanReferenceSchema.parse(referenceInput)
  try {
    return await assertSqliteStoredPlanReference(transaction, reference)
  } catch {
    throw new ExecutionPlanError('INVALID_REFERENCE', reference.executionPlanId)
  }
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

function hasCompleteAttemptHistory(
  attemptCount: number,
  latestAttemptId: string | null | undefined,
  attempts: readonly { attemptId: string; sequence: number }[]
): boolean {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 0 || attempts.length !== attemptCount)
    return false
  if (attemptCount === 0) return latestAttemptId == null
  if (latestAttemptId == null) return false

  const ordered = [...attempts].toSorted((left, right) => left.sequence - right.sequence)
  return (
    new Set(ordered.map((attempt) => attempt.attemptId)).size === attemptCount &&
    ordered.every((attempt, index) => attempt.sequence === index + 1) &&
    ordered.at(-1)?.attemptId === latestAttemptId
  )
}

export interface SqliteReconciliationCandidateScan {
  /** ISO timestamp; executions updated before it are stale enough to reconcile. */
  readonly staleBefore: string
  readonly limit: number
  /** Keyset cursor from the previous page; keeps repeated scans bounded. */
  readonly afterExecutionId?: string
}

export class SqliteCommandAcceptanceRepository implements CommandAcceptanceRepository {
  readonly #budgetAdmission: boolean

  constructor(
    readonly provider: PersistenceProvider,
    options: { readonly budgetAdmission?: boolean } = {}
  ) {
    this.#budgetAdmission = options.budgetAdmission === true
  }

  accept(
    commandInput: CommandInboxRecord,
    executionInput: Execution
  ): Promise<CommandAcceptanceResult> {
    const command = CommandInboxRecordSchema.parse(commandInput)
    const execution = ExecutionSchema.parse(executionInput)
    return this.provider.transaction(async (transaction) => {
      const commandId = recordId(scopeKey(command))
      await this.#assertNotRetired(transaction, command)
      const existingRecord = await transaction.get(namespaces.commands, commandId)
      if (existingRecord === undefined) {
        if (
          (await transaction.get(namespaces.executions, recordId(execution.executionId))) !==
          undefined
        ) {
          throw new Error('EXECUTION_ID_CONFLICT')
        }
        const storedPlan = await assertSqliteStoredPlanReference(
          transaction,
          execution.executionPlan
        )
        const allowance = this.#budgetAdmission
          ? await this.#admissionAllowance(transaction, command, execution, storedPlan)
          : undefined
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
        if (allowance !== undefined) {
          await SqliteDurableUsageStore.withTransaction(
            transaction,
            allowance.workspaceId,
            (store) => new DurableUsageLedger({ store }).openBudget(allowance)
          )
        }
        return { outcome: 'accepted', command, execution }
      }
      const existing = CommandInboxRecordSchema.parse(existingRecord.value)
      const existingExecution = await this.#execution(transaction, existing.executionId)
      if (existing.payloadHash === command.payloadHash) {
        if (this.#budgetAdmission) {
          await this.#verifyAdmissionInTransaction(
            transaction,
            existing,
            existingExecution,
            existing,
            existingExecution
          )
        }
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

  async verifyAdmission(
    commandInput: CommandInboxRecord,
    executionInput: Execution
  ): Promise<void> {
    if (!this.#budgetAdmission) return
    const command = CommandInboxRecordSchema.parse(commandInput)
    const execution = ExecutionSchema.parse(executionInput)
    await this.provider.transaction(async (transaction) => {
      const storedRecord = await transaction.get(namespaces.commands, recordId(scopeKey(command)))
      if (storedRecord === undefined) throw invalidPersistedAdmission()
      const storedCommand = CommandInboxRecordSchema.parse(storedRecord.value)
      const storedExecution = await this.#execution(transaction, storedCommand.executionId)
      await this.#verifyAdmissionInTransaction(
        transaction,
        command,
        execution,
        storedCommand,
        storedExecution
      )
    })
  }

  async get(scopeInput: CommandInboxScope): Promise<CommandInboxRecord | undefined> {
    const scope = CommandInboxScopeSchema.parse(scopeInput)
    return this.provider.transaction(async (transaction) => {
      await this.#assertNotRetired(transaction, scope)
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
      const keys = retiredCommandKeyCandidates(scope)
      const legacyId = recordId(keys.legacyScope)
      const currentId = recordId(keys.metadata.scopeKey)
      const legacy = await transaction.get(namespaces.retiredCommands, legacyId)
      const current = await transaction.get(namespaces.retiredCommands, currentId)
      if (current !== undefined) {
        assertSqliteRetiredCommandKey(current.value, currentId, keys.metadata.scopeKey)
        return true
      }
      const stored = await transaction.get(namespaces.commands, recordId(scopeKey(scope)))
      if (!stored) return legacy !== undefined
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
      if (legacy !== undefined) {
        const legacyValue = parseLegacySqliteRetirement(legacy.value)
        if (
          legacyValue.commandId !== command.commandId ||
          legacyValue.executionId !== command.executionId
        )
          throw new Error('RETIRED_COMMAND_KEY_CORRUPT')
      }
      await transaction.put({
        namespace: namespaces.retiredCommands,
        id: currentId,
        value: {
          scopeKey: keys.metadata.scopeKey,
          metadataVersion: keys.metadata.metadataVersion,
          identityDigest: keys.metadata.identityDigest,
          retiredAt:
            legacy === undefined ? retiredAt : parseLegacySqliteRetirement(legacy.value).retiredAt,
          commandId: command.commandId,
          executionId: command.executionId,
        },
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
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly retentionHoldPolicy?: RetentionHoldPolicy
    }
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
          const tombstone = await findSqliteRetirement(transaction, command)
          const execution = await transaction.get(
            namespaces.executions,
            recordId(command.executionId)
          )
          const state =
            execution === undefined ? undefined : ExecutionSchema.parse(execution.value).state
          const holds = await countSqliteMatchingActiveRetentionHolds(
            transaction,
            {
              classId: 'command-inbox',
              scope: {
                kind: 'project',
                workspaceId: command.workspaceId,
                projectId: command.projectId,
              },
            },
            options.retentionHoldPolicy
          )
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
              holds,
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
      readonly retentionHoldPolicy?: RetentionHoldPolicy
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
          const tombstone = await findSqliteRetirement(transaction, command)
          const execution = await transaction.get(
            namespaces.executions,
            recordId(command.executionId)
          )
          const state =
            execution === undefined ? undefined : ExecutionSchema.parse(execution.value).state
          const holds = await countSqliteMatchingActiveRetentionHolds(
            transaction,
            {
              classId: 'command-inbox',
              scope: {
                kind: 'project',
                workspaceId: command.workspaceId,
                projectId: command.projectId,
              },
            },
            options.retentionHoldPolicy
          )
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
            holds,
          })
          if (!counter.add(verdict)) {
            return { verdict, admitted: false, removed: false, conflicted: false }
          }
          if (verdict.verdict !== 'eligible' || dryRun) {
            return { verdict, admitted: true, removed: false, conflicted: false }
          }
          const keys = retiredCommandKeyCandidates(command)
          const retirementId = recordId(keys.metadata.scopeKey)
          const retirementValue =
            tombstone?.id === retirementId
              ? tombstone.value
              : {
                  scopeKey: keys.metadata.scopeKey,
                  metadataVersion: keys.metadata.metadataVersion,
                  identityDigest: keys.metadata.identityDigest,
                  retiredAt: parseLegacySqliteRetirement(tombstone?.value).retiredAt,
                  commandId: command.commandId,
                  executionId: command.executionId,
                }
          // Journal only after this candidate has been admitted to the bounded
          // pass. The trusted journal records an approved deletion intent for
          // restoration to replay before this transaction applies it.
          if (options.journal !== undefined) {
            await options.journal(
              RetentionJournalOperationSchema.array().parse([
                {
                  kind: 'sqlite.put' as const,
                  namespace: namespaces.retiredCommands,
                  id: retirementId,
                  value: retirementValue,
                },
                { kind: 'sqlite.delete', namespace: namespaces.commands, id: candidate.id },
                {
                  kind: 'sqlite.delete',
                  namespace: namespaces.commandByExecution,
                  id: recordId(command.executionId),
                },
              ])
            )
          }
          if (tombstone?.id !== retirementId) {
            await transaction.put({
              namespace: namespaces.retiredCommands,
              id: retirementId,
              value: json(retirementValue),
            })
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

  /** Delete replay tombstones only after their explicit 30-day retention class expires. */
  async deleteEligibleRetiredCommandKeys(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly afterId?: string
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
      readonly retentionHoldPolicy?: RetentionHoldPolicy
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('COMMAND_RETIREMENT_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter(
      'retired-command-keys',
      assessedAt,
      options.bound ?? 64
    )
    let deleted = 0
    let raced = 0
    let afterId = options.afterId
    let done = false
    while (!done) {
      const page = await this.provider.transaction((transaction) =>
        transaction.scan(namespaces.retiredCommands, {
          limit: Math.min(128, counter.remaining + 1),
          ...(afterId === undefined ? {} : { afterId }),
        })
      )
      if (page.length === 0) break
      for (const candidate of page) {
        if (!counter.admitCandidate()) {
          done = true
          break
        }
        afterId = candidate.id
        const outcome = await this.provider.transaction(async (transaction) => {
          const current = await transaction.get(namespaces.retiredCommands, candidate.id)
          if (current === undefined) return { verdict: undefined, removed: false, raced: true }
          if (current.revision !== candidate.revision)
            return { verdict: undefined, removed: false, raced: true }
          const fresh = parseSqliteRetiredCommandKey(current.id, current.value)
          const holds = await countSqliteMatchingActiveRetentionHolds(
            transaction,
            { classId: 'retired-command-keys' },
            options.retentionHoldPolicy
          )
          const expiry = new Date(Date.parse(fresh.retiredAt) + (options.policyRetainMs ?? 0))
          const verdict = evaluateRetentionEligibility({
            retentionExpiresAt:
              options.policyRetainMs === null || !Number.isFinite(expiry.getTime())
                ? undefined
                : expiry.toISOString(),
            now: assessedAt,
            policyRetainMs: options.policyRetainMs,
            ownerTerminal: true,
            publicationSettled: true,
            rejectionKeyReserved: true,
            pendingReferences: 0,
            holds,
          })
          counter.recordVerdict(verdict)
          if (verdict.verdict !== 'eligible' || dryRun)
            return { verdict, removed: false, raced: false }
          if (options.journal !== undefined) {
            await options.journal([
              {
                kind: 'sqlite.delete',
                namespace: namespaces.retiredCommands,
                id: candidate.id,
              },
            ])
          }
          const removed = await transaction.delete(
            namespaces.retiredCommands,
            candidate.id,
            candidate.revision
          )
          return { verdict, removed, raced: !removed }
        })
        if (outcome.verdict === undefined) {
          // A candidate that raced still consumes its bounded slot. Record a
          // conservative retention verdict rather than losing accounting.
          counter.recordVerdict({ verdict: 'retained', reason: 'unconfirmed_signal' })
        }
        if (outcome.removed) deleted += 1
        if (outcome.raced) raced += 1
      }
      if (page.length < Math.min(128, counter.remaining + 1)) break
    }
    return {
      dryRun,
      deleted,
      raced,
      ...counter.result(),
      ...(counter.result().truncated && afterId !== undefined ? { nextAfterId: afterId } : {}),
    }
  }

  /** Temporary safety containment until atomic full eligibility is implemented. */
  async deleteExpiredInbox(now: Date): Promise<number> {
    if (Number.isNaN(now.getTime())) throw new Error('COMMAND_RETENTION_INVALID_TIMESTAMP')
    throw new Error('COMMAND_RETENTION_ELIGIBILITY_REQUIRED')
  }

  async #assertNotRetired(
    transaction: PersistenceTransaction,
    scope: CommandInboxScope
  ): Promise<void> {
    const keys = retiredCommandKeyCandidates(scope)
    if (
      (await transaction.get(namespaces.retiredCommands, recordId(keys.legacyScope))) !==
        undefined ||
      (await transaction.get(namespaces.retiredCommands, recordId(keys.metadata.scopeKey))) !==
        undefined
    )
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

  async #admissionAllowance(
    transaction: PersistenceTransaction,
    command: CommandInboxRecord,
    execution: Execution,
    storedPlan: ExecutionPlan
  ) {
    const parentPlan = storedPlan.parentExecutionPlan
    if (execution.parentExecutionId === undefined) {
      if (parentPlan !== undefined) throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
    } else {
      const parentRecord = await transaction.get(
        namespaces.executions,
        recordId(execution.parentExecutionId)
      )
      if (parentRecord === undefined)
        throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
      const parent = ExecutionSchema.parse(parentRecord.value)
      if (
        parent.executionId !== execution.parentExecutionId ||
        parent.correlation.workspaceId !== execution.correlation.workspaceId ||
        parent.correlation.projectId !== execution.correlation.projectId ||
        parentPlan === undefined ||
        parent.executionPlan.executionPlanId !== parentPlan.executionPlanId ||
        parent.executionPlan.contentDigest !== parentPlan.contentDigest
      ) {
        throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
      }
    }
    return executionPlanBudgetAllowance(command, execution, storedPlan)
  }

  async #verifyAdmissionInTransaction(
    transaction: PersistenceTransaction,
    commandInput: CommandInboxRecord,
    executionInput: Execution,
    storedCommand: CommandInboxRecord,
    storedExecution: Execution
  ): Promise<void> {
    const suppliedSource = executionBudgetAdmissionSource(commandInput, executionInput)
    const storedSource = executionBudgetAdmissionSource(storedCommand, storedExecution)
    if (!isDeepStrictEqual(suppliedSource, storedSource)) throw invalidPersistedAdmission()
    if (
      commandInput.status === storedCommand.status &&
      executionInput.state === storedExecution.state &&
      ((commandInput.status === 'completed' && executionInput.state === 'completed') ||
        (commandInput.status === 'failed' &&
          ['failed', 'cancelled', 'timed_out'].includes(executionInput.state)))
    ) {
      return
    }
    const verified = await SqliteDurableUsageStore.withTransaction(
      transaction,
      storedCommand.workspaceId,
      async (store) => {
        const ledger = new DurableUsageLedger({ store })
        let summary: DurableUsageBudgetSummary
        try {
          summary = await ledger.summary(storedCommand.workspaceId, storedExecution.executionId)
        } catch (error) {
          if (error instanceof DurableUsageError && error.code === 'BUDGET_NOT_FOUND') {
            throw invalidPersistedAdmission()
          }
          throw error
        }
        const entries = await ledger.entries(storedCommand.workspaceId, storedExecution.executionId)
        const openingKey = budgetOpeningEntryIdempotencyKey(
          storedSource.idempotencyKey,
          storedExecution.executionId
        )
        const openingEntries = entries.filter((entry) => entry.source.idempotencyKey === openingKey)
        const opening = openingEntries[0]
        if (
          openingEntries.length !== 1 ||
          opening === undefined ||
          opening.sequence !== 1 ||
          opening.kind !== 'credit' ||
          opening.source.sourceId !== storedSource.sourceId
        ) {
          throw invalidPersistedAdmission()
        }
        const effect = await store.transaction(storedCommand.workspaceId, (usageTransaction) =>
          usageTransaction.getEffect(storedSource.idempotencyKey)
        )
        const openingSummary = {
          executionId: storedExecution.executionId,
          currency: summary.currency,
          maximumMicrounits: opening.quantity.value,
          maximumTokens: summary.maximumTokens,
          spentMicrounits: 0,
          reservedMicrounits: 0,
          availableMicrounits: opening.quantity.value,
          spentTokens: 0,
          reservedTokens: 0,
          availableTokens: summary.maximumTokens,
          settled: false,
        }
        if (
          effect === undefined ||
          effect.workspaceId !== storedCommand.workspaceId ||
          effect.executionId !== storedExecution.executionId ||
          effect.idempotencyKey !== storedSource.idempotencyKey ||
          !isDeepStrictEqual(effect.result, openingSummary)
        ) {
          throw invalidPersistedAdmission()
        }
        return summary
      }
    )
    if (verified.settled && executionStates.has(storedExecution.state)) {
      throw invalidPersistedAdmission()
    }
  }
}

function parseLegacySqliteRetirement(input: unknown): {
  readonly retiredAt: string
  readonly commandId: string
  readonly executionId: string
} {
  if (input === undefined || typeof input !== 'object' || input === null)
    throw new Error('RETIRED_COMMAND_KEY_CORRUPT')
  const value = input as Record<string, unknown>
  if (
    typeof value['retiredAt'] !== 'string' ||
    !Number.isFinite(Date.parse(value['retiredAt'])) ||
    new Date(value['retiredAt']).toISOString() !== value['retiredAt']
  )
    throw new Error('RETIRED_COMMAND_KEY_CORRUPT')
  const commandId = CommandInboxRecordSchema.shape.commandId.parse(value['commandId'])
  const executionId = ExecutionSchema.shape.executionId.parse(value['executionId'])
  return { retiredAt: value['retiredAt'], commandId, executionId }
}

function assertSqliteRetiredCommandKey(input: unknown, id: string, expectedScopeKey: string): void {
  const parsed = parseSqliteRetiredCommandKey(id, input)
  if (parsed.metadataVersion !== 2 || parsed.scopeKey !== expectedScopeKey)
    throw new Error('RETIRED_COMMAND_KEY_CORRUPT')
}

function parseSqliteRetiredCommandKey(
  id: string,
  input: unknown
): {
  readonly scopeKey: string
  readonly metadataVersion: number
  readonly identityDigest: string | null
  readonly retiredAt: string
  readonly commandId: string
  readonly executionId: string
} {
  const legacy = parseLegacySqliteRetirement(input)
  const value = input as Record<string, unknown>
  if (
    value['metadataVersion'] === undefined ||
    (value['metadataVersion'] === 1 && value['identityDigest'] === null)
  ) {
    return {
      scopeKey: '',
      metadataVersion: 1,
      identityDigest: null,
      ...legacy,
    }
  }
  if (
    value['metadataVersion'] !== 2 ||
    typeof value['scopeKey'] !== 'string' ||
    typeof value['identityDigest'] !== 'string' ||
    retiredCommandKeyFromMetadataV2(value['identityDigest']) !== value['scopeKey'] ||
    id !== recordId(value['scopeKey'])
  )
    throw new Error('RETIRED_COMMAND_KEY_CORRUPT')
  return {
    scopeKey: value['scopeKey'],
    metadataVersion: 2,
    identityDigest: value['identityDigest'],
    ...legacy,
  }
}

async function findSqliteRetirement(
  transaction: PersistenceTransaction,
  command: CommandInboxRecord
): Promise<{ readonly id: string; readonly value: unknown } | undefined> {
  const keys = retiredCommandKeyCandidates(command)
  const currentId = recordId(keys.metadata.scopeKey)
  const current = await transaction.get(namespaces.retiredCommands, currentId)
  if (current !== undefined) {
    const parsed = parseSqliteRetiredCommandKey(current.id, current.value)
    if (
      parsed.metadataVersion !== 2 ||
      parsed.scopeKey !== keys.metadata.scopeKey ||
      parsed.commandId !== command.commandId ||
      parsed.executionId !== command.executionId
    )
      throw new Error('RETIRED_COMMAND_KEY_CORRUPT')
    return current
  }
  const legacyId = recordId(keys.legacyScope)
  const legacy = await transaction.get(namespaces.retiredCommands, legacyId)
  if (legacy === undefined) return undefined
  const parsed = parseSqliteRetiredCommandKey(legacy.id, legacy.value)
  if (
    parsed.metadataVersion !== 1 ||
    parsed.commandId !== command.commandId ||
    parsed.executionId !== command.executionId
  )
    throw new Error('RETIRED_COMMAND_KEY_CORRUPT')
  return legacy
}

export class SqliteExecutionRepository implements ExecutionRepository {
  constructor(readonly provider: PersistenceProvider) {}

  /**
   * Deletes terminal executions and their settled attempts (#194) once the
   * retention duration has passed since the terminal instant, and only when
   * nothing that must outlive them still references them: the acceptance
   * record, either command receipt, any execution event, a reconciliation
   * checkpoint, a non-terminal attempt, runtime terminal-usage receipt, or
   * workflow job all retain the execution. This class is therefore the last to
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
      readonly retentionHoldPolicy?: RetentionHoldPolicy
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
          const retiredCommandReference = (await transaction.list(namespaces.retiredCommands)).some(
            (record) => {
              const rawValue = record.value as { executionId?: unknown } | null
              if (rawValue?.executionId !== execution.executionId) return false
              parseSqliteRetiredCommandKey(record.id, record.value)
              return true
            }
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
          const terminalUsage = (await transaction.list('runtime-terminal-usage')).some(
            (record) =>
              (record.value as { executionId?: unknown } | null)?.executionId ===
              execution.executionId
          )
          // Billing state has a separate retention lifecycle. Retaining only the
          // runtime terminal receipt does not protect budgets or replay receipts.
          // Positively identified references pin owners even when payloads are
          // damaged; a failed schema parse must never authorize owner deletion.
          let durableUsage = false
          for (const namespace of [
            'usage-budgets',
            'usage-effects',
            'usage-ledger-entries',
            'usage-entry-sequences',
          ]) {
            const referenced = (await transaction.list(namespace)).some((record) => {
              const value = record.value as {
                executionId?: unknown
                parentExecutionId?: unknown
                reservations?: { childExecutionId?: unknown }[]
              } | null
              return (
                value?.executionId === execution.executionId ||
                value?.parentExecutionId === execution.executionId ||
                (Array.isArray(value?.reservations) &&
                  value.reservations.some(
                    (reservation) => reservation?.childExecutionId === execution.executionId
                  ))
              )
            })
            if (referenced) {
              durableUsage = true
              break
            }
          }
          const workflowJobs = (await transaction.list('workflow-jobs')).some((record) => {
            const value = record.value as {
              workflowKey?: unknown
              input?: { executionId?: unknown } | null
            } | null
            return (
              value?.workflowKey === execution.executionId ||
              value?.input?.executionId === execution.executionId
            )
          })
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
          // Preserve positively identified provenance even if another proposal field is damaged.
          const memoryProposalReference = (await transaction.list('memory-write-proposals')).some(
            (record) => {
              const provenance = (
                record.value as {
                  provenance?: { sourceExecutionId?: unknown; sourceAttemptId?: unknown }
                } | null
              )?.provenance
              return (
                provenance?.sourceExecutionId === execution.executionId ||
                attempts.some((attempt) => attempt.attemptId === provenance?.sourceAttemptId)
              )
            }
          )
          const activeAttempts = attempts.filter(
            (attempt) => !terminalExecutionStates.has(attempt.state)
          )
          const attemptsComplete = hasCompleteAttemptHistory(
            execution.attemptCount,
            execution.latestAttemptId,
            attempts
          )
          const holds = await countSqliteMatchingActiveRetentionHolds(
            transaction,
            {
              classId: 'executions',
              scope: {
                kind: 'project',
                workspaceId: execution.correlation.workspaceId,
                projectId: execution.correlation.projectId,
              },
            },
            options.retentionHoldPolicy
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
              retiredCommandReference ||
              events ||
              checkpoints ||
              runtimeCommands ||
              terminalUsage ||
              durableUsage ||
              workflowJobs ||
              cancellationReceipts ||
              interactionReceiptReference ||
              interactionRequestReference ||
              memoryProposalReference ||
              activeAttempts.length > 0 ||
              !attemptsComplete
                ? 1
                : 0,
            holds,
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
      if (
        current.version !== expectedVersion ||
        !sameImmutableExecution(current, execution) ||
        current.latestAttemptId !== execution.latestAttemptId
      )
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
      const latestAttemptId = current.latestAttemptId
      if (latestAttemptId !== undefined) {
        await SqliteDurableUsageStore.withTransaction(
          transaction,
          current.correlation.workspaceId,
          (store) =>
            new DurableUsageLedger({ store }).assertRuntimeAttemptReleased(
              current.correlation.workspaceId,
              current.executionId,
              latestAttemptId
            )
        )
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
      readonly afterId?: string
      readonly retentionHoldPolicy?: RetentionHoldPolicy
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('EXECUTION_PLAN_RETENTION_INVALID_TIMESTAMP')
    if (
      options.afterId !== undefined &&
      (options.afterId.length === 0 || options.afterId.length > 128)
    )
      throw new Error('EXECUTION_PLAN_RETENTION_INVALID_CURSOR')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter(
      'execution-plans',
      assessedAt,
      options.bound ?? 64
    )
    let deleted = 0
    let raced = 0
    let scanned = 0
    let cursor = options.afterId
    let nextAfterId: string | undefined
    let truncated = false
    if (counter.bound === 0) {
      const lookahead = await this.provider.transaction((transaction) =>
        transaction.scan(namespaces.plans, {
          limit: 1,
          ...(cursor === undefined ? {} : { afterId: cursor }),
        })
      )
      truncated = lookahead.length > 0
    }
    while (scanned < counter.bound) {
      const remaining = counter.bound - scanned
      const limit = Math.max(1, Math.min(128, remaining + 1))
      const page = await this.provider.transaction((transaction) =>
        transaction.scan(namespaces.plans, {
          limit,
          ...(cursor === undefined ? {} : { afterId: cursor }),
        })
      )
      if (page.length === 0) break
      for (let index = 0; index < page.length; index += 1) {
        const record = page[index]!
        const outcome = await this.provider.transaction(async (transaction) => {
          const stored = await transaction.get(namespaces.plans, record.id)
          if (stored === undefined) {
            if (!dryRun)
              await clearReferenceRetentionWindow(transaction, 'executionPlans', record.id)
            return { verdict: undefined, removed: false, raced: true }
          }
          const plan = assertExecutionPlanIntegrity(stored.value)
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
          for (const descendant of await transaction.list(namespaces.plans)) {
            const parentPlanId = executionPlanParentId(descendant.value)
            if (parentPlanId !== undefined) references.add(parentPlanId)
          }
          const pendingReferences = references.has(plan.executionPlanId) ? 1 : 0
          const currentWindow = await getReferenceRetentionWindow(
            transaction,
            'executionPlans',
            stored.id
          )
          const holds = await countSqliteMatchingActiveRetentionHolds(
            transaction,
            {
              classId: 'execution-plans',
              scope: {
                kind: 'project',
                workspaceId: plan.correlation.workspaceId,
                projectId: plan.correlation.projectId,
              },
            },
            options.retentionHoldPolicy
          )
          const observed = observeReferenceRetentionWindow({
            now: assessedAt,
            unreferencedSince: currentWindow,
            pendingReferences,
            policyRetainMs: options.policyRetainMs,
          })
          if (!dryRun && observed.unreferencedSince !== currentWindow)
            await setReferenceRetentionWindow(
              transaction,
              'executionPlans',
              stored.id,
              observed.unreferencedSince
            )
          const verdict =
            options.policyRetainMs !== null && pendingReferences > 0
              ? { verdict: 'retained' as const, reason: 'reference_pending' as const }
              : evaluateRetentionEligibility({
                  retentionExpiresAt: observed.retentionExpiresAt,
                  now: assessedAt,
                  policyRetainMs: options.policyRetainMs,
                  ownerTerminal: true,
                  publicationSettled: true,
                  rejectionKeyReserved: true,
                  pendingReferences,
                  holds,
                })
          if (verdict.verdict !== 'eligible' || dryRun)
            return { verdict, removed: false, raced: false }
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
            return { verdict, removed: false, raced: true }
          }
          if (removed) await clearReferenceRetentionWindow(transaction, 'executionPlans', stored.id)
          return { verdict, removed, raced: !removed }
        })
        scanned += 1
        cursor = record.id
        if (outcome.verdict !== undefined) counter.add(outcome.verdict)
        if (outcome.removed) deleted += 1
        if (outcome.raced) raced += 1
        if (scanned >= counter.bound) {
          let hasLookahead = index + 1 < page.length
          if (!hasLookahead) {
            const lookahead = await this.provider.transaction((transaction) =>
              transaction.scan(namespaces.plans, {
                limit: 1,
                ...(cursor === undefined ? {} : { afterId: cursor }),
              })
            )
            hasLookahead = lookahead.length > 0
          }
          if (hasLookahead && scanned > 0) nextAfterId = cursor
          truncated = hasLookahead
          break
        }
      }
      if (truncated || scanned >= counter.bound) break
      if (page.length < limit) break
    }
    return {
      dryRun,
      deleted,
      raced,
      ...counter.result(),
      scanned,
      truncated,
      ...(nextAfterId === undefined ? {} : { nextAfterId }),
    }
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
        if (plan.parentExecutionPlan) {
          if (plan.parentExecutionPlan.executionPlanId === plan.executionPlanId) {
            throw new ExecutionPlanError('INVALID_REFERENCE', plan.executionPlanId)
          }
          await assertSqliteStoredParentPlanReference(transaction, plan.parentExecutionPlan)
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
        if (
          package_.contextPackageId !== plan.contextPackage.contextPackageId ||
          package_.contentDigest !== plan.contextPackage.contentDigest
        ) {
          throw new ExecutionPlanError(
            'MISSING_CONTEXT_PACKAGE',
            plan.contextPackage.contextPackageId
          )
        }
        await clearReferenceRetentionWindow(
          transaction,
          'contextPackages',
          recordId(plan.contextPackage.contextPackageId)
        )
        await clearReferenceRetentionWindow(transaction, 'executionPlans', id)
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
      if (
        package_.contextPackageId !== plan.contextPackage.contextPackageId ||
        package_.contentDigest !== plan.contextPackage.contentDigest
      ) {
        throw new ExecutionPlanError(
          'MISSING_CONTEXT_PACKAGE',
          plan.contextPackage.contextPackageId
        )
      }
      // Preserve validation's specific missing-context error contract before
      // the shared new-reference helper verifies the full plan/context pin.
      if (stored) await assertSqliteStoredPlanReference(transaction, plan)
      if (!stored) {
        if (plan.parentExecutionPlan) {
          if (plan.parentExecutionPlan.executionPlanId === plan.executionPlanId) {
            throw new ExecutionPlanError('INVALID_REFERENCE', plan.executionPlanId)
          }
          await assertSqliteStoredParentPlanReference(transaction, plan.parentExecutionPlan)
        }
        await clearReferenceRetentionWindow(
          transaction,
          'contextPackages',
          recordId(plan.contextPackage.contextPackageId)
        )
        await clearReferenceRetentionWindow(transaction, 'executionPlans', id)
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

function invalidPersistedAdmission(): DurableUsageError {
  return new DurableUsageError('STORE_STATE_INVALID')
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
