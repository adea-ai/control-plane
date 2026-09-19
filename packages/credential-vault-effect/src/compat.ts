/**
 * M14 #407 — plain-promise facade over the Effect runtime.
 *
 * Proves the #406 no-leak constraint: the public vault surface keeps the exact original
 * Promise-based signatures (`CredentialVault`, `NeonEncryptedSecretProvider`,
 * `InMemorySecretProvider`, `CredentialVaultError`) — no Effect type crosses this
 * boundary. src/compat.test.mjs is the original 9-test suite with only its import
 * specifier changed, and it passes against THIS facade unchanged.
 *
 * Test-support module for the PoC parity suite; excluded from the tsc build.
 */

import type {
  CredentialAuditEvent,
  CredentialLease,
  CredentialMetadata,
  EncryptedSecretReference,
  EncryptedSecretStore,
  SecretProvider,
} from '@control-plane/credential-vault'
import type { PolicyDecisionPoint } from '@control-plane/policy'
import { Effect } from 'effect'
import { InMemorySecretProvider } from '@control-plane/credential-vault'
import {
  CredentialVaultError,
  NeonSecretCodec,
  makeCredentialVault,
  neonSecretCodecLayer,
  runEgress,
} from './index.ts'
import type { CredentialVaultService, NeonSecretCodecService } from './index.ts'

export { CredentialVaultError, InMemorySecretProvider }

export class CredentialVault {
  readonly #vault: CredentialVaultService

  constructor(options: {
    readonly provider: SecretProvider
    readonly decisionPoint: PolicyDecisionPoint
    readonly now?: () => string
  }) {
    this.#vault = Effect.runSync(
      makeCredentialVault({
        provider: options.provider,
        decisionPoint: options.decisionPoint,
        ...(options.now === undefined ? {} : { now: options.now }),
      })
    )
  }

  create(input: {
    readonly credentialId: string
    readonly workspaceId: string
    readonly connectorRef: string
    readonly provider: string
    readonly secret: string
    readonly createdAt: string
    readonly expiresAt?: string
  }): Promise<CredentialMetadata> {
    return runEgress(this.#vault.create(input))
  }

  metadata(credentialId: string): Promise<CredentialMetadata> {
    return runEgress(this.#vault.metadata(credentialId))
  }

  rotate(credentialId: string, secret: string, principalRef: string): Promise<CredentialMetadata> {
    return runEgress(this.#vault.rotate(credentialId, secret, principalRef))
  }

  revoke(credentialId: string, principalRef: string): Promise<CredentialMetadata> {
    return runEgress(this.#vault.revoke(credentialId, principalRef))
  }

  lease(input: {
    readonly credentialLeaseId: string
    readonly credentialId: string
    readonly requestId: string
    readonly workspaceId: string
    readonly principalRef: string
    readonly operation: string
    readonly resourceRef: string
    readonly requestedAt: string
    readonly expiresAt: string
    readonly policySnapshot: { readonly policyId: string; readonly version: number; readonly digest: string }
  }): Promise<CredentialLease> {
    return runEgress(this.#vault.lease(input))
  }

  use<Result>(
    capabilityRef: string,
    scope: {
      readonly workspaceId: string
      readonly operation: string
      readonly resourceRef: string
    },
    operation: (secret: string) => Result | Promise<Result>
  ): Promise<Result> {
    return runEgress(this.#vault.use(capabilityRef, scope, operation))
  }

  audit(): Promise<readonly CredentialAuditEvent[]> {
    return runEgress(this.#vault.audit())
  }
}

export class NeonEncryptedSecretProvider {
  readonly #codec: NeonSecretCodecService

  constructor(options: {
    readonly store: EncryptedSecretStore
    readonly encryptionKey: string
    readonly keyReference: string
    readonly secretPrefix?: string
  }) {
    this.#codec = Effect.runSync(
      Effect.gen(function* () {
        return yield* NeonSecretCodec
      }).pipe(Effect.provide(neonSecretCodecLayer(options)))
    )
  }

  async store(input: {
    credentialId: string
    revision: number
    secret: string
  }): Promise<EncryptedSecretReference> {
    return runEgress(this.#codec.store(input))
  }

  async resolve(reference: EncryptedSecretReference): Promise<string> {
    return runEgress(this.#codec.resolve(reference))
  }

  async revoke(reference: EncryptedSecretReference): Promise<void> {
    return runEgress(this.#codec.revoke(reference))
  }
}

export const packageName = 'credential-vault-effect/compat'
