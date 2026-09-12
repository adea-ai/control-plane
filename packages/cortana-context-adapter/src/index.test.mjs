import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { ContextProviderResolver, runContextProviderConformance } from '@control-plane/context'
import {
  CortanaContextProviderAdapter,
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
})

function createAdapter(server, overrides = {}) {
  return new CortanaContextProviderAdapter({
    readModel,
    providerRef: 'pvr_01JABCDEF0123456789ABCDEFG',
    mappedProjectRef: 'provider-project-fixture',
    transport: 'http',
    client: server,
    expectedCorpusRevision: 'corpus-42',
    expectedMemoryRevision: 'memory-9',
    expectedEmbeddingVersion: 'embed-3',
    expectedRetrievalVersion: 'retrieve-2',
    ...overrides,
  })
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
