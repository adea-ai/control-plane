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
  InboxDoc,
  hook,
  type Conversation,
  type AbortCommitReceipt,
  type Cursor,
  type EntryId,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { z } from 'zod'
import { canonicalJsonStringify, compareCodePointOrder } from '@control-plane/contracts'
import {
  PiDurableDelegateChildOutcomeSchema,
  type PiDurableDelegateChildOutcome,
  type PiDurableGovernedDelegateChildEnginePort,
  type PiDurableGovernedManagementCallEnginePort,
  type PiGuardedCancellationPreparation,
  type PiGuardedCancellationInput,
  type PiGuardedCancellationEngine,
} from './contracts.js'
import {
  ManagementCallArgumentsSchema,
  verifyPiDurableManagementToolSource,
  verifyPiDurableToolSource,
  piDurableToolSourceKey,
  type PiDurableToolSource,
} from './tool-source.js'

export const PI_DURABLE_RUNTIME_VERSION = '1.1.0'

export interface PiDurableEngineOptions {
  /** Explicit disposable qualification only. Normal production construction omits it. */
  readonly nativeCancellationQualification?: {
    readonly now: () => string
    readonly onOwnerReady: (owner: {
      readonly sessionId: string
      readonly installFence: (input: { readonly mutationId: string }) => Promise<void>
      /** Test-only public-native operations for exact queued-input race qualification. */
      readonly queueInputForQualification: (input: {
        readonly requestId: string
        readonly content: string
      }) => Promise<number>
      readonly queuedInputIdsForQualification: () => Promise<readonly number[]>
    }) => void
    readonly onOwnerClosed: (sessionId: string) => void
  }
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
    /** Durable, owner-fenced markers surrounding the one physical provider send. */
    readonly preparePhysicalSend?: (requestDigest: string) => Promise<void>
    readonly armPhysicalSend?: (requestDigest: string) => Promise<void>
  }>
  /** Rebuild Models and hold eligible credential access only for this callback. */
  readonly withModels: <T>(use: (models: Models) => Promise<T>) => Promise<T>
  readonly governedDelegateChild?: PiDurableGovernedDelegateChildEnginePort
  /** Durable governed management caller; retains the full immutable request. */
  readonly governedManagementCall?: PiDurableGovernedManagementCallEnginePort
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

