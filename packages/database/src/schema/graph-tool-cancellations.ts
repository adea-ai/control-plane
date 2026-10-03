import { check, pgTable, primaryKey, timestamp, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/** Durable execution-scoped intent used to fence future Hosted graph tool effects. */
export const graphToolCancellations = pgTable(
  'graph_tool_cancellations',
  {
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    executionId: varchar('execution_id', { length: 64 }).notNull(),
    threadId: varchar('thread_id', { length: 256 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.executionId] }),
    check(
      'graph_tool_cancellations_key_check',
      sql`length(${table.idempotencyKey}) > 0 and length(${table.threadId}) > 0`
    ),
  ]
)
