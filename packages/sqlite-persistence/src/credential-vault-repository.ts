import {
  CredentialAuditEventSchema,
  CredentialCommandReceiptSchema,
  CredentialLeaseSchema,
  StoredCredentialSchema,
  credentialCommandKey,
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
import type { PersistenceProvider, PersistenceTransaction } from '@control-plane/deployment'
import { json, recordId } from './record-storage.js'

/** Record namespaces owned by the SQLite credential vault adapter. */
export const CREDENTIAL_VAULT_NAMESPACES = Object.freeze({
  credentials: 'credentials',
  connectors: 'credential-connectors',
  leases: 'credential-leases',
  leaseIds: 'credential-lease-ids',
  audit: 'credential-audit-events',
  auditSequence: 'credential-audit-sequence',
  commands: 'credential-commands',
})

const ns = CREDENTIAL_VAULT_NAMESPACES

/**
 * Local and Hosted `simple` credential metadata, leases, audit and receipts in the profile's
 * SQLite records table. Only opaque secret references are stored; never plaintext secrets.
 */
export class SqliteCredentialVaultRepository implements CredentialVaultRepository {
  constructor(readonly provider: Pick<PersistenceProvider, 'transaction'>) {}

  insertCredential(
    input: StoredCredential,
    receiptInput?: CredentialCommandReceiptInput
  ): Promise<CredentialInsertResult> {
    const credential = StoredCredentialSchema.parse(input)
    const receipt =
      receiptInput === undefined ? undefined : CredentialCommandReceiptSchema.parse(receiptInput)
    return this.provider.transaction(async (transaction) => {
      if (receipt !== undefined && (await readReceipt(transaction, receipt)) !== undefined) {
        return 'receipt_exists'
      }
      const result = await writeSqliteCredential(transaction, credential)
      if (result !== 'inserted') return result
      if (receipt !== undefined) await writeReceipt(transaction, receipt)
      return 'inserted'
    })
  }

  getCredential(credentialId: string): Promise<StoredCredential | undefined> {
    return this.provider.transaction((transaction) => readCredential(transaction, credentialId))
  }

  findCredentialByConnector(
    workspaceId: string,
    connectorRef: string
  ): Promise<StoredCredential | undefined> {
    return this.provider.transaction(async (transaction) => {
      const binding = await transaction.get(ns.connectors, connectorId(workspaceId, connectorRef))
      if (binding === undefined) return undefined
      const boundId = (binding.value as { readonly credentialId?: unknown }).credentialId
      if (typeof boundId !== 'string') throw new Error('SQLITE_CREDENTIAL_BINDING_CORRUPT')
      const credential = await readCredential(transaction, boundId)
      if (
        credential === undefined ||
        credential.metadata.workspaceId !== workspaceId ||
        credential.metadata.connectorRef !== connectorRef ||
        credential.metadata.status === 'revoked'
      ) {
        throw new Error('SQLITE_CREDENTIAL_BINDING_CORRUPT')
      }
      return credential
    })
  }

  listCredentials(
    workspaceId: string,
    page: { readonly afterCredentialId?: string; readonly limit: number }
  ): Promise<readonly StoredCredential[]> {
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1_000) {
      throw new RangeError('CREDENTIAL_PAGE_LIMIT_INVALID')
    }
    return this.provider.transaction(async (transaction) =>
      (await transaction.list(ns.credentials))
        .map((record) => StoredCredentialSchema.parse(record.value))
        .filter(
          (credential) =>
            credential.metadata.workspaceId === workspaceId &&
            (page.afterCredentialId === undefined ||
              credential.metadata.credentialId > page.afterCredentialId)
        )
        .toSorted((left, right) =>
          left.metadata.credentialId < right.metadata.credentialId ? -1 : 1
        )
        .slice(0, page.limit)
    )
  }

  updateCredential(
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
    return this.provider.transaction(async (transaction) => {
      if (receipt !== undefined && (await readReceipt(transaction, receipt)) !== undefined) {
        return 'receipt_exists'
      }
      const currentRecord = await transaction.get(ns.credentials, next.metadata.credentialId)
      const current = await readCredential(transaction, next.metadata.credentialId)
      if (
        currentRecord === undefined ||
        current === undefined ||
        current.metadata.workspaceId !== next.metadata.workspaceId ||
        current.metadata.connectorRef !== next.metadata.connectorRef ||
        current.metadata.revision !== expected.revision ||
        current.metadata.status !== expected.status
      ) {
        return 'conflict'
      }
      await transaction.put({
        namespace: ns.credentials,
        id: next.metadata.credentialId,
        value: json(next),
        expectedRevision: currentRecord.revision,
      })
      if (next.metadata.status === 'revoked' && current.metadata.status !== 'revoked') {
        await transaction.delete(
          ns.connectors,
          connectorId(next.metadata.workspaceId, next.metadata.connectorRef)
        )
      }
      if (options.revokeActiveLeases === true) {
        for (const record of await transaction.list(ns.leases)) {
          const lease = CredentialLeaseSchema.parse(record.value)
          if (lease.credentialId === next.metadata.credentialId && lease.status === 'active') {
            await transaction.put({
              namespace: ns.leases,
              id: record.id,
              value: json({ ...lease, status: 'revoked' }),
              expectedRevision: record.revision,
            })
          }
        }
      }
      if (receipt !== undefined) await writeReceipt(transaction, receipt)
      return 'updated'
    })
  }

  getCommandReceipt(scope: CredentialCommandScope): Promise<CredentialCommandReceipt | undefined> {
    return this.provider.transaction((transaction) => readReceipt(transaction, scope))
  }

  insertLease(input: CredentialLease): Promise<boolean> {
    const lease = CredentialLeaseSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      if (
        (await transaction.get(ns.leaseIds, lease.credentialLeaseId)) !== undefined ||
        (await transaction.get(ns.leases, leaseRecordId(lease.capabilityRef))) !== undefined
      ) {
        return false
      }
      await transaction.put({
        namespace: ns.leaseIds,
        id: lease.credentialLeaseId,
        value: { capabilityRef: lease.capabilityRef },
      })
      await transaction.put({
        namespace: ns.leases,
        id: leaseRecordId(lease.capabilityRef),
        value: json(lease),
      })
      return true
    })
  }

  getLease(capabilityRef: string): Promise<CredentialLease | undefined> {
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(ns.leases, leaseRecordId(capabilityRef))
      if (record === undefined) return undefined
      const lease = CredentialLeaseSchema.parse(record.value)
      if (lease.capabilityRef !== capabilityRef) throw new Error('SQLITE_CREDENTIAL_LEASE_CORRUPT')
      return lease
    })
  }

  transitionLease(input: CredentialLease): Promise<boolean> {
    const next = CredentialLeaseSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(ns.leases, leaseRecordId(next.capabilityRef))
      if (record === undefined) return false
      const current = CredentialLeaseSchema.parse(record.value)
      if (current.status !== 'active' || current.credentialLeaseId !== next.credentialLeaseId) {
        return false
      }
      await transaction.put({
        namespace: ns.leases,
        id: record.id,
        value: json(next),
        expectedRevision: record.revision,
      })
      return true
    })
  }

  appendAudit(input: CredentialAuditEventInput): Promise<void> {
    return this.provider.transaction((transaction) =>
      appendSqliteCredentialAudit(transaction, input)
    )
  }

  listAudit(
    filter: { readonly workspaceId?: string; readonly credentialId?: string } = {}
  ): Promise<readonly CredentialAuditEvent[]> {
    return this.provider.transaction(async (transaction) =>
      (await transaction.list(ns.audit))
        .toSorted((left, right) => (left.id < right.id ? -1 : 1))
        .map((record) => CredentialAuditEventSchema.parse(record.value))
        .filter(
          (event) =>
            (filter.workspaceId === undefined || event.workspaceId === filter.workspaceId) &&
            (filter.credentialId === undefined || event.credentialId === filter.credentialId)
        )
    )
  }
}

