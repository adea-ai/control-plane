import {
  AgentHqExecutionEventEnvelopeSchema,
  type AgentHqExecutionEventEnvelope,
} from '@control-plane/contracts'
import type { ExecutionEvent, ExecutionEventRepository } from './index.js'

export type AgentHqDeliveryResult =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'retryable_failure'; readonly code: string }
  | { readonly outcome: 'permanent_failure'; readonly code: string }

export interface AgentHqEventTransport {
  deliver(envelope: AgentHqExecutionEventEnvelope): Promise<AgentHqDeliveryResult>
}

export interface ServiceAuthorizationProvider {
  getHeader(): Promise<string>
}

export interface HttpAgentHqEventTransportOptions {
  readonly endpoint: string
  readonly authorization: ServiceAuthorizationProvider
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export class HttpAgentHqEventTransport implements AgentHqEventTransport {
  readonly #endpoint: string
  readonly #authorization: ServiceAuthorizationProvider
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number

  constructor(options: HttpAgentHqEventTransportOptions) {
    const endpoint = new URL(options.endpoint)
    if (endpoint.protocol !== 'https:') {
      throw new Error('AGENT_HQ_DELIVERY_ENDPOINT_REQUIRES_HTTPS')
    }
    this.#endpoint = endpoint.toString()
    this.#authorization = options.authorization
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) {
      throw new Error('INVALID_AGENT_HQ_DELIVERY_TIMEOUT')
    }
  }

  async deliver(envelope: AgentHqExecutionEventEnvelope): Promise<AgentHqDeliveryResult> {
    const parsed = AgentHqExecutionEventEnvelopeSchema.parse(envelope)
    const authorization = await this.#authorization.getHeader()
    if (!/^(?:Bearer|DPoP) \S{16,4096}$/.test(authorization)) {
      return { outcome: 'permanent_failure', code: 'AUTHENTICATION_CONFIGURATION' }
    }
    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'x-event-id': parsed.eventId,
          'x-event-sequence': String(parsed.sequence),
        },
        body: JSON.stringify(parsed),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch {
      return { outcome: 'retryable_failure', code: 'TRANSPORT_ERROR' }
    }
    if (response.ok) return { outcome: 'accepted' }
    if ([408, 425, 429].includes(response.status) || response.status >= 500) {
      return { outcome: 'retryable_failure', code: `HTTP_${response.status}` }
    }
    return {
      outcome: 'permanent_failure',
      code:
        response.status === 409 || response.status === 422
          ? 'SCHEMA_MISMATCH'
          : `HTTP_${response.status}`,
    }
  }
}

export interface EventPublicationService {
  markPublished(input: unknown): Promise<ExecutionEvent>
  recordPublicationFailure(input: unknown): Promise<ExecutionEvent>
  quarantinePublication(input: unknown): Promise<ExecutionEvent>
}

export interface EventDeliveryObserver {
  record(input: {
    readonly eventId: string
    readonly outcome: 'delivered' | 'failed' | 'quarantined'
    readonly attempts: number
  }): void
}

/**
 * Observability port for quarantine outcomes with bounded label cardinality:
 * implementations map `reason` to a fixed reason-category set. The dispatcher
 * additionally isolates every hook call so a throwing metrics sink can never
 * change a delivery result.
 */
export interface EventDeliveryMetrics {
  recordQuarantine(input: { readonly reason: string; readonly attempted: boolean }): void
}

export interface ExecutionEventDispatcherOptions {
  readonly repository: ExecutionEventRepository
  readonly publicationService: EventPublicationService
  readonly transport: AgentHqEventTransport
  readonly now?: () => string
  readonly retry?: { readonly baseDelayMs: number; readonly maximumAttempts: number }
  readonly observer?: EventDeliveryObserver
  readonly metrics?: EventDeliveryMetrics
}

export class ExecutionEventDispatcher {
  readonly #repository: ExecutionEventRepository
  readonly #publicationService: EventPublicationService
  readonly #transport: AgentHqEventTransport
  readonly #now: () => string
  readonly #baseDelayMs: number
  readonly #maximumAttempts: number
  readonly #observer: EventDeliveryObserver | undefined
  readonly #metrics: EventDeliveryMetrics | undefined

  constructor(options: ExecutionEventDispatcherOptions) {
    this.#repository = options.repository
    this.#publicationService = options.publicationService
    this.#transport = options.transport
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#baseDelayMs = options.retry?.baseDelayMs ?? 1_000
    this.#maximumAttempts = options.retry?.maximumAttempts ?? 5
    this.#observer = options.observer
    this.#metrics = options.metrics
    if (this.#baseDelayMs < 1 || this.#maximumAttempts < 1) {
      throw new Error('INVALID_EVENT_DELIVERY_RETRY_POLICY')
    }
  }

