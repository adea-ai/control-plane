import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import {
  enforceNodeProcessSpawnPolicy,
  ProcessRpcDecodeError,
  ProcessRpcLink,
  type NodeProcessSpawnPolicy,
  type ProcessRpcFrameCodec,
} from '@control-plane/deployment'
import process from 'node:process'
import { z } from 'zod'

type Json = z.util.JSONType
type RpcParams = Record<string, Json> | Json[]
type RpcId = string | number
type AcpMessage = z.infer<typeof MessageSchema>

const MessageLimit = 1_048_576
const PendingLimit = 128
const IdSchema = z.union([z.string().max(256), z.number().int().safe()])
const MessageSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: IdSchema.optional(),
    method: z.string().min(1).max(256).optional(),
    params: z.union([z.record(z.string(), z.json()), z.array(z.json())]).optional(),
    result: z.json().optional(),
    error: z
      .object({ code: z.number().int(), message: z.string(), data: z.json().optional() })
      .optional(),
  })
  .strict()

/** Wire payload for link writes: outbound requests, notifications, and responses. */
interface AcpRequestPayload {
  readonly jsonrpc: '2.0'
  readonly id?: RpcId
  readonly method?: string
  readonly params?: RpcParams
  readonly result?: Json
  readonly error?: { readonly code: number; readonly message: string }
}

/**
 * JSON-RPC 2.0 framing for the shared process link. Every decode failure is a
 * fatal protocol error; late results and native server-to-client requests are
 * reported as unmatched lines and routed by the client.
 */
const AcpFrameCodec: ProcessRpcFrameCodec<AcpRequestPayload, Json, AcpMessage> = {
  encode: (payload, id) =>
    JSON.stringify(MessageSchema.parse(id === undefined ? payload : { ...payload, id })),
  decode: (line) => {
    let message: AcpMessage
    try {
      message = MessageSchema.parse(JSON.parse(line))
    } catch {
      throw new ProcessRpcDecodeError('ACP_PROCESS_PROTOCOL_ERROR')
    }
    if (message.method !== undefined) {
      if ('result' in message || message.error !== undefined) {
        throw new ProcessRpcDecodeError('ACP_PROCESS_PROTOCOL_ERROR')
      }
      return { kind: 'unmatched', message }
    }
    if (message.id === undefined || 'result' in message === (message.error !== undefined)) {
      throw new ProcessRpcDecodeError('ACP_PROCESS_PROTOCOL_ERROR')
    }
    if (message.error !== undefined) {
      return {
        kind: 'response',
        id: message.id,
        error: new Error(`ACP_PROCESS_RPC_ERROR:${message.error.code}`),
      }
    }
    return { kind: 'response', id: message.id, result: message.result ?? null }
  },
}

export interface AcpStdioClientOptions {
  readonly executablePath: string
  readonly args?: readonly string[]
  readonly cwd: string
  /** Explicit environment only: the parent environment is never inherited. */
  readonly environment: Readonly<Record<string, string>>
  /**
   * Bounded spawn policy (CP-RNODE-025): when set, process launches that
   * violate it are rejected before any process starts.
   */
  readonly spawnPolicy?: NodeProcessSpawnPolicy
  readonly onNotification: (method: string, params: Json) => void
  readonly onRequest: (id: RpcId, method: string, params: Json) => void
}

/** Bounded JSON-RPC framing only; native ACP session semantics belong to the transport. */
export class AcpStdioClient {
  readonly #options: AcpStdioClientOptions
  readonly #lateResults = new Map<RpcId, (value: Json) => void>()
  readonly #incoming = new Set<RpcId>()
  #link: ProcessRpcLink<AcpRequestPayload, Json, AcpMessage> | undefined
  #sequence = 0
  #started = false
  #failure: Error | undefined
  #close: Promise<void> | undefined

