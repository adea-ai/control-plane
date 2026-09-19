import { Context } from 'effect'
import type { CredentialAuditEvent, EncryptedSecretReference } from '../index.js'
import type { CredentialLease, CredentialMetadata } from './schemas.js'

/**
 * Mutable in-memory vault state (credential records, lease records, audit log)
 * as an Effect service. One instance is owned by each CredentialVault, exactly
 * like the private fields of the pre-Effect class.
 */

export interface CredentialRecord {
  metadata: CredentialMetadata
  readonly secrets: Map<number, EncryptedSecretReference>
}

export interface LeaseRecord {
  lease: CredentialLease
  readonly secretReference: EncryptedSecretReference
}

export interface VaultState {
  readonly credentials: Map<string, CredentialRecord>
  readonly leases: Map<string, LeaseRecord>
  readonly audit: CredentialAuditEvent[]
}

export class VaultStore extends Context.Tag('credential-vault/VaultStore')<VaultStore, VaultState>() {}
