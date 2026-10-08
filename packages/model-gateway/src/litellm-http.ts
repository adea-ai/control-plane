import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  DurableUsageLedger,
  ModelPriceSnapshotSchema,
  PinnedModelPrice,
} from '@control-plane/usage-ledger'
import { z } from 'zod'
import { RecordedModelSpendingAuthorizationSchema } from './recorded-spending-authorization.js'
export { RecordedModelSpendingAuthorizationSchema } from './recorded-spending-authorization.js'
import {
  ManagedModelRequestSchema,
  ModelProviderError,
  type LiteLlmClientPort,
  type LiteLlmRequestInput,
} from './index.js'

const Reference = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const Amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export interface ModelHttpAuthorization {
  readonly grant: unknown
  readonly price: unknown
  /** Exact server-owned LiteLLM deployment, never a load-balanced model group. */
  readonly proxyModelId: string
  readonly endpoint: string
  readonly credential: { readonly value: Uint8Array; close(): Promise<void> }
  /** Re-read revocation/current authority immediately before the physical send. */
  assertActive(signal: AbortSignal): Promise<void>
}

export interface ModelHttpAuthority {
  /** Only the server composition supplies this port. Its source must authenticate
   * the recorded scope, spend authorization, deployment and credential binding.
   * Implementations must honor abort and close any lease acquired after abort.
   */
  authorize(
    context: LiteLlmRequestInput['context'],
    signal: AbortSignal
  ): Promise<ModelHttpAuthorization>
}

const Usage = z
  .object({
    prompt_tokens: Amount,
    completion_tokens: Amount,
    total_tokens: Amount,
    prompt_tokens_details: z.object({ cached_tokens: Amount.optional() }).optional(),
    completion_tokens_details: z.object({ reasoning_tokens: Amount.optional() }).optional(),
  })
  .superRefine((usage, ctx) => {
    if (
      !Number.isSafeInteger(usage.prompt_tokens + usage.completion_tokens) ||
      usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens ||
      (usage.prompt_tokens_details?.cached_tokens ?? 0) > usage.prompt_tokens ||
      (usage.completion_tokens_details?.reasoning_tokens ?? 0) > usage.completion_tokens
    )
      ctx.addIssue({ code: 'custom', message: 'Unknown model usage' })
  })
const Finish = z.enum(['stop', 'length', 'tool_calls', 'function_call', 'content_filter'])
const Completion = z.object({
  id: z.string().min(1).max(256).optional(),
  choices: z
    .array(
      z.object({ message: z.object({ content: z.string().max(4_194_304) }), finish_reason: Finish })
    )
    .length(1),
  usage: Usage,
})
const StreamFrame = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().max(262_144).nullable().optional() }),
        finish_reason: Finish.nullable().optional(),
      })
    )
    .max(1),
  usage: Usage.nullable().optional(),
})
const MAX_RESPONSE_BYTES = 4_194_304
const unknownOutcome = () => new ModelProviderError('MODEL_HTTP_OUTCOME_UNKNOWN', false)

/** One committed hold per physical HTTP request. No retry, redirect or opaque
 * fallback can occur in this client; ambiguous outcomes remain held for recovery.
 */
export class LedgerLiteLlmHttpClient implements LiteLlmClientPort {
  readonly managesPhysicalTimeout = true
  readonly #ledger: DurableUsageLedger
  readonly #authority: ModelHttpAuthority
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => string
  readonly #active = new Map<string, Set<AbortController>>()

  constructor(options: {
    readonly ledger: DurableUsageLedger
    readonly authority: ModelHttpAuthority
    readonly fetch?: typeof globalThis.fetch
    readonly now?: () => string
  }) {
    this.#ledger = options.ledger
    this.#authority = options.authority
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async complete(input: LiteLlmRequestInput) {
    const send = await this.#admit(input, false)
    try {
      const response = await send.fetch()
      const bytes = await readResponse(response, send.signal)
      const result = Completion.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      )
      await send.settle(result.usage)
      return {
        choices: result.choices,
        usage: normalizedUsage(result.usage),
        ...(result.id === undefined ? {} : { id: result.id }),
        response_ms: Math.max(0, Math.round(performance.now() - send.startedAt)),
      }
    } catch (error) {
      if (error instanceof ModelProviderError && error.providerCode === 'MODEL_HTTP_SEND_DENIED')
        throw error
      throw unknownOutcome()
    } finally {
      await send.close()
    }
  }

