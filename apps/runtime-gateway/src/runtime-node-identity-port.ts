import type {
  RuntimeNodeCredentialConsumptionResult,
  RuntimeNodeIdentityInvalidation,
  RuntimeNodeIdentityValidationPort,
} from '@control-plane/runtime-gateway-protocol'

/**
 * The scope and generation a presenting channel asserts. PostgreSQL checks it against the canonical
 * credential and channel owner inside the consumption transaction. In-memory authorities have no
 * canonical owner table and do not enforce it; production identity is PostgreSQL.
 */
export interface RuntimeNodeCredentialBinding {
  readonly nodeId: string
  readonly workspaceId: string
  readonly channelGeneration: number
}

/** Protocol consumption outcomes plus the canonical binding rejections. A rejection never consumes. */
export type RuntimeNodeCredentialGatewayConsumption =
  | RuntimeNodeCredentialConsumptionResult
  | 'node_mismatch'
  | 'workspace_mismatch'
  | 'superseded'

/** Gateway-only contract; the published protocol package keeps its legacy port stable. */
export type RuntimeNodeIdentityGatewayPort = Omit<
  RuntimeNodeIdentityValidationPort,
  'subscribeRevocations'
> & {
  consumeCredential(
    credentialId: string,
    revocationVersion: number,
    now: Date,
    binding?: RuntimeNodeCredentialBinding
  ): Promise<RuntimeNodeCredentialGatewayConsumption>
  subscribeRevocations(
    listener: (invalidation: RuntimeNodeIdentityInvalidation) => void
  ): () => void
}
