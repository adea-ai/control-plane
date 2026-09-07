import {
  RuntimeCommandResultReferenceSchema,
  type Execution,
  type ExecutionAttempt,
  type ExecutionRepository,
  type RuntimeCommandRecord,
  type RuntimeCommandRepository,
} from '@control-plane/domain'
import {
  hashExecutionEventPayload,
  ExecutionEventDraftSchema,
  type ExecutionEventDraft,
  type RuntimeEventEffectResult,
  type RuntimeEventEffectSink,
} from '@control-plane/events'
import {
  GatewayCommandEnvelopeSchema,
  GatewayErrorEnvelopeSchema,
  GatewayProgressEnvelopeSchema,
  GatewayResultEnvelopeSchema,
  type GatewayErrorEnvelope,
  type GatewayProgressEnvelope,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import {
  RuntimeExecutionProgressSchema,
  type RuntimeExecutionProgress,
} from '@control-plane/runtime-sdk'
import { managedCloudOperationalPolicy } from '@control-plane/config'
import { createHash } from 'node:crypto'
import type { GatewayMetrics } from './websocket-coordination.js'
import type { RuntimeCommandDeliveryService } from './runtime-command-delivery.js'

const MAX_INLINE_EVENT_BYTES = 16_384
const RETENTION_MS = managedCloudOperationalPolicy.retention.executionEventsMs
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'timed_out'])

export interface RuntimeEventSourceChannel {
  readonly nodeId: string
  readonly workspaceId: string
  readonly channelGeneration: number
}

export interface RuntimeNodeChannelAuthority {
  isActive(source: RuntimeEventSourceChannel): Promise<boolean>
}

export interface RuntimeEventQuarantine {
  record(input: {
    readonly commandId?: string
    readonly frameHash: string
    readonly reason: RuntimeEventIngestionErrorCode
    readonly recordedAt: string
  }): Promise<void>
}

export interface NormalizedRuntimeTerminal {
  readonly state: 'completed' | 'failed' | 'cancelled'
  readonly resultReference?: string
  readonly failure?: {
    readonly classification: 'runtime_error' | 'cancelled'
    readonly code: string
  }
  readonly payload: ExecutionEventDraft['payload']
}

interface RuntimeEventContext {
  readonly command: RuntimeCommandRecord
  readonly execution: Execution
  readonly attempt: ExecutionAttempt
}

type RuntimeNormalizerInput<Frame> = RuntimeEventContext & { readonly frame: Frame }

export interface RuntimeAdapterEventNormalizer {
  normalizeProgress(
    input: RuntimeNormalizerInput<GatewayProgressEnvelope>
  ): Promise<RuntimeExecutionProgress>
  normalizeResult(
    input: RuntimeNormalizerInput<GatewayResultEnvelope>
  ): Promise<NormalizedRuntimeTerminal | undefined>
  normalizeError(
    input: RuntimeNormalizerInput<
      GatewayErrorEnvelope & { readonly commandId: string; readonly payloadHash: string }
    >
  ): Promise<NormalizedRuntimeTerminal>
}

export class DefaultRuntimeAdapterEventNormalizer implements RuntimeAdapterEventNormalizer {
  async normalizeProgress(
    input: RuntimeNormalizerInput<GatewayProgressEnvelope>
  ): Promise<RuntimeExecutionProgress> {
    const kind = input.frame.event.kind
    const type = kind.includes('interaction')
      ? 'interaction'
      : kind.includes('usage')
        ? 'usage'
        : kind.includes('artifact')
          ? 'artifact'
          : kind.includes('status')
            ? 'status'
            : 'output'
    const command = GatewayCommandEnvelopeSchema.parse(input.command.commandEnvelope)
    const handleId = input.frame.event.data['handleId']
    return RuntimeExecutionProgressSchema.parse({
      handleId:
        typeof handleId === 'string' && handleId.length > 0 && handleId.length <= 256
          ? handleId
          : `${command.driver.family}:${input.attempt.attemptId}`,
      sequence: input.frame.eventSequence,
      occurredAt: input.frame.sentAt,
      type,
      data: input.frame.event.data,
    })
  }

