import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import {
  ContextProviderResolver,
  InMemoryContextContributionCache,
  runContextProviderConformance,
} from '@control-plane/context'
import {
  CortanaContextProviderAdapter,
  CortanaHttpClient,
  CortanaContextBundleSchema,
  FakeCortanaCompatibleServer,
  createContextBundle,
} from './index.ts'

const now = '2026-08-25T12:00:00.000Z'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const scopeDigest = `sha256:${'a'.repeat(64)}`
const readModel = {
  definition: {
    providerId: 'ctp_01JABCDEF0123456789ABCDEFG',
    providerType: 'cortana-compatible',
    displayName: 'Cortana fixture',
    contractVersion: '1.0.0',
    capabilities: {
      boundedRetrieval: true,
      evidenceSearch: true,
      memoryRecall: true,
      healthStatus: true,
      memoryWriteProposal: false,
      memoryWriteCommit: false,
    },
  },
  connection: {
    connectionId: 'ctc_01JABCDEF0123456789ABCDEFG',
    providerId: 'ctp_01JABCDEF0123456789ABCDEFG',
    workspaceId,
    principalRef: 'principal://test/user',
    scopeDigest,
    executionLocations: ['cloud', 'runtime_node'],
    state: 'active',
  },
  health: { status: 'healthy', checkedAt: '2026-08-25T11:59:00.000Z' },
}

