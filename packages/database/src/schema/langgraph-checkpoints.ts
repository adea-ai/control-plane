import { sql } from 'drizzle-orm'
import { customType, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

/** LangGraph PostgresSaver schema; owned by the migration role, used by the app role. */
export const langgraphCheckpointMigrations = pgTable('checkpoint_migrations', {
  version: integer('v').primaryKey(),
})

export const langgraphCheckpoints = pgTable(
  'checkpoints',
  {
    threadId: text('thread_id').notNull(),
    checkpointNs: text('checkpoint_ns').default('').notNull(),
    checkpointId: text('checkpoint_id').notNull(),
    parentCheckpointId: text('parent_checkpoint_id'),
    type: text('type'),
    checkpoint: jsonb('checkpoint').notNull(),
    metadata: jsonb('metadata')
      .default(sql`'{}'::jsonb`)
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.checkpointNs, table.checkpointId] })]
)

export const langgraphCheckpointBlobs = pgTable(
  'checkpoint_blobs',
  {
    threadId: text('thread_id').notNull(),
    checkpointNs: text('checkpoint_ns').default('').notNull(),
    channel: text('channel').notNull(),
    version: text('version').notNull(),
    type: text('type').notNull(),
    blob: bytea('blob'),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.checkpointNs, table.channel, table.version] }),
  ]
)

export const langgraphCheckpointWrites = pgTable(
  'checkpoint_writes',
  {
    threadId: text('thread_id').notNull(),
    checkpointNs: text('checkpoint_ns').default('').notNull(),
    checkpointId: text('checkpoint_id').notNull(),
    taskId: text('task_id').notNull(),
    index: integer('idx').notNull(),
    channel: text('channel').notNull(),
    type: text('type'),
    blob: bytea('blob').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.threadId, table.checkpointNs, table.checkpointId, table.taskId, table.index],
    }),
  ]
)