/** Raised when an unknown physical management effect must pause the turn. */
export class PiDurableManagementReconciliationRequiredError extends Error {
  constructor() {
    super('PI_MANAGEMENT_RECONCILIATION_REQUIRED')
    this.name = 'PiDurableManagementReconciliationRequiredError'
  }
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
const ManagementParameters = Type.Object(
  {
    operation: Type.String({ minLength: 1, maxLength: 128 }),
    // Operation-specific payload; the host compiler validates it strictly.
    input: Type.Object({}, { additionalProperties: true }),
  },
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

// A restriction union for this explicitly opted-in native owner only. It is not
// independent restore generation or complete product/CP writer registration.
const QualificationFence = defineDoc<{ revision: number; mutations: string[] }>({
  kind: 'adea.pi.native-cancellation-qualification-fence',
  scope: 'conversation',
  version: 1,
  history: 'latest',
  fork: 'initial',
  initial: () => ({ revision: 0, mutations: [] }),
})

const HistoricalCancellationIdentity = z.strictObject({
  sessionId: z.string().min(1).max(8192),
  requestId: z.string().min(1).max(8192),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  targetDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  turnKey: z.string().min(1).max(8192),
  inferenceId: z.string().min(1).max(8192).nullable(),
})
const HistoricalCancellationMetadata = z.strictObject({
  targetDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expiresAt: z.string(),
  fenceRevision: z.number().int().nonnegative().safe(),
  inferenceId: z.string().nullable(),
  turnKey: z.string(),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
})

const NativeReceiptIds = z
  .array(z.number().int().positive().safe())
  .refine((ids) => new Set(ids).size === ids.length)
const HistoricalCancellationReceipt = z.strictObject({
  version: z.literal(1),
  requestId: z.string().min(1).max(8192),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  conversationId: z.number().int().positive().safe(),
  background: z.literal(false),
  taskIds: NativeReceiptIds,
  queuedInputIds: NativeReceiptIds,
  metadata: HistoricalCancellationMetadata,
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
  // Observer admission is deliberately distinct from an opening promise. No
  // historical read may initialize storage, acquire models or revive a session.
  const readyOwners = new Map<string, { root: Conversation }>()
  const blocked = new Map<string, { error: Error; closing: Promise<void> }>()
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
      const management = options.governedManagementCall
      const delegateTools = delegate
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
                    readyOwners.delete(sessionId)
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
                  if (!context.abortSignal?.aborted) {
                    readyOwners.delete(sessionId)
                    void harness.close(BACKGROUND_CONTEXT).catch(() => {})
                  }
                  throw new Error('PI_GOVERNED_TOOL_BLOCKED')
                }
              },
            }),
          ]
        : []
      const managementTools = management
        ? [
            defineTool({
              name: 'management_call',
              description:
                'Execute a governed workspace management operation through the host decision service.',
              parameters: ManagementParameters,
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
                    ...management.source,
                    conversationId: String(api.conversationId),
                    taskId: String(api.taskId),
                    assistantEntryId: String(assistant),
                    callId: api.callId,
                  }
                  const source = await api.memo(
                    'adea.management-call.source/v1',
                    candidate,
                    context
                  )
                  if (piDurableToolSourceKey(source) !== piDurableToolSourceKey(candidate))
                    throw new Error('PI_TOOL_SOURCE_REJECTED')
                  const reader = {
                    assertCurrent: async (retained: PiDurableToolSource) => {
                      await options.assertAuthority()
                      await management.assertCurrent(retained)
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
                  const verified = await verifyPiDurableManagementToolSource(source, args, reader)
                  await retainCommitted(assistant as EntryId)
                  context.abortSignal?.throwIfAborted()
                  const outcome = await management.execute(
                    {
                      input: verified.args.input,
                      operation: verified.args.operation,
                      source: verified.source,
                      sourceKey: verified.sourceKey,
                    },
                    { readAssistantEntry: reader.readAssistantEntry, readTask: reader.readTask },
                    context.abortSignal
                  )
                  await reader.assertCurrent(verified.source)
                  context.abortSignal?.throwIfAborted()
                  if (outcome.state === 'reconciliation_required') {
                    // Close without a terminal tool outcome so the same
                    // execute/safe task resumes after an engine restart; the
                    // retained canonical identity prevents a resend or a
                    // fresh decision on that resume.
                    readyOwners.delete(sessionId)
                    const closing = harness.close(BACKGROUND_CONTEXT)
                    blocked.set(sessionId, {
                      closing,
                      error: new PiDurableManagementReconciliationRequiredError(),
                    })
                    context.abortSignal?.throwIfAborted()
                    await new Promise<never>((_resolve, reject) =>
                      context.abortSignal?.addEventListener(
                        'abort',
                        () => reject(new Error('PI_GOVERNED_TOOL_BLOCKED')),
                        { once: true }
                      )
                    )
                  }
                  return { content: [{ type: 'text' as const, text: JSON.stringify(outcome) }] }
                } catch (error) {
                  if (error instanceof PiDurableManagementReconciliationRequiredError) throw error
                  // Never serialize host compiler/gate/source diagnostics into the native transcript.
                  if (!context.abortSignal?.aborted) {
                    readyOwners.delete(sessionId)
                    void harness.close(BACKGROUND_CONTEXT).catch(() => {})
                  }
                  throw new Error('PI_GOVERNED_TOOL_BLOCKED', { cause: error })
                }
              },
            }),
          ]
        : []
      const tools = [...delegateTools, ...managementTools]
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
                    const physicalInit = { ...init, redirect: 'error' as const }
                    // SDK/auth resolution may await after streamSimple. Fence the actual HTTP boundary too.
                    await options.assertAuthority()
                    await reservation?.assertActive()
                    if (reservation?.preparePhysicalSend || reservation?.armPhysicalSend) {
                      if (!reservation.preparePhysicalSend || !reservation.armPhysicalSend)
                        throw new Error('PI_PHYSICAL_SEND_MARKER_INCOMPLETE')
                      const physicalRequest = new Request(input, physicalInit)
                      const requestDigest = await physicalRequestDigest(physicalRequest)
                      await reservation.preparePhysicalSend(requestDigest)
                      // An ambiguous arm result must never reach physicalFetch.
                      await reservation.armPhysicalSend(requestDigest)
                      await reservation.assertActive()
                      // This is the last await before fetch: a spending check may yield while
                      // another owner or cancellation advances the journal epoch.
                      await options.assertAuthority()
                      return physicalFetch(physicalRequest)
                    }
                    return physicalFetch(input, physicalInit)
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
                        (!(
                          (delegate !== undefined &&
                            part.name === 'delegate_child' &&
                            DelegateObjective.safeParse(part.arguments).success) ||
                          (management !== undefined &&
                            part.name === 'management_call' &&
                            ManagementCallArgumentsSchema.safeParse(part.arguments).success)
                        ) ||
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
        options.nativeCancellationQualification?.onOwnerReady({
          sessionId,
          queueInputForQualification: async ({ requestId, content }) =>
            root.commit(async (tx) => {
              const inbox = await tx.doc(InboxDoc, root.id)
              const record = await tx.createSubmission({
                conversationId: root.id,
                requestId,
                type: 'input',
                status: 'queued',
              })
              inbox.items.push({ id: record.id, mode: 'followUp', content })
              return record.id
            }, BACKGROUND_CONTEXT),
          queuedInputIdsForQualification: async () =>
            (await harness.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT))?.items.map(
              (item) => item.id
            ) ?? [],
          installFence: async ({ mutationId }) => {
            if (!mutationId || mutationId.length > 8192)
              throw new Error('PI_NATIVE_CANCELLATION_MUTATION_INVALID')
            await root.commit(async (tx) => {
              const fence = await tx.doc(QualificationFence, root.id)
              if (!fence.mutations.includes(mutationId)) {
                if (!Number.isSafeInteger(fence.revision + 1))
                  throw new Error('PI_NATIVE_CANCELLATION_EPOCH_EXHAUSTED')
                fence.mutations.push(mutationId)
                fence.revision += 1
              }
            }, BACKGROUND_CONTEXT)
          },
        })
        if (options.nativeCancellationQualification) readyOwners.set(sessionId, { root })
        return harness
      } catch (error) {
        readyOwners.delete(sessionId)
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

  const prepared = new WeakMap<
    PiGuardedCancellationPreparation,
    {
      root: Conversation
      revision: number
      scopeDigest: string
    }
  >()
  function requireHistoricalOwner(sessionId: string, expected?: { root: Conversation }) {
    const owner = readyOwners.get(sessionId)
    if (closed || !owner || (expected && owner !== expected))
      throw new Error('PI_NATIVE_CANCELLATION_OBSERVER_UNAVAILABLE')
    return owner
  }
  async function historicalReceipt(input: PiGuardedCancellationInput) {
    const parsed = HistoricalCancellationIdentity.safeParse(input)
    if (!parsed.success) throw new Error('PI_NATIVE_CANCELLATION_RECEIPT_BINDING_INVALID')
    const pins = Object.freeze(parsed.data)
    const owner = requireHistoricalOwner(pins.sessionId)
    const receipt = await owner.root.readAbortReceipt(pins.requestId, BACKGROUND_CONTEXT)
    requireHistoricalOwner(pins.sessionId, owner)
    if (receipt) {
      const checked = HistoricalCancellationReceipt.safeParse(receipt)
      if (
        !checked.success ||
        receipt.version !== 1 ||
        receipt.background !== false ||
        receipt.conversationId !== owner.root.id ||
        receipt.requestId !== pins.requestId ||
        receipt.requestDigest !== pins.requestDigest ||
        checked.data.metadata.targetDigest !== pins.targetDigest ||
        checked.data.metadata.expiresAt !== pins.expiresAt ||
        checked.data.metadata.turnKey !== pins.turnKey ||
        checked.data.metadata.inferenceId !== pins.inferenceId
      )
        throw new Error('PI_NATIVE_CANCELLATION_RECEIPT_BINDING_INVALID')
    }
    // No current-time, current-turn or authority check: this describes a past
    // committed effect and cannot authorize any new effect or journal settlement.
    return { pins, owner, receipt }
  }
  const guardedCancellation: PiGuardedCancellationEngine | undefined =
    options.nativeCancellationQualification
      ? {
          async readReceipt(input) {
            return (await historicalReceipt(input)).receipt
          },
          async drainReceipt(input): Promise<AbortCommitReceipt> {
            const { pins, owner, receipt } = await historicalReceipt(input)
            if (!receipt) throw new Error('PI_GUARDED_ABORT_RECEIPT_MISSING')
            const drained = await owner.root.drainAbortReceipt(pins.requestId, BACKGROUND_CONTEXT)
            requireHistoricalOwner(pins.sessionId, owner)
            if (canonicalJsonStringify(drained) !== canonicalJsonStringify(receipt))
              throw new Error('PI_NATIVE_CANCELLATION_RECEIPT_BINDING_INVALID')
            return drained
          },
          async prepare(input) {
            const pins = Object.freeze({ ...input })
            if (
              !pins.requestId ||
              !/^sha256:[a-f0-9]{64}$/.test(pins.requestDigest) ||
              !/^sha256:[a-f0-9]{64}$/.test(pins.targetDigest) ||
              !Number.isFinite(Date.parse(pins.expiresAt))
            )
              throw new Error('PI_NATIVE_CANCELLATION_BINDING_INVALID')
            const harness = await open(pins.sessionId)
            const root = await harness.root(BACKGROUND_CONTEXT)
            const inspection = await harness.inspect(BACKGROUND_CONTEXT)
            const queuedInputs = inspection.submissions.filter(
              (queued) =>
                queued.type === 'input' &&
                queued.status === 'queued' &&
                queued.conversationId === root.id
            )
            // Public inspection is read-only. Any queue change between this read
            // and N causes the exact native snapshot comparison below to refuse.
            const snapshot = await root.commit(async (tx) => {
              const fence = await tx.doc(QualificationFence, root.id)
              const tasks = []
              let cursor
              do {
                const page = await tx.scanTasks({}, 256, cursor)
                tasks.push(...page.items)
                cursor = page.next
              } while (cursor)
              const conversations = await tx.scanConversations({}, 2)
              if (
                conversations.next ||
                conversations.items.length !== 1 ||
                conversations.items[0]?.id !== root.id
              )
                throw new Error('PI_NATIVE_CANCELLATION_SCOPE_UNAVAILABLE')
              const live = tasks.filter(
                (task) => !task.background && task.state.status !== 'terminal'
              )
              if (
                turns.get(pins.sessionId) !== pins.turnKey ||
                live.some((task) => task.conversationId !== root.id) ||
                (pins.inferenceId !== null &&
                  !live.some((task) => `pi-generation:${String(task.id)}` === pins.inferenceId))
              )
                throw new Error('PI_LEAD_AUTHORITY_CONFLICT')
              return {
                revision: fence.revision,
                scopeDigest: digest(
                  canonicalJsonStringify({
                    tasks: live.toSorted((a, b) => a.id - b.id),
                    queuedInputs: queuedInputs.toSorted((a, b) => a.id - b.id),
                  })
                ),
              }
            }, BACKGROUND_CONTEXT)
            prepared.set(pins, { root, ...snapshot })
            return pins
          },
          async commit(preparation) {
            const candidate = prepared.get(preparation)
            if (!candidate) throw new Error('PI_NATIVE_CANCELLATION_PREPARATION_INVALID')
            const receipt = await candidate.root.commitAbort(
              {
                requestId: preparation.requestId,
                requestDigest: preparation.requestDigest,
                hostDocuments: [
                  {
                    token: QualificationFence,
                    conversationId: candidate.root.id,
                    mode: 'read',
                  },
                ],
                metadata: {
                  targetDigest: preparation.targetDigest,
                  expiresAt: preparation.expiresAt,
                  fenceRevision: candidate.revision,
                  inferenceId: preparation.inferenceId,
                  turnKey: preparation.turnKey,
                  scopeDigest: candidate.scopeDigest,
                },
                prepare: async (tx, scope) => {
                  const fence = await tx.doc(QualificationFence, candidate.root.id)
                  if (
                    fence.revision !== candidate.revision ||
                    scope.conversations.length !== 1 ||
                    scope.conversations[0]?.id !== candidate.root.id ||
                    turns.get(preparation.sessionId) !== preparation.turnKey ||
                    digest(
                      canonicalJsonStringify({
                        tasks: scope.tasks.toSorted((a, b) => a.id - b.id),
                        queuedInputs: scope.queuedInputs.toSorted((a, b) => a.id - b.id),
                      })
                    ) !== candidate.scopeDigest
                  )
                    throw new Error('PI_LEAD_AUTHORITY_CONFLICT')
                  return () => {
                    if (turns.get(preparation.sessionId) !== preparation.turnKey)
                      throw new Error('PI_LEAD_AUTHORITY_CONFLICT')
                    const now = Date.parse(options.nativeCancellationQualification!.now())
                    if (!Number.isFinite(now) || now >= Date.parse(preparation.expiresAt))
                      throw new Error('PI_AUTHORITY_EXPIRED')
                  }
                },
              },
              BACKGROUND_CONTEXT
            )
            // N is committed. D is intentionally not awaited while holding its line;
            // the caller can retain its exact receipt before any later drain result.
            return receipt
          },
        }
      : undefined

  return {
    storePath,
    ...(guardedCancellation ? { guardedCancellation } : {}),
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
        readyOwners.delete(request.sessionId)
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
      readyOwners.clear()
      await Promise.all(
        [...opened.entries()].map(async ([sessionId, pending]) => {
          const harness = await pending.catch(() => undefined)
          try {
            if (harness) await harness.close(BACKGROUND_CONTEXT)
          } finally {
            options.nativeCancellationQualification?.onOwnerClosed(sessionId)
          }
        })
      )
      opened.clear()
      turns.clear()
    },
  }
}

/** Fingerprint the actual SDK request without retaining its URL, headers, or body in the journal. */
async function physicalRequestDigest(request: Request): Promise<string> {
  const body = Buffer.from(await request.clone().arrayBuffer())
  const headers = [...request.headers.entries()].toSorted(([a], [b]) => compareCodePointOrder(a, b))
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        request.method,
        request.url,
        headers,
        createHash('sha256').update(body).digest('hex'),
      ])
    )
    .digest('hex')}`
}
