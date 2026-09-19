import { Effect } from 'effect'
import { IdentifierSchemas } from '@control-plane/contracts'
import { PolicyDecisionSchema, type PolicySnapshotReference } from '@control-plane/policy'
import type { CredentialAuditEvent, EncryptedSecretReference } from '../index.js'
import { VaultConfig } from './config.js'
import {
  CallbackRejection,
  CredentialExists,
  CredentialExpired,
  CredentialMissing,
  CredentialRevoked,
  CredentialVaultError,
  IllegalLeaseTransition,
  LeaseConflict,
  LeaseConsumed,
  LeaseExpired,
  LeaseMissing,
  LeaseRevoked,
  LeaseScopeMismatch,
  PolicyDenied,
  ProviderOperationFailed,
  SecretEgressBlocked,
  leaseTransitions,
  type LeaseStatus,
  type VaultError,
} from './errors.js'
import { Clock, PolicyPort, SecretProviderPort } from './ports.js'
import { VaultStore, type CredentialRecord, type LeaseRecord } from './state.js'
import {
  CredentialLeaseSchema,
  CredentialMetadataSchema,
  TimestampSchema,
  type CredentialLease,
  type CredentialMetadata,
} from './schemas.js'
import { assertSecret, clone, containsSecret, hash } from './util.js'

/**
 * The vault engine: the credential/lease lifecycle as typed Effects.
 *
 * Every program has the shape Effect<A, VaultError, Deps> where Deps are the
 * port services (VaultStore, Clock, SecretProviderPort, PolicyPort, VaultConfig).
 * Synchronous validation failures that the original implementation surfaced
 * raw (zod ZodError, INVALID_SECRET) surface as defects here and reject the
 * boundary promise with the identical error value.
 */

export interface CreateCredentialInput {
  readonly credentialId: string
  readonly workspaceId: string
  readonly connectorRef: string
  readonly provider: string
  readonly secret: string
  readonly createdAt: string
  readonly expiresAt?: string
}

export interface IssueLeaseInput {
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
}

export interface LeaseScope {
  readonly workspaceId: string
  readonly operation: string
  readonly resourceRef: string
}

type Deps = VaultStore | Clock | SecretProviderPort | PolicyPort | VaultConfig

const nowString = Effect.map(Clock, (clock) => clock.now())

const requireCredential = (credentialId: string) =>
  Effect.flatMap(VaultStore, (state) => {
    const record = state.credentials.get(IdentifierSchemas.credentialId.parse(credentialId))
    return record ? Effect.succeed(record) : Effect.fail(new CredentialMissing())
  })

/** Lazy expiry flip (active -> expired) exactly like the original `#currentMetadata`. */
const refreshMetadata = (record: CredentialRecord) =>
  Effect.flatMap(nowString, (at) => {
    if (
      record.metadata.status === 'active' &&
      record.metadata.expiresAt &&
      Date.parse(record.metadata.expiresAt) <= Date.parse(at)
    ) {
      record.metadata = CredentialMetadataSchema.parse({ ...record.metadata, status: 'expired' })
    }
    return Effect.succeed(record.metadata)
  })

const recordAudit = (
  action: CredentialAuditEvent['action'],
  metadata: CredentialMetadata,
  credentialLeaseId?: string,
  reasonCode?: string,
  principalRef?: string
) =>
  Effect.gen(function* () {
    const state = yield* VaultStore
    const at = yield* nowString
    state.audit.push({
      action,
      credentialId: metadata.credentialId,
      ...(credentialLeaseId === undefined ? {} : { credentialLeaseId }),
      workspaceId: metadata.workspaceId,
      revision: metadata.revision,
      ...(principalRef === undefined ? {} : { principalRef }),
      ...(reasonCode === undefined ? {} : { reasonCode }),
      at,
    })
  })

const storeSecret = (credentialId: string, revision: number, secret: string) =>
  Effect.flatMap(SecretProviderPort, (provider) =>
    Effect.tryPromise({
      try: () => provider.store({ credentialId, revision, secret }),
      catch: () => new ProviderOperationFailed(),
    })
  )

/**
 * Lease status transition guarded by the transition table. Fails
 * `IllegalLeaseTransition` (internal only); call sites map it onto the public
 * code of the intended transition so the public taxonomy is unchanged.
 */
const transitionLease = (record: LeaseRecord, to: LeaseStatus, consumedAt: string) =>
  Effect.suspend(() => {
    const from = record.lease.status
    if (!leaseTransitions[from].includes(to)) {
      return Effect.fail(new IllegalLeaseTransition({ from, to }))
    }
    record.lease = CredentialLeaseSchema.parse({
      ...record.lease,
      status: to,
      ...(to === 'consumed' ? { consumedAt } : {}),
    })
    return Effect.succeed(record.lease)
  })

