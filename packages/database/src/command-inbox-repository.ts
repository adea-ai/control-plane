import { isDeepStrictEqual } from 'node:util'
import {
  CommandInboxError,
  CommandInboxRecordSchema,
  CommandInboxScopeSchema,
  ExecutionSchema,
  type CommandAcceptanceRepository,
  type CommandAcceptanceResult,
  type CommandInboxRecord,
  type CommandInboxScope,
  type Execution,
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  retiredCommandKeyCandidates,
  retiredCommandKeyFromMetadataV2,
  retiredCommandKeyV1,
  type RetentionAssessment,
  type RetentionDeletionResult,
  RetentionJournalOperationSchema,
  type RetentionJournalSink,
  type RetentionHoldPolicy,
  RetentionHoldError,
} from '@control-plane/domain'
import {
  executionBudgetAdmissionSource,
  executionPlanBudgetAllowance,
  type ExecutionPlan,
} from '@control-plane/execution-plan'
import {
  DurableUsageLedger,
  budgetOpeningEntryIdempotencyKey,
  type DurableUsageBudgetSummary,
} from '@control-plane/usage-ledger'
import { DurableUsageError } from '@control-plane/usage-ledger/durable-contract'
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { fromExecutionRow, toExecutionRow } from './execution-repository.js'
import { commandInbox } from './schema/commands.js'
import { executions } from './schema/executions.js'
import { retiredCommandKeys } from './schema/retired-command-keys.js'
import {
  lockExecutionPlanReference,
  PostgresExecutionPlanRepository,
} from './execution-plan-repository.js'
import { PostgresDurableUsageStore } from './usage-store.js'
import {
  acquireAdmissionRolloutSharedLock,
  assertAdmissionRolloutOpen,
} from './admission-rollout.js'
import {
  acquirePostgresRetentionHoldClassMutex,
  countPostgresMatchingActiveRetentionHolds,
  validatePostgresRetentionHoldPolicy,
} from './retention-hold-repository.js'

const terminalExecutionStates = new Set<string>(['completed', 'failed', 'cancelled', 'timed_out'])

export class PostgresCommandAcceptanceRepository implements CommandAcceptanceRepository {
  readonly #budgetAdmission: boolean

  constructor(
    readonly database: ControlPlaneDatabase,
    options: { readonly budgetAdmission?: boolean } = {}
  ) {
    this.#budgetAdmission = options.budgetAdmission === true
  }

