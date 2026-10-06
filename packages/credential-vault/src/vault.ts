import { createHash, randomBytes } from 'node:crypto'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  PolicyDecisionSchema,
  type PolicyDecisionPoint,
  type PolicySnapshotReference,
} from '@control-plane/policy'
import { z } from 'zod'
import {
  CredentialLeaseSchema,
  CredentialMetadataSchema,
  InMemoryCredentialVaultRepository,
  StoredCredentialSchema,
  type CredentialAuditEvent,
  type CredentialCommandReceiptInput,
  type CredentialLease,
  type CredentialMetadata,
  type CredentialVaultRepository,
  type EncryptedSecretReference,
  type StoredCredential,
} from './repository.js'

const TimestampSchema = z.iso.datetime()
const maximumCredentialLeaseClockSkewMs = 30_000
export const MAXIMUM_CREDENTIAL_LEASE_TTL_MS = 300_000
export const MINIMUM_SECRET_LENGTH = 8
export const MAXIMUM_SECRET_LENGTH = 65_536

export interface SecretProvider {
  store(input: {
    readonly credentialId: string
    readonly revision: number
    readonly secret: string
  }): Promise<EncryptedSecretReference>
  resolve(reference: EncryptedSecretReference): Promise<string>
  revoke(reference: EncryptedSecretReference): Promise<void>
}

export type CredentialVaultErrorCode =
  | 'CREDENTIAL_MISSING'
  | 'CREDENTIAL_EXISTS'
  | 'CREDENTIAL_CONNECTOR_IN_USE'
  | 'CREDENTIAL_REVISION_CONFLICT'
  | 'CREDENTIAL_REVOKED'
  | 'CREDENTIAL_EXPIRED'
  | 'CREDENTIAL_SECRET_REQUIRED'
  | 'CREDENTIAL_SECRET_INVALID'
  | 'CREDENTIAL_COMMAND_REPLAYED'
  | 'LEASE_MISSING'
  | 'LEASE_CONFLICT'
  | 'LEASE_EXPIRED'
  | 'LEASE_REVOKED'
  | 'LEASE_CONSUMED'
  | 'LEASE_SCOPE_MISMATCH'
  | 'POLICY_DENIED'
  | 'SECRET_EGRESS_BLOCKED'
  | 'PROVIDER_OPERATION_FAILED'

/** Bounded error. The message is the code; it never carries secret material or provider text. */
export class CredentialVaultError extends Error {
  constructor(readonly code: CredentialVaultErrorCode) {
    super(code)
    this.name = 'CredentialVaultError'
  }
}

export interface CredentialCommandBinding {
  /** Receipt written atomically with the state change; its payload hash excludes the secret. */
  readonly receipt: Omit<CredentialCommandReceiptInput, 'result'>
}

export class CredentialVault {
  readonly #provider: SecretProvider
  readonly #decisionPoint: PolicyDecisionPoint | undefined
  readonly #repository: CredentialVaultRepository
  readonly #now: () => string

