import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

export const catalogVersionLifecycle = pgEnum('catalog_version_lifecycle', [
  'draft',
  'published',
  'deprecated',
  'revoked',
  'superseded',
])

export const catalogApprovalDecision = pgEnum('catalog_approval_decision', ['approved', 'rejected'])

const identifier = (name: string) => varchar(name, { length: 64 })

export const agentProfiles = pgTable('agent_profiles', {
  profileId: identifier('profile_id').primaryKey(),
  displayName: varchar('display_name', { length: 128 }).notNull(),
  ownership: jsonb('ownership').notNull(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
})

export const agentProfileVersions = pgTable(
  'agent_profile_versions',
  {
    profileVersionId: identifier('profile_version_id').primaryKey(),
    profileId: identifier('profile_id')
      .notNull()
      .references(() => agentProfiles.profileId),
    version: integer('version').notNull(),
    revision: integer('revision').notNull(),
    lifecycle: catalogVersionLifecycle('lifecycle').notNull(),
    contentDigest: varchar('content_digest', { length: 71 }).notNull(),
    definition: jsonb('definition').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    lifecycleMetadata: jsonb('lifecycle_metadata').notNull(),
  },
  (table) => [
    uniqueIndex('agent_profile_versions_number_unique').on(table.profileId, table.version),
    index('agent_profile_versions_profile_index').on(table.profileId),
  ]
)

export const skills = pgTable('skills', {
  skillId: identifier('skill_id').primaryKey(),
  displayName: varchar('display_name', { length: 128 }).notNull(),
  ownership: jsonb('ownership').notNull(),
  provenance: jsonb('provenance').notNull(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
})

export const skillVersions = pgTable(
  'skill_versions',
  {
    skillVersionId: identifier('skill_version_id').primaryKey(),
    skillId: identifier('skill_id')
      .notNull()
      .references(() => skills.skillId),
    revision: integer('revision').notNull(),
    lifecycle: catalogVersionLifecycle('lifecycle').notNull(),
    manifest: jsonb('manifest').notNull(),
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    lifecycleMetadata: jsonb('lifecycle_metadata').notNull(),
  },
  (table) => [index('skill_versions_skill_index').on(table.skillId)]
)

/**
 * Version-binding approval decisions (#188): append-only per
 * (version_kind, version_id, revision) and deliberately separate from the
 * version lifecycle — publication is not approval.
 */
export const catalogApprovals = pgTable(
  'catalog_approvals',
  {
    versionKind: varchar('version_kind', { length: 16 }).notNull(),
    versionId: identifier('version_id').notNull(),
    revision: integer('revision').notNull(),
    contentDigest: varchar('content_digest', { length: 71 }).notNull(),
    decision: catalogApprovalDecision('decision').notNull(),
    actorPrincipalRef: varchar('actor_principal_ref', { length: 256 }).notNull(),
    authorityRef: varchar('authority_ref', { length: 256 }),
    rationale: varchar('rationale', { length: 1024 }),
    decidedAt: timestamp('decided_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionKind, table.versionId, table.revision] }),
    index('catalog_approvals_version_index').on(table.versionKind, table.versionId),
  ]
)
