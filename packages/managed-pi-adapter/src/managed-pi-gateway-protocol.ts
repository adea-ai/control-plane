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
import {
  RuntimeAdapterError,
  RuntimeArtifactReferenceSchema,
  type RuntimeExecutionHandle,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'
import {
  ManagedPiEventSchema,
  ManagedPiInspectionSchema,
  type ManagedPiEvent,
  type ManagedPiInspection,
} from './index.js'
import type { ManagedPiGatewayExchange } from './managed-pi-gateway-types.js'
import type { ReferenceExecution, ReferenceManagedPiScenario } from './managed-pi-gateway-driver.js'

export function unavailableInspection(observedAt: string, limitation: string): ManagedPiInspection {
  return ManagedPiInspectionSchema.parse({
    driverVersion: '0.0.0',
    runtimeVersion: '0.0.0',
    protocolVersion: '1.4.0',
    health: 'unavailable',
    capabilities: [],
    limitations: [limitation],
    observedAt,
  })
}

export function normalizeGatewayProgress(progressInput: GatewayProgressEnvelope): ManagedPiEvent {
  const progress = GatewayProgressEnvelopeSchema.parse(progressInput)
  const common = { sequence: progress.eventSequence, occurredAt: progress.sentAt }
  switch (progress.event.kind) {
    case 'managed-pi.status':
      return ManagedPiEventSchema.parse({ ...common, kind: 'status', ...progress.event.data })
    case 'managed-pi.output':
      return ManagedPiEventSchema.parse({ ...common, kind: 'output', ...progress.event.data })
    case 'managed-pi.tool-request':
      return ManagedPiEventSchema.parse({ ...common, kind: 'tool_request', ...progress.event.data })
    case 'managed-pi.interaction':
      return ManagedPiEventSchema.parse({ ...common, kind: 'interaction', ...progress.event.data })
    case 'managed-pi.usage':
      return ManagedPiEventSchema.parse({ ...common, kind: 'usage', ...progress.event.data })
    case 'managed-pi.artifact':
      return ManagedPiEventSchema.parse({ ...common, kind: 'artifact', ...progress.event.data })
    case 'managed-pi.error':
      return ManagedPiEventSchema.parse({ ...common, kind: 'error', ...progress.event.data })
    default:
      throw new RuntimeAdapterError({
        code: 'MANAGED_PI_EVENT_UNSUPPORTED',
        classification: 'unsupported',
        message: 'Managed Pi progress event kind is unsupported',
        retryable: false,
      })
  }
}

export function scenarioExecution(
  handle: RuntimeExecutionHandle,
  scenario: ReferenceManagedPiScenario,
  observedAt: string
): ReferenceExecution {
  const artifact = RuntimeArtifactReferenceSchema.parse({
    artifactId: 'art_01JABCDEF0123456789ABCDEFG',
    version: 1,
    mediaType: 'application/json',
    digest: `sha256:${'e'.repeat(64)}`,
    sizeBytes: 32,
    locator: 'artifact://managed-pi/result',
  })
  const commonEvents: ManagedPiEvent[] = [
    { sequence: 1, occurredAt: observedAt, kind: 'status', state: 'running' },
    { sequence: 2, occurredAt: observedAt, kind: 'output', text: 'managed Pi running' },
    {
      sequence: 3,
      occurredAt: observedAt,
      kind: 'tool_request',
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
      toolId: 'project-files',
      operation: 'read',
    },
    {
      sequence: 4,
      occurredAt: observedAt,
      kind: 'usage',
      inputTokens: 12,
      outputTokens: 4,
      durationMs: 120,
    },
    { sequence: 5, occurredAt: observedAt, kind: 'artifact', artifact },
  ]
  if (scenario === 'complete') {
    const result = {
      output: { answer: 'managed-pi-complete' },
      usage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
      artifacts: [artifact],
    }
    return {
      handle,
      events: [
        ...commonEvents,
        { sequence: 6, occurredAt: observedAt, kind: 'status', state: 'succeeded' },
      ],
      status: { state: 'succeeded', observedAt, result },
    }
  }
  if (scenario === 'awaiting_input') {
    return {
      handle,
      events: [
        { sequence: 1, occurredAt: observedAt, kind: 'status', state: 'waiting_input' },
        {
          sequence: 2,
          occurredAt: observedAt,
          kind: 'interaction',
          interactionId: 'int_01JABCDEF0123456789ABCDEFG',
          interactionKind: 'input',
          prompt: 'Continue execution?',
        },
      ],
      status: { state: 'waiting_input', observedAt },
    }
  }
  if (scenario === 'running') {
    return { handle, events: commonEvents, status: { state: 'running', observedAt } }
  }
  const error =
    scenario === 'crash'
      ? runtimeError('PI_PROCESS_CRASHED', 'runtime', true)
      : scenario === 'timeout'
        ? runtimeError('PI_EXECUTION_TIMED_OUT', 'timeout', true)
        : runtimeError('PI_AMBIGUOUS_OUTCOME', 'unknown', false)
  const state = scenario === 'timeout' ? 'timed_out' : 'errored'
  return {
    handle,
    events: [
      { sequence: 1, occurredAt: observedAt, kind: 'status', state },
      { sequence: 2, occurredAt: observedAt, kind: 'error', error },
    ],
    status: { state, observedAt, error },
  }
}

export function progressEnvelope(
  command: GatewayCommandEnvelope,
  event: ManagedPiEvent
): GatewayProgressEnvelope {
  const { sequence, occurredAt, kind, ...data } = event
  return GatewayProgressEnvelopeSchema.parse({
    type: 'progress',
    schemaVersion: 1,
    protocolVersion: command.protocolVersion,
    sequence: command.sequence + sequence,
    nodeId: command.nodeId,
    workspaceId: command.workspaceId,
    traceId: command.traceId,
    sentAt: occurredAt,
    channelGeneration: command.channelGeneration,
    commandId: command.commandId,
    payloadHash: command.payloadHash,
    eventSequence: sequence,
    event: { kind: `managed-pi.${kind.replaceAll('_', '-')}`, data },
  })
}

export function successResult(
  command: GatewayCommandEnvelope,
  dataInput: unknown,
  completedAt: string
): GatewayResultEnvelope {
  const data = z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(dataInput)))
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
    result: { data },
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
    result: { data: { error: runtimeError(code, classification, retryable) } },
  })
}

export function runtimeError(
  code: string,
  classification: RuntimeErrorData['classification'],
  retryable: boolean
): RuntimeErrorData {
  return RuntimeErrorDataSchema.parse({ code, classification, message: code, retryable })
}

export function inlineParameters(command: GatewayCommandEnvelope): Record<string, z.util.JSONType> {
  if (!('parameters' in command.payload)) throw new Error('MANAGED_PI_INLINE_PAYLOAD_REQUIRED')
  return command.payload.parameters
}

export function assertExchange(
  command: GatewayCommandEnvelope,
  exchange: ManagedPiGatewayExchange
): void {
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
    throw new RuntimeAdapterError({
      code: 'RUNTIME_GATEWAY_CORRELATION_MISMATCH',
      classification: 'infrastructure',
      message: 'Runtime Gateway response correlation failed',
      retryable: false,
    })
  }
  exchange.progress.forEach((event) => GatewayProgressEnvelopeSchema.parse(event))
  if (exchange.result) GatewayResultEnvelopeSchema.parse(exchange.result)
  if (exchange.error) GatewayErrorEnvelopeSchema.parse(exchange.error)
}

export function gatewayIdempotencyKey(identity: string): string {
  return `managed-pi:${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`
}

export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}
