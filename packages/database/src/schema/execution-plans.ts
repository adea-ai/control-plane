import { index, integer, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import type { ExecutionPlan } from '@control-plane/execution-plan'

const identifier = (name: string) => varchar(name, { length: 30 })

export const executionPlans = pgTable(
  'execution_plans',
  {
    executionPlanId: identifier('execution_plan_id').primaryKey(),
    contentDigest: varchar('content_digest', { length: 71 }).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    workspaceId: identifier('workspace_id').notNull(),
    projectId: identifier('project_id').notNull(),
    taskId: identifier('task_id').notNull(),
    agentId: identifier('agent_id').notNull(),
    plan: jsonb('plan').$type<ExecutionPlan>().notNull(),
    compiledAt: timestamp('compiled_at', { mode: 'date', withTimezone: true }).notNull(),
    // Retention metadata, not part of the immutable plan/digest. Null means
    // there is no durable observation of the final reference being released.
    unreferencedSince: timestamp('unreferenced_since', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('execution_plans_scope_index').on(
      table.workspaceId,
      table.projectId,
      table.taskId,
      table.agentId
    ),
  ]
)
