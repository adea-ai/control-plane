import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  IdentifierSchemas,
  type EventId,
  type TraceId,
  type WorkflowId,
} from '@control-plane/contracts'
import {
  CommandInboxRecordSchema,
  ExecutionAttemptSchema,
  ExecutionSchema,
  type CommandAcceptanceRepository,
  type ExecutionRepository,
} from '@control-plane/domain'
import {
  ExecutionEventError,
  ExecutionEventService,
  sanitizeExecutionEventDraft,
  type ExecutionEvent,
  type ExecutionEventDraft,
  type ExecutionEventRepository,
  type GraphExecutionEventType,
} from '@control-plane/events'
import {
  assertExecutionPlanIntegrity,
  type ExecutionPlanRepository,
} from '@control-plane/execution-plan'
import {
  GraphEventSchema,
  type GraphEvent,
  type GraphEventPublisher,
} from '@control-plane/orchestration'
import { z } from 'zod'

const IdempotencyKeySchema = z.string().min(1).max(512)
const GRAPH_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const EVENT_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const publicTypes: Partial<Record<GraphEvent['type'], GraphExecutionEventType>> = {
  'graph.started': 'graph.started',
  'graph.node.started': 'graph.node_started',
  'graph.node.completed': 'graph.node_completed',
  'graph.completed': 'graph.completed',
}

export interface DurableGraphEventPublisherOptions {
  /** Root-execution command authority; parented children fail closed until delegation authority exists. */
  readonly commands: Pick<CommandAcceptanceRepository, 'getByExecutionId' | 'getExecution'>
  readonly attempts: Pick<ExecutionRepository, 'getAttempt'>
  readonly plans: Pick<ExecutionPlanRepository, 'get'>
  readonly events: ExecutionEventRepository
  /** The configured `executionEventsMs` policy value. */
  readonly retentionMs?: number
  readonly now?: () => string
}

/** Publishes only graph lifecycle events with a public Data API contract. */
export class DurableGraphEventPublisher implements GraphEventPublisher {
  readonly #commands: DurableGraphEventPublisherOptions['commands']
  readonly #attempts: DurableGraphEventPublisherOptions['attempts']
  readonly #plans: DurableGraphEventPublisherOptions['plans']
  readonly #events: ExecutionEventRepository
  readonly #eventService: ExecutionEventService
  readonly #retentionMs: number
  readonly #now: () => string

