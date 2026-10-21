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
    readonly expectedCredentialRevision?: number
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
    if (
      input.expectedCredentialRevision !== undefined &&
      input.expectedCredentialRevision !== metadata.revision
    )
      fail('CREDENTIAL_REVISION_CONFLICT')
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
    const effective = this.#effective(credential.metadata)
    if (effective.status === 'revoked') fail('CREDENTIAL_REVOKED')
    if (effective.status === 'expired') fail('CREDENTIAL_EXPIRED')
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
      // Fail closed: a result that carries the secret, or that cannot be proven
      // not to carry it, never leaves the vault.
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

/**
 * Outcome of inspecting one value for secret material.
 *
 * - `absent`: the value was inspected completely and does not carry the secret.
 * - `present`: the secret was found.
 * - `unverifiable`: the value's shape cannot be inspected without running
 *   caller-controlled code, so the vault cannot prove that it is secret-free.
 */
type SecretPresence = 'absent' | 'present' | 'unverifiable'

/** Bounds the inspection so a hostile or accidental structure cannot stall a lease. */
const MAXIMUM_INSPECTED_NODES = 100_000
const MAXIMUM_INSPECTION_DEPTH = 64

/**
 * Bounds for binary containers. Their own properties can only be listed by
 * walking every element, so a container larger than this is rejected rather
 * than inspected.
 */
const MAXIMUM_BINARY_BYTES = 65_536

/**
 * Reads an intrinsic accessor without running caller-defined code. The
 * accessors are captured once, from the built-in prototypes, so a subclass that
 * overrides `buffer`, `byteOffset`, or `byteLength` never runs.
 */
function intrinsicGetter(prototype: object, name: string): (() => unknown) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
  return descriptor && typeof descriptor.get === 'function'
    ? (descriptor.get as () => unknown)
    : undefined
}

