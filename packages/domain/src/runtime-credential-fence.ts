/**
 * The durable revocation version captured from the authenticated inbound
 * runtime credential. PostgreSQL write repositories validate it in the same
 * transaction as the inbound state change.
 */
export interface CredentialRevocationFence {
  readonly credentialId: string
  readonly revocationVersion: number
}
