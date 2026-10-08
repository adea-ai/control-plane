import { describe, expect, test } from 'bun:test'
import {
  FakeModelAdapter,
  LiteLlmAdapter,
  ManagedModelGateway,
  ModelGatewayError,
  ModelRouteRegistry,
} from './index.ts'

const ids = {
  call: 'mdc_01JABCDEF0123456789ABCDEFG',
  request: 'req_01JABCDEF0123456789ABCDEFG',
  execution: 'exe_01JABCDEF0123456789ABCDEFG',
  attempt: 'att_01JABCDEF0123456789ABCDEFG',
  workspace: 'wsp_01JABCDEF0123456789ABCDEFG',
  trace: 'trc_01JABCDEF0123456789ABCDEFG',
}
const snapshot = { policyId: 'workspace-standard', version: 1, digest: `sha256:${'a'.repeat(64)}` }
const requirement = {
  alias: 'reasoning.standard',
  requiredCapabilities: ['text_generation', 'reasoning'],
  providerPolicy: { allowedClasses: ['managed'], deniedProviders: [], dataResidency: ['us'] },
  fallback: 'same_alias',
}
const deployment = {
  deploymentId: 'managed.reasoning.us',
  alias: 'reasoning.standard',
  provider: 'openai',
  providerModel: 'gpt-5',
  providerClass: 'managed',
  dataResidency: 'us',
  capabilities: ['text_generation', 'reasoning', 'structured_output'],
  credentialRef: 'lease://model/openai',
  adapterRef: 'litellm-primary',
  enabled: true,
  fundingSource: 'hq_managed',
  maxContextTokens: 128_000,
  maxOutputTokens: 16_384,
  costClass: 'premium',
  priority: 10,
  requiredEntitlements: ['models.managed'],
}
const request = (overrides = {}) => ({
  modelCallId: ids.call,
  requestId: ids.request,
  executionId: ids.execution,
  attemptId: ids.attempt,
  workspaceId: ids.workspace,
  principalRef: 'service:runtime-worker',
  alias: 'reasoning.standard',
  messages: [{ role: 'user', content: 'Summarize this.' }],
  settings: { maxOutputTokens: 256, temperature: 0.2, timeoutMs: 5_000 },
  requirement,
  policySnapshot: snapshot,
  traceId: ids.trace,
  fundingSource: 'hq_managed',
  routing: {
    entitlements: ['models.managed'],
    maxCostClass: 'premium',
    estimatedInputTokens: 128,
  },
  ...overrides,
})
const allowPdp = {
  requests: [],
  async authorize(input) {
    this.requests.push(input)
    return {
      effect: 'allow',
      decisionId: `sha256:${'b'.repeat(64)}`,
      reasonCode: 'CEDAR_PERMIT',
      policySnapshot: input.policySnapshot,
      evaluatedAt: input.context.requestedAt,
    }
  },
}

async function fixture(adapter = new FakeModelAdapter(), deploymentOverrides = {}) {
  const registry = new ModelRouteRegistry()
  registry.register({ ...deployment, ...deploymentOverrides })
  adapter.completion = {
    content: 'A summary.',
    finishReason: 'stop',
    usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 2, reasoningTokens: 1 },
    providerRequestId: 'provider-request-1',
    latencyMs: 42,
  }
  const gateway = new ManagedModelGateway({
    registry,
    adapters: new Map([['litellm-primary', adapter]]),
    decisionPoint: allowPdp,
    now: () => '2026-08-25T09:00:00.000Z',
  })
  return { gateway, registry, adapter }
}