  /**
   * Read-only eligibility assessment for the command-inbox class (#194).
   * Bounded by `bound` expired candidates, ordered oldest-deadline first, and
   * evaluated with the shared predicate. Never deletes: eligibility is
   * revalidated per candidate at claim time.
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
    const candidates = await this.database
      .select({
        status: commandInbox.status,
        retentionExpiresAt: commandInbox.retentionExpiresAt,
        reconciliationRequiredAt: commandInbox.reconciliationRequiredAt,
        executionState: executions.state,
        callerPrincipalId: commandInbox.callerPrincipalId,
        operation: commandInbox.operation,
        workspaceId: commandInbox.workspaceId,
        projectId: commandInbox.projectId,
        idempotencyKey: commandInbox.idempotencyKey,
        ownerWorkspaceId: executions.workspaceId,
        ownerProjectId: executions.projectId,
      })
      .from(commandInbox)
      .innerJoin(executions, eq(executions.executionId, commandInbox.executionId))
      .where(lt(commandInbox.retentionExpiresAt, now))
      .orderBy(asc(commandInbox.retentionExpiresAt))
      .limit(counter.bound + 1)
    await this.database.transaction((transaction) =>
      validatePostgresRetentionHoldPolicy(transaction, options.retentionHoldPolicy)
    )
    const retiredKeys =
      candidates.length === 0
        ? new Set<string>()
        : new Set(
            (
              await this.database
                .select({ scopeKey: retiredCommandKeys.scopeKey })
                .from(retiredCommandKeys)
                .where(
                  inArray(
                    retiredCommandKeys.scopeKey,
                    candidates.flatMap((candidate) => {
                      const keys = retiredCommandKeyCandidates(
                        CommandInboxScopeSchema.parse(candidate)
                      )
                      return [keys.legacyKey, keys.metadata.scopeKey]
                    })
                  )
                )
            ).map((row) => row.scopeKey)
          )
    for (const candidate of candidates) {
      if (
        candidate.workspaceId !== candidate.ownerWorkspaceId ||
        candidate.projectId !== candidate.ownerProjectId
      ) {
        throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
      }
      const holds = await this.database.transaction((transaction) =>
        countPostgresMatchingActiveRetentionHolds(
          transaction,
          {
            classId: 'command-inbox',
            scope: {
              kind: 'project',
              workspaceId: candidate.ownerWorkspaceId,
              projectId: candidate.ownerProjectId,
            },
          },
          options.retentionHoldPolicy
        )
      )
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt: candidate.retentionExpiresAt.toISOString(),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        ownerTerminal:
          ['completed', 'failed'].includes(candidate.status) &&
          terminalExecutionStates.has(candidate.executionState),
        publicationSettled: true,
        rejectionKeyReserved: (() => {
          const keys = retiredCommandKeyCandidates(CommandInboxScopeSchema.parse(candidate))
          return retiredKeys.has(keys.legacyKey) || retiredKeys.has(keys.metadata.scopeKey)
        })(),
        pendingReferences: candidate.reconciliationRequiredAt === null ? 0 : 1,
        holds,
      })
      if (!counter.add(verdict)) break
    }
    return counter.result()
  }

  /**
   * Deletes expired, eligible command-inbox rows (#194) while keeping the
   * reserved rejection key, so a replay of the same scoped idempotency key
   * still fails closed with COMMAND_RETENTION_EXPIRED.
   *
   * Each candidate is revalidated immediately before deletion: the delete is
   * guarded by the candidate's status and deadline, so a row that changed
   * between selection and deletion is reported as `raced` (affected rows 0)
   * rather than removed on stale evidence. `dryRun` defaults to true.
   */
  async deleteEligibleInbox(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
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
    const candidates = await this.database
      .select({
        commandId: commandInbox.commandId,
        executionId: commandInbox.executionId,
      })
      .from(commandInbox)
      .innerJoin(executions, eq(executions.executionId, commandInbox.executionId))
      .where(lt(commandInbox.retentionExpiresAt, now))
      .orderBy(asc(commandInbox.retentionExpiresAt))
      .limit(counter.bound + 1)
    await this.database.transaction((transaction) =>
      validatePostgresRetentionHoldPolicy(transaction, options.retentionHoldPolicy)
    )
    for (const candidate of candidates) {
      if (!counter.admitCandidate()) break
      const outcome = await this.database.transaction(async (transaction) => {
        await acquirePostgresRetentionHoldClassMutex(transaction, 'command-inbox')
        const [owner] = await transaction
          .select({
            executionId: executions.executionId,
            state: executions.state,
            workspaceId: executions.workspaceId,
            projectId: executions.projectId,
          })
          .from(executions)
          .where(eq(executions.executionId, candidate.executionId))
          .limit(1)
          .for('update')
        const [stored] = await transaction
          .select({
            commandId: commandInbox.commandId,
            executionId: commandInbox.executionId,
            status: commandInbox.status,
            retentionExpiresAt: commandInbox.retentionExpiresAt,
            reconciliationRequiredAt: commandInbox.reconciliationRequiredAt,
            callerPrincipalId: commandInbox.callerPrincipalId,
            operation: commandInbox.operation,
            workspaceId: commandInbox.workspaceId,
            projectId: commandInbox.projectId,
            idempotencyKey: commandInbox.idempotencyKey,
          })
          .from(commandInbox)
          .where(eq(commandInbox.commandId, candidate.commandId))
          .limit(1)
          .for('update')
        if (owner === undefined || stored === undefined || stored.executionId !== owner.executionId)
          return { bound: false, deleted: false, raced: true }
        if (stored.workspaceId !== owner.workspaceId || stored.projectId !== owner.projectId) {
          throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
        }
        const keys = retiredCommandKeyCandidates(CommandInboxScopeSchema.parse(stored))
        const retirements = await transaction
          .select({
            scopeKey: retiredCommandKeys.scopeKey,
            commandId: retiredCommandKeys.commandId,
            executionId: retiredCommandKeys.executionId,
            retiredAt: retiredCommandKeys.retiredAt,
            metadataVersion: retiredCommandKeys.metadataVersion,
            identityDigest: retiredCommandKeys.identityDigest,
          })
          .from(retiredCommandKeys)
          .where(inArray(retiredCommandKeys.scopeKey, [keys.legacyKey, keys.metadata.scopeKey]))
        for (const retirement of retirements) {
          if (
            retirement.commandId !== stored.commandId ||
            retirement.executionId !== stored.executionId ||
            !validRetiredCommandKeyMetadata(retirement)
          ) {
            throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
          }
        }
        const retirement =
          retirements.find((row) => row.scopeKey === keys.metadata.scopeKey) ?? retirements[0]
        const holds = await countPostgresMatchingActiveRetentionHolds(
          transaction,
          {
            classId: 'command-inbox',
            scope: { kind: 'project', workspaceId: owner.workspaceId, projectId: owner.projectId },
          },
          options.retentionHoldPolicy
        )
        const verdict = evaluateRetentionEligibility({
          retentionExpiresAt: stored.retentionExpiresAt.toISOString(),
          now: assessedAt,
          policyRetainMs: options.policyRetainMs,
          ownerTerminal:
            ['completed', 'failed'].includes(stored.status) &&
            terminalExecutionStates.has(owner.state),
          publicationSettled: true,
          rejectionKeyReserved: retirement !== undefined,
          pendingReferences: stored.reconciliationRequiredAt === null ? 0 : 1,
          holds,
        })
        counter.recordVerdict(verdict)
        if (verdict.verdict !== 'eligible' || dryRun)
          return { bound: false, deleted: false, raced: false }
        if (retirement !== undefined && retirement.scopeKey !== keys.metadata.scopeKey) {
          await transaction
            .insert(retiredCommandKeys)
            .values({
              scopeKey: keys.metadata.scopeKey,
              commandId: stored.commandId,
              executionId: stored.executionId,
              retiredAt: retirement.retiredAt,
              metadataVersion: keys.metadata.metadataVersion,
              identityDigest: keys.metadata.identityDigest,
            })
            .onConflictDoNothing()
        }
        // The rejection key is a precondition of eligibility, so the journal
        // restates it as well as the delete before the transaction applies them.
        if (options.journal !== undefined) {
          await options.journal([
            ...(retirement === undefined
              ? []
              : [
                  {
                    kind: 'postgres.retireCommandKey' as const,
                    scopeKey: keys.metadata.scopeKey,
                    commandId: stored.commandId,
                    executionId: stored.executionId,
                    retiredAt: retirement.retiredAt.toISOString(),
                  },
                ]),
            { kind: 'postgres.deleteCommand', commandId: stored.commandId },
          ])
        }
        const removed = await transaction
          .delete(commandInbox)
          .where(
            and(
              eq(commandInbox.commandId, stored.commandId),
              eq(commandInbox.status, stored.status),
              lt(commandInbox.retentionExpiresAt, now)
            )
          )
          .returning({ commandId: commandInbox.commandId })
        return { bound: false, deleted: removed.length === 1, raced: removed.length !== 1 }
      })
      if (outcome.bound) break
      if (outcome.deleted) deleted += 1
      if (outcome.raced) raced += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }

  /** Temporary safety containment until atomic full eligibility is implemented. */
  async deleteExpiredInbox(now: Date): Promise<number> {
    if (Number.isNaN(now.getTime())) throw new Error('COMMAND_RETENTION_INVALID_TIMESTAMP')
    throw new Error('COMMAND_RETENTION_ELIGIBILITY_REQUIRED')
  }

  async accept(
    command: CommandInboxRecord,
    execution: Execution
  ): Promise<CommandAcceptanceResult> {
    const parsedCommand = CommandInboxRecordSchema.parse(command)
    const parsedExecution = ExecutionSchema.parse(execution)
    return this.database.transaction(
      async (transaction) => {
        await acquireAdmissionRolloutSharedLock(transaction)
        if (this.#budgetAdmission) {
          await PostgresDurableUsageStore.acquireTransactionLocks(
            transaction,
            parsedCommand.workspaceId
          )
        }
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${retiredCommandKeyV1(parsedCommand)}, 0))`
        )
        await assertNotRetired(transaction, parsedCommand)
        const [existingScope] = await transaction
          .select({ commandId: commandInbox.commandId })
          .from(commandInbox)
          .where(scopeWhere(parsedCommand))
          .limit(1)
        let allowance: ReturnType<typeof executionPlanBudgetAllowance> | undefined
        if (!existingScope) {
          const [existingCommandId] = await transaction
            .select({ commandId: commandInbox.commandId })
            .from(commandInbox)
            .where(eq(commandInbox.commandId, parsedCommand.commandId))
            .limit(1)
          if (existingCommandId) throw new Error('COMMAND_ID_CONFLICT')
          await assertAdmissionRolloutOpen(transaction)
          if (
            parsedCommand.executionPlan.executionPlanId !==
              parsedExecution.executionPlan.executionPlanId ||
            parsedCommand.executionPlan.contentDigest !==
              parsedExecution.executionPlan.contentDigest ||
            !(await lockExecutionPlanReference(transaction, parsedExecution.executionPlan))
          ) {
            throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
          }
          if (this.#budgetAdmission) {
            const plan = await new PostgresExecutionPlanRepository(transaction).get(
              parsedExecution.executionPlan
            )
            if (plan === undefined) throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
            allowance = await this.#admissionAllowance(
              transaction,
              parsedCommand,
              parsedExecution,
              plan
            )
          }
        }
        const insertedCommand = await transaction
          .insert(commandInbox)
          .values(toCommandRow(parsedCommand))
          .onConflictDoNothing()
          .returning({ commandId: commandInbox.commandId })
        if (insertedCommand.length === 1) {
          await transaction.insert(executions).values(toExecutionRow(parsedExecution))
          if (allowance !== undefined) {
            await PostgresDurableUsageStore.withTransaction(
              transaction,
              allowance.workspaceId,
              (store) => new DurableUsageLedger({ store }).openBudget(allowance)
            )
          }
          return { outcome: 'accepted', command: parsedCommand, execution: parsedExecution }
        }

        const [existingRow] = await transaction
          .select()
          .from(commandInbox)
          .where(scopeWhere(parsedCommand))
          .limit(1)
        if (!existingRow) throw new Error('COMMAND_ID_CONFLICT')
        const existing = fromCommandRow(existingRow)
        const [executionRow] = await transaction
          .select()
          .from(executions)
          .where(eq(executions.executionId, existing.executionId))
          .limit(1)
          .for('key share')
        if (!executionRow) throw new Error('COMMAND_EXECUTION_INVARIANT_VIOLATION')
        const existingExecution = fromExecutionRow(executionRow)
        if (existing.payloadHash === parsedCommand.payloadHash) {
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

        const [conflictedRow] = await transaction
          .update(commandInbox)
          .set({
            conflictCount: sql`${commandInbox.conflictCount} + 1`,
            lastConflictAt: new Date(parsedCommand.lastSeenAt),
            lastSeenAt: new Date(parsedCommand.lastSeenAt),
            version: sql`${commandInbox.version} + 1`,
          })
          .where(eq(commandInbox.commandId, existing.commandId))
          .returning()
        if (!conflictedRow) throw new Error('COMMAND_CONFLICT_AUDIT_FAILED')
        return {
          outcome: 'conflict',
          command: fromCommandRow(conflictedRow),
          execution: existingExecution,
        }
      },
      { accessMode: 'read write', deferrable: false, isolationLevel: 'read committed' }
    )
  }

  async verifyAdmission(
    commandInput: CommandInboxRecord,
    executionInput: Execution
  ): Promise<void> {
    if (!this.#budgetAdmission) return
    const command = CommandInboxRecordSchema.parse(commandInput)
    const execution = ExecutionSchema.parse(executionInput)
    await this.database.transaction(
      async (transaction) => {
        await PostgresDurableUsageStore.acquireTransactionLocks(transaction, command.workspaceId)
        const [storedCommandRow] = await transaction
          .select()
          .from(commandInbox)
          .where(scopeWhere(command))
          .limit(1)
        if (storedCommandRow === undefined) throw invalidPersistedAdmission()
        const storedCommand = fromCommandRow(storedCommandRow)
        const [storedExecutionRow] = await transaction
          .select()
          .from(executions)
          .where(eq(executions.executionId, storedCommand.executionId))
          .limit(1)
          .for('key share')
        if (storedExecutionRow === undefined) throw invalidPersistedAdmission()
        await this.#verifyAdmissionInTransaction(
          transaction,
          command,
          execution,
          storedCommand,
          fromExecutionRow(storedExecutionRow)
        )
      },
      { accessMode: 'read write', deferrable: false, isolationLevel: 'read committed' }
    )
  }

  async get(scope: CommandInboxScope): Promise<CommandInboxRecord | undefined> {
    const parsed = CommandInboxScopeSchema.parse(scope)
    await assertNotRetired(this.database, parsed)
    const [row] = await this.database.select().from(commandInbox).where(scopeWhere(parsed)).limit(1)
    return row ? fromCommandRow(row) : undefined
  }

  /** Reserve a rejection key; domain payload deletion remains a separate operation. */
  async retireExpiredCommand(scopeInput: CommandInboxScope, retiredAt: string): Promise<boolean> {
    const scope = CommandInboxScopeSchema.parse(scopeInput)
    const timestamp = new Date(retiredAt)
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== retiredAt)
      throw new Error('COMMAND_RETIREMENT_INVALID_TIMESTAMP')
    const keys = retiredCommandKeyCandidates(scope)
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${keys.legacyKey}, 0))`
      )
      const retiredRows = await transaction
        .select()
        .from(retiredCommandKeys)
        .where(inArray(retiredCommandKeys.scopeKey, [keys.legacyKey, keys.metadata.scopeKey]))
      const retiredV2 = retiredRows.find((row) => row.scopeKey === keys.metadata.scopeKey)
      if (retiredV2 !== undefined) {
        if (!validRetiredCommandKeyMetadata(retiredV2))
          throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
        return true
      }
      // Discover ownership without claiming the command. Both retirement and
      // deletion lock the execution before the command, avoiding an inversion.
      const [observed] = await transaction
        .select()
        .from(commandInbox)
        .where(scopeWhere(scope))
        .limit(1)
      if (!observed) return retiredRows.length > 0
      const [executionRow] = await transaction
        .select()
        .from(executions)
        .where(eq(executions.executionId, observed.executionId))
        .limit(1)
        .for('update')
      if (!executionRow) throw new Error('COMMAND_EXECUTION_INVARIANT_VIOLATION')
      const [row] = await transaction
        .select()
        .from(commandInbox)
        .where(scopeWhere(scope))
        .limit(1)
        .for('update')
      if (!row) return false
      const command = fromCommandRow(row)
      if (command.executionId !== executionRow.executionId)
        throw new Error('COMMAND_EXECUTION_INVARIANT_VIOLATION')
      const execution = fromExecutionRow(executionRow)
      if (
        !['completed', 'failed'].includes(command.status) ||
        !['completed', 'failed', 'cancelled', 'timed_out'].includes(execution.state) ||
        timestamp.getTime() <= Date.parse(command.retentionExpiresAt)
      )
        return false
      const legacyRetirement = retiredRows.find((retired) => retired.scopeKey === keys.legacyKey)
      if (
        legacyRetirement !== undefined &&
        (legacyRetirement.commandId !== command.commandId ||
          legacyRetirement.executionId !== command.executionId ||
          !validRetiredCommandKeyMetadata(legacyRetirement))
      ) {
        throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
      }
      await transaction.insert(retiredCommandKeys).values({
        scopeKey: keys.metadata.scopeKey,
        commandId: command.commandId,
        executionId: command.executionId,
        retiredAt: legacyRetirement?.retiredAt ?? timestamp,
        metadataVersion: keys.metadata.metadataVersion,
        identityDigest: keys.metadata.identityDigest,
      })
      return true
    })
  }

  /** Deletes replay tombstones only after the explicit retention class expires. */
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
      const limit = Math.min(128, counter.remaining + 1)
      const candidates = await this.database
        .select({ scopeKey: retiredCommandKeys.scopeKey })
        .from(retiredCommandKeys)
        .where(afterId === undefined ? sql`true` : gt(retiredCommandKeys.scopeKey, afterId))
        .orderBy(asc(retiredCommandKeys.scopeKey))
        .limit(limit)
      if (candidates.length === 0) break
      for (const candidate of candidates) {
        if (!counter.admitCandidate()) {
          done = true
          break
        }
        afterId = candidate.scopeKey
        const outcome = await this.database.transaction(async (transaction) => {
          await acquirePostgresRetentionHoldClassMutex(transaction, 'retired-command-keys')
          const [stored] = await transaction
            .select()
            .from(retiredCommandKeys)
            .where(eq(retiredCommandKeys.scopeKey, candidate.scopeKey))
            .limit(1)
            .for('update')
          if (stored === undefined) return { verdict: undefined, deleted: false, raced: true }
          const validMetadata =
            (stored.metadataVersion === 1 && stored.identityDigest === null) ||
            (stored.metadataVersion === 2 &&
              stored.identityDigest !== null &&
              retiredCommandKeyFromMetadataV2(stored.identityDigest) === stored.scopeKey)
          if (
            !validMetadata ||
            !Number.isFinite(stored.retiredAt.getTime()) ||
            !CommandInboxRecordSchema.shape.commandId.safeParse(stored.commandId).success ||
            !ExecutionSchema.shape.executionId.safeParse(stored.executionId).success
          )
            throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
          const holds = await countPostgresMatchingActiveRetentionHolds(
            transaction,
            { classId: 'retired-command-keys' },
            options.retentionHoldPolicy
          )
          const expiry = new Date(stored.retiredAt.getTime() + (options.policyRetainMs ?? 0))
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
            return { verdict, deleted: false, raced: false }
          if (options.journal !== undefined) {
            await options.journal(
              RetentionJournalOperationSchema.array().parse([
                { kind: 'postgres.deleteRetiredCommandKey', scopeKey: stored.scopeKey },
              ])
            )
          }
          const removed = await transaction
            .delete(retiredCommandKeys)
            .where(eq(retiredCommandKeys.scopeKey, stored.scopeKey))
            .returning({ scopeKey: retiredCommandKeys.scopeKey })
          return { verdict, deleted: removed.length === 1, raced: removed.length !== 1 }
        })
        if (outcome.verdict === undefined)
          counter.recordVerdict({ verdict: 'retained', reason: 'unconfirmed_signal' })
        if (outcome.deleted) deleted += 1
        if (outcome.raced) raced += 1
      }
      if (candidates.length < limit) break
    }
    const result = counter.result()
    return {
      dryRun,
      deleted,
      raced,
      ...result,
      ...(result.truncated && afterId !== undefined ? { nextAfterId: afterId } : {}),
    }
  }

  async getByExecutionId(executionId: string): Promise<CommandInboxRecord | undefined> {
    const parsedId = ExecutionSchema.shape.executionId.parse(executionId)
    const [row] = await this.database
      .select()
      .from(commandInbox)
      .where(eq(commandInbox.executionId, parsedId))
      .limit(1)
    return row ? fromCommandRow(row) : undefined
  }

  async getExecution(executionId: string): Promise<Execution | undefined> {
    const parsedId = ExecutionSchema.shape.executionId.parse(executionId)
    const [row] = await this.database
      .select()
      .from(executions)
      .where(eq(executions.executionId, parsedId))
      .limit(1)
    return row ? fromExecutionRow(row) : undefined
  }

  async compareAndSet(expectedVersion: number, command: CommandInboxRecord): Promise<boolean> {
    const parsed = CommandInboxRecordSchema.parse(command)
    const updated = await this.database
      .update(commandInbox)
      .set(toCommandUpdate(parsed))
      .where(
        and(
          eq(commandInbox.commandId, parsed.commandId),
          eq(commandInbox.version, expectedVersion),
          scopeWhere(parsed)
        )
      )
      .returning({ commandId: commandInbox.commandId })
    return updated.length === 1
  }

  async #admissionAllowance(
    transaction: CommandTransaction,
    command: CommandInboxRecord,
    execution: Execution,
    plan: ExecutionPlan
  ) {
    const parentPlan = plan.parentExecutionPlan
    if (execution.parentExecutionId === undefined) {
      if (parentPlan !== undefined) throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
    } else {
      const [parentRow] = await transaction
        .select()
        .from(executions)
        .where(eq(executions.executionId, execution.parentExecutionId))
        .limit(1)
        .for('key share')
      if (parentRow === undefined) throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
      const parent = fromExecutionRow(parentRow)
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
    return executionPlanBudgetAllowance(command, execution, plan)
  }

  async #verifyAdmissionInTransaction(
    transaction: CommandTransaction,
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
    const verified = await PostgresDurableUsageStore.withTransaction(
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
    if (verified.settled && !terminalExecutionStates.has(storedExecution.state)) {
      throw invalidPersistedAdmission()
    }
  }
}

