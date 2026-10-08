import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  createAssistantMessageEventStream,
  Type,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage,
} from '@earendil-works/pi-ai'
import { createModels, createProvider, type Models } from '@earendil-works/pi-ai/models'
import {
  AssistantEntry,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  type Conversation,
  type Cursor,
  type EntryId,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { z } from 'zod'
import {
  PiDurableDelegateChildOutcomeSchema,
  type PiDurableDelegateChildOutcome,
  type PiDurableGovernedDelegateChildEnginePort,
} from './contracts.js'
import {
  verifyPiDurableToolSource,
  piDurableToolSourceKey,
  type PiDurableToolSource,
} from './tool-source.js'

export const PI_DURABLE_RUNTIME_VERSION = '1.1.0'

export interface PiDurableEngineOptions {
  readonly directory: string
  readonly model: { readonly provider: string; readonly modelId: string }
  readonly maxOutputTokens: number
  /** Must reject stale authority, including unresolved inference after a process crash. */
  readonly assertAuthority: () => Promise<void>
  /** Production composition requires a ledger-backed reservation; this ID survives recovery. */
  readonly authorizeInference?: (request: {
    readonly sessionId: string
    readonly inferenceId: string
    readonly provider: string
    readonly modelId: string
  }) => Promise<{
    readonly maxOutputTokens: number
    readonly maximumInputTokens: number
    readonly assertActive: () => Promise<void>
  }>
  /** Rebuild Models and hold eligible credential access only for this callback. */
  readonly withModels: <T>(use: (models: Models) => Promise<T>) => Promise<T>
  readonly governedDelegateChild?: PiDurableGovernedDelegateChildEnginePort
  /** Settle only committed native assistant receipts before admitting another generation or effect. */
  readonly retainInferences?: (inferences: PiDurableEngineResult['inferences']) => Promise<void>
}

export interface PiDurableEngineRun {
  readonly sessionId: string
  readonly requestId: string
  readonly input: string
}

export interface PiDurableEngineResult {
  readonly submissionId: string
  readonly text: string
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly costUsd: string
    readonly durationMs: number
  }
  readonly inferences: readonly {
    readonly inferenceId: string
    readonly usage: {
      readonly inputTokens: number
      readonly outputTokens: number
      readonly durationMs: number
      readonly cachedInputTokens: number
      readonly reasoningTokens: number
    }
  }[]
}

export class PiDurableEngineToolBlockedError extends Error {
  readonly outcome: PiDurableDelegateChildOutcome
  readonly source: PiDurableToolSource
  readonly sourceKey: string
  readonly inferences: PiDurableEngineResult['inferences']

  constructor(
    outcome: PiDurableDelegateChildOutcome,
    source: PiDurableToolSource,
    sourceKey: string,
    inferences: PiDurableEngineResult['inferences']
  ) {
    super('PI_GOVERNED_TOOL_BLOCKED')
    this.name = 'PiDurableEngineToolBlockedError'
    this.outcome = outcome
    this.source = source
    this.sourceKey = sourceKey
    this.inferences = inferences
  }
}

const DelegateObjective = z.strictObject({ objective: z.string().trim().min(1).max(8192) })
const DelegateParameters = Type.Object(
  { objective: Type.String({ minLength: 1, maxLength: 8192 }) },
  { additionalProperties: false }
)

async function receipts(root: Conversation, first: EntryId, last?: EntryId) {
  const result: PiDurableEngineResult['inferences'][number][] = []
  let cursor: Cursor | undefined
  do {
    const page = await root.entries(
      {
        minEntryId: first,
        ...(last === undefined ? {} : { maxEntryId: last }),
        order: 'ascending',
      },
      256,
      cursor,
      BACKGROUND_CONTEXT
    )
    for (const entry of page.items) {
      if (entry.kind !== 'pi.assistant') continue
      const message = entry.model?.find(
        (value): value is AssistantMessage => value.role === 'assistant'
      )
      if (!message || message.stopReason === 'error' || message.stopReason === 'aborted') continue
      if (entry.byTaskId === undefined) throw new Error('PI_NATIVE_INFERENCE_RECEIPT_MISSING')
      if (!Number.isSafeInteger(message.durationMs) || message.durationMs! < 0)
        throw new Error('PI_NATIVE_INFERENCE_DURATION_MISSING')
      result.push({
        inferenceId: `pi-generation:${String(entry.byTaskId)}`,
        usage: { ...counts(message.usage), durationMs: message.durationMs! },
      })
    }
    cursor = page.next
  } while (cursor !== undefined)
  return result
}

