import type { ToolCall, ToolDefinition, ToolVersion } from '@control-plane/tool-sdk'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

/** Tool definitions are immutable within their workspace-scoped catalog. */
export const toolDefinitions = pgTable(
  'tool_definitions',
  {
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    toolDefinitionId: varchar('tool_definition_id', { length: 64 }).notNull(),
    definition: jsonb('definition').$type<ToolDefinition>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.toolDefinitionId] }),
    check(
      'tool_definitions_identity_check',
      sql`jsonb_typeof(${table.definition}) = 'object' and ${table.definition}->>'toolDefinitionId' = ${table.toolDefinitionId}`
    ),
  ]
)

/** Immutable version content, with a workspace-local semantic-version key. */
export const toolVersions = pgTable(
  'tool_versions',
  {
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    toolVersionId: varchar('tool_version_id', { length: 64 }).notNull(),
    toolDefinitionId: varchar('tool_definition_id', { length: 64 }).notNull(),
    semanticVersion: text('semantic_version').notNull(),
    version: jsonb('version').$type<ToolVersion>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.toolVersionId] }),
    uniqueIndex('tool_versions_semantic_version_unique').on(
      table.workspaceId,
      table.toolDefinitionId,
      table.semanticVersion
    ),
    index('tool_versions_definition_index').on(table.workspaceId, table.toolDefinitionId),
    foreignKey({
      columns: [table.workspaceId, table.toolDefinitionId],
      foreignColumns: [toolDefinitions.workspaceId, toolDefinitions.toolDefinitionId],
      name: 'tool_versions_definition_fk',
    }),
    check(
      'tool_versions_identity_check',
      sql`jsonb_typeof(${table.version}) = 'object' and ${table.version}->>'toolVersionId' = ${table.toolVersionId} and ${table.version}->>'toolDefinitionId' = ${table.toolDefinitionId} and ${table.version}->>'semanticVersion' = ${table.semanticVersion}`
    ),
  ]
)

/** Durable tool-call receipts and the workspace idempotency uniqueness fence. */
export const toolCalls = pgTable(
  'tool_calls',
  {
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    toolCallId: varchar('tool_call_id', { length: 64 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull(),
    executionId: varchar('execution_id', { length: 64 }).notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    call: jsonb('call').$type<ToolCall>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.toolCallId] }),
    uniqueIndex('tool_calls_workspace_idempotency_unique').on(
      table.workspaceId,
      table.idempotencyKey
    ),
    index('tool_calls_execution_index').on(table.workspaceId, table.executionId),
    check('tool_calls_revision_check', sql`${table.revision} > 0`),
    check(
      'tool_calls_identity_check',
      sql`jsonb_typeof(${table.call}) = 'object' and ${table.call}->>'toolCallId' = ${table.toolCallId} and ${table.call}->>'workspaceId' = ${table.workspaceId} and ${table.call}->>'idempotencyKey' = ${table.idempotencyKey} and ${table.call}->>'executionId' = ${table.executionId} and (${table.call}->>'revision')::bigint = ${table.revision}`
    ),
  ]
)