/** Calls an intrinsic accessor; a shape that does not match yields undefined. */
function callIntrinsic(getter: (() => unknown) | undefined, receiver: unknown): unknown {
  if (getter === undefined) return undefined
  try {
    return getter.call(receiver)
  } catch {
    return undefined
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArrayBuffer = intrinsicGetter(typedArrayPrototype, 'buffer')
const typedArrayByteOffset = intrinsicGetter(typedArrayPrototype, 'byteOffset')
const typedArrayByteLength = intrinsicGetter(typedArrayPrototype, 'byteLength')
const typedArrayLength = intrinsicGetter(typedArrayPrototype, 'length')
const dataViewBuffer = intrinsicGetter(DataView.prototype, 'buffer')
const dataViewByteOffset = intrinsicGetter(DataView.prototype, 'byteOffset')
const dataViewByteLength = intrinsicGetter(DataView.prototype, 'byteLength')
const arrayBufferByteLength = intrinsicGetter(ArrayBuffer.prototype, 'byteLength')
const sharedArrayBufferByteLength =
  typeof SharedArrayBuffer === 'undefined'
    ? undefined
    : intrinsicGetter(SharedArrayBuffer.prototype, 'byteLength')
const mapSize = intrinsicGetter(Map.prototype, 'size')
const setSize = intrinsicGetter(Set.prototype, 'size')

/**
 * True when `value` carries `secret`, and also when `value` cannot be proven
 * not to carry it.
 *
 * Every caller must read `true` as "this value must not leave the vault", so an
 * uninspectable value fails closed. The inspection reads own property
 * descriptors and intrinsic accessors, so it never invokes a getter, a
 * `toString`, or any other caller-defined code, and it understands the
 * containers a callback may realistically return: plain objects and arrays,
 * `Error`, `Map`, `Set`, `Buffer`, typed arrays, and `ArrayBuffer`.
 *
 * The guarantee is about a result's own contents and is bounded: a traversal
 * visits at most {@link MAXIMUM_INSPECTED_NODES} values and
 * {@link MAXIMUM_INSPECTION_DEPTH} levels, and a binary container larger than
 * {@link MAXIMUM_BINARY_BYTES} is rejected rather than inspected. This is not a
 * sandbox for hostile JavaScript: reading a prototype can still run a proxy's
 * `getPrototypeOf` trap, so a result that fabricates values through a proxy is
 * outside the guarantee, and such an operation already holds the secret.
 */
export function containsSecret(value: unknown, secret: string): boolean {
  return secretPresence(value, secret) !== 'absent'
}

function secretPresence(value: unknown, secret: string): SecretPresence {
  const seen = new Set<object>()
  const secretBytes = Buffer.from(secret, 'utf8')
  let nodes = 0

  const visit = (input: unknown, depth: number): SecretPresence => {
    nodes += 1
    if (nodes > MAXIMUM_INSPECTED_NODES) return 'unverifiable'
    if (typeof input === 'string') return input.includes(secret) ? 'present' : 'absent'
    if (typeof input === 'symbol') {
      const description = input.description ?? ''
      return description.includes(secret) ? 'present' : 'absent'
    }
    if (input === null || input === undefined) return 'absent'
    if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
      return 'absent'
    }
    // A function can close over the secret without exposing it as a property.
    if (typeof input === 'function') return 'unverifiable'
    if (typeof input !== 'object') return 'absent'
    if (depth > MAXIMUM_INSPECTION_DEPTH) return 'unverifiable'
    // A cycle is outside the inspectable representation; fail closed instead
    // of recursing without bound.
    if (seen.has(input)) return 'unverifiable'

    seen.add(input)
    try {
      if (Array.isArray(input)) return inspectOwnProperties(input, secret, visit, depth)
      // The `size` accessors are intrinsic, so they identify a genuine Map or
      // Set without running a proxy's traps.
      if (callIntrinsic(mapSize, input) !== undefined) {
        return inspectMap(input as Map<unknown, unknown>, secret, visit, depth)
      }
      if (callIntrinsic(setSize, input) !== undefined) {
        return inspectSet(input as Set<unknown>, secret, visit, depth)
      }
      const binary = binaryShape(input)
      if (binary !== undefined) {
        // A binary container above the enumeration bound is rejected rather than
        // inspected: its own properties can only be listed by walking every
        // element, which is not bounded work.
        if (binary.bytes.byteLength > MAXIMUM_BINARY_BYTES) return 'unverifiable'
        if (containsBytes(binary.bytes, secretBytes)) return 'present'
        return inspectOwnProperties(input, secret, visit, depth, (key) =>
          isElementSlot(key, binary.elementCount)
        )
      }
      const prototype = Object.getPrototypeOf(input)
      if (prototype === Object.prototype || prototype === null) {
        return inspectOwnProperties(input, secret, visit, depth)
      }
      // An error carries its message, stack, and cause as own properties, so it
      // is inspected like a plain object even though its prototype is not one.
      if (hasErrorPrototype(prototype)) {
        return inspectOwnProperties(input, secret, visit, depth)
      }
      // A class instance or an exotic object: its contents cannot be read
      // without running caller-controlled code.
      return 'unverifiable'
    } finally {
      seen.delete(input)
    }
  }

  try {
    return visit(value, 0)
  } catch {
    // Reading the value failed, so the secret cannot be ruled out.
    return 'unverifiable'
  }
}

/**
 * Inspects own properties without invoking accessors. A property whose value
 * cannot be read without running caller code makes the whole value
 * unverifiable rather than being skipped. A symbol key's own description is
 * inspected too, because a key can carry the secret as well.
 */
function inspectOwnProperties(
  input: object,
  secret: string,
  visit: (value: unknown, depth: number) => SecretPresence,
  depth: number,
  skip?: (key: string) => boolean
): SecretPresence {
  for (const key of Object.getOwnPropertyNames(input)) {
    if (skip?.(key) === true) continue
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor) continue
    if (!('value' in descriptor)) return 'unverifiable'
    // The name itself is material: a property can be named after the secret.
    if (key.includes(secret)) return 'present'
    if (sensitiveKey.test(key)) return 'present'
    const presence = visit(descriptor.value, depth + 1)
    if (presence !== 'absent') return presence
  }
  for (const symbol of Object.getOwnPropertySymbols(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, symbol)
    if (!descriptor) continue
    if (!('value' in descriptor)) return 'unverifiable'
    // The key itself is material: a symbol description can name the secret.
    if (symbol.description?.includes(secret) === true) return 'present'
    const presence = visit(descriptor.value, depth + 1)
    if (presence !== 'absent') return presence
  }
  return 'absent'
}

