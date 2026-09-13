import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  ContextProviderResolver,
  InMemoryContextContributionCache,
  createFakeContextProvider,
  runContextProviderConformance,
} from './provider.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const scopeDigest = `sha256:${'a'.repeat(64)}`
const now = '2026-08-25T12:00:00.000Z'

describe('optional context provider resolution', () => {
  test('preserves the no-provider execution path when disabled or unconfigured', async () => {
    const disabled = await resolver([]).resolve(request({ mode: 'disabled' }))
    expect(disabled).toEqual({
      status: 'disabled',
      contributions: [],
      pins: [],
      decisionReasons: ['POLICY_DISABLED'],
    })

    const absent = await resolver([]).resolve(request())
    expect(absent).toMatchObject({ status: 'omitted', contributions: [], pins: [] })
  })

  test('selects by scope, policy, location, capability, health, and budget', async () => {
    const wrongScope = fake('A', { scopeDigest: `sha256:${'b'.repeat(64)}` })
    const incapable = fake('B', { capabilities: { evidenceSearch: false } })
    const healthy = fake('C')
    const result = await resolver([wrongScope, incapable, healthy]).resolve(request())

    expect(result.status).toBe('included')
    expect(result.contributions.map((entry) => entry.content)).toEqual(['evidence-C'])
    expect(result.pins[0]).toMatchObject({
      providerId: healthy.readModel.definition.providerId,
      scopeDigest,
      revision: 'revision-C',
      included: true,
    })
    expect(JSON.stringify(result.pins)).not.toContain('evidence-C')
    expect(JSON.stringify(result.pins)).not.toMatch(/credential|secret/i)
  })

  test('never broadens scope and applies pinned failure behavior', async () => {
    const unavailable = fake('A', { health: 'unavailable' })
    await expect(
      resolver([unavailable]).resolve(request({ mode: 'required', failureBehavior: 'fail' }))
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })

    const awaiting = await resolver([unavailable]).resolve(
      request({ mode: 'required', failureBehavior: 'await_input' })
    )
    expect(awaiting.status).toBe('awaiting_input')

    const revoked = fake('B', { state: 'revoked' })
    await expect(
      resolver([revoked]).resolve(request({ mode: 'required', failureBehavior: 'fail' }))
    ).rejects.toMatchObject({ code: 'PROVIDER_REVOKED' })
  })

  test('rejects stale, over-budget, and scope-mismatched output and substitutes deterministically', async () => {
    const stale = fake('A', { expiresAt: '2026-08-25T11:00:00.000Z' })
    const oversized = fake('B', { tokenCount: 101 })
    const substitute = fake('C')
    const result = await resolver([stale, oversized, substitute]).resolve(request())
    expect(result.contributions[0].content).toBe('evidence-C')

    const malicious = fake('D', { outputScopeDigest: `sha256:${'d'.repeat(64)}` })
    await expect(
      resolver([malicious]).resolve(request({ mode: 'required', failureBehavior: 'fail' }))
    ).rejects.toMatchObject({ code: 'PROVIDER_SCOPE_MISMATCH' })
  })

  test('rejects forged digests, token underclaims, and UTF-8 byte overflow before caching', async () => {
    const provider = fake('V')
    const forgedDigest = contribution(provider, {
      content: 'forged-content',
      contentDigest: `sha256:${'f'.repeat(64)}`,
    })
    await expect(
      resolver([forgedDigest]).resolve(
        request({ mode: 'required', failureBehavior: 'fail', maximumTokens: 1_000 })
      )
    ).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' })

    const underclaimedContent = 'x'.repeat(401)
    const underclaimed = contribution(provider, {
      content: underclaimedContent,
      contentDigest: contentDigest(underclaimedContent),
      tokenCount: 0,
    })
    await expect(
      resolver([underclaimed]).resolve(
        request({ mode: 'required', failureBehavior: 'fail', maximumTokens: 100 })
      )
    ).rejects.toMatchObject({ code: 'PROVIDER_BUDGET_EXCEEDED' })
    await expect(
      runContextProviderConformance(underclaimed, request({ maximumTokens: 100 }))
    ).resolves.toMatchObject({ bounded: false })

    const multibyteContent = '💥'.repeat(70_000)
    const byteOverflow = contribution(provider, {
      content: multibyteContent,
      contentDigest: contentDigest(multibyteContent),
      tokenCount: 70_000,
    })
    await expect(
      resolver([byteOverflow]).resolve(
        request({ mode: 'required', failureBehavior: 'fail', maximumTokens: 100_000 })
      )
    ).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' })
  })

  test('revalidates cached contributions and preserves safe token overestimates', async () => {
    const provider = fake('W')
    const content = 'safe-overestimate'
    const safe = contribution(provider, {
      content,
      contentDigest: contentDigest(content),
      tokenCount: 50,
    })
    await expect(resolver([safe]).resolve(request({ maximumTokens: 50 }))).resolves.toMatchObject({
      status: 'included',
    })

    const nativeTokenizerCount = contribution(provider, {
      content: 'hello',
      contentDigest: contentDigest('hello'),
      tokenCount: 1,
    })
    await expect(
      resolver([nativeTokenizerCount]).resolve(request({ maximumTokens: 2 }))
    ).resolves.toMatchObject({ status: 'included', contributions: [{ tokenCount: 2 }] })

    const cache = {
      async get() {
        return contribution(provider, {
          content: 'cached-forgery',
          contentDigest: `sha256:${'e'.repeat(64)}`,
        }).retrieve(request())
      },
      async set() {},
    }
    await expect(
      resolver([provider], { cache }).resolve(
        request({ mode: 'required', failureBehavior: 'fail' })
      )
    ).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' })
  })

  test('normalizes degraded output without making it ProjectState or canonical memory', async () => {
    const degraded = fake('A', { health: 'degraded', degraded: true })
    const result = await resolver([degraded]).resolve(request())
    expect(result.status).toBe('degraded')
    expect(result.contributions[0]).toMatchObject({ kind: 'evidence', degraded: true })
    expect(result).not.toHaveProperty('projectState')
    expect(result).not.toHaveProperty('canonicalMemory')
  })

  test('enforces the provider latency bound', async () => {
    const slow = fake('S', { delayMs: 20 })
    await expect(
      resolver([slow]).resolve(
        request({ mode: 'required', failureBehavior: 'fail', maximumLatencyMs: 1 })
      )
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  })

  test('provides two fake profiles and a reusable conformance harness', async () => {
    const evidence = fake('E')
    const memory = fake('M', {
      capabilities: { evidenceSearch: false, memoryRecall: true },
      kind: 'memory',
    })
    expect(evidence.readModel.definition.providerType).not.toBe(
      memory.readModel.definition.providerType
    )
    expect(await runContextProviderConformance(evidence, request())).toEqual({
      bounded: true,
      deterministic: true,
      scopePreserved: true,
    })
  })

  test('reuses only scope- and policy-bound contribution cache entries', async () => {
    const cache = new InMemoryContextContributionCache()
    const provider = fake('K')
    let retrievals = 0
    const counted = {
      ...provider,
      async retrieve(input) {
        retrievals += 1
        return provider.retrieve(input)
      },
    }
    const selected = resolver([counted], { cache })
    await selected.resolve(request())
    await selected.resolve(request())
    await selected.resolve(request({ maximumTokens: 99 }))
    expect(retrievals).toBe(2)
  })

  test('does not cache drivers without an authoritative cache identity', async () => {
    const provider = fake('K')
    let retrievals = 0
    const selected = resolver(
      [
        {
          readModel: provider.readModel,
          async retrieve(input) {
            retrievals += 1
            return provider.retrieve(input)
          },
        },
      ],
      { cache: new InMemoryContextContributionCache() }
    )
    await selected.resolve(request())
    await selected.resolve(request())
    expect(retrievals).toBe(2)
  })

  test('invalidates cached data when the authoritative revision identity changes', async () => {
    const provider = fake('K')
    let revision = 'one'
    let retrievals = 0
    const selected = resolver(
      [
        {
          ...provider,
          cacheIdentity: () => contentDigest(revision),
          async retrieve(input) {
            retrievals += 1
            return (await provider.retrieve(input)).map((entry) => ({ ...entry, revision }))
          },
        },
      ],
      { cache: new InMemoryContextContributionCache() }
    )
    await selected.resolve(request())
    revision = 'two'
    const result = await selected.resolve(request())
    await selected.resolve(request())
    expect(result.contributions[0].revision).toBe('two')
    expect(retrievals).toBe(2)
  })

  test('does not populate cache when the revision changes during retrieval', async () => {
    const provider = fake('K')
    let revision = 0
    let stores = 0
    const selected = resolver(
      [
        {
          ...provider,
          cacheIdentity: () => contentDigest(String(revision)),
          async retrieve(input) {
            revision += 1
            return provider.retrieve(input)
          },
        },
      ],
      {
        cache: {
          get: async () => undefined,
          set: async () => {
            stores += 1
          },
        },
      }
    )
    await selected.resolve(request())
    expect(stores).toBe(0)
  })

  test('rechecks revision identity after an asynchronous cache lookup', async () => {
    const provider = fake('K')
    const oldEntries = await provider.retrieve(request())
    let revision = 'old'
    let retrievals = 0
    const selected = resolver(
      [
        {
          ...provider,
          cacheIdentity: () => contentDigest(revision),
          async retrieve(input) {
            retrievals += 1
            return (await provider.retrieve(input)).map((entry) => ({ ...entry, revision }))
          },
        },
      ],
      {
        cache: {
          get: async () => {
            revision = 'new'
            return oldEntries
          },
          set: async () => undefined,
        },
      }
    )
    const result = await selected.resolve(request())
    expect(retrievals).toBe(1)
    expect(result.contributions[0].revision).toBe('new')
  })

  test('does not reuse a contribution across execution locations', async () => {
    const provider = fake('K')
    const locations = []
    const selected = resolver(
      [
        {
          ...provider,
          async retrieve(input) {
            locations.push(input.executionLocation)
            return (await provider.retrieve(input)).map((entry) => ({
              ...entry,
              content: input.executionLocation,
              contentDigest: contentDigest(input.executionLocation),
            }))
          },
        },
      ],
      { cache: new InMemoryContextContributionCache() }
    )
    for (const executionLocation of ['cloud', 'runtime_node', 'cloud', 'runtime_node']) {
      const result = await selected.resolve({ ...request(), executionLocation })
      expect(result.contributions[0].content).toBe(executionLocation)
    }
    expect(locations).toEqual(['cloud', 'runtime_node'])
  })

  test('retrieves and caches independently for each objective', async () => {
    const provider = fake('K')
    const objectives = []
    const selected = resolver(
      [
        {
          ...provider,
          async retrieve(input) {
            objectives.push(input.objective)
            return provider.retrieve(input)
          },
        },
      ],
      { cache: new InMemoryContextContributionCache() }
    )
    for (const objective of [
      'Investigate latency',
      'Investigate failures',
      'Investigate latency',
    ]) {
      await selected.resolve({ ...request(), objective })
    }
    expect(objectives).toEqual(['Investigate latency', 'Investigate failures'])
    await expect(selected.resolve({ ...request(), objective: '' })).rejects.toThrow()
  })

  test('ranks explicit connections before provider preference and reachability', async () => {
    const direct = fake('A', { reachability: 'direct', latencyClass: 'low', costClass: 'low' })
    const preferred = fake('B', {
      reachability: 'remote',
      latencyClass: 'high',
      costClass: 'premium',
    })
    const explicit = fake('C', {
      reachability: 'remote',
      latencyClass: 'high',
      costClass: 'premium',
    })

    const preferredResult = await resolver([direct, preferred]).resolve(
      request({ providerIds: [preferred.readModel.definition.providerId] })
    )
    expect(preferredResult.pins[0].providerId).toBe(preferred.readModel.definition.providerId)
    expect(preferredResult.decisionReasons).toContain('PREFERRED_PROVIDER')

    const explicitResult = await resolver([direct, preferred, explicit]).resolve(
      request({ connectionIds: [explicit.readModel.connection.connectionId] })
    )
    expect(explicitResult.pins[0].connectionId).toBe(explicit.readModel.connection.connectionId)
    expect(explicitResult.decisionReasons).toContain('EXPLICIT_CONNECTION')
  })
})

