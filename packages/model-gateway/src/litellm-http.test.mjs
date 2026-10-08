import { describe, expect, test } from 'bun:test'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { LedgerLiteLlmHttpClient } from './litellm-http.ts'
import { LiteLlmAdapter, ManagedModelGateway, ModelRouteRegistry } from './index.ts'
import { NativeModelBroker } from './native-model-broker.ts'

const now = '2026-10-08T01:00:00.000Z'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const deployment = {
  deploymentId: 'managed.reasoning.us',
  alias: 'reasoning.standard',
  provider: 'openai',
  providerModel: 'gpt-5',
  providerClass: 'managed',
  dataResidency: 'us',
  capabilities: ['text_generation'],
  credentialRef: 'lease://model/openai',
  adapterRef: 'litellm-primary',
  enabled: true,
  fundingSource: 'hq_managed',
  maxContextTokens: 100,
  maxOutputTokens: 20,
  costClass: 'standard',
  priority: 1,
  requiredEntitlements: [],
}
const request = {
  modelCallId: 'mdc_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  workspaceId,
  executionId,
  attemptId,
  principalRef: 'service:runtime',
  alias: deployment.alias,
  messages: [{ role: 'user', content: 'Hello' }],
  settings: { maxOutputTokens: 20, temperature: 0, timeoutMs: 200 },
  requirement: {
    alias: deployment.alias,
    requiredCapabilities: ['text_generation'],
    providerPolicy: { allowedClasses: ['managed'], deniedProviders: [], dataResidency: ['us'] },
    fallback: 'same_alias',
  },
  policySnapshot: {
    policyId: 'workspace-standard',
    version: 1,
    digest: `sha256:${'a'.repeat(64)}`,
  },
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  fundingSource: 'hq_managed',
  routing: { entitlements: [], maxCostClass: 'standard', estimatedInputTokens: 1 },
}
const input = (overrides = {}) => ({
  model: deployment.providerModel,
  messages: request.messages,
  maxTokens: 20,
  temperature: 0,
  timeoutMs: 200,
  traceId: request.traceId,
  credentialRef: deployment.credentialRef,
  context: { request, deployment },
  ...overrides,
})
const response = (overrides = {}) =>
  new Response(
    JSON.stringify({
      id: 'provider-1',
      model: 'gpt-5',
      choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
      ...overrides,
    }),
    { headers: { 'content-type': 'application/json' } }
  )

// Serial atomic draft/commit store; accounting and replay rules remain the real ledger's.
class Store {
  state = { budgets: new Map(), effects: new Map(), entries: [] }
  tail = Promise.resolve()
  fail = false
  async transaction(_workspace, operation) {
    const prior = this.tail
    let release
    this.tail = new Promise((resolve) => {
      release = resolve
    })
    await prior
    const draft = structuredClone(this.state)
    try {
      const result = await operation({
        getBudget: async (id) => structuredClone(draft.budgets.get(id)),
        putBudget: async (value) => {
          draft.budgets.set(value.executionId, structuredClone(value))
        },
        getEffect: async (id) => structuredClone(draft.effects.get(id)),
        putEffect: async (value) => {
          draft.effects.set(value.idempotencyKey, structuredClone(value))
        },
        appendEntry: async (value) => {
          if (this.fail) {
            this.fail = false
            throw new Error('STORE_UNAVAILABLE')
          }
          draft.entries.push(structuredClone(value))
        },
        listEntries: async (id) => draft.entries.filter((e) => e.executionId === id),
      })
      this.state = draft
      return result
    } finally {
      release()
    }
  }
}