  constructor(options: AcpStdioClientOptions) {
    if (!isAbsolute(options.executablePath) || !isAbsolute(options.cwd)) {
      throw new Error('ACP_PROCESS_ABSOLUTE_PATH_REQUIRED')
    }
    this.#options = {
      ...options,
      args: [...(options.args ?? [])],
      environment: { ...options.environment },
    }
  }

  get connected(): boolean {
    return this.#link?.connected ?? false
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('ACP_PROCESS_ALREADY_STARTED')
    if (this.#failure) throw this.#failure
    this.#started = true
    if (this.#options.spawnPolicy !== undefined) {
      await enforceNodeProcessSpawnPolicy(this.#options.spawnPolicy, {
        executable: this.#options.executablePath,
        args: this.#options.args ?? [],
        environment: this.#options.environment,
        cwd: this.#options.cwd,
      })
    }
    const child = spawn(this.#options.executablePath, [...(this.#options.args ?? [])], {
      cwd: this.#options.cwd,
      env: { ...this.#options.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.#link = new ProcessRpcLink({
      child,
      codec: AcpFrameCodec,
      maxFrameBytes: MessageLimit,
      writeLimitBytes: MessageLimit,
      formatFrameError: () => new Error('ACP_PROCESS_PROTOCOL_ERROR'),
      formatExitError: () => new Error('ACP_PROCESS_CLOSED'),
      formatTimeoutError: () => new Error('ACP_PROCESS_REQUEST_TIMEOUT'),
      formatAbortError: () => new Error('ACP_PROCESS_ABORTED'),
      formatChildError: () => new Error('ACP_PROCESS_START_FAILED'),
      notRunningError: () => new Error('ACP_PROCESS_NOT_STARTED'),
      onStdinError: () => this.#link?.fail(new Error('ACP_PROCESS_WRITE_FAILED')),
      onLine: (message) => this.#route(message),
      onFail: (error) => {
        this.#failure ??= error
        this.#incoming.clear()
        this.#lateResults.clear()
      },
      onResponseMiss: (id, response) => {
        const lateResult = this.#lateResults.get(id)
        this.#lateResults.delete(id)
        if (response.error === undefined) lateResult?.(response.result ?? null)
      },
      signalStrategy: 'process-group',
      protocolFailureSignal: 'SIGTERM',
      unrefStopTimers: false,
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', () => reject(new Error('ACP_PROCESS_START_FAILED')))
    })
  }

  request(
    method: string,
    params: RpcParams,
    options: { timeoutMs?: number; signal?: AbortSignal; onLateResult?: (value: Json) => void } = {}
  ): Promise<Json> {
    const timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
      return Promise.reject(new Error('ACP_PROCESS_INVALID_TIMEOUT'))
    }
    const link = this.#link
    if (link === undefined || !link.connected) {
      return Promise.reject(this.#failure ?? link?.failure ?? new Error('ACP_PROCESS_NOT_STARTED'))
    }
    if (options.signal?.aborted) return Promise.reject(new Error('ACP_PROCESS_ABORTED'))
    if (link.pendingCount >= PendingLimit) {
      return Promise.reject(new Error('ACP_PROCESS_BACKPRESSURE'))
    }
    if (options.onLateResult !== undefined && this.#lateResults.size >= PendingLimit) {
      return Promise.reject(new Error('ACP_PROCESS_LATE_RESULT_LIMIT'))
    }
    const id = `cp:${++this.#sequence}`
    if (options.onLateResult !== undefined) this.#lateResults.set(id, options.onLateResult)
    return link.request(
      { jsonrpc: '2.0', method, params },
      {
        id,
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onSettled: (reason) => {
          // Timeouts and aborts keep the late-result registration alive so a
          // straggling response still reaches onLateResult exactly once.
          if (reason !== 'timeout' && reason !== 'abort') this.#lateResults.delete(id)
        },
      }
    )
  }

  notify(method: string, params: RpcParams): void {
    this.#requireLink().write({ jsonrpc: '2.0', method, params })
  }

  respond(id: RpcId, result: Json): void {
    if (!this.#incoming.has(id)) throw new Error('ACP_PROCESS_REQUEST_UNKNOWN')
    this.#requireLink().write({ jsonrpc: '2.0', id, result })
    this.#incoming.delete(id)
  }

  respondError(id: RpcId, code: number, message: string): void {
    if (!this.#incoming.has(id)) throw new Error('ACP_PROCESS_REQUEST_UNKNOWN')
    this.#requireLink().write({ jsonrpc: '2.0', id, error: { code, message } })
    this.#incoming.delete(id)
  }

  close(): Promise<void> {
    this.#close ??= this.#stop()
    return this.#close
  }

  async #stop(): Promise<void> {
    const link = this.#link
    if (link === undefined) {
      this.#failure ??= new Error('ACP_PROCESS_CLOSING')
      return
    }
    const confirmed = await link.stop({
      failure: new Error('ACP_PROCESS_CLOSING'),
      graceMs: 2_000,
      finalWaitMs: 2_000,
    })
    if (!confirmed) throw new Error('ACP_PROCESS_CLEANUP_UNCONFIRMED')
  }

  #requireLink(): ProcessRpcLink<AcpRequestPayload, Json, AcpMessage> {
    const link = this.#link
    if (link === undefined) throw new Error('ACP_PROCESS_NOT_STARTED')
    return link
  }

  #route(message: AcpMessage): void {
    try {
      this.#deliver(message)
    } catch {
      // Every routing failure is a protocol failure; the cause stays internal.
      throw new ProcessRpcDecodeError('ACP_PROCESS_PROTOCOL_ERROR')
    }
  }

  #deliver(message: AcpMessage): void {
    if (message.method === undefined) return
    if (message.id === undefined) {
      this.#options.onNotification(message.method, message.params ?? null)
      return
    }
    if (this.#incoming.has(message.id) || this.#incoming.size >= PendingLimit) {
      throw new Error('ACP_PROCESS_BACKPRESSURE')
    }
    this.#incoming.add(message.id)
    this.#options.onRequest(message.id, message.method, message.params ?? null)
  }
}
