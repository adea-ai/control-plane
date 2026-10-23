import {
  RuntimeStartRequestSchema,
  projectExternalSessionDiscovery,
  type ExternalSession,
  type ExternalSessionRegistry,
  type RuntimeConnection,
  type RuntimeSessionOperation,
  type RuntimeTransport,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { type AcpSnapshot, type AcpUpdate } from './acp-schemas.js'
import type { NativeRouteGate } from './native-route-gate.js'

export interface AcpTransportCall {
  readonly method: string
  readonly params: Record<string, z.util.JSONType>
}

export interface AcpTransport {
  // Transport implementations normalize native updates, results, and lifecycle
  // operations to this interface; initialize retains the selected wire version.
  connectionState(): 'connected' | 'disconnected'
  /** Repeating a create token must return the same native session. */
  createSession(createToken: string, signal?: AbortSignal): Promise<{ readonly sessionId: string }>
  request(
    method: string,
    params: Record<string, z.util.JSONType>,
    signal?: AbortSignal
  ): Promise<unknown>
  respond(
    requestId: number,
    result: Record<string, z.util.JSONType>,
    signal?: AbortSignal
  ): Promise<void>
  updates(nativeSessionId: string, signal?: AbortSignal): AsyncIterable<AcpUpdate>
  snapshot(nativeSessionId: string, signal?: AbortSignal): Promise<AcpSnapshot>
  cleanup(nativeSessionId: string, signal?: AbortSignal): Promise<void>
  replay?(
    nativeSessionId: string,
    options?: { readonly afterSequence?: number; readonly signal?: AbortSignal }
  ): Promise<AcpSessionReplay>
  replaySupport?(): boolean
}

export interface AcpSessionReplay {
  readonly updates: readonly AcpUpdate[]
  readonly nativeUpdates?: readonly z.util.JSONType[]
  readonly completeness: 'complete' | 'partial' | 'unavailable'
}

export interface AcpExternalSessionsOptions {
  readonly registry: ExternalSessionRegistry
  readonly runtimeConnection: () => RuntimeConnection
  readonly nodeStatus: () => 'online' | 'offline' | 'unknown' | 'revoked' | 'not_applicable'
  readonly workspaceId: string
  readonly projectId?: string
  readonly opaqueNativeSessionId: (nativeSessionId: string) => string
  readonly resolveNativeSessionId: (opaqueNativeSessionId: string) => Promise<string | undefined>
  readonly capabilityTtlMs: number
  readonly authorize: (
    operation: RuntimeSessionOperation['operation'],
    session?: ExternalSession
  ) => Promise<boolean>
  readonly publishDiscovery?: (input: {
    readonly scope: {
      readonly workspaceId: string
      readonly projectId?: string
      readonly runtimeNodeRefId?: string
    }
    readonly model: ReturnType<typeof projectExternalSessionDiscovery>
  }) => Promise<void>
}

export interface AcpDriverOptions {
  readonly transport: AcpTransport
  readonly adapterVersion: string
  readonly externalSessionId: (nativeSessionId: string) => string
  readonly interactionId: (nativeRequestId: number) => string
  /** Resolve authorized task content before creating a native session. No external effects. */
  readonly resolvePrompt?: (
    request: ReturnType<typeof RuntimeStartRequestSchema.parse>,
    signal: AbortSignal
  ) => Promise<string>
  readonly now?: () => Date
  readonly protocolVersion?: number
  readonly requestTimeoutMs?: number
  readonly externalSessions?: AcpExternalSessionsOptions
  /**
   * Optional native route gate (M13.03.1). When present the driver consults
   * the evaluated qualification instead of declaring capabilities, usage
   * claims or governed native paths directly; an unqualified route stays
   * fail-closed. Omitted only by drivers that are not native executor routes.
   */
  readonly nativeRouteGate?: NativeRouteGate
}

export interface AcpAdapterOptions {
  readonly transport: RuntimeTransport
}