async function fixture(fetch, overrides = {}) {
  const store = new Store()
  const ledger = new DurableUsageLedger({ store, now: () => now })
  const scope = { workspaceId, executionId }
  await ledger.openBudget({
    ...scope,
    currency: 'USD',
    maximumMicrounits: 1000,
    maximumTokens: 1000,
    source: { sourceId: 'open', idempotencyKey: 'open' },
  })
  await ledger.reserve({
    ...scope,
    attemptId,
    reservationKey: `runtime-attempt:${attemptId}`,
    maximumMicrounits: 1000,
    maximumTokens: 1000,
    source: { sourceId: 'reserve', idempotencyKey: 'reserve' },
  })
  const grant = {
    schemaVersion: 1,
    authorizationId: 'operator-spend-1',
    evidenceRef: 'operator://approved-spend/1',
    workspaceId,
    executionId,
    attemptId,
    deploymentId: deployment.deploymentId,
    credentialRef: deployment.credentialRef,
    currency: 'USD',
    fundingSource: 'hq_managed',
    principalRef: request.principalRef,
    alias: request.alias,
    policySnapshotDigest: request.policySnapshot.digest,
    maximumMicrounits: 1000,
    maximumTokens: 1000,
    issuedAt: '2026-10-08T00:00:00.000Z',
    expiresAt: '2026-10-08T02:00:00.000Z',
    ...overrides,
  }
  const price = {
    schemaVersion: 1,
    deploymentId: deployment.deploymentId,
    provider: deployment.provider,
    model: deployment.providerModel,
    version: 'operator-price-1',
    currency: 'USD',
    fundingSource: grant.fundingSource,
    validFrom: grant.issuedAt,
    validUntil: grant.expiresAt,
    maximumInputTokens: 100,
    maximumOutputTokens: 20,
    ratesMicrounitsPerMillionTokens: { input: 1_000_000, cachedInput: 500_000, output: 2_000_000 },
  }
  let closes = 0
  const authority = {
    async authorize() {
      return {
        grant,
        price,
        endpoint: 'https://litellm.example/v1/chat/completions',
        proxyModelId: 'deployment-1',
        credential: {
          value: new TextEncoder().encode('server-secret'),
          close: async () => {
            closes++
          },
        },
        assertActive: async () => {},
      }
    },
  }
  const client = new LedgerLiteLlmHttpClient({ ledger, authority, fetch, now: () => now })
  return { client, ledger, store, grant, price, authority, closes: () => closes }
}

