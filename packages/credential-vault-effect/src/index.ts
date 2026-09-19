/**
 * M14 #407 — Effect-TS proof of concept for the credential-vault lease core.
 *
 * Isolated evaluation artifact (branch feat/m407-effect-poc). It re-expresses the
 * lease lifecycle of `@control-plane/credential-vault`@1.1.3 (commit 645b866) with
 * Effect services, layers, typed errors, Config-based configuration, an explicit
 * no-retry policy, and acquire/release consumption safety.
 *
 * Contract locks:
 * - Schemas, identifier rules, and wire types are imported from the original module —
 *   zero drift on validation and public data shapes.
 * - Error taxonomy is preserved 1:1: every original code stays a typed
 *   `CredentialVaultError` with the exact same `code` and `message`; raw `Error` throws
 *   (zod, `INVALID_SECRET`, provider failures) stay untyped, exactly like the original.
 * - The original has no retries; `Schedule.stop` (a schedule that never repeats) states
 *   that no-retry policy explicitly at each port instead of inventing new behavior.
 * - AES-256-GCM sealing is byte-compatible: same key/IV/plaintext/AAD inputs produce
 *   identical ciphertext bytes (verified in src/parity.test.mjs).
 * - The public `SecretProvider` / `EncryptedSecretStore` / vault surface stays plain
 *   (see src/compat.ts): Effect types exist only inside this module.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { Config, Context, Effect, Layer, Schedule } from 'effect'
import type { ConfigError } from 'effect'
import { IdentifierSchemas } from '@control-plane/contracts'
import {
  CredentialLeaseSchema,
  CredentialMetadataSchema,
  type CredentialAuditEvent,
  type CredentialLease,
  type CredentialMetadata,
  type CredentialVaultErrorCode,
  type EncryptedSecretReference,
  type EncryptedSecretStore as PlainEncryptedSecretStore,
  type SecretProvider as PlainSecretProvider,
} from '@control-plane/credential-vault'
import {
  PolicyDecisionSchema,
  type PolicyAuthorizationRequest,
  type PolicyDecision,
  type PolicyDecisionPoint as PlainPolicyDecisionPoint,
  type PolicySnapshotReference,
} from '@control-plane/policy'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()

// ---------------------------------------------------------------------------
// Typed errors — tagged class, identical taxonomy to the original module.
// ---------------------------------------------------------------------------

export class CredentialVaultError extends Error {
  readonly _tag = 'CredentialVaultError'
  constructor(readonly code: CredentialVaultErrorCode) {
    super(code)
    this.name = 'CredentialVaultError'
  }
}

const failCode = (code: CredentialVaultErrorCode): Effect.Effect<never, CredentialVaultError> =>
  Effect.fail(new CredentialVaultError(code))

/**
 * Typed-error egress: the only sanctioned way to leave the Effect runtime. Unwraps the
 * fiber `Cause` so callers observe the exact original error values — typed
 * `CredentialVaultError` on the error channel, raw `Error`/zod throws as defects.
 */
export const runEgress = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (exit._tag === 'Success') return exit.value
    const cause = exit.cause
    if (cause._tag === 'Fail') throw cause.error
    if (cause._tag === 'Die') throw cause.defect
    throw new Error(`vault fiber ended: ${cause._tag}`)
  })

// ---------------------------------------------------------------------------
// Services: clock, configuration, and the two injected ports.
// ---------------------------------------------------------------------------

export interface VaultClockService {
  readonly now: Effect.Effect<string>
}
export class VaultClock extends Context.Tag('m407.VaultClock')<VaultClock, VaultClockService>() {}

export const VaultSystemClockLayer: Layer.Layer<VaultClock> = Layer.succeed(VaultClock, {
  now: Effect.sync(() => new Date().toISOString()),
})

export interface VaultConfigValues {
  readonly maxLeaseClockSkewMs: number
  readonly maxLeaseTtlMs: number
  readonly minSecretLength: number
  readonly maxSecretLength: number
}
export class VaultConfig extends Context.Tag('m407.VaultConfig')<VaultConfig, VaultConfigValues>() {}