function counts(usage: Usage) {
  const values = [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.reasoning ?? 0,
  ]
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    !Number.isSafeInteger(inputTokens + usage.output) ||
    (usage.reasoning ?? 0) > usage.output
  )
    throw new Error('PI_INVALID_PROVIDER_USAGE')
  return {
    inputTokens,
    outputTokens: usage.output,
    cachedInputTokens: usage.cacheRead,
    reasoningTokens: usage.reasoning ?? 0,
  }
}

function safeFailureUsage(usage: Usage): Usage {
  counts(usage)
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning ?? 0,
    totalTokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

const EngineState = defineDoc<{
  runtimeVersion: string
  provider: string
  modelId: string
  inputs: Record<string, string>
  governedTools?: 'delegate_child/v1'
}>({
  kind: 'adea.pi.engine',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    runtimeVersion: PI_DURABLE_RUNTIME_VERSION,
    provider: '',
    modelId: '',
    inputs: {},
  }),
})

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function failure(model: Model<Api>, code: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: 'error',
    errorMessage: code,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

/** Node SQLite profile: one process owns a session store; the adapter provides external fencing. */
export function createPiDurableEngine(options: PiDurableEngineOptions) {
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) {
    throw new Error('PI_OUTPUT_BUDGET_REQUIRED')
  }
  const opened = new Map<string, Promise<Harness>>()
  const blocked = new Map<
    string,
    { error: PiDurableEngineToolBlockedError; closing: Promise<void> }
  >()
  const physicalFetch = globalThis.fetch
  const turns = new Map<string, string>()
  let closed = false

  const storePath = (sessionId: string) => join(options.directory, `${digest(sessionId)}.sqlite`)

  async function open(sessionId: string): Promise<Harness> {
    if (closed) throw new Error('PI_ENGINE_CLOSED')
    if (!sessionId) throw new Error('PI_SESSION_ID_REQUIRED')
    const existing = opened.get(sessionId)
    if (existing) return existing
    const opening = (async () => {
      await options.assertAuthority()
      const model = await options.withModels(async (models) => {
        const resolved = models.getModel(options.model.provider, options.model.modelId)
        if (
          !resolved ||
          resolved.id !== options.model.modelId ||
          resolved.provider !== options.model.provider
        )
          throw new Error('PI_PINNED_MODEL_UNAVAILABLE')
        // Catalog metadata stays in memory. Credentials, endpoint overrides and headers never enter storage.
        return {
          id: resolved.id,
          provider: resolved.provider,
          api: resolved.api,
          name: resolved.name,
          baseUrl: '',
          input: [...resolved.input],
          cost: structuredClone(resolved.cost),
          reasoning: resolved.reasoning,
          contextWindow: resolved.contextWindow,
          maxTokens: Math.min(resolved.maxTokens, options.maxOutputTokens),
        } satisfies Model<Api>
      })
      let inferenceId: string | undefined
      let harness: Harness
      const retainCommitted = async (last?: EntryId) => {
        if (!options.retainInferences) return
        const requestId = turns.get(sessionId)
        if (!requestId) throw new Error('PI_RETAINED_TURN_REQUIRED')
        const root = await harness.root(BACKGROUND_CONTEXT)
        const submission = await root.commit(
          (tx) => tx.submissionByRequest(root.id, requestId),
          BACKGROUND_CONTEXT
        )
        if (
          !submission ||
          submission.type !== 'input' ||
          submission.status === 'queued' ||
          submission.entry === undefined
        )
          return
        const committed = await receipts(root, submission.entry, last)
        if (committed.length) await options.retainInferences(committed)
      }
      const delegate = options.governedDelegateChild
      const tools = delegate
        ? [
            defineTool({
              name: 'delegate_child',
              description:
                'Delegate a bounded objective through the host governed child execution service.',
              parameters: DelegateParameters,
              replay: 'safe',
              executionMode: 'sequential',
              outputLimits: { maxBytes: 8192, maxLines: 64 },
              async execute(args, api, context) {
                try {
                  context.abortSignal?.throwIfAborted()
                  await options.assertAuthority()
                  const task = await api.getTask(api.taskId, context)
                  const assistant =
                    task?.input && typeof task.input === 'object' && !Array.isArray(task.input)
                      ? task.input['assistant']
                      : undefined
                  if (
                    typeof assistant !== 'number' ||
                    !Number.isSafeInteger(assistant) ||
                    assistant < 1
                  )
                    throw new Error('PI_TOOL_SOURCE_REJECTED')
                  const candidate = {
                    schemaVersion: 'pi-tool-source/v1' as const,
                    ...delegate.source,
                    conversationId: String(api.conversationId),
                    taskId: String(api.taskId),
                    assistantEntryId: String(assistant),
                    callId: api.callId,
                  }
                  const source = await api.memo('adea.delegate-child.source/v1', candidate, context)
                  if (piDurableToolSourceKey(source) !== piDurableToolSourceKey(candidate))
                    throw new Error('PI_TOOL_SOURCE_REJECTED')
                  const reader = {
                    assertCurrent: async (retained: PiDurableToolSource) => {
                      await options.assertAuthority()
                      await delegate.assertCurrent(retained)
                    },
                    readTask: async (retained: PiDurableToolSource) => {
                      if (retained.taskId !== String(api.taskId))
                        throw new Error('PI_TOOL_SOURCE_REJECTED')
                      return api.getTask(api.taskId, context)
                    },
                    readAssistantEntry: async (retained: PiDurableToolSource) => {
                      if (retained.assistantEntryId !== String(assistant))
                        throw new Error('PI_TOOL_SOURCE_REJECTED')
                      return api.commit(
                        (tx) => tx.entry(AssistantEntry, assistant as EntryId),
                        context
                      )
                    },
                  }
                  const verified = await verifyPiDurableToolSource(source, args, reader)
                  await retainCommitted(assistant as EntryId)
                  context.abortSignal?.throwIfAborted()
                  const outcome = PiDurableDelegateChildOutcomeSchema.parse(
                    await delegate.execute(
                      verified,
                      { readTask: reader.readTask, readAssistantEntry: reader.readAssistantEntry },
                      context.abortSignal
                    )
                  )
                  await reader.assertCurrent(verified.source)
                  context.abortSignal?.throwIfAborted()
                  if (outcome.state !== 'succeeded') {
                    const root = await harness.root(BACKGROUND_CONTEXT)
                    const submission = await api.commit(
                      (tx) =>
                        tx.submissionByRequest(api.conversationId, delegate.source.admittedTurnKey),
                      context
                    )
                    if (
                      submission?.type !== 'input' ||
                      submission.status === 'queued' ||
                      submission.entry === undefined
                    )
                      throw new Error('PI_TOOL_TURN_NOT_RETAINED')
                    const inferences = await receipts(root, submission.entry, assistant as EntryId)
                    const error = new PiDurableEngineToolBlockedError(
                      outcome,
                      verified.source,
                      verified.sourceKey,
                      inferences
                    )
                    const closing = harness.close(BACKGROUND_CONTEXT)
                    blocked.set(sessionId, { error, closing })
                    // Closing the native scheduler aborts this invocation without writing a tool outcome.
                    context.abortSignal?.throwIfAborted()
                    await new Promise<never>((_resolve, reject) =>
                      context.abortSignal?.addEventListener(
                        'abort',
                        () => reject(new Error('PI_GOVERNED_TOOL_BLOCKED')),
                        { once: true }
                      )
                    )
                    throw new Error('PI_GOVERNED_TOOL_BLOCKED')
                  }
                  return { content: [{ type: 'text' as const, text: JSON.stringify(outcome) }] }
                } catch {
                  // Never serialize host compiler/gate/source diagnostics into the native transcript.
                  if (!context.abortSignal?.aborted)
                    void harness.close(BACKGROUND_CONTEXT).catch(() => {})
                  throw new Error('PI_GOVERNED_TOOL_BLOCKED')
                }
              },
            }),
          ]
        : []
      const guard = defineExtension({
        name: 'adea.inference-authority',
        tools,
        hooks: [
          hook(GenerationTask, {
            beforeRequest: async (_request, api) => {
              await retainCommitted()
              inferenceId = `pi-generation:${String(api.taskId)}`
              return undefined
            },
          }),
        ],
      })

      const stream = (
        _model: Model<Api>,
        transcript: TranscriptContext,
        request?: SimpleStreamOptions
      ) => {
        const output = createAssistantMessageEventStream()
        const startedAt = performance.now()
        void (async () => {
          try {
            await options.assertAuthority()
            await options.withModels(async (models) => {
              const current = models.getModel(options.model.provider, options.model.modelId)
              if (
                !current ||
                current.api !== model.api ||
                current.id !== options.model.modelId ||
                current.provider !== options.model.provider
              )
                throw new Error('PI_PINNED_MODEL_UNAVAILABLE')
              if (!inferenceId) throw new Error('PI_INFERENCE_ID_REQUIRED')
              const reservation = await options.authorizeInference?.({
                sessionId,
                inferenceId,
                ...options.model,
              })
              if (
                options.authorizeInference &&
                (!reservation ||
                  typeof reservation.assertActive !== 'function' ||
                  !Number.isSafeInteger(reservation.maximumInputTokens) ||
                  reservation.maximumInputTokens < current.contextWindow ||
                  !Number.isSafeInteger(current.contextWindow) ||
                  current.contextWindow < 1)
              ) {
                throw new Error('PI_CONSERVATIVE_INPUT_HOLD_INSUFFICIENT')
              }
              const allowance = Math.min(
                options.maxOutputTokens,
                reservation?.maxOutputTokens ?? options.maxOutputTokens
              )
              if (!Number.isSafeInteger(allowance) || allowance < 1)
                throw new Error('PI_INFERENCE_BUDGET_EXHAUSTED')
              // Recheck after potentially asynchronous model resolution and ledger reservation.
              await options.assertAuthority()
              await reservation?.assertActive()
              let physicalSends = 0
              const events = models.streamSimple(
                current,
                { messages: transcript.messages },
                {
                  ...request,
                  deferred: false,
                  cacheRetention: 'none',
                  maxRetries: 0,
                  maxTokens: Math.min(request?.maxTokens ?? allowance, allowance),
                  fetch: async (input, init) => {
                    if (++physicalSends !== 1) throw new Error('PI_ADDITIONAL_PHYSICAL_SEND_DENIED')
                    // SDK/auth resolution may await after streamSimple. Fence the actual HTTP boundary too.
                    await options.assertAuthority()
                    await reservation?.assertActive()
                    return physicalFetch(input, { ...init, redirect: 'error' })
                  },
                }
              )
              for await (const event of events) {
                if (event.type === 'error') {
                  output.push({
                    type: 'error',
                    reason: 'error',
                    error: {
                      ...failure(model, 'PI_PROVIDER_REQUEST_FAILED'),
                      usage: safeFailureUsage(event.error.usage),
                      durationMs:
                        event.error.durationMs ?? Math.round(performance.now() - startedAt),
                    },
                  })
                } else if (
                  event.type === 'done' &&
                  (event.message.deferred ||
                    event.message.content.some(
                      (part) =>
                        part.type === 'toolCall' &&
                        (!delegate ||
                          part.name !== 'delegate_child' ||
                          !DelegateObjective.safeParse(part.arguments).success ||
                          !/^[A-Za-z0-9][A-Za-z0-9._:/|-]{0,255}$/.test(part.id) ||
                          event.message.stopReason !== 'toolUse')
                    ) ||
                    event.message.usage.cacheWrite > 0)
                ) {
                  output.push({
                    type: 'error',
                    reason: 'error',
                    error: {
                      ...failure(
                        model,
                        event.message.usage.cacheWrite > 0
                          ? 'PI_CACHE_WRITE_PRICING_UNSUPPORTED'
                          : 'PI_UNADMITTED_EFFECT_UNAVAILABLE'
                      ),
                      usage: safeFailureUsage(event.message.usage),
                    },
                  })
                } else {
                  if (event.type === 'done') {
                    event.message.durationMs ??= Math.round(performance.now() - startedAt)
                    counts(event.message.usage)
                    output.push(event)
                  } else if (event.type === 'start') {
                    // First profile publishes committed snapshots. Failed SDK partials can carry credentials.
                    const partial = failure(model, '')
                    delete partial.errorMessage
                    partial.stopReason = 'stop'
                    output.push({ type: 'start', partial })
                  }
                }
              }
              await events.result()
              return { completed: true }
            })
          } catch {
            // Error strings from authority, credential resolvers or providers can contain secrets.
            output.push({
              type: 'error',
              reason: 'error',
              error: failure(model, 'PI_MODEL_ACCESS_DENIED'),
            })
          } finally {
            output.end()
          }
        })()
        return output
      }
      const models = createModels()
      models.setProvider(
        createProvider({
          id: options.model.provider,
          models: [model],
          auth: {
            apiKey: { name: 'opaque eligible selection', resolve: async () => ({ auth: {} }) },
          },
          api: { stream, streamSimple: stream },
        })
      )
      const storage = await openNodeSqliteStorage(storePath(sessionId))
      try {
        const registry = createRegistry()
        registry.install(guard)
        harness = await Harness.open(
          storage,
          {
            models,
            registry,
            settings: {
              extensions: [guard],
              stream: { deferred: false, maxRetries: 0 },
              retry: { enabled: false, maxRetries: 0 },
              compaction: { enabled: false },
            },
          },
          BACKGROUND_CONTEXT
        )
        const root = await harness.root(BACKGROUND_CONTEXT, {
          agent: {
            model: options.model,
            extensions: [guard],
            tools,
          },
        })
        await root.commit(async (tx) => {
          const state = await tx.doc(EngineState, root.id)
          if (
            state.provider &&
            (state.provider !== options.model.provider ||
              state.modelId !== options.model.modelId ||
              state.runtimeVersion !== PI_DURABLE_RUNTIME_VERSION)
          ) {
            throw new Error('PI_STORED_RUNTIME_IDENTITY_MISMATCH')
          }
          state.provider = options.model.provider
          state.modelId = options.model.modelId
          const governedTools = delegate ? 'delegate_child/v1' : undefined
          if (
            state.inputs &&
            Object.keys(state.inputs).length > 0 &&
            state.governedTools !== governedTools
          )
            throw new Error('PI_STORED_TOOL_POLICY_MISMATCH')
          if (governedTools) state.governedTools = governedTools
        }, BACKGROUND_CONTEXT)
        return harness
      } catch (error) {
        await storage.close(BACKGROUND_CONTEXT)
        throw error
      }
    })()
    opened.set(sessionId, opening)
    try {
      return await opening
    } catch (error) {
      opened.delete(sessionId)
      throw error
    }
  }

  return {
    storePath,
    async run(request: PiDurableEngineRun): Promise<PiDurableEngineResult> {
      const startedAt = performance.now()
      if (!request.requestId) throw new Error('PI_REQUEST_ID_REQUIRED')
      const delegate = options.governedDelegateChild
      if (
        delegate &&
        (delegate.source.externalSessionId !== request.sessionId ||
          delegate.source.admittedTurnKey !== request.requestId)
      )
        throw new Error('PI_TOOL_TURN_SCOPE_MISMATCH')
      turns.set(request.sessionId, request.requestId)
      const harness = await open(request.sessionId)
      const root = await harness.root(BACKGROUND_CONTEXT)
      await root.commit(async (tx) => {
        const state = await tx.doc(EngineState, root.id)
        const key = digest(request.requestId)
        const inputDigest = digest(request.input)
        const prior = state.inputs[key]
        if (prior && prior !== inputDigest) throw new Error('PI_REQUEST_ID_CONFLICT')
        state.inputs[key] = inputDigest
      }, BACKGROUND_CONTEXT)
      // Calling submit/wait explicitly resumes Pi's scheduler. Merely opening a store does not infer.
      const submission = await root.submit(
        { type: 'input', requestId: request.requestId, content: request.input },
        BACKGROUND_CONTEXT
      )
      let settled
      try {
        settled = await submission.wait(BACKGROUND_CONTEXT)
      } catch (error) {
        const pending = blocked.get(request.sessionId)
        if (!pending) {
          const retained = await root.commit(
            (tx) => tx.submissionByRequest(root.id, request.requestId),
            BACKGROUND_CONTEXT
          )
          if (
            retained?.type === 'input' &&
            retained.status !== 'queued' &&
            retained.entry !== undefined
          ) {
            const committed = await receipts(root, retained.entry)
            if (committed.length) await options.retainInferences?.(committed)
          }
          throw error
        }
        await pending.closing
        opened.delete(request.sessionId)
        blocked.delete(request.sessionId)
        throw pending.error
      }
      if (settled.type !== 'input' || settled.status !== 'done')
        throw new Error('PI_SUBMISSION_UNANSWERED')
      const entry = await root.commit(
        (tx) => tx.entry(AssistantEntry, settled.answer),
        BACKGROUND_CONTEXT
      )
      const answer = entry?.model?.find(
        (message): message is AssistantMessage => message.role === 'assistant'
      )
      if (!answer || answer.stopReason === 'error' || answer.stopReason === 'aborted')
        throw new Error('PI_SUBMISSION_UNANSWERED')
      if (entry?.byTaskId === undefined) throw new Error('PI_NATIVE_INFERENCE_RECEIPT_MISSING')
      const inferences = await receipts(root, settled.entry, settled.answer)
      if (!inferences.length) throw new Error('PI_NATIVE_INFERENCE_RECEIPT_MISSING')
      await options.retainInferences?.(inferences)
      const trustedCounts = inferences.reduce(
        (total, inference) => ({
          inputTokens: total.inputTokens + inference.usage.inputTokens,
          outputTokens: total.outputTokens + inference.usage.outputTokens,
        }),
        { inputTokens: 0, outputTokens: 0 }
      )
      const durationMs = answer.durationMs ?? Math.round(performance.now() - startedAt)
      return {
        submissionId: String(submission.id),
        text: answer.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
        usage: {
          inputTokens: trustedCounts.inputTokens,
          outputTokens: trustedCounts.outputTokens,
          costUsd: String(answer.usage.cost.total),
          durationMs,
        },
        inferences,
      }
    },
    async inspect(sessionId: string) {
      return (await open(sessionId)).inspect(BACKGROUND_CONTEXT)
    },
    async cancel(sessionId: string): Promise<void> {
      const harness = await open(sessionId)
      await (await harness.root(BACKGROUND_CONTEXT)).abort(BACKGROUND_CONTEXT)
    },
    async close(): Promise<void> {
      closed = true
      await Promise.all(
        [...opened.values()].map(async (pending) => {
          const harness = await pending.catch(() => undefined)
          if (harness) await harness.close(BACKGROUND_CONTEXT)
        })
      )
      opened.clear()
      turns.clear()
    },
  }
}