describe('managed model gateway', () => {
  test('resolves a logical alias through plan and policy constraints with normalized usage', async () => {
    const { gateway, adapter } = await fixture()
    const result = await gateway.complete(request())
    expect(result).toMatchObject({
      modelCallId: ids.call,
      alias: 'reasoning.standard',
      content: 'A summary.',
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
        cachedInputTokens: 2,
        reasoningTokens: 1,
      },
      provider: { name: 'openai', model: 'gpt-5', requestId: 'provider-request-1' },
      fundingSource: 'hq_managed',
      policySnapshot: snapshot,
    })
    expect(adapter.requests).toHaveLength(1)
    expect(allowPdp.requests.at(-1)).toMatchObject({
      action: 'model:invoke',
      resource: { type: 'model' },
      policySnapshot: snapshot,
    })
    expect(JSON.stringify({ request: adapter.requests[0].request, result })).not.toContain(
      'lease://model/openai'
    )
  })

  test('keeps a server-side credential canary out of model context', async () => {
    const secretCanary = 'secret-canary-model-context-9f4a'
    const calls = []
    const client = {
      async complete(input) {
        calls.push(input)
        return {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          id: 'litellm-1',
          response_ms: 12,
        }
      },
      async health() {
        return { healthy: true, checkedAt: '2026-08-25T09:00:00.000Z' }
      },
      async cancel() {
        return true
      },
    }
    const adapter = new LiteLlmAdapter({ client })
    const credentialRef = `lease://model/${secretCanary}`
    const { gateway } = await fixture(adapter, { credentialRef })
    const result = await gateway.complete(request())
    expect(calls[0]).toMatchObject({ model: 'gpt-5', credentialRef })
    expect(JSON.stringify(calls[0].messages)).not.toContain(secretCanary)
    expect(JSON.stringify(calls[0].messages)).not.toContain(calls[0].credentialRef)
    expect(JSON.stringify(result)).not.toContain('credentialRef')
    expect(JSON.stringify(result)).not.toContain('lease://')
  })

  test('fails closed for unknown aliases and plan/provider/capability constraints', async () => {
    const { gateway, adapter } = await fixture()
    for (const invalid of [
      request({ alias: 'unknown.alias' }),
      request({ requirement: { ...requirement, requiredCapabilities: ['vision_input'] } }),
      request({
        requirement: {
          ...requirement,
          providerPolicy: { ...requirement.providerPolicy, deniedProviders: ['openai'] },
        },
      }),
      request({
        requirement: {
          ...requirement,
          providerPolicy: { ...requirement.providerPolicy, dataResidency: ['eu'] },
        },
      }),
      request({ settings: { maxOutputTokens: 500_000, temperature: 0.2, timeoutMs: 5_000 } }),
    ])
      await expect(gateway.complete(invalid)).rejects.toBeInstanceOf(ModelGatewayError)
    expect(adapter.requests).toHaveLength(0)
  })

  test('supports normalized streaming, health, and cancellation', async () => {
    const adapter = new FakeModelAdapter()
    adapter.streamChunks = [
      { delta: 'A ' },
      { delta: 'summary.', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 2 } },
    ]
    const { gateway } = await fixture(adapter)
    const chunks = []
    for await (const chunk of gateway.stream(request())) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    })
    await expect(gateway.health('litellm-primary')).resolves.toMatchObject({ healthy: true })
    await expect(gateway.cancel(ids.call)).resolves.toBe(true)
  })

  test('keeps a secret canary out of normalized provider errors', async () => {
    const secretCanary = 'secret-canary-provider-error-9f4a'
    const adapter = new FakeModelAdapter()
    adapter.error = new Error(`Authorization: Bearer ${secretCanary} Summarize this.`)
    const { gateway } = await fixture(adapter)
    try {
      await gateway.complete(request())
      throw new Error('EXPECTED_PROVIDER_FAILURE')
    } catch (error) {
      expect(error).toMatchObject({ code: 'PROVIDER_FAILED', message: 'PROVIDER_FAILED' })
      expect(JSON.stringify(error)).not.toContain(secretCanary)
    }
  })

  test('classifies a partial provider stream without retrying or hiding emitted output', async () => {
    const adapter = new FakeModelAdapter()
    let streamAttempts = 0
    adapter.stream = async function* (input, route) {
      this.requests.push({
        request: JSON.parse(JSON.stringify(input)),
        deploymentId: route.deploymentId,
      })
      streamAttempts += 1
      yield { delta: 'partial ' }
    }
    const { gateway } = await fixture(adapter)
    const chunks = []
    let failure

    try {
      for await (const chunk of gateway.stream(request())) chunks.push(chunk)
    } catch (error) {
      failure = error
    }

    expect(chunks).toEqual([
      expect.objectContaining({ sequence: 0, delta: 'partial ', modelCallId: ids.call }),
    ])
    expect(failure).toMatchObject({ code: 'STREAM_FAILED', retryable: true })
    expect(streamAttempts).toBe(1)
  })

  test('routes deterministically and explains only eligible ranked candidates', async () => {
    const { gateway, registry } = await fixture()
    registry.register({
      ...deployment,
      deploymentId: 'managed.reasoning.backup',
      provider: 'anthropic',
      providerModel: 'claude-sonnet',
      credentialRef: 'lease://model/anthropic',
      priority: 20,
    })
    const first = await gateway.complete(request())
    const second = await gateway.complete(
      request({ modelCallId: 'mdc_01JABCDEF0123456789ABCDEFH' })
    )
    expect(first.route).toEqual(second.route)
    expect(first.route).toMatchObject({
      deploymentId: 'managed.reasoning.us',
      routerVersion: 'model-router/v1',
      eligibleCandidateIds: ['managed.reasoning.us', 'managed.reasoning.backup'],
    })
    expect(JSON.stringify(first.route)).not.toContain('lease://')
  })

  test('falls back on transient outage only to an allowed healthy compatible route', async () => {
    const adapter = new FakeModelAdapter()
    const { gateway, registry } = await fixture(adapter)
    registry.register({
      ...deployment,
      deploymentId: 'managed.reasoning.backup',
      provider: 'anthropic',
      providerModel: 'claude-sonnet',
      credentialRef: 'lease://model/anthropic',
      priority: 20,
      costClass: 'standard',
    })
    adapter.errorsByDeployment.set('managed.reasoning.us', {
      code: 'PROVIDER_OVERLOADED',
      retryable: true,
    })
    const result = await gateway.complete(request())
    expect(result.route).toMatchObject({
      deploymentId: 'managed.reasoning.backup',
      fallbackFrom: 'managed.reasoning.us',
    })
    expect(adapter.requests.map((entry) => entry.deploymentId)).toEqual([
      'managed.reasoning.us',
      'managed.reasoning.backup',
    ])

    registry.setHealth('managed.reasoning.backup', 'unhealthy')
    await expect(
      gateway.complete(request({ modelCallId: 'mdc_01JABCDEF0123456789ABCDEFH' }))
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' })
  })

  test('never admits fallback candidates that violate budget, entitlement, or data policy', async () => {
    const adapter = new FakeModelAdapter()
    const { gateway, registry } = await fixture(adapter)
    registry.register({
      ...deployment,
      deploymentId: 'managed.reasoning.eu-premium',
      provider: 'anthropic',
      providerModel: 'claude-opus',
      credentialRef: 'lease://model/anthropic',
      dataResidency: 'eu',
      requiredEntitlements: ['models.enterprise'],
      priority: 20,
    })
    adapter.errorsByDeployment.set('managed.reasoning.us', {
      code: 'PROVIDER_OVERLOADED',
      retryable: true,
    })
    await expect(
      gateway.complete(
        request({
          routing: {
            entitlements: ['models.managed'],
            maxCostClass: 'standard',
            estimatedInputTokens: 128,
          },
        })
      )
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    expect(adapter.requests).toHaveLength(0)
  })
})