type CommandRow = typeof commandInbox.$inferSelect

type CommandTransaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]

function invalidPersistedAdmission(): DurableUsageError {
  return new DurableUsageError('STORE_STATE_INVALID')
}

async function assertNotRetired(
  database: ControlPlaneDatabase | CommandTransaction,
  scope: CommandInboxScope
): Promise<void> {
  const keys = retiredCommandKeyCandidates(scope)
  const [row] = await database
    .select()
    .from(retiredCommandKeys)
    .where(inArray(retiredCommandKeys.scopeKey, [keys.legacyKey, keys.metadata.scopeKey]))
    .limit(1)
  if (row) throw new CommandInboxError('COMMAND_RETENTION_EXPIRED')
}

function validRetiredCommandKeyMetadata(row: {
  readonly scopeKey: string
  readonly metadataVersion: number
  readonly identityDigest: string | null
}): boolean {
  if (row.metadataVersion === 1) return row.identityDigest === null
  return (
    row.metadataVersion === 2 &&
    row.identityDigest !== null &&
    retiredCommandKeyFromMetadataV2(row.identityDigest) === row.scopeKey
  )
}

function toCommandRow(command: CommandInboxRecord): typeof commandInbox.$inferInsert {
  return {
    commandId: command.commandId,
    callerPrincipalId: command.callerPrincipalId,
    operation: command.operation,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    taskId: command.taskId,
    agentId: command.agentId,
    requestId: command.requestId,
    idempotencyKey: command.idempotencyKey,
    payloadHash: command.payloadHash,
    status: command.status,
    executionId: command.executionId,
    executionPlanId: command.executionPlan.executionPlanId,
    executionPlanDigest: command.executionPlan.contentDigest,
    executionPlanSchemaVersion: command.executionPlan.schemaVersion,
    version: command.version,
    conflictCount: command.conflictCount,
    receivedAt: new Date(command.receivedAt),
    lastSeenAt: new Date(command.lastSeenAt),
    retentionExpiresAt: new Date(command.retentionExpiresAt),
    lastConflictAt: optionalDate(command.lastConflictAt),
    processingAt: optionalDate(command.processingAt),
    reconciliationRequiredAt: optionalDate(command.reconciliationRequiredAt),
    terminalAt: optionalDate(command.terminalAt),
    resultReference: command.resultReference ?? null,
    errorReference: command.errorReference ?? null,
  }
}

