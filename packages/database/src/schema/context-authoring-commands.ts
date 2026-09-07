import type { ContextAuthoringCommandRecord } from '@control-plane/context'
import { index, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import { contextPackages } from './context-packages.js'

export const contextAuthoringCommands = pgTable(
  'context_authoring_commands',
  {
    commandKey: varchar('command_key', { length: 64 }).primaryKey(),
    workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    contextPackageId: varchar('context_package_id', { length: 30 })
      .notNull()
      .references(() => contextPackages.contextPackageId),
    record: jsonb('record').$type<ContextAuthoringCommandRecord>().notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('context_authoring_commands_scope_index').on(table.workspaceId, table.projectId),
  ]
)
