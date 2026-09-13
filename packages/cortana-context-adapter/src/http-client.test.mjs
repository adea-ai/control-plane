import { expect, test } from 'bun:test'
import { CortanaHttpClient } from './http-client.ts'

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

test('HTTP context client uses the fixed endpoint and explicit credentials with operation correlation', () =>
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
      expect(() => new CortanaHttpClient({ endpoint })).toThrow('ENDPOINT_INVALID')
      const client = new CortanaHttpClient({
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

test('HTTP context client does not follow redirects or expose remote error bodies', () => {
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
      const client = new CortanaHttpClient({ endpoint, allowLoopbackHttp: true })
      await expect(client.read(request(), new AbortController().signal)).rejects.toThrow(
        'RESPONSE_FAILED'
      )
      expect(redirected).toBe(0)
    }
  )
})

test('HTTP context client bounds streamed bytes and rejects invalid JSON and content types', async () => {
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
        const client = new CortanaHttpClient({
          endpoint,
          allowLoopbackHttp: true,
          maximumResponseBytes: limit,
        })
        await expect(client.read(request(), new AbortController().signal)).rejects.toThrow(code)
      }
    )
})

test('HTTP context client honors an already aborted caller without sending a request', () => {
  let calls = 0
  return serverTest(
    () => {
      calls++
      return Response.json({})
    },
    async (endpoint) => {
      const client = new CortanaHttpClient({ endpoint, allowLoopbackHttp: true })
      const controller = new AbortController()
      controller.abort()
      await expect(client.read(request(), controller.signal)).rejects.toThrow('ABORTED')
      expect(calls).toBe(0)
    }
  )
})
