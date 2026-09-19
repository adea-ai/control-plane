import { Data } from 'effect'

/**
 * Public error surface: the code union and the `CredentialVaultError` class,
 * moved verbatim from the pre-Effect implementation and re-exported from the
 * package root; signatures unchanged.
 */

export type CredentialVaultErrorCode =
  | 'CREDENTIAL_MISSING'
  | 'CREDENTIAL_EXISTS'
  | 'CREDENTIAL_REVOKED'
  | 'CREDENTIAL_EXPIRED'
  | 'LEASE_MISSING'
  | 'LEASE_CONFLICT'
  | 'LEASE_EXPIRED'
  | 'LEASE_REVOKED'
  | 'LEASE_CONSUMED'
  | 'LEASE_SCOPE_MISMATCH'
  | 'POLICY_DENIED'
  | 'SECRET_EGRESS_BLOCKED'
  | 'PROVIDER_OPERATION_FAILED'

export class CredentialVaultError extends Error {
  constructor(readonly code: CredentialVaultErrorCode) {
    super(code)
    this.name = 'CredentialVaultError'
  }
}

/**
 * Typed tagged errors for the vault domain. These live strictly inside the
 * module: the boundary (index.ts) maps them, exhaustively, onto the public
 * `CredentialVaultErrorCode` values via plain `CredentialVaultError` throws.
 * No tagged error or Effect type crosses the package boundary.
 */

export type LeaseStatus = 'active' | 'consumed' | 'expired' | 'revoked'
export type CredentialStatus = 'active' | 'revoked' | 'expired'

/** Terminal lease transitions, per status. Key exhaustiveness is enforced by Record. */
export const leaseTransitions: Record<LeaseStatus, readonly LeaseStatus[]> = {
  active: ['consumed', 'expired', 'revoked'],
  consumed: [],
  expired: [],
  revoked: [],
}

/** Credential status transitions. `expired -> active` is a rotation reactivating an expired credential. */
export const credentialTransitions: Record<CredentialStatus, readonly CredentialStatus[]> = {
  active: ['expired', 'revoked'],
  expired: ['active', 'revoked'],
  revoked: [],
}

export class CredentialMissing extends Data.TaggedError('CredentialMissing')<Record<never, never>> {}
export class CredentialExists extends Data.TaggedError('CredentialExists')<Record<never, never>> {}
export class CredentialRevoked extends Data.TaggedError('CredentialRevoked')<Record<never, never>> {}
export class CredentialExpired extends Data.TaggedError('CredentialExpired')<Record<never, never>> {}
export class LeaseMissing extends Data.TaggedError('LeaseMissing')<Record<never, never>> {}
export class LeaseConflict extends Data.TaggedError('LeaseConflict')<Record<never, never>> {}
export class LeaseExpired extends Data.TaggedError('LeaseExpired')<Record<never, never>> {}
export class LeaseRevoked extends Data.TaggedError('LeaseRevoked')<Record<never, never>> {}
export class LeaseConsumed extends Data.TaggedError('LeaseConsumed')<Record<never, never>> {}
export class LeaseScopeMismatch extends Data.TaggedError('LeaseScopeMismatch')<Record<never, never>> {}
export class PolicyDenied extends Data.TaggedError('PolicyDenied')<Record<never, never>> {}
export class SecretEgressBlocked extends Data.TaggedError('SecretEgressBlocked')<Record<never, never>> {}
export class ProviderOperationFailed extends Data.TaggedError('ProviderOperationFailed')<Record<never, never>> {}

/** Carries a `CredentialVaultError` thrown by the caller-supplied operation back through the boundary untouched. */
export class CallbackRejection extends Data.TaggedError('CallbackRejection')<{
  readonly cause: CredentialVaultError
}> {}
/** Internal only: an invalid lease transition attempt; mapped to public codes at the transition call sites. */
export class IllegalLeaseTransition extends Data.TaggedError('IllegalLeaseTransition')<{
  readonly from: LeaseStatus
  readonly to: LeaseStatus
}> {}

/** The full typed error channel of the vault engine programs. */
export type VaultError =
  | CredentialMissing
  | CredentialExists
  | CredentialRevoked
  | CredentialExpired
  | LeaseMissing
  | LeaseConflict
  | LeaseExpired
  | LeaseRevoked
  | LeaseConsumed
  | LeaseScopeMismatch
  | PolicyDenied
  | SecretEgressBlocked
  | ProviderOperationFailed
  | CallbackRejection
