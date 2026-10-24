import { expect, test } from 'bun:test'
import fastify from 'fastify'

test('Fastify preserves request log bindings, redaction, serializers and error responses', async () => {
  const lines = []
  const server = fastify({
    logger: {
      level: 'info',
      stream: { write: (line) => lines.push(line) },
      redact: ['secret', 'req.headers.authorization'],
      serializers: {
        req: (request) => ({ method: request.method, url: request.url, headers: request.headers }),
      },
    },
    requestIdHeader: 'x-request-id',
  })
  server.route({
    method: 'GET',
    url: '/logged',
    async handler(request) {
      request.log
        .child({ operation: 'fixture' })
        .info({ secret: 'logging-secret-canary' }, 'handled')
      return { ok: true }
    },
  })
  server.route({
    method: 'GET',
    url: '/failure',
    async handler() {
      throw new Error('controlled request failure')
    },
  })
  try {
    const response = await server.inject({
      method: 'GET',
      url: '/logged',
      headers: {
        'x-request-id': 'request-log-fixture',
        authorization: 'Bearer header-secret-canary',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
    const failed = await server.inject({ method: 'GET', url: '/failure' })
    expect(failed.statusCode).toBe(500)
    expect(failed.json()).toMatchObject({ statusCode: 500, error: 'Internal Server Error' })
    const records = lines.flatMap((line) => line.trim().split('\n').map(JSON.parse))
    expect(records).toContainEqual(
      expect.objectContaining({
        reqId: 'request-log-fixture',
        operation: 'fixture',
        secret: '[Redacted]',
        msg: 'handled',
      })
    )
    expect(records).toContainEqual(
      expect.objectContaining({ reqId: 'request-log-fixture', res: { statusCode: 200 } })
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 50,
        err: expect.objectContaining({ type: 'Error', message: 'controlled request failure' }),
      })
    )
    expect(lines.join('')).not.toContain('logging-secret-canary')
    expect(lines.join('')).not.toContain('header-secret-canary')
  } finally {
    await server.close()
  }
})
