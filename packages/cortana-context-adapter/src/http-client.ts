import { z } from 'zod'
import { GatewayCommandEnvelopeSchema } from '@control-plane/runtime-gateway-protocol'
import type { CortanaClientPort, CortanaClientRequest } from './index.js'

export const CortanaClientRequestSchema = z
  .object({
    objective: z.string().min(1).max(16384),
    operationId: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    transport: z.enum(['http', 'mcp', 'runtime_node']),
    gatewayCommand: GatewayCommandEnvelopeSchema.optional(),
    mappedProjectRef: z.string().min(1).max(1024),
    scopeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    principalRef: z.string().min(1).max(256),
    maximumTokens: z.number().int().nonnegative(),
    deadline: z.iso.datetime(),
    includeEvidence: z.boolean(),
    includeMemory: z.boolean(),
  })
  .strict()

const HttpRequest = CortanaClientRequestSchema.omit({ gatewayCommand: true })
  .extend({ transport: z.literal('http') })
  .strict()

export interface CortanaHttpClientOptions {
  /** Full trusted read endpoint, never supplied by a gateway command. */
  readonly endpoint: string
  readonly authorization?: string
  readonly maximumResponseBytes?: number
  readonly allowLoopbackHttp?: boolean
}

/** POSTs the versioned adapter request to a configured Cortana-compatible HTTP endpoint. */
export class CortanaHttpClient implements CortanaClientPort {
  readonly #endpoint: string
  readonly #authorization: string | undefined
  readonly #limit: number
  constructor(options: CortanaHttpClientOptions) {
    const url = new URL(options.endpoint)
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && loopback && options.allowLoopbackHttp))
    )
      fail('ENDPOINT_INVALID')
    this.#endpoint = url.toString()
    this.#authorization = options.authorization
    if (
      this.#authorization !== undefined &&
      (this.#authorization.length > 8192 || /[\r\n]/.test(this.#authorization))
    )
      fail('AUTHORIZATION_INVALID')
    this.#limit = options.maximumResponseBytes ?? 524288
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1 || this.#limit > 16777216)
      fail('LIMIT_INVALID')
  }

  async read(input: CortanaClientRequest, signal: AbortSignal): Promise<unknown> {
    const request = HttpRequest.parse(input)
    const remaining = Date.parse(request.deadline) - Date.now()
    if (remaining <= 0 || remaining > 300000) fail('DEADLINE_INVALID')
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const timer = setTimeout(() => controller.abort(), remaining)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      combined.throwIfAborted()
      const response = await fetch(this.#endpoint, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        signal: combined,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.#authorization ? { authorization: this.#authorization } : {}),
        },
        body: JSON.stringify(request),
      })
      reader = response.body?.getReader()
      if (!response.ok) fail('HTTP_FAILED')
      if (
        !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(
          response.headers.get('content-type') ?? ''
        )
      )
        fail('CONTENT_TYPE_INVALID')
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > this.#limit))
        fail('OUTPUT_LIMIT')
      if (!reader) fail('BODY_MISSING')
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > this.#limit) fail('OUTPUT_LIMIT')
        chunks.push(value)
      }
      combined.throwIfAborted()
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (error) {
      if (
        error instanceof Error &&
        /^CORTANA_HTTP_(HTTP_FAILED|CONTENT_TYPE_INVALID|OUTPUT_LIMIT|BODY_MISSING)$/.test(
          error.message
        )
      )
        throw error
      return fail(combined.aborted ? 'ABORTED' : 'RESPONSE_FAILED')
    } finally {
      clearTimeout(timer)
      controller.abort()
      await reader?.cancel().catch(() => undefined)
      reader?.releaseLock()
    }
  }
}

function fail(code: string): never {
  throw new Error(`CORTANA_HTTP_${code}`)
}
