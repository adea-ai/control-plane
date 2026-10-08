import { executionScopeColumn, executionScopeCheck } from './execution-scope.js'
import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import type { AttemptRoutingDecision, MarketplacePluginReference } from '@control-plane/domain'

export const executionState = pgEnum('execution_state', [
  'accepted',
  'queued',
  'starting',
  'running',
  'awaiting_input',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'reconciliation_required',
])

export const executionAttemptState = pgEnum('execution_attempt_state', [
  'queued',
  'starting',
  'running',
  'awaiting_input',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'reconciliation_required',
])

export const executionFailureClassification = pgEnum('execution_failure_classification', [
  'validation',
  'policy',
  'runtime_unavailable',
  'runtime_error',
  'infrastructure',
  'timeout',
  'cancelled',
  'unknown',
])

const identifier = (name: string) => varchar(name, { length: 30 })
const lifecycleTimestamps = () => ({
  acceptedAt: timestamp('accepted_at', { mode: 'date', withTimezone: true }).notNull(),
  queuedAt: timestamp('queued_at', { mode: 'date', withTimezone: true }),
  startingAt: timestamp('starting_at', { mode: 'date', withTimezone: true }),
  runningAt: timestamp('running_at', { mode: 'date', withTimezone: true }),
  awaitingInputAt: timestamp('awaiting_input_at', { mode: 'date', withTimezone: true }),
  cancellingAt: timestamp('cancelling_at', { mode: 'date', withTimezone: true }),
  reconciliationRequiredAt: timestamp('reconciliation_required_at', {
    mode: 'date',
    withTimezone: true,
  }),
  terminalAt: timestamp('terminal_at', { mode: 'date', withTimezone: true }),
  deadlineAt: timestamp('deadline_at', { mode: 'date', withTimezone: true }),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull(),
})

export const executions = pgTable(
  'executions',
  {
    executionId: identifier('execution_id').primaryKey(),
    state: executionState('state').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    workspaceId: identifier('workspace_id').notNull(),
    projectId: identifier('project_id'),
    executionScope: executionScopeColumn(),
    taskId: identifier('task_id').notNull(),
    agentId: identifier('agent_id').notNull(),
    requestId: identifier('request_id').notNull(),
    executionPlanId: identifier('execution_plan_id').notNull(),
    executionPlanDigest: varchar('execution_plan_digest', { length: 71 }).notNull(),
    executionPlanSchemaVersion: integer('execution_plan_schema_version').notNull(),
    marketplacePluginReferences: jsonb('marketplace_plugin_references').$type<
      readonly MarketplacePluginReference[]
    >(),
    parentExecutionId: identifier('parent_execution_id'),
    attemptCount: integer('attempt_count').notNull(),
    latestAttemptId: identifier('latest_attempt_id'),
    failureClassification: executionFailureClassification('failure_classification'),
    failureCode: varchar('failure_code', { length: 128 }),
    terminalResultRef: identifier('terminal_result_ref'),
    ...lifecycleTimestamps(),
  },
  (table) => [
    executionScopeCheck('executions_scope_check', table),
    foreignKey({
      columns: [table.parentExecutionId],
      foreignColumns: [table.executionId],
      name: 'executions_parent_execution_fk',
    }),
    index('executions_scope_index').on(table.workspaceId, table.projectId, table.taskId),
    index('executions_state_deadline_index').on(table.state, table.deadlineAt),
    index('executions_parent_index').on(table.parentExecutionId),
    index('executions_plan_index').on(table.executionPlanId),
  ]
)

export const executionAttempts = pgTable(
  'execution_attempts',
  {
    attemptId: identifier('attempt_id').primaryKey(),
    executionId: identifier('execution_id')
      .notNull()
      .references(() => executions.executionId),
    sequence: integer('sequence').notNull(),
    state: executionAttemptState('state').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    runtimeDefinitionId: identifier('runtime_definition_id'),
    runtimeNodeRefId: identifier('runtime_node_ref_id'),
    runtimeConnectionId: identifier('runtime_connection_id'),
    externalSessionId: identifier('external_session_id'),
    routingDecision: jsonb('routing_decision').$type<AttemptRoutingDecision>(),
    failureClassification: executionFailureClassification('failure_classification'),
    failureCode: varchar('failure_code', { length: 128 }),
    terminalResultRef: identifier('terminal_result_ref'),
    ...lifecycleTimestamps(),
  },
  (table) => [
    uniqueIndex('execution_attempts_execution_sequence_unique').on(
      table.executionId,
      table.sequence
    ),
    index('execution_attempts_state_deadline_index').on(table.state, table.deadlineAt),
    index('execution_attempts_runtime_index').on(
      table.runtimeDefinitionId,
      table.runtimeNodeRefId,
      table.runtimeConnectionId
    ),
  ]
)
