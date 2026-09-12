import type { ContextCommandRecord } from '@control-plane/domain'
import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

export const contextCommands = pgTable(
  'context_commands',
  {
    commandId: varchar('command_id', { length: 30 }).primaryKey(),
    operationKey: varchar('operation_key', { length: 71 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
    nodeId: varchar('node_id', { length: 30 }).notNull(),
    version: integer('version').notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    issuedAt: timestamp('issued_at', { mode: 'date', withTimezone: true }).notNull(),
    record: jsonb('record').$type<ContextCommandRecord>().notNull(),
  },
  (table) => [
    uniqueIndex('context_commands_operation_key_unique').on(table.operationKey),
    index('context_commands_dispatch_index').on(
      table.workspaceId,
      table.nodeId,
      table.status,
      table.issuedAt,
      table.commandId
    ),
  ]
)