  constructor(options: {
    readonly provider: SecretProvider
    /** Absent in compositions that never lease (for example the Control API); leases then deny. */
    readonly decisionPoint?: PolicyDecisionPoint
    readonly repository?: CredentialVaultRepository
    readonly now?: () => string
  }) {
    this.#provider = options.provider
    this.#decisionPoint = options.decisionPoint
    this.#repository = options.repository ?? new InMemoryCredentialVaultRepository()
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async create(input: {
    readonly credentialId: string
    readonly workspaceId: string
    readonly connectorRef: string
    readonly provider: string
    readonly secret: string
    readonly createdAt: string
    readonly createdBy?: string
    readonly expiresAt?: string
    readonly command?: CredentialCommandBinding
  }): Promise<CredentialMetadata> {
    const credentialId = IdentifierSchemas.credentialId.parse(input.credentialId)
    assertSecret(input.secret)
    const metadata = CredentialMetadataSchema.parse({
      credentialId,
      workspaceId: input.workspaceId,
      connectorRef: input.connectorRef,
      provider: input.provider,
      status: 'active',
      revision: 1,
      createdAt: input.createdAt,
      ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    })
    if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.parse(this.#now())) {
      fail('CREDENTIAL_EXPIRED')
    }
    if (await this.#repository.getCredential(credentialId)) fail('CREDENTIAL_EXISTS')
    if (
      await this.#repository.findCredentialByConnector(metadata.workspaceId, metadata.connectorRef)
    )
      fail('CREDENTIAL_CONNECTOR_IN_USE')
    const reference = await this.#storeSecret(credentialId, 1, input.secret)
    const stored = StoredCredentialSchema.parse({
      metadata,
      secretRevisions: [{ revision: 1, reference }],
    })
    const result = await this.#repository.insertCredential(
      stored,
      input.command === undefined ? undefined : { ...input.command.receipt, result: metadata }
    )
    if (result !== 'inserted') {
      // The secret was never bound to durable metadata; remove it before reporting.
      await this.#discardSecret(reference)
      fail(
        result === 'credential_exists'
          ? 'CREDENTIAL_EXISTS'
          : result === 'connector_in_use'
            ? 'CREDENTIAL_CONNECTOR_IN_USE'
            : 'CREDENTIAL_COMMAND_REPLAYED'
      )
    }
    await this.#record('credential.created', metadata, { principalRef: metadata.createdBy })
    return clone(metadata)
  }

  /**
   * Reads public metadata. With `workspaceId`, a credential owned by another workspace is
   * reported as missing so existence does not leak across workspaces.
   */
  async metadata(credentialId: string, workspaceId?: string): Promise<CredentialMetadata> {
    return this.#effective((await this.#credential(credentialId, workspaceId)).metadata)
  }

  /** Workspace-scoped page ordered by credential ID; `nextCredentialId` continues it. */
  async list(
    workspaceId: string,
    page: { readonly afterCredentialId?: string; readonly limit: number }
  ): Promise<{
    readonly credentials: readonly CredentialMetadata[]
    readonly nextCredentialId?: string
  }> {
    const scope = IdentifierSchemas.workspaceId.parse(workspaceId)
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) {
      throw new RangeError('CREDENTIAL_PAGE_LIMIT_INVALID')
    }
    const after =
      page.afterCredentialId === undefined
        ? undefined
        : IdentifierSchemas.credentialId.parse(page.afterCredentialId)
    const records = (
      await this.#repository.listCredentials(scope, {
        ...(after === undefined ? {} : { afterCredentialId: after }),
        limit: page.limit + 1,
      })
    ).filter((record) => record.metadata.workspaceId === scope)
    const credentials = records
      .slice(0, page.limit)
      .map((record) => this.#effective(record.metadata))
    const last = credentials.at(-1)
    return records.length > page.limit && last !== undefined
      ? { credentials, nextCredentialId: last.credentialId }
      : { credentials }
  }

  /** Finds the non-revoked credential bound to a workspace connector. */
  async findByConnector(
    workspaceId: string,
    connectorRef: string
  ): Promise<CredentialMetadata | undefined> {
    const record = await this.#repository.findCredentialByConnector(
      IdentifierSchemas.workspaceId.parse(workspaceId),
      connectorRef
    )
    if (!record || record.metadata.workspaceId !== workspaceId) return undefined
    return this.#effective(record.metadata)
  }

  async rotate(
    credentialId: string,
    secret: string,
    principalRef: string,
    options: {
      readonly workspaceId?: string
      readonly expectedRevision?: number
      readonly command?: CredentialCommandBinding
    } = {}
  ): Promise<CredentialMetadata> {
    const record = await this.#credential(credentialId, options.workspaceId)
    const current = this.#effective(record.metadata)
    if (current.status === 'revoked') fail('CREDENTIAL_REVOKED')
    if (current.status === 'expired') fail('CREDENTIAL_EXPIRED')
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      fail('CREDENTIAL_REVISION_CONFLICT')
    }
    assertSecret(secret)
    const revision = record.metadata.revision + 1
    const reference = await this.#storeSecret(record.metadata.credentialId, revision, secret)
    const metadata = CredentialMetadataSchema.parse({
      ...record.metadata,
      status: 'active',
      revision,
      rotatedAt: this.#now(),
    })
    const next = StoredCredentialSchema.parse({
      metadata,
      // Earlier revisions stay resolvable for leases pinned before this rotation.
      secretRevisions: [...record.secretRevisions, { revision, reference }],
    })
    const result = await this.#repository.updateCredential(
      next,
      { revision: record.metadata.revision, status: record.metadata.status },
      options.command === undefined
        ? {}
        : { receipt: { ...options.command.receipt, result: metadata } }
    )
    if (result !== 'updated') {
      await this.#discardSecret(reference)
      fail(result === 'conflict' ? 'CREDENTIAL_REVISION_CONFLICT' : 'CREDENTIAL_COMMAND_REPLAYED')
    }
    await this.#record('credential.rotated', metadata, { principalRef })
    return clone(metadata)
  }

  async revoke(
    credentialId: string,
    principalRef: string,
    options: { readonly workspaceId?: string } = {}
  ): Promise<CredentialMetadata> {
    let record = await this.#credential(credentialId, options.workspaceId)
    for (let attempt = 0; record.metadata.status !== 'revoked'; attempt += 1) {
      // A concurrent rotation may win the compare-and-set; re-read and revoke the newer state.
      if (attempt >= 3) fail('CREDENTIAL_REVISION_CONFLICT')
      const metadata = CredentialMetadataSchema.parse({
        ...record.metadata,
        status: 'revoked',
        revokedAt: this.#now(),
      })
      const next = StoredCredentialSchema.parse({ ...record, metadata })
      const result = await this.#repository.updateCredential(
        next,
        { revision: record.metadata.revision, status: record.metadata.status },
        { revokeActiveLeases: true }
      )
      if (result === 'updated') {
        record = next
        await this.#record('credential.revoked', metadata, { principalRef })
        break
      }
      record = await this.#credential(credentialId, options.workspaceId)
    }
    // Retried revocations repeat the idempotent provider deletes until every revision is gone.
    let providerFailed = false
    for (const { reference } of record.secretRevisions) {
      try {
        await this.#provider.revoke(reference)
      } catch {
        providerFailed = true
      }
    }
    if (providerFailed) fail('PROVIDER_OPERATION_FAILED')
    return this.#effective(record.metadata)
  }

  async lease(input: {
    readonly credentialLeaseId: string
    readonly credentialId: string
    readonly requestId: string
    readonly workspaceId: string
    readonly principalRef: string
    readonly operation: string
    readonly resourceRef: string
    readonly requestedAt: string
    readonly expiresAt: string
    readonly policySnapshot: PolicySnapshotReference
  }): Promise<CredentialLease> {
    const leaseId = IdentifierSchemas.credentialLeaseId.parse(input.credentialLeaseId)
    const record = await this.#credential(input.credentialId)
    const metadata = this.#effective(record.metadata)
    if (metadata.status === 'revoked') fail('CREDENTIAL_REVOKED')
    if (metadata.status === 'expired') fail('CREDENTIAL_EXPIRED')
    if (metadata.status === 'secret_required') fail('CREDENTIAL_SECRET_REQUIRED')
    if (metadata.workspaceId !== input.workspaceId) fail('LEASE_SCOPE_MISMATCH')
    const issuedAt = TimestampSchema.parse(this.#now())
    const requestedAt = TimestampSchema.parse(input.requestedAt)
    const expiresAt = TimestampSchema.parse(input.expiresAt)
    const issuedAtMilliseconds = Date.parse(issuedAt)
    const requestClockSkew = Math.abs(Date.parse(requestedAt) - issuedAtMilliseconds)
    const ttl = Date.parse(expiresAt) - issuedAtMilliseconds
    if (
      requestClockSkew > maximumCredentialLeaseClockSkewMs ||
      ttl <= 0 ||
      ttl > MAXIMUM_CREDENTIAL_LEASE_TTL_MS
    ) {
      fail('LEASE_EXPIRED')
    }
    if (metadata.expiresAt && Date.parse(expiresAt) > Date.parse(metadata.expiresAt)) {
      fail('LEASE_EXPIRED')
    }
    if (this.#decisionPoint === undefined) {
      await this.#record('lease.denied', metadata, {
        credentialLeaseId: leaseId,
        reasonCode: 'POLICY_DECISION_POINT_UNAVAILABLE',
      })
      fail('POLICY_DENIED')
    }
    let decision: z.output<typeof PolicyDecisionSchema>
    try {
      decision = PolicyDecisionSchema.parse(
        await this.#decisionPoint.authorize({
          requestId: IdentifierSchemas.requestId.parse(input.requestId),
          principal: {
            type: 'service',
            id: input.principalRef,
            workspaceId: metadata.workspaceId,
          },
          action: 'credential:lease',
          resource: {
            type: 'credential',
            id: metadata.credentialId,
            workspaceId: metadata.workspaceId,
            attributes: {
              connectorRef: metadata.connectorRef,
              provider: metadata.provider,
              revision: metadata.revision,
              operation: input.operation,
              resourceRef: input.resourceRef,
            },
          },
          context: { workspaceId: metadata.workspaceId, requestedAt: issuedAt },
          policySnapshot: input.policySnapshot,
        })
      )
    } catch {
      await this.#record('lease.denied', metadata, {
        credentialLeaseId: leaseId,
        reasonCode: 'POLICY_EVALUATOR_FAILED',
      })
      fail('POLICY_DENIED')
    }
    if (decision.effect !== 'allow') {
      await this.#record('lease.denied', metadata, {
        credentialLeaseId: leaseId,
        reasonCode: decision.reasonCode,
      })
      fail('POLICY_DENIED')
    }
    if (!record.secretRevisions.some(({ revision }) => revision === metadata.revision)) {
      fail('CREDENTIAL_MISSING')
    }
    const lease = CredentialLeaseSchema.parse({
      credentialLeaseId: leaseId,
      credentialId: metadata.credentialId,
      credentialRevision: metadata.revision,
      workspaceId: metadata.workspaceId,
      principalRef: input.principalRef,
      operation: input.operation,
      resourceRef: input.resourceRef,
      capabilityRef: `lease://${leaseId}/${hash({ leaseId, decisionId: decision.decisionId, expiresAt })}`,
      status: 'active',
      policySnapshot: decision.policySnapshot,
      policyDecisionId: decision.decisionId,
      issuedAt,
      expiresAt,
    })
    if (!(await this.#repository.insertLease(lease))) fail('LEASE_CONFLICT')
    await this.#record('lease.issued', metadata, { credentialLeaseId: leaseId })
    return clone(lease)
  }

  /**
   * Resolves the lease's pinned secret revision exactly once and hands it to `operation`.
   * The lease is consumed before decryption, so a failed or replayed use cannot decrypt again.
   */
  async use<Result>(
    capabilityRef: string,
    scope: {
      readonly workspaceId: string
      readonly operation: string
      readonly resourceRef: string
    },
    operation: (secret: string) => Result | Promise<Result>
  ): Promise<Result> {
    const lease = await this.#repository.getLease(capabilityRef)
    if (!lease) fail('LEASE_MISSING')
    if (lease.status === 'revoked') fail('LEASE_REVOKED')
    if (lease.status === 'consumed') fail('LEASE_CONSUMED')
    const now = this.#now()
    if (lease.status === 'expired' || Date.parse(lease.expiresAt) <= Date.parse(now)) {
      if (lease.status === 'active') {
        await this.#repository.transitionLease(
          CredentialLeaseSchema.parse({ ...lease, status: 'expired' })
        )
      }
      fail('LEASE_EXPIRED')
    }
    const credential = await this.#credential(lease.credentialId)
    if (credential.metadata.status === 'revoked') fail('CREDENTIAL_REVOKED')
    if (
      lease.workspaceId !== scope.workspaceId ||
      credential.metadata.workspaceId !== scope.workspaceId ||
      lease.operation !== scope.operation ||
      lease.resourceRef !== scope.resourceRef
    ) {
      fail('LEASE_SCOPE_MISMATCH')
    }
    const consumed = CredentialLeaseSchema.parse({ ...lease, status: 'consumed', consumedAt: now })
    if (!(await this.#repository.transitionLease(consumed))) {
      const latest = await this.#repository.getLease(capabilityRef)
      fail(
        latest?.status === 'revoked'
          ? 'LEASE_REVOKED'
          : latest?.status === 'expired'
            ? 'LEASE_EXPIRED'
            : 'LEASE_CONSUMED'
      )
    }
    const pinned = credential.secretRevisions.find(
      ({ revision }) => revision === lease.credentialRevision
    )
    if (!pinned) fail('CREDENTIAL_MISSING')
    let secret: string
    try {
      secret = await this.#provider.resolve(pinned.reference)
    } catch {
      fail('PROVIDER_OPERATION_FAILED')
    }
    try {
      const result = await operation(secret)
      if (containsSecret(result, secret)) fail('SECRET_EGRESS_BLOCKED')
      await this.#record('lease.used', credential.metadata, {
        credentialLeaseId: lease.credentialLeaseId,
      })
      return result
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error
      fail('PROVIDER_OPERATION_FAILED')
    }
  }

  async audit(
    filter: { readonly workspaceId?: string; readonly credentialId?: string } = {}
  ): Promise<readonly CredentialAuditEvent[]> {
    return this.#repository.listAudit(filter)
  }

  async #credential(credentialId: string, workspaceId?: string): Promise<StoredCredential> {
    const parsed = IdentifierSchemas.credentialId.safeParse(credentialId)
    if (!parsed.success) fail('CREDENTIAL_MISSING')
    const record = await this.#repository.getCredential(parsed.data)
    if (!record) fail('CREDENTIAL_MISSING')
    if (workspaceId !== undefined && record.metadata.workspaceId !== workspaceId) {
      fail('CREDENTIAL_MISSING')
    }
    return record
  }

  #effective(metadata: CredentialMetadata): CredentialMetadata {
    if (
      metadata.status === 'active' &&
      metadata.expiresAt &&
      Date.parse(metadata.expiresAt) <= Date.parse(this.#now())
    ) {
      return CredentialMetadataSchema.parse({ ...metadata, status: 'expired' })
    }
    return clone(metadata)
  }

  async #storeSecret(credentialId: string, revision: number, secret: string) {
    try {
      return await this.#provider.store({ credentialId, revision, secret })
    } catch {
      fail('PROVIDER_OPERATION_FAILED')
    }
  }

  async #discardSecret(reference: EncryptedSecretReference): Promise<void> {
    try {
      await this.#provider.revoke(reference)
    } catch {
      // The orphaned ciphertext is unreachable without durable metadata; report the original error.
    }
  }

  async #record(
    action: CredentialAuditEvent['action'],
    metadata: CredentialMetadata,
    detail: {
      readonly credentialLeaseId?: string | undefined
      readonly reasonCode?: string | undefined
      readonly principalRef?: string | undefined
    } = {}
  ): Promise<void> {
    await this.#repository.appendAudit({
      action,
      credentialId: metadata.credentialId,
      ...(detail.credentialLeaseId === undefined
        ? {}
        : { credentialLeaseId: detail.credentialLeaseId }),
      workspaceId: metadata.workspaceId,
      revision: metadata.revision,
      ...(detail.principalRef === undefined ? {} : { principalRef: detail.principalRef }),
      ...(detail.reasonCode === undefined ? {} : { reasonCode: detail.reasonCode }),
      at: this.#now(),
    })
  }
}

