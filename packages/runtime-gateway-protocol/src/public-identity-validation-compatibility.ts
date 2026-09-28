import type { RuntimeNodeIdentityValidationPort } from './index.js'

// Compile-time regression guard for consumers that implemented the published 1.x port.
const legacyIdentityValidator: RuntimeNodeIdentityValidationPort = {
  verify: async () => ({}),
  isRevoked: async () => false,
  subscribeRevocations: (listener: (credentialId: string) => void) => {
    void listener
    return () => undefined
  },
}

void legacyIdentityValidator
