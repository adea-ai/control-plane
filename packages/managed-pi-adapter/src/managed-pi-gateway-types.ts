import {
  type GatewayAcknowledgementEnvelope,
  type GatewayCommandEnvelope,
  type GatewayErrorEnvelope,
  type GatewayInventoryEnvelope,
  type GatewayProgressEnvelope,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'

export type ManagedPiGatewayConnectionState = 'online' | 'offline' | 'revoked'
export type LocalProjectGrantState = 'granted' | 'missing' | 'revoked'

export interface ManagedPiGatewayExchange {
  readonly ack: GatewayAcknowledgementEnvelope
  readonly progress: readonly GatewayProgressEnvelope[]
  readonly result?: GatewayResultEnvelope
  readonly error?: GatewayErrorEnvelope
}

export interface ManagedPiGatewayTransport {
  inventory(): Promise<GatewayInventoryEnvelope>
  connectionState(): ManagedPiGatewayConnectionState
  grantState(grantRef: string): LocalProjectGrantState
  dispatch(command: GatewayCommandEnvelope): Promise<ManagedPiGatewayExchange>
}

export interface ManagedPiGatewayClientOptions {
  readonly transport: ManagedPiGatewayTransport
  readonly nodeId: string
  readonly workspaceId: string
  readonly runtimeConnectionId: string
  readonly executionId: string
  readonly traceId: string
  readonly runtimeOpaqueRef: string
  readonly localProjectGrantRef: string
  readonly commandId: (identity: string) => string
  readonly now?: () => Date
  readonly commandTtlMs?: number
}
