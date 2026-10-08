import { createHash, timingSafeEqual } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/domain'
import { z } from 'zod'
import {
  ManagedModelRequestSchema,
  type ManagedModelGateway,
  type ManagedModelRequest,
  type ManagedModelResult,
  type ModelStreamChunk,
} from './index.js'

const Text = z.string().max(262_144)
const NativeMessage = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([
    Text,
    z.array(z.object({ type: z.literal('text'), text: Text }).strict()).max(256),
  ]),
})
const NativeRequest = z.object({
  model: z.string().max(128),
  messages: z.array(NativeMessage).min(1).max(256),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().default(false),
  tools: z.array(z.never()).max(0).optional(),
})
const MAX_BODY_BYTES = 1_048_576
const Alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Native OpenAI-compatible protocol surface for one trusted attempt binding.
 * The caller has only this capability; provider, credential, policy and financial
 * authority remain in the gateway's server composition. Install this handler on
 * a private broker listener, not the public Control API.
 */
export class NativeModelBroker {
  readonly #gateway: Pick<ManagedModelGateway, 'complete' | 'stream' | 'cancel'>
  readonly #template: ManagedModelRequest
  readonly #capability: Buffer
  readonly #active = new Set<string>()
  readonly #seen = new Set<string>()
  readonly #closing = new AbortController()
  #closed = false
  #reconciliationRequired = false

  constructor(options: {
    readonly gateway: Pick<ManagedModelGateway, 'complete' | 'stream' | 'cancel'>
    readonly template: ManagedModelRequest
    readonly capability: string
  }) {
    this.#gateway = options.gateway
    this.#template = ManagedModelRequestSchema.parse(structuredClone(options.template))
    if (!/^[a-f0-9]{64}$/.test(options.capability))
      throw new Error('MODEL_BROKER_CAPABILITY_INVALID')
    this.#capability = Buffer.from(`Bearer ${options.capability}`)
  }

