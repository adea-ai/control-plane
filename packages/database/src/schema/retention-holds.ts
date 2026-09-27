import { check, index, integer, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

const identifier = (name: string) => varchar(name, { length: 30 })

/** Durable owner hold metadata, installed by the canonical migration chain. */
export const retentionHolds = pgTable(
  'retention_holds',
  {
    holdId: varchar('hold_id', { length: 36 }).primaryKey(),
    classId: varchar('class_id', { length: 64 }).notNull(),
    scopeKind: varchar('scope_kind', { length: 16 }).notNull(),
    workspaceId: identifier('workspace_id'),
    projectId: identifier('project_id'),
    owner: varchar('hold_owner', { length: 64 }).notNull(),
    reasonCode: varchar('reason_code', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    createdByPrincipalRef: varchar('created_by_principal_ref', { length: 256 }).notNull(),
    createdAuthorityRef: varchar('created_authority_ref', { length: 256 }).notNull(),
    revision: integer('revision').default(0).notNull(),
    releaseRequestId: varchar('release_request_id', { length: 36 }),
    releasedAt: timestamp('released_at', { mode: 'date', withTimezone: true }),
    releasedByPrincipalRef: varchar('released_by_principal_ref', { length: 256 }),
    releaseAuthorityRef: varchar('release_authority_ref', { length: 256 }),
  },
  (table) => [
    check(
      'retention_holds_scope_shape_check',
      sql`(${table.scopeKind} = 'class' and ${table.workspaceId} is null and ${table.projectId} is null) or (${table.scopeKind} = 'workspace' and ${table.workspaceId} is not null and ${table.projectId} is null) or (${table.scopeKind} = 'project' and ${table.workspaceId} is not null and ${table.projectId} is not null)`
    ),
    check(
      'retention_holds_release_revision_check',
      sql`(${table.revision} = 0 and ${table.releaseRequestId} is null and ${table.releasedAt} is null and ${table.releasedByPrincipalRef} is null and ${table.releaseAuthorityRef} is null) or (${table.revision} = 1 and ${table.releaseRequestId} is not null and ${table.releasedAt} is not null and ${table.releasedByPrincipalRef} is not null and ${table.releaseAuthorityRef} is not null)`
    ),
    index('retention_holds_scope_index').on(
      table.classId,
      table.releasedAt,
      table.scopeKind,
      table.workspaceId,
      table.projectId
    ),
  ]
)
