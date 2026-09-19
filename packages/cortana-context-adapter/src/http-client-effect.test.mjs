import { expect, test } from 'bun:test'
import { CortanaHttpClient } from './http-client.ts'
import { EffectCortanaHttpClient } from './http-client-effect.ts'

const implementations = [
  ['promise-original', CortanaHttpClient],
  ['effect-facade', EffectCortanaHttpClient],
]

function request() {
  return {
    objective: 'Read evidence',
    operationId: 'context-http:operation-1',
    transport: 'http',
    mappedProjectRef: 'project:test',
    scopeDigest: `sha256:${'a'.repeat(64)}`,
    principalRef: 'service:test',
    maximumTokens: 100,
    deadline: new Date(Date.now() + 10000).toISOString(),
    includeEvidence: true,
    includeMemory: false,
  }
}

async function serverTest(fetch, run) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch })
  try {
    await run(`http://127.0.0.1:${server.port}/read`)
  } finally {
    await server.stop(true)
  }
}

for (const [label, Client] of implementations) {
  // The original http-client.test.mjs suite, unchanged, executed for both
  // implementations — the only edit is the constructor indirection above.
  test(`[${label}] HTTP context client uses the fixed endpoint and explicit credentials with operation correlation`, () =>
    serverTest(
      async (incoming) => {
        expect(incoming.method).toBe('POST')
        expect(incoming.headers.get('authorization')).toBe('Bearer test-only')
        const body = await incoming.json()
        expect(body.operationId).toBe('context-http:operation-1')
        expect(body.objective).toBe('Read evidence')
        return Response.json({ evidence: 'bounded' })
      },
      async (endpoint) => {
        expect(() => new Client({ endpoint })).toThrow('ENDPOINT_INVALID')
        const client = new Client({
          endpoint,
          allowLoopbackHttp: true,
          authorization: 'Bearer test-only',
        })
        expect(await client.read(request(), new AbortController().signal)).toEqual({
          evidence: 'bounded',
        })
        await expect(
          client.read({ ...request(), gatewayCommand: {} }, new AbortController().signal)
        ).rejects.toThrow()
      }
    ))

  test(`[${label}] HTTP context client does not follow redirects or expose remote error bodies`, () => {
    let redirected = 0
    return serverTest(
      (incoming) => {
        if (new URL(incoming.url).pathname === '/target') {
          redirected++
          return Response.json({ secret: 'never-read' })
        }
        return Response.redirect(new URL('/target', incoming.url), 302)
      },
      async (endpoint) => {
        const client = new Client({ endpoint, allowLoopbackHttp: true })
        await expect(client.read(request(), new AbortController().signal)).rejects.toThrow(
          'RESPONSE_FAILED'
        )
        expect(redirected).toBe(0)
      }
    )
  })

  test(`[${label}] HTTP context client bounds streamed bytes and rejects invalid JSON and content types`, async () => {
    for (const [body, type, limit, code] of [
      ['x'.repeat(200), 'application/json', 20, 'OUTPUT_LIMIT'],
      ['not-json-private-text', 'application/json', 200, 'RESPONSE_FAILED'],
      ['{}', 'text/plain', 200, 'CONTENT_TYPE_INVALID'],
    ])
      await serverTest(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(body))
                controller.close()
              },
            }),
            { headers: { 'content-type': type } }
          ),
        async (endpoint) => {
          const client = new Client({
            endpoint,
            allowLoopbackHttp: true,
            maximumResponseBytes: limit,
          })
          await expect(client.read(request(), new AbortController().signal)).rejects.toThrow(code)
        }
      )
  })

  test(`[${label}] HTTP context client honors an already aborted caller without sending a request`, () => {
    let calls = 0
    return serverTest(
      () => {
        calls++
        return Response.json({})
      },
      async (endpoint) => {
        const client = new Client({ endpoint, allowLoopbackHttp: true })
        const controller = new AbortController()
        controller.abort()
        await expect(client.read(request(), controller.signal)).rejects.toThrow('ABORTED')
        expect(calls).toBe(0)
      }
    )
  })
}

// ---------------------------------------------------------------------------
// Failure-injection parity: identical stubbed fetch for both implementations;
// assertions compare error codes AND byte accounting (bytes delivered to the
// reader, cancel timing) — not just outcomes.
// ---------------------------------------------------------------------------

/**
 * Creates a stubbed fetch with instrumented byte accounting.
 * spec: { status?, contentType?, contentLength?, chunks: string[],
 *         respondAfterMs?, omitBody?, fetchThrows? }
 *
 * The response body is a pull-based stream (highWaterMark 0): each reader
 * `read()` pulls exactly one chunk, so `bytesDelivered` counts exactly the
 * bytes the implementation chose to consume before finishing or cancelling.
 */
