import { createHash } from 'node:crypto'
import {
  GatewayAcknowledgementEnvelopeSchema,
  GatewayErrorEnvelopeSchema,
  GatewayProgressEnvelopeSchema,
  GatewayResultEnvelopeSchema,
  RuntimeErrorDataSchema,
  type GatewayCommandEnvelope,
  type GatewayProgressEnvelope,
  type GatewayResultEnvelope,
  type RuntimeErrorData,
} from '@control-plane/runtime-gateway-protocol'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { AcpUpdateSchema, type AcpUpdate } from './acp-schemas.js'
import type { AcpGatewayExchange } from './acp-gateway-types.js'

export function normalizeAcpProgress(progressInput: GatewayProgressEnvelope): AcpUpdate {
  const progress = GatewayProgressEnvelopeSchema.parse(progressInput)
  if (progress.event.kind !== 'acp.update') {
    throw runtimeError('ACP_GATEWAY_EVENT_UNSUPPORTED', 'unsupported', false)
  }
  return AcpUpdateSchema.parse(progress.event.data)
}

export function progressEnvelope(
  command: GatewayCommandEnvelope,
  update: AcpUpdate,
  eventSequence: number
): GatewayProgressEnvelope {
  return GatewayProgressEnvelopeSchema.parse({
    type: 'progress',
    schemaVersion: 1,
    protocolVersion: command.protocolVersion,
    sequence: command.sequence + eventSequence,
    nodeId: command.nodeId,
    workspaceId: command.workspaceId,
    traceId: command.traceId,
    sentAt: command.sentAt,
    channelGeneration: command.channelGeneration,
    commandId: command.commandId,
    payloadHash: command.payloadHash,
    eventSequence,
    event: { kind: 'acp.update', data: jsonRecord(update) },
  })
}

export function successResult(
  command: GatewayCommandEnvelope,
  dataInput: unknown,
  completedAt: string
): GatewayResultEnvelope {
  return GatewayResultEnvelopeSchema.parse({
    type: 'result',
    schemaVersion: 1,
    protocolVersion: command.protocolVersion,
    sequence: command.sequence + 1,
    nodeId: command.nodeId,
    workspaceId: command.workspaceId,
    traceId: command.traceId,
    sentAt: completedAt,
    channelGeneration: command.channelGeneration,
    commandId: command.commandId,
    payloadHash: command.payloadHash,
    status: 'succeeded',
    completedAt,
    result: { data: jsonRecord(dataInput) },
  })
}

export function failureResult(
  command: GatewayCommandEnvelope,
  code: string,
  classification: RuntimeErrorData['classification'],
  retryable: boolean,
  completedAt: string
): GatewayResultEnvelope {
  return GatewayResultEnvelopeSchema.parse({
    type: 'result',
    schemaVersion: 1,
    protocolVersion: command.protocolVersion,
    sequence: command.sequence + 1,
    nodeId: command.nodeId,
    workspaceId: command.workspaceId,
    traceId: command.traceId,
    sentAt: completedAt,
    channelGeneration: command.channelGeneration,
    commandId: command.commandId,
    payloadHash: command.payloadHash,
    status: 'failed',
    completedAt,
    result: { data: { error: errorData(code, classification, retryable) } },
  })
}

export function runtimeError(
  code: string,
  classification: RuntimeErrorData['classification'],
  retryable: boolean
): RuntimeAdapterError {
  return new RuntimeAdapterError({ code, classification, message: code, retryable })
}

export function withGatewayTimeout<Value>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<Value>,
  upstreamSignal?: AbortSignal
): Promise<Value> {
  const controller = new AbortController()
  return new Promise<Value>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      upstreamSignal?.removeEventListener('abort', abort)
      complete()
    }
    const timeout = () => runtimeError('RUNTIME_GATEWAY_TIMEOUT', 'timeout', true)
    const abort = () => {
      finish(() => reject(timeout()))
      controller.abort()
    }
    const timer = setTimeout(abort, timeoutMs)
    timer.unref?.()
    if (upstreamSignal?.aborted) {
      abort()
      return
    }
    upstreamSignal?.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error))
      )
  })
}

export function errorData(
  code: string,
  classification: RuntimeErrorData['classification'],
  retryable: boolean
) {
  return RuntimeErrorDataSchema.parse({ code, classification, message: code, retryable })
}

export function inlineParameters(command: GatewayCommandEnvelope): Record<string, z.util.JSONType> {
  if (!('parameters' in command.payload)) throw new Error('ACP_INLINE_PAYLOAD_REQUIRED')
  return command.payload.parameters
}

export function assertExchange(command: GatewayCommandEnvelope, exchange: AcpGatewayExchange): void {
  GatewayAcknowledgementEnvelopeSchema.parse(exchange.ack)
  if (
    exchange.ack.commandId !== command.commandId ||
    exchange.ack.payloadHash !== command.payloadHash ||
    exchange.progress.some(
      (event) => event.commandId !== command.commandId || event.payloadHash !== command.payloadHash
    ) ||
    (exchange.result !== undefined &&
      (exchange.result.commandId !== command.commandId ||
        exchange.result.payloadHash !== command.payloadHash)) ||
    (exchange.error !== undefined &&
      (exchange.error.commandId !== command.commandId ||
        exchange.error.payloadHash !== command.payloadHash))
  ) {
    throw runtimeError('RUNTIME_GATEWAY_CORRELATION_MISMATCH', 'infrastructure', false)
  }
  exchange.progress.forEach((event) => GatewayProgressEnvelopeSchema.parse(event))
  if (exchange.result) GatewayResultEnvelopeSchema.parse(exchange.result)
  if (exchange.error) GatewayErrorEnvelopeSchema.parse(exchange.error)
}

export function gatewayIdempotencyKey(identity: string): string {
  return `acp:${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`
}

export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`
}

export function stable(value: unknown): string {
  return JSON.stringify(value)
}

export function jsonRecord(value: unknown): Record<string, z.util.JSONType> {
  return z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)))
}
