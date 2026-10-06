import { CredentialPublicMetadataSchema, IdentifierSchemas } from '@control-plane/contracts'
import { PolicySnapshotReferenceSchema } from '@control-plane/policy'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()
export const CredentialReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
export const CredentialProviderNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9.-]*$/)

/**
 * `secret_required` marks metadata that exists without usable secret material, for example
 * after a profile import. A rotation re-enters the secret and returns the credential to `active`.
 * `expired` is derived from `expiresAt` when metadata is read and is never persisted.
 */
export const CredentialStatusSchema = z.enum(['active', 'revoked', 'expired', 'secret_required'])
export const PersistedCredentialStatusSchema = z.enum(['active', 'revoked', 'secret_required'])

/** Same shape as the public contract so persisted and public metadata cannot drift. */
export const CredentialMetadataSchema = CredentialPublicMetadataSchema

export const CredentialLeaseStatusSchema = z.enum(['active', 'consumed', 'expired', 'revoked'])

export const CredentialLeaseSchema = z
  .object({
    credentialLeaseId: IdentifierSchemas.credentialLeaseId,
    credentialId: IdentifierSchemas.credentialId,
    credentialRevision: z.number().int().positive(),
    workspaceId: IdentifierSchemas.workspaceId,
    principalRef: CredentialReferenceSchema,
    operation: CredentialReferenceSchema,
    resourceRef: CredentialReferenceSchema,
    capabilityRef: z.string().regex(/^lease:\/\/crl_[0-9A-HJKMNP-TV-Z]{26}\/[a-f0-9]{64}$/),
    status: CredentialLeaseStatusSchema,
    policySnapshot: PolicySnapshotReferenceSchema,
    policyDecisionId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    consumedAt: TimestampSchema.optional(),
  })
  .strict()

/** Opaque provider reference. It identifies stored ciphertext and never contains plaintext. */
export const EncryptedSecretReferenceSchema = z
  .object({
    backend: z.enum(['memory', 'neon-encrypted']),
    locator: z.string().min(1).max(512),
    version: z.string().min(1).max(64),
    keyReference: z.string().min(1).max(128),
    encryptionVersion: z.enum(['memory-v1', 'aad-v1']),
    ciphertextDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .transform((value) => value as `sha256:${string}`),
  })
  .strict()

export const CredentialSecretRevisionSchema = z
  .object({
    revision: z.number().int().positive(),
    reference: EncryptedSecretReferenceSchema,
  })
  .strict()

export const StoredCredentialSchema = z
  .object({
    metadata: CredentialMetadataSchema.extend({ status: PersistedCredentialStatusSchema }),
    secretRevisions: z.array(CredentialSecretRevisionSchema).max(1_024),
  })
  .strict()
  .superRefine((credential, context) => {
    const revisions = credential.secretRevisions.map(({ revision }) => revision)
    if (
      new Set(revisions).size !== revisions.length ||
      revisions.some((revision) => revision > credential.metadata.revision) ||
      (credential.metadata.status === 'active' && !revisions.includes(credential.metadata.revision))
    ) {
      context.addIssue({ code: 'custom', message: 'Credential secret revisions are inconsistent' })
    }
  })

export const CredentialAuditActionSchema = z.enum([
  'credential.created',
  'credential.rotated',
  'credential.revoked',
  'credential.imported',
  'lease.issued',
  'lease.used',
  'lease.denied',
])

/** Audit events carry identifiers, revisions and bounded codes only. */
export const CredentialAuditEventSchema = z
  .object({
    action: CredentialAuditActionSchema,
    credentialId: IdentifierSchemas.credentialId,
    credentialLeaseId: IdentifierSchemas.credentialLeaseId.optional(),
    workspaceId: IdentifierSchemas.workspaceId,
    revision: z.number().int().positive(),
    principalRef: CredentialReferenceSchema.optional(),
    reasonCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    at: TimestampSchema,
  })
  .strict()

export const CredentialCommandOperationSchema = z.enum(['create', 'rotate'])

/** Idempotency receipt. `payloadHash` never covers secret material. */
export const CredentialCommandReceiptSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    callerId: CredentialReferenceSchema,
    operation: CredentialCommandOperationSchema,
    idempotencyKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    result: CredentialMetadataSchema,
  })
  .strict()

