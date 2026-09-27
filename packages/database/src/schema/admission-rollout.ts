import { sql } from 'drizzle-orm'
import { bigint, check, integer, pgEnum, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'

export const admissionRolloutState = pgEnum('admission_rollout_state', ['open', 'paused'])

export const admissionRolloutGate = pgTable(
  'admission_rollout_gate',
  {
    gateKey: varchar('gate_key', { length: 32 }).primaryKey(),
    state: admissionRolloutState('state').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull(),
    updatedBy: varchar('updated_by', { length: 64 }).notNull(),
  },
  (table) => [
    check('admission_rollout_gate_key_check', sql`${table.gateKey} = 'intake'`),
    check('admission_rollout_gate_schema_version_check', sql`${table.schemaVersion} = 1`),
    check(
      'admission_rollout_gate_revision_check',
      sql`${table.revision} between 0 and 9007199254740991`
    ),
  ]
)