function makeStub(spec) {
  const log = {
    fetchCalls: 0,
    bytesDelivered: 0,
    bytesAtCancel: null,
    cancelCalled: false,
    streamTerminated: false,
    aborted: false,
  }
  const stub = (url, init) => {
    log.fetchCalls++
    const signal = init?.signal
    signal?.addEventListener('abort', () => {
      log.aborted = true
    })
    if (spec.fetchThrows) return Promise.reject(spec.fetchThrows)
    const respond = () => {
      let streamCancelled = false
      let streamErrored = false
      let scheduled = 0
      let streamController
      // Real fetch semantics: aborting the request signal errors the body
      // stream. The stub must model this or mid-stream abort behavior diverges.
      signal?.addEventListener('abort', () => {
        streamErrored = true
        log.streamTerminated = true
        try {
          streamController?.error(new DOMException('This operation was aborted', 'AbortError'))
        } catch {
          // already closed
        }
      })
      const body =
        spec.omitBody || spec.chunks === undefined
          ? null
          : new ReadableStream(
              {
                start(controller) {
                  streamController = controller
                },
                pull(controller) {
                  const emit = () => {
                    scheduled--
                    if (streamCancelled || streamErrored) return
                    if (log.nextChunk >= spec.chunks.length) {
                      controller.close()
                      return
                    }
                    const encoded = new TextEncoder().encode(spec.chunks[log.nextChunk])
                    log.nextChunk++
                    log.bytesDelivered += encoded.byteLength
                    controller.enqueue(encoded)
                  }
                  const delay = spec.chunkDelayMs ?? 0
                  if (delay > 0) {
                    // One in-flight delivery at a time; the queue stays empty so
                    // pull is re-invoked only after the previous chunk lands.
                    if (scheduled === 0) {
                      scheduled++
                      setTimeout(emit, delay)
                    }
                  } else {
                    emit()
                  }
                },
                cancel() {
                  streamCancelled = true
                  log.cancelCalled = true
                  log.bytesAtCancel = log.bytesDelivered
                  log.streamTerminated = true
                },
              },
              { highWaterMark: 0 }
            )
      log.nextChunk = 0
      const headers = { 'content-type': spec.contentType ?? 'application/json' }
      if (spec.contentLength !== undefined) headers['content-length'] = spec.contentLength
      return new Response(body, { status: spec.status ?? 200, headers })
    }
    if (spec.respondAfterMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(respond()), spec.respondAfterMs)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('This operation was aborted', 'AbortError'))
        })
      })
    }
    return Promise.resolve(respond())
  }
  return { stub, log }
}

async function runScenario(Client, spec, options = {}) {
  const { stub, log } = makeStub(spec)
  const originalFetch = globalThis.fetch
  globalThis.fetch = stub
  const client = new Client({
    endpoint: 'http://127.0.0.1:9/read',
    allowLoopbackHttp: true,
    ...(options.maximumResponseBytes !== undefined
      ? { maximumResponseBytes: options.maximumResponseBytes }
      : {}),
  })
  let outcome
  try {
    outcome = { ok: true, value: await client.read(request(), new AbortController().signal) }
  } catch (error) {
    outcome = { ok: false, message: error.message, name: error.name }
  } finally {
    globalThis.fetch = originalFetch
  }
  // Give the implementation's cleanup a tick to run.
  await Bun.sleep(5)
  return { outcome, log }
}

