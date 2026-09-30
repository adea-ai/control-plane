import type { GraphDefinitionCommand, PublishedGraphDefinition } from '@control-plane/orchestration'
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'

type GraphDefinitionCommandReceipt = {
  workspaceId: string
  command: GraphDefinitionCommand
  result: PublishedGraphDefinition
}

/** Immutable version content; lifecycle revision is the only mutable authority. */
export const graphDefinitionVersions = pgTable(
  'graph_definition_versions',
  {
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    graphDefinitionId: varchar('graph_definition_id', { length: 256 }).notNull(),
    graphVersion: text('graph_version').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    definition: jsonb('definition').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.graphDefinitionId, table.graphVersion] }),
  ]
)

/** A durable command receipt is committed atomically with its catalog mutation. */
export const graphDefinitionCommands = pgTable(
  'graph_definition_commands',
  {
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    callerId: varchar('caller_id', { length: 64 }).notNull(),
    operation: varchar('operation', { length: 16 })
      .$type<GraphDefinitionCommand['operation']>()
      .notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    receipt: jsonb('receipt').$type<GraphDefinitionCommandReceipt | null>(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.callerId, table.operation, table.idempotencyKey],
      name: 'graph_definition_commands_scope_pk',
    }),
    check(
      'graph_definition_commands_operation_check',
      sql`${table.operation} in ('publish', 'deprecate', 'revoke')`
    ),
    check(
      'graph_definition_commands_payload_hash_check',
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'graph_definition_commands_receipt_object_check',
      sql`jsonb_typeof(${table.receipt}) = 'object' or ${table.receipt} is null`
    ),
  ]
)
