import type { PolicySnapshotReference } from '@control-plane/policy'
import {
  CredentialVault,
  CredentialVaultError,
  MAXIMUM_CREDENTIAL_LEASE_TTL_MS,
  createCredentialLeaseId,
} from './vault.js'

/** Scope of one server-side tool call that needs a workspace connector credential. */
export interface ToolCredentialRequest {
  readonly workspaceId: string
  readonly connectorRef: string
  readonly requestId: string
  readonly principalRef: string
  readonly operation: string
  readonly resourceRef: string
}

/**
 * Port consumed by server-side tool executors and MCP adapters. The secret exists only inside
 * `operation`; the broker never returns it and the vault blocks results that echo it.
 */
export interface ToolCredentialBroker {
  withCredential<Result>(
    request: ToolCredentialRequest,
    operation: (secret: string) => Result | Promise<Result>
  ): Promise<Result>
}

/**
 * Obtains a short-lived, single-use lease for the execution's workspace connector through the
 * vault (`credential:lease` policy decision) and consumes it immediately for one tool call.
 */
export class VaultToolCredentialBroker implements ToolCredentialBroker {
  readonly #vault: CredentialVault
  readonly #policySnapshot: (
    workspaceId: string
  ) => PolicySnapshotReference | undefined | Promise<PolicySnapshotReference | undefined>
  readonly #leaseIds: () => string
  readonly #leaseTtlMs: number
  readonly #now: () => Date

  constructor(options: {
    readonly vault: CredentialVault
    /** Resolves the active policy snapshot for the workspace; absence fails closed. */
    readonly policySnapshot: (
      workspaceId: string
    ) => PolicySnapshotReference | undefined | Promise<PolicySnapshotReference | undefined>
    readonly leaseIds?: () => string
    /** Lease lifetime; defaults to 60 seconds and may not exceed 300 seconds. */
    readonly leaseTtlMs?: number
    readonly now?: () => Date
  }) {
    const ttl = options.leaseTtlMs ?? 60_000
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > MAXIMUM_CREDENTIAL_LEASE_TTL_MS) {
      throw new RangeError('CREDENTIAL_LEASE_TTL_INVALID')
    }
    this.#vault = options.vault
    this.#policySnapshot = options.policySnapshot
    this.#leaseIds = options.leaseIds ?? createCredentialLeaseId
    this.#leaseTtlMs = ttl
    this.#now = options.now ?? (() => new Date())
  }

  async withCredential<Result>(
    request: ToolCredentialRequest,
    operation: (secret: string) => Result | Promise<Result>
  ): Promise<Result> {
    let snapshot: PolicySnapshotReference | undefined
    try {
      snapshot = await this.#policySnapshot(request.workspaceId)
    } catch {
      snapshot = undefined
    }
    if (snapshot === undefined) throw new CredentialVaultError('POLICY_DENIED')
    const credential = await this.#vault.findByConnector(request.workspaceId, request.connectorRef)
    if (credential === undefined) throw new CredentialVaultError('CREDENTIAL_MISSING')
    const now = this.#now()
    const lease = await this.#vault.lease({
      credentialLeaseId: this.#leaseIds(),
      credentialId: credential.credentialId,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      principalRef: request.principalRef,
      operation: request.operation,
      resourceRef: request.resourceRef,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#leaseTtlMs).toISOString(),
      policySnapshot: snapshot,
    })
    return this.#vault.use(
      lease.capabilityRef,
      {
        workspaceId: request.workspaceId,
        operation: request.operation,
        resourceRef: request.resourceRef,
      },
      operation
    )
  }
}
