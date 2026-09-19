import { Context, Cause, Data, Effect, Layer, ManagedRuntime, Option } from 'effect'
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

/**
 * Typed tagged errors — one per existing failure mode of the original
 * `CortanaHttpClient.read`. Mapped to the exact same `CORTANA_HTTP_*` error
 * values at the runtime boundary; nothing here crosses the public API.
 */
class Aborted extends Data.TaggedError('Aborted') {}

class HttpStatusFailed extends Data.TaggedError('HttpStatusFailed') {}

class ContentTypeInvalid extends Data.TaggedError('ContentTypeInvalid') {}

class OutputLimitExceeded extends Data.TaggedError('OutputLimitExceeded') {}

class BodyMissing extends Data.TaggedError('BodyMissing') {}

class TransportFailed extends Data.TaggedError('TransportFailed')<{
  readonly cause: unknown
}> {}

class ResponseUnparseable extends Data.TaggedError('ResponseUnparseable')<{
  readonly cause: unknown
}> {}

/** Service resolved by the module-level runtime: the fetch implementation, dereferenced at call time. */
class FetchService extends Context.Tag('m409/FetchService')<FetchService, () => typeof fetch>() {}

const FetchLayer = Layer.succeed(FetchService, () => globalThis.fetch)

/** Facade-edge runtime: built exactly once at module init, shared by all instances. */
const runtime = ManagedRuntime.make(FetchLayer)

const jsonContentType =
  /^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i

function readProgram(
  endpoint: string,
  authorization: string | undefined,
  limit: number,
  request: z.output<typeof HttpRequest>,
  callerSignal: AbortSignal,
  remaining: number
): Effect.Effect<unknown, Aborted | HttpStatusFailed | ContentTypeInvalid | OutputLimitExceeded | BodyMissing | TransportFailed | ResponseUnparseable, FetchService> {
  return Effect.gen(function* () {
    const controller = new AbortController()
    const combined = AbortSignal.any([callerSignal, controller.signal])
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

    const pipeline = Effect.gen(function* () {
      if (combined.aborted) return yield* Effect.fail(new Aborted())
      const fetchImpl = yield* FetchService
      const response = yield* Effect.tryPromise({
        try: (fiberSignal) =>
          fetchImpl()(endpoint, {
            method: 'POST',
            redirect: 'error',
            credentials: 'omit',
            signal: AbortSignal.any([combined, fiberSignal]),
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              ...(authorization ? { authorization } : {}),
            },
            body: JSON.stringify(request),
          }),
        catch: (cause) => new TransportFailed({ cause }),
      })
      reader = response.body?.getReader()
      if (!response.ok) return yield* Effect.fail(new HttpStatusFailed())
      if (!jsonContentType.test(response.headers.get('content-type') ?? ''))
        return yield* Effect.fail(new ContentTypeInvalid())
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
        return yield* Effect.fail(new OutputLimitExceeded())
      const body = reader
      if (!body) return yield* Effect.fail(new BodyMissing())

      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const result = yield* Effect.tryPromise({
          try: () => body.read(),
          catch: (cause) => new TransportFailed({ cause }),
        })
        if (result.done) break
        size += result.value.byteLength
        if (size > limit) return yield* Effect.fail(new OutputLimitExceeded())
        chunks.push(result.value)
      }
      if (combined.aborted) return yield* Effect.fail(new Aborted())
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return yield* Effect.try({
        try: () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        catch: (cause) => new ResponseUnparseable({ cause }),
      })
    }).pipe(
      // Deadline cap — interrupts the fiber, which aborts the in-flight fetch
      // through the fiber signal, exactly as the original's timer aborts its controller.
      Effect.timeoutFail({
        duration: remaining,
        onTimeout: () => new Aborted(),
      }),
      Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
      // Mirrors the original's `finally`: release the body lock in every exit path.
      Effect.ensuring(
        Effect.promise(async () => {
          controller.abort()
          await reader?.cancel().catch(() => undefined)
          reader?.releaseLock()
        })
      )
    )
    return yield* pipeline
  })
}

function toHttpError(
  error:
    | Aborted
    | HttpStatusFailed
    | ContentTypeInvalid
    | OutputLimitExceeded
    | BodyMissing
    | TransportFailed
    | ResponseUnparseable
): Error {
  switch (error._tag) {
    case 'Aborted':
      return fail('ABORTED')
    case 'HttpStatusFailed':
      return fail('HTTP_FAILED')
    case 'ContentTypeInvalid':
      return fail('CONTENT_TYPE_INVALID')
    case 'OutputLimitExceeded':
      return fail('OUTPUT_LIMIT')
    case 'BodyMissing':
      return fail('BODY_MISSING')
    case 'TransportFailed':
    case 'ResponseUnparseable':
      return fail('RESPONSE_FAILED')
  }
}

/** POSTs the versioned adapter request to a configured Cortana-compatible HTTP endpoint. */
export class EffectCortanaHttpClient implements CortanaClientPort {
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
    const exit = await runtime.runPromiseExit(
      Effect.mapError(
        readProgram(this.#endpoint, this.#authorization, this.#limit, request, signal, remaining),
        toHttpError
      )
    )
    if (exit._tag === 'Failure') {
      const failure = Cause.failureOption(exit.cause)
      if (Option.isSome(failure)) throw failure.value
      const defect = Cause.dieOption(exit.cause)
      if (Option.isSome(defect)) throw defect.value
      throw fail('RESPONSE_FAILED')
    }
    return exit.value
  }
}

function fail(code: string): never {
  throw new Error(`CORTANA_HTTP_${code}`)
}
