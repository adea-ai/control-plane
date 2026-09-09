import { index, jsonb, pgEnum, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core'

export const marketplaceInstallationState = pgEnum('marketplace_installation_state', [
  'pending-authorization',
  'unavailable',
  'rejected-by-policy',
  'installed',
  'superseded',
])

export const marketplaceInstallations = pgTable(
  'marketplace_installations',
  {
    installationId: varchar('installation_id', { length: 64 }).primaryKey(),
    catalogId: varchar('catalog_id', { length: 72 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 256 }).notNull(),
    userId: varchar('user_id', { length: 256 }).notNull(),
    pluginId: varchar('plugin_id', { length: 192 }).notNull(),
    releaseId: varchar('release_id', { length: 72 }).notNull(),
    canonicalContentDigest: varchar('canonical_content_digest', { length: 71 }).notNull(),
    requestedHarness: varchar('requested_harness', { length: 128 }).notNull(),
    installationInstanceId: varchar('installation_instance_id', { length: 256 }),
    packageDigest: varchar('package_digest', { length: 71 }),
    requiredConnectors: jsonb('required_connectors').$type<readonly string[]>().notNull(),
    requiredCredentials: jsonb('required_credentials').$type<readonly string[]>().notNull(),
    state: marketplaceInstallationState('state').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    requestDigest: varchar('request_digest', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('marketplace_installations_workspace_idempotency_unique').on(
      table.workspaceId,
      table.idempotencyKey
    ),
    index('marketplace_installations_workspace_index').on(table.workspaceId, table.updatedAt),
  ]
)
