import {
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import {
  idColumn,
  jsonColumn,
  revisionColumn,
  softDeleteColumns,
  timestampColumns,
} from './conventions.js'

export const outboxStatus = pgEnum('outbox_status', ['pending', 'published', 'failed'])

export const inboxMessages = pgTable(
  'inbox_messages',
  {
    id: idColumn(),
    consumer: varchar('consumer', { length: 128 }).notNull(),
    messageId: varchar('message_id', { length: 255 }).notNull(),
    payload: jsonColumn('payload'),
    revision: revisionColumn(),
    ...timestampColumns(),
    ...softDeleteColumns(),
  },
  (table) => [
    uniqueIndex('inbox_messages_consumer_message_id_unique').on(table.consumer, table.messageId),
    index('inbox_messages_created_at_index').on(table.createdAt),
  ]
)

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: idColumn(),
    aggregateType: varchar('aggregate_type', { length: 128 }).notNull(),
    aggregateId: varchar('aggregate_id', { length: 255 }).notNull(),
    eventType: varchar('event_type', { length: 255 }).notNull(),
    payload: jsonColumn('payload'),
    status: outboxStatus('status').default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    revision: revisionColumn(),
    ...timestampColumns(),
    publishedAt: timestamp('published_at', { mode: 'date', withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { mode: 'date', withTimezone: true }),
    quarantinedAt: timestamp('quarantined_at', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    index('outbox_events_pending_index').on(table.status, table.createdAt),
    index('outbox_events_retry_index').on(table.status, table.quarantinedAt, table.nextAttemptAt),
    index('outbox_events_aggregate_index').on(table.aggregateType, table.aggregateId),
  ]
)
