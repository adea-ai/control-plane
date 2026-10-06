import {
  CredentialAuditEventSchema,
  CredentialCommandReceiptSchema,
  CredentialLeaseSchema,
  StoredCredentialSchema,
  type CredentialAuditEvent,
  type CredentialAuditEventInput,
  type CredentialCommandReceipt,
  type CredentialCommandReceiptInput,
  type CredentialCommandScope,
  type CredentialInsertResult,
  type CredentialLease,
  type CredentialUpdateResult,
  type CredentialVaultRepository,
  type PersistedCredentialStatus,
  type StoredCredential,
} from '@control-plane/credential-vault'
import { and, asc, eq, ne, sql, type SQL } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import {
  credentialAuditEvents,
  credentialCommands,
  credentialLeases,
  credentials,
} from './schema/credential-vault.js'

type CredentialRow = typeof credentials.$inferSelect
type LeaseRow = typeof credentialLeases.$inferSelect
type CommandRow = typeof credentialCommands.$inferSelect
type Transaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]

/** Aborts the surrounding transaction and carries a non-error repository outcome. */
class Outcome<Value> extends Error {
  constructor(readonly value: Value) {
    super('CREDENTIAL_REPOSITORY_OUTCOME')
  }
}

/**
 * PostgreSQL credential metadata, leases, audit and idempotency receipts. Composition supplies
 * the application-role connection; secret ciphertext stays behind `PostgresEncryptedSecretStore`.
 */
export class PostgresCredentialVaultRepository implements CredentialVaultRepository {
  constructor(private readonly database: ControlPlaneDatabase) {}

  async insertCredential(
    input: StoredCredential,
    receiptInput?: CredentialCommandReceiptInput
  ): Promise<CredentialInsertResult> {
    const credential = StoredCredentialSchema.parse(input)
    const receipt =
      receiptInput === undefined ? undefined : CredentialCommandReceiptSchema.parse(receiptInput)
    try {
      return await this.database.transaction(async (transaction) => {
        if (receipt !== undefined) await claimReceipt(transaction, receipt)
        const inserted = await transaction
          .insert(credentials)
          .values(toCredentialRow(credential))
          .onConflictDoNothing()
          .returning({ credentialId: credentials.credentialId })
        if (inserted.length === 1) return 'inserted' as const
        const [existing] = await transaction
          .select({ credentialId: credentials.credentialId })
          .from(credentials)
          .where(eq(credentials.credentialId, credential.metadata.credentialId))
          .limit(1)
        throw new Outcome<CredentialInsertResult>(
          existing === undefined ? 'connector_in_use' : 'credential_exists'
        )
      })
    } catch (error) {
      if (error instanceof Outcome) return error.value as CredentialInsertResult
      throw error
    }
  }

  async getCredential(credentialId: string): Promise<StoredCredential | undefined> {
    const [row] = await this.database
      .select()
      .from(credentials)
      .where(eq(credentials.credentialId, credentialId))
      .limit(1)
    return row === undefined ? undefined : fromCredentialRow(row)
  }