function toCommandUpdate(command: CommandInboxRecord): Partial<typeof commandInbox.$inferInsert> {
  return {
    status: command.status,
    version: command.version,
    conflictCount: command.conflictCount,
    lastSeenAt: new Date(command.lastSeenAt),
    lastConflictAt: optionalDate(command.lastConflictAt),
    processingAt: optionalDate(command.processingAt),
    reconciliationRequiredAt: optionalDate(command.reconciliationRequiredAt),
    terminalAt: optionalDate(command.terminalAt),
    resultReference: command.resultReference ?? null,
    errorReference: command.errorReference ?? null,
  }
}

function fromCommandRow(row: CommandRow): CommandInboxRecord {
  return CommandInboxRecordSchema.parse({
    commandId: row.commandId,
    callerPrincipalId: row.callerPrincipalId,
    operation: row.operation,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    taskId: row.taskId,
    agentId: row.agentId,
    requestId: row.requestId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    status: row.status,
    executionId: row.executionId,
    executionPlan: {
      executionPlanId: row.executionPlanId,
      contentDigest: row.executionPlanDigest,
      schemaVersion: row.executionPlanSchemaVersion,
    },
    version: row.version,
    conflictCount: row.conflictCount,
    receivedAt: row.receivedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    retentionExpiresAt: row.retentionExpiresAt.toISOString(),
    ...(row.lastConflictAt ? { lastConflictAt: row.lastConflictAt.toISOString() } : {}),
    ...(row.processingAt ? { processingAt: row.processingAt.toISOString() } : {}),
    ...(row.reconciliationRequiredAt
      ? { reconciliationRequiredAt: row.reconciliationRequiredAt.toISOString() }
      : {}),
    ...(row.terminalAt ? { terminalAt: row.terminalAt.toISOString() } : {}),
    ...(row.resultReference ? { resultReference: row.resultReference } : {}),
    ...(row.errorReference ? { errorReference: row.errorReference } : {}),
  })
}

function scopeWhere(scope: CommandInboxScope) {
  return and(
    eq(commandInbox.callerPrincipalId, scope.callerPrincipalId),
    eq(commandInbox.operation, scope.operation),
    eq(commandInbox.workspaceId, scope.workspaceId),
    eq(commandInbox.projectId, scope.projectId),
    eq(commandInbox.idempotencyKey, scope.idempotencyKey)
  )
}

function optionalDate(value: string | undefined): Date | null {
  return value ? new Date(value) : null
}