describe('Cortana-compatible context adapter', () => {
  test('normalizes a compatible bundle through the concrete HTTP client', async () => {
    let reads = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (incoming) => {
        const input = await incoming.json()
        expect(input.operationId).toBe('context-http:adapter-test')
        reads++
        return Response.json(bundle())
      },
    })
    try {
      const client = new CortanaHttpClient({
        endpoint: `http://127.0.0.1:${server.port}/read`,
        allowLoopbackHttp: true,
      })
      const adapter = createAdapter(client, { transport: 'http' })
      const contributions = await adapter.retrieve({
        ...request(),
        now: new Date().toISOString(),
        operationId: 'context-http:adapter-test',
      })
      expect(contributions.map(({ kind }) => kind)).toEqual(['evidence', 'memory'])
      expect(reads).toBe(1)
    } finally {
      await server.stop(true)
    }
  })
  test('normalizes bounded evidence and memory over MCP and HTTP', async () => {
    for (const transport of ['mcp', 'http']) {
      const server = new FakeCortanaCompatibleServer(bundle())
      const adapter = createAdapter(server, { transport })
      const result = await new ContextProviderResolver([adapter]).resolve(request())
      expect(result.status).toBe('included')
      expect(result.contributions.map(({ kind }) => kind)).toEqual(['evidence', 'memory'])
      expect(result.contributions[0].provenance[0]).toMatchObject({
        sourceKind: 'external_evidence',
        citation: 'Evidence fixture',
      })
      expect(result.contributions[1].provenance[0]).toEqual({
        sourceRef: 'memory://fixture/1',
        sourceKind: 'provider_memory',
      })
      expect(server.requests[0].transport).toBe(transport)
      expect(server.requests[0].objective).toBe(request().objective)
    }
  })

  test('accepts the checked-in golden ContextBundle schema snapshot', async () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/golden/context-bundle.v1.json', import.meta.url), 'utf8')
    )
    expect(CortanaContextBundleSchema.parse(fixture).bundleDigest).toBe(fixture.bundleDigest)
    await expect(
      createAdapter(new FakeCortanaCompatibleServer(fixture)).retrieve(request())
    ).resolves.toHaveLength(2)
  })

  test('uses the generic Runtime Gateway context driver without a RuntimeConnection', async () => {
    const server = new FakeCortanaCompatibleServer(bundle())
    const adapter = createAdapter(server, { transport: 'runtime_node' })
    await adapter.retrieve(request())
    const command = server.requests[0].gatewayCommand
    expect(command).toMatchObject({
      family: 'context_provider',
      operation: 'context.read',
      driver: { family: 'context-provider', version: '1.0.0' },
    })
    expect(command).not.toHaveProperty('runtimeConnectionId')
    expect(command.payload.parameters.objective).toBe(request().objective)
    expect(JSON.stringify(command)).not.toMatch(/cortana|credential|database|localPath/i)
  })

  test('forwards the stable operation identity through each transport and binding', async () => {
    for (const transport of ['mcp', 'http', 'runtime_node']) {
      const server = new FakeCortanaCompatibleServer(bundle())
      const bindings = []
      const adapter = createAdapter(server, {
        transport,
        bindRuntimeNodeRead: async (input) => {
          bindings.push(input.request.operationId)
          return runtimeBinding(input)
        },
      })
      const operationId = 'context-author:operation-fixture-0001'
      await new ContextProviderResolver([adapter]).resolve({ ...request(), operationId })
      expect(server.requests[0].operationId).toBe(operationId)
      if (transport === 'runtime_node') {
        expect(bindings).toEqual([operationId])
        expect(server.requests[0].gatewayCommand.payload.parameters.operationId).toBe(operationId)
      }
    }
  })

  test('requires an explicit authorized RuntimeNode binding before sending a context command', async () => {
    const server = new FakeCortanaCompatibleServer(bundle())
    const adapter = createAdapter(server, {
      transport: 'runtime_node',
      bindRuntimeNodeRead: undefined,
    })
    await expect(adapter.retrieve(request())).rejects.toMatchObject({
      code: 'CORTANA_RUNTIME_BINDING_REQUIRED',
    })
    expect(server.requests).toHaveLength(0)
  })

  test('rejects invalid, cross-scope, and expired RuntimeNode bindings before client access', async () => {
    for (const [overrides, code] of [
      [{ commandId: 'invalid' }, 'CORTANA_RUNTIME_BINDING_INVALID'],
      [{ workspaceId: 'wsp_02JABCDEF0123456789ABCDEFG' }, 'CORTANA_RUNTIME_BINDING_SCOPE_MISMATCH'],
      [{ principalRef: 'principal://other/user' }, 'CORTANA_RUNTIME_BINDING_SCOPE_MISMATCH'],
      [{ scopeDigest: `sha256:${'f'.repeat(64)}` }, 'CORTANA_RUNTIME_BINDING_SCOPE_MISMATCH'],
      [{ providerRef: 'pvr_02JABCDEF0123456789ABCDEFG' }, 'CORTANA_RUNTIME_BINDING_SCOPE_MISMATCH'],
      [{ expiresAt: now }, 'CORTANA_RUNTIME_BINDING_EXPIRED'],
    ]) {
      const server = new FakeCortanaCompatibleServer(bundle())
      const adapter = createAdapter(server, {
        transport: 'runtime_node',
        bindRuntimeNodeRead: async (input) => ({ ...runtimeBinding(input), ...overrides }),
      })
      await expect(adapter.retrieve(request())).rejects.toMatchObject({ code })
      expect(server.requests).toHaveLength(0)
    }
  })

  test('reuses one authorized command across retries and allocates distinct commands for new reads', async () => {
    const server = new FakeCortanaCompatibleServer(bundle(), 1)
    let bindings = 0
    const adapter = createAdapter(server, {
      transport: 'runtime_node',
      bindRuntimeNodeRead: async (input) => runtimeBinding(input, ++bindings),
    })
    await adapter.retrieve(request())
    expect(bindings).toBe(1)
    expect(server.requests[0].gatewayCommand).toEqual(server.requests[1].gatewayCommand)
    expect(server.requests[0].gatewayCommand).toMatchObject({
      nodeId: 'rnr_02JABCDEF0123456789ABCDEFG',
      channelGeneration: 7,
      sequence: 1,
      authorizationRef: 'authz:provider-read-policy-v1',
    })
    await adapter.retrieve(request())
    expect(bindings).toBe(2)
    expect(server.requests[2].gatewayCommand.commandId).not.toBe(
      server.requests[0].gatewayCommand.commandId
    )
    expect(server.requests[2].gatewayCommand.idempotencyKey).not.toBe(
      server.requests[0].gatewayCommand.idempotencyKey
    )
  })

  test('bounds an uncooperative binding authority and never sends after its grant expires', async () => {
    const server = new FakeCortanaCompatibleServer(bundle())
    let signal
    const hanging = createAdapter(server, {
      transport: 'runtime_node',
      bindRuntimeNodeRead: async (_input, inputSignal) => {
        signal = inputSignal
        return new Promise(() => {})
      },
    })
    const short = request()
    short.policy.maximumLatencyMs = 5
    await expect(hanging.retrieve(short)).rejects.toMatchObject({
      code: 'CORTANA_RUNTIME_BINDING_TIMEOUT',
    })
    expect(signal.aborted).toBe(true)
    const expired = createAdapter(server, {
      transport: 'runtime_node',
      bindRuntimeNodeRead: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { ...runtimeBinding(input), expiresAt: new Date(Date.parse(now) + 5).toISOString() }
      },
    })
    await expect(expired.retrieve(request())).rejects.toMatchObject({ code: 'CORTANA_TIMEOUT' })
    expect(server.requests).toHaveLength(0)
  })

  test('does not let contribution caching bypass RuntimeNode authorization', async () => {
    const server = new FakeCortanaCompatibleServer(bundle())
    let bindings = 0
    const adapter = createAdapter(server, {
      transport: 'runtime_node',
      bindRuntimeNodeRead: async (input) => runtimeBinding(input, ++bindings),
    })
    const resolver = new ContextProviderResolver([adapter], {
      cache: new InMemoryContextContributionCache(),
    })
    await resolver.resolve(request())
    await resolver.resolve(request())
    expect(bindings).toBe(2)
    expect(server.requests).toHaveLength(2)
  })

  test('binds all read semantics into the payload hash and caps the command deadline', async () => {
    const calls = []
    const full = bundle()
    const client = {
      read: async (input) => {
        calls.push(input)
        return bundle({
          evidence: input.includeEvidence ? full.evidence : [],
          memories: input.includeMemory ? full.memories : [],
          tokenCount: (input.includeEvidence ? 4 : 0) + (input.includeMemory ? 4 : 0),
        })
      },
    }
    for (const change of [
      {},
      { objective: 'A different objective' },
      { capability: 'memoryRecall' },
      { policy: { includeMemory: false } },
      { policy: { includeEvidence: false } },
      { policy: { maximumAgeSeconds: 60 } },
    ]) {
      const input = { ...request(), ...change, policy: { ...request().policy, ...change.policy } }
      await createAdapter(client, {
        transport: 'runtime_node',
        bindRuntimeNodeRead: async (value) => ({
          ...runtimeBinding(value),
          expiresAt: new Date(Date.parse(now) + 500).toISOString(),
        }),
      }).retrieve(input)
    }
    expect(new Set(calls.map((entry) => entry.gatewayCommand.payloadHash)).size).toBe(6)
    expect(calls[0].gatewayCommand.payload.parameters).toMatchObject({
      mappedProjectRef: 'provider-project-fixture',
      principalRef: request().principalRef,
      includeEvidence: true,
      includeMemory: true,
    })
    expect(calls[0].gatewayCommand.expiresAt).toBe(new Date(Date.parse(now) + 500).toISOString())
    expect(calls[0].deadline).toBe(calls[0].gatewayCommand.expiresAt)
  })

  test('sanitizes authority errors and bounds clients that ignore cancellation', async () => {
    const adapter = createAdapter(
      {
        read: async () => {
          throw new Error('UNEXPECTED_READ')
        },
      },
      {
        transport: 'runtime_node',
        bindRuntimeNodeRead: async () => {
          throw new Error('private authority details')
        },
      }
    )
    await expect(adapter.retrieve(request())).rejects.toMatchObject({ code: 'CORTANA_UNAVAILABLE' })
    let signal
    const hanging = createAdapter({
      read: async (_input, value) => {
        signal = value
        return new Promise(() => {})
      },
    })
    const short = request()
    short.policy.maximumLatencyMs = 5
    await expect(hanging.retrieve(short)).rejects.toMatchObject({ code: 'CORTANA_TIMEOUT' })
    expect(signal.aborted).toBe(true)
  })

  test('validates version, scope, revision, digest, budget, and evidence/memory separation', async () => {
    await expectFailure({ contractVersion: '2.0.0' }, 'CORTANA_BUNDLE_INVALID')
    await expectFailure({ scopeDigest: `sha256:${'d'.repeat(64)}` }, 'CORTANA_SCOPE_MISMATCH')
    await expectFailure({ bundleDigest: `sha256:${'e'.repeat(64)}` }, 'CORTANA_DIGEST_MISMATCH')
    await expectFailure({ tokenCount: 999 }, 'CORTANA_DIGEST_MISMATCH')
    const wrongRevision = createAdapter(new FakeCortanaCompatibleServer(bundle()), {
      expectedCorpusRevision: 'corpus-other',
      maximumRetries: 0,
    })
    await expect(wrongRevision.retrieve(request())).rejects.toMatchObject({
      code: 'CORTANA_REVISION_MISMATCH',
    })
    const noMemory = request()
    noMemory.policy.includeMemory = false
    await expect(
      createAdapter(new FakeCortanaCompatibleServer(bundle())).retrieve(noMemory)
    ).rejects.toMatchObject({ code: 'CORTANA_MEMORY_NOT_AUTHORIZED' })
  })

  test('retries idempotent reads, opens the circuit, bounds output, and emits content-safe telemetry', async () => {
    const recovered = new FakeCortanaCompatibleServer(bundle(), 1)
    await expect(createAdapter(recovered).retrieve(request())).resolves.toHaveLength(2)
    expect(recovered.requests).toHaveLength(2)
    expect(recovered.effects).toBe(1)

    const telemetry = []
    const failing = new FakeCortanaCompatibleServer(bundle(), 10)
    const adapter = createAdapter(failing, {
      maximumRetries: 0,
      circuitFailureThreshold: 1,
      onTelemetry: (event) => telemetry.push(event),
    })
    await expect(adapter.retrieve(request())).rejects.toMatchObject({ code: 'CORTANA_UNAVAILABLE' })
    await expect(adapter.retrieve(request())).rejects.toMatchObject({
      code: 'CORTANA_CIRCUIT_OPEN',
    })
    expect(JSON.stringify(telemetry)).not.toMatch(/bounded evidence|bounded memory/)

    const limited = createAdapter(new FakeCortanaCompatibleServer(bundle()), {
      maximumOutputBytes: 32,
      maximumRetries: 0,
    })
    await expect(limited.retrieve(request())).rejects.toMatchObject({
      code: 'CORTANA_OUTPUT_LIMIT',
    })
  })

  test('cancels timed-out requests and passes provider conformance', async () => {
    const slow = createAdapter(new FakeCortanaCompatibleServer(bundle(), 0, 20), {
      maximumRetries: 0,
    })
    const timed = request()
    timed.policy.maximumLatencyMs = 1
    await expect(slow.retrieve(timed)).rejects.toMatchObject({ code: 'CORTANA_TIMEOUT' })

    expect(
      await runContextProviderConformance(
        createAdapter(new FakeCortanaCompatibleServer(bundle())),
        request()
      )
    ).toEqual({ bounded: true, deterministic: true, scopePreserved: true })
  })

  test('disabling or removing the adapter restores ordinary no-provider behavior', async () => {
    const disabled = request()
    disabled.policy.mode = 'disabled'
    expect(await new ContextProviderResolver([]).resolve(disabled)).toEqual({
      status: 'disabled',
      contributions: [],
      pins: [],
      decisionReasons: ['POLICY_DISABLED'],
    })
  })

  test('does not reuse cached evidence across pinned corpus revisions', async () => {
    const cache = new InMemoryContextContributionCache()
    const first = createAdapter(new FakeCortanaCompatibleServer(bundle()))
    await new ContextProviderResolver([first], { cache }).resolve(request())
    const changedServer = new FakeCortanaCompatibleServer(bundle({ corpusRevision: 'corpus-43' }))
    const changed = createAdapter(changedServer, { expectedCorpusRevision: 'corpus-43' })
    const result = await new ContextProviderResolver([changed], { cache }).resolve(request())
    expect(changedServer.requests).toHaveLength(1)
    expect(result.contributions[0].providerMetadata.corpusRevision).toBe('corpus-43')
    await new ContextProviderResolver([changed], { cache }).resolve(request())
    expect(changedServer.requests).toHaveLength(1)
  })

  test('separates cached data by adapter project, transport, client identity, and output bound', async () => {
    for (const overrides of [
      { mappedProjectRef: 'different-project' },
      { transport: 'mcp' },
      { clientIdentity: 'different-endpoint-policy' },
      { maximumOutputBytes: 4096 },
    ]) {
      const cache = new InMemoryContextContributionCache()
      await new ContextProviderResolver(
        [createAdapter(new FakeCortanaCompatibleServer(bundle()))],
        { cache }
      ).resolve(request())
      const server = new FakeCortanaCompatibleServer(bundle())
      await new ContextProviderResolver([createAdapter(server, overrides)], { cache }).resolve(
        request()
      )
      expect(server.requests).toHaveLength(1)
    }
  })

  test('retrieves fresh data if client identity or any required revision pin is unavailable', async () => {
    for (const key of [
      'clientIdentity',
      'expectedCorpusRevision',
      'expectedMemoryRevision',
      'expectedEmbeddingVersion',
      'expectedRetrievalVersion',
    ]) {
      const server = new FakeCortanaCompatibleServer(bundle())
      const selected = new ContextProviderResolver([createAdapter(server, { [key]: undefined })], {
        cache: new InMemoryContextContributionCache(),
      })
      await selected.resolve(request())
      await selected.resolve(request())
      expect(server.requests).toHaveLength(2)
    }
  })
})

