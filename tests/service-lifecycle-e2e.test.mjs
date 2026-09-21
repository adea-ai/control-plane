import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  InMemoryInteractionRepository,
  InteractionService,
  contextCommandSemanticHash,
} from '@control-plane/domain'
import {
  SqliteContextCommandGrantRepository,
  SqliteContextNodeInboxRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import {
  InMemoryMarketplaceInstallationRepository,
  MarketplaceInstallationService,
  MarketplaceRegistryService,
  createControlApiApplication,
  createPrivateApiAuthentication,
} from '../apps/control-api/dist/index.js'
import {
  InMemoryToolCallRepository,
  InMemoryToolRateLimiter,
  InMemoryToolRegistryRepository,
  InteractionToolApprovalCoordinator,
  McpAdapter,
  PolicyControlledToolExecutionService,
  StaticToolPolicyAuthorizer,
  ToolGateway,
  ToolRegistry,
  start as startToolGateway,
} from '../apps/tool-gateway/dist/index.js'
import {
  composeContextNode,
  start as startRuntimeWorker,
} from '../apps/runtime-worker/dist/index.js'

const contextNodeIds = {
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  providerRef: 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  authorizationRef: 'authz:context-node-e2e-read',
  principalRef: 'service:e2e-gateway',
  scopeDigest: `sha256:${'7'.repeat(64)}`,
}

describe('Service lifecycle E2E composition', () => {
  test('tool gateway service boots ready and drains its process listeners on shutdown', async () => {
    const input = serviceOptions('e2e-tool-gateway')
    const runtime = await startToolGateway(input)
    try {
      expect(runtime.metadata.serviceName).toBe('tool-gateway')
      expect(runtime.health()).toMatchObject({
        status: 'ok',
        metadata: { serviceName: 'tool-gateway' },
      })
      expect(runtime.readiness().status).toBe('ready')
    } finally {
      await runtime.shutdown('test')
    }
    expect(runtime.readiness().status).toBe('not_ready')
    expect(input.processAdapter.listeners.size).toBe(0)
  })

  test('tool gateway serves a discovered MCP tool end-to-end and fails closed on unknown tools and denied grants', async () => {
    const client = new FakeMcpHttpClient()
    const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
    const gateway = new ToolGateway(registry)
    const adapter = new McpAdapter({
      registration: { serverId: 'weather', credentialRef: 'vault://mcp/weather' },
      workspaceId: toolIds.workspaceId,
      client,
      registry,
      gateway,
      ids: nextToolIds(),
      limits: { maxInputBytes: 1_048_576, maxOutputBytes: 1_048_576, timeoutMs: 2_000 },
    })
    const service = new PolicyControlledToolExecutionService({
      gateway,
      calls: new InMemoryToolCallRepository(),
      authorizer: new StaticToolPolicyAuthorizer({
        effect: 'allow',
        decisionId: 'decision-e2e-allow',
        policyVersion: 'workspace-e2e@1',
        reasonCode: 'GRANTED',
        requiresApproval: false,
        evaluatedAt: '2026-09-21T12:00:00.000Z',
      }),
      approvals: new InteractionToolApprovalCoordinator(
        new InteractionService(new InMemoryInteractionRepository()),
        new InMemoryInteractionRepository()
      ),
      rateLimiter: new InMemoryToolRateLimiter(),
    })

    // Boot-time discovery registers the MCP tool as a published, workspace-scoped version.
    const [version] = await adapter.refresh()
    expect(await registry.list(toolIds.workspaceId)).toEqual([
      expect.objectContaining({
        definition: expect.objectContaining({
          name: 'weather.weather.lookup',
          ownership: { scope: 'workspace', workspaceId: toolIds.workspaceId },
        }),
        versions: [
          expect.objectContaining({
            toolVersionId: version.toolVersionId,
            lifecycle: 'published',
            executor: { type: 'mcp', reference: 'mcp/weather' },
          }),
        ],
      }),
    ])

    const request = toolRequest(version)
    const outcome = await service.execute(request)
    expect(outcome.state).toBe('succeeded')
    expect(outcome.call).toMatchObject({
      status: 'succeeded',
      toolVersionId: version.toolVersionId,
      workspaceId: toolIds.workspaceId,
    })
    expect(outcome.result).toMatchObject({
      toolDefinitionId: version.toolDefinitionId,
      toolVersionId: version.toolVersionId,
      operation: 'invoke',
      output: { forecast: 'sunny' },
      artifactRefs: [],
      executor: { type: 'mcp', reference: 'mcp/weather' },
      attempts: 1,
    })
    expect(outcome.result.audit.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    // The MCP HTTP boundary received the server identity and credential reference; the
    // canonical execution result never carries the credential forward.
    expect(client.invocations).toEqual([
      expect.objectContaining({
        serverId: 'weather',
        toolName: 'weather_lookup',
        credentialRef: 'vault://mcp/weather',
        input: { city: 'San Juan' },
      }),
    ])
    expect(JSON.stringify(outcome.result)).not.toContain('vault://')

    // Idempotent redelivery replays the durable result without another provider effect.
    const replay = await service.execute(request)
    expect(replay.state).toBe('succeeded')
    expect(replay.result).toEqual(outcome.result)
    expect(client.invocations).toHaveLength(1)

    // Unknown tool version with a self-consistent grant fails closed as unavailable.
    await expect(
      service.execute(
        toolRequest(version, {
          toolDefinitionId: 'tld_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          toolVersionId: 'tlv_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        })
      )
    ).rejects.toMatchObject({ name: 'ToolGatewayError', code: 'TOOL_UNAVAILABLE' })

    // An unregistered operation is unavailable even though the tool exists.
    await expect(
      service.execute(toolRequest(version, { operation: 'purge', grantOperations: ['purge'] }))
    ).rejects.toMatchObject({ name: 'ToolGatewayError', code: 'OPERATION_UNAVAILABLE' })

    // The grant is the authorization boundary: an expired grant is denied before any lookup.
    await expect(
      service.execute(
        toolRequest(version, { grantExpiresAt: new Date(Date.now() - 1_000).toISOString() })
      )
    ).rejects.toMatchObject({ name: 'ToolGatewayError', code: 'GRANT_DENIED' })

    // Workspace scope is enforced at the registry: another workspace cannot read the tool.
    await expect(
      registry.readDefinition(version.toolDefinitionId, 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV')
    ).rejects.toMatchObject({ name: 'ToolRegistryError', code: 'SCOPE_DENIED' })
    expect(client.invocations).toHaveLength(1)
  })

  test('runtime worker composes a durable context node that executes, replays, and revokes over its grant store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-e2e-context-node-'))
    const path = join(directory, 'node.sqlite')
    const frames = []
    let nextSequenceValue = 2
    const driverCalls = []
    const composition = await composeContextNode({
      store: { backend: 'sqlite', path },
      workspaceId: contextNodeIds.workspaceId,
      nodeId: contextNodeIds.nodeId,
      timeoutMs: 2_000,
      driver: {
        execute: async (command, signal) => {
          driverCalls.push({ commandId: command.commandId, status: command.status, signal })
          return { status: 'succeeded', result: { evidence: 'bounded-e2e' } }
        },
        reconcile: async () => ({ status: 'unknown' }),
      },
      transport: {
        send: async (serialized) => {
          frames.push(JSON.parse(serialized))
        },
        nextSequence: async () => nextSequenceValue++,
        assertCurrent: async (command) => {
          if (command.channelGeneration !== 1) throw new Error('STALE_CHANNEL')
        },
      },
    })
    try {
      // Trusted operator provisioning: an active node grant is required before any command is admitted.
      await composition.administration.apply({ operation: 'grant', grant: contextNodeGrant() })
      const envelope = contextCommandEnvelope()
      await composition.channel.receive(JSON.stringify(envelope))
      expect(frames.map((frame) => frame.type)).toEqual(['ack', 'result'])
      expect(frames[0].disposition).toBe('accepted')
      expect(frames[1]).toMatchObject({
        status: 'succeeded',
        sequence: 2,
        result: { data: { evidence: 'bounded-e2e' } },
      })
      expect(driverCalls).toEqual([
        expect.objectContaining({
          commandId: contextNodeIds.commandId,
        }),
      ])
      expect(driverCalls[0].signal.aborted).toBeFalse()

      // Redelivery replays the durable result without another provider read.
      await composition.channel.receive(JSON.stringify(envelope))
      expect(frames.map((frame) => frame.type)).toEqual(['ack', 'result', 'ack', 'result'])
      expect(frames[2].disposition).toBe('replayed')
      expect(frames[3].sequence).toBe(3)
      expect(driverCalls).toHaveLength(1)

      // Revoking the grant fails the channel closed for any further disclosure.
      await composition.administration.apply({
        operation: 'revoke',
        workspaceId: contextNodeIds.workspaceId,
        authorizationRef: contextNodeIds.authorizationRef,
      })
      await expect(composition.channel.receive(JSON.stringify(envelope))).rejects.toThrow(
        'CONTEXT_GRANT_DENIED'
      )
      expect(driverCalls).toHaveLength(1)
    } finally {
      await composition.close()
    }

    // The drained store keeps the terminal record durable for the next worker boot.
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const stored = await new SqliteContextNodeInboxRepository(provider).get(
        contextNodeIds.workspaceId,
        contextNodeIds.nodeId,
        contextNodeIds.commandId
      )
      expect(stored).toMatchObject({
        status: 'succeeded',
        result: { evidence: 'bounded-e2e' },
      })
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('runtime worker fails closed on invalid node config and drains the composed store on shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-e2e-runtime-worker-'))
    try {
      const path = join(directory, 'node.sqlite')
      // Seed the node-local grant store so the booted worker demonstrably shares and releases it.
      const seeded = new SqlitePersistenceProvider({ path })
      await seeded.migrate()
      await new SqliteContextCommandGrantRepository(seeded).create(contextNodeGrant())
      await seeded.close()

      // Invalid or partial node config fails closed before the worker reports ready.
      const rejected = serviceOptions('e2e-runtime-worker')
      await expect(
        startRuntimeWorker({
          ...rejected,
          contextNode: contextNodeConfig(path, { timeoutMs: 0 }),
        })
      ).rejects.toMatchObject({ name: 'ServiceStartupError' })
      expect(rejected.processAdapter.exitCode).toBe(1)
      expect(rejected.processAdapter.listeners.size).toBe(0)

      const input = serviceOptions('e2e-runtime-worker')
      const runtime = await startRuntimeWorker({
        ...input,
        contextNode: contextNodeConfig(path),
      })
      expect(runtime.readiness().status).toBe('ready')
      await runtime.shutdown('test')
      expect(input.processAdapter.listeners.size).toBe(0)

      const reopened = new SqlitePersistenceProvider({ path })
      try {
        await reopened.migrate()
        expect(
          await new SqliteContextCommandGrantRepository(reopened).get(
            contextNodeIds.workspaceId,
            contextNodeIds.authorizationRef
          )
        ).toMatchObject({ status: 'active' })
      } finally {
        await reopened.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('marketplace install-plan negotiates a capability-bound plan over the authenticated HTTP surface', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-e2e-marketplace-'))
    let application
    try {
      application = await marketplaceApplication(directory)
      const response = await application.inject({
        method: 'POST',
        url: '/v1/marketplace/install-plan',
        headers: { authorization: `Bearer ${await privateCredential(directory)}` },
        payload: planEnvelope(),
      })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.meta).toEqual({
        correlationId: expect.any(String),
        requestId: expect.any(String),
      })
      const snapshot = marketplaceSnapshot()
      expect(body.data).toMatchObject({
        planVersion: 2,
        pluginId: 'plugin:example:demo',
        releaseId: snapshot.releaseId,
        instanceId: 'wsp-e2e-demo',
        strategy: 'native-agent-plugin',
        compatibility: 'full',
        allowedToActivate: false,
        approvalRequired: true,
        preserveDataAcrossUpdates: true,
        profile: { harness: 'codex', profileVersion: 1 },
        source: {
          repositoryUrl: 'https://github.com/example/plugins',
          commitSha: 'c'.repeat(40),
          pluginSubdirectory: 'plugins/demo',
          contentDigest: snapshot.sourceDigest,
        },
        selection: { skillDirectories: ['skills/review'], mcpServers: {} },
        disabled: [],
        requiredConnectors: [],
        requiredCredentials: [],
      })
      expect(body.data.preconditions.length).toBeGreaterThan(0)
      expect(body.data.packageKey).toMatch(/^packages\//)
      expect(body.data.dataKey).toMatch(/^instances\//)
    } finally {
      await application?.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('marketplace install-plan rejects unauthenticated, cross-workspace, and unconfigured requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-e2e-marketplace-auth-'))
    let application
    let unconfiguredApplication
    try {
      application = await marketplaceApplication(directory)
      const credential = await privateCredential(directory)
      const post = async (payload, headers = {}) =>
        application.inject({
          method: 'POST',
          url: '/v1/marketplace/install-plan',
          headers: { authorization: `Bearer ${credential}`, ...headers },
          payload,
        })

      // Missing credentials cannot reach the marketplace route at all.
      const anonymous = await application.inject({
        method: 'POST',
        url: '/v1/marketplace/install-plan',
        payload: planEnvelope(),
      })
      expect(anonymous.statusCode).toBe(401)
      expect(anonymous.json().error.code).toBe('PRIVATE_API_AUTHENTICATION_FAILED')

      const unauthorized = await post(planEnvelope(), {
        authorization: `Bearer ${'x'.repeat(43)}`,
      })
      expect(unauthorized.statusCode).toBe(401)
      expect(unauthorized.json().error.code).toBe('PRIVATE_API_AUTHENTICATION_FAILED')

      // A rejected caller identity fails closed even with the correct credential.
      const impostor = await post(
        planEnvelope({ caller: { servicePrincipalId: 'svc_impersonator' } })
      )
      expect(impostor.statusCode).toBe(401)
      expect(impostor.json().error.code).toBe('PRIVATE_API_CALLER_INVALID')

      // The envelope workspace must match the payload workspace identity.
      const crossWorkspace = await post(
        planEnvelope({
          payload: {
            ...planEnvelope().payload,
            workspaceIdentity: {
              userId: 'user-e2e',
              workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            },
          },
        })
      )
      expect(crossWorkspace.statusCode).toBe(400)
      expect(crossWorkspace.json().error.code).toBe('MARKETPLACE_REQUEST_INVALID')

      // Unknown plugins are a validated client error, not a server fault.
      const missing = await post(
        planEnvelope({
          payload: { ...planEnvelope().payload, pluginId: 'plugin:example:missing' },
        })
      )
      expect(missing.statusCode).toBe(400)
      expect(missing.json().error.code).toBe('MARKETPLACE_RELEASE_NOT_FOUND')

      // Without installation planning configured the route fails closed as unavailable.
      unconfiguredApplication = await createControlApiApplication({
        ...applicationDefaults(),
        serviceAuthenticator: (await createPrivateApiAuthentication(directory)).authenticator,
      })
      const unconfigured = await unconfiguredApplication.inject({
        method: 'POST',
        url: '/v1/marketplace/install-plan',
        headers: { authorization: `Bearer ${await privateCredential(directory)}` },
        payload: planEnvelope(),
      })
      expect(unconfigured.statusCode).toBe(503)
      expect(unconfigured.json().error.code).toBe('MARKETPLACE_INSTALLATION_NOT_CONFIGURED')
    } finally {
      await application?.close()
      await unconfiguredApplication?.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

const toolIds = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
  interactionId: 'int_01JABCDEF0123456789ABCDEFG',
}

class FakeMcpHttpClient {
  enforcesRawDiscoveryLimit = true
  discoveryLimits = []
  invocations = []
  tools = [
    {
      name: 'weather_lookup',
      description: 'Looks up bounded weather.',
      version: '2026-09',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { forecast: { type: 'string' } },
        required: ['forecast'],
        additionalProperties: false,
      },
      readOnly: true,
    },
  ]

  async discover(_registration, limits) {
    this.discoveryLimits.push(structuredClone(limits))
    return structuredClone(this.tools)
  }

  async invoke(request, signal) {
    if (signal.aborted) throw Object.assign(new Error('aborted'), { code: 'MCP_ABORTED' })
    this.invocations.push(structuredClone(request))
    return { forecast: 'sunny' }
  }
}

let toolIdCounter = 0

function nextToolIds() {
  const suffixes = ['G', 'H', 'J', 'K', 'M', 'N', 'P', 'Q']
  let value = toolIdCounter
  toolIdCounter += suffixes.length
  return {
    definition: () => `tld_01JABCDEF0123456789ABCDEF${suffixes[value++]}`,
    version: () => `tlv_01JABCDEF0123456789ABCDEF${suffixes[value++]}`,
  }
}

function toolRequest(version, overrides = {}) {
  const values = {
    toolCallId: toolIds.toolCallId,
    idempotencyKey: 'e2e-tool-effect',
    requestedAt: '2026-09-21T12:00:00.000Z',
    policySnapshotRef: 'policy://workspace/e2e',
    approval: {
      interactionId: toolIds.interactionId,
      allowedPrincipalIds: ['svc_agent-hq'],
      requestedAt: '2026-09-21T12:00:00.000Z',
      expiresAt: '2026-09-21T13:00:00.000Z',
    },
    requestId: toolIds.requestId,
    executionId: toolIds.executionId,
    attemptId: toolIds.attemptId,
    workspaceId: toolIds.workspaceId,
    profileId: toolIds.profileId,
    toolDefinitionId: version.toolDefinitionId,
    toolVersionId: version.toolVersionId,
    operation: 'invoke',
    input: { city: 'San Juan' },
    audit: { principalRef: 'service:e2e-runtime-worker', traceId: toolIds.traceId },
    grantExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    grantOperations: undefined,
    ...overrides,
  }
  const { grantExpiresAt, grantOperations, ...request } = values
  return {
    ...request,
    grant: {
      workspaceId: request.workspaceId,
      profileId: request.profileId,
      toolDefinitionId: request.toolDefinitionId,
      toolVersionId: request.toolVersionId,
      operations: grantOperations ?? [request.operation],
      expiresAt: grantExpiresAt,
    },
  }
}

function contextNodeGrant() {
  return {
    authorizationRef: contextNodeIds.authorizationRef,
    workspaceId: contextNodeIds.workspaceId,
    nodeId: contextNodeIds.nodeId,
    providerRef: contextNodeIds.providerRef,
    principalRef: contextNodeIds.principalRef,
    mappedProjectRef: 'project:e2e-bound',
    scopeDigest: contextNodeIds.scopeDigest,
    capabilities: ['boundedRetrieval'],
    maximumTokens: 1_024,
    includeEvidence: true,
    includeMemory: false,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    status: 'active',
  }
}

function contextCommandEnvelope() {
  const issuedAt = new Date().toISOString()
  const value = {
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 5 },
    commandId: contextNodeIds.commandId,
    nodeId: contextNodeIds.nodeId,
    workspaceId: contextNodeIds.workspaceId,
    traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    channelGeneration: 1,
    sequence: 1,
    sentAt: issuedAt,
    issuedAt,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    idempotencyKey: 'context-node:e2e-read',
    providerRef: contextNodeIds.providerRef,
    authorizationRef: contextNodeIds.authorizationRef,
    family: 'context_provider',
    operation: 'context.read',
    driver: { family: 'context-provider', version: '1.0.0' },
    requiredCapabilities: ['context.read'],
    payload: {
      version: 1,
      parameters: {
        operationId: 'context-node:e2e-read',
        principalRef: contextNodeIds.principalRef,
        scopeDigest: contextNodeIds.scopeDigest,
        objective: 'Read bounded evidence for the E2E worker',
        mappedProjectRef: 'project:e2e-bound',
        capability: 'boundedRetrieval',
        maximumTokens: 512,
        maximumAgeSeconds: 3_600,
        includeEvidence: true,
        includeMemory: false,
      },
    },
  }
  return { ...value, payloadHash: contextCommandSemanticHash(value) }
}

function contextNodeConfig(path, overrides = {}) {
  return {
    store: { backend: 'sqlite', path },
    workspaceId: contextNodeIds.workspaceId,
    nodeId: contextNodeIds.nodeId,
    timeoutMs: 2_000,
    driver: {
      execute: async () => ({ status: 'succeeded', result: { evidence: 'bounded-e2e' } }),
      reconcile: async () => ({ status: 'unknown' }),
    },
    transport: {
      send: async () => {},
      nextSequence: async () => 2,
      assertCurrent: async () => {},
    },
    ...overrides,
  }
}

function serviceOptions(instanceId) {
  const listeners = new Map()
  const processAdapter = {
    listeners,
    on: (event, listener) => listeners.set(event, listener),
    off: (event) => listeners.delete(event),
    setExitCode(code) {
      this.exitCode = code
    },
  }
  return {
    environment: {
      APP_ENV: 'test',
      COMMIT_SHA: 'e2e-service-lifecycle',
      INSTANCE_ID: instanceId,
      SERVICE_VERSION: '0.0.0',
    },
    logger: { write: () => undefined },
    processAdapter,
  }
}

async function privateCredential(directory) {
  const authentication = await createPrivateApiAuthentication(directory)
  return (await readFile(authentication.credentialFile, 'utf8')).trim()
}

function applicationDefaults() {
  const metadata = {
    serviceName: 'control-api',
    version: 'test',
    commitSha: 'test',
    environment: 'test',
    instanceId: 'e2e-marketplace',
  }
  return {
    metadata,
    logger: { write: () => undefined },
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
  }
}

async function marketplaceApplication(directory) {
  const snapshot = marketplaceSnapshot()
  const registry = new MarketplaceRegistryService({
    fetchImpl: async (input) => {
      const artifact = snapshot.artifacts[String(input).split('/').at(-1)]
      return artifact === undefined
        ? new Response('missing', { status: 404 })
        : new Response(artifact, { status: 200 })
    },
    latestUrl: 'https://registry.example/releases/latest/download/catalog-latest.v1.json',
    immutableReleaseBaseUrl: 'https://registry.example/releases/download/catalog/{catalogId}',
    releaseVerifier: { verify: async () => true },
  })
  const installations = new MarketplaceInstallationService({
    registry,
    repository: new InMemoryMarketplaceInstallationRepository(),
    policy: { harnessProfile: { resolve: async () => harnessProfile() } },
  })
  return createControlApiApplication({
    ...applicationDefaults(),
    serviceAuthenticator: (await createPrivateApiAuthentication(directory)).authenticator,
    marketplaceRegistryService: registry,
    marketplaceInstallationService: installations,
  })
}

function planEnvelope(overrides = {}) {
  const values = {
    caller: { servicePrincipalId: 'svc_agent-hq' },
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    contractVersion: { major: 2, minor: 0 },
    correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
    idempotencyKey: 'marketplace-plan-e2e',
    issuedAt: '2026-09-21T00:00:00.000Z',
    operation: 'marketplace.install.plan',
    payload: {
      pluginId: 'plugin:example:demo',
      releaseId: marketplaceSnapshot().releaseId,
      instanceId: 'wsp-e2e-demo',
      requestedHarness: 'codex',
      workspaceIdentity: {
        userId: 'user-e2e',
        workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
      },
    },
    payloadHash: 'a'.repeat(64),
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  }
  const payload = overrides.payload
  const { payload: _ignored, ...rest } = overrides
  return { ...values, ...rest, ...(payload === undefined ? {} : { payload }) }
}

function harnessProfile() {
  return {
    profileVersion: 1,
    harness: 'codex',
    runtimeVersion: '1.2.3',
    adapterVersion: '0.4.1',
    agentPlugins: { versions: ['1.0.0'], skills: true, mcpTransports: ['stdio'] },
    components: { skillDirectories: false, mcpTransports: [] },
  }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`
}

function bytesDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

// Mirrors the canonical JSON of the marketplace registry so integrity artifacts verify.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

function artifactDigest(text) {
  return bytesDigest(JSON.stringify(text))
}

function agentPackageFixture(sourceDigest) {
  const manifest = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'demo',
  }
  const manifestContent = `${stableJson(manifest)}\n`
  const mcp = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: {} }
  const mcpContent = `${stableJson(mcp)}\n`
  const files = [
    {
      action: 'copy',
      sourcePath: 'skills/review/SKILL.md',
      targetPath: 'skills/review/SKILL.md',
      digest: bytesDigest('review'),
      preserveMode: true,
    },
    {
      action: 'write',
      targetPath: 'mcp.json',
      digest: bytesDigest(mcpContent),
      content: mcpContent,
      mode: '0644',
    },
    {
      action: 'write',
      targetPath: 'plugin.json',
      digest: bytesDigest(manifestContent),
      content: manifestContent,
      mode: '0644',
    },
  ]
  const packageDigest = bytesDigest(
    stableJson({
      algorithm: 'adea-package-files/1',
      files: files
        .map((file) => ({
          digest: file.digest,
          mode: file.action === 'copy' ? 'preserve-source' : file.mode,
          path: file.targetPath,
        }))
        .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    })
  )
  return {
    contractVersion: 1,
    normalizerVersion: 'adea-agent-plugins/1',
    format: 'agent-plugins',
    specVersion: '1.0.0',
    originFormat: 'agent-plugins',
    sourceDigest,
    status: 'portable',
    manifest,
    packageDigest,
    files,
    skills: [{ name: 'review', path: 'skills/review', description: 'Review changes' }],
    mcpServers: {},
    nonPortable: [],
    diagnostics: [],
    requirements: { skills: true, mcpTransports: [], executables: [], environmentReview: false },
  }
}

let marketplaceSnapshotCache

function marketplaceSnapshot() {
  if (marketplaceSnapshotCache !== undefined) return marketplaceSnapshotCache
  const sourceDigest = `sha256:${'a'.repeat(64)}`
  const release = {
    releaseId: `release:${'b'.repeat(64)}`,
    resolvedRepositoryUrl: 'https://github.com/example/plugins',
    resolvedCommitSha: 'c'.repeat(40),
    pluginSubdirectory: 'plugins/demo',
    canonicalContentDigest: sourceDigest,
    manifestDigest: `sha256:${'d'.repeat(64)}`,
    contentResolution: 'complete',
    fileIndex: ['skills/review/SKILL.md', 'mcp.json', 'plugin.json'],
    releaseMetadata: { agentPlugins: agentPackageFixture(sourceDigest) },
    requiredConnectors: [],
    requiredCredentials: [],
  }
  const plugin = {
    pluginId: 'plugin:example:demo',
    displayName: 'Demo',
    description: 'Demo plugin',
    sourceId: 'example',
    productGroupingKey: 'example',
    currentReleaseId: release.releaseId,
    availableReleases: [release],
    harnessCompatibility: { codex: { status: 'portable' } },
    securityClassification: { level: 'low' },
    provenance: {},
  }
  const catalogBody = {
    schemaVersion: 1,
    generatedAt: '2026-09-21T00:00:00.000Z',
    sources: [{ sourceId: 'example' }],
    plugins: [plugin],
  }
  const catalogId = `catalog:${bytesDigest(canonicalJson(catalogBody)).slice('sha256:'.length)}`
  const catalog = { ...catalogBody, catalogId }
  const catalogText = JSON.stringify(catalog)
  const files = {
    'catalog.v1.json': catalogText,
    'catalog-summary.v1.json': JSON.stringify({ catalogId, pluginCount: 1, schemaVersion: 1 }),
    'categories.v1.json': JSON.stringify({ categories: [], catalogId, schemaVersion: 1 }),
    'compatibility.v1.json': JSON.stringify({ catalogId, plugins: [], schemaVersion: 1 }),
    'sources.lock.json': JSON.stringify({ catalogId, schemaVersion: 1, sources: [] }),
  }
  const integrity = Object.fromEntries(
    [
      'catalog.v1.json',
      'catalog-summary.v1.json',
      'categories.v1.json',
      'compatibility.v1.json',
      'sources.lock.json',
    ].map((name) => [name, artifactDigest(files[name])])
  )
  marketplaceSnapshotCache = {
    artifacts: {
      ...files,
      'catalog-latest.v1.json': catalogText,
      'integrity.json': JSON.stringify({ catalogId, files: integrity, schemaVersion: 1 }),
    },
    releaseId: release.releaseId,
    sourceDigest,
  }
  return marketplaceSnapshotCache
}
