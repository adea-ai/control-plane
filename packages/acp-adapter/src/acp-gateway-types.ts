import {
  type GatewayAcknowledgementEnvelope,
  type GatewayCommandEnvelope,
  type GatewayErrorEnvelope,
  type GatewayInventoryEnvelope,
  type GatewayProgressEnvelope,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import { z } from 'zod'
import type { QualifiedNativeRoute } from './native-route-qualification.js'

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
  /**
   * The qualified native route for this execution (M13.03, #1021).
   *
   * When it is absent the route is UNQUALIFIED: no capability claim is
   * advertised, no usage is reported, `session/resume` and `session/cancel`
   * are refused, and no governed native path is open. The route's claims come
   * from the deployment's qualification evidence, never from the native
   * driver's own advertisement.
   */
  readonly nativeRoute?: QualifiedNativeRoute
}