function createAdapter(server, overrides = {}) {
  let sequence = 0
  return new CortanaContextProviderAdapter({
    readModel,
    providerRef: 'pvr_01JABCDEF0123456789ABCDEFG',
    mappedProjectRef: 'provider-project-fixture',
    transport: 'http',
    client: server,
    clientIdentity: 'fixture-client-v1',
    bindRuntimeNodeRead: async (input) => runtimeBinding(input, ++sequence),
    expectedCorpusRevision: 'corpus-42',
    expectedMemoryRevision: 'memory-9',
    expectedEmbeddingVersion: 'embed-3',
    expectedRetrievalVersion: 'retrieve-2',
    ...overrides,
  })
}

function runtimeBinding({ request: input, providerRef }, sequence = 1) {
  return {
    nodeId: 'rnr_02JABCDEF0123456789ABCDEFG',
    workspaceId: input.workspaceId,
    traceId: 'trc_02JABCDEF0123456789ABCDEFG',
    channelGeneration: 7,
    sequence,
    commandId: `cmd_${String(sequence).padStart(26, '0')}`,
    idempotencyKey: `context-read-fixture:${sequence}`,
    authorizationRef: 'authz:provider-read-policy-v1',
    providerRef,
    principalRef: input.principalRef,
    scopeDigest: input.scopeDigest,
    expiresAt: new Date(Date.parse(input.now) + 60000).toISOString(),
  }
}

