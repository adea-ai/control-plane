import {
  type GatewayAcknowledgementEnvelope,
  type GatewayCommandEnvelope,
  type GatewayErrorEnvelope,
  type GatewayInventoryEnvelope,
  type GatewayProgressEnvelope,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import { z } from 'zod'

// Shared inside the gateway modules only; gateway.ts does not re-export these.
export const MaximumGatewayOperations = 1_024
export const SessionReferenceSchema = z
  .string()
  .regex(/^nses_[0-9A-HJKMNP-TV-Z]{26}$/, 'Expected an opaque ACP session reference')
export const NativeSessionIdSchema = z.string().min(1).max(512)
export type AcpGatewayConnectionState = 'online' | 'offline' | 'revoked'
export type AcpLocalProjectGrantState = 'granted' | 'missing' | 'revoked'

export interface AcpGatewayExchange {
  readonly ack: GatewayAcknowledgementEnvelope
  readonly progress: readonly GatewayProgressEnvelope[]
  readonly result?: GatewayResultEnvelope
  readonly error?: GatewayErrorEnvelope
}

export interface AcpGatewayTransport {
  inventory(signal?: AbortSignal): Promise<GatewayInventoryEnvelope>
  connectionState(): AcpGatewayConnectionState
  grantState(grantRef: string): AcpLocalProjectGrantState
  dispatch(command: GatewayCommandEnvelope, signal?: AbortSignal): Promise<AcpGatewayExchange>
}

export interface AcpGatewayClientOptions {
  readonly transport: AcpGatewayTransport
  readonly nodeId: string
  readonly workspaceId: string
  readonly runtimeConnectionId: string
  readonly executionId: string
  readonly attemptId: string
  readonly traceId: string
  readonly runtimeOpaqueRef: string
  readonly localProjectGrantRef: string
  readonly commandId: (identity: string) => string
  readonly now?: () => Date
  readonly commandTtlMs?: number
  readonly requestTimeoutMs?: number
}
