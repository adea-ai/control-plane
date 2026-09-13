import { sql } from 'drizzle-orm'
import { bigint, check, pgTable, text, varchar } from 'drizzle-orm/pg-core'

export const runtimeChannelSequences = pgTable(
  'runtime_channel_sequences',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    identity: text('identity').notNull(),
    next: bigint('next', { mode: 'number' }).notNull(),
  },
  (table) => [
    check('runtime_channel_sequences_next_bounds', sql`${table.next} between 1 and 2147483648`),
  ]
)
