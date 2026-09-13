import { index, jsonb, pgEnum, pgTable, timestamp, varchar, bigint } from 'drizzle-orm/pg-core'
import { executionAttempts, executions } from './executions.js'
import { runtimeConnections } from './runtime-connections.js'

export const runtimeCommandStatus = pgEnum('runtime_command_status', [
  'queued',
  'dispatched',
  'acknowledged',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
])

const identifier = (name: string) => varchar(name, { length: 30 })

export const runtimeCommands = pgTable(
  'runtime_commands',
  {
    commandId: identifier('command_id').primaryKey(),
    executionId: identifier('execution_id')
      .notNull()
      .references(() => executions.executionId),
    attemptId: identifier('attempt_id')
      .notNull()
      .references(() => executionAttempts.attemptId),
    runtimeNodeRefId: identifier('runtime_node_ref_id').notNull(),
    runtimeConnectionId: identifier('runtime_connection_id')
      .notNull()
      .references(() => runtimeConnections.runtimeConnectionId),
    workspaceId: identifier('workspace_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    payloadHash: varchar('payload_hash', { length: 71 }).notNull(),
    commandEnvelope: jsonb('command_envelope').notNull(),
    /** Optional dispatch correlation (trace/request/project/task/agent). */
    correlation: jsonb('correlation'),
    issuedAt: timestamp('issued_at', { mode: 'date', withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    status: runtimeCommandStatus('status').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    deliveryAttempts: bigint('delivery_attempts', { mode: 'number' }).notNull(),
    lastChannelGeneration: bigint('last_channel_generation', { mode: 'number' }),
    lastSequence: bigint('last_sequence', { mode: 'number' }),
    firstDispatchedAt: timestamp('first_dispatched_at', { mode: 'date', withTimezone: true }),
    lastDispatchedAt: timestamp('last_dispatched_at', { mode: 'date', withTimezone: true }),
    acknowledgementReference: varchar('acknowledgement_reference', { length: 128 }),
    acknowledgementDisposition: varchar('acknowledgement_disposition', { length: 16 }),
    acknowledgedAt: timestamp('acknowledged_at', { mode: 'date', withTimezone: true }),
    resultReference: identifier('result_reference'),
    resultStatus: varchar('result_status', { length: 16 }),
    resultRecordedAt: timestamp('result_recorded_at', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    index('runtime_commands_node_status_issued_index').on(
      table.runtimeNodeRefId,
      table.status,
      table.issuedAt
    ),
    index('runtime_commands_expiry_index').on(table.status, table.expiresAt),
    index('runtime_commands_execution_attempt_index').on(table.executionId, table.attemptId),
  ]
)
