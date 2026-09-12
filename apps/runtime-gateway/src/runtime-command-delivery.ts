import {
  createQueuedRuntimeCommandRecord,
  RuntimeCommandRecordSchema,
  RuntimeCommandResultReferenceSchema,
  type RuntimeCommandRecord,
  type RuntimeCommandRepository,
} from '@control-plane/domain'
import {
  GatewayAcknowledgementEnvelopeSchema,
  GatewayCommandEnvelopeSchema,
  GatewayErrorEnvelopeSchema,
  GatewayResultEnvelopeSchema,
  type GatewayCommandEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import type { GatewayMetrics } from './websocket-coordination.js'
import type { ActiveRuntimeNodeChannelRecord } from './websocket-coordination.js'

export interface RuntimeCommandSender {
  send(envelope: GatewayCommandEnvelope): Promise<void>
}

export interface RuntimeCommandDeliveryServiceOptions {
  readonly repository: RuntimeCommandRepository
  readonly sender: RuntimeCommandSender
  readonly metrics: GatewayMetrics
  readonly now?: () => Date
}

export type RuntimeCommandDeliveryErrorCode =
  | 'RUNTIME_COMMAND_MISSING'
  | 'RUNTIME_COMMAND_PAYLOAD_MISMATCH'
  | 'RUNTIME_COMMAND_TERMINAL'
  | 'RUNTIME_COMMAND_STALE_CHANNEL'
  | 'RUNTIME_COMMAND_STALE_SEQUENCE'
  | 'RUNTIME_COMMAND_ACK_CONFLICT'
  | 'RUNTIME_COMMAND_RESULT_CONFLICT'
  | 'RUNTIME_COMMAND_SCOPE_MISMATCH'
  | 'RUNTIME_COMMAND_CONCURRENT_UPDATE'
  | 'RUNTIME_COMMAND_SEND_FAILED'

export class RuntimeCommandDeliveryError extends Error {
  constructor(readonly code: RuntimeCommandDeliveryErrorCode) {
    super(code)
    this.name = 'RuntimeCommandDeliveryError'
  }
}

export class RuntimeCommandDeliveryService {
  readonly #metrics: GatewayMetrics
  readonly #now: () => Date
  readonly #repository: RuntimeCommandRepository
  readonly #sender: RuntimeCommandSender

  constructor(options: RuntimeCommandDeliveryServiceOptions) {
    this.#repository = options.repository
    this.#sender = options.sender
    this.#metrics = options.metrics
    this.#now = options.now ?? (() => new Date())
  }

  async enqueue(commandValue: unknown): Promise<{
    readonly record: RuntimeCommandRecord
    readonly replayed: boolean
  }> {
    const command = GatewayCommandEnvelopeSchema.parse(commandValue)
    if (
      command.family !== 'runtime' ||
      command.executionId === undefined ||
      command.attemptId === undefined ||
      command.runtimeConnectionId === undefined
    ) {
      throw new RuntimeCommandDeliveryError('RUNTIME_COMMAND_SCOPE_MISMATCH')
    }
    const now = this.#now().toISOString()
    const record = createQueuedRuntimeCommandRecord(command, now)
    const created = await this.#repository.create(record)
    if (created.outcome === 'conflict') {
      throw new RuntimeCommandDeliveryError('RUNTIME_COMMAND_PAYLOAD_MISMATCH')
    }
    return { record: created.record, replayed: created.outcome === 'duplicate' }
  }

  async deliver(
    commandId: string,
    transport: { readonly channelGeneration: number; readonly sequence: number }
  ): Promise<{
    readonly record: RuntimeCommandRecord
    readonly sent: boolean
    readonly terminalResultReference?: string
  }> {
    const current = await this.#required(commandId)
    if (isTerminalResult(current.status)) {
      return {
        record: current,
        sent: false,
        ...(current.resultReference === undefined
          ? {}
          : { terminalResultReference: current.resultReference }),
      }
    }
    if (current.status === 'expired') fail('RUNTIME_COMMAND_TERMINAL')
    const now = this.#now()
    if (Date.parse(current.expiresAt) <= now.getTime()) {
      const expired = await this.#save(current, {
        ...current,
        status: 'expired',
        version: current.version + 1,
        updatedAt: now.toISOString(),
      })
      this.#metrics.increment('runtime_gateway.command_expiries')
      return { record: expired, sent: false }
    }
    if (
      current.lastChannelGeneration !== undefined &&
      transport.channelGeneration < current.lastChannelGeneration
    ) {
      fail('RUNTIME_COMMAND_STALE_CHANNEL')
    }
    if (
      current.lastChannelGeneration === transport.channelGeneration &&
      current.lastSequence !== undefined &&
      transport.sequence <= current.lastSequence
    ) {
      fail('RUNTIME_COMMAND_STALE_SEQUENCE')
    }

    const dispatchedAt = now.toISOString()
    const next = await this.#save(current, {
      ...current,
      status: 'dispatched',
      version: current.version + 1,
      deliveryAttempts: current.deliveryAttempts + 1,
      lastChannelGeneration: transport.channelGeneration,
      lastSequence: transport.sequence,
      firstDispatchedAt: current.firstDispatchedAt ?? dispatchedAt,
      lastDispatchedAt: dispatchedAt,
      updatedAt: dispatchedAt,
    })
    this.#metrics.observe(
      'runtime_gateway.command_queue_age_ms',
      Math.max(0, now.getTime() - Date.parse(current.issuedAt))
    )
    if (current.deliveryAttempts > 0) {
      this.#metrics.increment('runtime_gateway.command_redeliveries')
    }
    const envelope = GatewayCommandEnvelopeSchema.parse({
      ...current.commandEnvelope,
      channelGeneration: transport.channelGeneration,
      sequence: transport.sequence,
      sentAt: dispatchedAt,
    })
    try {
      await this.#sender.send(envelope)
    } catch {
      fail('RUNTIME_COMMAND_SEND_FAILED')
    }
    return { record: next, sent: true }
  }

  async acknowledge(acknowledgementValue: unknown): Promise<{
    readonly record: RuntimeCommandRecord
    readonly duplicate: boolean
  }> {
    const acknowledgement = GatewayAcknowledgementEnvelopeSchema.parse(acknowledgementValue)
    const current = await this.#required(acknowledgement.commandId)
    this.#assertEnvelopeScope(current, acknowledgement)
    if (acknowledgement.payloadHash !== current.payloadHash) {
      fail('RUNTIME_COMMAND_PAYLOAD_MISMATCH')
    }
    const reference = `ack:${acknowledgement.channelGeneration}:${acknowledgement.sequence}`
    if (current.acknowledgementReference !== undefined) {
      if (
        current.acknowledgementReference === reference &&
        current.acknowledgementDisposition === acknowledgement.disposition
      ) {
        return { record: current, duplicate: true }
      }
      fail('RUNTIME_COMMAND_ACK_CONFLICT')
    }
    if (isTerminal(current.status)) {
      fail('RUNTIME_COMMAND_TERMINAL')
    }
    const now = this.#now()
    const status = acknowledgementStatus(acknowledgement.disposition)
    const next = await this.#save(current, {
      ...current,
      status,
      version: current.version + 1,
      acknowledgementReference: reference,
      acknowledgementDisposition: acknowledgement.disposition,
      acknowledgedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    if (current.lastDispatchedAt !== undefined) {
      this.#metrics.observe(
        'runtime_gateway.command_ack_latency_ms',
        Math.max(0, now.getTime() - Date.parse(current.lastDispatchedAt))
      )
    }
    return { record: next, duplicate: false }
  }

  async recordResult(
    resultValue: unknown,
    resultReferenceValue?: unknown
  ): Promise<{ readonly record: RuntimeCommandRecord; readonly duplicate: boolean }> {
    const result = GatewayResultEnvelopeSchema.parse(resultValue)
    const resultReference =
      resultReferenceValue === undefined
        ? undefined
        : RuntimeCommandResultReferenceSchema.parse(resultReferenceValue)
    const current = await this.#required(result.commandId)
    this.#assertRecordedResultScope(current, result)
    if (result.payloadHash !== current.payloadHash) {
      fail('RUNTIME_COMMAND_PAYLOAD_MISMATCH')
    }
    if (current.resultStatus !== undefined) {
      if (current.resultReference === resultReference && current.resultStatus === result.status) {
        return { record: current, duplicate: true }
      }
      fail('RUNTIME_COMMAND_RESULT_CONFLICT')
    }
    if (isTerminal(current.status)) {
      fail('RUNTIME_COMMAND_RESULT_CONFLICT')
    }
    const now = this.#now().toISOString()
    const next = await this.#save(current, {
      ...current,
      status: result.status,
      version: current.version + 1,
      ...(resultReference === undefined ? {} : { resultReference }),
      resultStatus: result.status,
      resultRecordedAt: now,
      updatedAt: now,
    })
    return { record: next, duplicate: false }
  }

  async recordError(
    errorValue: unknown
  ): Promise<{ readonly record: RuntimeCommandRecord; readonly duplicate: boolean }> {
    const error = GatewayErrorEnvelopeSchema.parse(errorValue)
    if (error.commandId === undefined || error.payloadHash === undefined) {
      fail('RUNTIME_COMMAND_SCOPE_MISMATCH')
    }
    const current = await this.#required(error.commandId)
    this.#assertRecordedResultScope(current, error)
    if (error.payloadHash !== current.payloadHash) fail('RUNTIME_COMMAND_PAYLOAD_MISMATCH')
    if (current.resultStatus !== undefined) {
      if (current.resultStatus === 'failed' && current.resultReference === undefined) {
        return { record: current, duplicate: true }
      }
      fail('RUNTIME_COMMAND_RESULT_CONFLICT')
    }
    if (isTerminal(current.status)) fail('RUNTIME_COMMAND_RESULT_CONFLICT')
    const now = this.#now().toISOString()
    const next = await this.#save(current, {
      ...current,
      status: 'failed',
      version: current.version + 1,
      resultStatus: 'failed',
      resultRecordedAt: now,
      updatedAt: now,
    })
    return { record: next, duplicate: false }
  }

  async redeliverPending(
    nodeId: string,
    input: {
      readonly channelGeneration: number
      readonly firstSequence: number
      readonly limit: number
    }
  ): Promise<RuntimeCommandRecord[]> {
    const records = await this.#repository.listDispatchable(
      nodeId,
      this.#now().toISOString(),
      input.limit
    )
    const delivered: RuntimeCommandRecord[] = []
    for (const [index, record] of records.entries()) {
      const result = await this.deliver(record.commandId, {
        channelGeneration: input.channelGeneration,
        sequence: input.firstSequence + index,
      })
      delivered.push(result.record)
    }
    return delivered
  }

  async get(commandId: string): Promise<RuntimeCommandRecord | undefined> {
    return this.#repository.get(commandId)
  }

  async #required(commandId: string): Promise<RuntimeCommandRecord> {
    const record = await this.#repository.get(commandId)
    if (record === undefined) fail('RUNTIME_COMMAND_MISSING')
    return record
  }

  async #save(
    current: RuntimeCommandRecord,
    nextValue: RuntimeCommandRecord
  ): Promise<RuntimeCommandRecord> {
    const next = RuntimeCommandRecordSchema.parse(nextValue)
    if (!(await this.#repository.compareAndSet(current.version, next))) {
      fail('RUNTIME_COMMAND_CONCURRENT_UPDATE')
    }
    return next
  }

  #assertEnvelopeScope(
    current: RuntimeCommandRecord,
    envelope: {
      readonly nodeId: string
      readonly workspaceId: string
      readonly channelGeneration: number
      readonly sequence: number
    }
  ): void {
    if (
      envelope.nodeId !== current.nodeId ||
      envelope.workspaceId !== current.workspaceId ||
      envelope.channelGeneration !== current.lastChannelGeneration ||
      envelope.sequence !== current.lastSequence
    ) {
      fail('RUNTIME_COMMAND_SCOPE_MISMATCH')
    }
  }

  #assertRecordedResultScope(
    current: RuntimeCommandRecord,
    result: {
      readonly nodeId: string
      readonly workspaceId: string
      readonly channelGeneration: number
    }
  ): void {
    if (
      result.nodeId !== current.nodeId ||
      result.workspaceId !== current.workspaceId ||
      current.lastChannelGeneration === undefined ||
      result.channelGeneration > current.lastChannelGeneration
    ) {
      fail('RUNTIME_COMMAND_SCOPE_MISMATCH')
    }
  }
}

