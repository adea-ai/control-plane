import { IdentifierSchemas } from '@control-plane/contracts'
import { redactTelemetryValue } from '@control-plane/telemetry'
import { createHash } from 'node:crypto'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()
const EventTypeSchema = z
  .string()
  .regex(/^(?:execution|attempt|interaction|usage|artifact|reconciliation)\.[a-z][a-z0-9_-]*$/)
const ErrorReferenceSchema = z
  .string()
  .max(512)
  .regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/)
const PublicationSchema = z.object({
  status: z.enum(['pending', 'published', 'failed', 'quarantined']),
  attempts: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  lastAttemptAt: TimestampSchema.optional(),
  nextAttemptAt: TimestampSchema.optional(),
  publishedAt: TimestampSchema.optional(),
  quarantinedAt: TimestampSchema.optional(),
  errorReference: ErrorReferenceSchema.optional(),
})

export const ExecutionEventSchema = z.object({
  eventId: IdentifierSchemas.eventId,
  executionId: IdentifierSchemas.executionId,
  attemptId: IdentifierSchemas.attemptId.optional(),
  workflowId: IdentifierSchemas.workflowId.optional(),
  sequence: z.number().int().positive(),
  type: EventTypeSchema,
  schemaVersion: z.number().int().positive(),
  correlation: z.object({
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId,
    taskId: IdentifierSchemas.taskId,
    agentId: IdentifierSchemas.agentId,
    requestId: IdentifierSchemas.requestId,
    commandId: IdentifierSchemas.commandId.optional(),
    traceId: IdentifierSchemas.traceId,
  }),
  payload: z.record(z.string(), z.json()),
  payloadBytes: z.number().int().nonnegative().max(16_384),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: TimestampSchema,
  recordedAt: TimestampSchema,
  retentionExpiresAt: TimestampSchema,
  archivedAt: TimestampSchema.optional(),
  publication: PublicationSchema,
})

export type ExecutionEvent = z.output<typeof ExecutionEventSchema>
export type ExecutionEventDraft = Omit<
  ExecutionEvent,
  'sequence' | 'payloadBytes' | 'payloadHash' | 'publication' | 'archivedAt'
>

export const ExecutionEventDraftSchema = ExecutionEventSchema.omit({
  sequence: true,
  payloadBytes: true,
  payloadHash: true,
  publication: true,
  archivedAt: true,
})

export function sanitizeExecutionEventDraft(draft: ExecutionEventDraft): ExecutionEventDraft {
  return ExecutionEventDraftSchema.parse({
    ...draft,
    payload: redactTelemetryValue(draft.payload),
  })
}

export interface ExecutionEventRepository {
  append(draft: ExecutionEventDraft): Promise<ExecutionEvent | undefined>
  get(eventId: string): Promise<ExecutionEvent | undefined>
  queryAfter(
    executionId: string,
    afterSequence: number,
    limit: number
  ): Promise<readonly ExecutionEvent[]>
  queryPending(limit: number, dueAt?: string): Promise<readonly ExecutionEvent[]>
  compareAndSetPublication(expectedVersion: number, event: ExecutionEvent): Promise<boolean>
  archive(eventId: string, archivedAt: string): Promise<ExecutionEvent | undefined>
}

export class InMemoryExecutionEventRepository implements ExecutionEventRepository {
  readonly #events = new Map<string, ExecutionEvent>()
  readonly #sequences = new Map<string, number>()

