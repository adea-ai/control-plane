import { and, asc, eq, gt, or, sql, type SQL } from 'drizzle-orm'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  CommandInboxRecordSchema,
  type CommandInboxRecord,
  type Execution,
  retiredCommandKeyFromMetadataV2,
} from '@control-plane/domain'
import { DelegationRecordSchema } from '@control-plane/orchestration'
import { fromAttemptRow, fromExecutionRow } from './execution-repository.js'
import { fromRuntimeCommandRow } from './runtime-command-repository.js'
import type { ControlPlaneDatabase } from './connection.js'
import type { AdmissionRolloutStatus } from './admission-rollout.js'
import {
  commandInbox,
  delegations,
  executionAttempts,
  executions,
  retiredCommandKeys,
  runtimeCommands,
} from './schema/index.js'

const PAGE_SIZE = 128
const MAX_INVENTORY_ROWS = 20_000
const MAX_DIAGNOSTICS = 96
export const ADMISSION_ROLLOUT_AUDIT_BUDGET_MS = 20_000
const ADMISSION_ROLLOUT_SEARCH_PATH = 'pg_catalog, public, pg_temp'

type AdmissionRolloutTransaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]

export interface AdmissionRolloutAuditCounts {
  readonly executions: number
  readonly activeExecutions: number
  readonly attempts: number
  readonly commands: number
  readonly runtimeCommands: number
  readonly unresolvedRuntimeCommands: number
  readonly delegations: number
  readonly retiredCommandKeys: number
  readonly lineageErrors: number
}

export interface AdmissionRolloutDiagnostic {
  readonly code: string
  readonly entityId?: string
}

export interface AdmissionRolloutAuditReport {
  readonly gate: AdmissionRolloutStatus
  readonly complete: boolean
  readonly canResume: boolean
  readonly counts: AdmissionRolloutAuditCounts
  readonly diagnostics: readonly AdmissionRolloutDiagnostic[]
}

interface OwnerRecord {
  readonly execution: Execution
  readonly rawId: string
  attempts: { readonly attemptId: string; readonly sequence: number; readonly state: string }[]
  command?: CommandInboxRecord
  delegation?: { readonly parentExecutionId: string; readonly state: string }
  hasRetiredCommand: boolean
}

interface AuditCountsMutable {
  executions: number
  activeExecutions: number
  attempts: number
  commands: number
  runtimeCommands: number
  unresolvedRuntimeCommands: number
  delegations: number
  retiredCommandKeys: number
  lineageErrors: number
}

export async function setAdmissionRolloutTransactionBounds(
  transaction: Pick<AdmissionRolloutTransaction, 'execute'>,
  deadline: number
): Promise<void> {
  const remainingMs = Math.max(1, Math.floor(deadline - Date.now()))
  await setAdmissionRolloutSearchPath(transaction)
  await transaction.execute(sql.raw("select set_config('lock_timeout', '2000ms', true)"))
  await transaction.execute(
    sql.raw("select set_config('statement_timeout', '" + remainingMs + "ms', true)")
  )
}

export async function setAdmissionRolloutSearchPath(transaction: {
  execute(query: SQL): Promise<unknown>
}): Promise<void> {
  await transaction.execute(
    sql.raw(`select set_config('search_path', '${ADMISSION_ROLLOUT_SEARCH_PATH}', true)`)
  )
}

export async function lockAdmissionRolloutInventory(
  transaction: Pick<AdmissionRolloutTransaction, 'execute'>
): Promise<void> {
  await transaction.execute(
    sql.raw(
      'lock table public.executions, public.execution_attempts, public.command_inbox, public.runtime_commands, public.retired_command_keys, public.delegations in share mode'
    )
  )
}

