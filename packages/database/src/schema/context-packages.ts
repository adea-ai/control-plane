import type { ContextPackage } from '@control-plane/context'
import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

const identifier = (name: string) => varchar(name, { length: 30 })

export const contextPackages = pgTable(
  'context_packages',
  {
    contextPackageId: identifier('context_package_id').primaryKey(),
    contentDigest: varchar('content_digest', { length: 71 }).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    workspaceId: identifier('workspace_id').notNull(),
    projectId: identifier('project_id').notNull(),
    contextPackage: jsonb('context_package').$type<ContextPackage>().notNull(),
    compiledAt: timestamp('compiled_at', { mode: 'date', withTimezone: true }).notNull(),
    // Retention metadata, not part of the immutable package/digest. Reference
    // writers must clear this clock atomically when a new reference is persisted.
    unreferencedSince: timestamp('unreferenced_since', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('context_packages_content_digest_unique').on(table.contentDigest),
    index('context_packages_scope_index').on(table.workspaceId, table.projectId, table.compiledAt),
  ]
)