function inspectMap(
  input: Map<unknown, unknown>,
  secret: string,
  visit: (value: unknown, depth: number) => SecretPresence,
  depth: number
): SecretPresence {
  // `Map.prototype.entries` is called directly so a proxy cannot run its traps.
  for (const [key, value] of Map.prototype.entries.call(input)) {
    if (typeof key === 'string' && sensitiveKey.test(key)) return 'present'
    const keyPresence = visit(key, depth + 1)
    if (keyPresence !== 'absent') return keyPresence
    const valuePresence = visit(value, depth + 1)
    if (valuePresence !== 'absent') return valuePresence
  }
  // A Map may also carry own properties beside its entries.
  return inspectOwnProperties(input, secret, visit, depth)
}

function inspectSet(
  input: Set<unknown>,
  secret: string,
  visit: (value: unknown, depth: number) => SecretPresence,
  depth: number
): SecretPresence {
  for (const value of Set.prototype.values.call(input)) {
    const presence = visit(value, depth + 1)
    if (presence !== 'absent') return presence
  }
  // A Set may also carry own properties beside its values.
  return inspectOwnProperties(input, secret, visit, depth)
}

/**
 * The bytes of a binary container, read through intrinsic accessors only, so a
 * subclass that overrides `buffer`, `byteOffset`, or `byteLength` never runs. A
 * shape that cannot be read that way yields undefined and fails closed.
 */
function binaryShape(
  input: object
): { readonly bytes: Uint8Array; readonly elementCount: number } | undefined {
  if (ArrayBuffer.isView(input)) {
    const dataViewLength = callIntrinsic(dataViewByteLength, input) as number | undefined
    if (dataViewLength !== undefined) {
      const byteOffset = callIntrinsic(dataViewByteOffset, input) as number | undefined
      const buffer = callIntrinsic(dataViewBuffer, input) as ArrayBufferLike | undefined
      if (byteOffset === undefined || buffer === undefined) return undefined
      return { bytes: byteView(buffer, byteOffset, dataViewLength), elementCount: 0 }
    }
    const byteLength = callIntrinsic(typedArrayByteLength, input) as number | undefined
    if (byteLength === undefined) return undefined
    const byteOffset = callIntrinsic(typedArrayByteOffset, input) as number | undefined
    const buffer = callIntrinsic(typedArrayBuffer, input) as ArrayBufferLike | undefined
    const length = callIntrinsic(typedArrayLength, input) as number | undefined
    if (byteOffset === undefined || buffer === undefined || length === undefined) return undefined
    return { bytes: byteView(buffer, byteOffset, byteLength), elementCount: length }
  }
  // The `byteLength` accessor only answers for a genuine buffer, so it is the
  // type test as well as the measurement.
  if (callIntrinsic(arrayBufferByteLength, input) !== undefined) {
    return { bytes: new Uint8Array(input as ArrayBuffer), elementCount: 0 }
  }
  if (callIntrinsic(sharedArrayBufferByteLength, input) !== undefined) {
    return { bytes: new Uint8Array(input as SharedArrayBuffer), elementCount: 0 }
  }
  return undefined
}

/** True for a key that names an element slot rather than a user-added property. */
function isElementSlot(key: string, elementCount: number): boolean {
  if (!/^(0|[1-9]\d*)$/u.test(key)) return false
  return Number(key) < elementCount
}

/**
 * True when the prototype chain reaches `Error.prototype`, so an error and an
 * error subclass are both recognised. The walk is bounded.
 */
function hasErrorPrototype(prototype: object | null): boolean {
  let current = prototype
  for (let depth = 0; current !== null && depth < 16; depth += 1) {
    if (current === Error.prototype) return true
    current = Object.getPrototypeOf(current) as object | null
  }
  return false
}

/**
 * A byte view over a buffer. A shared buffer is accepted at runtime; the
 * library types are narrower than the runtime behaviour.
 */
function byteView(buffer: ArrayBufferLike, byteOffset: number, byteLength: number): Uint8Array {
  return new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength)
}

/** Byte-exact search, so binary material is matched without decoding it. */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true
  if (needle.length > haystack.length) return false
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer
    }
    return true
  }
  return false
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
