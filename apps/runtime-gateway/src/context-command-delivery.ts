import { createHash } from 'node:crypto'
import {
  ContextCommandRecordSchema,
  ContextCommandPendingQuerySchema,
  createQueuedContextCommandRecord,
  type ContextCommandRecord,
  type ContextCommandRepository,
} from '@control-plane/domain'
import {
  GatewayAcknowledgementEnvelopeSchema,
  GatewayCommandEnvelopeSchema,
  GatewayErrorEnvelopeSchema,
  GatewayResultEnvelopeSchema,
  type GatewayCommandEnvelope,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import type {
  ActiveRuntimeNodeChannelRecord,
  RuntimeNodeCoordinationPort,
} from './websocket-coordination.js'

export interface ContextCommandDeliveryOptions {
  readonly repository: ContextCommandRepository
  readonly coordination: Pick<RuntimeNodeCoordinationPort, 'lookup'>
  /** Use the authenticated lifecycle sender, which rechecks current ownership and capability policy. */
  readonly sender: { send(command: GatewayCommandEnvelope): Promise<void> }
  /** Must verify scope/content and durably store the result, idempotently by command and digest. */
  readonly results: {
    persist(
      command: ContextCommandRecord,
      result: GatewayResultEnvelope,
      digest: string
    ): Promise<string>
  }
  readonly now?: () => Date
}

export class ContextCommandDeliveryService {
  readonly #now: () => Date
  constructor(readonly options: ContextCommandDeliveryOptions) {
    this.#now = options.now ?? (() => new Date())
  }

  async enqueue(input: unknown): Promise<{ record: ContextCommandRecord; replayed: boolean }> {
    const command = GatewayCommandEnvelopeSchema.parse(input)
    const now = this.#now().toISOString()
    if (Date.parse(command.expiresAt) - Date.parse(command.issuedAt) > 86_400_000)
      fail('EXPIRY_TOO_LONG')
    if (Date.parse(command.expiresAt) <= Date.parse(now)) fail('EXPIRED')
    const candidate = createQueuedContextCommandRecord(command, now)
    const created = await this.options.repository.create(candidate)
    if (created.outcome === 'conflict') fail('PAYLOAD_MISMATCH')
    return { record: created.record, replayed: created.outcome === 'duplicate' }
  }

  async get(workspaceId: string, commandId: string): Promise<ContextCommandRecord | undefined> {
    return this.options.repository.get(workspaceId, commandId)
  }

  async redeliverPending(
    sourceInput: ActiveRuntimeNodeChannelRecord,
    input: {
      readonly limit: number
      readonly afterCommandId?: string
      /** Composition-owned allocator for the authenticated channel, not a locally invented sequence. */
      readonly nextSequence: () => Promise<number>
    }
  ): Promise<{ records: ContextCommandRecord[]; nextAfterCommandId?: string }> {
    const source = structuredClone(sourceInput)
    await this.#active(source)
    const pending = await this.options.repository.listPending(
      ContextCommandPendingQuerySchema.parse({
        workspaceId: source.workspaceId,
        nodeId: source.nodeId,
        limit: input.limit,
        ...(input.afterCommandId ? { afterCommandId: input.afterCommandId } : {}),
      })
    )
    const records: ContextCommandRecord[] = []
    for (const record of pending)
      records.push(
        (await this.deliver(source, record.commandId, await input.nextSequence())).record
      )
    const last = pending.at(-1)
    return {
      records,
      ...(last && pending.length === input.limit ? { nextAfterCommandId: last.commandId } : {}),
    }
  }

  async deliver(
    sourceInput: ActiveRuntimeNodeChannelRecord,
    commandId: string,
    sequence: number
  ): Promise<{ record: ContextCommandRecord; sent: boolean }> {
    const source = structuredClone(sourceInput)
    await this.#active(source)
    const current = await this.#required(source, commandId)
    if (terminal(current)) return { record: current, sent: false }
    const now = this.#now().toISOString()
    if (Date.parse(current.expiresAt) <= Date.parse(now)) {
      const record = await this.#save(current, {
        ...current,
        status: 'expired',
        terminalAt: now,
        updatedAt: now,
        version: current.version + 1,
      })
      return { record, sent: false }
    }
    const envelope = GatewayCommandEnvelopeSchema.parse({
      ...current.commandEnvelope,
      channelGeneration: source.channelGeneration,
      sequence,
      sentAt: now,
    })
    const record = await this.#save(current, {
      ...current,
      status: 'dispatched',
      version: current.version + 1,
      updatedAt: now,
      deliveryAttempts: current.deliveryAttempts + 1,
      lastDelivery: { channelGeneration: source.channelGeneration, sequence, at: now },
    })
    // Recheck after persistence: a replacement channel must not receive stale-generation work.
    await this.#active(source)
    try {
      await this.options.sender.send(envelope)
    } catch {
      fail('SEND_FAILED')
    }
    return { record, sent: true }
  }

  async acknowledge(
    sourceInput: ActiveRuntimeNodeChannelRecord,
    input: unknown
  ): Promise<{ record: ContextCommandRecord; duplicate: boolean }> {
    const source = structuredClone(sourceInput)
    const ack = GatewayAcknowledgementEnvelopeSchema.parse(input)
    const current = await this.#frame(source, ack)
    if (ack.sequence !== current.lastDelivery?.sequence) fail('STALE_SEQUENCE')
    const accepted = ack.disposition === 'accepted' || ack.disposition === 'replayed'
    if (current.status === 'acknowledged') {
      if (!accepted) fail('ACK_CONFLICT')
      return { record: current, duplicate: true }
    }
    const digest = fingerprint({
      type: 'ack',
      disposition: ack.disposition,
      payloadHash: ack.payloadHash,
    })
    if (terminal(current)) {
      if (accepted || current.completionDigest === digest)
        return { record: current, duplicate: true }
      fail('ACK_CONFLICT')
    }
    const now = this.#now().toISOString()
    await this.#active(source)
    const record = await this.#save(current, {
      ...current,
      version: current.version + 1,
      updatedAt: now,
      status: accepted ? 'acknowledged' : ack.disposition === 'expired' ? 'expired' : 'failed',
      ...(!accepted
        ? {
            terminalAt: now,
            completionDigest: digest,
            errorCode:
              ack.disposition === 'expired'
                ? 'CONTEXT_COMMAND_EXPIRED'
                : 'CONTEXT_COMMAND_REJECTED',
          }
        : {}),
    })
    return { record, duplicate: false }
  }

  async recordResult(
    sourceInput: ActiveRuntimeNodeChannelRecord,
    input: unknown
  ): Promise<{ record: ContextCommandRecord; duplicate: boolean }> {
    const source = structuredClone(sourceInput)
    const result = GatewayResultEnvelopeSchema.parse(input)
    if (Buffer.byteLength(JSON.stringify(result)) > 262144) fail('RESULT_TOO_LARGE')
    const current = await this.#frame(source, result)
    const digest = fingerprint({
      type: 'result',
      payloadHash: result.payloadHash,
      status: result.status,
      completedAt: result.completedAt,
      result: result.result,
    })
    if (terminal(current)) {
      if (current.completionDigest === digest) return { record: current, duplicate: true }
      fail('RESULT_CONFLICT')
    }
    let resultReference: ContextCommandRecord['resultReference']
    if (result.status === 'succeeded') {
      try {
        resultReference = ContextCommandRecordSchema.shape.resultReference
          .unwrap()
          .parse(
            await this.options.results.persist(
              structuredClone(current),
              structuredClone(result),
              digest
            )
          )
      } catch {
        fail('RESULT_STORE_FAILED')
      }
    }
    await this.#active(source)
    const now = this.#now().toISOString()
    const record = await this.#save(current, {
      ...current,
      status: result.status,
      version: current.version + 1,
      updatedAt: now,
      terminalAt: now,
      completionDigest: digest,
      ...(resultReference ? { resultReference } : {}),
      ...(result.status === 'failed' ? { errorCode: 'CONTEXT_PROVIDER_FAILED' } : {}),
    })
    return { record, duplicate: false }
  }

  async recordError(
    sourceInput: ActiveRuntimeNodeChannelRecord,
    input: unknown
  ): Promise<{ record: ContextCommandRecord; duplicate: boolean }> {
    const source = structuredClone(sourceInput)
    const error = GatewayErrorEnvelopeSchema.parse(input)
    if (!error.commandId || !error.payloadHash) fail('SCOPE_MISMATCH')
    const current = await this.#frame(source, {
      ...error,
      commandId: error.commandId,
      payloadHash: error.payloadHash,
    })
    const digest = fingerprint({
      type: 'error',
      code: error.code,
      retryable: error.retryable,
      payloadHash: error.payloadHash,
    })
    if (terminal(current)) {
      if (current.completionDigest === digest) return { record: current, duplicate: true }
      fail('RESULT_CONFLICT')
    }
    const now = this.#now().toISOString()
    await this.#active(source)
    const record = await this.#save(current, {
      ...current,
      status: 'failed',
      errorCode: error.code,
      version: current.version + 1,
      updatedAt: now,
      terminalAt: now,
      completionDigest: digest,
    })
    return { record, duplicate: false }
  }

  async #active(source: ActiveRuntimeNodeChannelRecord): Promise<void> {
    const active = await this.options.coordination.lookup(source.nodeId)
    if (
      !active ||
      ['nodeId', 'workspaceId', 'connectionId', 'gatewayInstanceId', 'channelGeneration'].some(
        (key) =>
          active[key as keyof ActiveRuntimeNodeChannelRecord] !==
          source[key as keyof ActiveRuntimeNodeChannelRecord]
      )
    )
      fail('STALE_CHANNEL')
  }
  async #required(
    source: ActiveRuntimeNodeChannelRecord,
    commandId: string
  ): Promise<ContextCommandRecord> {
    const current = await this.options.repository.get(source.workspaceId, commandId)
    if (!current || current.nodeId !== source.nodeId) fail('MISSING')
    return current
  }
  async #frame(
    source: ActiveRuntimeNodeChannelRecord,
    envelope: {
      nodeId: string
      workspaceId: string
      channelGeneration: number
      commandId: string
      payloadHash: string
    }
  ): Promise<ContextCommandRecord> {
    await this.#active(source)
    if (
      envelope.nodeId !== source.nodeId ||
      envelope.workspaceId !== source.workspaceId ||
      envelope.channelGeneration !== source.channelGeneration
    )
      fail('SCOPE_MISMATCH')
    const current = await this.#required(source, envelope.commandId)
    if (current.payloadHash !== envelope.payloadHash) fail('PAYLOAD_MISMATCH')
    if (current.lastDelivery?.channelGeneration !== source.channelGeneration) fail('STALE_CHANNEL')
    return current
  }
  async #save(
    current: ContextCommandRecord,
    input: ContextCommandRecord
  ): Promise<ContextCommandRecord> {
    const next = ContextCommandRecordSchema.parse(input)
    if (!(await this.options.repository.compareAndSet(current.version, next)))
      fail('CONCURRENT_UPDATE')
    return next
  }
}

function terminal(record: ContextCommandRecord): boolean {
  return ['succeeded', 'failed', 'cancelled', 'expired'].includes(record.status)
}
function fail(code: string): never {
  throw new Error(`CONTEXT_COMMAND_${code}`)
}
function fingerprint(input: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(input)).digest('hex')}`
}
function canonical(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`
  if (input && typeof input === 'object')
    return `{${Object.entries(input)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
      .join(',')}}`
  return JSON.stringify(input) ?? 'undefined'
}
