import { Effect, Layer, ManagedRuntime } from 'effect'
import type { PolicyDecisionPoint, PolicySnapshotReference } from '@control-plane/policy'
import {
  credentialMetadata,
  createCredential,
  issueLease,
  readAudit,
  revokeCredential,
  rotateCredential,
  useLease,
} from './vault/engine.js'
import {
  CredentialVaultError,
  type CredentialVaultErrorCode,
  type VaultError,
} from './vault/errors.js'
import { resolveEncryptedSecret, revokeEncryptedSecret, SecretStorePort, storeEncryptedSecret } from './vault/crypto.js'
import { makeVaultRuntime, runBoundary, toVaultError, type VaultDeps, type VaultRuntime } from './vault/runtime.js'
import type { CredentialLease, CredentialMetadata } from './vault/schemas.js'
import { hash } from './vault/util.js'

/**
 * Public boundary of the credential vault. The lease lifecycle engine is
 * re-expressed with Effect-TS (see ./vault/*); every public type and method
 * signature is unchanged from the pre-Effect implementation. Effect runs
 * strictly inside the module: each public Promise method executes one program
 * through a per-instance ManagedRuntime and maps typed errors, exhaustively,
 * back onto `CredentialVaultError` at this edge.
 */

export { CredentialMetadataSchema, CredentialLeaseSchema } from './vault/schemas.js'
export type { CredentialMetadata, CredentialLease } from './vault/schemas.js'
export { CredentialVaultError }
export type { CredentialVaultErrorCode }

export interface EncryptedSecretReference {
  readonly backend: 'memory' | 'neon-encrypted'
  readonly locator: string
  readonly version: string
  readonly keyReference: string
  readonly encryptionVersion: 'memory-v1' | 'aad-v1'
  readonly ciphertextDigest: `sha256:${string}`
}

export interface SecretProvider {
  store(input: {
    readonly credentialId: string
    readonly revision: number
    readonly secret: string
  }): Promise<EncryptedSecretReference>
  resolve(reference: EncryptedSecretReference): Promise<string>
  revoke(reference: EncryptedSecretReference): Promise<void>
}

export interface CredentialAuditEvent {
  readonly action:
    | 'credential.created'
    | 'credential.rotated'
    | 'credential.revoked'
    | 'lease.issued'
    | 'lease.used'
    | 'lease.denied'
  readonly credentialId: string
  readonly credentialLeaseId?: string
  readonly workspaceId: string
  readonly revision: number
  readonly principalRef?: string
  readonly reasonCode?: string
  readonly at: string
}

export class CredentialVault {
  readonly #runtime: VaultRuntime

  constructor(options: {
    readonly provider: SecretProvider
    readonly decisionPoint: PolicyDecisionPoint
    readonly now?: () => string
  }) {
    this.#runtime = makeVaultRuntime(options)
  }

  async create(input: {
    readonly credentialId: string
    readonly workspaceId: string
    readonly connectorRef: string
    readonly provider: string
    readonly secret: string
    readonly createdAt: string
    readonly expiresAt?: string
  }): Promise<CredentialMetadata> {
    return this.#run(createCredential(input))
  }

  async metadata(credentialId: string): Promise<CredentialMetadata> {
    return this.#run(credentialMetadata(credentialId))
  }

  async rotate(
    credentialId: string,
    secret: string,
    principalRef: string
  ): Promise<CredentialMetadata> {
    return this.#run(rotateCredential(credentialId, secret, principalRef))
  }

  async revoke(credentialId: string, principalRef: string): Promise<CredentialMetadata> {
    return this.#run(revokeCredential(credentialId, principalRef))
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
    return this.#run(issueLease(input))
  }

  async use<Result>(
    capabilityRef: string,
    scope: {
      readonly workspaceId: string
      readonly operation: string
      readonly resourceRef: string
    },
    operation: (secret: string) => Result | Promise<Result>
  ): Promise<Result> {
    return this.#run(useLease(capabilityRef, scope, operation))
  }

