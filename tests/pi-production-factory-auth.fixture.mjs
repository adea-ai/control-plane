// TEST ONLY: verify the consumer's signed assertion with existing production authentication.
// This helper accepts public trust; it creates no credential, key, grant or scope.
import { ServiceCredentialClaimsSchema } from '@control-plane/contracts'
import {
  Ed25519ServiceCredentialVerifier,
  PolicyServiceAuthenticator,
} from '../apps/control-api/src/auth/service-authentication.ts'

export function createProductionFactoryServiceAuthenticator(options) {
  if (
    !options.issuer ||
    !options.audience ||
    !options.expectedPrincipalId ||
    !options.workspaceId ||
    typeof options.isRevoked !== 'function'
  )
    throw new Error('TEST_SIGNED_SERVICE_TRUST_REQUIRED')
  const verifier = new Ed25519ServiceCredentialVerifier([
    { keyId: options.keyId, publicKey: options.publicKey },
  ])
  return new PolicyServiceAuthenticator({
    issuer: options.issuer,
    audience: options.audience,
    logger: { write: () => {} },
    revocationChecker: { isRevoked: options.isRevoked },
    verifier: {
      async verify(credential) {
        const claims = ServiceCredentialClaimsSchema.parse(await verifier.verify(credential))
        if (
          claims.principalId !== options.expectedPrincipalId ||
          claims.workspaceIds.length !== 1 ||
          claims.workspaceIds[0] !== options.workspaceId ||
          claims.projectIds.length !== 0
        )
          throw new Error('TEST_SIGNED_SERVICE_SCOPE_MISMATCH')
        return claims
      },
    },
  })
}
