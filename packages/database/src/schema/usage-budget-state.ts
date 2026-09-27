import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import type {
  DurableUsageBudget,
  DurableUsageEffect,
} from '@control-plane/usage-ledger/durable-contract'
import { executions } from './executions.js'

const identifier = (name: string) => varchar(name, { length: 30 })

/** Mutable budget snapshots are transactionally checked against immutable entries. */
export const usageBudgetStates = pgTable(
  'usage_budget_states',
  {
    executionId: identifier('execution_id')
      .primaryKey()
      .references(() => executions.executionId, { onDelete: 'restrict' }),
    workspaceId: identifier('workspace_id').notNull(),
    parentExecutionId: identifier('parent_execution_id').references(() => executions.executionId, {
      onDelete: 'restrict',
    }),
    schemaVersion: integer('schema_version').notNull(),
    state: jsonb('state').$type<DurableUsageBudget>().notNull(),
  },
  (table) => [
    check('usage_budget_states_schema_version_check', sql`${table.schemaVersion} = 1`),
    check('usage_budget_states_state_object_check', sql`jsonb_typeof(${table.state}) = 'object'`),
    uniqueIndex('usage_budget_states_workspace_execution_unique').on(
      table.workspaceId,
      table.executionId
    ),
    index('usage_budget_states_workspace_parent_index').on(
      table.workspaceId,
      table.parentExecutionId
    ),
  ]
)

/** Immutable workspace-global replay receipts, keyed independently of execution. */
export const usageOperationReceipts = pgTable(
  'usage_operation_receipts',
  {
    workspaceId: identifier('workspace_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull(),
    executionId: identifier('execution_id')
      .notNull()
      .references(() => executions.executionId, { onDelete: 'restrict' }),
    fingerprint: varchar('fingerprint', { length: 71 }).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    receipt: jsonb('receipt').$type<DurableUsageEffect>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.idempotencyKey],
      name: 'usage_operation_receipts_workspace_key_pk',
    }),
    check('usage_operation_receipts_schema_version_check', sql`${table.schemaVersion} = 1`),
    check(
      'usage_operation_receipts_receipt_object_check',
      sql`jsonb_typeof(${table.receipt}) = 'object'`
    ),
    index('usage_operation_receipts_workspace_execution_index').on(
      table.workspaceId,
      table.executionId
    ),
    index('usage_operation_receipts_workspace_fingerprint_index').on(
      table.workspaceId,
      table.fingerprint
    ),
  ]
)
