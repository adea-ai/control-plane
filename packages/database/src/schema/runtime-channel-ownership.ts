import { bigint, boolean, jsonb, pgTable, varchar } from 'drizzle-orm/pg-core'

export const runtimeChannelOwnership = pgTable('runtime_channel_ownership', {
  nodeId: varchar('node_id', { length: 30 }).primaryKey(),
  workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
  generation: bigint('generation', { mode: 'number' }).notNull(),
  active: boolean('active').notNull(),
  record: jsonb('record').notNull(),
})