  constructor(options: DurableGraphEventPublisherOptions) {
    const retentionMs = options.retentionMs ?? GRAPH_EVENT_RETENTION_MS
    if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
      throw new TypeError('GRAPH_EVENT_RETENTION_INVALID')
    }
    this.#commands = options.commands
    this.#attempts = options.attempts
    this.#plans = options.plans
    this.#events = options.events
    this.#eventService = new ExecutionEventService(options.events)
    this.#retentionMs = retentionMs
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async publish(input: GraphEvent, idempotencyKey: string): Promise<void> {
    const event = GraphEventSchema.parse(input)
    const type = publicTypes[event.type]
    // Resume, interrupt, cancel, and failure diagnostics remain orchestration
    // events until the public Data API assigns them canonical event names.
    if (type === undefined) return

    const key = IdempotencyKeySchema.parse(idempotencyKey)
    const { command, execution, attempt, graph } = await this.#trustedOwner(event)
    const recordedAt = z.iso.datetime().parse(this.#now())
    const retentionExpiresAt = new Date(Date.parse(recordedAt) + this.#retentionMs).toISOString()
    const draft: ExecutionEventDraft = {
      eventId: deterministicEventId(event.workspaceId, event.executionId, key),
      executionId: execution.executionId,
      attemptId: attempt.attemptId,
      workflowId: workflowIdFromExecutionId(execution.executionId),
      type,
      schemaVersion: 1,
      correlation: {
        workspaceId: execution.correlation.workspaceId,
        projectId: execution.correlation.projectId,
        taskId: execution.correlation.taskId,
        agentId: execution.correlation.agentId,
        requestId: execution.correlation.requestId,
        commandId: command.commandId,
        traceId: traceIdFromRequestId(command.requestId),
      },
      sensitivity: 'internal',
      redaction: 'redacted',
      payload: {
        callerPrincipalId: command.callerPrincipalId,
        graph: {
          graphDefinitionId: graph.reference.graphDefinitionId,
          graphVersion: graph.reference.graphVersion,
          contentDigest: graph.reference.contentDigest,
        },
        threadId: event.threadId,
        segmentSequence: event.sequence,
        ...(event.node === undefined ? {} : { node: event.node }),
        details: event.details,
      },
      occurredAt: event.occurredAt,
      recordedAt,
      retentionExpiresAt,
    }

    const sanitized = sanitizeExecutionEventDraft(draft)
    try {
      await this.#eventService.append(sanitized)
    } catch (error) {
      if (!(error instanceof ExecutionEventError) || error.code !== 'EVENT_EXISTS') throw error
      const existing = await this.#events.get(sanitized.eventId)
      if (existing === undefined) {
        throw new GraphEventPublicationError('GRAPH_EVENT_REPLAY_UNAVAILABLE')
      }
      // The current attempt was authenticated above; keep the first durable row's attempt provenance.
      if (!sameEventSemantics(existing, sanitized)) {
        throw new GraphEventPublicationError('GRAPH_EVENT_IDEMPOTENCY_CONFLICT')
      }
      // A semantic replay retains the first durable occurredAt/recordedAt values.
    }
  }

  async #trustedOwner(event: GraphEvent) {
    const [rawCommand, rawExecution] = await Promise.all([
      this.#commands.getByExecutionId(event.executionId),
      this.#commands.getExecution(event.executionId),
    ])
    const command =
      rawCommand === undefined ? undefined : CommandInboxRecordSchema.safeParse(rawCommand)
    const execution =
      rawExecution === undefined ? undefined : ExecutionSchema.safeParse(rawExecution)
    if (!command?.success || !execution?.success) {
      throw new GraphEventPublicationError('GRAPH_EVENT_AUTHORITY_MISSING')
    }
    const acceptedCommand = command.data
    const acceptedExecution = execution.data
    if (
      acceptedExecution.correlation.projectId === undefined ||
      acceptedCommand.operation !== 'execution.accept' ||
      acceptedCommand.executionId !== acceptedExecution.executionId ||
      acceptedExecution.parentExecutionId !== undefined ||
      acceptedCommand.workspaceId !== acceptedExecution.correlation.workspaceId ||
      acceptedCommand.projectId !== acceptedExecution.correlation.projectId ||
      acceptedCommand.taskId !== acceptedExecution.correlation.taskId ||
      acceptedCommand.agentId !== acceptedExecution.correlation.agentId ||
      acceptedCommand.requestId !== acceptedExecution.correlation.requestId ||
      !samePlanPin(acceptedCommand.executionPlan, acceptedExecution.executionPlan) ||
      event.workspaceId !== acceptedExecution.correlation.workspaceId ||
      event.workflowId !== workflowIdFromExecutionId(acceptedExecution.executionId) ||
      event.threadId !== `graph:${acceptedExecution.executionId}`
    ) {
      throw new GraphEventPublicationError('GRAPH_EVENT_SCOPE_MISMATCH')
    }

    const rawAttempt = await this.#attempts.getAttempt(event.attemptId)
    const attempt =
      rawAttempt === undefined ? undefined : ExecutionAttemptSchema.safeParse(rawAttempt)
    if (
      !attempt?.success ||
      attempt.data.executionId !== acceptedExecution.executionId ||
      acceptedExecution.latestAttemptId !== attempt.data.attemptId ||
      acceptedExecution.attemptCount !== attempt.data.sequence ||
      event.attemptId !== attempt.data.attemptId ||
      !isActiveSegmentState(acceptedExecution.state) ||
      !isActiveSegmentState(attempt.data.state)
    ) {
      throw new GraphEventPublicationError('GRAPH_EVENT_ATTEMPT_MISMATCH')
    }

    let plan
    try {
      const stored = await this.#plans.get({
        executionPlanId: acceptedExecution.executionPlan.executionPlanId,
        contentDigest: acceptedExecution.executionPlan.contentDigest,
      })
      if (stored === undefined) throw new Error('PLAN_MISSING')
      plan = assertExecutionPlanIntegrity(stored)
    } catch {
      throw new GraphEventPublicationError('GRAPH_PLAN_REQUIRED')
    }
    const graph = plan.graph
    if (
      plan.executionPlanId !== acceptedExecution.executionPlan.executionPlanId ||
      plan.contentDigest !== acceptedExecution.executionPlan.contentDigest ||
      plan.schemaVersion !== acceptedExecution.executionPlan.schemaVersion ||
      graph === undefined ||
      !sameCorrelation(plan.correlation, acceptedExecution.correlation)
    ) {
      throw new GraphEventPublicationError('GRAPH_PLAN_REQUIRED')
    }
    return { command: acceptedCommand, execution: acceptedExecution, attempt: attempt.data, graph }
  }
}

