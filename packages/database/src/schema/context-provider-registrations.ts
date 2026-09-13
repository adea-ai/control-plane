import { index, jsonb, pgTable, primaryKey, varchar } from 'drizzle-orm/pg-core'

export const contextProviderRegistrations = pgTable(
  'context_provider_registrations',
  {
    workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
    connectionId: varchar('connection_id', { length: 30 }).notNull(),
    principalRef: varchar('principal_ref', { length: 256 }).notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    record: jsonb('record').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.connectionId] }),
    index('context_provider_registrations_scope_idx').on(
      table.workspaceId,
      table.principalRef,
      table.state
    ),
  ]
)
