import { RuntimeAdapterError, RuntimeArtifactReferenceSchema } from '@control-plane/runtime-sdk'
import { SemanticVersionSchema } from './acp-schemas.js'
import { z } from 'zod'
import {
  AcpUpdateSchema,
  AcpSnapshotSchema,
  NativeSessionIdSchema,
  type AcpSnapshot,
  type AcpUpdate,
} from './acp-schemas.js'
import type { AcpTransport, AcpTransportCall, AcpSessionReplay } from './index.js'

export type ReferenceAcpScenario = 'complete' | 'running' | 'timeout'

export interface ReferenceAcpTransportOptions {
  readonly now?: () => string
  readonly protocolVersion?: number
  readonly scenario?: ReferenceAcpScenario
  readonly nativeSessions?: readonly { readonly sessionId: string; readonly title?: string }[]
  readonly historyCompleteness?: AcpSessionReplay['completeness']
  readonly sessionReplay?: boolean
  readonly harnessVersion?: string
}

interface ReferenceSession {
  readonly attemptId: string
  readonly updates: AcpUpdate[]
  snapshot: AcpSnapshot
}

export class ReferenceAcpTransport implements AcpTransport {
  readonly #now: () => string
  readonly #protocolVersion: number
  readonly #scenario: ReferenceAcpScenario
  readonly #historyCompleteness: AcpSessionReplay['completeness']
  readonly #sessionReplay: boolean
  readonly #harnessVersion: string
  readonly #calls: AcpTransportCall[] = []
  readonly #responses: Array<{ requestId: number; result: Record<string, z.util.JSONType> }> = []
  readonly #sessions = new Map<string, ReferenceSession>()
  readonly #nativeSessions = new Map<
    string,
    { readonly sessionId: string; readonly title?: string }
  >()
  readonly #effects = new Map<string, number>()
  readonly #createdSessions = new Map<string, string>()
  readonly #pendingCreatedSessions = new Map<string, Promise<{ readonly sessionId: string }>>()
  #replays = 0
  #state: 'connected' | 'disconnected' = 'connected'

  constructor(options: ReferenceAcpTransportOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#protocolVersion = options.protocolVersion ?? 2
    this.#scenario = options.scenario ?? 'complete'
    this.#historyCompleteness = options.historyCompleteness ?? 'complete'
    this.#sessionReplay = options.sessionReplay ?? false
    this.#harnessVersion = SemanticVersionSchema.parse(options.harnessVersion ?? '2.4.0')
    for (const session of options.nativeSessions ?? []) {
      this.#nativeSessions.set(session.sessionId, structuredClone(session))
    }
  }

  connectionState(): 'connected' | 'disconnected' {
    return this.#state
  }

  async createSession(
    createToken: string,
    signal?: AbortSignal
  ): Promise<{ readonly sessionId: string }> {
    const existing = this.#createdSessions.get(createToken)
    if (existing) return { sessionId: existing }
    const pending = this.#pendingCreatedSessions.get(createToken)
    if (pending) return pending
    const created = this.request('session/new', {}, signal).then((result) => {
      const parsed = z.object({ sessionId: NativeSessionIdSchema }).strict().parse(result)
      this.#createdSessions.set(createToken, parsed.sessionId)
      return parsed
    })
    this.#pendingCreatedSessions.set(createToken, created)
    try {
      return await created
    } finally {
      if (this.#pendingCreatedSessions.get(createToken) === created) {
        this.#pendingCreatedSessions.delete(createToken)
      }
    }
  }

