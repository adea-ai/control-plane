import { z } from 'zod'
import {
  ContextCommandRecordSchema,
  createQueuedContextCommandRecord,
  contextCommandOperationKey,
} from './context-command.js'

const Timestamp = z.iso.datetime()
const minimumRetentionMs = 30 * 24 * 60 * 60 * 1000

/** Node-local execution state, independent of gateway delivery and execution-plan identities. */
export const ContextNodeInboxRecordSchema = z
  .object({
    command: ContextCommandRecordSchema,
    version: z.number().int().positive(),
    status: z.enum([
      'accepted',
      'executing',
      'reconciliation_required',
      'succeeded',
      'failed',
      'expired',
    ]),
    receivedAt: Timestamp,
    updatedAt: Timestamp,
    retentionExpiresAt: Timestamp,
    startedAt: Timestamp.optional(),
    terminalAt: Timestamp.optional(),
    result: z.record(z.string(), z.json()).optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
      .optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message })
    if (record.command.status !== 'queued' || record.command.version !== 1)
      issue('Inbox command must preserve original queued identity')
    if (
      Date.parse(record.receivedAt) < Date.parse(record.command.issuedAt) ||
      Date.parse(record.receivedAt) >= Date.parse(record.command.expiresAt) ||
      Date.parse(record.updatedAt) < Date.parse(record.receivedAt) ||
      Date.parse(record.retentionExpiresAt) < Date.parse(record.receivedAt) + minimumRetentionMs
    )
      issue('Invalid inbox chronology or retention')
    const started = record.status !== 'accepted' && record.status !== 'expired'
    const terminal =
      record.status === 'succeeded' || record.status === 'failed' || record.status === 'expired'
    if (
      started !== (record.startedAt !== undefined) ||
      terminal !== (record.terminalAt !== undefined) ||
      (record.status === 'succeeded') !== (record.result !== undefined) ||
      (record.status === 'failed') !== (record.errorCode !== undefined)
    )
      issue('Inbox state metadata mismatch')
    if (
      record.startedAt &&
      (Date.parse(record.startedAt) < Date.parse(record.receivedAt) ||
        Date.parse(record.startedAt) >= Date.parse(record.command.expiresAt) ||
        Date.parse(record.startedAt) > Date.parse(record.updatedAt))
    )
      issue('Invalid provider start time')
    if (
      record.status === 'expired' &&
      Date.parse(record.terminalAt ?? '') < Date.parse(record.command.expiresAt)
    )
      issue('Premature expiration')
    if (
      record.terminalAt &&
      (Date.parse(record.terminalAt) < Date.parse(record.startedAt ?? record.receivedAt) ||
        record.terminalAt !== record.updatedAt)
    )
      issue('Invalid terminal time')
    if (record.result && Buffer.byteLength(JSON.stringify(record.result)) > 262144)
      issue('Inbox result exceeds bounded inline storage')
  })
export type ContextNodeInboxRecord = z.output<typeof ContextNodeInboxRecordSchema>

export interface ContextNodeInboxRepository {
  accept(record: ContextNodeInboxRecord): Promise<{
    outcome: 'created' | 'duplicate' | 'conflict'
    record: ContextNodeInboxRecord
  }>
  get(
    workspaceId: string,
    nodeId: string,
    commandId: string
  ): Promise<ContextNodeInboxRecord | undefined>
  compareAndSet(expectedVersion: number, record: ContextNodeInboxRecord): Promise<boolean>
}

export function createContextNodeInboxRecord(
  command: unknown,
  receivedAt: string
): ContextNodeInboxRecord {
  return ContextNodeInboxRecordSchema.parse({
    command: createQueuedContextCommandRecord(command, receivedAt),
    version: 1,
    status: 'accepted',
    receivedAt,
    updatedAt: receivedAt,
    retentionExpiresAt: new Date(Date.parse(receivedAt) + minimumRetentionMs).toISOString(),
  })
}

/** Executing is persisted before calling the provider; recovery cannot re-enter executing. */
export function contextNodeInboxTransitionAllowed(
  currentInput: ContextNodeInboxRecord,
  nextInput: ContextNodeInboxRecord
): boolean {
  const current = ContextNodeInboxRecordSchema.parse(currentInput)
  const next = ContextNodeInboxRecordSchema.parse(nextInput)
  if (
    next.version !== current.version + 1 ||
    JSON.stringify(next.command) !== JSON.stringify(current.command) ||
    next.receivedAt !== current.receivedAt ||
    Date.parse(next.retentionExpiresAt) < Date.parse(current.retentionExpiresAt) ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    (current.startedAt !== undefined && next.startedAt !== current.startedAt)
  )
    return false
  const allowed: Record<
    ContextNodeInboxRecord['status'],
    readonly ContextNodeInboxRecord['status'][]
  > = {
    accepted: ['executing', 'expired'],
    executing: ['succeeded', 'failed', 'reconciliation_required'],
    reconciliation_required: ['succeeded', 'failed'],
    succeeded: [],
    failed: [],
    expired: [],
  }
  return allowed[current.status].includes(next.status)
}

export function contextNodeInboxOperationKey(record: ContextNodeInboxRecord): string {
  const parsed = ContextNodeInboxRecordSchema.parse(record)
  return `${parsed.command.nodeId}:${contextCommandOperationKey(parsed.command.scope)}`
}
