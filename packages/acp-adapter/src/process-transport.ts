import { z } from 'zod'
import { AcpStdioClient, type AcpStdioClientOptions } from './stdio-client.js'
import {
  AcpSnapshotSchema,
  AcpUpdateSchema,
  type AcpSnapshot,
  type AcpSessionReplay,
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
  closing?: Promise<void>
  resuming?: Promise<unknown>
  resumePending?: boolean
  closed?: boolean
  closeRequested?: boolean
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
  readonly #pendingCreates = new Set<string>()
  readonly #earlyUpdates = new Map<string, Json[]>()
  #creating = 0
  #earlyBytes = 0
  #earlyCount = 0
  readonly #permissions = new Map<number, { nativeId: string | number; sessionId: string }>()
  #permissionSequence = 0
  #supportsClose = false
  #supportsLoad = false
  readonly #replays = new Map<string, { promise: Promise<void>; updates: Json[]; bytes: number }>()

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
    if (!z.string().min(1).max(256).safeParse(createToken).success)
      return Promise.reject(new Error('ACP_NATIVE_CREATE_TOKEN_INVALID'))
    if (signal?.aborted) return Promise.reject(new Error('ACP_NATIVE_ABORTED'))
    const existing = this.#creates.get(createToken)
    if (existing) return existing
    if (this.#creates.size >= 128) return Promise.reject(new Error('ACP_NATIVE_SESSION_LIMIT'))
    const created = this.#newSession(createToken, signal)
    // Retain rejected outcomes too: a lost response must not trigger a second create.
    this.#creates.set(createToken, created)
    return created
  }

  async #newSession(createToken: string, signal?: AbortSignal): Promise<{ sessionId: string }> {
    if (this.#sessions.size + this.#pendingCreates.size >= 128)
      throw new Error('ACP_NATIVE_SESSION_LIMIT')
    this.#pendingCreates.add(createToken)
    this.#creating += 1
    try {
      const response = await this.#rpc.request(
        'session/new',
        {
          cwd: this.#options.cwd,
          mcpServers: [...(this.#options.mcpServers ?? [])],
        },
        {
          ...this.#requestOptions(signal),
          onLateResult: (value) => {
            const recovered = this.#acceptCreatedSession(value, createToken)
            this.#creates.set(createToken, Promise.resolve(recovered))
          },
        }
      )
      return this.#acceptCreatedSession(response, createToken)
    } finally {
      this.#creating -= 1
      if (this.#creating === 0 && this.#pendingCreates.size === 0) {
        this.#earlyUpdates.clear()
        this.#earlyBytes = 0
        this.#earlyCount = 0
      }
    }
  }

  #acceptCreatedSession(response: Json, createToken: string): { sessionId: string } {
    const { sessionId } = z.object({ sessionId: SessionId }).passthrough().parse(response)
    if (this.#sessions.has(sessionId)) throw new Error('ACP_NATIVE_SESSION_ID_REUSED')
    this.#registerSession(sessionId)
    this.#pendingCreates.delete(createToken)
    const early = this.#earlyUpdates.get(sessionId) ?? []
    this.#earlyUpdates.delete(sessionId)
    for (const params of early) this.#notification('session/update', params)
    if (this.#creating === 0 && this.#pendingCreates.size === 0) {
      this.#earlyUpdates.clear()
      this.#earlyBytes = 0
      this.#earlyCount = 0
    }
    return { sessionId }
  }

  #registerSession(sessionId: string): Session {
    if (this.#sessions.size >= 128) throw new Error('ACP_NATIVE_SESSION_LIMIT')
    const session: Session = {
      snapshot: { state: 'starting', observedAt: new Date().toISOString() },
      updates: [],
      nativeUpdates: [],
      bytes: 0,
      text: '',
      wake: new Set(),
      startedAt: 0,
      cancelRequested: false,
    }
    this.#sessions.set(sessionId, session)
    return session
  }

  async request(
    method: string,
    params: Record<string, Json>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error('ACP_NATIVE_ABORTED')
    if (method === 'session/list') return this.#listSessions(params, signal)
    if (method === 'session/load') {
      const { sessionId } = SessionParams.parse(params)
      await this.replay(sessionId, signal ? { signal } : {})
      return {}
    }
    if (method === 'session/resume') {
      const { sessionId } = SessionParams.parse(params)
      if (this.#replays.has(sessionId)) throw new Error('ACP_NATIVE_SESSION_LOADING')
      if (!this.#sessions.has(sessionId) && this.#sessions.size + this.#pendingCreates.size >= 128)
        throw new Error('ACP_NATIVE_SESSION_LIMIT')
      const session = this.#sessions.get(sessionId) ?? this.#registerSession(sessionId)
      if (session.closeRequested && !session.closed) throw new Error('ACP_NATIVE_SESSION_CLOSING')
      if (session.snapshot.state === 'running') throw new Error('ACP_NATIVE_SESSION_BUSY')
      if (session.closing && !session.closed) throw new Error('ACP_NATIVE_SESSION_CLOSING')
      if (!session.resuming) {
        delete session.closing
        session.closed = false
        session.closeRequested = false
        session.resumePending = true
        session.resuming = (async () => {
          if (session.closing) await session.closing
          const result = await this.#rpc.request(
            method,
            {
              sessionId,
              cwd: this.#options.cwd,
              mcpServers: [...(this.#options.mcpServers ?? [])],
            },
            this.#requestOptions()
          )
          z.object({}).passthrough().parse(result)
          delete session.closing
          session.closed = false
          session.cancelRequested = false
          session.resumePending = false
          return result
        })()
      }
      const resumed = session.resuming
      await this.#waitForCleanup(
        resumed.then(() => undefined),
        signal
      )
      return resumed
    }
    if (method === 'initialize') {
      const result = await this.#rpc.request(method, params, this.#requestOptions(signal))
      this.#supportsLoad = z
        .object({
          protocolVersion: z.literal(1),
          agentCapabilities: z.object({ loadSession: z.literal(true) }),
        })
        .safeParse(result).success
      this.#supportsClose = z
        .object({
          protocolVersion: z.literal(1),
          agentCapabilities: z.object({
            sessionCapabilities: z.object({ close: z.object({}).passthrough() }),
          }),
        })
        .safeParse(result).success
      return result
    }
    if (method === 'session/close') {
      const { sessionId } = SessionParams.parse(params)
      await this.cleanup(sessionId, signal)
      return {}
    }
    if (method === 'session/prompt') {
      const { sessionId } = SessionParams.parse(params)
      const session = this.#session(sessionId)
      if (this.#replays.has(sessionId)) throw new Error('ACP_NATIVE_SESSION_LOADING')
      if (session.closing) throw new Error('ACP_NATIVE_SESSION_CLOSING')
      if (session.closeRequested) throw new Error('ACP_NATIVE_SESSION_CLOSING')
      if (session.resumePending) throw new Error('ACP_NATIVE_SESSION_RESUMING')
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

  replaySupport(): boolean {
    return this.#supportsLoad
  }

  async replay(
    nativeSessionId: string,
    options: { readonly afterSequence?: number; readonly signal?: AbortSignal } = {}
  ): Promise<AcpSessionReplay> {
    const sessionId = SessionId.parse(nativeSessionId)
    const afterSequence = z
      .number()
      .int()
      .nonnegative()
      .parse(options.afterSequence ?? 0)
    if (options.signal?.aborted) throw new Error('ACP_NATIVE_ABORTED')
    if (!this.#supportsLoad) throw new Error('ACP_NATIVE_LOAD_UNSUPPORTED')
    if (!this.#sessions.has(sessionId) && this.#sessions.size + this.#pendingCreates.size >= 128)
      throw new Error('ACP_NATIVE_SESSION_LIMIT')
    const session = this.#sessions.get(sessionId) ?? this.#registerSession(sessionId)
    if (session.closeRequested && !session.closed) throw new Error('ACP_NATIVE_SESSION_CLOSING')
    if (session.snapshot.state === 'running' || session.resumePending)
      throw new Error('ACP_NATIVE_SESSION_BUSY')
    if (session.closing && !session.closed) throw new Error('ACP_NATIVE_SESSION_CLOSING')
    let replay = this.#replays.get(sessionId)
    if (!replay) {
      delete session.closing
      session.closed = false
      session.closeRequested = false
      replay = { promise: Promise.resolve(), updates: [], bytes: 0 }
      this.#replays.set(sessionId, replay)
      replay.promise = this.#rpc
        .request(
          'session/load',
          { sessionId, cwd: this.#options.cwd, mcpServers: [...(this.#options.mcpServers ?? [])] },
          this.#requestOptions()
        )
        .then((result) => {
          z.object({}).passthrough().parse(result)
          session.closed = false
          delete session.closing
          this.#replays.delete(sessionId)
        })
    }
    await this.#waitForCleanup(replay.promise, options.signal)
    return {
      updates: [],
      nativeUpdates: structuredClone(replay.updates.slice(afterSequence)),
      completeness: 'partial',
    }
  }

  async #listSessions(params: Record<string, Json>, signal?: AbortSignal) {
    if (params['cursor'] !== undefined) throw new Error('ACP_NATIVE_PARTIAL_LIST_UNSUPPORTED')
    const sessions: { sessionId: string; title?: string }[] = []
    const cursors = new Set<string>()
    const ids = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 16; page++) {
      const response = z
        .object({
          sessions: z
            .array(
              z
                .object({ sessionId: SessionId, title: z.string().max(512).nullable().optional() })
                .passthrough()
            )
            .max(128),
          nextCursor: z.string().min(1).max(4096).nullable().optional(),
        })
        .passthrough()
        .parse(
          await this.#rpc.request(
            'session/list',
            { ...params, ...(cursor ? { cursor } : {}) },
            this.#requestOptions(signal)
          )
        )
      for (const session of response.sessions) {
        if (ids.has(session.sessionId)) throw new Error('ACP_NATIVE_LIST_DUPLICATE_SESSION')
        if (sessions.length >= 128) throw new Error('ACP_NATIVE_LIST_LIMIT')
        ids.add(session.sessionId)
        sessions.push({
          sessionId: session.sessionId,
          ...(session.title ? { title: session.title } : {}),
        })
      }
      if (!response.nextCursor) return { sessions }
      if (cursors.has(response.nextCursor)) throw new Error('ACP_NATIVE_LIST_CURSOR_REPEATED')
      cursor = response.nextCursor
      cursors.add(cursor)
    }
    throw new Error('ACP_NATIVE_LIST_LIMIT')
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
    if (signal?.aborted) throw new Error('ACP_NATIVE_ABORTED')
    const session = this.#session(nativeSessionId)
    if (!this.#supportsClose) throw new Error('ACP_NATIVE_CLOSE_UNSUPPORTED')
    session.closeRequested = true
    const replay = this.#replays.get(nativeSessionId)
    if (replay) await this.#waitForCleanup(replay.promise, signal)
    if (session.resuming)
      await this.#waitForCleanup(
        session.resuming.then(() => undefined),
        signal
      )
    if (!session.closing) session.closing = this.#closeSession(nativeSessionId, session)
    await this.#waitForCleanup(session.closing, signal)
  }

  async #closeSession(nativeSessionId: string, session: Session): Promise<void> {
    if (session.snapshot.state === 'running') {
      await this.request('session/cancel', { sessionId: nativeSessionId })
      if (session.turn) await this.#waitForCleanup(session.turn)
      const settled = await this.snapshot(nativeSessionId)
      if (settled.state !== 'cancelled' && settled.state !== 'completed')
        throw new Error('ACP_NATIVE_CLEANUP_UNCONFIRMED')
    }
    this.#cancelPermissions(nativeSessionId)
    const result = await this.#rpc.request(
      'session/close',
      { sessionId: nativeSessionId },
      this.#requestOptions()
    )
    z.object({}).passthrough().parse(result)
    session.closed = true
    delete session.resuming
  }

  #requestOptions(signal?: AbortSignal) {
    return { timeoutMs: this.#options.requestTimeoutMs ?? 30_000, ...(signal ? { signal } : {}) }
  }

  async #waitForCleanup(turn: Promise<void>, signal?: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let aborted: (() => void) | undefined
    try {
      await Promise.race([
        turn,
        new Promise<never>((_, reject) => {
          aborted = () => reject(new Error('ACP_NATIVE_ABORTED'))
          signal?.addEventListener('abort', aborted, { once: true })
          if (signal?.aborted) aborted()
          timer = setTimeout(
            () => reject(new Error('ACP_NATIVE_CLEANUP_TIMEOUT')),
            this.#options.requestTimeoutMs ?? 30_000
          )
          timer.unref()
        }),
      ])
    } finally {
      clearTimeout(timer)
      if (aborted) signal?.removeEventListener('abort', aborted)
    }
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
    const replay = this.#replays.get(envelope.sessionId)
    if (replay) {
      const bytes = Buffer.byteLength(JSON.stringify(envelope.update))
      if (replay.bytes + bytes > 4_194_304 || replay.updates.length >= 4096)
        throw new Error('ACP_NATIVE_HISTORY_LIMIT')
      replay.bytes += bytes
      replay.updates.push(envelope.update)
      return
    }
    if (!this.#sessions.has(envelope.sessionId) && this.#pendingCreates.size > 0) {
      const bytes = Buffer.byteLength(JSON.stringify(params))
      if (this.#earlyBytes + bytes > 4_194_304 || this.#earlyCount >= 4096)
        throw new Error('ACP_NATIVE_EARLY_UPDATE_LIMIT')
      this.#earlyBytes += bytes
      this.#earlyCount += 1
      const updates = this.#earlyUpdates.get(envelope.sessionId) ?? []
      updates.push(params)
      this.#earlyUpdates.set(envelope.sessionId, updates)
      return
    }
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
    if (
      session.cancelRequested ||
      session.closeRequested ||
      session.closing ||
      session.resumePending ||
      this.#replays.has(input.sessionId)
    ) {
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
