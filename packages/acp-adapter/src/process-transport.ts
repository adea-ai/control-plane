import { z } from 'zod'
import { AcpStdioClient, type AcpStdioClientOptions } from './stdio-client.js'
import {
  AcpSnapshotSchema,
  AcpUpdateSchema,
  type AcpSnapshot,
  type AcpTransport,
  type AcpUpdate,
} from './index.js'

type Json = z.util.JSONType
const SessionId = z.string().min(1).max(512)
const SessionParams = z.object({ sessionId: SessionId }).passthrough()
const Usage = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .passthrough()
const PromptResult = z
  .object({
    stopReason: z.enum(['end_turn', 'cancelled', 'refusal', 'max_tokens', 'max_turn_requests']),
    usage: Usage.optional(),
  })
  .passthrough()
type Session = {
  snapshot: AcpSnapshot
  updates: AcpUpdate[]
  nativeUpdates: Json[]
  bytes: number
  text: string
  wake: Set<() => void>
  turn?: Promise<void>
  startedAt: number
  cancelRequested: boolean
}

export interface AcpProcessTransportOptions extends Omit<
  AcpStdioClientOptions,
  'onRequest' | 'onNotification'
> {
  readonly mcpServers?: readonly Json[]
  readonly turnTimeoutMs?: number
  readonly requestTimeoutMs?: number
}

/** Native v1 wire translation. Use an AcpDriver explicitly configured for protocolVersion 1. */
export class AcpProcessTransport implements AcpTransport {
  readonly #rpc: AcpStdioClient
  readonly #options: AcpProcessTransportOptions
  readonly #sessions = new Map<string, Session>()
  readonly #creates = new Map<string, Promise<{ sessionId: string }>>()
  readonly #permissions = new Map<number, { nativeId: string | number; sessionId: string }>()
  #permissionSequence = 0