describe('ledger LiteLLM physical HTTP sends', () => {
  test.each(['disconnect', 'shutdown', 'timeout'])(
    'native %s aborts an active physical stream and retains its hold',
    async (action) => {
      const providerBody = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
            )
          )
        },
      })
      const f = await fixture(
        async () => new Response(providerBody, { headers: { 'content-type': 'text/event-stream' } })
      )
      const registry = new ModelRouteRegistry()
      registry.register(deployment)
      const gateway = new ManagedModelGateway({
        registry,
        adapters: new Map([['litellm-primary', new LiteLlmAdapter({ client: f.client })]]),
        decisionPoint: {
          authorize: async (p) => ({
            effect: 'allow',
            decisionId: `sha256:${'b'.repeat(64)}`,
            reasonCode: 'CEDAR_PERMIT',
            policySnapshot: p.policySnapshot,
            evaluatedAt: now,
          }),
        },
      })
      const capability = 'c0ffee91'.repeat(8)
      const broker = new NativeModelBroker({
        gateway,
        capability,
        template: {
          ...request,
          settings: { ...request.settings, timeoutMs: action === 'timeout' ? 80 : 200 },
        },
      })
      const connection = new AbortController()
      const keepAlive = setTimeout(() => {}, 300)
      try {
        const result = await broker.fetch(
          new Request('http://127.0.0.1/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${capability}` },
            signal: connection.signal,
            body: JSON.stringify({
              model: request.alias,
              stream: true,
              messages: [{ role: 'user', content: 'Hello' }],
            }),
          })
        )
        const reader = result.body.getReader()
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('partial')
        if (action === 'disconnect') connection.abort()
        if (action === 'shutdown') await broker.close()
        await expect(reader.read()).rejects.toThrow('MODEL_BROKER_REQUEST_FAILED')
        reader.releaseLock()
        expect(f.closes()).toBe(1)
        await expect(
          f.ledger.settle({
            workspaceId,
            executionId,
            reservationKey: `runtime-attempt:${attemptId}`,
            source: { sourceId: 'finish', idempotencyKey: 'finish' },
          })
        ).rejects.toMatchObject({ code: 'SETTLEMENT_INCOMPLETE' })
      } finally {
        clearTimeout(keepAlive)
        await broker.close()
      }
    }
  )
  test('distinct native requests get separate holds while identical retries cannot bill again', async () => {
    let f
    let sends = 0
    f = await fixture(async () => {
      sends++
      expect((await f.ledger.entries(workspaceId, executionId)).at(-1)).toMatchObject({
        kind: 'model_reservation',
        costMicrounits: 124,
        reservedTokens: 112,
      })
      return response()
    })
    const registry = new ModelRouteRegistry()
    registry.register(deployment)
    const gateway = new ManagedModelGateway({
      registry,
      adapters: new Map([['litellm-primary', new LiteLlmAdapter({ client: f.client })]]),
      decisionPoint: {
        authorize: async (p) => ({
          effect: 'allow',
          decisionId: `sha256:${'b'.repeat(64)}`,
          reasonCode: 'CEDAR_PERMIT',
          policySnapshot: p.policySnapshot,
          evaluatedAt: now,
        }),
      },
    })
    const capability = 'c0ffee91'.repeat(8)
    const broker = new NativeModelBroker({ gateway, template: request, capability })
    try {
      for (let n = 0; n < 2; n++) {
        const inbound = new Request('http://127.0.0.1/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${capability}` },
          body: JSON.stringify({
            model: request.alias,
            max_tokens: 12,
            stream: false,
            messages: [{ role: 'user', content: `Hello ${n}` }],
            fundingSource: 'external_subscription',
            workspaceId: 'forged',
            credentialRef: 'upstream-secret',
          }),
        })
        const result = await broker.fetch(inbound.clone())
        expect(result.status).toBe(200)
        expect(JSON.stringify(await result.json())).not.toContain('server-secret')
        expect((await broker.fetch(inbound)).status).toBe(409)
      }
      const entries = await f.ledger.entries(workspaceId, executionId)
      const holds = entries.filter((e) => e.kind === 'model_reservation')
      expect(holds).toHaveLength(2)
      expect(holds[0].modelCallId).not.toBe(holds[1].modelCallId)
      expect(entries.filter((e) => e.kind === 'model_usage').map((e) => e.costMicrounits)).toEqual([
        19, 19,
      ])
      expect(sends).toBe(2)
      expect(f.closes()).toBe(2)
    } finally {
      await broker.close()
    }
  })
  test('commits conservative hold before sending and prices known usage exactly once', async () => {
    let f
    const sends = []
    f = await fixture(async (url, options) => {
      const entries = await f.ledger.entries(workspaceId, executionId)
      expect(entries.at(-1)).toMatchObject({
        kind: 'model_reservation',
        costMicrounits: 140,
        reservedTokens: 120,
      })
      sends.push({ url, options })
      return response()
    })
    expect(await f.client.complete(input())).toMatchObject({
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    })
    const entries = await f.ledger.entries(workspaceId, executionId)
    expect(entries.filter((e) => e.kind === 'model_usage')).toHaveLength(1)
    expect(entries.find((e) => e.kind === 'model_usage')).toMatchObject({
      costMicrounits: 19,
      quantity: { value: 16 },
    })
    expect(sends).toHaveLength(1)
    expect(sends[0].options.redirect).toBe('error')
    expect(sends[0].options.headers['x-litellm-num-retries']).toBe('0')
    expect(JSON.parse(sends[0].options.body)).toMatchObject({
      model: 'deployment-1',
      disable_fallbacks: true,
    })
    expect(JSON.stringify(entries)).not.toContain('server-secret')
    expect(f.closes()).toBe(1)
    await expect(f.client.complete(input())).rejects.toThrow(
      'MODEL_REQUEST_DISPATCH_ALREADY_ADMITTED'
    )
    expect(sends).toHaveLength(1)
  })
  test.each([
    { workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' },
    { evidenceRef: undefined },
    { expiresAt: now },
    { maximumMicrounits: 139 },
    { maximumTokens: 119 },
    { credentialRef: 'lease://model/other' },
    { fundingSource: 'external_subscription' },
  ])('does not send without matching current recorded spending authority: %j', async (override) => {
    let sends = 0
    const f = await fixture(async () => {
      sends++
      return response()
    }, override)
    await expect(f.client.complete(input())).rejects.toThrow()
    expect(sends).toBe(0)
    expect(
      (await f.ledger.entries(workspaceId, executionId)).filter(
        (e) => e.kind === 'model_reservation'
      )
    ).toHaveLength(0)
    expect(f.closes()).toBe(1)
  })
  test('bounds a stalled authorization and closes a lease that arrives after abort', async () => {
    let sends = 0
    const f = await fixture(async () => {
      sends++
      return response()
    })
    const authorize = f.authority.authorize
    let resolve
    f.authority.authorize = () =>
      new Promise((r) => {
        resolve = r
      })
    const bounded = { ...request, settings: { ...request.settings, timeoutMs: 10 } }
    const pending = f.client.complete(
      input({ timeoutMs: 10, context: { request: bounded, deployment } })
    )
    const keepAlive = setTimeout(() => {}, 100)
    try {
      await expect(
        Promise.race([
          pending,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('UNBOUNDED_AUTHORIZATION')), 60)
          ),
        ])
      ).rejects.not.toThrow('UNBOUNDED_AUTHORIZATION')
      resolve(await authorize())
      await new Promise((r) => setTimeout(r, 1))
      expect(f.closes()).toBe(1)
      expect(sends).toBe(0)
    } finally {
      clearTimeout(keepAlive)
    }
  })
  test('does not send after a failed atomic hold write', async () => {
    let sends = 0
    const f = await fixture(async () => {
      sends++
      return response()
    })
    f.store.fail = true
    await expect(f.client.complete(input())).rejects.toThrow('STORE_UNAVAILABLE')
    expect(sends).toBe(0)
    expect(f.closes()).toBe(1)
  })
  test.each([
    async () => {
      throw new Error('server-secret network outcome unknown')
    },
    async () => new Response('server-secret', { status: 503 }),
    async () => response({ usage: undefined }),
    async () => response({ usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 99 } }),
    async () =>
      response({ usage: { prompt_tokens: 101, completion_tokens: 4, total_tokens: 105 } }),
    async () =>
      response({
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
          prompt_tokens_details: { cached_tokens: 13 },
        },
      }),
  ])('keeps ambiguous sends unresolved and blocks attempt settlement', async (fetch) => {
    const f = await fixture(fetch)
    let error
    try {
      await f.client.complete(input())
    } catch (value) {
      error = value
    }
    expect(error).toMatchObject({ providerCode: 'MODEL_HTTP_OUTCOME_UNKNOWN', retryable: false })
    expect(String(error)).not.toContain('server-secret')
    await expect(
      f.ledger.settle({
        workspaceId,
        executionId,
        reservationKey: `runtime-attempt:${attemptId}`,
        source: { sourceId: 'finish', idempotencyKey: 'finish' },
      })
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INCOMPLETE' })
    expect(f.closes()).toBe(1)
  })
  test('coalesces neither concurrent sends nor replays across client instances', async () => {
    let sends = 0
    const f = await fixture(async () => {
      sends++
      return response()
    })
    const second = new LedgerLiteLlmHttpClient({
      ledger: f.ledger,
      authority: f.authority,
      fetch: async () => {
        sends++
        return response()
      },
      now: () => now,
    })
    const results = await Promise.allSettled([f.client.complete(input()), second.complete(input())])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(sends).toBe(1)
  })
  test('requires authority over the complete immutable attempt allocation, not just one request', async () => {
    let sends = 0
    const f = await fixture(
      async () => {
        sends++
        return response()
      },
      { maximumMicrounits: 120 }
    )
    await expect(f.client.complete(input())).rejects.toThrow('MODEL_HTTP_AUTHORIZATION_DENIED')
    expect(sends).toBe(0)
  })
  test('refuses an input price ceiling below the configured full model context', async () => {
    let sends = 0
    const f = await fixture(async () => {
      sends++
      return response()
    })
    f.price.maximumInputTokens = 80
    await expect(f.client.complete(input())).rejects.toThrow('MODEL_HTTP_AUTHORIZATION_DENIED')
    expect(sends).toBe(0)
  })
  test('refuses replay of one logical request after server routing changes', async () => {
    let sends = 0
    const f = await fixture(async () => {
      sends++
      return response()
    })
    await f.client.complete(input())
    const other = { ...deployment, deploymentId: 'managed.reasoning.other' }
    f.grant.deploymentId = other.deploymentId
    f.price.deploymentId = other.deploymentId
    await expect(
      f.client.complete(input({ context: { request, deployment: other } }))
    ).rejects.toThrow()
    expect(sends).toBe(1)
  })
  test('releases a known pre-send denial without issuing a request', async () => {
    let sends = 0
    const f = await fixture(async () => {
      sends++
      return response()
    })
    const authorize = f.authority.authorize
    f.authority.authorize = async () => ({
      ...(await authorize()),
      assertActive: async () => {
        throw new Error('REVOKED')
      },
    })
    await expect(f.client.complete(input())).rejects.toMatchObject({
      providerCode: 'MODEL_HTTP_SEND_DENIED',
      retryable: false,
    })
    expect(sends).toBe(0)
    await expect(
      f.ledger.settle({
        workspaceId,
        executionId,
        reservationKey: `runtime-attempt:${attemptId}`,
        source: { sourceId: 'finish', idempotencyKey: 'finish' },
      })
    ).resolves.toMatchObject({ releasedMicrounits: 1000 })
  })
  test('keeps unresolved HTTP stream failures nonretryable through the gateway', async () => {
    const f = await fixture(
      async () =>
        new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    )
    const registry = new ModelRouteRegistry()
    registry.register(deployment)
    const gateway = new ManagedModelGateway({
      registry,
      adapters: new Map([['litellm-primary', new LiteLlmAdapter({ client: f.client })]]),
      decisionPoint: {
        authorize: async (p) => ({
          effect: 'allow',
          decisionId: `sha256:${'b'.repeat(64)}`,
          reasonCode: 'CEDAR_PERMIT',
          policySnapshot: p.policySnapshot,
          evaluatedAt: now,
        }),
      },
    })
    await expect(
      (async () => {
        for await (const _ of gateway.stream(request)) {
          /* consume */
        }
      })()
    ).rejects.toMatchObject({ code: 'STREAM_FAILED', retryable: false })
  })
  test('bounds an unacknowledged ledger admission without sending afterward', async () => {
    let sends = 0
    const f = await fixture(async () => {
      sends++
      return response()
    })
    const reserve = f.ledger.reserveModelRequestForDispatch.bind(f.ledger)
    let resolve
    f.ledger.reserveModelRequestForDispatch = () =>
      new Promise((r) => {
        resolve = r
      })
    const bounded = { ...request, settings: { ...request.settings, timeoutMs: 10 } }
    const pending = f.client.complete(
      input({ timeoutMs: 10, context: { request: bounded, deployment } })
    )
    const keepAlive = setTimeout(() => {}, 100)
    let error
    try {
      try {
        await Promise.race([
          pending,
          new Promise((_, reject) => setTimeout(() => reject(new Error('UNBOUNDED_LEDGER')), 60)),
        ])
      } catch (e) {
        error = e
      }
      expect(error?.message).not.toBe('UNBOUNDED_LEDGER')
      expect(error).toBeDefined()
      resolve(undefined)
      await new Promise((r) => setTimeout(r, 1))
      expect(sends).toBe(0)
      expect(f.closes()).toBe(1)
    } finally {
      clearTimeout(keepAlive)
      f.ledger.reserveModelRequestForDispatch = reserve
    }
  })
  test('waits for stream usage after finish and settles before publishing terminal output', async () => {
    const frames =
      [
        { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
      ]
        .map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`)
        .join('') + 'data: [DONE]\r\n\r\n'
    const f = await fixture(
      async () => new Response(frames, { headers: { 'content-type': 'text/event-stream' } })
    )
    const chunks = []
    for await (const chunk of f.client.stream(input())) {
      if (chunk.finish_reason)
        expect((await f.ledger.entries(workspaceId, executionId)).at(-1).kind).toBe('model_release')
      chunks.push(chunk)
    }
    expect(chunks).toEqual([
      { delta: 'Hello' },
      {
        delta: '',
        finish_reason: 'stop',
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      },
    ])
    expect(f.closes()).toBe(1)
  })
  test.each([
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: [DONE]\n\ndata: {"choices":[]}\n\n',
  ])('retains unknown or truncated stream holds', async (frames) => {
    const f = await fixture(
      async () => new Response(frames, { headers: { 'content-type': 'text/event-stream' } })
    )
    await expect(
      (async () => {
        for await (const _ of f.client.stream(input())) {
          /* consume */
        }
      })()
    ).rejects.toMatchObject({ providerCode: 'MODEL_HTTP_OUTCOME_UNKNOWN', retryable: false })
    expect(
      (await f.ledger.entries(workspaceId, executionId)).filter((e) => e.kind === 'model_usage')
    ).toHaveLength(0)
    expect(f.closes()).toBe(1)
  })
})
