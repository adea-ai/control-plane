import {
  GatewayCommandEnvelopeSchema,
  GrantReferenceSchema,
  type GatewayCommandEnvelope,
  type GatewayProgressEnvelope,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { ReferenceAcpTransport, type ReferenceAcpScenario } from './reference-transport.js'
import type { AcpUpdate } from './acp-schemas.js'
import {
  NativeSessionIdSchema,
  SessionReferenceSchema,
  type AcpLocalProjectGrantState,
} from './acp-gateway-types.js'
import {
  failureResult,
  inlineParameters,
  progressEnvelope,
  runtimeError,
  successResult,
} from './acp-gateway-protocol.js'

export interface ReferenceAcpDriverOptions {
  readonly now?: () => string
  readonly scenario?: ReferenceAcpScenario
  readonly protocolVersion?: number
  readonly nativeSessions?: readonly { readonly sessionId: string; readonly title?: string }[]
  readonly sessionReplay?: boolean
}

export class ReferenceAcpDriver {
  readonly #now: () => string
  readonly #harness: ReferenceAcpTransport
  readonly #grants = new Map<string, AcpLocalProjectGrantState>()
  readonly #nativeByReference = new Map<string, string>()
  readonly #referenceByNative = new Map<string, string>()
  readonly #effects = new Map<string, number>()
  readonly #nativeState = {
    authenticationOwner: 'native_harness',
    configurationOwner: 'native_harness',
    sessionFilesOwner: 'native_harness',
  }
  #nextReference = 0

  constructor(options: ReferenceAcpDriverOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#harness = new ReferenceAcpTransport({
      now: this.#now,
      ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
      ...(options.protocolVersion === undefined
        ? {}
        : { protocolVersion: options.protocolVersion }),
      ...(options.nativeSessions === undefined ? {} : { nativeSessions: options.nativeSessions }),
      ...(options.sessionReplay === undefined ? {} : { sessionReplay: options.sessionReplay }),
    })
  }

  setGrantState(grantRef: string, state: AcpLocalProjectGrantState): void {
    this.#grants.set(GrantReferenceSchema.parse(grantRef), state)
  }

  grantState(grantRef: string): AcpLocalProjectGrantState {
    return this.#grants.get(GrantReferenceSchema.parse(grantRef)) ?? 'missing'
  }

  nativeState() {
    return structuredClone(this.#nativeState)
  }

  effectCount(attemptId: string, operation: GatewayCommandEnvelope['operation']): number {
    return this.#effects.get(`${attemptId}:${operation}`) ?? 0
  }

  async handle(commandInput: GatewayCommandEnvelope): Promise<{
    readonly progress: GatewayProgressEnvelope[]
    readonly result: GatewayResultEnvelope
  }> {
    const command = GatewayCommandEnvelopeSchema.parse(commandInput)
    this.#increment(command)
    try {
      if (command.operation === 'runtime.execute') return this.#execute(command)
      if (command.operation === 'runtime.status') return this.#status(command)
      if (command.operation === 'runtime.session') return this.#session(command)
      if (command.operation === 'runtime.cancel') return this.#cancel(command)
      if (command.operation === 'runtime.approval' || command.operation === 'runtime.input') {
        return this.#respond(command)
      }
      return {
        progress: [],
        result: failureResult(
          command,
          'ACP_OPERATION_UNSUPPORTED',
          'unsupported',
          false,
          this.#now()
        ),
      }
    } catch (error) {
      const normalized =
        error instanceof RuntimeAdapterError
          ? error
          : runtimeError('ACP_DRIVER_FAILURE', 'runtime', true)
      return {
        progress: [],
        result: failureResult(
          command,
          normalized.code,
          normalized.classification,
          normalized.retryable,
          this.#now()
        ),
      }
    }
  }

  async #execute(command: GatewayCommandEnvelope) {
    const parameters = z
      .object({
        sessionRef: SessionReferenceSchema,
        prompt: z.array(z.record(z.string(), z.json())).min(1).max(64),
        grantRef: GrantReferenceSchema,
      })
      .strict()
      .parse(inlineParameters(command))
    const grant = this.grantState(parameters.grantRef)
    if (grant !== 'granted') {
      return {
        progress: [],
        result: failureResult(
          command,
          grant === 'revoked' ? 'LOCAL_PROJECT_GRANT_REVOKED' : 'LOCAL_PROJECT_GRANT_MISSING',
          'validation',
          false,
          this.#now()
        ),
      }
    }
    const nativeSessionId = this.#native(parameters.sessionRef)
    await this.#harness.request('session/prompt', {
      sessionId: nativeSessionId,
      prompt: parameters.prompt,
    })
    const updates: AcpUpdate[] = []
    for await (const update of this.#harness.updates(nativeSessionId)) updates.push(update)
    return {
      progress: updates.map((update, index) => progressEnvelope(command, update, index + 1)),
      result: successResult(command, {}, this.#now()),
    }
  }

  async #status(command: GatewayCommandEnvelope) {
    const parameters = z
      .union([
        z
          .object({ action: z.literal('initialize'), request: z.record(z.string(), z.json()) })
          .strict(),
        z.object({ action: z.literal('snapshot'), sessionRef: SessionReferenceSchema }).strict(),
      ])
      .parse(inlineParameters(command))
    if (parameters.action === 'initialize') {
      const initialize = await this.#harness.request('initialize', parameters.request)
      return { progress: [], result: successResult(command, { initialize }, this.#now()) }
    }
    const snapshot = await this.#harness.snapshot(this.#native(parameters.sessionRef))
    return { progress: [], result: successResult(command, { snapshot }, this.#now()) }
  }

  async #session(command: GatewayCommandEnvelope) {
    const parameters = z
      .object({
        action: z.enum(['new', 'list', 'resume', 'close', 'replay']),
        sessionRef: SessionReferenceSchema.optional(),
        afterSequence: z.number().int().nonnegative().optional(),
        createToken: z.string().min(1).max(256).optional(),
      })
      .strict()
      .parse(inlineParameters(command))
    if (parameters.action === 'new') {
      const result = await this.#harness.createSession(
        parameters.createToken ?? `gateway-command:${command.commandId}`
      )
      return {
        progress: [],
        result: successResult(
          command,
          { sessionId: this.#reference(result.sessionId) },
          this.#now()
        ),
      }
    }
    if (parameters.action === 'list') {
      const result = z
        .object({
          sessions: z.array(
            z
              .object({ sessionId: NativeSessionIdSchema, title: z.string().optional() })
              .passthrough()
          ),
        })
        .parse(await this.#harness.request('session/list', {}))
      return {
        progress: [],
        result: successResult(
          command,
          {
            sessions: result.sessions.map(({ sessionId, title }) => ({
              sessionId: this.#reference(sessionId),
              ...(title === undefined ? {} : { title }),
            })),
          },
          this.#now()
        ),
      }
    }
    if (!parameters.sessionRef)
      throw runtimeError('ACP_SESSION_REFERENCE_MISSING', 'validation', false)
    const nativeSessionId = this.#native(parameters.sessionRef)
    if (parameters.action === 'replay') {
      const replay = await this.#harness.replay(
        nativeSessionId,
        parameters.afterSequence === undefined ? {} : { afterSequence: parameters.afterSequence }
      )
      return { progress: [], result: successResult(command, replay, this.#now()) }
    }
    await this.#harness.request(`session/${parameters.action}`, { sessionId: nativeSessionId })
    return { progress: [], result: successResult(command, {}, this.#now()) }
  }

  async #cancel(command: GatewayCommandEnvelope) {
    const parameters = z
      .object({ sessionRef: SessionReferenceSchema, requestedAt: z.iso.datetime() })
      .strict()
      .parse(inlineParameters(command))
    const nativeSessionId = this.#native(parameters.sessionRef)
    await this.#harness.request('session/cancel', { sessionId: nativeSessionId })
    return { progress: [], result: successResult(command, {}, this.#now()) }
  }

  async #respond(command: GatewayCommandEnvelope) {
    const parameters = z
      .object({
        sessionRef: SessionReferenceSchema,
        requestId: z.number().int().nonnegative(),
        response: z.record(z.string(), z.json()),
      })
      .strict()
      .parse(inlineParameters(command))
    this.#native(parameters.sessionRef)
    await this.#harness.respond(parameters.requestId, parameters.response)
    return { progress: [], result: successResult(command, {}, this.#now()) }
  }

  #reference(nativeSessionId: string): string {
    const existing = this.#referenceByNative.get(nativeSessionId)
    if (existing) return existing
    const values = [
      'nses_01JABCDEF0123456789ABCDEFG',
      'nses_01JBBCDEF0123456789ABCDEFG',
      'nses_01JDBCDEF0123456789ABCDEFG',
    ]
    const sessionRef = values[this.#nextReference++]
    if (!sessionRef) throw runtimeError('ACP_SESSION_REFERENCE_CAPACITY', 'infrastructure', false)
    this.#referenceByNative.set(nativeSessionId, sessionRef)
    this.#nativeByReference.set(sessionRef, nativeSessionId)
    return sessionRef
  }

  #native(sessionRef: string): string {
    const native = this.#nativeByReference.get(sessionRef)
    if (!native) throw runtimeError('ACP_SESSION_REFERENCE_STALE', 'unavailable', true)
    return native
  }

  #increment(command: GatewayCommandEnvelope): void {
    const key = `${command.attemptId}:${command.operation}`
    this.#effects.set(key, (this.#effects.get(key) ?? 0) + 1)
  }
}