export type CredentialMetadata = z.output<typeof CredentialMetadataSchema>
export type CredentialStatus = z.output<typeof CredentialStatusSchema>
export type PersistedCredentialStatus = z.output<typeof PersistedCredentialStatusSchema>
export type CredentialLease = z.output<typeof CredentialLeaseSchema>
export type EncryptedSecretReference = z.output<typeof EncryptedSecretReferenceSchema>
export type StoredCredential = z.output<typeof StoredCredentialSchema>
export type CredentialAuditEvent = z.output<typeof CredentialAuditEventSchema>
export type CredentialAuditEventInput = z.input<typeof CredentialAuditEventSchema>
export type CredentialCommandReceipt = z.output<typeof CredentialCommandReceiptSchema>
export type CredentialCommandReceiptInput = z.input<typeof CredentialCommandReceiptSchema>
export type CredentialCommandScope = Pick<
  CredentialCommandReceiptInput,
  'workspaceId' | 'callerId' | 'operation' | 'idempotencyKey'
>

export type CredentialInsertResult =
  | 'inserted'
  | 'credential_exists'
  | 'connector_in_use'
  | 'receipt_exists'
export type CredentialUpdateResult = 'updated' | 'conflict' | 'receipt_exists'

/**
 * Durable vault state. Implementations persist metadata, secret references, leases, audit
 * events and idempotency receipts; they never receive plaintext secret values.
 */
export interface CredentialVaultRepository {
  insertCredential(
    credential: StoredCredential,
    receipt?: CredentialCommandReceiptInput
  ): Promise<CredentialInsertResult>
  getCredential(credentialId: string): Promise<StoredCredential | undefined>
  /** Returns the one non-revoked credential bound to a workspace connector, if any. */
  findCredentialByConnector(
    workspaceId: string,
    connectorRef: string
  ): Promise<StoredCredential | undefined>
  /** Workspace-scoped page ordered by credential ID. */
  listCredentials(
    workspaceId: string,
    page: { readonly afterCredentialId?: string; readonly limit: number }
  ): Promise<readonly StoredCredential[]>
  /**
   * Compare-and-set on `(revision, status)`. With `revokeActiveLeases`, every active lease of the
   * credential becomes `revoked` in the same atomic write.
   */
  updateCredential(
    next: StoredCredential,
    expected: { readonly revision: number; readonly status: PersistedCredentialStatus },
    options?: {
      readonly revokeActiveLeases?: boolean
      readonly receipt?: CredentialCommandReceiptInput
    }
  ): Promise<CredentialUpdateResult>
  getCommandReceipt(scope: CredentialCommandScope): Promise<CredentialCommandReceipt | undefined>
  insertLease(lease: CredentialLease): Promise<boolean>
  getLease(capabilityRef: string): Promise<CredentialLease | undefined>
  /** Compare-and-set from `active`; returns false when another use already transitioned it. */
  transitionLease(next: CredentialLease): Promise<boolean>
  appendAudit(event: CredentialAuditEventInput): Promise<void>
  listAudit(filter: {
    readonly workspaceId?: string
    readonly credentialId?: string
  }): Promise<readonly CredentialAuditEvent[]>
}

export function credentialCommandKey(scope: CredentialCommandScope): string {
  return JSON.stringify([scope.workspaceId, scope.callerId, scope.operation, scope.idempotencyKey])
}

/** Process-local reference implementation used by tests and ephemeral compositions. */
export class InMemoryCredentialVaultRepository implements CredentialVaultRepository {
  readonly #credentials = new Map<string, StoredCredential>()
  readonly #leases = new Map<string, CredentialLease>()
  readonly #receipts = new Map<string, CredentialCommandReceipt>()
  readonly #audit: CredentialAuditEvent[] = []