  async normalizeResult(
    input: RuntimeNormalizerInput<GatewayResultEnvelope>
  ): Promise<NormalizedRuntimeTerminal | undefined> {
    const { frame } = input
    if (frame.status === 'cancelled') {
      return { state: 'cancelled', payload: { status: 'cancelled' } }
    }
    if (frame.status === 'failed') {
      const data = 'data' in frame.result ? frame.result.data : {}
      const error = data['error']
      const code = runtimeFailureCode(error)
      const retryable = runtimeFailureRetryable(error)
      return {
        state: 'failed',
        failure: { classification: 'runtime_error', code },
        payload: { status: 'failed', code, retryable },
      }
    }
    if ('data' in frame.result) return undefined
    const { artifact } = frame.result
    return {
      state: 'completed',
      resultReference: artifact.artifactId,
      payload: {
        status: 'succeeded',
        artifact: {
          digest: artifact.digest,
          mediaType: artifact.mediaType,
          sizeBytes: artifact.sizeBytes,
        },
      },
    }
  }

  async normalizeError(
    input: RuntimeNormalizerInput<
      GatewayErrorEnvelope & { readonly commandId: string; readonly payloadHash: string }
    >
  ): Promise<NormalizedRuntimeTerminal> {
    return {
      state: 'failed',
      failure: { classification: 'runtime_error', code: input.frame.code },
      payload: { code: input.frame.code, retryable: input.frame.retryable },
    }
  }
}

export interface RuntimeEventIngestionServiceOptions {
  readonly commands: RuntimeCommandRepository
  readonly executions: ExecutionRepository
  readonly effects: RuntimeEventEffectSink
  readonly normalizer: RuntimeAdapterEventNormalizer
  readonly channelAuthority: RuntimeNodeChannelAuthority
  readonly quarantine: RuntimeEventQuarantine
  readonly metrics: GatewayMetrics
  readonly now?: () => Date
}

export type RuntimeEventIngestionErrorCode =
  | 'RUNTIME_EVENT_COMMAND_MISSING'
  | 'RUNTIME_EVENT_ATTEMPT_MISSING'
  | 'RUNTIME_EVENT_EXECUTION_MISSING'
  | 'RUNTIME_EVENT_SCOPE_MISMATCH'
  | 'RUNTIME_EVENT_PAYLOAD_MISMATCH'
  | 'RUNTIME_EVENT_STALE_CHANNEL'
  | 'RUNTIME_EVENT_STALE_SEQUENCE'
  | 'RUNTIME_EVENT_COMMAND_TERMINAL'
  | 'RUNTIME_EVENT_PAYLOAD_TOO_LARGE'
  | 'RUNTIME_EVENT_NORMALIZATION_FAILED'
  | 'RUNTIME_EVENT_CONFLICT'

export class RuntimeEventIngestionError extends Error {
  constructor(readonly code: RuntimeEventIngestionErrorCode) {
    super(code)
    this.name = 'RuntimeEventIngestionError'
  }
}

export class RuntimeEventIngestionService {
  readonly #channelAuthority: RuntimeNodeChannelAuthority
  readonly #commands: RuntimeCommandRepository
  readonly #effects: RuntimeEventEffectSink
  readonly #executions: ExecutionRepository
  readonly #metrics: GatewayMetrics
  readonly #normalizer: RuntimeAdapterEventNormalizer
  readonly #now: () => Date
  readonly #quarantine: RuntimeEventQuarantine

  constructor(options: RuntimeEventIngestionServiceOptions) {
    this.#commands = options.commands
    this.#executions = options.executions
    this.#effects = options.effects
    this.#normalizer = options.normalizer
    this.#channelAuthority = options.channelAuthority
    this.#quarantine = options.quarantine
    this.#metrics = options.metrics
    this.#now = options.now ?? (() => new Date())
  }

