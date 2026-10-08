import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  createAssistantMessageEventStream,
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
  GenerationTask,
  Harness,
  hook,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

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
  const physicalFetch = globalThis.fetch
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
      const guard = defineExtension({
        name: 'adea.inference-authority',
        hooks: [
          hook(GenerationTask, {
            beforeRequest: (_request, api) => {
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
                    event.message.content.some((part) => part.type === 'toolCall') ||
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
        const harness = await Harness.open(
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
          agent: { model: options.model, extensions: [guard], tools: [] },
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
      const settled = await submission.wait(BACKGROUND_CONTEXT)
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
      const trustedCounts = counts(answer.usage)
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
        inferences: [
          {
            inferenceId: `pi-generation:${String(entry.byTaskId)}`,
            usage: { ...trustedCounts, durationMs },
          },
        ],
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
    },
  }
}