export interface RuntimePendingCommandDispatcherOptions {
  readonly repository: RuntimeCommandRepository
  readonly delivery: Pick<RuntimeCommandDeliveryService, 'deliver'>
  readonly now?: () => Date
  readonly limit?: number
}

export class RuntimePendingCommandDispatcher {
  readonly #delivery: RuntimePendingCommandDispatcherOptions['delivery']
  readonly #limit: number
  readonly #now: () => Date
  readonly #repository: RuntimeCommandRepository

  constructor(options: RuntimePendingCommandDispatcherOptions) {
    this.#repository = options.repository
    this.#delivery = options.delivery
    this.#now = options.now ?? (() => new Date())
    this.#limit = options.limit ?? 128
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1 || this.#limit > 1_000) {
      throw new Error('RUNTIME_PENDING_COMMAND_LIMIT_INVALID')
    }
  }

  async dispatch(
    source: ActiveRuntimeNodeChannelRecord,
    firstSequence: number,
    nextSequence?: () => Promise<number>
  ): Promise<number> {
    if (!Number.isSafeInteger(firstSequence) || firstSequence < 1) {
      throw new Error('RUNTIME_PENDING_COMMAND_SEQUENCE_INVALID')
    }
    const dispatchable = await this.#repository.listDispatchable(
      source.nodeId,
      this.#now().toISOString(),
      this.#limit
    )
    let delivered = 0
    for (const command of dispatchable) {
      if (command.status !== 'queued' || command.workspaceId !== source.workspaceId) continue
      const outcome = await this.#delivery.deliver(command.commandId, {
        channelGeneration: source.channelGeneration,
        sequence: nextSequence ? await nextSequence() : firstSequence + delivered,
      })
      if (outcome.sent) delivered += 1
    }
    return delivered
  }
}

function acknowledgementStatus(
  disposition: 'accepted' | 'replayed' | 'rejected' | 'expired'
): RuntimeCommandRecord['status'] {
  if (disposition === 'rejected') return 'failed'
  if (disposition === 'expired') return 'expired'
  return 'acknowledged'
}

function isTerminal(status: RuntimeCommandRecord['status']): boolean {
  return isTerminalResult(status) || status === 'expired'
}

function isTerminalResult(status: RuntimeCommandRecord['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

function fail(code: RuntimeCommandDeliveryErrorCode): never {
  throw new RuntimeCommandDeliveryError(code)
}