  async ingestProgress(
    frameValue: unknown,
    source: RuntimeEventSourceChannel
  ): Promise<RuntimeEventEffectResult> {
    const frame = GatewayProgressEnvelopeSchema.parse(frameValue)
    const context = await this.#context(frame, source, false)
    this.#assertInlineBound(frame.event.data)
    let normalized: RuntimeExecutionProgress
    try {
      normalized = RuntimeExecutionProgressSchema.parse(
        await this.#normalizer.normalizeProgress({ frame, ...context })
      )
    } catch {
      return this.#reject(frame, 'RUNTIME_EVENT_NORMALIZATION_FAILED')
    }
    if (normalized.sequence !== frame.eventSequence) {
      return this.#reject(frame, 'RUNTIME_EVENT_STALE_SEQUENCE')
    }
    this.#assertInlineBound(normalized.data)
    const result = await this.#effects.applyProgress({
      commandId: frame.commandId,
      eventSequence: frame.eventSequence,
      frameHash: frameHash(frame),
      draft: this.#draft(
        context,
        frame,
        progressEventType(normalized.type),
        normalized.data,
        normalized.occurredAt
      ),
    })
    return this.#classify(frame, result)
  }

  async ingestResult(
    frameValue: unknown,
    source: RuntimeEventSourceChannel
  ): Promise<RuntimeEventEffectResult> {
    const frame = GatewayResultEnvelopeSchema.parse(frameValue)
    const context = await this.#context(frame, source, true)
    if ('data' in frame.result) this.#assertInlineBound(frame.result.data)
    let normalized: NormalizedRuntimeTerminal | undefined
    try {
      normalized = await this.#normalizer.normalizeResult({ frame, ...context })
    } catch {
      return this.#reject(frame, 'RUNTIME_EVENT_NORMALIZATION_FAILED')
    }
    if (normalized === undefined) return { outcome: 'applied' }
    const expectedState = {
      succeeded: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
    } as const
    if (normalized.state !== expectedState[frame.status]) {
      return this.#reject(frame, 'RUNTIME_EVENT_NORMALIZATION_FAILED')
    }
    return this.#applyTerminal(frame, context, normalized)
  }

  async ingestError(
    frameValue: unknown,
    source: RuntimeEventSourceChannel
  ): Promise<RuntimeEventEffectResult> {
    const frame = GatewayErrorEnvelopeSchema.parse(frameValue)
    if (frame.commandId === undefined || frame.payloadHash === undefined) {
      return this.#reject(frame, 'RUNTIME_EVENT_SCOPE_MISMATCH')
    }
    if (frame.protocolVersion.major !== 1 || frame.protocolVersion.minor < 1) {
      return this.#reject(frame, 'RUNTIME_EVENT_SCOPE_MISMATCH')
    }
    const commandFrame = { ...frame, commandId: frame.commandId, payloadHash: frame.payloadHash }
    const context = await this.#context(commandFrame, source, false, true)
    let normalized: NormalizedRuntimeTerminal
    try {
      normalized = await this.#normalizer.normalizeError({ frame: commandFrame, ...context })
    } catch {
      return this.#reject(frame, 'RUNTIME_EVENT_NORMALIZATION_FAILED')
    }
    if (normalized.state !== 'failed') {
      return this.#reject(frame, 'RUNTIME_EVENT_NORMALIZATION_FAILED')
    }
    return this.#applyTerminal(commandFrame, context, normalized)
  }

  async dispatchControl(
    commandValue: unknown,
    transport: { readonly channelGeneration: number; readonly sequence: number },
    delivery: RuntimeCommandDeliveryService
  ): Promise<
    | { readonly sent: true; readonly commandId: string }
    | { readonly sent: false; readonly terminalState: string }
  > {
    const command = GatewayCommandEnvelopeSchema.parse(commandValue)
    if (!['runtime.cancel', 'runtime.input', 'runtime.approval'].includes(command.operation)) {
      fail('RUNTIME_EVENT_SCOPE_MISMATCH')
    }
    if (command.protocolVersion.major !== 1 || command.protocolVersion.minor < 1) {
      fail('RUNTIME_EVENT_SCOPE_MISMATCH')
    }
    const attempt = await this.#executions.getAttempt(command.attemptId ?? '')
    const execution = await this.#executions.getExecution(command.executionId ?? '')
    if (
      !attempt ||
      !execution ||
      attempt.executionId !== execution.executionId ||
      execution.correlation.workspaceId !== command.workspaceId ||
      attempt.runtime?.runtimeNodeRefId !== command.nodeId ||
      attempt.runtime.runtimeConnectionId !== command.runtimeConnectionId
    ) {
      fail('RUNTIME_EVENT_SCOPE_MISMATCH')
    }
    if (TERMINAL_STATES.has(execution.state) || TERMINAL_STATES.has(attempt.state)) {
      return { sent: false, terminalState: execution.state }
    }
    await delivery.enqueue(command)
    await delivery.deliver(command.commandId, transport)
    return { sent: true, commandId: command.commandId }
  }

  async #context(
    frame:
      | GatewayProgressEnvelope
      | GatewayResultEnvelope
      | (GatewayErrorEnvelope & { commandId: string; payloadHash: string }),
    source: RuntimeEventSourceChannel,
    historicalResult: boolean,
    allowTerminalCommand = historicalResult
  ): Promise<RuntimeEventContext> {
    const command = await this.#commands.get(frame.commandId)
    if (!command) return this.#reject(frame, 'RUNTIME_EVENT_COMMAND_MISSING')
    const attempt = await this.#executions.getAttempt(command.attemptId)
    if (!attempt) return this.#reject(frame, 'RUNTIME_EVENT_ATTEMPT_MISSING')
    const execution = await this.#executions.getExecution(command.executionId)
    if (!execution) return this.#reject(frame, 'RUNTIME_EVENT_EXECUTION_MISSING')
    const active = await this.#channelAuthority.isActive(source)
    if (!active) return this.#reject(frame, 'RUNTIME_EVENT_STALE_CHANNEL')
    if (
      source.nodeId !== frame.nodeId ||
      source.workspaceId !== frame.workspaceId ||
      frame.nodeId !== command.nodeId ||
      frame.workspaceId !== command.workspaceId ||
      execution.correlation.workspaceId !== command.workspaceId ||
      attempt.executionId !== command.executionId ||
      attempt.runtime?.runtimeNodeRefId !== command.nodeId ||
      attempt.runtime.runtimeConnectionId !== command.runtimeConnectionId
    ) {
      return this.#reject(frame, 'RUNTIME_EVENT_SCOPE_MISMATCH')
    }
    if (frame.payloadHash !== command.payloadHash) {
      return this.#reject(frame, 'RUNTIME_EVENT_PAYLOAD_MISMATCH')
    }
    if (
      command.lastChannelGeneration !== source.channelGeneration ||
      (historicalResult
        ? frame.channelGeneration > source.channelGeneration
        : frame.channelGeneration !== source.channelGeneration)
    ) {
      return this.#reject(frame, 'RUNTIME_EVENT_STALE_CHANNEL')
    }
    if (command.lastSequence !== undefined && frame.sequence < command.lastSequence) {
      return this.#reject(frame, 'RUNTIME_EVENT_STALE_SEQUENCE')
    }
    if (
      command.status === 'expired' ||
      (!allowTerminalCommand && ['succeeded', 'failed', 'cancelled'].includes(command.status))
    ) {
      return this.#reject(frame, 'RUNTIME_EVENT_COMMAND_TERMINAL')
    }
    return { command, execution, attempt }
  }

  async #applyTerminal(
    frame:
      | GatewayResultEnvelope
      | (GatewayErrorEnvelope & { commandId: string; payloadHash: string }),
    context: RuntimeEventContext,
    normalized: NormalizedRuntimeTerminal
  ): Promise<RuntimeEventEffectResult> {
    validateTerminal(normalized)
    this.#assertInlineBound(normalized.payload)
    if (
      'result' in frame &&
      'artifact' in frame.result &&
      normalized.resultReference !== frame.result.artifact.artifactId
    ) {
      return this.#reject(frame, 'RUNTIME_EVENT_NORMALIZATION_FAILED')
    }
    const occurredAt = 'completedAt' in frame ? frame.completedAt : frame.sentAt
    const result = await this.#effects.applyTerminal({
      commandId: frame.commandId,
      messageSequence: frame.sequence,
      frameHash: frameHash(frame),
      execution: context.execution,
      attempt: context.attempt,
      state: normalized.state,
      ...(normalized.resultReference ? { resultReference: normalized.resultReference } : {}),
      ...(normalized.failure ? { failure: normalized.failure } : {}),
      draft: this.#draft(
        context,
        frame,
        `execution.${normalized.state}`,
        normalized.payload,
        occurredAt
      ),
    })
    return this.#classify(frame, result)
  }

  #draft(
    context: RuntimeEventContext,
    frame:
      | GatewayProgressEnvelope
      | GatewayResultEnvelope
      | (GatewayErrorEnvelope & { commandId: string }),
    type: string,
    payload: ExecutionEventDraft['payload'],
    occurredAt: string
  ) {
    const recordedAt = this.#now()
    return ExecutionEventDraftSchema.parse({
      eventId: deterministicEventId(
        frame.commandId,
        type,
        'eventSequence' in frame ? frame.eventSequence : frame.sequence
      ),
      executionId: context.execution.executionId,
      attemptId: context.attempt.attemptId,
      type,
      schemaVersion: 1,
      correlation: {
        ...context.execution.correlation,
        commandId: frame.commandId,
        traceId: frame.traceId,
      },
      payload: { ...payload },
      occurredAt,
      recordedAt: recordedAt.toISOString(),
      retentionExpiresAt: new Date(recordedAt.getTime() + RETENTION_MS).toISOString(),
    })
  }

  #assertInlineBound(value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_INLINE_EVENT_BYTES) {
      fail('RUNTIME_EVENT_PAYLOAD_TOO_LARGE')
    }
  }

  async #classify(
    frame: { readonly commandId?: string },
    result: RuntimeEventEffectResult
  ): Promise<RuntimeEventEffectResult> {
    this.#metrics.increment(`runtime_gateway.event_${result.outcome}`)
    if (result.outcome === 'conflict') return this.#reject(frame, 'RUNTIME_EVENT_CONFLICT')
    return result
  }

  async #reject(frame: unknown, code: RuntimeEventIngestionErrorCode): Promise<never> {
    const candidate = frame as { commandId?: string }
    await this.#quarantine.record({
      ...(candidate.commandId ? { commandId: candidate.commandId } : {}),
      frameHash: frameHash(frame),
      reason: code,
      recordedAt: this.#now().toISOString(),
    })
    this.#metrics.increment(`runtime_gateway.event_rejected.${code}`)
    throw new RuntimeEventIngestionError(code)
  }
}

