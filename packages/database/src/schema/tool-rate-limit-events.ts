import { check, index, pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/** One accepted rate-limit slot per durable tool-call receipt. */
export const toolRateLimitEvents = pgTable(
  'tool_rate_limit_events',
  {
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    principalRef: varchar('principal_ref', { length: 256 }).notNull(),
    toolDefinitionId: varchar('tool_definition_id', { length: 64 }).notNull(),
    operation: varchar('operation', { length: 128 }).notNull(),
    toolCallId: varchar('tool_call_id', { length: 64 }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.toolCallId] }),
    index('tool_rate_limit_events_window_index').on(
      table.workspaceId,
      table.principalRef,
      table.toolDefinitionId,
      table.operation,
      table.consumedAt
    ),
    check(
      'tool_rate_limit_events_identity_check',
      sql`length(${table.principalRef}) > 0 and length(${table.operation}) > 0`
    ),
  ]
)
