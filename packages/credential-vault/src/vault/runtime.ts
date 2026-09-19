import { Cause, Layer, ManagedRuntime, Option } from 'effect'
import type { Effect } from 'effect'
import type { PolicyDecisionPoint } from '@control-plane/policy'
import type { SecretProvider } from '../index.js'
import { VaultConfig, VaultConfigLayer } from './config.js'
import { Clock, PolicyPort, SecretProviderPort } from './ports.js'
import { VaultStore, type VaultState } from './state.js'
import { CredentialVaultError, type VaultError } from './errors.js'

/**
 * Boundary wiring. One ManagedRuntime is built per CredentialVault (and per
 * NeonEncryptedSecretProvider) in the constructor; every public Promise method
 * runs one program through it. This is the exact boundary pattern:
 *
 *   public async method(input): Promise<A> {
 *     return runBoundary(this.#runtime, Effect.mapError(engine.program(input), toVaultError))
 *   }
 *
 * runBoundary translates the Effect Exit into a Promise resolution/rejection.
 * Typed failures reject with the raw domain error (exactly what the original
 * implementation threw); defects (zod ZodError, raw provider errors) reject
 * with the original thrown value. In effect 3.22.2 `runPromise` would wrap
 * rejections in a FiberFailure, which is why the Exit-based translation is
 * used instead. No Effect type ever crosses the boundary.
 */

export type VaultDeps = VaultStore | Clock | SecretProviderPort | PolicyPort | VaultConfig

export type VaultRuntime = ManagedRuntime.ManagedRuntime<VaultDeps, never>

export const makeVaultState = (): VaultState => ({
  credentials: new Map(),
  leases: new Map(),
  audit: [],
})

export const makeVaultRuntime = (options: {
  readonly provider: SecretProvider
  readonly decisionPoint: PolicyDecisionPoint
  readonly now?: () => string
}): VaultRuntime =>
  ManagedRuntime.make(
    Layer.mergeAll(
      VaultConfigLayer,
      Layer.succeed(VaultStore, makeVaultState()),
      Layer.succeed(Clock, { now: options.now ?? (() => new Date().toISOString()) }),
      Layer.succeed(SecretProviderPort, options.provider),
      Layer.succeed(PolicyPort, options.decisionPoint)
    )
  )

/**
 * Exhaustive boundary mapping from the engine's tagged errors onto the public
 * `CredentialVaultError`. This switch is compile-time-checked: removing any
 * case breaks `tsc` (noImplicitReturns + explicit return type), which is the
 * typed-error exhaustiveness guarantee the pilot is evaluating.
 */
export function toVaultError(error: VaultError): CredentialVaultError {
  // eslint-disable-next-line no-underscore-dangle -- `_tag` is Effect's standard discriminant
  switch (error._tag) {
    case 'CredentialMissing':
      return new CredentialVaultError('CREDENTIAL_MISSING')
    case 'CredentialExists':
      return new CredentialVaultError('CREDENTIAL_EXISTS')
    case 'CredentialRevoked':
      return new CredentialVaultError('CREDENTIAL_REVOKED')
    case 'CredentialExpired':
      return new CredentialVaultError('CREDENTIAL_EXPIRED')
    case 'LeaseMissing':
      return new CredentialVaultError('LEASE_MISSING')
    case 'LeaseConflict':
      return new CredentialVaultError('LEASE_CONFLICT')
    case 'LeaseExpired':
      return new CredentialVaultError('LEASE_EXPIRED')
    case 'LeaseRevoked':
      return new CredentialVaultError('LEASE_REVOKED')
    case 'LeaseConsumed':
      return new CredentialVaultError('LEASE_CONSUMED')
    case 'LeaseScopeMismatch':
      return new CredentialVaultError('LEASE_SCOPE_MISMATCH')
    case 'PolicyDenied':
      return new CredentialVaultError('POLICY_DENIED')
    case 'SecretEgressBlocked':
      return new CredentialVaultError('SECRET_EGRESS_BLOCKED')
    case 'ProviderOperationFailed':
      return new CredentialVaultError('PROVIDER_OPERATION_FAILED')
    case 'CallbackRejection':
      return error.cause
  }
}

function unwrapCause<E>(cause: Cause.Cause<E>): unknown {
  const failure = Cause.failureOption(cause)
  if (Option.isSome(failure)) return failure.value
  const defect = Cause.dieOption(cause)
  if (Option.isSome(defect)) return defect.value
  return cause
}

/** Runs one program to completion, rejecting with the original error values. */
export function runBoundary<R, E, A>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  program: Effect.Effect<A, E, R>
): Promise<A> {
  return runtime.runPromiseExit(program).then((exit) => {
    // eslint-disable-next-line no-underscore-dangle -- `_tag` is Effect's standard discriminant
    if (exit._tag === 'Success') return exit.value
    throw unwrapCause(exit.cause)
  })
}