  constructor(options: AcpProcessTransportOptions) {
    for (const timeout of [options.turnTimeoutMs ?? 300_000, options.requestTimeoutMs ?? 30_000]) {
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000)
        throw new Error('ACP_NATIVE_INVALID_TIMEOUT')
    }
    this.#options = { ...options, mcpServers: structuredClone(options.mcpServers ?? []) }
    this.#rpc = new AcpStdioClient({
      ...options,
      onNotification: (method, params) => this.#notification(method, params),
      onRequest: (id, method, params) => this.#permission(id, method, params),
    })
  }

  open(): Promise<void> {
    return this.#rpc.start()
  }
  connectionState(): 'connected' | 'disconnected' {
    return this.#rpc.connected ? 'connected' : 'disconnected'
  }

  async close(): Promise<void> {
    await this.#rpc.close()
    for (const session of this.#sessions.values()) {
      if (session.snapshot.state === 'running' || session.snapshot.state === 'starting')
        this.#fail(session, 'ACP_NATIVE_PROCESS_CLOSED')
    }
    this.#permissions.clear()
  }

  createSession(createToken: string, signal?: AbortSignal): Promise<{ sessionId: string }> {
    const existing = this.#creates.get(createToken)
    if (existing) return existing
    if (this.#creates.size >= 128) return Promise.reject(new Error('ACP_NATIVE_SESSION_LIMIT'))
    const created = this.#newSession(signal)
    // Retain rejected outcomes too: a lost response must not trigger a second create.
    this.#creates.set(createToken, created)
    return created
  }

  async #newSession(signal?: AbortSignal): Promise<{ sessionId: string }> {
    const response = await this.#rpc.request(
      'session/new',
      {
        cwd: this.#options.cwd,
        mcpServers: [...(this.#options.mcpServers ?? [])],
      },
      this.#requestOptions(signal)
    )
    const { sessionId } = z.object({ sessionId: SessionId }).passthrough().parse(response)
    if (this.#sessions.has(sessionId)) throw new Error('ACP_NATIVE_SESSION_ID_REUSED')
    this.#sessions.set(sessionId, {
      snapshot: { state: 'starting', observedAt: new Date().toISOString() },
      updates: [],
      nativeUpdates: [],
      bytes: 0,
      text: '',
      wake: new Set(),
      startedAt: 0,
      cancelRequested: false,
    })
    return { sessionId }
  }

  async request(
    method: string,
    params: Record<string, Json>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error('ACP_NATIVE_ABORTED')
    if (method === 'session/prompt') {
      const { sessionId } = SessionParams.parse(params)
      const session = this.#session(sessionId)
      if (session.turn) throw new Error('ACP_NATIVE_TURN_ALREADY_STARTED')
      session.startedAt = Date.now()
      session.snapshot = { state: 'running', observedAt: new Date().toISOString() }
      this.#push(session, { sessionUpdate: 'state_update', state: 'running' })
      session.turn = this.#rpc
        .request(method, params, { timeoutMs: this.#options.turnTimeoutMs ?? 300_000 })
        .then((result) => this.#complete(session, result))
        .catch(() => this.#fail(session, 'ACP_NATIVE_OUTCOME_UNCERTAIN'))
      return {} // Local dispatch acknowledgement, not the final native prompt response.
    }
    if (method === 'session/cancel') {
      const { sessionId } = SessionParams.parse(params)
      this.#session(sessionId).cancelRequested = true
      this.#cancelPermissions(sessionId)
      this.#rpc.notify(method, params)
      return {}
    }
    return this.#rpc.request(method, params, this.#requestOptions(signal))
  }

  async respond(
    requestId: number,
    result: Record<string, Json>,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error('ACP_NATIVE_ABORTED')
    const permission = this.#permissions.get(requestId)
    if (!permission) throw new Error('ACP_NATIVE_PERMISSION_UNKNOWN')
    this.#rpc.respond(permission.nativeId, result)
    this.#permissions.delete(requestId)
  }

  async *updates(nativeSessionId: string, signal?: AbortSignal): AsyncIterable<AcpUpdate> {
    const session = this.#session(nativeSessionId)
    let index = 0
    while (true) {
      if (signal?.aborted) return
      while (index < session.updates.length) {
        if (signal?.aborted) return
        yield structuredClone(session.updates[index++]!)
      }
      if (session.snapshot.state !== 'starting' && session.snapshot.state !== 'running') return
      await new Promise<void>((resolve) => {
        const wake = () => {
          session.wake.delete(wake)
          signal?.removeEventListener('abort', wake)
          resolve()
        }
        session.wake.add(wake)
        signal?.addEventListener('abort', wake, { once: true })
        if (signal?.aborted) wake()
      })
    }
  }

  async snapshot(nativeSessionId: string, signal?: AbortSignal): Promise<AcpSnapshot> {
    if (signal?.aborted) throw new Error('ACP_NATIVE_ABORTED')
    return structuredClone(this.#session(nativeSessionId).snapshot)
  }

  async cleanup(nativeSessionId: string, signal?: AbortSignal): Promise<void> {
    const session = this.#session(nativeSessionId)
    if (session.snapshot.state === 'running') {
      await this.request('session/cancel', { sessionId: nativeSessionId }, signal)
      if (session.turn) await session.turn
      const settled = await this.snapshot(nativeSessionId, signal)
      if (settled.state !== 'cancelled' && settled.state !== 'completed')
        throw new Error('ACP_NATIVE_CLEANUP_UNCONFIRMED')
    }
    this.#cancelPermissions(nativeSessionId)
  }

  #requestOptions(signal?: AbortSignal) {
    return { timeoutMs: this.#options.requestTimeoutMs ?? 30_000, ...(signal ? { signal } : {}) }
  }

  #session(id: string): Session {
    const session = this.#sessions.get(id)
    if (!session) throw new Error('ACP_NATIVE_SESSION_UNKNOWN')
    return session
  }

  #notification(method: string, params: Json): void {
    if (method !== 'session/update') return
    const envelope = z
      .object({ sessionId: SessionId, update: z.record(z.string(), z.json()) })
      .passthrough()
      .parse(params)
    const session = this.#session(envelope.sessionId)
    const update = envelope.update
    const size = Buffer.byteLength(JSON.stringify(update))
    if (session.bytes + size > 4_194_304 || session.nativeUpdates.length >= 4096)
      throw new Error('ACP_NATIVE_OUTPUT_LIMIT')
    session.bytes += size
    session.nativeUpdates.push(update)
    if (update['sessionUpdate'] === 'agent_message_chunk') {
      const content = z
        .object({ type: z.literal('text'), text: z.string() })
        .passthrough()
        .safeParse(update['content'])
      if (content.success) {
        if (Buffer.byteLength(session.text) + Buffer.byteLength(content.data.text) > 1_048_576)
          throw new Error('ACP_NATIVE_OUTPUT_LIMIT')
        session.text += content.data.text
        this.#push(session, {
          sessionUpdate: 'agent_message_chunk',
          messageId:
            typeof update['messageId'] === 'string'
              ? update['messageId']
              : `local-chunk:${session.nativeUpdates.length}`,
          text: content.data.text,
        })
      }
    }
    // Other native events remain in the result transcript; context usage is not billable usage.
  }

  #permission(nativeId: string | number, method: string, params: Json): void {
    if (method !== 'session/request_permission') {
      this.#rpc.respondError(nativeId, -32601, 'Method not supported')
      return
    }
    const input = z
      .object({
        sessionId: SessionId,
        toolCall: z.object({ toolCallId: z.string(), title: z.string().optional() }).passthrough(),
        options: z
          .array(z.object({ optionId: z.string(), kind: z.string() }).passthrough())
          .max(32),
      })
      .passthrough()
      .parse(params)
    const session = this.#session(input.sessionId)
    if (session.cancelRequested) {
      this.#rpc.respond(nativeId, { outcome: { outcome: 'cancelled' } })
      return
    }
    const options = input.options.flatMap<{ optionId: string; kind: 'allow_once' | 'reject' }>(
      (option) =>
        option.kind === 'allow_once'
          ? [{ optionId: option.optionId, kind: 'allow_once' as const }]
          : option.kind === 'reject_once'
            ? [{ optionId: option.optionId, kind: 'reject' as const }]
            : []
    )
    if (!options.length) {
      this.#rpc.respond(nativeId, { outcome: { outcome: 'cancelled' } })
      return
    }
    const requestId = ++this.#permissionSequence
    this.#permissions.set(requestId, { nativeId, sessionId: input.sessionId })
    this.#push(session, {
      sessionUpdate: 'request_permission',
      requestId,
      toolCallId: input.toolCall.toolCallId,
      title: input.toolCall.title ?? 'Native tool permission',
      options,
    })
  }

  #cancelPermissions(sessionId: string): void {
    for (const [id, permission] of this.#permissions) {
      if (permission.sessionId !== sessionId) continue
      this.#rpc.respond(permission.nativeId, { outcome: { outcome: 'cancelled' } })
      this.#permissions.delete(id)
    }
  }

  #complete(session: Session, input: Json): void {
    const result = PromptResult.parse(input)
    const observedAt = new Date().toISOString()
    if (result.stopReason === 'cancelled') session.snapshot = { state: 'cancelled', observedAt }
    else if (result.stopReason !== 'end_turn') {
      this.#fail(session, 'ACP_NATIVE_TURN_INCOMPLETE')
      return
    } else if (!result.usage) {
      this.#fail(session, 'ACP_NATIVE_USAGE_UNAVAILABLE')
      return
    } else {
      const usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        durationMs: Math.max(0, Date.now() - session.startedAt),
      }
      session.snapshot = AcpSnapshotSchema.parse({
        state: 'completed',
        observedAt,
        usage,
        artifacts: [],
        output: {
          text: session.text,
          nativeUpdates: session.nativeUpdates,
          nativeUsage: result.usage,
        },
      })
      this.#push(session, { sessionUpdate: 'usage_update', ...usage })
    }
    this.#push(session, {
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason: result.stopReason,
    })
  }

  #push(session: Session, update: AcpUpdate): void {
    if (session.updates.length >= 4096) throw new Error('ACP_NATIVE_UPDATE_LIMIT')
    session.updates.push(AcpUpdateSchema.parse(update))
    for (const wake of session.wake) wake()
  }

  #fail(session: Session, code: string): void {
    session.snapshot = {
      state: 'failed',
      observedAt: new Date().toISOString(),
      error: { code, message: code, classification: 'unknown', retryable: false },
    }
    for (const wake of session.wake) wake()
  }
}
