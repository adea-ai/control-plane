import { pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'

export const retiredCommandKeys = pgTable('retired_command_keys', {
  scopeKey: varchar('scope_key', { length: 64 }).primaryKey(),
  commandId: varchar('command_id', { length: 30 }).notNull(),
  executionId: varchar('execution_id', { length: 30 }).notNull(),
  retiredAt: timestamp('retired_at', { mode: 'date', withTimezone: true }).notNull(),
})