/** Defaults equal the original module's `maximumCredentialLeaseClockSkewMs` (30s), TTL cap (300s), and secret length bounds. */
export const VaultConfigLayer: Layer.Layer<VaultConfig, ConfigError.ConfigError> = Layer.effect(
  VaultConfig,
  Effect.all({
    maxLeaseClockSkewMs: Config.number('VAULT_MAX_LEASE_CLOCK_SKEW_MS').pipe(
      Config.withDefault(30_000)
    ),
    maxLeaseTtlMs: Config.number('VAULT_MAX_LEASE_TTL_MS').pipe(Config.withDefault(300_000)),
    minSecretLength: Config.number('VAULT_MIN_SECRET_LENGTH').pipe(Config.withDefault(8)),
    maxSecretLength: Config.number('VAULT_MAX_SECRET_LENGTH').pipe(Config.withDefault(65_536)),
  })
)

/** IV randomness isolated as a service: the only nondeterminism in AES-GCM sealing. */
export interface SecretCipherRandomService {
  readonly randomIv: Effect.Effect<Buffer>
}
export class SecretCipherRandom
  extends Context.Tag('m407.SecretCipherRandom')<SecretCipherRandom, SecretCipherRandomService>()
{}
export const SecretCipherRandomLive: Layer.Layer<SecretCipherRandom> = Layer.succeed(
  SecretCipherRandom,
  { randomIv: Effect.sync(() => randomBytes(12)) }
)

export interface SecretProviderService {
  readonly store: (input: {
    readonly credentialId: string
    readonly revision: number
    readonly secret: string
  }) => Effect.Effect<EncryptedSecretReference, unknown>
  readonly resolve: (reference: EncryptedSecretReference) => Effect.Effect<string, unknown>
  readonly revoke: (reference: EncryptedSecretReference) => Effect.Effect<void, unknown>
}
export class SecretProvider
  extends Context.Tag('m407.SecretProvider')<SecretProvider, SecretProviderService>()
{}

/**
 * Adapts the plain (Promise-based) `SecretProvider` port into an Effect service. The
 * plain port stays the public contract; Effect never leaks through it.
 */
export const SecretProviderLayer = (provider: PlainSecretProvider): Layer.Layer<SecretProvider> =>
  Layer.succeed(SecretProvider, {
    store: (input) => plainToEffect(provider.store(input)),
    resolve: (reference) => plainToEffect(provider.resolve(reference)),
    revoke: (reference) => plainToEffect(provider.revoke(reference)),
  })

export interface PolicyDecisionPointService {
  readonly authorize: (request: PolicyAuthorizationRequest) => Effect.Effect<PolicyDecision, unknown>
}
export class PolicyDecisionPoint
  extends Context.Tag('m407.PolicyDecisionPoint')<PolicyDecisionPoint, PolicyDecisionPointService>()
{}
export const PolicyDecisionPointLayer = (
  decisionPoint: PlainPolicyDecisionPoint
): Layer.Layer<PolicyDecisionPoint> =>
  Layer.succeed(PolicyDecisionPoint, {
    authorize: (request) => plainToEffect(decisionPoint.authorize(request)),
  })

/**
 * The original module is fail-fast: no provider or policy call is ever retried, and the
 * vault fails closed on any failure. `Effect.retry(Schedule.stop)` runs the effect once
 * and never replays — semantically identical to no retry, but states the policy
 * explicitly where a future maintainer would otherwise have to add one silently.
 */