const transitionRejectionByTarget: Record<'consumed' | 'expired' | 'revoked', VaultError> = {
  consumed: new LeaseConsumed(),
  expired: new LeaseExpired(),
  revoked: new LeaseRevoked(),
}

const transitionTo = (
  record: LeaseRecord,
  to: 'consumed' | 'expired' | 'revoked',
  consumedAt: string
) =>
  Effect.catchTag(transitionLease(record, to, consumedAt), 'IllegalLeaseTransition', () =>
    Effect.fail(transitionRejectionByTarget[to])
  )

export const createCredential = (input: CreateCredentialInput) =>
  Effect.gen(function* () {
    const state = yield* VaultStore
    if (state.credentials.has(input.credentialId)) return yield* new CredentialExists()
    const credentialId = IdentifierSchemas.credentialId.parse(input.credentialId)
    assertSecret(input.secret)
    const reference = yield* storeSecret(credentialId, 1, input.secret)
    const metadata = CredentialMetadataSchema.parse({
      credentialId,
      workspaceId: input.workspaceId,
      connectorRef: input.connectorRef,
      provider: input.provider,
      status: 'active',
      revision: 1,
      createdAt: input.createdAt,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    })
    state.credentials.set(credentialId, { metadata, secrets: new Map([[1, reference]]) })
    yield* recordAudit('credential.created', metadata)
    return clone(metadata)
  }) satisfies Effect.Effect<CredentialMetadata, VaultError, Deps>

export const credentialMetadata = (credentialId: string) =>
  Effect.flatMap(requireCredential(credentialId), (record) =>
    Effect.map(refreshMetadata(record), () => clone(record.metadata))
  ) satisfies Effect.Effect<CredentialMetadata, VaultError, Deps>

export const rotateCredential = (credentialId: string, secret: string, principalRef: string) =>
  Effect.gen(function* () {
    const record = yield* requireCredential(credentialId)
    if (record.metadata.status === 'revoked') return yield* new CredentialRevoked()
    assertSecret(secret)
    const revision = record.metadata.revision + 1
    const reference = yield* storeSecret(record.metadata.credentialId, revision, secret)
    record.secrets.set(revision, reference)
    const at = yield* nowString
    record.metadata = CredentialMetadataSchema.parse({
      ...record.metadata,
      status: 'active',
      revision,
      rotatedAt: at,
    })
    yield* recordAudit('credential.rotated', record.metadata, undefined, undefined, principalRef)
    return clone(record.metadata)
  }) satisfies Effect.Effect<CredentialMetadata, VaultError, Deps>

export const revokeCredential = (credentialId: string, principalRef: string) =>
  Effect.gen(function* () {
    const state = yield* VaultStore
    const record = yield* requireCredential(credentialId)
    if (record.metadata.status !== 'revoked') {
      const at = yield* nowString
      record.metadata = CredentialMetadataSchema.parse({
        ...record.metadata,
        status: 'revoked',
        revokedAt: at,
      })
      const provider = yield* SecretProviderPort
      for (const reference of record.secrets.values()) {
        // Raw provider errors escape as defects, exactly like the original (no catch).
        yield* Effect.promise(() => provider.revoke(reference))
      }
      for (const lease of state.leases.values()) {
        if (lease.lease.credentialId !== credentialId || lease.lease.status !== 'active') continue
        // Unreachable by the filter above; typed as the public code for this transition.
        yield* Effect.catchTag(transitionLease(lease, 'revoked', at), 'IllegalLeaseTransition', () =>
          Effect.fail(new LeaseRevoked())
        )
      }
      yield* recordAudit('credential.revoked', record.metadata, undefined, undefined, principalRef)
    }
    return clone(record.metadata)
  }) satisfies Effect.Effect<CredentialMetadata, VaultError, Deps>

