import { randomUUID } from 'node:crypto'
import type { RuntimeNodeChannel } from './authentication.js'
import type {
  RuntimeGatewayWebSocketLifecycle,
  RuntimeGatewaySocket,
} from './websocket-lifecycle.js'

interface WebSocketUpgradeData {
  readonly connectionId: string
  readonly authenticatedChannel: RuntimeNodeChannel
}

interface NativeServerSocket {
  readonly data: WebSocketUpgradeData
  getBufferedAmount(): number
  send(value: string): unknown
  close(code: number, reason: string): void
}

interface NativeUpgradeServer {
  upgrade(request: Request, options: { readonly data: WebSocketUpgradeData }): boolean
}

interface NativeServeOptions {
  readonly hostname: string
  readonly port: number
  readonly fetch: (request: Request, server: NativeUpgradeServer) => Promise<Response | undefined>
  readonly websocket: {
    readonly maxPayloadLength: number
    readonly backpressureLimit: number
    readonly closeOnBackpressureLimit: true
    readonly idleTimeout: number
    readonly open: (socket: NativeServerSocket) => void
    readonly message: (
      socket: NativeServerSocket,
      message: string | ArrayBuffer | Uint8Array
    ) => Promise<void>
    readonly close: (socket: NativeServerSocket, code: number, reason: string) => Promise<void>
  }
}

interface NativeGatewayServer {
  stop(closeActiveConnections?: boolean): void | Promise<void>
}

export type RuntimeGatewayNativeServe = (options: NativeServeOptions) => NativeGatewayServer

export interface RuntimeGatewayWebSocketServerOptions {
  readonly lifecycle: RuntimeGatewayWebSocketLifecycle
  readonly authenticateUpgrade: (request: Request) => Promise<RuntimeNodeChannel>
  readonly hostname: string
  readonly port: number
  readonly limits: {
    readonly maxFrameBytes: number
    readonly maxBufferedBytes: number
    readonly idleTimeoutSeconds: number
  }
  readonly serve?: RuntimeGatewayNativeServe
  readonly sweepIntervalMs?: number
  readonly onSweepError?: () => void
}

export class RuntimeGatewayWebSocketServer {
  readonly #authenticateUpgrade: (request: Request) => Promise<RuntimeNodeChannel>
  readonly #hostname: string
  readonly #idleTimeoutSeconds: number
  readonly #lifecycle: RuntimeGatewayWebSocketLifecycle
  readonly #maxBufferedBytes: number
  readonly #maxFrameBytes: number
  readonly #port: number
  readonly #serve: RuntimeGatewayNativeServe
  #server: NativeGatewayServer | undefined
  readonly #sweepIntervalMs: number
  readonly #onSweepError: () => void
  #sweepTimer: ReturnType<typeof setTimeout> | undefined
  #sweepTask: Promise<void> | undefined
  #closing: Promise<void> | undefined

  constructor(options: RuntimeGatewayWebSocketServerOptions) {
    this.#lifecycle = options.lifecycle
    this.#authenticateUpgrade = options.authenticateUpgrade
    this.#hostname = options.hostname
    this.#port = options.port
    this.#maxFrameBytes = positiveInteger(options.limits.maxFrameBytes, 'maxFrameBytes')
    this.#maxBufferedBytes = positiveInteger(options.limits.maxBufferedBytes, 'maxBufferedBytes')
    this.#idleTimeoutSeconds = positiveInteger(
      options.limits.idleTimeoutSeconds,
      'idleTimeoutSeconds'
    )
    this.#serve = options.serve ?? nativeBunServe
    this.#sweepIntervalMs = positiveInteger(options.sweepIntervalMs ?? 1_000, 'sweepIntervalMs')
    if (this.#sweepIntervalMs > 60_000) throw new Error('Invalid sweepIntervalMs')
    this.#onSweepError =
      options.onSweepError ?? (() => console.error('RUNTIME_GATEWAY_SWEEP_FAILED'))
  }

  start(): void {
    if (this.#server !== undefined || this.#closing !== undefined)
      throw new Error('Runtime Gateway server is already started or closed')
    this.#server = this.#serve({
      hostname: this.#hostname,
      port: this.#port,
      fetch: (request, server) => this.#upgrade(request, server),
      websocket: {
        maxPayloadLength: this.#maxFrameBytes,
        backpressureLimit: this.#maxBufferedBytes,
        closeOnBackpressureLimit: true,
        idleTimeout: this.#idleTimeoutSeconds,
        open: (socket) => {
          this.#lifecycle.open({
            ...socket.data,
            socket: nativeSocketAdapter(socket),
          })
        },
        message: (socket, message) => this.#lifecycle.receive(socket.data.connectionId, message),
        close: (socket, code, reason) =>
          this.#lifecycle.closed(
            socket.data.connectionId,
            `peer_closed_${code}_${normalizeReason(reason)}`
          ),
      },
    })
    this.#scheduleSweep()
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing
    const server = this.#server
    if (server === undefined) return Promise.resolve()
    this.#server = undefined
    if (this.#sweepTimer !== undefined) clearTimeout(this.#sweepTimer)
    this.#closing = (async () => {
      await this.#sweepTask
      try {
        await this.#lifecycle.close()
      } finally {
        await server.stop(true)
      }
    })()
    return this.#closing
  }

  #scheduleSweep(): void {
    this.#sweepTimer = setTimeout(() => {
      this.#sweepTimer = undefined
      this.#sweepTask = Promise.resolve()
        .then(() => this.#lifecycle.sweep())
        .catch(() => {
          // Never forward raw persistence errors or let a reporting sink stop future sweeps.
          try {
            this.#onSweepError()
          } catch {
            /* callback failure is isolated */
          }
        })
        .finally(() => {
          this.#sweepTask = undefined
          if (this.#server !== undefined) this.#scheduleSweep()
        })
    }, this.#sweepIntervalMs)
    this.#sweepTimer.unref()
  }

  async #upgrade(request: Request, server: NativeUpgradeServer): Promise<Response | undefined> {
    if (this.#server === undefined) return new Response('Runtime Gateway draining', { status: 503 })
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.pathname !== '/runtime-gateway/v1/connect') {
      return new Response('Not Found', { status: 404 })
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 })
    }
    let authenticatedChannel: RuntimeNodeChannel
    try {
      authenticatedChannel = await this.#authenticateUpgrade(request)
    } catch {
      return new Response('RuntimeNode authentication rejected', { status: 401 })
    }
    if (this.#server === undefined) return new Response('Runtime Gateway draining', { status: 503 })
    const upgraded = server.upgrade(request, {
      data: { connectionId: `gwc_${randomUUID()}`, authenticatedChannel },
    })
    return upgraded ? undefined : new Response('WebSocket upgrade unavailable', { status: 503 })
  }
}

function nativeSocketAdapter(socket: NativeServerSocket): RuntimeGatewaySocket {
  return {
    bufferedAmount: () => socket.getBufferedAmount(),
    send: (value) => {
      socket.send(value)
    },
    close: (code, reason) => socket.close(code, reason),
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`)
  return value
}

function normalizeReason(reason: string): string {
  const normalized = reason.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return normalized.length === 0 ? 'none' : normalized
}

function nativeBunServe(options: NativeServeOptions): NativeGatewayServer {
  const runtime = (globalThis as unknown as { readonly Bun?: { serve: RuntimeGatewayNativeServe } })
    .Bun
  if (runtime === undefined) throw new Error('Runtime Gateway WebSocket server requires Bun')
  return runtime.serve(options)
}