test('failure injection: both implementations produce identical codes and byte accounting', async () => {
  const scenarios = [
    {
      name: 'success-streamed-json',
      spec: { chunks: ['{"evi', 'dence"', ':[1,2]}'], chunkDelayMs: 0 },
    },
    {
      name: 'non-2xx',
      spec: { status: 503, chunks: ['{"error":"down"}'] },
    },
    {
      name: 'mid-stream-truncation-invalid-json',
      spec: { chunks: ['{"partial":'] },
    },
    {
      name: 'mid-stream-oversized-body',
      spec: { chunks: ['x'.repeat(64), 'x'.repeat(64), 'x'.repeat(64), 'x'.repeat(64)] },
      options: { maximumResponseBytes: 100 },
    },
    {
      name: 'oversized-content-length-header',
      spec: { chunks: ['{}'], contentLength: '1000' },
      options: { maximumResponseBytes: 100 },
    },
    {
      name: 'non-numeric-content-length',
      spec: { chunks: ['{}'], contentLength: 'many' },
      options: { maximumResponseBytes: 100 },
    },
    {
      name: 'missing-body',
      spec: { omitBody: true },
    },
    {
      name: 'wrong-content-type',
      spec: { chunks: ['{}'], contentType: 'text/html' },
    },
    {
      name: 'fetch-network-error',
      spec: { fetchThrows: new TypeError('Failed to fetch') },
    },
  ]

  for (const { spec, options = {} } of scenarios) {
    const promiseRun = await runScenario(CortanaHttpClient, spec, options)
    const effectRun = await runScenario(EffectCortanaHttpClient, spec, options)
    expect(promiseRun.outcome).toEqual(effectRun.outcome)
    expect(promiseRun.log.fetchCalls).toBe(effectRun.log.fetchCalls)
    expect(promiseRun.log.bytesDelivered).toBe(effectRun.log.bytesDelivered)
    expect(promiseRun.log.cancelCalled).toBe(effectRun.log.cancelCalled)
  }
})

test('failure injection: byte accounting is exact where it must be', async () => {
  // 64-byte chunks, 100-byte cap: both must stop after 128 delivered bytes.
  const oversized = { chunks: ['x'.repeat(64), 'x'.repeat(64), 'x'.repeat(64), 'x'.repeat(64)] }
  const promiseRun = await runScenario(CortanaHttpClient, oversized, {
    maximumResponseBytes: 100,
  })
  const effectRun = await runScenario(EffectCortanaHttpClient, oversized, {
    maximumResponseBytes: 100,
  })
  expect(promiseRun.outcome.message).toBe('CORTANA_HTTP_OUTPUT_LIMIT')
  expect(effectRun.outcome.message).toBe('CORTANA_HTTP_OUTPUT_LIMIT')
  expect(promiseRun.log.bytesDelivered).toBe(128)
  expect(effectRun.log.bytesDelivered).toBe(128)
  // Real-fetch semantics: both implementations abort their controller during
  // cleanup, which terminates (errors) the body stream — the cancel callback
  // itself only fires when the stream is still readable.
  expect(promiseRun.log.streamTerminated).toBe(true)
  expect(effectRun.log.streamTerminated).toBe(true)
})

test('failure injection: deadline produces ABORTED in both and the cancellation reaches the stubbed fetch', async () => {
  const spec = { chunks: ['{}'], respondAfterMs: 5_000 }
  const deadlineRequest = () => ({
    ...request(),
    deadline: new Date(Date.now() + 40).toISOString(),
  })

  for (const [, Client] of implementations) {
    const { stub, log } = makeStub(spec)
    const originalFetch = globalThis.fetch
    globalThis.fetch = stub
    const client = new Client({
      endpoint: 'http://127.0.0.1:9/read',
      allowLoopbackHttp: true,
    })
    let message
    try {
      await client.read(deadlineRequest(), new AbortController().signal)
    } catch (error) {
      message = error.message
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(message).toBe('CORTANA_HTTP_ABORTED')
    // The Effect runtime's cancellation must propagate into the in-flight fetch.
    expect(log.aborted).toBe(true)
  }
})

test('failure injection: deadline during streaming aborts both with identical byte accounting', async () => {
  // Chunk 1 (16 bytes) is delivered at ~60ms; the 100ms deadline fires while the
  // second chunk read is in flight (chunk 2 would land at ~120ms). Both
  // implementations must report ABORTED, deliver exactly 16 bytes, and
  // terminate the stream.
  const spec = {
    chunks: ['0123456789abcdef', '0123456789abcdef', '0123456789abcdef', '0123456789abcdef'],
    chunkDelayMs: 60,
  }
  const deadlineRequest = () => ({
    ...request(),
    deadline: new Date(Date.now() + 100).toISOString(),
  })

  for (const [, Client] of implementations) {
    const { stub, log } = makeStub(spec)
    const originalFetch = globalThis.fetch
    globalThis.fetch = stub
    const client = new Client({
      endpoint: 'http://127.0.0.1:9/read',
      allowLoopbackHttp: true,
      maximumResponseBytes: 100,
    })
    let message
    try {
      await client.read(deadlineRequest(), new AbortController().signal)
    } catch (error) {
      message = error.message
    } finally {
      globalThis.fetch = originalFetch
    }
    await Bun.sleep(20)
    expect(message).toBe('CORTANA_HTTP_ABORTED')
    expect(log.bytesDelivered).toBe(16)
    expect(log.streamTerminated).toBe(true)
  }
})