const plainToEffect = <A>(promise: Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise(() => promise).pipe(Effect.retry(Schedule.stop))

// ---------------------------------------------------------------------------
// AES-256-GCM codec over the injected EncryptedSecretStore port (AAD-v1 format
// byte-compatible with the original NeonEncryptedSecretProvider).
// ---------------------------------------------------------------------------

type SecretStorePutInput = Parameters<PlainEncryptedSecretStore['put']>[0]
type SecretStoreGetInput = Parameters<PlainEncryptedSecretStore['get']>[0]
type SecretStoreGetRecord = NonNullable<Awaited<ReturnType<PlainEncryptedSecretStore['get']>>>
type SecretStoreDeleteInput = Parameters<PlainEncryptedSecretStore['delete']>[0]

export interface EncryptedSecretStorePort {
  readonly put: (input: SecretStorePutInput) => Effect.Effect<void, unknown>
  readonly get: (input: SecretStoreGetInput) => Effect.Effect<SecretStoreGetRecord | undefined, unknown>
  readonly delete: (input: SecretStoreDeleteInput) => Effect.Effect<void, unknown>
}
export class EncryptedSecretStoreService
  extends Context.Tag('m407.EncryptedSecretStore')<
    EncryptedSecretStoreService,
    EncryptedSecretStorePort
  >()
{}

export const EncryptedSecretStoreLayer = (
  store: PlainEncryptedSecretStore
): Layer.Layer<EncryptedSecretStoreService> =>
  Layer.succeed(EncryptedSecretStoreService, {
    put: (input) => plainToEffect(store.put(input)),
    get: (input) => plainToEffect(store.get(input)),
    delete: (input) => plainToEffect(store.delete(input)),
  })

export interface NeonSecretCodecService {
  readonly store: (input: {
    readonly credentialId: string
    readonly revision: number
    readonly secret: string
  }) => Effect.Effect<EncryptedSecretReference, unknown>
  readonly resolve: (reference: EncryptedSecretReference) => Effect.Effect<string, unknown>
  readonly revoke: (reference: EncryptedSecretReference) => Effect.Effect<void, unknown>
}
export class NeonSecretCodec
  extends Context.Tag('m407.NeonSecretCodec')<NeonSecretCodec, NeonSecretCodecService>()
{}

export interface NeonCodecOptions {
  readonly store: PlainEncryptedSecretStore
  readonly encryptionKey: string
  readonly keyReference: string
  readonly secretPrefix?: string
  readonly random?: Layer.Layer<SecretCipherRandom>
}

export const neonSecretCodecLayer = (options: NeonCodecOptions): Layer.Layer<NeonSecretCodec> =>
  Layer.effect(
    NeonSecretCodec,
    Effect.gen(function* () {
      // Invalid keys are construction-time throws in the original (INVALID_SECRET_ENCRYPTION_KEY).
      const key = decodeEncryptionKey(options.encryptionKey)
      const keyReference = options.keyReference
      const secretPrefix = (options.secretPrefix ?? 'neon://credential-secrets').replace(/\/$/, '')
      const storePort = yield* EncryptedSecretStoreService
      const { randomIv } = yield* SecretCipherRandom

      const store = (input: {
        readonly credentialId: string
        readonly revision: number
        readonly secret: string
      }) =>
        Effect.gen(function* () {
          const locator = `${secretPrefix}/${input.credentialId}`
          const version = String(input.revision)
          const iv = yield* randomIv
          const cipher = createCipheriv('aes-256-gcm', key, iv)
          cipher.setAAD(
            secretAssociatedData({ locator, version, keyReference, encryptionVersion: 'aad-v1' })
          )
          const ciphertext = Buffer.concat([cipher.update(input.secret, 'utf8'), cipher.final()])
          const authTag = cipher.getAuthTag()
          yield* storePort.put({
            locator,
            version,
            ciphertext: ciphertext.toString('base64url'),
            iv: iv.toString('base64url'),
            authTag: authTag.toString('base64url'),
            keyReference,
            encryptionVersion: 'aad-v1',
          })
          const reference: EncryptedSecretReference = {
            backend: 'neon-encrypted',
            locator,
            version,
            keyReference,
            encryptionVersion: 'aad-v1',
            ciphertextDigest: `sha256:${hash(input.secret)}`,
          }
          return reference
        })

      const resolve = (reference: EncryptedSecretReference) =>
        Effect.gen(function* () {
          const record = yield* storePort.get({
            locator: reference.locator,
            version: reference.version,
          })
          if (
            !record ||
            reference.keyReference !== keyReference ||
            record.keyReference !== reference.keyReference
          ) {
            return yield* Effect.fail(new Error('SECRET_MISSING'))
          }
          if (reference.encryptionVersion !== 'aad-v1' || record.encryptionVersion !== 'aad-v1') {
            return yield* Effect.fail(new Error('SECRET_LEGACY_FORMAT'))
          }
          // Narrowed above by the 'aad-v1' guard; hoisted so the narrowing
          // survives into the decipher closure (as in the original's flat scope).
          const recordEncryptionVersion: 'aad-v1' = record.encryptionVersion
          return yield* Effect.try(() => {
            const decipher = createDecipheriv(
              'aes-256-gcm',
              key,
              Buffer.from(record.iv, 'base64url')
            )
            decipher.setAAD(
              secretAssociatedData({
                locator: reference.locator,
                version: reference.version,
                keyReference: record.keyReference,
                encryptionVersion: recordEncryptionVersion,
              })
            )
            decipher.setAuthTag(Buffer.from(record.authTag, 'base64url'))
            return Buffer.concat([
              decipher.update(Buffer.from(record.ciphertext, 'base64url')),
              decipher.final(),
            ]).toString('utf8')
          }).pipe(Effect.catchAll(() => Effect.fail(new Error('SECRET_CORRUPTED'))))
        })

      const revoke = (reference: EncryptedSecretReference) =>
        storePort.delete({ locator: reference.locator, version: reference.version })

      return { store, resolve, revoke } satisfies NeonSecretCodecService
    })
  ).pipe(Layer.provide(EncryptedSecretStoreLayer(options.store)), Layer.provide(options.random ?? SecretCipherRandomLive))

/** A complete Effect-typed SecretProvider backed by the AES-256-GCM codec. */
export const neonSecretProviderLayer = (options: NeonCodecOptions): Layer.Layer<SecretProvider> =>
  Layer.effect(
    SecretProvider,
    Effect.gen(function* () {
      const codec = yield* NeonSecretCodec
      return {
        store: (input) => codec.store(input),
        resolve: (reference) => codec.resolve(reference),
        revoke: (reference) => codec.revoke(reference),
      } satisfies SecretProviderService
    })
  ).pipe(Layer.provide(neonSecretCodecLayer(options)))

// ---------------------------------------------------------------------------
// The credential vault lease core.
// ---------------------------------------------------------------------------

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

export interface CredentialVaultService {
  readonly create: (input: CreateCredentialInput) => Effect.Effect<CredentialMetadata, CredentialVaultError>
  readonly metadata: (credentialId: string) => Effect.Effect<CredentialMetadata, CredentialVaultError>
  readonly rotate: (
    credentialId: string,
    secret: string,
    principalRef: string
  ) => Effect.Effect<CredentialMetadata, CredentialVaultError>
  readonly revoke: (
    credentialId: string,
    principalRef: string
  ) => Effect.Effect<CredentialMetadata, CredentialVaultError>
  readonly lease: (input: IssueLeaseInput) => Effect.Effect<CredentialLease, CredentialVaultError>
  readonly use: <A>(
    capabilityRef: string,
    scope: LeaseScope,
    operation: (secret: string) => A
  ) => Effect.Effect<Awaited<A>, CredentialVaultError>
  readonly audit: () => Effect.Effect<readonly CredentialAuditEvent[], never>
}
export class CredentialVault
  extends Context.Tag('m407.CredentialVault')<CredentialVault, CredentialVaultService>()
{}

interface CredentialRecord {
  metadata: CredentialMetadata
  readonly secrets: Map<number, EncryptedSecretReference>
}

interface LeaseRecord {
  lease: CredentialLease
  readonly secretReference: EncryptedSecretReference
}

export const CredentialVaultLayer: Layer.Layer<
  CredentialVault,
  never,
  VaultClock | VaultConfig | SecretProvider | PolicyDecisionPoint
> = Layer.effect(
  CredentialVault,
  Effect.gen(function* () {
    const clock = yield* VaultClock
    const config = yield* VaultConfig
    const provider = yield* SecretProvider
    const policy = yield* PolicyDecisionPoint

    const credentials = new Map<string, CredentialRecord>()
    const leases = new Map<string, LeaseRecord>()
    const auditLog: CredentialAuditEvent[] = []

    const recordAudit = (
      action: CredentialAuditEvent['action'],
      metadata: CredentialMetadata,
      credentialLeaseId?: string,
      reasonCode?: string,
      principalRef?: string
    ) =>
      Effect.gen(function* () {
        const at = yield* clock.now
        auditLog.push({
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

    const credentialRecord = (credentialId: string) =>
      Effect.gen(function* () {
        const parsed = IdentifierSchemas.credentialId.parse(credentialId)
        const record = credentials.get(parsed)
        if (!record) return yield* failCode('CREDENTIAL_MISSING')
        return record
      })

    const currentMetadata = (record: CredentialRecord) =>
      Effect.gen(function* () {
        if (
          record.metadata.status === 'active' &&
          record.metadata.expiresAt &&
          Date.parse(record.metadata.expiresAt) <= Date.parse(yield* clock.now)
        ) {
          // Synchronous throws inside Effect.gen surface as defects — untyped, exactly
          // like the original module's raw zod throws.
          record.metadata = CredentialMetadataSchema.parse({
            ...record.metadata,
            status: 'expired',
          })
        }
        return record.metadata
      })

    const storeSecret = (credentialId: string, revision: number, secret: string) =>
      provider.store({ credentialId, revision, secret }).pipe(
        Effect.retry(Schedule.stop), // explicit no-retry policy
        Effect.catchAll(() => failCode('PROVIDER_OPERATION_FAILED'))
      )

    const create = (input: CreateCredentialInput): Effect.Effect<CredentialMetadata, CredentialVaultError> =>
      Effect.gen(function* () {
        if (credentials.has(input.credentialId)) return yield* failCode('CREDENTIAL_EXISTS')
        const credentialId = IdentifierSchemas.credentialId.parse(input.credentialId)
        assertSecret(input.secret, config)
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
        credentials.set(credentialId, { metadata, secrets: new Map([[1, reference]]) })
        yield* recordAudit('credential.created', metadata)
        return clone(metadata)
      })

    const metadataOf = (credentialId: string): Effect.Effect<CredentialMetadata, CredentialVaultError> =>
      Effect.gen(function* () {
        const record = yield* credentialRecord(credentialId)
        return clone(yield* currentMetadata(record))
      })

    const rotate = (
      credentialId: string,
      secret: string,
      principalRef: string
    ): Effect.Effect<CredentialMetadata, CredentialVaultError> =>
      Effect.gen(function* () {
        const record = yield* credentialRecord(credentialId)
        if (record.metadata.status === 'revoked') return yield* failCode('CREDENTIAL_REVOKED')
        assertSecret(secret, config)
        const revision = record.metadata.revision + 1
        const reference = yield* storeSecret(record.metadata.credentialId, revision, secret)
        record.secrets.set(revision, reference)
        const rotatedAt = yield* clock.now
        record.metadata = CredentialMetadataSchema.parse({
          ...record.metadata,
          status: 'active',
          revision,
          rotatedAt,
        })
        yield* recordAudit('credential.rotated', record.metadata, undefined, undefined, principalRef)
        return clone(record.metadata)
      })

    const revoke = (
      credentialId: string,
      principalRef: string
    ): Effect.Effect<CredentialMetadata, CredentialVaultError> =>
      Effect.gen(function* () {
        const record = yield* credentialRecord(credentialId)
        if (record.metadata.status !== 'revoked') {
          const revokedAt = yield* clock.now
          record.metadata = CredentialMetadataSchema.parse({
            ...record.metadata,
            status: 'revoked',
            revokedAt,
          })
          // Provider failures here surface raw in the original (uncaught rejection); a
          // defect preserves that (untyped, fail-loud) instead of inventing an error code.
          yield* Effect.forEach(
            record.secrets.values(),
            (reference) => provider.revoke(reference).pipe(Effect.retry(Schedule.stop), Effect.catchAll(Effect.die)),
            { discard: true }
          )
          for (const leaseRecord of leases.values()) {
            if (
              leaseRecord.lease.credentialId !== credentialId ||
              leaseRecord.lease.status !== 'active'
            ) {
              continue
            }
            leaseRecord.lease = CredentialLeaseSchema.parse({
              ...leaseRecord.lease,
              status: 'revoked',
            })
          }
          yield* recordAudit('credential.revoked', record.metadata, undefined, undefined, principalRef)
        }
        return clone(record.metadata)
      })

    const issueLease = (input: IssueLeaseInput): Effect.Effect<CredentialLease, CredentialVaultError> =>
      Effect.gen(function* () {
        const leaseId = IdentifierSchemas.credentialLeaseId.parse(input.credentialLeaseId)
        if (leases.has(leaseId)) return yield* failCode('LEASE_CONFLICT')
        const record = yield* credentialRecord(input.credentialId)
        const metadata = yield* currentMetadata(record)
        if (metadata.status === 'revoked') return yield* failCode('CREDENTIAL_REVOKED')
        if (metadata.status === 'expired') return yield* failCode('CREDENTIAL_EXPIRED')
        if (metadata.workspaceId !== input.workspaceId) return yield* failCode('LEASE_SCOPE_MISMATCH')
        const issuedAtRaw = yield* clock.now
        const issuedAt = TimestampSchema.parse(issuedAtRaw)
        const requestedAt = TimestampSchema.parse(input.requestedAt)
        const expiresAt = TimestampSchema.parse(input.expiresAt)
        const issuedAtMilliseconds = Date.parse(issuedAt)
        const requestClockSkew = Math.abs(Date.parse(requestedAt) - issuedAtMilliseconds)
        const ttl = Date.parse(expiresAt) - issuedAtMilliseconds
        if (
          requestClockSkew > config.maxLeaseClockSkewMs ||
          ttl <= 0 ||
          ttl > config.maxLeaseTtlMs
        ) {
          return yield* failCode('LEASE_EXPIRED')
        }
        if (metadata.expiresAt && Date.parse(expiresAt) > Date.parse(metadata.expiresAt)) {
          return yield* failCode('LEASE_EXPIRED')
        }
        const requestId = IdentifierSchemas.requestId.parse(input.requestId)
        const decision = yield* policy
          .authorize({
            requestId,
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
          .pipe(
            // A failing evaluator OR a malformed decision both mean the policy layer is
            // unavailable — the original catches both under one `catch` (fail closed).
            Effect.flatMap((raw) => Effect.try(() => PolicyDecisionSchema.parse(raw))),
            Effect.catchAllCause(() =>
              recordAudit('lease.denied', metadata, leaseId, 'POLICY_EVALUATOR_FAILED').pipe(
                Effect.zipRight(failCode('POLICY_DENIED'))
              )
            )
          )
        if (decision.effect !== 'allow') {
          yield* recordAudit('lease.denied', metadata, leaseId, decision.reasonCode)
          return yield* failCode('POLICY_DENIED')
        }
        const secretReference = record.secrets.get(metadata.revision)
        if (!secretReference) return yield* failCode('CREDENTIAL_MISSING')
        const capabilityRef = `lease://${leaseId}/${hash({ leaseId, decisionId: decision.decisionId, expiresAt })}`
        const issued = CredentialLeaseSchema.parse({
            credentialLeaseId: leaseId,
            credentialId: metadata.credentialId,
            credentialRevision: metadata.revision,
            workspaceId: metadata.workspaceId,
            principalRef: input.principalRef,
            operation: input.operation,
            resourceRef: input.resourceRef,
            capabilityRef,
            status: 'active',
            policySnapshot: decision.policySnapshot,
            policyDecisionId: decision.decisionId,
          issuedAt,
          expiresAt,
        })
        leases.set(issued.capabilityRef, { lease: issued, secretReference })
        yield* recordAudit('lease.issued', metadata, leaseId)
        return clone(issued)
      })

    const use = <A>(
      capabilityRef: string,
      scope: LeaseScope,
      operation: (secret: string) => A
    ): Effect.Effect<Awaited<A>, CredentialVaultError> =>
      Effect.gen(function* () {
        const record = leases.get(capabilityRef)
        if (!record) return yield* failCode('LEASE_MISSING')
        const { lease } = record
        if (lease.status === 'revoked') return yield* failCode('LEASE_REVOKED')
        if (lease.status === 'consumed') return yield* failCode('LEASE_CONSUMED')
        if (lease.status === 'expired' || Date.parse(lease.expiresAt) <= Date.parse(yield* clock.now)) {
          record.lease = CredentialLeaseSchema.parse({ ...lease, status: 'expired' })
          return yield* failCode('LEASE_EXPIRED')
        }
        const credential = yield* credentialRecord(lease.credentialId)
        if (credential.metadata.status === 'revoked') return yield* failCode('CREDENTIAL_REVOKED')
        if (
          lease.workspaceId !== scope.workspaceId ||
          lease.operation !== scope.operation ||
          lease.resourceRef !== scope.resourceRef
        ) {
          return yield* failCode('LEASE_SCOPE_MISMATCH')
        }
        // Resource-safety re-expression: consumption is the acquire; the secret only
        // exists inside the release-guaranteed scope. acquireUseRelease guarantees the
        // consumed state survives even if the consuming fiber is interrupted — the
        // original achieves this only by call ordering, not by any structural guarantee.
        // The release is a no-op on success/failure, exactly like the original, which
        // never un-consumes a lease.
        return yield* Effect.acquireUseRelease(
          Effect.gen(function* () {
            const consumedAt = yield* clock.now
            record.lease = CredentialLeaseSchema.parse({
              ...lease,
              status: 'consumed',
              consumedAt,
            })
          }),
          () =>
            Effect.gen(function* () {
            const secret = yield* provider.resolve(record.secretReference).pipe(
              Effect.retry(Schedule.stop), // explicit no-retry policy
              Effect.catchAll(() => failCode('PROVIDER_OPERATION_FAILED'))
            )
            const result = yield* Effect.tryPromise({
              try: () => Promise.resolve(operation(secret)),
              catch: (error) =>
                error instanceof CredentialVaultError
                  ? error
                  : new CredentialVaultError('PROVIDER_OPERATION_FAILED'),
            })
            if (containsSecret(result, secret)) return yield* failCode('SECRET_EGRESS_BLOCKED')
            yield* recordAudit('lease.used', credential.metadata, lease.credentialLeaseId)
            return result
          }),
          () => Effect.void
        )
      })

    const audit = (): Effect.Effect<readonly CredentialAuditEvent[], never> =>
      Effect.sync(() => clone(auditLog))

    return {
      create,
      metadata: metadataOf,
      rotate,
      revoke,
      lease: issueLease,
      use,
      audit,
    } satisfies CredentialVaultService
  })
)

// ---------------------------------------------------------------------------
// Composition helpers.
// ---------------------------------------------------------------------------

export interface VaultComposition {
  readonly provider: Layer.Layer<SecretProvider>
  readonly policy: Layer.Layer<PolicyDecisionPoint>
  readonly clock: Layer.Layer<VaultClock>
}

/** Builds the vault service from explicit Layers (fully Effect-native composition). */
export const credentialVaultEffect = (composition: VaultComposition): Effect.Effect<CredentialVaultService, never> =>
  Effect.gen(function* () {
    return yield* CredentialVault
  }).pipe(
    Effect.provide(
      CredentialVaultLayer.pipe(
        Layer.provide(VaultConfigLayer),
        Layer.provide(composition.clock),
        Layer.provide(composition.provider),
        Layer.provide(composition.policy)
      )
    ),
    // A ConfigError can only come from malformed environment configuration at boot;
    // failing to start loudly (defect) is the intended behavior for defaults-backed config.
    Effect.orDie
  )

export interface VaultOptions {
  /** Plain (Promise-based) port — the public contract. Adapted via {@link SecretProviderLayer}. */
  readonly provider: PlainSecretProvider
  readonly decisionPoint: PlainPolicyDecisionPoint
  /** Test/system clock as a Layer (Effect-native). */
  readonly clock?: Layer.Layer<VaultClock>
  /** Convenience for plain callers; ignored when `clock` is given. */
  readonly now?: () => string
}

export const makeCredentialVault = (options: VaultOptions): Effect.Effect<CredentialVaultService, never> =>
  credentialVaultEffect({
    provider: SecretProviderLayer(options.provider),
    policy: PolicyDecisionPointLayer(options.decisionPoint),
    clock:
      options.clock ??
      Layer.succeed(VaultClock, {
        now: Effect.sync(() => (options.now ?? (() => new Date().toISOString()))()),
      }),
  })

// ---------------------------------------------------------------------------
// Helpers copied verbatim from the original module (not exported there).
// ---------------------------------------------------------------------------

function secretAssociatedData(input: {
  readonly locator: string
  readonly version: string
  readonly keyReference: string
  readonly encryptionVersion: 'aad-v1'
}): Buffer {
  return Buffer.from(
    JSON.stringify([
      'control-plane-credential-secret',
      input.encryptionVersion,
      input.locator,
      input.version,
      input.keyReference,
    ]),
    'utf8'
  )
}

function decodeEncryptionKey(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64url')
  if (key.length !== 32) throw new Error('INVALID_SECRET_ENCRYPTION_KEY')
  return key
}

function assertSecret(secret: string, config: VaultConfigValues): void {
  if (secret.length < config.minSecretLength || secret.length > config.maxSecretLength) {
    throw new Error('INVALID_SECRET')
  }
}

const sensitiveKey =
  /^(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|token)$/i

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret)
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secret))
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, entry]) => sensitiveKey.test(key) || containsSecret(entry, secret)
  )
}

function hash(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return createHash('sha256').update(serialized).digest('hex')
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

export const packageName = 'credential-vault-effect'
