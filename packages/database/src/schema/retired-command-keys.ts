import { sql } from 'drizzle-orm'
import { check, index, pgTable, smallint, timestamp, varchar } from 'drizzle-orm/pg-core'

export const retiredCommandKeys = pgTable(
  'retired_command_keys',
  {
    scopeKey: varchar('scope_key', { length: 64 }).primaryKey(),
    commandId: varchar('command_id', { length: 30 }).notNull(),
    executionId: varchar('execution_id', { length: 30 }).notNull(),
    retiredAt: timestamp('retired_at', { mode: 'date', withTimezone: true }).notNull(),
    metadataVersion: smallint('metadata_version').notNull().default(1),
    identityDigest: varchar('identity_digest', { length: 64 }),
  },
  (table) => [
    index('retired_command_keys_retired_at_index').on(table.retiredAt),
    check(
      'retired_command_keys_metadata_check',
      sql`(${table.metadataVersion} = 1 and ${table.identityDigest} is null) or (${table.metadataVersion} = 2 and ${table.identityDigest} is not null and ${table.identityDigest} ~ '^[a-f0-9]{64}$')`
    ),
  ]
)
