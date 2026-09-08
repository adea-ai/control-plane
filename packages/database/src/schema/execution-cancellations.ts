import type { ExecutionCancellationReceipt } from '@control-plane/domain'
import { index, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'

export const executionCancellations = pgTable(
  'execution_cancellations',
  {
    commandKey: varchar('command_key', { length: 64 }).primaryKey(),
    workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    receipt: jsonb('receipt').$type<ExecutionCancellationReceipt>().notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('execution_cancellations_scope_index').on(table.workspaceId, table.projectId)]
)
