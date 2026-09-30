import { createHash } from 'node:crypto'
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
  GraphDefinitionCatalog,
  OrchestrationError,
  PublishedGraphDefinitionSchema,
  createGraphEvent,
  type GraphEvent,
  type GraphEventPublisher,
  type GraphContinueRequest,
  type GraphExecutionRequest,
  type GraphNodeOperationPort,
  type GraphReference,
  type GraphResumeRequest,
  type GraphSegmentResult,
  type GraphCompatibilityEnvironment,
  type PublishedGraphDefinition,
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
    state: JsonRecord,
    visitOrdinal?: number
  ) => Promise<Readonly<Record<string, unknown>>>
}

interface GraphNodeExecutionConfig {
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface LangGraphRegistration {
  readonly reference: GraphReference
  readonly recursionLimit?: number
  readonly validateInput?: (input: unknown) => boolean
  readonly validateState?: (state: unknown) => boolean
  readonly validateOutput?: (output: unknown) => boolean
  build(context: GraphBuildContext): GraphRunnable
}

export interface PublishedGraphDefinitionRequest {
  readonly workspaceId: string
  readonly reference: GraphReference
}

export interface PublishedGraphDefinitionResolver {
  resolveForNewExecution(
    request: PublishedGraphDefinitionRequest
  ): Promise<PublishedGraphDefinition>
  getPinned(request: PublishedGraphDefinitionRequest): Promise<PublishedGraphDefinition>
}

export type GraphOperationIdentity = Pick<
  import('@control-plane/orchestration').GraphNodeOperation,
  'kind' | 'name'
>

export type GraphSchemaValidator = (value: unknown) => boolean

export interface GraphSchemaRegistry {
  getValidator(reference: string): GraphSchemaValidator | undefined
}

export interface DeclarativeGraphCompilerOptions {
  readonly operationAllowlist: readonly GraphOperationIdentity[]
  readonly schemaRegistry: GraphSchemaRegistry
  readonly maximumSteps?: number
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
  readonly #graphDefinitionResolver: PublishedGraphDefinitionResolver | undefined
  readonly #declarativeCompiler: DeclarativeGraphCompiler | undefined
  readonly #active = new Map<string, AbortController>()

  constructor(options: {
    readonly graphs?: readonly LangGraphRegistration[]
    readonly graphDefinitionResolver?: PublishedGraphDefinitionResolver
    readonly declarativeCompiler?: DeclarativeGraphCompiler
    readonly operations: GraphNodeOperationPort
    readonly events: GraphEventPublisher
    readonly checkpointer: BaseCheckpointSaver
    readonly now?: () => string
    readonly compilerVersion?: string
    readonly adapterVersion?: string
    readonly telemetry?: Pick<Telemetry, 'startSpan'>
  }) {
    if (Boolean(options.graphDefinitionResolver) !== Boolean(options.declarativeCompiler)) {
      throw new TypeError(
        'Graph definition resolver and declarative compiler must be configured together'
      )
    }
    this.#operations = options.operations
    this.#events = options.events
    this.#checkpointer = options.checkpointer
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#compilerVersion = options.compilerVersion ?? '1.0.0'
    this.#adapterVersion = options.adapterVersion ?? '1.4.12'
    this.#telemetry = options.telemetry
    this.#graphDefinitionResolver = options.graphDefinitionResolver
    this.#declarativeCompiler = options.declarativeCompiler
    for (const graph of options.graphs ?? []) {
      const key = graphKey(graph.reference)
      if (this.#graphs.has(key)) throw new OrchestrationError('GRAPH_VERSION_MISMATCH', false)
      this.#graphs.set(key, graph)
    }
  }

  async run(input: unknown): Promise<GraphSegmentResult> {
    const parsed = GraphExecutionRequestSchema.safeParse(input)
    if (!parsed.success) throw new OrchestrationError('INVALID_GRAPH_REQUEST', false)
    assertCheckpointSafe(parsed.data.input)
    return this.#invoke(parsed.data, parsed.data.input, 'graph.started', 'GRAPH_FAILED', 'new')
  }

  async resume(input: unknown): Promise<GraphSegmentResult> {
    const parsed = GraphResumeRequestSchema.safeParse(input)
    if (!parsed.success) throw new OrchestrationError('INVALID_GRAPH_REQUEST', false)
    assertCheckpointSafe(parsed.data.response)
    return this.#invoke(
      parsed.data,
      new Command({ resume: parsed.data.response }),
      'graph.resumed',
      'RESUME_FAILED',
      'pinned'
    )
  }

