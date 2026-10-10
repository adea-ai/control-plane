import { expect, test } from 'bun:test'
import { createProductionManagementHttpClient } from './production-management-http.ts'

const endpoint = 'https://adea-fixture.invalid/api/internal/pi-durable/management'
const decision = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(32)}`
const call = {
  canonicalRequest: { attemptId: 'att_1', executionId: 'exe_1', toolCallId: 'tlc_1' },
  decision,
  input: { name: 'Renamed' },
  operation: 'project.update',
  targetId: 'prj_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
}

function transport(handler, options = {}) {
  const seen = []
  const client = createProductionManagementHttpClient({
    endpoint,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      seen.push(request)
      return handler(request, init)
    },
    ...options,
  })
  return { client, seen }
}

test('posts the exact canonical call body with the decision bearer and returns the value', async () => {
  const { client, seen } = transport(async () =>
    Response.json({
      operation: 'project.update',
      schemaVersion: 'adea-management-result/v1',
      value: { id: 'prj_01JABCDEF0123456789ABCDEFG', name: 'Renamed' },
    })
  )
  const result = await client.call(call)
  expect(result).toEqual({
    ok: true,
    value: { id: 'prj_01JABCDEF0123456789ABCDEFG', name: 'Renamed' },
  })
  expect(seen).toHaveLength(1)
  expect(seen[0].method).toBe('POST')
  expect(seen[0].url).toBe(endpoint)
  expect(seen[0].headers.get('authorization')).toBe(`Bearer ${decision}`)
  expect(seen[0].headers.get('content-type')).toBe('application/json')
  expect(await seen[0].json()).toEqual({
    canonicalRequest: call.canonicalRequest,
    input: call.input,
    operation: call.operation,
    schemaVersion: 'adea-management-call/v1',
    targetId: call.targetId,
    workspaceId: call.workspaceId,
  })
})

test('maps a canonical refusal to a typed outcome without losing the reason', async () => {
  const { client } = transport(
    async () =>
      new Response(
        JSON.stringify({
          code: 'LEAD_MANAGEMENT_REFUSED',
          operation: 'project.update',
          reason: 'authority_replay',
        }),
        { status: 403 }
      )
  )
  expect(await client.call(call)).toEqual({
    code: 'LEAD_MANAGEMENT_REFUSED',
    ok: false,
    operation: 'project.update',
    reason: 'authority_replay',
  })
})

test('fails closed on mismatched, malformed, oversized or unexpected responses', async () => {
  const cases = [
    async () =>
      Response.json({
        operation: 'project.delete',
        schemaVersion: 'adea-management-result/v1',
        value: null,
      }),
    async () => new Response('{"operation":', { status: 200 }),
    async () =>
      Response.json({
        code: 'LEAD_MANAGEMENT_REFUSED',
        operation: 'project.delete',
      }),
    async () =>
      new Response(
        JSON.stringify({
          operation: 'project.update',
          schemaVersion: 'adea-management-result/v1',
          value: 'x'.repeat(300_000),
        }),
        { status: 200 }
      ),
    async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }),
    async () => new Response(null, { status: 500 }),
    async () => new Response(null, { status: 404 }),
  ]
  for (const handler of cases) {
    const { client } = transport(handler)
    await expect(client.call(call)).rejects.toThrow('PI_MANAGEMENT_CALL_UNAVAILABLE')
  }
})

test('rejects configuration and unhashable requests before any send', async () => {
  const invalidEndpoints = [
    'http://adea-fixture.invalid/api/internal/pi-durable/management',
    'https://adea-fixture.invalid/api/internal/pi-durable/management/',
    'https://adea-fixture.invalid/api/internal/pi-durable/other',
    'https://user:pass@adea-fixture.invalid/api/internal/pi-durable/management',
    'https://adea-fixture.invalid/api/internal/pi-durable/management?x=1',
  ]
  for (const invalidEndpoint of invalidEndpoints) {
    expect(() => createProductionManagementHttpClient({ endpoint: invalidEndpoint })).toThrow(
      'PI_MANAGEMENT_CALL_UNAVAILABLE'
    )
  }
  const { client, seen } = transport(async () => {
    throw new Error('TEST_UNEXPECTED_SEND')
  })
  const invalidCalls = [
    { ...call, canonicalRequest: undefined },
    { ...call, canonicalRequest: { value: Number.NaN } },
    { ...call, decision: 'not-a-jwt' },
    { ...call, decision: `a.${'b'.repeat(9_000)}.c` },
    { ...call, input: { fn: undefined } },
    { ...call, operation: '' },
    { ...call, workspaceId: 'nope' },
    { ...call, extra: true },
  ]
  for (const invalid of invalidCalls) {
    await expect(client.call(invalid)).rejects.toThrow('PI_MANAGEMENT_CALL_UNAVAILABLE')
  }
  expect(seen).toHaveLength(0)
})

test('aborts a stalled call within the configured timeout', async () => {
  const { client } = transport(
    (_request, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    { timeoutMs: 100 }
  )
  await expect(client.call(call)).rejects.toThrow('PI_MANAGEMENT_CALL_UNAVAILABLE')
})
