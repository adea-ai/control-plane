import { integer, jsonb, pgTable, primaryKey, text, varchar } from 'drizzle-orm/pg-core'

/**
 * Generic record store behind the `PersistenceProvider` interface (namespaces of revisioned JSON
 * records with optimistic create-if-absent/CAS semantics). `PostgresPersistenceProvider` implements
 * the same provider contract over it so the Hosted `hosted-server` (PostgreSQL) profile can use it
 * wherever the Local profiles use the SQLite record store, e.g. the secure ACP device fence/ledger
 * state. Only tests construct it today; no Hosted composition is wired to it yet.
 */
export const persistenceRecords = pgTable(
  'persistence_records',
  {
    namespace: varchar('namespace', { length: 128 }).notNull(),
    id: varchar('id', { length: 512 }).notNull(),
    revision: integer('revision').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.id], name: 'persistence_records_scope_pk' }),
  ]
)
