import type {
  RuntimeNodeCredentialConsumptionResult,
  RuntimeNodeIdentityInvalidation,
  RuntimeNodeIdentityValidationPort,
} from '@control-plane/runtime-gateway-protocol'

/** Gateway-only contract; the published protocol package keeps its legacy port stable. */
export type RuntimeNodeIdentityGatewayPort = Omit<
  RuntimeNodeIdentityValidationPort,
  'subscribeRevocations'
> & {
  consumeCredential(
    credentialId: string,
    revocationVersion: number,
    now: Date
  ): Promise<RuntimeNodeCredentialConsumptionResult>
  subscribeRevocations(
    listener: (invalidation: RuntimeNodeIdentityInvalidation) => void
  ): () => void
}
