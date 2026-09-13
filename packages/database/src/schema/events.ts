import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { executions } from './executions.js'

export const eventPublicationStatus = pgEnum('event_publication_status', [
  'pending',
  'published',
  'failed',
  'quarantined',
])
const identifier = (name: string) => varchar(name, { length: 30 })

export const executionEvents = pgTable(
  'execution_events',
  {
    eventId: identifier('event_id').primaryKey(),
    executionId: identifier('execution_id')
      .notNull()
      .references(() => executions.executionId),
    attemptId: identifier('attempt_id'),
    workflowId: identifier('workflow_id'),
    sequence: integer('sequence').notNull(),
    eventType: varchar('event_type', { length: 128 }).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    requestId: identifier('request_id').notNull(),
    workspaceId: identifier('workspace_id').notNull(),
    projectId: identifier('project_id').notNull(),
    taskId: identifier('task_id').notNull(),
    agentId: identifier('agent_id').notNull(),
    commandId: identifier('command_id'),
    traceId: identifier('trace_id').notNull(),
    /** Classification metadata only; never payload content. Nullable for pre-existing rows. */
    sensitivity: varchar('sensitivity', { length: 16 }),
    redaction: varchar('redaction', { length: 16 }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadBytes: integer('payload_bytes').notNull(),
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    occurredAt: timestamp('occurred_at', { mode: 'date', withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { mode: 'date', withTimezone: true }).notNull(),
    retentionExpiresAt: timestamp('retention_expires_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    archivedAt: timestamp('archived_at', { mode: 'date', withTimezone: true }),
    publicationStatus: eventPublicationStatus('publication_status').notNull(),
    publicationAttempts: integer('publication_attempts').notNull(),
    publicationVersion: integer('publication_version').notNull(),
    lastAttemptAt: timestamp('last_attempt_at', { mode: 'date', withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { mode: 'date', withTimezone: true }),
    publishedAt: timestamp('published_at', { mode: 'date', withTimezone: true }),
    quarantinedAt: timestamp('quarantined_at', { mode: 'date', withTimezone: true }),
    publicationErrorReference: varchar('publication_error_reference', { length: 512 }),
  },
  (table) => [
    uniqueIndex('execution_events_execution_sequence_unique').on(table.executionId, table.sequence),
    index('execution_events_replay_index').on(table.executionId, table.sequence, table.archivedAt),
    index('execution_events_publication_index').on(table.publicationStatus, table.recordedAt),
    index('execution_events_retention_index').on(table.retentionExpiresAt, table.archivedAt),
  ]
)