  async continue(input: unknown): Promise<GraphSegmentResult> {
    const parsed = GraphContinueRequestSchema.safeParse(input)
    if (!parsed.success) throw new OrchestrationError('INVALID_GRAPH_REQUEST', false)
    return this.#invoke(parsed.data, null, 'graph.resumed', 'RESUME_FAILED', 'pinned')
  }

  async cancel(input: unknown): Promise<boolean> {
    const parsed = GraphCancellationRequestSchema.safeParse(input)
    if (!parsed.success) throw new OrchestrationError('INVALID_GRAPH_REQUEST', false)
    if (!this.#graphs.has(graphKey(parsed.data.graph)) && this.#graphDefinitionResolver) {
      await this.#resolvePublishedDefinition(
        { workspaceId: parsed.data.workspaceId, reference: parsed.data.graph },
        'pinned'
      )
    }
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
    failureCode: 'GRAPH_FAILED' | 'RESUME_FAILED',
    resolution: 'new' | 'pinned'
  ): Promise<GraphSegmentResult> {
    const registration = await this.#resolveRegistration(request, resolution)
    if (
      resolution === 'new' &&
      !(graphInput instanceof Command) &&
      registration.validateInput &&
      !registration.validateInput(graphInput)
    ) {
      throw new OrchestrationError('INVALID_GRAPH_REQUEST', false)
    }
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
        invokeOperation: async (node, kind, name, state, visitOrdinal = 0) => {
          if (controller.signal.aborted) throw new OrchestrationError('GRAPH_CANCELLED', false)
          if (!Number.isSafeInteger(visitOrdinal) || visitOrdinal < 0) {
            throw new OrchestrationError('GRAPH_FAILED', false)
          }
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
                idempotencyKey: graphOperationIdempotencyKey(request, node, visitOrdinal),
              })
            )
            assertCheckpointSafe(result)
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
        ...(registration.recursionLimit === undefined
          ? {}
          : { recursionLimit: registration.recursionLimit }),
      }
      const invocationInput =
        graphInput instanceof Command || graphInput === null
          ? graphInput
          : { input: graphInput, values: {}, output: {} }
      const state = await graph.invoke(invocationInput, config)
      if (registration.validateState && !registration.validateState(state)) {
        throw new DeclarativeGraphCompilationError('GRAPH_SCHEMA_VALIDATION_FAILED')
      }
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
      const output = state['output'] ?? {}
      if (registration.validateOutput && !registration.validateOutput(output)) {
        throw new DeclarativeGraphCompilationError('GRAPH_SCHEMA_VALIDATION_FAILED')
      }
      await emit('graph.completed')
      graphOutcome = { status: 'ok' }
      return GraphSegmentResultSchema.parse({
        status: 'completed',
        state,
        ...(typeof checkpointId === 'string' ? { checkpointId } : {}),
        output,
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

  async #resolveRegistration(
    request: GraphExecutionRequest | GraphResumeRequest | GraphContinueRequest,
    resolution: 'new' | 'pinned'
  ): Promise<LangGraphRegistration> {
    const registered = this.#graphs.get(graphKey(request.graph))
    if (registered) return registered
    if (!this.#graphDefinitionResolver || !this.#declarativeCompiler) {
      throw new OrchestrationError('GRAPH_NOT_FOUND', false)
    }
    const published = await this.#resolvePublishedDefinition(
      { workspaceId: request.workspaceId, reference: request.graph },
      resolution
    )
    return this.#declarativeCompiler.compile(published)
  }

  async #resolvePublishedDefinition(
    request: PublishedGraphDefinitionRequest,
    resolution: 'new' | 'pinned'
  ): Promise<PublishedGraphDefinition> {
    if (!this.#graphDefinitionResolver) throw new OrchestrationError('GRAPH_NOT_FOUND', false)
    const published =
      resolution === 'new'
        ? await this.#graphDefinitionResolver.resolveForNewExecution(request)
        : await this.#graphDefinitionResolver.getPinned(request)
    const parsed = PublishedGraphDefinitionSchema.safeParse(published)
    if (!parsed.success) {
      throw new DeclarativeGraphCompilationError('INVALID_PUBLISHED_GRAPH')
    }
    if (graphKey(parsed.data.reference) !== graphKey(request.reference)) {
      throw new OrchestrationError('GRAPH_VERSION_MISMATCH', false)
    }
    return parsed.data
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

export type DeclarativeGraphCompilationErrorCode =
  | 'INVALID_PUBLISHED_GRAPH'
  | 'INVALID_GRAPH_TOPOLOGY'
  | 'UNSUPPORTED_OPERATION'
  | 'UNKNOWN_GRAPH_SCHEMA'
  | 'GRAPH_SCHEMA_VALIDATION_FAILED'
  | 'INVALID_GRAPH_STEP_LIMIT'

export class DeclarativeGraphCompilationError extends Error {
  constructor(readonly code: DeclarativeGraphCompilationErrorCode) {
    super(code)
    this.name = 'DeclarativeGraphCompilationError'
  }
}

export class CatalogBackedGraphDefinitionResolver implements PublishedGraphDefinitionResolver {
  readonly #catalogForWorkspace: (workspaceId: string) => GraphDefinitionCatalog
  readonly #compatibility:
    | GraphCompatibilityEnvironment
    | ((workspaceId: string) => GraphCompatibilityEnvironment)

  constructor(options: {
    readonly catalogForWorkspace: (workspaceId: string) => GraphDefinitionCatalog
    readonly compatibility:
      | GraphCompatibilityEnvironment
      | ((workspaceId: string) => GraphCompatibilityEnvironment)
  }) {
    this.#catalogForWorkspace = options.catalogForWorkspace
    this.#compatibility = options.compatibility
  }

  resolveForNewExecution({ workspaceId, reference }: PublishedGraphDefinitionRequest) {
    return this.#catalogForWorkspace(workspaceId).resolveForNewExecution(
      reference,
      typeof this.#compatibility === 'function'
        ? this.#compatibility(workspaceId)
        : this.#compatibility
    )
  }

  getPinned({ workspaceId, reference }: PublishedGraphDefinitionRequest) {
    return this.#catalogForWorkspace(workspaceId).getPinned(reference)
  }
}

export class DeclarativeGraphCompiler {
  readonly #operationAllowlist: ReadonlySet<string>
  readonly #schemaRegistry: GraphSchemaRegistry
  readonly #maximumSteps: number

  constructor(options: DeclarativeGraphCompilerOptions) {
    this.#operationAllowlist = new Set(
      options.operationAllowlist.map(({ kind, name }) => operationKey(kind, name))
    )
    this.#schemaRegistry = options.schemaRegistry
    this.#maximumSteps = options.maximumSteps ?? 512
    if (
      !Number.isSafeInteger(this.#maximumSteps) ||
      this.#maximumSteps < 1 ||
      this.#maximumSteps > 10_000
    ) {
      throw new DeclarativeGraphCompilationError('INVALID_GRAPH_STEP_LIMIT')
    }
  }

  compile(input: unknown): LangGraphRegistration {
    const published = parsePublishedGraph(input)
    const content = published.content
    assertGraphTopology(content)
    const feedbackEdges = graphFeedbackEdges(content)
    const conditionalSources = new Set(
      content.edges.filter((edge) => edge.when).map((edge) => edge.from)
    )
    for (const node of content.nodes) {
      const outgoing = content.edges.filter((edge) => edge.from === node.node)
      if (outgoing.some((edge) => edge.when) && outgoing.some((edge) => !edge.when)) {
        throw new DeclarativeGraphCompilationError('INVALID_GRAPH_TOPOLOGY')
      }
      const incoming = content.edges.filter(
        (edge) =>
          edge.to === node.node &&
          edge.from !== START &&
          !feedbackEdges.has(graphEdgeKey(edge.from, edge.to))
      )
      if (node.join !== 'any' && incoming.length > 1 && incoming.some((edge) => edge.when)) {
        throw new DeclarativeGraphCompilationError('INVALID_GRAPH_TOPOLOGY')
      }
    }

    for (const node of content.nodes) {
      if (!this.#operationAllowlist.has(operationKey(node.operation.kind, node.operation.name))) {
        throw new DeclarativeGraphCompilationError('UNSUPPORTED_OPERATION')
      }
    }

    const validators = resolveGraphSchemas(content.schemas, this.#schemaRegistry)
    const terminalNodes = content.nodes.filter(({ node }) =>
      content.edges.some((edge) => edge.from === node && edge.to === END)
    )
    const validate = (validator: GraphSchemaValidator, value: unknown) => {
      try {
        return validator(value) === true
      } catch {
        return false
      }
    }

    const registration: LangGraphRegistration = {
      reference: published.reference,
      recursionLimit: this.#maximumSteps,
      validateInput: (value) => validate(validators.input, value),
      validateState: (value) => validate(validators.state, value),
      validateOutput: (value) => validate(validators.output, value),
      build(context) {
        const graph = new StateGraph(ManagedState) as unknown as DynamicStateGraphBuilder
        for (const node of content.nodes) {
          const isStartNode = content.edges.some(
            (edge) => edge.from === START && edge.to === node.node
          )
          const isTerminalNode = terminalNodes.some(({ node: name }) => name === node.node)
          graph.addNode(node.node, async (state, config) => {
            const operationInput =
              isStartNode && !Object.hasOwn(state.values, node.node) ? state.input : state.values
            const visitOrdinal = graphStepOrdinal(config)
            const result = JsonRecordSchema.parse(
              await context.invokeOperation(
                node.node,
                node.operation.kind,
                node.operation.name,
                operationInput,
                visitOrdinal
              )
            )
            const nextValues = { ...state.values, [node.node]: result }
            const outputUpdate = isTerminalNode
              ? terminalNodes.length === 1
                ? result
                : { [node.node]: result }
              : undefined
            const nextState = {
              input: state.input,
              values: nextValues,
              output:
                outputUpdate === undefined ? state.output : { ...state.output, ...outputUpdate },
            }
            if (!validate(validators.state, nextState)) {
              throw new DeclarativeGraphCompilationError('GRAPH_SCHEMA_VALIDATION_FAILED')
            }
            return {
              values: { [node.node]: result },
              ...(outputUpdate === undefined ? {} : { output: outputUpdate }),
            }
          })
        }

        const nonStartSourcesByTarget = new Map<string, string[]>()
        const endSources: string[] = []
        for (const edge of content.edges) {
          if (conditionalSources.has(edge.from)) continue
          if (edge.to === END) {
            endSources.push(edge.from)
          } else if (edge.from === START) {
            graph.addEdge(START, edge.to)
          } else {
            const sources = nonStartSourcesByTarget.get(edge.to) ?? []
            sources.push(edge.from)
            nonStartSourcesByTarget.set(edge.to, sources)
          }
        }
        for (const [target, sources] of nonStartSourcesByTarget) {
          const feedbackSources = sources.filter((source) =>
            feedbackEdges.has(graphEdgeKey(source, target))
          )
          const entrySources = sources.filter((source) => !feedbackSources.includes(source))
          if (content.nodes.find((node) => node.node === target)?.join === 'any') {
            for (const source of entrySources) graph.addEdge(source, target)
          } else if (entrySources.length > 0) {
            graph.addEdge(entrySources.length === 1 ? entrySources[0]! : entrySources, target)
          }
          for (const source of feedbackSources) graph.addEdge(source, target)
        }
        for (const source of endSources) graph.addEdge(source, END)
        for (const source of conditionalSources) {
          const outgoing = content.edges.filter((edge) => edge.from === source)
          graph.addConditionalEdges(
            source,
            (state) => {
              const result = state.values[source]
              const targets = outgoing
                .filter((edge) => conditionMatches(result, edge.when!))
                .map((edge) => edge.to)
              if (targets.length === 0)
                throw new DeclarativeGraphCompilationError('INVALID_GRAPH_TOPOLOGY')
              return targets
            },
            [...new Set(outgoing.map((edge) => edge.to))]
          )
        }
        return graph.compile({ checkpointer: context.checkpointer })
      },
    }
    return registration
  }

  /** Validate a proposed graph input before its selection is persisted to a plan. */
  validateInput(definition: unknown, input: unknown): boolean {
    const registration = this.compile(definition)
    return registration.validateInput?.(input) ?? true
  }
}

interface ManagedGraphState {
  readonly input: JsonRecord
  readonly values: JsonRecord
  readonly output: JsonRecord
}

interface DynamicStateGraphBuilder {
  addNode(
    name: string,
    action: (
      state: ManagedGraphState,
      config: GraphNodeExecutionConfig
    ) => Promise<Partial<ManagedGraphState>>
  ): this
  addEdge(start: string | string[], end: string): this
  addConditionalEdges(
    source: string,
    route: (state: ManagedGraphState) => string[],
    destinations: string[]
  ): this
  compile(options: { checkpointer: BaseCheckpointSaver }): GraphRunnable
}

function parsePublishedGraph(input: unknown): PublishedGraphDefinition {
  const parsed = PublishedGraphDefinitionSchema.safeParse(input)
  if (!parsed.success) throw new DeclarativeGraphCompilationError('INVALID_PUBLISHED_GRAPH')
  return parsed.data
}

function resolveGraphSchemas(
  references: PublishedGraphDefinition['content']['schemas'],
  registry: GraphSchemaRegistry
): {
  readonly input: GraphSchemaValidator
  readonly state: GraphSchemaValidator
  readonly output: GraphSchemaValidator
} {
  const input = registry.getValidator(references.input)
  const state = registry.getValidator(references.state)
  const output = registry.getValidator(references.output)
  if (!input || !state || !output) {
    throw new DeclarativeGraphCompilationError('UNKNOWN_GRAPH_SCHEMA')
  }
  return { input, state, output }
}

function assertGraphTopology(content: PublishedGraphDefinition['content']): void {
  const nodeNames = new Set(content.nodes.map(({ node }) => node))
  const seenEdges = new Set<string>()
  for (const { from, to } of content.edges) {
    const edgeKey = `${from}\u0000${to}`
    if (seenEdges.has(edgeKey)) throw new DeclarativeGraphCompilationError('INVALID_GRAPH_TOPOLOGY')
    seenEdges.add(edgeKey)
  }
  const forward = adjacency(content.edges.map(({ from, to }) => [from, to] as const))
  const reverse = adjacency(content.edges.map(({ from, to }) => [to, from] as const))

  const reachable = visitGraph('__start__', forward)
  const canReachEnd = visitGraph(END, reverse)
  if (
    !content.edges.some(({ from }) => from === START) ||
    !content.edges.some(({ to }) => to === END) ||
    [...nodeNames].some((node) => !reachable.has(node) || !canReachEnd.has(node))
  ) {
    throw new DeclarativeGraphCompilationError('INVALID_GRAPH_TOPOLOGY')
  }
}

function graphEdgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`
}

/** DFS back edges identify feedback without treating every edge in a cycle as feedback. */
function graphFeedbackEdges(content: PublishedGraphDefinition['content']): Set<string> {
  const forward = adjacency(content.edges.map(({ from, to }) => [from, to] as const))
  const visited = new Set<string>()
  const ancestors = new Set<string>()
  const feedback = new Set<string>()
  const visit = (node: string) => {
    visited.add(node)
    ancestors.add(node)
    for (const target of forward.get(node) ?? []) {
      if (ancestors.has(target)) feedback.add(graphEdgeKey(node, target))
      else if (!visited.has(target)) visit(target)
    }
    ancestors.delete(node)
  }
  visit(START)
  return feedback
}

function conditionMatches(
  value: unknown,
  condition: NonNullable<PublishedGraphDefinition['content']['edges'][number]['when']>
): boolean {
  let current = value
  for (const key of condition.path) {
    if (current === null || typeof current !== 'object') return false
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false
    current = descriptor.value
  }
  return current === condition.equals
}

function adjacency(edges: readonly (readonly [string, string])[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const [from, to] of edges) {
    const targets = result.get(from) ?? []
    targets.push(to)
    result.set(from, targets)
  }
  return result
}

function visitGraph(start: string, edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const visited = new Set<string>()
  const pending = [start]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    pending.push(...(edges.get(current) ?? []))
  }
  return visited
}

function operationKey(kind: GraphOperationIdentity['kind'], name: string): string {
  return `${kind}\u0000${name}`
}

function graphStepOrdinal(config: GraphNodeExecutionConfig): number {
  const step = config.metadata?.['langgraph_step']
  if (!Number.isSafeInteger(step) || typeof step !== 'number' || step < 0) {
    throw new OrchestrationError('GRAPH_FAILED', false)
  }
  return step
}

function graphOperationIdempotencyKey(
  request: GraphExecutionRequest | GraphResumeRequest | GraphContinueRequest,
  node: string,
  visitOrdinal: number
): string {
  const identity = JSON.stringify([
    'control-plane.graph-operation.v1',
    request.workspaceId,
    request.executionId,
    request.threadId,
    request.graph.graphDefinitionId,
    request.graph.graphVersion,
    request.graph.contentDigest,
    node,
    visitOrdinal,
  ])
  const digest = createHash('sha256').update(identity).digest('hex')
  return `graph-op-v1:${digest}`
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