function validateTerminal(terminal: NormalizedRuntimeTerminal): void {
  if (terminal.state === 'completed') {
    RuntimeCommandResultReferenceSchema.parse(terminal.resultReference)
    if (terminal.failure !== undefined) fail('RUNTIME_EVENT_NORMALIZATION_FAILED')
  } else if (terminal.state === 'failed') {
    if (!terminal.failure || terminal.resultReference !== undefined)
      fail('RUNTIME_EVENT_NORMALIZATION_FAILED')
  } else if (terminal.failure !== undefined || terminal.resultReference !== undefined) {
    fail('RUNTIME_EVENT_NORMALIZATION_FAILED')
  }
}

function runtimeFailureCode(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'RUNTIME_FAILED'
  const code = (value as Record<string, unknown>)['code']
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : 'RUNTIME_FAILED'
}

function runtimeFailureRetryable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['retryable'] === true
  )
}

function progressEventType(type: RuntimeExecutionProgress['type']): string {
  if (type === 'usage') return 'usage.recorded'
  if (type === 'artifact') return 'artifact.recorded'
  if (type === 'interaction') return 'interaction.requested'
  return 'attempt.progressed'
}

function frameHash(value: unknown): string {
  const serializable = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  return `sha256:${hashExecutionEventPayload(serializable)}`
}

function deterministicEventId(commandId: string, type: string, sequence: number): string {
  const digest = createHash('sha256').update(`${commandId}:${type}:${sequence}`).digest()
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  return `evt_${Array.from(digest.subarray(0, 26), (byte) => alphabet[byte & 31]).join('')}`
}

function fail(code: RuntimeEventIngestionErrorCode): never {
  throw new RuntimeEventIngestionError(code)
}