function resolver(providers, options) {
  return new ContextProviderResolver(providers, options)
}

function fake(suffix, overrides = {}) {
  return createFakeContextProvider({
    suffix,
    workspaceId,
    scopeDigest,
    health: 'healthy',
    state: 'active',
    capabilities: { evidenceSearch: true, memoryRecall: false },
    kind: 'evidence',
    tokenCount: 10,
    ...overrides,
  })
}

function contribution(provider, overrides) {
  return {
    ...provider,
    async retrieve(input) {
      const entries = await provider.retrieve(input)
      return entries.map((entry) => ({ ...entry, ...overrides }))
    },
  }
}

function contentDigest(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function request(policy = {}) {
  return {
    workspaceId,
    scopeDigest,
    principalRef: 'principal://test/user',
    executionLocation: 'cloud',
    capability: 'evidenceSearch',
    objective: 'Retrieve relevant test evidence',
    now,
    policy: {
      mode: 'preferred',
      providerIds: [],
      includeEvidence: true,
      includeMemory: false,
      maximumTokens: 100,
      maximumAgeSeconds: 3_600,
      maximumLatencyMs: 1_000,
      failureBehavior: 'continue_without',
      ...policy,
    },
  }
}

describe('provider read identity and deadline', () => {
  test('every provider read carries an operation identity and an explicit deadline', async () => {
    const observed = []
    const provider = fake('P')
    const capturing = {
      ...provider,
      retrieve: async (input) => {
        observed.push(input)
        return provider.retrieve(input)
      },
    }
    await resolver([capturing]).resolve(request())
    expect(observed).toHaveLength(1)
    expect(observed[0].operationId).toMatch(/^op:[0-9a-f-]{36}$/)
    expect(observed[0].deadlineAt).toBe('2026-08-25T12:00:01.000Z')

    observed.length = 0
    const explicit = request({ maximumLatencyMs: 2_500 })
    await resolver([capturing]).resolve({
      ...explicit,
      operationId: 'op:explicit-correlation-id',
      deadlineAt: '2026-08-25T12:00:05.000Z',
    })
    expect(observed[0].operationId).toBe('op:explicit-correlation-id')
    expect(observed[0].deadlineAt).toBe('2026-08-25T12:00:05.000Z')
  })

  test('per-read identity and deadline stay out of the cache identity', async () => {
    let retrievals = 0
    const provider = fake('C')
    const counting = {
      ...provider,
      cacheIdentity: () => `sha256:${'c'.repeat(64)}`,
      retrieve: async (input) => {
        retrievals += 1
        return provider.retrieve(input)
      },
    }
    const withCache = resolver([counting], { cache: new InMemoryContextContributionCache() })
    await withCache.resolve(request())
    await withCache.resolve({ ...request(), operationId: 'op:a-different-correlation' })
    expect(retrievals).toBe(1)
  })
})