/**
 * Writes a credential and its live connector binding inside an owned transaction. Exported for
 * profile import, which must preserve the one-live-credential-per-connector invariant.
 */
export async function writeSqliteCredential(
  transaction: PersistenceTransaction,
  input: StoredCredential
): Promise<'inserted' | 'credential_exists' | 'connector_in_use'> {
  const credential = StoredCredentialSchema.parse(input)
  const { credentialId, workspaceId, connectorRef, status } = credential.metadata
  if ((await transaction.get(ns.credentials, credentialId)) !== undefined) {
    return 'credential_exists'
  }
  if (status !== 'revoked') {
    const binding = await transaction.get(ns.connectors, connectorId(workspaceId, connectorRef))
    if (binding !== undefined) return 'connector_in_use'
    await transaction.put({
      namespace: ns.connectors,
      id: connectorId(workspaceId, connectorRef),
      value: { credentialId },
    })
  }
  await transaction.put({ namespace: ns.credentials, id: credentialId, value: json(credential) })
  return 'inserted'
}

/** Reads every stored credential (any workspace) for profile export. */
export async function listSqliteCredentials(
  transaction: PersistenceTransaction
): Promise<readonly StoredCredential[]> {
  return (await transaction.list(ns.credentials)).map((record) =>
    StoredCredentialSchema.parse(record.value)
  )
}