function bundle(overrides = {}) {
  return createContextBundle({
    contractVersion: '1.0.0',
    bundleId: 'bundle-fixture-1',
    scopeDigest,
    corpusRevision: 'corpus-42',
    memoryRevision: 'memory-9',
    embeddingVersion: 'embed-3',
    retrievalVersion: 'retrieve-2',
    createdAt: '2026-08-25T11:59:00.000Z',
    tokenCount: 8,
    degraded: false,
    omittedCount: 0,
    evidence: [
      {
        sliceId: 'evidence-1',
        content: 'bounded evidence',
        tokenCount: 4,
        contentDigest: 'sha256:30093e91ea5f5bf22aeff70004c2b7f29608ce396d42817d76803104fa0a40e7',
        sourceRef: 'https://example.invalid/evidence/1',
        citation: 'Evidence fixture',
      },
    ],
    memories: [
      {
        sliceId: 'memory-1',
        content: 'bounded memory',
        tokenCount: 4,
        contentDigest: 'sha256:d770b00ff4ffced952aece9ab241eb6a946a5a934e48eafe0d48dc13b4cfc655',
        sourceRef: 'memory://fixture/1',
      },
    ],
    ...overrides,
  })
}

async function expectFailure(overrides, code) {
  const raw = bundle()
  Object.assign(raw, overrides)
  const adapter = createAdapter(new FakeCortanaCompatibleServer(raw), { maximumRetries: 0 })
  await expect(adapter.retrieve(request())).rejects.toMatchObject({ code })
}

function request() {
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
      includeMemory: true,
      maximumTokens: 100,
      maximumAgeSeconds: 3_600,
      maximumLatencyMs: 1_000,
      failureBehavior: 'fail',
    },
  }
}
