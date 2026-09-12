import {
  CortanaClientRequestSchema,
  type CortanaClientPort,
  type CortanaClientRequest,
} from '@control-plane/cortana-context-adapter'
import { createQueuedContextCommandRecord, type ContextCommandRecord } from '@control-plane/domain'
import { GatewayCommandEnvelopeSchema } from '@control-plane/runtime-gateway-protocol'
import type { ContextCommandDeliveryService } from './context-command-delivery.js'
import type { ContextCommandArtifactStore } from './context-result-store.js'
import type {
  ActiveRuntimeNodeChannelRecord,
  RuntimeNodeCoordinationPort,
} from './websocket-coordination.js'

export interface ContextGatewayReadClientOptions {
  readonly delivery: Pick<ContextCommandDeliveryService, 'enqueue' | 'get' | 'deliver'>
  readonly artifacts: Pick<ContextCommandArtifactStore, 'read'>
  readonly coordination: Pick<RuntimeNodeCoordinationPort, 'lookup'>
  /** Trusted scope/grant authority. Channel ownership is separately checked by delivery and lifecycle. */
  readonly authorize: (record: ContextCommandRecord, action: 'dispatch' | 'read') => Promise<void>
  readonly nextSequence: (channel: ActiveRuntimeNodeChannelRecord) => Promise<number>
  readonly pollIntervalMs?: number
}

export class ContextGatewayReadError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ContextGatewayReadError'
  }
}

/** Cancellation stops waiting; it does not erase durable commands or claim cancellation of provider effects. */
export class ContextGatewayReadClient implements CortanaClientPort {
  readonly #interval: number
  constructor(readonly options: ContextGatewayReadClientOptions) {
    this.#interval = options.pollIntervalMs ?? 25
    if (!Number.isSafeInteger(this.#interval) || this.#interval < 10 || this.#interval > 1000)
      fail('INVALID_POLL_INTERVAL')
  }

  async read(input: CortanaClientRequest, callerSignal: AbortSignal): Promise<unknown> {
    const request = CortanaClientRequestSchema.parse(input)
    const command = GatewayCommandEnvelopeSchema.parse(request.gatewayCommand)
    const candidate = createQueuedContextCommandRecord(command, command.issuedAt)
    const parameters = (
      candidate.commandEnvelope['payload'] as { parameters: Record<string, unknown> }
    ).parameters
    if (
      request.transport !== 'runtime_node' ||
      [
        'objective',
        'operationId',
        'mappedProjectRef',
        'scopeDigest',
        'principalRef',
        'maximumTokens',
        'includeEvidence',
        'includeMemory',
      ].some((key) => request[key as keyof CortanaClientRequest] !== parameters[key])
    )
      fail('REQUEST_MISMATCH')
    const deadline = Date.parse(request.deadline)
    const remaining = deadline - Date.now()
    if (
      !Number.isFinite(remaining) ||
      remaining <= 0 ||
      remaining > 300000 ||
      deadline > Date.parse(command.expiresAt)
    )
      fail('DEADLINE_INVALID')
    const controller = new AbortController()
    const signal = AbortSignal.any([callerSignal, controller.signal])
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, remaining)
    const abort = deferredAbort(signal)
    try {
      return await Promise.race([this.#read(candidate, signal), abort.promise])
    } catch (error) {
      if (signal.aborted) return fail(timedOut ? 'TIMEOUT' : 'ABORTED')
      if (error instanceof ContextGatewayReadError) throw error
      return fail('READ_FAILED')
    } finally {
      clearTimeout(timer)
      abort.close()
      controller.abort()
    }
  }

  async #read(candidate: ContextCommandRecord, signal: AbortSignal) {
    signal.throwIfAborted()
    await this.options.authorize(structuredClone(candidate), 'dispatch')
    signal.throwIfAborted()
    let record = (await this.options.delivery.enqueue(candidate.commandEnvelope)).record
    signal.throwIfAborted()
    if (
      record.payloadHash !== candidate.payloadHash ||
      record.nodeId !== candidate.nodeId ||
      JSON.stringify(record.scope) !== JSON.stringify(candidate.scope)
    )
      fail('IDENTITY_CONFLICT')
    if (['queued', 'dispatched', 'acknowledged'].includes(record.status)) {
      const channel = await this.options.coordination.lookup(record.nodeId)
      signal.throwIfAborted()
      if (!channel || channel.workspaceId !== record.scope.workspaceId) fail('CHANNEL_UNAVAILABLE')
      await this.options.authorize(structuredClone(record), 'dispatch')
      signal.throwIfAborted()
      const sequence = await this.options.nextSequence(structuredClone(channel))
      signal.throwIfAborted()
      await this.options.authorize(structuredClone(record), 'dispatch')
      signal.throwIfAborted()
      await this.options.delivery.deliver(channel, record.commandId, sequence)
    }
    while (true) {
      signal.throwIfAborted()
      const current = await this.options.delivery.get(record.scope.workspaceId, record.commandId)
      signal.throwIfAborted()
      if (
        !current ||
        current.payloadHash !== candidate.payloadHash ||
        current.nodeId !== candidate.nodeId ||
        JSON.stringify(current.scope) !== JSON.stringify(candidate.scope)
      )
        fail('IDENTITY_CONFLICT')
      record = current
      if (record.status === 'succeeded') {
        await this.options.authorize(structuredClone(record), 'read')
        signal.throwIfAborted()
        const result = await this.options.artifacts.read(record)
        signal.throwIfAborted()
        await this.options.authorize(structuredClone(record), 'read')
        signal.throwIfAborted()
        return result
      }
      if (['failed', 'cancelled', 'expired'].includes(record.status))
        fail('COMMAND_TERMINAL_FAILURE')
      await delay(this.#interval, signal)
    }
  }
}

function deferredAbort(signal: AbortSignal) {
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<never>((_, no) => {
    reject = no
  })
  const onAbort = () => reject(new Error('CONTEXT_GATEWAY_WAIT_ABORTED'))
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  return { promise, close: () => signal.removeEventListener('abort', onAbort) }
}
async function delay(ms: number, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = deferredAbort(signal)
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      }),
      abort.promise,
    ])
  } finally {
    clearTimeout(timer)
    abort.close()
  }
}
function fail(code: string): never {
  throw new ContextGatewayReadError(`CONTEXT_GATEWAY_${code}`)
}
