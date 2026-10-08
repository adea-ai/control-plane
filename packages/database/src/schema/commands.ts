import { sql } from 'drizzle-orm'
import { executionScopeColumn, executionScopeCheck } from './execution-scope.js'
import {
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

export const commandInboxStatus = pgEnum('command_inbox_status', [
  'accepted',
  'processing',
  'completed',
  'failed',
  'reconciliation_required',
])

const identifier = (name: string) => varchar(name, { length: 30 })

export const commandInbox = pgTable(
  'command_inbox',
  {
    commandId: identifier('command_id').primaryKey(),
    callerPrincipalId: varchar('caller_principal_id', { length: 64 }).notNull(),
    operation: varchar('operation', { length: 128 }).notNull(),
    workspaceId: identifier('workspace_id').notNull(),
    projectId: identifier('project_id'),
    executionScope: executionScopeColumn(),
    taskId: identifier('task_id').notNull(),
    agentId: identifier('agent_id').notNull(),
    requestId: identifier('request_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    status: commandInboxStatus('status').notNull(),
    executionId: identifier('execution_id').notNull(),
    executionPlanId: identifier('execution_plan_id').notNull(),
    executionPlanDigest: varchar('execution_plan_digest', { length: 71 }).notNull(),
    executionPlanSchemaVersion: integer('execution_plan_schema_version').notNull(),
    version: integer('version').notNull(),
    conflictCount: integer('conflict_count').notNull(),
    receivedAt: timestamp('received_at', { mode: 'date', withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date', withTimezone: true }).notNull(),
    retentionExpiresAt: timestamp('retention_expires_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    lastConflictAt: timestamp('last_conflict_at', { mode: 'date', withTimezone: true }),
    processingAt: timestamp('processing_at', { mode: 'date', withTimezone: true }),
    reconciliationRequiredAt: timestamp('reconciliation_required_at', {
      mode: 'date',
      withTimezone: true,
    }),
    terminalAt: timestamp('terminal_at', { mode: 'date', withTimezone: true }),
    resultReference: identifier('result_reference'),
    errorReference: varchar('error_reference', { length: 512 }),
  },
  (table) => [
    executionScopeCheck('command_inbox_scope_check', table),
    uniqueIndex('command_inbox_scope_idempotency_unique').on(
      table.callerPrincipalId,
      table.operation,
      table.workspaceId,
      table.projectId,
      table.idempotencyKey
    ),
    uniqueIndex('command_inbox_workspace_idempotency_unique')
      .on(table.callerPrincipalId, table.operation, table.workspaceId, table.idempotencyKey)
      .where(sql`${table.projectId} is null`),
    index('command_inbox_status_retention_index').on(table.status, table.retentionExpiresAt),
    index('command_inbox_execution_index').on(table.executionId),
    index('command_inbox_request_index').on(table.requestId),
  ]
)
