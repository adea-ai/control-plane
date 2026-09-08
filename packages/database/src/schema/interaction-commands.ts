import type { InteractionCommandReceipt } from '@control-plane/domain'
import { index, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'

export const interactionCommands = pgTable(
  'interaction_commands',
  {
    commandKey: varchar('command_key', { length: 64 }).primaryKey(),
    workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    receipt: jsonb('receipt').$type<InteractionCommandReceipt>().notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('interaction_commands_scope_index').on(table.workspaceId, table.projectId)]
)
