import type {
  CredentialCommandReceipt,
  CredentialLease,
  StoredCredential,
} from '@control-plane/credential-vault'
import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * Connector credential metadata and opaque secret references. Plaintext secrets never enter
 * this table; ciphertext stays in `credential_secrets` behind the secret-provider boundary.
 */
export const credentials = pgTable(
  'credentials',
  {
    credentialId: varchar('credential_id', { length: 64 }).primaryKey(),
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    connectorRef: varchar('connector_ref', { length: 256 }).notNull(),
    provider: varchar('provider', { length: 128 }).notNull(),
    status: varchar('status', { length: 32 })
      .$type<StoredCredential['metadata']['status']>()
      .notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    createdBy: varchar('created_by', { length: 256 }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { mode: 'date', withTimezone: true }),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }),
    revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
    secretRevisions: jsonb('secret_revisions')
      .$type<StoredCredential['secretRevisions']>()
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'credentials_status_check',
      sql`${table.status} in ('active', 'revoked', 'secret_required')`
    ),
    check('credentials_revision_check', sql`${table.revision} > 0`),
    check(
      'credentials_secret_revisions_array_check',
      sql`jsonb_typeof(${table.secretRevisions}) = 'array'`
    ),
    check(
      'credentials_revoked_at_check',
      sql`(${table.status} = 'revoked') = (${table.revokedAt} is not null)`
    ),
    // One live credential per workspace connector; revoked rows free the binding.
    uniqueIndex('credentials_workspace_connector_live_unique')
      .on(table.workspaceId, table.connectorRef)
      .where(sql`${table.status} <> 'revoked'`),
    index('credentials_workspace_index').on(table.workspaceId, table.credentialId),
  ]
)

/** Single-use, revision-pinned leases. The capability reference is not a secret. */
export const credentialLeases = pgTable(
  'credential_leases',
  {
    credentialLeaseId: varchar('credential_lease_id', { length: 64 }).primaryKey(),
    capabilityRef: varchar('capability_ref', { length: 160 }).notNull(),
    credentialId: varchar('credential_id', { length: 64 })
      .notNull()
      .references(() => credentials.credentialId),
    credentialRevision: bigint('credential_revision', { mode: 'number' }).notNull(),
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    principalRef: varchar('principal_ref', { length: 256 }).notNull(),
    operation: varchar('operation', { length: 256 }).notNull(),
    resourceRef: varchar('resource_ref', { length: 256 }).notNull(),
    status: varchar('status', { length: 16 }).$type<CredentialLease['status']>().notNull(),
    policySnapshot: jsonb('policy_snapshot').$type<CredentialLease['policySnapshot']>().notNull(),
    policyDecisionId: varchar('policy_decision_id', { length: 71 }).notNull(),
    issuedAt: timestamp('issued_at', { mode: 'date', withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    uniqueIndex('credential_leases_capability_unique').on(table.capabilityRef),
    index('credential_leases_credential_status_index').on(table.credentialId, table.status),
    check(
      'credential_leases_status_check',
      sql`${table.status} in ('active', 'consumed', 'expired', 'revoked')`
    ),
    check(
      'credential_leases_lifetime_check',
      sql`${table.expiresAt} > ${table.issuedAt} and ${table.expiresAt} <= ${table.issuedAt} + interval '300 seconds'`
    ),
    check('credential_leases_revision_check', sql`${table.credentialRevision} > 0`),
  ]
)

/** Append-only audit trail with identifiers, revisions and bounded codes only. */
export const credentialAuditEvents = pgTable(
  'credential_audit_events',
  {
    sequence: bigserial('sequence', { mode: 'number' }).primaryKey(),
    action: varchar('action', { length: 32 }).notNull(),
    credentialId: varchar('credential_id', { length: 64 }).notNull(),
    credentialLeaseId: varchar('credential_lease_id', { length: 64 }),
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    principalRef: varchar('principal_ref', { length: 256 }),
    reasonCode: varchar('reason_code', { length: 128 }),
    at: timestamp('at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    index('credential_audit_events_workspace_index').on(table.workspaceId, table.sequence),
    index('credential_audit_events_credential_index').on(table.credentialId, table.sequence),
    check(
      'credential_audit_events_reason_code_check',
      sql`${table.reasonCode} is null or ${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`
    ),
  ]
)

/** Idempotency receipts for create/rotate. The payload hash never covers the secret. */
export const credentialCommands = pgTable(
  'credential_commands',
  {
    workspaceId: varchar('workspace_id', { length: 64 }).notNull(),
    callerId: varchar('caller_id', { length: 256 }).notNull(),
    operation: varchar('operation', { length: 16 })
      .$type<CredentialCommandReceipt['operation']>()
      .notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    result: jsonb('result').$type<CredentialCommandReceipt['result']>().notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.callerId, table.operation, table.idempotencyKey],
      name: 'credential_commands_scope_pk',
    }),
    check('credential_commands_operation_check', sql`${table.operation} in ('create', 'rotate')`),
    check('credential_commands_payload_hash_check', sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`),
    check('credential_commands_result_object_check', sql`jsonb_typeof(${table.result}) = 'object'`),
  ]
)