  async insertCredential(
    input: StoredCredential,
    receipt?: CredentialCommandReceiptInput
  ): Promise<CredentialInsertResult> {
    const credential = StoredCredentialSchema.parse(input)
    const parsedReceipt =
      receipt === undefined ? undefined : CredentialCommandReceiptSchema.parse(receipt)
    if (parsedReceipt && this.#receipts.has(credentialCommandKey(parsedReceipt))) {
      return 'receipt_exists'
    }
    if (this.#credentials.has(credential.metadata.credentialId)) return 'credential_exists'
    if (
      credential.metadata.status !== 'revoked' &&
      (await this.findCredentialByConnector(
        credential.metadata.workspaceId,
        credential.metadata.connectorRef
      ))
    ) {
      return 'connector_in_use'
    }
    this.#credentials.set(credential.metadata.credentialId, structuredClone(credential))
    if (parsedReceipt) this.#receipts.set(credentialCommandKey(parsedReceipt), parsedReceipt)
    return 'inserted'
  }

  async getCredential(credentialId: string): Promise<StoredCredential | undefined> {
    const credential = this.#credentials.get(credentialId)
    return credential === undefined ? undefined : structuredClone(credential)
  }

  async findCredentialByConnector(
    workspaceId: string,
    connectorRef: string
  ): Promise<StoredCredential | undefined> {
    for (const credential of this.#credentials.values()) {
      if (
        credential.metadata.workspaceId === workspaceId &&
        credential.metadata.connectorRef === connectorRef &&
        credential.metadata.status !== 'revoked'
      ) {
        return structuredClone(credential)
      }
    }
    return undefined
  }

  async listCredentials(
    workspaceId: string,
    page: { readonly afterCredentialId?: string; readonly limit: number }
  ): Promise<readonly StoredCredential[]> {
    return [...this.#credentials.values()]
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
      .map((credential) => structuredClone(credential))
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
    if (receipt && this.#receipts.has(credentialCommandKey(receipt))) return 'receipt_exists'
    const current = this.#credentials.get(next.metadata.credentialId)
    if (
      current === undefined ||
      current.metadata.revision !== expected.revision ||
      current.metadata.status !== expected.status ||
      current.metadata.workspaceId !== next.metadata.workspaceId
    ) {
      return 'conflict'
    }
    this.#credentials.set(next.metadata.credentialId, structuredClone(next))
    if (options.revokeActiveLeases === true) {
      for (const [capabilityRef, lease] of this.#leases) {
        if (lease.credentialId === next.metadata.credentialId && lease.status === 'active') {
          this.#leases.set(capabilityRef, { ...lease, status: 'revoked' })
        }
      }
    }
    if (receipt) this.#receipts.set(credentialCommandKey(receipt), receipt)
    return 'updated'
  }

  async getCommandReceipt(
    scope: CredentialCommandScope
  ): Promise<CredentialCommandReceipt | undefined> {
    const receipt = this.#receipts.get(credentialCommandKey(scope))
    return receipt === undefined ? undefined : structuredClone(receipt)
  }

  async insertLease(input: CredentialLease): Promise<boolean> {
    const lease = CredentialLeaseSchema.parse(input)
    for (const existing of this.#leases.values()) {
      if (existing.credentialLeaseId === lease.credentialLeaseId) return false
    }
    if (this.#leases.has(lease.capabilityRef)) return false
    this.#leases.set(lease.capabilityRef, structuredClone(lease))
    return true
  }

  async getLease(capabilityRef: string): Promise<CredentialLease | undefined> {
    const lease = this.#leases.get(capabilityRef)
    return lease === undefined ? undefined : structuredClone(lease)
  }

  async transitionLease(input: CredentialLease): Promise<boolean> {
    const next = CredentialLeaseSchema.parse(input)
    const current = this.#leases.get(next.capabilityRef)
    if (current === undefined || current.status !== 'active') return false
    this.#leases.set(next.capabilityRef, structuredClone(next))
    return true
  }

  async appendAudit(event: CredentialAuditEventInput): Promise<void> {
    this.#audit.push(CredentialAuditEventSchema.parse(event))
  }

  async listAudit(
    filter: { readonly workspaceId?: string; readonly credentialId?: string } = {}
  ): Promise<readonly CredentialAuditEvent[]> {
    return this.#audit
      .filter(
        (event) =>
          (filter.workspaceId === undefined || event.workspaceId === filter.workspaceId) &&
          (filter.credentialId === undefined || event.credentialId === filter.credentialId)
      )
      .map((event) => structuredClone(event))
  }
}