  async findCredentialByConnector(
    workspaceId: string,
    connectorRef: string
  ): Promise<StoredCredential | undefined> {
    const [row] = await this.database
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.workspaceId, workspaceId),
          eq(credentials.connectorRef, connectorRef),
          ne(credentials.status, 'revoked')
        )
      )
      .limit(1)
    return row === undefined ? undefined : fromCredentialRow(row)
  }

  async listCredentials(
    workspaceId: string,
    page: { readonly afterCredentialId?: string; readonly limit: number }
  ): Promise<readonly StoredCredential[]> {
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1_000) {
      throw new RangeError('CREDENTIAL_PAGE_LIMIT_INVALID')
    }
    const conditions: SQL[] = [eq(credentials.workspaceId, workspaceId)]
    if (page.afterCredentialId !== undefined) {
      conditions.push(sql`${credentials.credentialId} collate "C" > ${page.afterCredentialId}`)
    }
    const rows = await this.database
      .select()
      .from(credentials)
      .where(and(...conditions))
      .orderBy(sql`${credentials.credentialId} collate "C"`)
      .limit(page.limit)
    return rows.map(fromCredentialRow)
  }

  async updateCredential(
    input: StoredCredential,
    expected: { readonly revision: number; readonly status: PersistedCredentialStatus },
    options: {
      readonly revokeActiveLeases?: boolean
      readonly receipt?: CredentialCommandReceiptInput
    } = {}
  ): Promise<CredentialUpdateResult> {
    const next = StoredCredentialSchema.parse(input)
    const receipt =
      options.receipt === undefined
        ? undefined
        : CredentialCommandReceiptSchema.parse(options.receipt)
    try {
      return await this.database.transaction(async (transaction) => {
        if (receipt !== undefined) await claimReceipt(transaction, receipt)
        const { credentialId: _credentialId, ...values } = toCredentialRow(next)
        const updated = await transaction
          .update(credentials)
          .set({ ...values, updatedAt: new Date() })
          .where(
            and(
              eq(credentials.credentialId, next.metadata.credentialId),
              eq(credentials.workspaceId, next.metadata.workspaceId),
              eq(credentials.revision, expected.revision),
              eq(credentials.status, expected.status)
            )
          )
          .returning({ credentialId: credentials.credentialId })
        if (updated.length !== 1) throw new Outcome<CredentialUpdateResult>('conflict')
        if (options.revokeActiveLeases === true) {
          await transaction
            .update(credentialLeases)
            .set({ status: 'revoked' })
            .where(
              and(
                eq(credentialLeases.credentialId, next.metadata.credentialId),
                eq(credentialLeases.status, 'active')
              )
            )
        }
        return 'updated' as const
      })
    } catch (error) {
      if (error instanceof Outcome) return error.value as CredentialUpdateResult
      throw error
    }
  }

  async getCommandReceipt(
    scope: CredentialCommandScope
  ): Promise<CredentialCommandReceipt | undefined> {
    const [row] = await this.database
      .select()
      .from(credentialCommands)
      .where(
        and(
          eq(credentialCommands.workspaceId, scope.workspaceId),
          eq(credentialCommands.callerId, scope.callerId),
          eq(credentialCommands.operation, scope.operation),
          eq(credentialCommands.idempotencyKey, scope.idempotencyKey)
        )
      )
      .limit(1)
    return row === undefined ? undefined : fromCommandRow(row)
  }

  async insertLease(input: CredentialLease): Promise<boolean> {
    const lease = CredentialLeaseSchema.parse(input)
    const inserted = await this.database
      .insert(credentialLeases)
      .values(toLeaseRow(lease))
      .onConflictDoNothing()
      .returning({ credentialLeaseId: credentialLeases.credentialLeaseId })
    return inserted.length === 1
  }

  async getLease(capabilityRef: string): Promise<CredentialLease | undefined> {
    const [row] = await this.database
      .select()
      .from(credentialLeases)
      .where(eq(credentialLeases.capabilityRef, capabilityRef))
      .limit(1)
    return row === undefined ? undefined : fromLeaseRow(row)
  }

  async transitionLease(input: CredentialLease): Promise<boolean> {
    const next = CredentialLeaseSchema.parse(input)
    const updated = await this.database
      .update(credentialLeases)
      .set({
        status: next.status,
        consumedAt: next.consumedAt === undefined ? null : new Date(next.consumedAt),
      })
      .where(
        and(
          eq(credentialLeases.capabilityRef, next.capabilityRef),
          eq(credentialLeases.credentialLeaseId, next.credentialLeaseId),
          eq(credentialLeases.status, 'active')
        )
      )
      .returning({ credentialLeaseId: credentialLeases.credentialLeaseId })
    return updated.length === 1
  }

  async appendAudit(input: CredentialAuditEventInput): Promise<void> {
    const event = CredentialAuditEventSchema.parse(input)
    await this.database.insert(credentialAuditEvents).values({
      action: event.action,
      credentialId: event.credentialId,
      credentialLeaseId: event.credentialLeaseId ?? null,
      workspaceId: event.workspaceId,
      revision: event.revision,
      principalRef: event.principalRef ?? null,
      reasonCode: event.reasonCode ?? null,
      at: new Date(event.at),
    })
  }

  async listAudit(
    filter: { readonly workspaceId?: string; readonly credentialId?: string } = {}
  ): Promise<readonly CredentialAuditEvent[]> {
    const conditions: SQL[] = []
    if (filter.workspaceId !== undefined) {
      conditions.push(eq(credentialAuditEvents.workspaceId, filter.workspaceId))
    }
    if (filter.credentialId !== undefined) {
      conditions.push(eq(credentialAuditEvents.credentialId, filter.credentialId))
    }
    const rows = await this.database
      .select()
      .from(credentialAuditEvents)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(credentialAuditEvents.sequence))
      .limit(10_000)
    return rows.map((row) =>
      CredentialAuditEventSchema.parse({
        action: row.action,
        credentialId: row.credentialId,
        ...(row.credentialLeaseId === null ? {} : { credentialLeaseId: row.credentialLeaseId }),
        workspaceId: row.workspaceId,
        revision: row.revision,
        ...(row.principalRef === null ? {} : { principalRef: row.principalRef }),
        ...(row.reasonCode === null ? {} : { reasonCode: row.reasonCode }),
        at: row.at.toISOString(),
      })
    )
  }
}

