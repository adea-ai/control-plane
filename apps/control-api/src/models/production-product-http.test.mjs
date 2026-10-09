import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  createProductionProductHttpReader,
  productionProductHttpRequest,
} from './production-product-http.ts'

const input = {
  schemaVersion: 'pi-lead-intent/v1',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  intentId: randomUUID(),
  principalId: 'svc_agent-hq',
}
const endpoint = 'https://adea.example/api/internal/pi-durable/lead-product/current'
test('HTTP protocol forwards exactly three validated identifiers, never internal or caller authority fields', () => {
  const body = productionProductHttpRequest({
    ...input,
    canonicalActorPrincipalId: 'caller',
    selectionRef: 'caller',
    prompt: 'caller',
  })
  expect(body).toEqual({
    workspaceId: input.workspaceId,
    intentId: input.intentId,
    principalId: input.principalId,
  })
  expect(Object.keys(body)).toHaveLength(3)
  expect(() => productionProductHttpRequest({ ...input, principalId: 'user:caller' })).toThrow()
})
test('configured service credential supplier is required, fresh for each read and never follows redirects', async () => {
  expect(() => createProductionProductHttpReader({ endpoint })).toThrow()
  expect(() =>
    createProductionProductHttpReader({
      endpoint: endpoint.replace('https:', 'http:'),
      credentials: {},
    })
  ).toThrow()
  let credentials = 0,
    sends = 0
  const reader = createProductionProductHttpReader({
    endpoint,
    credentials: {
      getExistingCredential: async (request) => {
        credentials++
        expect(request).toEqual({
          audience: 'adea-lead-product',
          workspaceId: input.workspaceId,
          principalId: input.principalId,
          scope: 'execution:read',
        })
        return 'synthetic.signed.assertion'
      },
    },
    fetch: async (_url, options) => {
      sends++
      expect(JSON.parse(options.body)).toEqual(productionProductHttpRequest(input))
      expect(options.redirect).toBe('error')
      return new Response(null, { status: 404 })
    },
  })
  expect(await reader.readCurrent(input)).toBeUndefined()
  expect(await reader.readCurrent(input)).toBeUndefined()
  expect(credentials).toBe(2)
  expect(sends).toBe(2)
})
test('raw server errors, malformed evidence and oversized responses normalize to a safe denial', async () => {
  for (const response of [
    new Response('private upstream detail', { status: 403 }),
    new Response('{}'),
    new Response('x'.repeat(262_145)),
  ]) {
    const reader = createProductionProductHttpReader({
      endpoint,
      credentials: { getExistingCredential: async () => 'synthetic.signed.assertion' },
      fetch: async () => response,
    })
    await expect(reader.readCurrent(input)).rejects.toThrow('PI_PRODUCT_READER_UNAVAILABLE')
  }
})
test('credential acquisition is inside the unchanged five-second deadline and cannot send afterward', async () => {
  let sends = 0,
    signal
  const reader = createProductionProductHttpReader({
    endpoint,
    credentials: {
      getExistingCredential: async (_input, cancellation) => {
        signal = cancellation
        return new Promise(() => {})
      },
    },
    fetch: async () => {
      sends++
      throw new Error('UNEXPECTED_SEND')
    },
  })
  await expect(reader.readCurrent(input)).rejects.toThrow('PI_PRODUCT_READER_UNAVAILABLE')
  expect(signal.aborted).toBe(true)
  expect(sends).toBe(0)
}, 10_000)
test('aborted errored response body is unlocked and rejects safely during cleanup', async () => {
  let body
  const reader = createProductionProductHttpReader({
    endpoint,
    credentials: { getExistingCredential: async () => 'synthetic.signed.assertion' },
    fetch: async (_url, options) => {
      body = new ReadableStream({
        start(controller) {
          options.signal.addEventListener(
            'abort',
            () => controller.error(new Error('SYNTHETIC_ABORT')),
            { once: true }
          )
        },
      })
      return new Response(body)
    },
  })
  await expect(reader.readCurrent(input)).rejects.toThrow('PI_PRODUCT_READER_UNAVAILABLE')
  expect(body.locked).toBe(false)
}, 10_000)