function assertSecret(secret: unknown): asserts secret is string {
  if (
    typeof secret !== 'string' ||
    secret.length < MINIMUM_SECRET_LENGTH ||
    secret.length > MAXIMUM_SECRET_LENGTH
  ) {
    fail('CREDENTIAL_SECRET_INVALID')
  }
}

const sensitiveKey =
  /^(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|token)$/i

export function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret)
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secret))
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, entry]) => sensitiveKey.test(key) || containsSecret(entry, secret)
  )
}

export function hash(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return createHash('sha256').update(serialized).digest('hex')
}

const crockfordAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function opaqueSuffix(): string {
  let value = BigInt(`0x${randomBytes(16).toString('hex')}`)
  let encoded = ''
  for (let index = 0; index < 26; index += 1) {
    encoded = crockfordAlphabet[Number(value & 31n)] + encoded
    value >>= 5n
  }
  return encoded
}

/** Random, server-generated credential identifier. */
export function createCredentialId(): string {
  return IdentifierSchemas.credentialId.parse(`crd_${opaqueSuffix()}`)
}

/** Random, server-generated credential lease identifier. */
export function createCredentialLeaseId(): string {
  return IdentifierSchemas.credentialLeaseId.parse(`crl_${opaqueSuffix()}`)
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function fail(code: CredentialVaultErrorCode): never {
  throw new CredentialVaultError(code)
}
