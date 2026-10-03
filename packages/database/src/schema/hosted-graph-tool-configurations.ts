import { check, pgTable, timestamp, varchar, bigint, smallint } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/** Immutable operator pricing and tool-pin provenance for a Hosted graph tool version. */
export const hostedGraphToolConfigurations = pgTable(
  'hosted_graph_tool_configurations',
  {
    toolVersionId: varchar('tool_version_id', { length: 64 }).primaryKey(),
    schemaVersion: smallint('schema_version').notNull(),
    toolDefinitionId: varchar('tool_definition_id', { length: 64 }).notNull(),
    contentDigest: varchar('content_digest', { length: 71 }).notNull(),
    operation: varchar('operation', { length: 128 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    costMicrounits: bigint('cost_microunits', { mode: 'number' }).notNull(),
    configurationDigest: varchar('configuration_digest', { length: 64 }).notNull(),
    pinnedAt: timestamp('pinned_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    check('hosted_graph_tool_configurations_schema_check', sql`${table.schemaVersion} = 1`),
    check(
      'hosted_graph_tool_configurations_price_check',
      sql`${table.costMicrounits} > 0 and ${table.currency} ~ '^[A-Z]{3}$'`
    ),
    check(
      'hosted_graph_tool_configurations_digest_check',
      sql`${table.contentDigest} ~ '^sha256:[a-f0-9]{64}$' and ${table.configurationDigest} ~ '^[a-f0-9]{64}$'`
    ),
  ]
)