  async dispatchBatch(limit: number): Promise<{
    delivered: number
    failed: number
    quarantined: number
  }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('INVALID_EVENT_DELIVERY_BATCH_LIMIT')
    }
    const now = this.#now()
    const events = await this.#repository.queryPending(limit, now)
    const result = { delivered: 0, failed: 0, quarantined: 0 }
    for (const event of events) {
      const outcome = await this.#dispatch(event, now)
      result[outcome] += 1
    }
    return result
  }

  async #dispatch(
    event: ExecutionEvent,
    attemptedAt: string
  ): Promise<'delivered' | 'failed' | 'quarantined'> {
    let envelope: AgentHqExecutionEventEnvelope
    try {
      envelope = createAgentHqExecutionEventEnvelope(event)
    } catch {
      await this.#quarantine(event, attemptedAt, 'SCHEMA_MISMATCH', false)
      return 'quarantined'
    }

    let delivery: AgentHqDeliveryResult
    try {
      delivery = await this.#transport.deliver(envelope)
    } catch {
      delivery = { outcome: 'retryable_failure', code: 'TRANSPORT_ERROR' }
    }

    if (delivery.outcome === 'accepted') {
      let published: ExecutionEvent
      try {
        published = await this.#publicationService.markPublished({
          eventId: event.eventId,
          expectedPublicationVersion: event.publication.version,
          publishedAt: attemptedAt,
        })
      } catch (error) {
        const latest = await this.#repository.get(event.eventId)
        if (latest?.publication.status !== 'published') throw error
        published = latest
      }
      this.#record(published, 'delivered')
      return 'delivered'
    }

    if (
      delivery.outcome === 'permanent_failure' ||
      event.publication.attempts + 1 >= this.#maximumAttempts
    ) {
      await this.#quarantine(event, attemptedAt, delivery.code, true)
      return 'quarantined'
    }

    const nextAttemptAt = new Date(
      Date.parse(attemptedAt) + this.#baseDelayMs * 2 ** event.publication.attempts
    ).toISOString()
    const failed = await this.#publicationService.recordPublicationFailure({
      eventId: event.eventId,
      expectedPublicationVersion: event.publication.version,
      attemptedAt,
      nextAttemptAt,
      errorReference: errorReference(delivery.code),
    })
    this.#record(failed, 'failed')
    return 'failed'
  }

  async #quarantine(
    event: ExecutionEvent,
    quarantinedAt: string,
    code: string,
    attempted: boolean
  ): Promise<void> {
    const quarantined = await this.#publicationService.quarantinePublication({
      eventId: event.eventId,
      expectedPublicationVersion: event.publication.version,
      quarantinedAt,
      errorReference: errorReference(code),
      attempted,
    })
    if (this.#metrics !== undefined) {
      try {
        this.#metrics.recordQuarantine({ reason: code, attempted })
      } catch {
        // Metrics export is isolated per emission and can never fail delivery.
      }
    }
    this.#record(quarantined, 'quarantined')
  }

  #record(event: ExecutionEvent, outcome: 'delivered' | 'failed' | 'quarantined'): void {
    this.#observer?.record({
      eventId: event.eventId,
      outcome,
      attempts: event.publication.attempts,
    })
  }
}

export function createAgentHqExecutionEventEnvelope(
  event: ExecutionEvent
): AgentHqExecutionEventEnvelope {
  if (containsRawRuntimePayload(event.payload)) throw new Error('RAW_RUNTIME_PAYLOAD')
  return AgentHqExecutionEventEnvelopeSchema.parse({
    contractVersion: { major: 1, minor: 0 },
    eventId: event.eventId,
    eventType: event.type,
    executionId: event.executionId,
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(event.workflowId ? { workflowId: event.workflowId } : {}),
    workspaceId: event.correlation.workspaceId,
    projectId: event.correlation.projectId,
    taskId: event.correlation.taskId,
    agentId: event.correlation.agentId,
    sequence: event.sequence,
    schemaVersion: event.schemaVersion,
    payloadHash: event.payloadHash,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    correlation: event.correlation,
    data: event.payload,
  })
}

const rawRuntimeKey =
  /(?:^|_)(?:raw|temporal|provider|harness|pi|acp|langgraph|litellm|mcp|e2b)(?:_|$)/i

function containsRawRuntimePayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsRawRuntimePayload)
  return Object.entries(value).some(
    ([key, nested]) => rawRuntimeKey.test(toSnakeCase(key)) || containsRawRuntimePayload(nested)
  )
}

function toSnakeCase(value: string): string {
  return value.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function errorReference(code: string): string {
  const slug = code
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
  return `delivery://agent-hq/${slug || 'unknown'}`
}