test('pinned BYO request never falls back to another account after a retryable provider error', async () => {
  const { selection } = await import('./selection-fixtures.mjs')
  const { ModelProviderError } = await import('./index.ts')
  const registry = new ModelRouteRegistry()
  const first = new FakeModelAdapter()
  first.complete = async () => {
    throw new ModelProviderError('RATE_LIMIT', true)
  }
  const second = new FakeModelAdapter()
  registry.register({
    ...deployment,
    deploymentId: 'byo.one',
    fundingSource: 'byo_api',
    selection,
    credentialRef: `vault://${selection.credentialRef}/1`,
  })
  registry.register({
    ...deployment,
    deploymentId: 'byo.two',
    fundingSource: 'byo_api',
    priority: 20,
    adapterRef: 'second',
    selection: {
      ...selection,
      accountRef: 'other-account',
      connectionRef: `mconn_${'3'.repeat(32)}`,
    },
    credentialRef: `vault://${selection.credentialRef}/1`,
  })
  const gateway = new ManagedModelGateway({
    registry,
    adapters: new Map([
      ['litellm-primary', first],
      ['second', second],
    ]),
    decisionPoint: allowPdp,
    selectionService: { assertReady: async () => {} },
  })
  await expect(
    gateway.complete(request({ fundingSource: 'byo_api', selection }))
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' })
  expect(second.requests).toHaveLength(0)
  await expect(gateway.complete(request({ fundingSource: 'byo_api' }))).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  })
})

test('pinned dispatch denies revoked authority or a deployment that changes model/account/location', async () => {
  const { selection } = await import('./selection-fixtures.mjs')
  for (const delta of [
    { accountRef: 'other' },
    { location: 'agent_hq_cloud' },
    { credentialRevision: 2 },
    { providerModel: 'different' },
  ]) {
    const registry = new ModelRouteRegistry()
    registry.register({
      ...deployment,
      fundingSource: 'byo_api',
      selection: { ...selection, ...delta },
      credentialRef: `vault://${selection.credentialRef}/1`,
    })
    const adapter = new FakeModelAdapter()
    const gateway = new ManagedModelGateway({
      registry,
      adapters: new Map([['litellm-primary', adapter]]),
      decisionPoint: allowPdp,
      selectionService: { assertReady: async () => {} },
    })
    await expect(
      gateway.complete(request({ fundingSource: 'byo_api', selection }))
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    expect(adapter.requests).toHaveLength(0)
  }
  const { registry, adapter } = await fixture()
  const gateway = new ManagedModelGateway({
    registry,
    adapters: new Map([['litellm-primary', adapter]]),
    decisionPoint: allowPdp,
    selectionService: {
      assertReady: async () => {
        throw new Error('revoked-secret-canary')
      },
    },
  })
  await expect(
    gateway.complete(request({ fundingSource: 'byo_api', selection }))
  ).rejects.toMatchObject({ code: 'MODEL_POLICY_DENIED' })
  expect(adapter.requests).toHaveLength(0)
})