const authorize = (metadata: CredentialMetadata, input: IssueLeaseInput, issuedAt: string) =>
  Effect.flatMap(PolicyPort, (decisionPoint) =>
    Effect.tryPromise({
      // The requestId parse stays inside the try, like the original: a malformed
      // requestId is surfaced as a policy failure, not a validation error.
      try: async () =>
        PolicyDecisionSchema.parse(
          await decisionPoint.authorize({
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
        ),
      catch: () => new PolicyDenied(),
    })
  )

export const issueLease = (input: IssueLeaseInput) =>
  Effect.gen(function* () {
    const state = yield* VaultStore
    const leaseId = IdentifierSchemas.credentialLeaseId.parse(input.credentialLeaseId)
    if (state.leases.has(leaseId)) return yield* new LeaseConflict()
    const record = yield* requireCredential(input.credentialId)
    const metadata = yield* refreshMetadata(record)
    if (metadata.status === 'revoked') return yield* new CredentialRevoked()
    if (metadata.status === 'expired') return yield* new CredentialExpired()
    if (metadata.workspaceId !== input.workspaceId) return yield* new LeaseScopeMismatch()
    const config = yield* VaultConfig
    const issuedAt = TimestampSchema.parse(yield* nowString)
    const requestedAt = TimestampSchema.parse(input.requestedAt)
    const expiresAt = TimestampSchema.parse(input.expiresAt)
    const issuedAtMilliseconds = Date.parse(issuedAt)
    const requestClockSkew = Math.abs(Date.parse(requestedAt) - issuedAtMilliseconds)
    const ttl = Date.parse(expiresAt) - issuedAtMilliseconds
    if (
      requestClockSkew > config.maximumCredentialLeaseClockSkewMs ||
      ttl <= 0 ||
      ttl > config.maximumCredentialLeaseTtlMs
    ) {
      return yield* new LeaseExpired()
    }
    if (metadata.expiresAt && Date.parse(expiresAt) > Date.parse(metadata.expiresAt)) {
      return yield* new LeaseExpired()
    }
    const decision = yield* Effect.catchAll(authorize(metadata, input, issuedAt), () =>
      Effect.flatMap(
        recordAudit('lease.denied', metadata, leaseId, 'POLICY_EVALUATOR_FAILED'),
        () => Effect.fail(new PolicyDenied())
      )
    )
    if (decision.effect !== 'allow') {
      yield* recordAudit('lease.denied', metadata, leaseId, decision.reasonCode)
      return yield* new PolicyDenied()
    }
    const secretReference = record.secrets.get(metadata.revision)
    if (!secretReference) return yield* new CredentialMissing()
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
    state.leases.set(lease.capabilityRef, { lease, secretReference })
    yield* recordAudit('lease.issued', metadata, leaseId)
    return clone(lease)
  }) satisfies Effect.Effect<CredentialLease, VaultError, Deps>

const resolveSecret = (reference: EncryptedSecretReference) =>
  Effect.flatMap(SecretProviderPort, (provider) =>
    Effect.tryPromise({
      try: () => provider.resolve(reference),
      catch: () => new ProviderOperationFailed(),
    })
  )

const runOperation = <Result>(
  operation: (secret: string) => Result | Promise<Result>,
  secret: string
) =>
  Effect.tryPromise({
    try: async () => await operation(secret),
    catch: (cause) =>
      cause instanceof CredentialVaultError
        ? new CallbackRejection({ cause })
        : new ProviderOperationFailed(),
  })

export const useLease = <Result>(
  capabilityRef: string,
  scope: LeaseScope,
  operation: (secret: string) => Result | Promise<Result>
) =>
  Effect.gen(function* () {
    const state = yield* VaultStore
    const record = state.leases.get(capabilityRef)
    if (!record) return yield* new LeaseMissing()
    const now = yield* nowString
    const { lease } = record
    if (lease.status === 'revoked') return yield* new LeaseRevoked()
    if (lease.status === 'consumed') return yield* new LeaseConsumed()
    if (lease.status === 'expired' || Date.parse(lease.expiresAt) <= Date.parse(now)) {
      yield* transitionTo(record, 'expired', now)
      return yield* new LeaseExpired()
    }
    const credential = yield* requireCredential(lease.credentialId)
    if (credential.metadata.status === 'revoked') return yield* new CredentialRevoked()
    if (
      lease.workspaceId !== scope.workspaceId ||
      lease.operation !== scope.operation ||
      lease.resourceRef !== scope.resourceRef
    ) {
      return yield* new LeaseScopeMismatch()
    }
    yield* transitionTo(record, 'consumed', now)
    const secret = yield* resolveSecret(record.secretReference)
    // The secret is only available inside the acquireUseRelease scope; the
    // release runs even when the operation or the egress check fails.
    return yield* Effect.acquireUseRelease(
      Effect.sync<{ value: string | undefined }>(() => ({ value: secret })),
      (holder) =>
        Effect.gen(function* () {
          const current = holder.value
          if (current === undefined) return yield* new ProviderOperationFailed()
          const result = yield* runOperation(operation, current)
          if (containsSecret(result, current)) return yield* new SecretEgressBlocked()
          yield* recordAudit('lease.used', credential.metadata, lease.credentialLeaseId)
          return result
        }),
      (holder) =>
        Effect.sync(() => {
          holder.value = undefined
        })
    )
  }) satisfies Effect.Effect<Result, VaultError, Deps>

export const readAudit = Effect.map(VaultStore, (state) =>
  clone(state.audit)
) satisfies Effect.Effect<readonly CredentialAuditEvent[], VaultError, Deps>
