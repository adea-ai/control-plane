import { bigint, jsonb, pgTable, primaryKey, text, varchar } from 'drizzle-orm/pg-core'

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