async function claimReceipt(transaction: Transaction, receipt: CredentialCommandReceipt) {
  const claimed = await transaction
    .insert(credentialCommands)
    .values({
      workspaceId: receipt.workspaceId,
      callerId: receipt.callerId,
      operation: receipt.operation,
      idempotencyKey: receipt.idempotencyKey,
      payloadHash: receipt.payloadHash,
      result: receipt.result,
    })
    .onConflictDoNothing()
    .returning({ idempotencyKey: credentialCommands.idempotencyKey })
  if (claimed.length !== 1) throw new Outcome('receipt_exists')
}

function toCredentialRow(credential: StoredCredential): typeof credentials.$inferInsert {
  const { metadata } = credential
  return {
    credentialId: metadata.credentialId,
    workspaceId: metadata.workspaceId,
    connectorRef: metadata.connectorRef,
    provider: metadata.provider,
    status: metadata.status,
    revision: metadata.revision,
    createdBy: metadata.createdBy ?? null,
    createdAt: new Date(metadata.createdAt),
    rotatedAt: metadata.rotatedAt === undefined ? null : new Date(metadata.rotatedAt),
    expiresAt: metadata.expiresAt === undefined ? null : new Date(metadata.expiresAt),
    revokedAt: metadata.revokedAt === undefined ? null : new Date(metadata.revokedAt),
    secretRevisions: credential.secretRevisions,
  }
}

function fromCredentialRow(row: CredentialRow): StoredCredential {
  return StoredCredentialSchema.parse({
    metadata: {
      credentialId: row.credentialId,
      workspaceId: row.workspaceId,
      connectorRef: row.connectorRef,
      provider: row.provider,
      status: row.status,
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
      ...(row.rotatedAt === null ? {} : { rotatedAt: row.rotatedAt.toISOString() }),
      ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt.toISOString() }),
      ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt.toISOString() }),
    },
    secretRevisions: row.secretRevisions,
  })
}

function toLeaseRow(lease: CredentialLease): typeof credentialLeases.$inferInsert {
  return {
    credentialLeaseId: lease.credentialLeaseId,
    capabilityRef: lease.capabilityRef,
    credentialId: lease.credentialId,
    credentialRevision: lease.credentialRevision,
    workspaceId: lease.workspaceId,
    principalRef: lease.principalRef,
    operation: lease.operation,
    resourceRef: lease.resourceRef,
    status: lease.status,
    policySnapshot: lease.policySnapshot,
    policyDecisionId: lease.policyDecisionId,
    issuedAt: new Date(lease.issuedAt),
    expiresAt: new Date(lease.expiresAt),
    consumedAt: lease.consumedAt === undefined ? null : new Date(lease.consumedAt),
  }
}

function fromLeaseRow(row: LeaseRow): CredentialLease {
  return CredentialLeaseSchema.parse({
    credentialLeaseId: row.credentialLeaseId,
    credentialId: row.credentialId,
    credentialRevision: row.credentialRevision,
    workspaceId: row.workspaceId,
    principalRef: row.principalRef,
    operation: row.operation,
    resourceRef: row.resourceRef,
    capabilityRef: row.capabilityRef,
    status: row.status,
    policySnapshot: row.policySnapshot,
    policyDecisionId: row.policyDecisionId,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.consumedAt === null ? {} : { consumedAt: row.consumedAt.toISOString() }),
  })
}

function fromCommandRow(row: CommandRow): CredentialCommandReceipt {
  return CredentialCommandReceiptSchema.parse({
    workspaceId: row.workspaceId,
    callerId: row.callerId,
    operation: row.operation,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    result: row.result,
  })
}
