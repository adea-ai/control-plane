import {
  bigint,
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { executions } from './executions.js'

export const usageLedgerEntryKind = pgEnum('usage_ledger_entry_kind', [
  'reservation',
  'model_usage',
  'tool_charge',
  'sandbox_usage',
  'adjustment',
  'release',
  'settlement',
  'refund',
  'credit',
])

export const usageFundingSource = pgEnum('usage_funding_source', [
  'hq_managed',
  'external_subscription',
])

export const usageLedgerEntries = pgTable(
  'usage_ledger_entries',
  {
    entryId: varchar('entry_id', { length: 30 }).primaryKey(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
    executionId: varchar('execution_id', { length: 30 })
      .notNull()
      .references(() => executions.executionId),
    attemptId: varchar('attempt_id', { length: 30 }),
    parentExecutionId: varchar('parent_execution_id', { length: 30 }),
    kind: usageLedgerEntryKind('kind').notNull(),
    sourceId: varchar('source_id', { length: 256 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull(),
    reservationKey: varchar('reservation_key', { length: 256 }),
    fundingSource: usageFundingSource('funding_source').notNull(),
    quantity: jsonb('quantity').$type<{ unit: string; value: number }>().notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    costMicrounits: bigint('cost_microunits', { mode: 'number' }).notNull(),
    costExact: boolean('cost_exact').notNull(),
    authorizationDecisionId: varchar('authorization_decision_id', { length: 71 }),
    recordedAt: timestamp('recorded_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('usage_ledger_execution_sequence_unique').on(table.executionId, table.sequence),
    uniqueIndex('usage_ledger_workspace_idempotency_unique').on(
      table.workspaceId,
      table.idempotencyKey
    ),
    index('usage_ledger_execution_recorded_index').on(table.executionId, table.recordedAt),
  ]
)