  async fetch(inbound: Request): Promise<Response> {
    const supplied = Buffer.from(inbound.headers.get('authorization') ?? '')
    if (
      this.#closed ||
      supplied.length !== this.#capability.length ||
      !timingSafeEqual(supplied, this.#capability)
    )
      return failure(401, 'MODEL_BROKER_UNAUTHORIZED')
    if (
      inbound.method !== 'POST' ||
      new URL(inbound.url).pathname !== '/v1/chat/completions' ||
      !inbound.headers.get('content-type')?.toLowerCase().startsWith('application/json')
    )
      return failure(400, 'MODEL_BROKER_INVALID_REQUEST')
    let request: ManagedModelRequest
    let stream: boolean
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), this.#template.settings.timeoutMs)
    timer.unref()
    const signal = AbortSignal.any([inbound.signal, this.#closing.signal, deadline.signal])
    try {
      const input = NativeRequest.parse(JSON.parse(await boundedBody(inbound, signal)))
      if (
        input.model !== this.#template.alias ||
        (input.max_tokens !== undefined && input.max_completion_tokens !== undefined)
      )
        throw new Error('MODEL_BROKER_INVALID_REQUEST')
      const maxOutputTokens =
        input.max_tokens ?? input.max_completion_tokens ?? this.#template.settings.maxOutputTokens
      if (maxOutputTokens > this.#template.settings.maxOutputTokens)
        throw new Error('MODEL_BROKER_INVALID_REQUEST')
      // Native request metadata is data only; the schema strips unknown fields.
      request = ManagedModelRequestSchema.parse({
        ...this.#template,
        messages: input.messages.map((message) => ({
          role: message.role === 'developer' ? 'system' : message.role,
          content:
            typeof message.content === 'string'
              ? message.content
              : message.content.map((part) => part.text).join(''),
        })),
        settings: {
          ...this.#template.settings,
          maxOutputTokens,
          temperature: input.temperature ?? this.#template.settings.temperature,
        },
      })
      const identity = createHash('sha256')
        .update(
          canonicalJsonStringify({
            workspaceId: request.workspaceId,
            executionId: request.executionId,
            attemptId: request.attemptId,
            alias: request.alias,
            messages: request.messages,
            maxOutputTokens: request.settings.maxOutputTokens,
            temperature: request.settings.temperature,
            stream: input.stream,
          })
        )
        .digest('hex')
      request = ManagedModelRequestSchema.parse({
        ...request,
        modelCallId: identifier('mdc', identity),
        requestId: identifier('req', identity),
      })
      stream = input.stream
      signal.throwIfAborted()
      if (this.#closed) {
        clearTimeout(timer)
        return failure(401, 'MODEL_BROKER_UNAUTHORIZED')
      }
    } catch {
      clearTimeout(timer)
      return failure(400, 'MODEL_BROKER_INVALID_REQUEST')
    }
    // SDK retries cannot turn an uncertain serial request into a new dispatch.
    if (this.#reconciliationRequired || this.#active.size > 0) {
      clearTimeout(timer)
      return failure(409, 'MODEL_BROKER_RECONCILIATION_REQUIRED')
    }
    const modelCallId = request.modelCallId
    // Identical requests are retries for this attempt, even after a settled
    // response is lost. The stable ID also fences dispatch across broker recreation.
    if (this.#seen.has(modelCallId) || this.#seen.size >= 1024) {
      clearTimeout(timer)
      return failure(409, 'MODEL_BROKER_REQUEST_REPLAY')
    }
    this.#seen.add(modelCallId)
    this.#active.add(modelCallId)
    const abort = () => {
      void this.#gateway.cancel(modelCallId).catch(() => undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    const release = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      this.#active.delete(modelCallId)
    }
    if (!stream) {
      try {
        const result = await this.#gateway.complete(request, signal)
        if (signal.aborted || this.#closed) throw new Error('MODEL_BROKER_CANCELLED')
        return Response.json(
          {
            id: modelCallId,
            object: 'chat.completion',
            model: request.alias,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: result.content },
                finish_reason: finishReason(result.finishReason),
              },
            ],
            usage: protocolUsage(result.usage),
          },
          { headers: { 'cache-control': 'no-store' } }
        )
      } catch {
        this.#reconciliationRequired = true
        return failure(502, 'MODEL_BROKER_REQUEST_FAILED')
      } finally {
        release()
      }
    }
    const iterator = this.#gateway.stream(request, signal)[Symbol.asyncIterator]()
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          if (signal.aborted || this.#closed) throw new Error('MODEL_BROKER_CANCELLED')
          const next = await iterator.next()
          if (next.done) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
            release()
            return
          }
          const chunk = next.value
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: modelCallId,
                object: 'chat.completion.chunk',
                model: request.alias,
                choices: [
                  {
                    index: 0,
                    delta: { content: chunk.delta },
                    finish_reason:
                      chunk.finishReason === undefined ? null : finishReason(chunk.finishReason),
                  },
                ],
                ...(chunk.usage === undefined ? {} : { usage: protocolUsage(chunk.usage) }),
              })}\n\n`
            )
          )
        } catch {
          this.#reconciliationRequired = true
          abort()
          await iterator.return?.()
          release()
          controller.error(new Error('MODEL_BROKER_REQUEST_FAILED'))
        }
      },
      cancel: async () => {
        this.#reconciliationRequired = true
        abort()
        await iterator.return?.()
        release()
      },
    })
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    })
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    this.#closing.abort()
    this.#capability.fill(0)
    await Promise.allSettled([...this.#active].map((id) => this.#gateway.cancel(id)))
  }
}

function failure(status: number, code: string) {
  return Response.json(
    { error: { code, message: code } },
    { status, headers: { 'cache-control': 'no-store' } }
  )
}

function protocolUsage(usage: NonNullable<ModelStreamChunk['usage']>) {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
  }
}

function finishReason(finish: ManagedModelResult['finishReason']) {
  if (finish === 'tool_call') return 'tool_calls'
  if (finish === 'cancelled' || finish === 'error') throw new Error('MODEL_BROKER_REQUEST_FAILED')
  return finish
}

function identifier(prefix: string, digest: string) {
  let value = BigInt(`0x${digest.slice(0, 32)}`)
  let encoded = ''
  for (let n = 0; n < 26; n++) {
    encoded = Alphabet[Number(value & 31n)] + encoded
    value >>= 5n
  }
  return `${prefix}_${encoded}`
}

async function boundedBody(request: Request, signal: AbortSignal) {
  if (!request.body) throw new Error('MODEL_BROKER_INVALID_REQUEST')
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let bytes = 0
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_BODY_BYTES) throw new Error('MODEL_BROKER_INVALID_REQUEST')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