export type GraphEventPublicationErrorCode =
  | 'GRAPH_EVENT_AUTHORITY_MISSING'
  | 'GRAPH_EVENT_SCOPE_MISMATCH'
  | 'GRAPH_EVENT_ATTEMPT_MISMATCH'
  | 'GRAPH_PLAN_REQUIRED'
  | 'GRAPH_EVENT_REPLAY_UNAVAILABLE'
  | 'GRAPH_EVENT_IDEMPOTENCY_CONFLICT'

export class GraphEventPublicationError extends Error {
  constructor(readonly code: GraphEventPublicationErrorCode) {
    super(code)
    this.name = 'GraphEventPublicationError'
  }
}

function sameCorrelation(
  left: {
    workspaceId: string
    projectId?: string | undefined
    taskId: string
    agentId: string
    requestId: string
  },
  right: {
    workspaceId: string
    projectId?: string | undefined
    taskId: string
    agentId: string
    requestId: string
  }
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.agentId === right.agentId &&
    left.requestId === right.requestId
  )
}

function samePlanPin(
  left: { executionPlanId: string; contentDigest: string; schemaVersion: number },
  right: { executionPlanId: string; contentDigest: string; schemaVersion: number }
): boolean {
  return (
    left.executionPlanId === right.executionPlanId &&
    left.contentDigest === right.contentDigest &&
    left.schemaVersion === right.schemaVersion
  )
}

function isActiveSegmentState(state: string): boolean {
  return state === 'running' || state === 'awaiting_input'
}

function workflowIdFromExecutionId(executionId: string): WorkflowId {
  return IdentifierSchemas.workflowId.parse(`wfl_${executionId.slice(4)}`)
}

function traceIdFromRequestId(requestId: string): TraceId {
  return IdentifierSchemas.traceId.parse(`trc_${requestId.slice(4)}`)
}

function deterministicEventId(workspaceId: string, executionId: string, key: string): EventId {
  const bytes = createHash('sha256')
    .update(JSON.stringify([workspaceId, executionId, key]))
    .digest('hex')
  let value = BigInt(`0x${bytes.slice(0, 32)}`)
  const encoded = Array.from({ length: 26 }, () => '0')
  for (let index = encoded.length - 1; index >= 0; index--) {
    encoded[index] = EVENT_ID_ALPHABET[Number(value & 31n)] ?? '0'
    value >>= 5n
  }
  return IdentifierSchemas.eventId.parse(`evt_${encoded.join('')}`)
}

function sameEventSemantics(event: ExecutionEvent, draft: ExecutionEventDraft): boolean {
  return (
    event.eventId === draft.eventId &&
    event.executionId === draft.executionId &&
    event.workflowId === draft.workflowId &&
    event.type === draft.type &&
    event.schemaVersion === draft.schemaVersion &&
    isDeepStrictEqual(event.correlation, draft.correlation) &&
    event.sensitivity === draft.sensitivity &&
    event.redaction === draft.redaction &&
    isDeepStrictEqual(event.payload, draft.payload)
  )
}
