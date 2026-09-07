import {
  Annotation,
  Command,
  END,
  INTERRUPT,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from '@langchain/langgraph'
import {
  GraphCancellationRequestSchema,
  GraphContinueRequestSchema,
  GraphExecutionRequestSchema,
  GraphResumeRequestSchema,
  GraphSegmentResultSchema,
  OrchestrationError,
  createGraphEvent,
  type GraphEvent,
  type GraphEventPublisher,
  type GraphContinueRequest,
  type GraphExecutionRequest,
  type GraphNodeOperationPort,
  type GraphReference,
  type GraphResumeRequest,
  type GraphSegmentResult,
  type OrchestrationPort,
} from '@control-plane/orchestration'
import {
  redactTelemetryValue,
  type Telemetry,
  type TelemetryIdentifiers,
  type TelemetrySpan,
} from '@control-plane/telemetry'
import { z } from 'zod'

const JsonRecordSchema = z.record(z.string(), z.json())
type JsonRecord = z.output<typeof JsonRecordSchema>

const ManagedState = Annotation.Root({
  input: Annotation<JsonRecord>,
  values: Annotation<JsonRecord>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
  output: Annotation<JsonRecord>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
})

interface GraphRunnable {
  invoke(input: unknown, config: Record<string, unknown>): Promise<JsonRecord>
}

interface GraphBuildContext {
  readonly operations: GraphNodeOperationPort
  readonly checkpointer: BaseCheckpointSaver
  readonly invokeOperation: (
    node: string,
    kind: 'runtime' | 'model' | 'tool' | 'delegation',
    name: string,
    state: JsonRecord
  ) => Promise<Readonly<Record<string, unknown>>>
}

export interface LangGraphRegistration {
  readonly reference: GraphReference
  build(context: GraphBuildContext): GraphRunnable
}

export class LangGraphOrchestrationAdapter implements OrchestrationPort {
  readonly #graphs = new Map<string, LangGraphRegistration>()
  readonly #operations: GraphNodeOperationPort
  readonly #events: GraphEventPublisher
  readonly #checkpointer: BaseCheckpointSaver
  readonly #now: () => string
  readonly #compilerVersion: string
  readonly #adapterVersion: string
  readonly #telemetry: Pick<Telemetry, 'startSpan'> | undefined
  readonly #active = new Map<string, AbortController>()

  constructor(options: {
    readonly graphs: readonly LangGraphRegistration[]
    readonly operations: GraphNodeOperationPort
    readonly events: GraphEventPublisher
    readonly checkpointer: BaseCheckpointSaver
    readonly now?: () => string
    readonly compilerVersion?: string
    readonly adapterVersion?: string
    readonly telemetry?: Pick<Telemetry, 'startSpan'>
  }) {
    this.#operations = options.operations
    this.#events = options.events
    this.#checkpointer = options.checkpointer
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#compilerVersion = options.compilerVersion ?? '1.0.0'
    this.#adapterVersion = options.adapterVersion ?? '1.4.12'
    this.#telemetry = options.telemetry
    for (const graph of options.graphs) {
      const key = graphKey(graph.reference)
      if (this.#graphs.has(key)) throw new OrchestrationError('GRAPH_VERSION_MISMATCH', false)
      this.#graphs.set(key, graph)
    }
  }

  async run(input: unknown): Promise<GraphSegmentResult> {
    const parsed = GraphExecutionRequestSchema.safeParse(input)
    if (!parsed.success) throw new OrchestrationError('INVALID_GRAPH_REQUEST', false)
    assertCheckpointSafe(parsed.data.input)
    return this.#invoke(parsed.data, parsed.data.input, 'graph.started', 'GRAPH_FAILED')
  }

  async resume(input: unknown): Promise<GraphSegmentResult> {
    const parsed = GraphResumeRequestSchema.safeParse(input)
    if (!parsed.success) throw new OrchestrationError('INVALID_GRAPH_REQUEST', false)
    assertCheckpointSafe(parsed.data.response)
    return this.#invoke(
      parsed.data,
      new Command({ resume: parsed.data.response }),
      'graph.resumed',
      'RESUME_FAILED'
    )
  }

  async continue(input: unknown): Promise<GraphSegmentResult> {
    const parsed = GraphContinueRequestSchema.safeParse(input)
    if (!parsed.success) throw new OrchestrationError('INVALID_GRAPH_REQUEST', false)
    return this.#invoke(parsed.data, null, 'graph.resumed', 'RESUME_FAILED')
  }

  async cancel(input: unknown): Promise<boolean> {
    const parsed = GraphCancellationRequestSchema.safeParse(input)
    if (!parsed.success) throw new OrchestrationError('INVALID_GRAPH_REQUEST', false)
    this.#active.get(activeKey(parsed.data.executionId, parsed.data.threadId))?.abort()
    const cancelled = await this.#operations.cancel(
      parsed.data.executionId,
      parsed.data.threadId,
      parsed.data.idempotencyKey
    )
    await this.#events.publish(
      createGraphEvent({
        ...correlation(parsed.data),
        threadId: parsed.data.threadId,
        sequence: 1,
        type: 'graph.cancelled',
        occurredAt: this.#now(),
        details: { reason: parsed.data.reason },
      }),
      parsed.data.idempotencyKey
    )
    return cancelled
  }

  async #invoke(
    request: GraphExecutionRequest | GraphResumeRequest | GraphContinueRequest,
    graphInput: unknown,
    initialEvent: GraphEvent['type'],
    failureCode: 'GRAPH_FAILED' | 'RESUME_FAILED'
  ): Promise<GraphSegmentResult> {
    const registration = this.#graphs.get(graphKey(request.graph))
    if (!registration) throw new OrchestrationError('GRAPH_NOT_FOUND', false)
    const controller = new AbortController()
    const key = activeKey(request.executionId, request.threadId)
    if (this.#active.has(key)) throw new OrchestrationError('GRAPH_FAILED', true)
    this.#active.set(key, controller)
    const identifiers = telemetryIdentifiers(request)
    const graphSpan = this.#telemetry?.startSpan('graph.run', identifiers, {
      'graph.definition.id': request.graph.graphDefinitionId,
    })
    let graphOutcome: Parameters<TelemetrySpan['end']>[0] = {
      status: 'error',
      error: new Error(failureCode),
    }
    const emitted: GraphEvent[] = []
    let sequence = 0
    const emit = async (type: GraphEvent['type'], node?: string, details: JsonRecord = {}) => {
      const event = createGraphEvent({
        ...correlation(request),
        threadId: request.threadId,
        sequence: ++sequence,
        type,
        ...(node ? { node } : {}),
        occurredAt: this.#now(),
        details,
      })
      emitted.push(event)
      await this.#events.publish(event, `${request.idempotencyKey}:event:${sequence}`)
    }
    try {
      await emit(initialEvent)
      const graph = registration.build({
        operations: this.#operations,
        checkpointer: this.#checkpointer,
        invokeOperation: async (node, kind, name, state) => {
          if (controller.signal.aborted) throw new OrchestrationError('GRAPH_CANCELLED', false)
          await emit('graph.node.started', node, { kind, operation: name })
          const spans = this.#operationSpans(request, node, kind, name)
          try {
            const result = JsonRecordSchema.parse(
              await this.#operations.invoke({
                executionId: request.executionId,
                attemptId: request.attemptId,
                workspaceId: request.workspaceId,
                workflowId: request.workflowId,
                threadId: request.threadId,
                node,
                kind,
                name,
                input: state,
                idempotencyKey: `${request.idempotencyKey}:${node}`,
              })
            )
            for (const span of spans) span.end({ status: 'ok' })
            await emit('graph.node.completed', node, { kind, operation: name })
            return result
          } catch (error) {
            for (const span of spans) span.end({ status: 'error', error })
            throw error
          }
        },
      })
      const config = {
        configurable: {
          thread_id: storageThreadId(request),
          ...('checkpointId' in request ? { checkpoint_id: request.checkpointId } : {}),
        },
        metadata: {
          graphDefinitionId: request.graph.graphDefinitionId,
          graphVersion: request.graph.graphVersion,
          contentDigest: request.graph.contentDigest,
          executionId: request.executionId,
          workflowId: request.workflowId,
          workspaceId: request.workspaceId,
          compilerVersion: this.#compilerVersion,
          adapterVersion: this.#adapterVersion,
        },
        signal: controller.signal,
      }
      const invocationInput =
        graphInput instanceof Command ? graphInput : { input: graphInput, values: {}, output: {} }
      const state = await graph.invoke(invocationInput, config)
      const checkpoint = await this.#checkpointer.getTuple(config)
      const checkpointId = checkpoint?.checkpoint.id
      const interruptions = state[INTERRUPT]
      if (Array.isArray(interruptions) && interruptions.length > 0) {
        if (typeof checkpointId !== 'string') {
          throw new OrchestrationError('CHECKPOINT_MISSING', false)
        }
        const normalized = normalizeInterrupt(interruptions[0])
        await emit('graph.interrupted', undefined, { interactionKey: normalized.interactionKey })
        graphOutcome = { status: 'ok' }
        return GraphSegmentResultSchema.parse({
          status: 'awaiting_input',
          state,
          checkpointId,
          interrupt: normalized,
          events: emitted,
        })
      }
      await emit('graph.completed')
      graphOutcome = { status: 'ok' }
      return GraphSegmentResultSchema.parse({
        status: 'completed',
        state,
        ...(typeof checkpointId === 'string' ? { checkpointId } : {}),
        output: state['output'] ?? {},
        events: emitted,
      })
    } catch (error) {
      if (error instanceof OrchestrationError && error.code === 'GRAPH_CANCELLED') {
        graphOutcome = { status: 'ok' }
        return GraphSegmentResultSchema.parse({ status: 'cancelled', state: {}, events: emitted })
      }
      try {
        await emit('graph.failed', undefined, { code: failureCode })
      } catch {
        // The original sanitized orchestration failure remains authoritative.
      }
      return GraphSegmentResultSchema.parse({
        status: 'failed',
        state: {},
        failure: { code: failureCode, retryable: true },
        events: emitted,
      })
    } finally {
      graphSpan?.end(graphOutcome)
      this.#active.delete(key)
    }
  }

  #operationSpans(
    request: GraphExecutionRequest | GraphResumeRequest | GraphContinueRequest,
    node: string,
    kind: 'delegation' | 'model' | 'runtime' | 'tool',
    name: string
  ): readonly TelemetrySpan[] {
    if (!this.#telemetry) return []
    const identifiers = telemetryIdentifiers(request)
    const attributes = { 'graph.node.kind': kind, 'graph.node.name': node, 'operation.name': name }
    const nodeSpan = this.#telemetry.startSpan('graph.node', identifiers, attributes)
    const operationName =
      kind === 'runtime'
        ? 'runtime.start'
        : kind === 'model'
          ? 'model.call'
          : kind === 'tool'
            ? 'tool.execute'
            : undefined
    return operationName
      ? [nodeSpan, this.#telemetry.startSpan(operationName, identifiers, attributes)]
      : [nodeSpan]
  }
}

function assertCheckpointSafe(value: unknown): void {
  if (JSON.stringify(redactTelemetryValue(value)) !== JSON.stringify(value)) {
    throw new OrchestrationError('INVALID_GRAPH_REQUEST', false)
  }
}

export function deterministicTestGraph(reference: GraphReference): LangGraphRegistration {
  return {
    reference,
    build(context) {
      const graph = new StateGraph(ManagedState)
        .addNode('prepare', async (state) => {
          const result = await context.invokeOperation('prepare', 'runtime', 'prepare', state.input)
          return { values: { prepared: result['value'] } }
        })
        .addNode('reason', async (state) => {
          const result = await context.invokeOperation('reason', 'model', 'reason', state.values)
          return { values: { reasoned: result['value'] } }
        })
        .addNode('lookup', async (state) => {
          const result = await context.invokeOperation('lookup', 'tool', 'lookup', state.values)
          return { output: { summary: result['value'] } }
        })
        .addEdge(START, 'prepare')
        .addEdge('prepare', 'reason')
        .addEdge('reason', 'lookup')
        .addEdge('lookup', END)
        .compile({ checkpointer: context.checkpointer })
      return graph
    },
  }
}

export function deterministicInterruptGraph(reference: GraphReference): LangGraphRegistration {
  return {
    reference,
    build(context) {
      return new StateGraph(ManagedState)
        .addNode('prepare', async (state) => {
          const result = await context.invokeOperation('prepare', 'runtime', 'prepare', state.input)
          return { values: { prepared: result['value'] } }
        })
        .addNode('approval', () => {
          const response = interrupt({
            interactionKey: 'approval-1',
            kind: 'approval',
            payload: { question: 'Approve deterministic test action?' },
          })
          return { values: { response } }
        })
        .addNode('finalize', async (state) => {
          await context.invokeOperation('finalize', 'tool', 'finalize', state.values)
          const response = state.values['response']
          const decision =
            response !== null && typeof response === 'object' && 'action' in response
              ? String(response['action'])
              : 'unknown'
          return { output: { decision } }
        })
        .addEdge(START, 'prepare')
        .addEdge('prepare', 'approval')
        .addEdge('approval', 'finalize')
        .addEdge('finalize', END)
        .compile({ checkpointer: context.checkpointer })
    },
  }
}

function normalizeInterrupt(input: unknown): {
  interactionKey: string
  kind: 'input' | 'approval' | 'grant' | 'runtime'
  payload: unknown
} {
  if (input !== null && typeof input === 'object') {
    const interruptRecord = input as Record<string, unknown>
    const value = interruptRecord['value']
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const interactionKey = record['interactionKey']
      const kind = record['kind']
      if (
        typeof interactionKey === 'string' &&
        ['input', 'approval', 'grant', 'runtime'].includes(String(kind))
      ) {
        return {
          interactionKey,
          kind: kind as 'input' | 'approval' | 'grant' | 'runtime',
          payload: record['payload'] ?? null,
        }
      }
    }
    if (typeof interruptRecord['id'] === 'string') {
      return {
        interactionKey: interruptRecord['id'],
        kind: 'input',
        payload: interruptRecord['value'] ?? null,
      }
    }
  }
  throw new OrchestrationError('GRAPH_FAILED', false)
}

function correlation(input: {
  readonly executionId: string
  readonly attemptId: string
  readonly workspaceId: string
  readonly workflowId: string
}) {
  return {
    executionId: input.executionId,
    attemptId: input.attemptId,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
  }
}

function telemetryIdentifiers(input: {
  readonly executionId: string
  readonly attemptId: string
  readonly workspaceId: string
  readonly workflowId: string
  readonly graph: GraphReference
}): TelemetryIdentifiers {
  return {
    executionId: input.executionId,
    attemptId: input.attemptId,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    graphVersion: input.graph.graphVersion,
  }
}

function graphKey(reference: GraphReference): string {
  return `${reference.graphDefinitionId}:${reference.graphVersion}:${reference.contentDigest}`
}

function activeKey(executionId: string, threadId: string): string {
  return `${executionId}:${threadId}`
}

function storageThreadId(input: {
  readonly workspaceId: string
  readonly executionId: string
  readonly threadId: string
}): string {
  return `${input.workspaceId}:${input.executionId}:${input.threadId}`
}

export const packageName = 'langgraph-adapter'

export * from './postgres-checkpointer.js'
export * from './sqlite-checkpointer.js'
