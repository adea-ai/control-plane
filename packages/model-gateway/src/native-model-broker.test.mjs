import { expect, test } from 'bun:test'
import { NativeModelBroker } from './native-model-broker.ts'

const template = {
  modelCallId: 'mdc_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  principalRef: 'service:runtime',
  alias: 'reasoning.standard',
  messages: [{ role: 'user', content: 'template' }],
  settings: { maxOutputTokens: 20, temperature: 0.2, timeoutMs: 100 },
  requirement: {
    alias: 'reasoning.standard',
    requiredCapabilities: ['text_generation'],
    providerPolicy: { allowedClasses: ['managed'], deniedProviders: [], dataResidency: ['us'] },
    fallback: 'same_alias',
  },
  policySnapshot: { policyId: 'workspace', version: 1, digest: `sha256:${'a'.repeat(64)}` },
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  fundingSource: 'hq_managed',
  routing: { entitlements: [], maxCostClass: 'standard', estimatedInputTokens: 1 },
}
const capability = 'c0ffee91'.repeat(8)
const body = {
  model: template.alias,
  stream: false,
  max_tokens: 12,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'native prompt' }] }],
}
const http = (data = body, token = capability) =>
  new Request('http://127.0.0.1/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  })
function fixture() {
  const calls = []
  const cancellations = []
  const gateway = {
    async complete(input) {
      calls.push(input)
      return {
        content: 'native result',
        finishReason: 'stop',
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          cachedInputTokens: 1,
          reasoningTokens: 1,
          totalTokens: 5,
        },
      }
    },
    async *stream(input) {
      calls.push(input)
      yield { delta: 'native result', sequence: 0 }
      yield {
        delta: '',
        sequence: 1,
        finishReason: 'stop',
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          cachedInputTokens: 1,
          reasoningTokens: 1,
        },
      }
    },
    async cancel(id) {
      cancellations.push(id)
      return true
    },
  }
  return { broker: new NativeModelBroker({ gateway, template, capability }), calls, cancellations }
}
test.each([false, true])(
  'lost settled native response cannot dispatch a retry: stream=%s',
  async (stream) => {
    const { broker, calls } = fixture()
    try {
      const response = await broker.fetch(http({ ...body, stream }))
      if (stream) await response.text()
      else await response.body.cancel()
      expect((await broker.fetch(http({ ...body, stream }))).status).toBe(409)
      expect(calls).toHaveLength(1)
    } finally {
      await broker.close()
    }
  }
)
test('recreated brokers derive the same ledger identity for an identical attempt request', async () => {
  const first = fixture()
  const second = fixture()
  try {
    await first.broker.fetch(http())
    await second.broker.fetch(http())
    expect(first.calls[0].modelCallId).toBe(second.calls[0].modelCallId)
    expect(first.calls[0].requestId).toBe(second.calls[0].requestId)
  } finally {
    await first.broker.close()
    await second.broker.close()
  }
})
test('native requests carry only data; broker owns scope, alias and each send identity', async () => {
  const { broker, calls } = fixture()
  for (let n = 0; n < 2; n++) {
    const response = await broker.fetch(
      http({
        ...body,
        messages: [{ role: 'user', content: n === 0 ? 'native prompt' : 'next native prompt' }],
        workspaceId: 'forged',
        credentialRef: 'forged',
        fundingSource: 'external_subscription',
        traceId: 'forged',
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      model: template.alias,
      choices: [{ message: { role: 'assistant', content: 'native result' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
  }
  expect(calls).toHaveLength(2)
  expect(calls[0]).toMatchObject({
    workspaceId: template.workspaceId,
    executionId: template.executionId,
    attemptId: template.attemptId,
    fundingSource: 'hq_managed',
    traceId: template.traceId,
    settings: { ...template.settings, maxOutputTokens: 12 },
    messages: [{ role: 'user', content: 'native prompt' }],
  })
  expect(calls[0].modelCallId).not.toBe(calls[1].modelCallId)
  expect(JSON.stringify(calls)).not.toContain(capability)
  await broker.close()
  expect((await broker.fetch(http())).status).toBe(401)
})
test('broker rejects missing capability, upstream route selection and excessive native output', async () => {
  const { broker, calls } = fixture()
  expect((await broker.fetch(http(body, 'wrong'))).status).toBe(401)
  expect((await broker.fetch(http({ ...body, model: 'upstream-provider-model' }))).status).toBe(400)
  expect((await broker.fetch(http({ ...body, max_tokens: 21 }))).status).toBe(400)
  expect((await broker.fetch(http({ ...body, tools: [{ type: 'function' }] }))).status).toBe(400)
  expect(calls).toHaveLength(0)
  await broker.close()
})
test('native streaming returns standard data frames and trusted usage with no upstream credentials', async () => {
  const { broker, calls } = fixture()
  const response = await broker.fetch(http({ ...body, stream: true }))
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const text = await response.text()
  expect(text).toContain('native result')
  expect(text).toContain('"prompt_tokens":3')
  expect(text).toContain('data: [DONE]')
  expect(text).not.toContain(capability)
  expect(calls).toHaveLength(1)
  await broker.close()
})
test('broker applies a bounded native temperature instead of silently discarding it', async () => {
  const { broker, calls } = fixture()
  expect((await broker.fetch(http({ ...body, temperature: 1 }))).status).toBe(200)
  expect(calls[0].settings.temperature).toBe(1)
  expect((await broker.fetch(http({ ...body, temperature: 3 }))).status).toBe(400)
  expect(calls).toHaveLength(1)
  await broker.close()
})
