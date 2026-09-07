import type { ExecutionValidationCommandRecord } from '@control-plane/execution-plan'
import { index, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import { executionPlans } from './execution-plans.js'

export const executionValidationCommands = pgTable(
  'execution_validation_commands',
  {
    commandKey: varchar('command_key', { length: 64 }).primaryKey(),
    workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
    projectId: varchar('project_id', { length: 30 }).notNull(),
    executionPlanId: varchar('execution_plan_id', { length: 30 })
      .notNull()
      .references(() => executionPlans.executionPlanId),
    record: jsonb('record').$type<ExecutionValidationCommandRecord>().notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('execution_validation_commands_scope_index').on(table.workspaceId, table.projectId),
  ]
)