export async function readSqliteCredential(
  transaction: PersistenceTransaction,
  credentialId: string
): Promise<StoredCredential | undefined> {
  return readCredential(transaction, credentialId)
}

/** Appends one audit event with a monotonically increasing storage sequence. */
export async function appendSqliteCredentialAudit(
  transaction: PersistenceTransaction,
  input: CredentialAuditEventInput
): Promise<void> {
  const event = CredentialAuditEventSchema.parse(input)
  const counter = await transaction.get(ns.auditSequence, 'next')
  const sequence =
    counter === undefined ? 1 : Number((counter.value as { readonly value?: unknown }).value)
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('SQLITE_CREDENTIAL_AUDIT_SEQUENCE_CORRUPT')
  }
  await transaction.put({
    namespace: ns.auditSequence,
    id: 'next',
    value: { value: sequence + 1 },
    ...(counter === undefined ? {} : { expectedRevision: counter.revision }),
  })
  await transaction.put({
    namespace: ns.audit,
    id: `e-${String(sequence).padStart(16, '0')}`,
    value: json(event),
  })
}

async function readCredential(
  transaction: PersistenceTransaction,
  credentialId: string
): Promise<StoredCredential | undefined> {
  const record = await transaction.get(ns.credentials, credentialId)
  if (record === undefined) return undefined
  const credential = StoredCredentialSchema.parse(record.value)
  if (credential.metadata.credentialId !== credentialId) {
    throw new Error('SQLITE_CREDENTIAL_RECORD_CORRUPT')
  }
  return credential
}

async function readReceipt(
  transaction: PersistenceTransaction,
  scope: CredentialCommandScope
): Promise<CredentialCommandReceipt | undefined> {
  const record = await transaction.get(ns.commands, recordId(credentialCommandKey(scope)))
  if (record === undefined) return undefined
  const receipt = CredentialCommandReceiptSchema.parse(record.value)
  if (credentialCommandKey(receipt) !== credentialCommandKey(scope)) {
    throw new Error('SQLITE_CREDENTIAL_RECEIPT_CORRUPT')
  }
  return receipt
}

async function writeReceipt(
  transaction: PersistenceTransaction,
  receipt: CredentialCommandReceipt
): Promise<void> {
  await transaction.put({
    namespace: ns.commands,
    id: recordId(credentialCommandKey(receipt)),
    value: json(receipt),
  })
}

function connectorId(workspaceId: string, connectorRef: string): string {
  return recordId(JSON.stringify([workspaceId, connectorRef]))
}

function leaseRecordId(capabilityRef: string): string {
  return recordId(capabilityRef)
}