export async function auditAdmissionRolloutInventory(
  transaction: AdmissionRolloutTransaction,
  gate: AdmissionRolloutStatus,
  deadline: number
): Promise<AdmissionRolloutAuditReport> {
  let complete = true
  let totalRows = 0
  let diagnosticsTruncated = false
  const diagnostics: AdmissionRolloutDiagnostic[] = []
  const counts: AuditCountsMutable = {
    executions: 0,
    activeExecutions: 0,
    attempts: 0,
    commands: 0,
    runtimeCommands: 0,
    unresolvedRuntimeCommands: 0,
    delegations: 0,
    retiredCommandKeys: 0,
    lineageErrors: 0,
  }
  const owners = new Map<string, OwnerRecord>()
  const attemptsById = new Map<
    string,
    { readonly executionId: string; readonly sequence: number; readonly state: string }
  >()
  const commandIds = new Set<string>()

  const diagnose = (code: string, id?: unknown, lineage = false) => {
    if (lineage) {
      counts.lineageErrors++
      complete = false
    }
    const safeId = safeIdentifier(id)
    if (diagnostics.length < MAX_DIAGNOSTICS) {
      diagnostics.push({ code, ...(safeId === undefined ? {} : { entityId: safeId }) })
    } else {
      diagnosticsTruncated = true
      complete = false
    }
  }
  const accountRow = (): boolean => {
    if (totalRows >= MAX_INVENTORY_ROWS || Date.now() >= deadline) {
      complete = false
      diagnose(totalRows >= MAX_INVENTORY_ROWS ? 'INVENTORY_ROW_LIMIT' : 'AUDIT_TIME_LIMIT')
      return false
    }
    totalRows++
    return true
  }
  const refreshTimeout = async () => {
    if (Date.now() >= deadline) throw new AdmissionRolloutAuditLimitError()
    await transaction.execute(
      sql.raw(
        "select set_config('statement_timeout', '" +
          Math.max(1, Math.floor(deadline - Date.now())) +
          "ms', true)"
      )
    )
  }

  let lastExecutionId: string | undefined
  while (true) {
    await refreshTimeout()
    const rows =
      lastExecutionId === undefined
        ? await transaction
            .select()
            .from(executions)
            .orderBy(asc(executions.executionId))
            .limit(PAGE_SIZE + 1)
        : await transaction
            .select()
            .from(executions)
            .where(gt(executions.executionId, lastExecutionId))
            .orderBy(asc(executions.executionId))
            .limit(PAGE_SIZE + 1)
    const page = rows.slice(0, PAGE_SIZE)
    for (const row of page) {
      if (!accountRow()) break
      lastExecutionId = row.executionId
      counts.executions++
      try {
        const execution = fromExecutionRow(row)
        owners.set(execution.executionId, {
          execution,
          rawId: execution.executionId,
          attempts: [],
          hasRetiredCommand: false,
        })
      } catch {
        diagnose('EXECUTION_RECORD_INVALID', row.executionId, true)
      }
    }
    if (!complete || rows.length <= PAGE_SIZE) break
  }

  let lastAttemptExecutionId: string | undefined
  let lastAttemptSequence = 0
  while (complete) {
    await refreshTimeout()
    const cursor =
      lastAttemptExecutionId === undefined
        ? undefined
        : or(
            gt(executionAttempts.executionId, lastAttemptExecutionId),
            and(
              eq(executionAttempts.executionId, lastAttemptExecutionId),
              gt(executionAttempts.sequence, lastAttemptSequence)
            )
          )
    const rows =
      cursor === undefined
        ? await transaction
            .select()
            .from(executionAttempts)
            .orderBy(asc(executionAttempts.executionId), asc(executionAttempts.sequence))
            .limit(PAGE_SIZE + 1)
        : await transaction
            .select()
            .from(executionAttempts)
            .where(cursor)
            .orderBy(asc(executionAttempts.executionId), asc(executionAttempts.sequence))
            .limit(PAGE_SIZE + 1)
    const page = rows.slice(0, PAGE_SIZE)
    for (const row of page) {
      if (!accountRow()) break
      lastAttemptExecutionId = row.executionId
      lastAttemptSequence = row.sequence
      counts.attempts++
      try {
        const attempt = fromAttemptRow(row)
        const owner = owners.get(attempt.executionId)
        if (!owner) {
          diagnose('ATTEMPT_OWNER_MISSING', attempt.attemptId, true)
          continue
        }
        owner.attempts.push({
          attemptId: attempt.attemptId,
          sequence: attempt.sequence,
          state: attempt.state,
        })
        attemptsById.set(attempt.attemptId, {
          executionId: attempt.executionId,
          sequence: attempt.sequence,
          state: attempt.state,
        })
      } catch {
        diagnose('ATTEMPT_RECORD_INVALID', row.attemptId, true)
      }
    }
    if (!complete || rows.length <= PAGE_SIZE) break
  }

  for (const owner of owners.values()) {
    owner.attempts.sort((left, right) => left.sequence - right.sequence)
    if (
      owner.attempts.length !== owner.execution.attemptCount ||
      owner.attempts.some((attempt, index) => attempt.sequence !== index + 1) ||
      (owner.execution.attemptCount === 0
        ? owner.execution.latestAttemptId !== undefined
        : owner.attempts.at(-1)?.attemptId !== owner.execution.latestAttemptId)
    ) {
      diagnose('ATTEMPT_CHAIN_INVALID', owner.rawId, true)
    }
    if (owner.attempts.slice(0, -1).some((attempt) => !isTerminalAttempt(attempt.state))) {
      diagnose('PRIOR_ATTEMPT_NOT_TERMINAL', owner.rawId, true)
    }
    const latest = owner.attempts.at(-1)
    if (isTerminalExecution(owner.execution.state)) {
      const expectedAttemptState = terminalAttemptState(owner.execution.state)
      if (
        owner.attempts.length > 0 &&
        (latest === undefined || latest.state !== expectedAttemptState)
      ) {
        diagnose('TERMINAL_ATTEMPT_MISMATCH', owner.rawId, true)
      }
    } else {
      counts.activeExecutions++
      diagnose('EXECUTION_NOT_TERMINAL', owner.rawId)
      diagnose('ACTIVE_OWNER_ACCOUNTING_NOT_ATTESTED', owner.rawId)
      if (latest && isTerminalAttempt(latest.state)) {
        diagnose('ACTIVE_EXECUTION_HAS_TERMINAL_ATTEMPT', owner.rawId, true)
      }
    }
  }

  let lastCommandId: string | undefined
  while (complete) {
    await refreshTimeout()
    const rows =
      lastCommandId === undefined
        ? await transaction
            .select()
            .from(commandInbox)
            .orderBy(asc(commandInbox.commandId))
            .limit(PAGE_SIZE + 1)
        : await transaction
            .select()
            .from(commandInbox)
            .where(gt(commandInbox.commandId, lastCommandId))
            .orderBy(asc(commandInbox.commandId))
            .limit(PAGE_SIZE + 1)
    const page = rows.slice(0, PAGE_SIZE)
    for (const row of page) {
      if (!accountRow()) break
      lastCommandId = row.commandId
      counts.commands++
      try {
        const command = commandFromRow(row)
        if (commandIds.has(command.commandId)) {
          diagnose('COMMAND_ID_DUPLICATE', command.commandId, true)
        }
        commandIds.add(command.commandId)
        const owner = owners.get(command.executionId)
        if (!owner) {
          diagnose('COMMAND_OWNER_MISSING', command.commandId, true)
          continue
        }
        if (owner.command !== undefined) {
          diagnose('OWNER_COMMAND_DUPLICATE', command.executionId, true)
          continue
        }
        owner.command = command
        if (!sameCommandOwner(command, owner.execution)) {
          diagnose('COMMAND_OWNER_IDENTITY_MISMATCH', command.commandId, true)
        }
        if (
          (isTerminalExecution(owner.execution.state) &&
            !terminalCommandPair(command.status, owner.execution.state)) ||
          (!isTerminalExecution(owner.execution.state) &&
            !['accepted', 'processing', 'reconciliation_required'].includes(command.status))
        ) {
          diagnose('COMMAND_EXECUTION_STATE_MISMATCH', command.commandId, true)
        }
      } catch {
        diagnose('COMMAND_RECORD_INVALID', row.commandId, true)
      }
    }
    if (!complete || rows.length <= PAGE_SIZE) break
  }

  let lastRetiredKey: string | undefined
  while (complete) {
    await refreshTimeout()
    const rows =
      lastRetiredKey === undefined
        ? await transaction
            .select()
            .from(retiredCommandKeys)
            .orderBy(asc(retiredCommandKeys.scopeKey))
            .limit(PAGE_SIZE + 1)
        : await transaction
            .select()
            .from(retiredCommandKeys)
            .where(gt(retiredCommandKeys.scopeKey, lastRetiredKey))
            .orderBy(asc(retiredCommandKeys.scopeKey))
            .limit(PAGE_SIZE + 1)
    const page = rows.slice(0, PAGE_SIZE)
    for (const row of page) {
      if (!accountRow()) break
      lastRetiredKey = row.scopeKey
      counts.retiredCommandKeys++
      const parsedCommandId = IdentifierSchemas.commandId.safeParse(row.commandId)
      const parsedExecutionId = IdentifierSchemas.executionId.safeParse(row.executionId)
      if (
        !/^[a-f0-9]{64}$/.test(row.scopeKey) ||
        !parsedCommandId.success ||
        !parsedExecutionId.success ||
        !validDate(row.retiredAt)
      ) {
        diagnose('RETIRED_COMMAND_KEY_INVALID', row.executionId, true)
        continue
      }
      if (row.metadataVersion === 1 && row.identityDigest === null) {
        diagnose('RETIRED_COMMAND_KEY_UNVERIFIABLE', row.executionId, true)
      } else if (
        row.metadataVersion !== 2 ||
        row.identityDigest === null ||
        !/^[a-f0-9]{64}$/.test(row.identityDigest)
      ) {
        diagnose('RETIRED_COMMAND_KEY_METADATA_INVALID', row.executionId, true)
        continue
      } else if (retiredCommandKeyFromMetadataV2(row.identityDigest) !== row.scopeKey) {
        diagnose('RETIRED_COMMAND_KEY_METADATA_MISMATCH', row.executionId, true)
        continue
      }
      const owner = owners.get(row.executionId)
      if (
        !owner ||
        !isTerminalExecution(owner.execution.state) ||
        owner.command !== undefined ||
        commandIds.has(row.commandId) ||
        (owner.execution.terminalAt !== undefined &&
          row.retiredAt.toISOString() < owner.execution.terminalAt) ||
        owner.hasRetiredCommand
      ) {
        diagnose('RETIRED_COMMAND_LINEAGE_INVALID', row.executionId, true)
        continue
      }
      owner.hasRetiredCommand = true
    }
    if (!complete || rows.length <= PAGE_SIZE) break
  }

  let lastRuntimeCommandId: string | undefined
  while (complete) {
    await refreshTimeout()
    const rows =
      lastRuntimeCommandId === undefined
        ? await transaction
            .select()
            .from(runtimeCommands)
            .orderBy(asc(runtimeCommands.commandId))
            .limit(PAGE_SIZE + 1)
        : await transaction
            .select()
            .from(runtimeCommands)
            .where(gt(runtimeCommands.commandId, lastRuntimeCommandId))
            .orderBy(asc(runtimeCommands.commandId))
            .limit(PAGE_SIZE + 1)
    const page = rows.slice(0, PAGE_SIZE)
    for (const row of page) {
      if (!accountRow()) break
      lastRuntimeCommandId = row.commandId
      counts.runtimeCommands++
      try {
        const runtimeCommand = fromRuntimeCommandRow(row)
        const owner = owners.get(runtimeCommand.executionId)
        const attempt = attemptsById.get(runtimeCommand.attemptId)
        if (
          !owner ||
          !attempt ||
          attempt.executionId !== runtimeCommand.executionId ||
          owner.execution.correlation.workspaceId !== runtimeCommand.workspaceId
        ) {
          diagnose('RUNTIME_COMMAND_LINEAGE_INVALID', runtimeCommand.commandId, true)
        }
        if (
          runtimeCommand.status === 'queued' ||
          runtimeCommand.status === 'dispatched' ||
          runtimeCommand.status === 'acknowledged' ||
          runtimeCommand.status === 'expired'
        ) {
          counts.unresolvedRuntimeCommands++
          diagnose('RUNTIME_COMMAND_OUTCOME_UNRESOLVED', runtimeCommand.commandId)
        } else if (
          !attempt ||
          !isTerminalAttempt(attempt.state) ||
          !hasRetainedRuntimeOutcome(
            runtimeCommand.status,
            runtimeCommand.resultStatus,
            runtimeCommand.resultRecordedAt,
            runtimeCommand.issuedAt,
            runtimeCommand.updatedAt,
            runtimeCommand.acknowledgementDisposition
          )
        ) {
          counts.unresolvedRuntimeCommands++
          diagnose('RUNTIME_COMMAND_RESULT_INVALID', runtimeCommand.commandId, true)
        }
      } catch {
        counts.unresolvedRuntimeCommands++
        diagnose('RUNTIME_COMMAND_RECORD_INVALID', row.commandId, true)
      }
    }
    if (!complete || rows.length <= PAGE_SIZE) break
  }

  let lastDelegationId: string | undefined
  while (complete) {
    await refreshTimeout()
    const rows =
      lastDelegationId === undefined
        ? await transaction
            .select()
            .from(delegations)
            .orderBy(asc(delegations.delegationId))
            .limit(PAGE_SIZE + 1)
        : await transaction
            .select()
            .from(delegations)
            .where(gt(delegations.delegationId, lastDelegationId))
            .orderBy(asc(delegations.delegationId))
            .limit(PAGE_SIZE + 1)
    const page = rows.slice(0, PAGE_SIZE)
    for (const row of page) {
      if (!accountRow()) break
      lastDelegationId = row.delegationId
      counts.delegations++
      try {
        const record = DelegationRecordSchema.parse(row.record)
        const parent = owners.get(row.parentExecutionId)
        const child = owners.get(row.childExecutionId)
        if (
          record.delegationId !== row.delegationId ||
          record.parentExecutionId !== row.parentExecutionId ||
          record.childExecutionId !== row.childExecutionId ||
          record.revision !== row.revision ||
          record.inputDigest !== row.inputDigest ||
          record.state !== row.state ||
          !parent ||
          !child ||
          child.execution.parentExecutionId !== parent.execution.executionId ||
          record.parentExecutionPlanId !== parent.execution.executionPlan.executionPlanId ||
          record.parentExecutionPlanDigest !== parent.execution.executionPlan.contentDigest ||
          record.childExecutionPlanId !== child.execution.executionPlan.executionPlanId ||
          record.childExecutionPlanDigest !== child.execution.executionPlan.contentDigest ||
          record.acceptedAt !== row.acceptedAt.toISOString() ||
          record.updatedAt !== row.updatedAt.toISOString() ||
          (record.delegationGroupId ?? null) !== row.delegationGroupId
        ) {
          diagnose('DELEGATION_LINEAGE_INVALID', row.delegationId, true)
          continue
        }
        if (child.delegation !== undefined) {
          diagnose('DELEGATION_CHILD_DUPLICATE', row.childExecutionId, true)
        } else {
          child.delegation = { parentExecutionId: row.parentExecutionId, state: row.state }
        }
        if (record.childAttemptId !== undefined) {
          const attempt = attemptsById.get(record.childAttemptId)
          if (!attempt || attempt.executionId !== record.childExecutionId) {
            diagnose('DELEGATION_ATTEMPT_INVALID', row.delegationId, true)
          }
        }
        if (!['completed', 'failed', 'cancelled'].includes(record.state)) {
          diagnose('DELEGATION_UNRESOLVED', row.delegationId)
        } else if (!delegationMatchesChild(record.state, child.execution.state)) {
          diagnose('DELEGATION_TERMINAL_STATE_MISMATCH', row.delegationId, true)
        }
      } catch {
        diagnose('DELEGATION_RECORD_INVALID', row.delegationId, true)
      }
    }
    if (!complete || rows.length <= PAGE_SIZE) break
  }

  for (const owner of owners.values()) {
    if (owner.execution.parentExecutionId !== undefined && owner.delegation === undefined) {
      diagnose('PARENTED_EXECUTION_LINEAGE_MISSING', owner.rawId, true)
    }
    if (
      owner.execution.parentExecutionId !== undefined &&
      owner.delegation !== undefined &&
      owner.delegation.parentExecutionId !== owner.execution.parentExecutionId
    ) {
      diagnose('PARENTED_EXECUTION_LINEAGE_MISMATCH', owner.rawId, true)
    }
    if (
      owner.command === undefined &&
      owner.execution.parentExecutionId === undefined &&
      !owner.hasRetiredCommand
    ) {
      // Bare root lifecycle owners are supported; this is not a missing inbox proof.
    }
  }

  if (diagnosticsTruncated) complete = false
  const hasBlockers =
    diagnostics.length > 0 || counts.activeExecutions > 0 || counts.unresolvedRuntimeCommands > 0
  return {
    gate,
    complete,
    canResume: complete && !hasBlockers,
    counts: { ...counts },
    diagnostics,
  }
}

