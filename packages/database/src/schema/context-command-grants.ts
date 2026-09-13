import { jsonb, pgTable, primaryKey, varchar } from 'drizzle-orm/pg-core'

export const contextCommandGrants = pgTable(
  'context_command_grants',
  {
    workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
    authorizationRef: varchar('authorization_ref', { length: 128 }).notNull(),
    record: jsonb('record').notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.authorizationRef] })]
)
