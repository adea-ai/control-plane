import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

type Json = z.util.JSONType
type RpcParams = Record<string, Json> | Json[]
type RpcId = string | number
type Pending = { resolve(value: Json): void; reject(error: Error): void }
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

export interface AcpStdioClientOptions {
  readonly executablePath: string
  readonly args?: readonly string[]
  readonly cwd: string
  /** Explicit environment only: the parent environment is never inherited. */
  readonly environment: Readonly<Record<string, string>>
  readonly onNotification: (method: string, params: Json) => void
  readonly onRequest: (id: RpcId, method: string, params: Json) => void
}

/** Bounded JSON-RPC framing only; native ACP session semantics belong to the transport. */
export class AcpStdioClient {
  readonly #options: AcpStdioClientOptions
  readonly #pending = new Map<RpcId, Pending>()
  readonly #incoming = new Set<RpcId>()
  #child: ChildProcessWithoutNullStreams | undefined
  #buffer = Buffer.alloc(0)
  #sequence = 0
  #started = false
  #lastSignal?: NodeJS.Signals
  #failure?: Error
  #closed: Promise<void> = Promise.resolve()
  #close?: Promise<void>

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
    return this.#child !== undefined && this.#failure === undefined
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('ACP_PROCESS_ALREADY_STARTED')
    if (this.#failure) throw this.#failure
    this.#started = true
    const child = spawn(this.#options.executablePath, [...(this.#options.args ?? [])], {
      cwd: this.#options.cwd,
      env: { ...this.#options.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.#child = child
    this.#closed = new Promise((resolve) => {
      child.once('close', () => {
        this.#fail(new Error('ACP_PROCESS_CLOSED'))
        this.#child = undefined
        resolve()
      })
    })
    child.stderr.resume()
    child.stdin.on('error', () => this.#fail(new Error('ACP_PROCESS_WRITE_FAILED')))
    child.stdout.on('data', (chunk: Buffer) => this.#read(chunk))
    child.on('error', () => this.#fail(new Error('ACP_PROCESS_START_FAILED')))
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', () => reject(new Error('ACP_PROCESS_START_FAILED')))
    })
  }

  request(
    method: string,
    params: RpcParams,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<Json> {
    const timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
      return Promise.reject(new Error('ACP_PROCESS_INVALID_TIMEOUT'))
    }
    if (!this.connected)
      return Promise.reject(this.#failure ?? new Error('ACP_PROCESS_NOT_STARTED'))
    if (options.signal?.aborted) return Promise.reject(new Error('ACP_PROCESS_ABORTED'))
    if (this.#pending.size >= PendingLimit)
      return Promise.reject(new Error('ACP_PROCESS_BACKPRESSURE'))
    const id = `cp:${++this.#sequence}`
    return new Promise((resolve, reject) => {
      const finish = (callback: () => void) => {
        if (!this.#pending.delete(id)) return
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', aborted)
        callback()
      }
      const aborted = () => finish(() => reject(new Error('ACP_PROCESS_ABORTED')))
      const timer = setTimeout(
        () => finish(() => reject(new Error('ACP_PROCESS_REQUEST_TIMEOUT'))),
        timeoutMs
      )
      timer.unref()
      this.#pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      })
      options.signal?.addEventListener('abort', aborted, { once: true })
      try {
        this.#write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.#pending
          .get(id)
          ?.reject(error instanceof Error ? error : new Error('ACP_PROCESS_WRITE_FAILED'))
      }
    })
  }

  notify(method: string, params: RpcParams): void {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  respond(id: RpcId, result: Json): void {
    if (!this.#incoming.has(id)) throw new Error('ACP_PROCESS_REQUEST_UNKNOWN')
    this.#write({ jsonrpc: '2.0', id, result })
    this.#incoming.delete(id)
  }

  respondError(id: RpcId, code: number, message: string): void {
    if (!this.#incoming.has(id)) throw new Error('ACP_PROCESS_REQUEST_UNKNOWN')
    this.#write({ jsonrpc: '2.0', id, error: { code, message } })
    this.#incoming.delete(id)
  }

  close(): Promise<void> {
    this.#close ??= this.#stop()
    return this.#close
  }

  async #stop(): Promise<void> {
    this.#fail(new Error('ACP_PROCESS_CLOSING'))
    if (!this.#child) return
    this.#signal('SIGTERM')
    if (await this.#waitClosed(2_000)) return
    this.#signal('SIGKILL')
    if (!(await this.#waitClosed(2_000))) throw new Error('ACP_PROCESS_CLEANUP_UNCONFIRMED')
  }

  async #waitClosed(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.#closed.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  #signal(signal: NodeJS.Signals): void {
    const child = this.#child
    if (!child?.pid) return
    if (this.#lastSignal === signal) return
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
      this.#lastSignal = signal
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  #write(message: unknown): void {
    if (!this.connected) throw this.#failure ?? new Error('ACP_PROCESS_NOT_STARTED')
    const encoded = `${JSON.stringify(MessageSchema.parse(message))}\n`
    if (Buffer.byteLength(encoded) > MessageLimit) throw new Error('ACP_PROCESS_MESSAGE_TOO_LARGE')
    const child = this.#child!
    if (child.stdin.writableLength + Buffer.byteLength(encoded) > MessageLimit) {
      throw new Error('ACP_PROCESS_BACKPRESSURE')
    }
    child.stdin.write(encoded)
  }

  #read(chunk: Buffer): void {
    if (this.#failure) return
    try {
      // Split before concatenating so many small valid frames do not count as one frame.
      let start = 0
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        this.#append(chunk.subarray(start, end))
        const line = new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer)
        this.#buffer = Buffer.alloc(0)
        this.#message(JSON.parse(line))
        if (this.#failure) return
        start = end + 1
      }
      this.#append(chunk.subarray(start))
    } catch {
      this.#fail(new Error('ACP_PROCESS_PROTOCOL_ERROR'))
      this.#signal('SIGTERM')
    }
  }

  #append(chunk: Buffer): void {
    if (this.#buffer.length + chunk.length > MessageLimit)
      throw new Error('ACP_PROCESS_MESSAGE_TOO_LARGE')
    this.#buffer = Buffer.concat([this.#buffer, chunk])
  }

  #message(input: unknown): void {
    const message = MessageSchema.parse(input)
    if (message.method !== undefined) {
      if ('result' in message || message.error !== undefined)
        throw new Error('ACP_PROCESS_PROTOCOL_ERROR')
      if (message.id === undefined)
        this.#options.onNotification(message.method, message.params ?? null)
      else {
        if (this.#incoming.has(message.id) || this.#incoming.size >= PendingLimit)
          throw new Error('ACP_PROCESS_BACKPRESSURE')
        this.#incoming.add(message.id)
        this.#options.onRequest(message.id, message.method, message.params ?? null)
      }
      return
    }
    if (message.id === undefined || 'result' in message === (message.error !== undefined)) {
      throw new Error('ACP_PROCESS_PROTOCOL_ERROR')
    }
    const pending = this.#pending.get(message.id)
    if (!pending) return // Late responses after timeout/abort are not new effects.
    if (message.error) pending.reject(new Error(`ACP_PROCESS_RPC_ERROR:${message.error.code}`))
    else pending.resolve(message.result ?? null)
  }

  #fail(error: Error): void {
    this.#failure ??= error
    for (const pending of this.#pending.values()) pending.reject(this.#failure)
    this.#incoming.clear()
    this.#buffer = Buffer.alloc(0)
  }
}