export class AdmissionRolloutAuditLimitError extends Error {
  constructor() {
    super('Admission rollout audit exceeded its time bound')
    this.name = 'AdmissionRolloutAuditLimitError'
  }
}

function commandFromRow(row: typeof commandInbox.$inferSelect): CommandInboxRecord {
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

function sameCommandOwner(command: CommandInboxRecord, execution: Execution): boolean {
  return (
    command.executionId === execution.executionId &&
    command.workspaceId === execution.correlation.workspaceId &&
    command.projectId === execution.correlation.projectId &&
    command.taskId === execution.correlation.taskId &&
    command.agentId === execution.correlation.agentId &&
    command.requestId === execution.correlation.requestId &&
    command.executionPlan.executionPlanId === execution.executionPlan.executionPlanId &&
    command.executionPlan.contentDigest === execution.executionPlan.contentDigest &&
    command.executionPlan.schemaVersion === execution.executionPlan.schemaVersion
  )
}

function terminalCommandPair(commandStatus: string, executionState: string): boolean {
  if (!isTerminalExecution(executionState)) return false
  if (executionState === 'completed') return commandStatus === 'completed'
  return ['failed', 'cancelled', 'timed_out'].includes(executionState) && commandStatus === 'failed'
}

function terminalAttemptState(executionState: string): string | undefined {
  if (executionState === 'completed') return 'completed'
  if (executionState === 'failed') return 'failed'
  if (executionState === 'cancelled') return 'cancelled'
  if (executionState === 'timed_out') return 'timed_out'
  return undefined
}

function isTerminalExecution(state: string): boolean {
  return ['completed', 'failed', 'cancelled', 'timed_out'].includes(state)
}

function isTerminalAttempt(state: string): boolean {
  return ['completed', 'failed', 'cancelled', 'timed_out'].includes(state)
}

function hasRetainedRuntimeOutcome(
  status: string,
  resultStatus: string | undefined,
  resultRecordedAt: string | undefined,
  issuedAt: string,
  updatedAt: string,
  acknowledgementDisposition: string | undefined
): boolean {
  if (
    status === 'failed' &&
    acknowledgementDisposition === 'rejected' &&
    resultStatus === undefined
  ) {
    return true
  }
  return (
    resultStatus === status &&
    resultRecordedAt !== undefined &&
    Date.parse(resultRecordedAt) >= Date.parse(issuedAt) &&
    Date.parse(resultRecordedAt) <= Date.parse(updatedAt)
  )
}

function delegationMatchesChild(delegationState: string, executionState: string): boolean {
  if (delegationState === 'completed') return executionState === 'completed'
  if (delegationState === 'cancelled') return executionState === 'cancelled'
  if (delegationState === 'failed') return ['failed', 'timed_out'].includes(executionState)
  return false
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (
    IdentifierSchemas.executionId.safeParse(value).success ||
    IdentifierSchemas.commandId.safeParse(value).success ||
    IdentifierSchemas.attemptId.safeParse(value).success ||
    IdentifierSchemas.delegationId.safeParse(value).success
  )
    return value
  return undefined
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}