  async request(
    method: string,
    params: Record<string, z.util.JSONType>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error('ACP_REQUEST_ABORTED')
    if (this.#state === 'disconnected') throw new Error('ACP_DISCONNECTED')
    this.#calls.push({ method, params: structuredClone(params) })
    if (method === 'initialize') {
      return {
        protocolVersion: this.#protocolVersion,
        capabilities: { session: {} },
        info: {
          name: 'reference-acp-agent',
          title: 'Reference ACP Agent',
          version: this.#harnessVersion,
        },
        authMethods: [{ id: 'native-owned' }],
      }
    }
    if (method === 'session/new') {
      this.#nativeSessions.set('native-session-1', { sessionId: 'native-session-1' })
      return { sessionId: 'native-session-1' }
    }
    if (method === 'session/prompt') {
      const prompt = z
        .object({
          sessionId: NativeSessionIdSchema,
          prompt: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
        })
        .parse(params)
      const attemptId =
        prompt.prompt[0]?.text.match(/att_[0-9A-HJKMNP-TV-Z]{26}/)?.[0] ??
        [...this.#effects.keys()][0] ??
        'att_01JABCDEF0123456789ABCDEFG'
      this.#sessions.set(prompt.sessionId, referenceSession(attemptId, this.#scenario, this.#now()))
      this.#nativeSessions.set(prompt.sessionId, { sessionId: prompt.sessionId })
      this.#effects.set(attemptId, (this.#effects.get(attemptId) ?? 0) + 1)
      return {}
    }
    if (method === 'session/cancel') {
      const sessionId = NativeSessionIdSchema.parse(params['sessionId'])
      const session = this.#session(sessionId)
      session.snapshot = { state: 'cancelled', observedAt: this.#now() }
      return {}
    }
    if (method === 'session/list') {
      return { sessions: [...this.#nativeSessions.values()].map((session) => ({ ...session })) }
    }
    if (method === 'session/resume' || method === 'session/close') {
      const sessionId = NativeSessionIdSchema.parse(params['sessionId'])
      if (!this.#nativeSessions.has(sessionId)) {
        throw new RuntimeAdapterError({
          code: 'ACP_SESSION_NOT_FOUND',
          classification: 'unavailable',
          message: 'ACP session was not found',
          retryable: true,
        })
      }
      return {}
    }
    throw new Error('REFERENCE_ACP_METHOD_UNSUPPORTED')
  }

  async respond(requestId: number, result: Record<string, z.util.JSONType>): Promise<void> {
    this.#responses.push({ requestId, result: structuredClone(result) })
  }

  async *updates(nativeSessionId: string, signal?: AbortSignal): AsyncIterable<AcpUpdate> {
    for (const update of this.#session(nativeSessionId).updates) {
      if (signal?.aborted) return
      yield structuredClone(update)
    }
  }

  async snapshot(nativeSessionId: string): Promise<AcpSnapshot> {
    return structuredClone(this.#session(nativeSessionId).snapshot)
  }

  async cleanup(nativeSessionId: string): Promise<void> {
    this.#session(nativeSessionId)
  }

  async replay(
    nativeSessionId: string,
    options: { readonly afterSequence?: number } = {}
  ): Promise<AcpSessionReplay> {
    if (!this.#nativeSessions.has(nativeSessionId)) {
      throw new RuntimeAdapterError({
        code: 'ACP_SESSION_NOT_FOUND',
        classification: 'unavailable',
        message: 'ACP session was not found',
        retryable: true,
      })
    }
    this.#replays += 1
    const updates: AcpUpdate[] =
      this.#historyCompleteness === 'unavailable'
        ? []
        : [
            {
              sessionUpdate: 'agent_message',
              messageId: 'native-history-message-1',
              text: 'Earlier message',
            },
          ]
    return {
      completeness: this.#historyCompleteness,
      updates: updates.slice(options.afterSequence ?? 0),
    }
  }

  replaySupport(): boolean {
    return this.#sessionReplay
  }

  disconnect(): void {
    this.#state = 'disconnected'
  }

  connect(): void {
    this.#state = 'connected'
  }

  completeAttempt(attemptId: string): void {
    const session = [...this.#sessions.values()].find(
      (candidate) => candidate.attemptId === attemptId
    )
    if (!session) throw new Error('REFERENCE_ACP_SESSION_MISSING')
    session.snapshot = completedSnapshot(this.#now())
  }

  calls(): AcpTransportCall[] {
    return structuredClone(this.#calls)
  }

  responses(): Array<{ requestId: number; result: Record<string, z.util.JSONType> }> {
    return structuredClone(this.#responses)
  }

  effectCount(attemptId: string): number {
    return this.#effects.get(attemptId) ?? 0
  }

  replayCount(): number {
    return this.#replays
  }

  setNativeSessionTitle(nativeSessionId: string, title: string): void {
    const session = this.#nativeSessions.get(nativeSessionId)
    if (!session) throw new Error('REFERENCE_ACP_SESSION_MISSING')
    this.#nativeSessions.set(nativeSessionId, { ...session, title })
  }

  removeNativeSession(nativeSessionId: string): void {
    this.#nativeSessions.delete(nativeSessionId)
  }

  #session(nativeSessionId: string): ReferenceSession {
    const session = this.#sessions.get(nativeSessionId)
    if (!session) throw new Error('REFERENCE_ACP_SESSION_MISSING')
    return session
  }
}

function referenceSession(
  attemptId: string,
  scenario: ReferenceAcpScenario,
  observedAt: string
): ReferenceSession {
  const artifact = RuntimeArtifactReferenceSchema.parse({
    artifactId: 'art_01JABCDEF0123456789ABCDEFG',
    version: 1,
    mediaType: 'application/json',
    digest: `sha256:${'e'.repeat(64)}`,
    sizeBytes: 32,
    locator: 'artifact://acp/result',
  })
  const updates: AcpUpdate[] = [
    { sessionUpdate: 'state_update', state: 'running' },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'native-message-1',
      text: 'ACP working',
    },
    {
      sessionUpdate: 'request_permission',
      requestId: 40,
      toolCallId: 'native-tool-call-1',
      title: 'Allow project read?',
      options: [
        { optionId: 'allow_once', kind: 'allow_once' },
        { optionId: 'reject', kind: 'reject' },
      ],
    },
    {
      sessionUpdate: 'usage_update',
      inputTokens: 12,
      outputTokens: 4,
      durationMs: 120,
    },
    { sessionUpdate: 'artifact', artifact },
    { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
  ].map((update) => AcpUpdateSchema.parse(update))
  const snapshot =
    scenario === 'complete'
      ? completedSnapshot(observedAt, artifact)
      : scenario === 'timeout'
        ? AcpSnapshotSchema.parse({
            state: 'timed_out',
            observedAt,
            error: {
              code: 'ACP_PROMPT_TIMED_OUT',
              classification: 'timeout',
              message: 'ACP prompt timed out',
              retryable: true,
            },
          })
        : AcpSnapshotSchema.parse({ state: 'running', observedAt })
  return { attemptId, updates, snapshot }
}

function completedSnapshot(
  observedAt: string,
  artifact = RuntimeArtifactReferenceSchema.parse({
    artifactId: 'art_01JABCDEF0123456789ABCDEFG',
    version: 1,
    mediaType: 'application/json',
    digest: `sha256:${'e'.repeat(64)}`,
    sizeBytes: 32,
    locator: 'artifact://acp/result',
  })
): AcpSnapshot {
  return AcpSnapshotSchema.parse({
    state: 'completed',
    observedAt,
    output: { text: 'ACP complete' },
    usage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
    artifacts: [artifact],
  })
}