  async audit(): Promise<readonly CredentialAuditEvent[]> {
    return this.#run(readAudit)
  }

  #run<Result>(program: Effect.Effect<Result, VaultError, VaultDeps>): Promise<Result> {
    return runBoundary(this.#runtime, Effect.mapError(program, toVaultError))
  }
}

export class InMemorySecretProvider implements SecretProvider {
  readonly #secrets = new Map<string, string>()
  readonly #revoked = new Set<string>()
  resolveCount = 0

  async store(input: { credentialId: string; revision: number; secret: string }) {
    const locator = `memory://${input.credentialId}/${input.revision}`
    this.#secrets.set(locator, input.secret)
    return {
      backend: 'memory' as const,
      locator,
      version: String(input.revision),
      keyReference: 'memory://test-kms',
      encryptionVersion: 'memory-v1' as const,
      ciphertextDigest: `sha256:${hash(input.secret)}` as const,
    }
  }

  async resolve(reference: EncryptedSecretReference): Promise<string> {
    this.resolveCount += 1
    if (this.#revoked.has(reference.locator)) throw new Error('SECRET_REVOKED')
    const secret = this.#secrets.get(reference.locator)
    if (!secret) throw new Error('SECRET_MISSING')
    return secret
  }

  async revoke(reference: EncryptedSecretReference): Promise<void> {
    this.#revoked.add(reference.locator)
  }

  async references(): Promise<readonly string[]> {
    return [...this.#secrets.keys()]
  }
}

export type SecretEncryptionVersion = 'legacy-v0' | 'aad-v1'

export interface EncryptedSecretStore {
  put(input: {
    readonly locator: string
    readonly version: string
    readonly ciphertext: string
    readonly iv: string
    readonly authTag: string
    readonly keyReference: string
    readonly encryptionVersion: 'aad-v1'
  }): Promise<void>
  get(input: { readonly locator: string; readonly version: string }): Promise<
    | {
        readonly ciphertext: string
        readonly iv: string
        readonly authTag: string
        readonly keyReference: string
        readonly encryptionVersion: SecretEncryptionVersion
      }
    | undefined
  >
  delete(input: { readonly locator: string; readonly version: string }): Promise<void>
}

export class NeonEncryptedSecretProvider implements SecretProvider {
  readonly #key: Buffer
  readonly #keyReference: string
  readonly #secretPrefix: string
  readonly #runtime: ManagedRuntime.ManagedRuntime<SecretStorePort, never>

  constructor(options: {
    readonly store: EncryptedSecretStore
    readonly encryptionKey: string
    readonly keyReference: string
    readonly secretPrefix?: string
  }) {
    this.#key = decodeEncryptionKey(options.encryptionKey)
    this.#keyReference = options.keyReference
    this.#secretPrefix = (options.secretPrefix ?? 'neon://credential-secrets').replace(/\/$/, '')
    this.#runtime = ManagedRuntime.make(Layer.succeed(SecretStorePort, options.store))
  }

  async store(input: { credentialId: string; revision: number; secret: string }) {
    return runBoundary(
      this.#runtime,
      storeEncryptedSecret({
        credentialId: input.credentialId,
        revision: input.revision,
        secret: input.secret,
        key: this.#key,
        keyReference: this.#keyReference,
        secretPrefix: this.#secretPrefix,
      })
    )
  }

  async resolve(reference: EncryptedSecretReference): Promise<string> {
    return runBoundary(
      this.#runtime,
      resolveEncryptedSecret({
        reference,
        key: this.#key,
        keyReference: this.#keyReference,
      })
    )
  }

  revoke(reference: EncryptedSecretReference): Promise<void> {
    return runBoundary(this.#runtime, revokeEncryptedSecret(reference))
  }
}

function decodeEncryptionKey(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64url')
  if (key.length !== 32) throw new Error('INVALID_SECRET_ENCRYPTION_KEY')
  return key
}

export const packageName = 'credential-vault'
