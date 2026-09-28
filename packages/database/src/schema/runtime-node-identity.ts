import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import type { RuntimeNodeCredentialClaims } from '@control-plane/runtime-gateway-protocol'

export const runtimeNodeVerificationKeys = pgTable(
  'runtime_node_verification_keys',
  {
    keyId: varchar('key_id', { length: 128 }).primaryKey(),
    nodeId: varchar('node_id', { length: 30 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
    publicKeyPem: varchar('public_key_pem', { length: 2048 }).notNull(),
    thumbprint: varchar('thumbprint', { length: 71 }).notNull(),
    status: varchar('status', { length: 16 }).$type<'active' | 'retired' | 'revoked'>().notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('runtime_node_verification_keys_scope_unique').on(
      table.keyId,
      table.nodeId,
      table.workspaceId
    ),
    check(
      'runtime_node_verification_keys_status_check',
      sql`${table.status} in ('active', 'retired', 'revoked')`
    ),
    check(
      'runtime_node_verification_keys_thumbprint_check',
      sql`${table.thumbprint} ~ '^sha256:[a-f0-9]{64}$'`
    ),
    check(
      'runtime_node_verification_keys_public_key_check',
      sql`${table.publicKeyPem} like '-----BEGIN PUBLIC KEY-----%-----END PUBLIC KEY-----%'`
    ),
  ]
)

export const runtimeNodeIssuedCredentials = pgTable(
  'runtime_node_issued_credentials',
  {
    credentialId: varchar('credential_id', { length: 128 }).primaryKey(),
    nodeId: varchar('node_id', { length: 30 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 30 }).notNull(),
    keyId: varchar('key_id', { length: 128 }).notNull(),
    claims: jsonb('claims').$type<RuntimeNodeCredentialClaims>().notNull(),
    revocationVersion: bigint('revocation_version', { mode: 'number' }).notNull(),
    issuedAt: timestamp('issued_at', { mode: 'date', withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    consumedAt: timestamp('consumed_at', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'runtime_node_issued_credentials_key_scope_fk',
      columns: [table.keyId, table.nodeId, table.workspaceId],
      foreignColumns: [
        runtimeNodeVerificationKeys.keyId,
        runtimeNodeVerificationKeys.nodeId,
        runtimeNodeVerificationKeys.workspaceId,
      ],
    }).onDelete('restrict'),
    index('runtime_node_issued_credentials_key_scope_idx').on(
      table.keyId,
      table.nodeId,
      table.workspaceId
    ),
    check(
      'runtime_node_issued_credentials_version_check',
      sql`${table.revocationVersion} between 1 and 9007199254740991`
    ),
    check(
      'runtime_node_issued_credentials_expiry_check',
      sql`${table.expiresAt} > ${table.issuedAt}`
    ),
    check(
      'runtime_node_issued_credentials_claims_scope_check',
      sql`jsonb_typeof(${table.claims}) = 'object'
        and ${table.claims} ->> 'credentialKind' = 'runtime_node'
        and (${table.claims} ->> 'schemaVersion')::integer = 1
        and ${table.claims} ->> 'credentialId' = ${table.credentialId}
        and ${table.claims} ->> 'nodeId' = ${table.nodeId}
        and ${table.claims} ->> 'workspaceId' = ${table.workspaceId}
        and ${table.claims} ->> 'keyId' = ${table.keyId}`
    ),
    check(
      'runtime_node_issued_credentials_revocation_state_check',
      sql`(${table.revokedAt} is null
          and ${table.revocationVersion} = (${table.claims} ->> 'revocationVersion')::bigint)
        or (${table.revokedAt} is not null
          and ${table.revocationVersion} = (${table.claims} ->> 'revocationVersion')::bigint + 1)`
    ),
  ]
)