  async append(draft: ExecutionEventDraft): Promise<ExecutionEvent | undefined> {
    const sanitized = sanitizeExecutionEventDraft(draft)
    if (this.#events.has(sanitized.eventId)) return undefined
    const sequence = (this.#sequences.get(sanitized.executionId) ?? 0) + 1
    const event = ExecutionEventSchema.parse({
      ...sanitized,
      sequence,
      payloadBytes: Buffer.byteLength(JSON.stringify(sanitized.payload)),
      payloadHash: hashExecutionEventPayload(sanitized.payload),
      publication: { status: 'pending', attempts: 0, version: 1 },
    })
    this.#sequences.set(sanitized.executionId, sequence)
    this.#events.set(event.eventId, clone(event))
    return event
  }

  async get(eventId: string): Promise<ExecutionEvent | undefined> {
    return cloneOptional(this.#events.get(eventId))
  }

  async queryAfter(executionId: string, afterSequence: number, limit: number) {
    return [...this.#events.values()]
      .filter(
        (event) =>
          event.executionId === executionId && event.sequence > afterSequence && !event.archivedAt
      )
      .toSorted((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
      .map(clone)
  }

  async queryPending(limit: number, dueAt?: string): Promise<readonly ExecutionEvent[]> {
    return [...this.#events.values()]
      .filter(
        (event) =>
          (event.publication.status === 'pending' || event.publication.status === 'failed') &&
          !event.archivedAt &&
          (!dueAt ||
            !event.publication.nextAttemptAt ||
            Date.parse(event.publication.nextAttemptAt) <= Date.parse(dueAt))
      )
      .toSorted((left, right) => left.recordedAt.localeCompare(right.recordedAt))
      .slice(0, limit)
      .map(clone)
  }

  async compareAndSetPublication(expectedVersion: number, event: ExecutionEvent): Promise<boolean> {
    const current = this.#events.get(event.eventId)
    if (current?.publication.version !== expectedVersion) return false
    this.#events.set(event.eventId, clone(ExecutionEventSchema.parse(event)))
    return true
  }

  async archive(eventId: string, archivedAt: string): Promise<ExecutionEvent | undefined> {
    const current = this.#events.get(eventId)
    if (!current) return undefined
    const archived = ExecutionEventSchema.parse({ ...current, archivedAt })
    this.#events.set(eventId, clone(archived))
    return archived
  }
}

export type ExecutionEventErrorCode =
  | 'EVENT_EXISTS'
  | 'EVENT_MISSING'
  | 'EVENT_PAYLOAD_TOO_LARGE'
  | 'INVALID_EVENT'
  | 'STALE_PUBLICATION_VERSION'
  | 'EVENT_ALREADY_PUBLISHED'
  | 'EVENT_RETENTION_ACTIVE'

export class ExecutionEventError extends Error {
  constructor(readonly code: ExecutionEventErrorCode) {
    super(code)
    this.name = 'ExecutionEventError'
  }
}

export class ExecutionEventService {
  constructor(readonly repository: ExecutionEventRepository) {}

  async append(input: unknown): Promise<ExecutionEvent> {
    const candidate = input as Record<string, unknown>
    const payload = redactTelemetryValue(candidate['payload'])
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload))
    if (payloadBytes > 16_384) fail('EVENT_PAYLOAD_TOO_LARGE')
    const result = ExecutionEventDraftSchema.safeParse({ ...candidate, payload })
    if (!result.success) fail('INVALID_EVENT')
    const draft = result.data
    if (Date.parse(draft.retentionExpiresAt) <= Date.parse(draft.recordedAt)) fail('INVALID_EVENT')
    const event = await this.repository.append(draft)
    if (!event) fail('EVENT_EXISTS')
    return event
  }

  async recordPublicationFailure(input: unknown): Promise<ExecutionEvent> {
    const parsed = z
      .object({
        eventId: IdentifierSchemas.eventId,
        expectedPublicationVersion: z.number().int().positive(),
        attemptedAt: TimestampSchema,
        nextAttemptAt: TimestampSchema.optional(),
        errorReference: ErrorReferenceSchema,
      })
      .parse(input)
    const current = await this.#get(parsed.eventId)
    if (current.publication.status === 'published') fail('EVENT_ALREADY_PUBLISHED')
    return this.#save(parsed.expectedPublicationVersion, {
      ...current,
      publication: {
        status: 'failed',
        attempts: current.publication.attempts + 1,
        version: current.publication.version + 1,
        lastAttemptAt: parsed.attemptedAt,
        ...(parsed.nextAttemptAt ? { nextAttemptAt: parsed.nextAttemptAt } : {}),
        errorReference: parsed.errorReference,
      },
    })
  }

  async markPublished(input: unknown): Promise<ExecutionEvent> {
    const parsed = z
      .object({
        eventId: IdentifierSchemas.eventId,
        expectedPublicationVersion: z.number().int().positive(),
        publishedAt: TimestampSchema,
      })
      .parse(input)
    const current = await this.#get(parsed.eventId)
    if (current.publication.status === 'published') return current
    return this.#save(parsed.expectedPublicationVersion, {
      ...current,
      publication: {
        status: 'published',
        attempts: current.publication.attempts + 1,
        version: current.publication.version + 1,
        lastAttemptAt: parsed.publishedAt,
        publishedAt: parsed.publishedAt,
      },
    })
  }

  async quarantinePublication(input: unknown): Promise<ExecutionEvent> {
    const parsed = z
      .object({
        eventId: IdentifierSchemas.eventId,
        expectedPublicationVersion: z.number().int().positive(),
        quarantinedAt: TimestampSchema,
        errorReference: ErrorReferenceSchema,
        attempted: z.boolean(),
      })
      .parse(input)
    const current = await this.#get(parsed.eventId)
    if (current.publication.status === 'published') fail('EVENT_ALREADY_PUBLISHED')
    return this.#save(parsed.expectedPublicationVersion, {
      ...current,
      publication: {
        status: 'quarantined',
        attempts: current.publication.attempts + (parsed.attempted ? 1 : 0),
        version: current.publication.version + 1,
        ...(parsed.attempted ? { lastAttemptAt: parsed.quarantinedAt } : {}),
        quarantinedAt: parsed.quarantinedAt,
        errorReference: parsed.errorReference,
      },
    })
  }

  async requeuePublication(input: unknown): Promise<ExecutionEvent> {
    const parsed = z
      .object({
        eventId: IdentifierSchemas.eventId,
        expectedPublicationVersion: z.number().int().positive(),
        requestedAt: TimestampSchema,
      })
      .parse(input)
    const current = await this.#get(parsed.eventId)
    if (current.publication.status === 'published') fail('EVENT_ALREADY_PUBLISHED')
    return this.#save(parsed.expectedPublicationVersion, {
      ...current,
      publication: {
        status: 'pending',
        attempts: current.publication.attempts,
        version: current.publication.version + 1,
      },
    })
  }

  async archive(input: unknown): Promise<ExecutionEvent> {
    const parsed = z
      .object({ eventId: IdentifierSchemas.eventId, archivedAt: TimestampSchema })
      .parse(input)
    const current = await this.#get(parsed.eventId)
    if (Date.parse(parsed.archivedAt) <= Date.parse(current.retentionExpiresAt)) {
      fail('EVENT_RETENTION_ACTIVE')
    }
    const archived = await this.repository.archive(parsed.eventId, parsed.archivedAt)
    if (!archived) fail('EVENT_MISSING')
    return archived
  }

  async #save(expectedVersion: number, event: ExecutionEvent): Promise<ExecutionEvent> {
    if (!(await this.repository.compareAndSetPublication(expectedVersion, event))) {
      fail('STALE_PUBLICATION_VERSION')
    }
    return event
  }

  async #get(eventId: string): Promise<ExecutionEvent> {
    const event = await this.repository.get(eventId)
    if (!event) fail('EVENT_MISSING')
    return event
  }
}

function fail(code: ExecutionEventErrorCode): never {
  throw new ExecutionEventError(code)
}
function clone<Value>(value: Value): Value {
  return structuredClone(value)
}
function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : clone(value)
}

export function hashExecutionEventPayload(payload: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

export * from './runtime-ingestion.js'

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`
  }
  throw new Error('EVENT_PAYLOAD_MUST_BE_JSON')
}

export const packageName = 'events'
export * from './delivery.js'