  async *stream(input: LiteLlmRequestInput) {
    const send = await this.#admit(input, true)
    try {
      const response = await send.fetch()
      if (
        !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') ||
        !response.body
      )
        throw unknownOutcome()
      let finish: z.output<typeof Finish> | undefined
      let usage: z.output<typeof Usage> | undefined
      let done = false
      for await (const data of streamData(response.body, send.signal)) {
        if (done) throw unknownOutcome()
        if (data === '[DONE]') {
          done = true
          continue
        }
        const frame = StreamFrame.parse(JSON.parse(data))
        const choice = frame.choices[0]
        if (choice?.delta.content) {
          if (finish !== undefined) throw unknownOutcome()
          yield { delta: choice.delta.content }
        }
        if (choice?.finish_reason) {
          if (finish !== undefined) throw unknownOutcome()
          finish = choice.finish_reason
        }
        if (frame.usage) {
          if (usage !== undefined) throw unknownOutcome()
          usage = frame.usage
        }
      }
      if (!done || finish === undefined || usage === undefined) throw unknownOutcome()
      await send.settle(usage)
      // Usage commonly arrives after the provider's finish chunk. Publish the
      // terminal boundary only after EOF and durable settlement, not before it.
      yield { delta: '', finish_reason: finish, usage: normalizedUsage(usage) }
    } catch (error) {
      if (error instanceof ModelProviderError && error.providerCode === 'MODEL_HTTP_SEND_DENIED')
        throw error
      throw unknownOutcome()
    } finally {
      await send.close()
    }
  }

