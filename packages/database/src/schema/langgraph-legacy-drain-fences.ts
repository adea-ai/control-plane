import { sql } from 'drizzle-orm'
import { bigint, check, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'

// One row per legacy thread. Rows are never deleted: a release clears the owner and advances the revision,
// so a released claim's generation and revision can never be reused. Hosted fencing uses this table through
// PostgresLegacyDrainFenceRepository; it does not create a generic persistence namespace.
export const langgraphLegacyDrainFences = pgTable(
  'langgraph_legacy_drain_fences',
  {
    storageThreadId: varchar('storage_thread_id', { length: 256 }).primaryKey(),
    owner: varchar('owner', { length: 256 }),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'langgraph_legacy_drain_fences_thread_check',
      sql`length(${table.storageThreadId}) between 1 and 256`
    ),
    check(
      'langgraph_legacy_drain_fences_owner_check',
      sql`${table.owner} is null or length(${table.owner}) between 1 and 256`
    ),
    check(
      'langgraph_legacy_drain_fences_generation_check',
      sql`${table.generation} between 1 and 9007199254740991`
    ),
    check(
      'langgraph_legacy_drain_fences_revision_check',
      sql`${table.revision} between 1 and 9007199254740991`
    ),
  ]
)