  async health() {
    return { healthy: true, checkedAt: this.#now(), reasonCode: 'HTTP_CLIENT_CONFIGURED' }
  }

  async cancel(modelCallId: string) {
    const active = this.#active.get(modelCallId)
    if (!active) return false
    for (const controller of active) controller.abort()
    return true
  }

  async #admit(input: LiteLlmRequestInput, stream: boolean) {
    input.context.signal?.throwIfAborted()
    const request = ManagedModelRequestSchema.parse(input.context.request)
    const deployment = structuredClone(input.context.deployment)
    if (
      input.model !== deployment.providerModel ||
      input.credentialRef !== deployment.credentialRef ||
      input.maxTokens !== request.settings.maxOutputTokens ||
      input.temperature !== request.settings.temperature ||
      input.timeoutMs !== request.settings.timeoutMs ||
      input.traceId !== request.traceId ||
      canonicalJsonStringify(input.messages) !== canonicalJsonStringify(request.messages)
    )
      throw new Error('MODEL_HTTP_SCOPE_MISMATCH')
    const startedAt = performance.now()
    const controller = new AbortController()
    const externalAbort = () => controller.abort()
    input.context.signal?.addEventListener('abort', externalAbort, { once: true })
    if (input.context.signal?.aborted) controller.abort()
    const timer = setTimeout(() => controller.abort(), request.settings.timeoutMs)
    timer.unref()
    const controllers = this.#active.get(request.modelCallId) ?? new Set<AbortController>()
    controllers.add(controller)
    this.#active.set(request.modelCallId, controllers)
    let authorization: ModelHttpAuthorization | undefined
    const close = async () => {
      input.context.signal?.removeEventListener('abort', externalAbort)
      controller.abort()
      clearTimeout(timer)
      controllers.delete(controller)
      if (controllers.size === 0) this.#active.delete(request.modelCallId)
      await authorization?.credential.close()
    }
    try {
      authorization = await abortable(
        this.#authority.authorize({ request, deployment }, controller.signal),
        controller.signal,
        (late) => late.credential.close()
      )
      const grant = RecordedModelSpendingAuthorizationSchema.parse(authorization.grant)
      const price = ModelPriceSnapshotSchema.parse(authorization.price)
      const at = Date.parse(z.iso.datetime().parse(this.#now()))
      if (
        controller.signal.aborted ||
        !deployment.enabled ||
        grant.workspaceId !== request.workspaceId ||
        grant.executionId !== request.executionId ||
        grant.attemptId !== request.attemptId ||
        grant.deploymentId !== deployment.deploymentId ||
        grant.principalRef !== request.principalRef ||
        grant.alias !== request.alias ||
        grant.policySnapshotDigest !== request.policySnapshot.digest ||
        grant.credentialRef !== deployment.credentialRef ||
        grant.fundingSource !== request.fundingSource ||
        deployment.fundingSource !== request.fundingSource ||
        price.fundingSource !== request.fundingSource ||
        price.deploymentId !== deployment.deploymentId ||
        price.provider !== deployment.provider ||
        price.model !== deployment.providerModel ||
        at < Date.parse(grant.issuedAt) ||
        at >= Date.parse(grant.expiresAt) ||
        price.maximumInputTokens < deployment.maxContextTokens ||
        input.maxTokens > deployment.maxOutputTokens
      )
        throw new Error('MODEL_HTTP_AUTHORIZATION_DENIED')
      const endpoint = new URL(authorization.endpoint)
      if (
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== '/v1/chat/completions' ||
        (endpoint.protocol !== 'https:' &&
          !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)))
      )
        throw new Error('MODEL_HTTP_ENDPOINT_DENIED')
      const proxyModelId = Reference.parse(authorization.proxyModelId)
      const secret = new TextDecoder('utf-8', { fatal: true }).decode(
        authorization.credential.value
      )
      if (!/^[\x21-\x7e]{1,4096}$/.test(secret)) throw new Error('MODEL_HTTP_CREDENTIAL_INVALID')
      const body = JSON.stringify({
        model: proxyModelId,
        messages: request.messages,
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        disable_fallbacks: true,
        num_retries: 0,
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        ...(request.settings.responseFormat === 'json'
          ? { response_format: { type: 'json_object' } }
          : {}),
      })
      // The broker allocates one modelCallId for each incoming native HTTP send.
      // Keep the fence stable through route/price changes and process restarts.
      const physicalCallId = request.modelCallId
      const digest = `sha256:${createHash('sha256')
        .update(
          canonicalJsonStringify({
            request,
            deployment,
            grant,
            endpoint: endpoint.href,
            proxyModelId,
            body,
          })
        )
        .digest('hex')}`
      const quote = new PinnedModelPrice(price, { now: this.#now }).quote({
        requestDigest: digest,
        maximumOutputTokens: input.maxTokens,
      })
      if (
        quote.maximumMicrounits > grant.maximumMicrounits ||
        quote.maximumTokens > grant.maximumTokens
      )
        throw new Error('MODEL_HTTP_AUTHORIZATION_DENIED')
      // The reservation ceiling is immutable and bounds all sends/charges for
      // this attempt. A per-request grant comparison alone permits cumulative
      // spend beyond the recorded authorization after earlier holds settle.
      const allocation = await abortable(
        this.#ledger.attemptAllocation(request.workspaceId, request.executionId, request.attemptId),
        controller.signal
      )
      if (
        allocation.currency !== grant.currency ||
        (grant.fundingSource !== 'external_subscription' &&
          allocation.maximumMicrounits > grant.maximumMicrounits) ||
        allocation.maximumTokens > grant.maximumTokens
      )
        throw new Error('MODEL_HTTP_AUTHORIZATION_DENIED')
      const scope = {
        workspaceId: request.workspaceId,
        executionId: request.executionId,
        attemptId: request.attemptId,
        reservationKey: `runtime-attempt:${request.attemptId}`,
        modelCallId: physicalCallId,
      }
      await abortable(
        this.#ledger.reserveModelRequestForDispatch({
          ...scope,
          maximumMicrounits: quote.maximumMicrounits,
          maximumTokens: quote.maximumTokens,
          fundingSource: quote.fundingSource,
          priceSnapshotDigest: quote.priceSnapshotDigest,
          requestDigest: digest,
          source: {
            sourceId: `http:${physicalCallId}`,
            idempotencyKey: `http:${physicalCallId}:hold`,
          },
        }),
        controller.signal
      )
      const approved = authorization
      return {
        startedAt,
        signal: controller.signal,
        close,
        fetch: async () => {
          try {
            await abortable(approved.assertActive(controller.signal), controller.signal)
            const sendAt = Date.parse(z.iso.datetime().parse(this.#now()))
            if (
              controller.signal.aborted ||
              sendAt < Date.parse(grant.issuedAt) ||
              sendAt >= Date.parse(grant.expiresAt) ||
              sendAt < Date.parse(price.validFrom) ||
              sendAt >= Date.parse(price.validUntil)
            )
              throw unknownOutcome()
          } catch {
            // This branch precedes fetch invocation, so the no-send outcome is
            // proven. Use its own bounded accounting deadline after cancellation.
            await abortable(
              this.#ledger.settleModelRequest({
                ...scope,
                costMicrounits: 0,
                tokens: 0,
                source: {
                  sourceId: `http:${physicalCallId}`,
                  idempotencyKey: `http:${physicalCallId}:nosend`,
                },
              }),
              AbortSignal.timeout(1000)
            )
            throw new ModelProviderError('MODEL_HTTP_SEND_DENIED', false)
          }
          const response = await abortable(
            this.#fetch(endpoint.href, {
              method: 'POST',
              redirect: 'error',
              signal: controller.signal,
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${secret}`,
                'x-litellm-num-retries': '0',
                'x-litellm-trace-id': request.traceId,
              },
              body,
            }),
            controller.signal,
            async (late) => {
              await late.body?.cancel()
            }
          )
          if (!response.ok) {
            await response.body?.cancel()
            throw unknownOutcome()
          }
          return response
        },
        settle: async (usage: z.output<typeof Usage>) => {
          const actual = quote.priceUsage({
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
          })
          await abortable(
            this.#ledger.settleModelRequest({
              ...scope,
              costMicrounits: actual.costMicrounits,
              tokens: actual.tokens,
              source: {
                sourceId: `http:${physicalCallId}`,
                idempotencyKey: `http:${physicalCallId}:settle`,
              },
            }),
            controller.signal
          )
        },
      }
    } catch (error) {
      await close()
      throw error
    }
  }
}

function abortable<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  closeLate?: (value: T) => Promise<void>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false
    const abort = () => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      reject(unknownOutcome())
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then(
      (value) => {
        if (finished) {
          void closeLate?.(value).catch(() => undefined)
          return
        }
        finished = true
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        if (finished) return
        finished = true
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

function normalizedUsage(usage: z.output<typeof Usage>) {
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.prompt_tokens_details?.cached_tokens === undefined
      ? {}
      : { prompt_tokens_details: { cached_tokens: usage.prompt_tokens_details.cached_tokens } }),
    ...(usage.completion_tokens_details?.reasoning_tokens === undefined
      ? {}
      : {
          completion_tokens_details: {
            reasoning_tokens: usage.completion_tokens_details.reasoning_tokens,
          },
        }),
  }
}

async function readResponse(response: Response, signal: AbortSignal) {
  if (
    !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
    !response.body
  )
    throw unknownOutcome()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of readChunks(response.body, signal)) {
    size += chunk.byteLength
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function* readChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  let bytes = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const result = await reader.read()
      signal.throwIfAborted()
      if (result.done) return
      bytes += result.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw unknownOutcome()
      yield result.value
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function* streamData(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  for await (const chunk of readChunks(body, signal)) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary: RegExpExecArray | null
    while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const event = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) yield data
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) throw unknownOutcome()
}
