import { describe, expect, test } from 'bun:test'
import {
  CredentialVault,
  InMemoryCredentialVaultRepository,
  NeonEncryptedSecretProvider,
  VaultToolCredentialBroker,
} from '@control-plane/credential-vault'
import { McpAdapter, McpAdapterError } from './mcp-adapter.ts'
import { InMemoryToolRegistryRepository, ToolGateway, ToolRegistry } from './tool-registry.ts'
import {
  InMemoryToolCallRepository,
  InMemoryToolRateLimiter,
  PolicyControlledToolExecutionService,
  StaticToolPolicyAuthorizer,
} from './tool-execution.ts'

const ids = {
  workspace: 'wsp_01JABCDEF0123456789ABCDEFG',
  otherWorkspace: 'wsp_01JABCDEF0123456789ABCDEFH',
  profile: 'prf_01JABCDEF0123456789ABCDEFG',
  execution: 'exe_01JABCDEF0123456789ABCDEFG',
  attempt: 'att_01JABCDEF0123456789ABCDEFG',
  request: 'req_01JABCDEF0123456789ABCDEFG',
  trace: 'trc_01JABCDEF0123456789ABCDEFG',
  call: 'tlc_01JABCDEF0123456789ABCDEFG',
  credential: 'crd_01JABCDEF0123456789ABCDEFG',
}
const secret = 'fixture-connector-SECRET-canary-2d81'
const rotatedSecret = 'fixture-connector-SECRET-canary-rotated-77f0'
const snapshot = { policyId: 'workspace-standard', version: 3, digest: `sha256:${'a'.repeat(64)}` }
const now = '2026-10-06T12:00:00.000Z'
const schema = {
  input: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { issues: { type: 'array', items: { type: 'string' } } },
    required: ['issues'],
    additionalProperties: false,
  },
}

/** A fixture connector that requires the leased secret on every call. */
class FixtureConnectorClient {
  enforcesRawDiscoveryLimit = true
  invocations = 0
  observedCredentials = []
  behaviour = 'ok'
  expected = secret
  async discover() {
    return [
      {
        name: 'issues_search',
        description: 'Searches issues.',
        version: '1',
        inputSchema: schema.input,
        outputSchema: schema.output,
        readOnly: true,
      },
    ]
  }
  async invoke(request) {
    this.invocations += 1
    this.observedCredentials.push(request.credential === this.expected)
    if (request.credential !== this.expected) {
      throw Object.assign(new Error('unauthorized'), { code: 'MCP_UNAUTHORIZED' })
    }
    if (this.behaviour === 'echo') return { issues: [`token=${request.credential}`] }
    if (this.behaviour === 'leaky-error') {
      throw Object.assign(new Error(`upstream rejected ${request.credential}`), {
        code: `bad code ${request.credential}`,
      })
    }
    return { issues: ['ENG-1'] }
  }
}

function makeIds() {
  let value = 0
  const suffixes = ['G', 'H', 'J', 'K', 'M', 'N', 'P', 'Q']
  return {
    definition: () => `tld_01JABCDEF0123456789ABCDEF${suffixes[value++]}`,
    version: () => `tlv_01JABCDEF0123456789ABCDEF${suffixes[value++]}`,
  }
}

async function fixture() {
  const policyRequests = []
  const records = new Map()
  const vault = new CredentialVault({
    provider: new NeonEncryptedSecretProvider({
      store: {
        async put(input) {
          records.set(`${input.locator}:${input.version}`, input)
        },
        async get(input) {
          return records.get(`${input.locator}:${input.version}`)
        },
        async delete(input) {
          records.delete(`${input.locator}:${input.version}`)
        },
      },
      encryptionKey: 'e'.repeat(64),
      keyReference: 'fixture-key/v1',
    }),
    repository: new InMemoryCredentialVaultRepository(),
    decisionPoint: {
      async authorize(request) {
        policyRequests.push(request)
        return {
          effect: 'allow',
          decisionId: `sha256:${'b'.repeat(64)}`,
          reasonCode: 'CEDAR_PERMIT',
          policySnapshot: request.policySnapshot,
          evaluatedAt: request.context.requestedAt,
        }
      },
    },
    now: () => now,
  })
  await vault.create({
    credentialId: ids.credential,
    workspaceId: ids.workspace,
    connectorRef: 'connector:issues',
    provider: 'issues',
    secret,
    createdAt: now,
    createdBy: 'svc_agent-hq',
  })
  const broker = new VaultToolCredentialBroker({
    vault,
    policySnapshot: (workspaceId) => (workspaceId === ids.workspace ? snapshot : undefined),
    now: () => new Date(now),
  })
  const client = new FixtureConnectorClient()
  const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
  const gateway = new ToolGateway(registry)
  const adapter = new McpAdapter({
    registration: {
      serverId: 'issues',
      credentialRef: 'vault://connector/issues',
      connectorRef: 'connector:issues',
    },
    workspaceId: ids.workspace,
    client,
    credentialBroker: broker,
    registry,
    gateway,
    ids: makeIds(),
    limits: { maxInputBytes: 1_048_576, maxOutputBytes: 1_048_576, timeoutMs: 1_000 },
    now: () => now,
  })
  const [version] = await adapter.refresh()
  const request = {
    requestId: ids.request,
    executionId: ids.execution,
    attemptId: ids.attempt,
    workspaceId: ids.workspace,
    profileId: ids.profile,
    toolDefinitionId: version.toolDefinitionId,
    toolVersionId: version.toolVersionId,
    operation: 'invoke',
    input: { query: 'open' },
    grant: {
      workspaceId: ids.workspace,
      profileId: ids.profile,
      toolDefinitionId: version.toolDefinitionId,
      toolVersionId: version.toolVersionId,
      operations: ['invoke'],
    },
    audit: { principalRef: 'service:runtime-worker', traceId: ids.trace },
  }
  const invoke = async () => gateway.invoke(await gateway.prepare(request))
  return { adapter, vault, client, gateway, registry, request, version, policyRequests, invoke }
}

describe('MCP adapter credential leases', () => {
  test('leases the workspace connector credential per call through policy and keeps it out of durable records', async () => {
    const { vault, client, gateway, registry, request, policyRequests } = await fixture()
    const calls = new InMemoryToolCallRepository()
    const service = new PolicyControlledToolExecutionService({
      gateway,
      calls,
      authorizer: new StaticToolPolicyAuthorizer({
        effect: 'allow',
        decisionId: 'tool-allow-1',
        policyVersion: 'workspace-v3',
        reasonCode: 'GRANTED',
        requiresApproval: false,
        evaluatedAt: now,
      }),
      approvals: {
        review: async () => {
          throw new Error('approval not expected')
        },
      },
      rateLimiter: new InMemoryToolRateLimiter(),
    })
    const outcome = await service.execute({
      ...request,
      toolCallId: ids.call,
      idempotencyKey: 'mcp-credential-call-0001',
      requestedAt: now,
      policySnapshotRef: 'policy://workspace/v3',
    })
    expect(outcome).toMatchObject({ state: 'succeeded', result: { output: { issues: ['ENG-1'] } } })
    expect(client.observedCredentials).toEqual([true])
    expect(policyRequests).toHaveLength(1)
    expect(policyRequests[0]).toMatchObject({
      action: 'credential:lease',
      principal: { id: 'service:runtime-worker', workspaceId: ids.workspace },
      resource: {
        type: 'credential',
        id: ids.credential,
        workspaceId: ids.workspace,
        attributes: {
          connectorRef: 'connector:issues',
          operation: 'invoke',
          resourceRef: 'mcp/issues/issues_search',
        },
      },
      policySnapshot: snapshot,
    })
    const audit = await vault.audit({ workspaceId: ids.workspace })
    expect(audit.map(({ action }) => action)).toEqual([
      'credential.created',
      'lease.issued',
      'lease.used',
    ])
    const durable = JSON.stringify({
      outcome,
      call: await calls.get(ids.workspace, ids.call),
      registry: await registry.list(ids.workspace),
      audit,
    })
    expect(durable.includes(secret)).toBe(false)
    expect(durable.includes('vault://')).toBe(false)
  })

  test('every call takes a fresh lease, so rotation and revocation apply to the next call', async () => {
    const { vault, client, invoke, policyRequests } = await fixture()
    await expect(invoke()).resolves.toMatchObject({ output: { issues: ['ENG-1'] } })
    await vault.rotate(ids.credential, rotatedSecret, 'svc_agent-hq')
    client.expected = rotatedSecret
    await expect(invoke()).resolves.toMatchObject({ output: { issues: ['ENG-1'] } })
    expect(policyRequests).toHaveLength(2)
    await vault.revoke(ids.credential, 'svc_agent-hq')
    const before = client.invocations
    await expect(invoke()).rejects.toMatchObject({
      code: 'EXECUTION_FAILED',
      executorCode: 'MCP_CREDENTIAL_MISSING',
    })
    expect(client.invocations).toBe(before)
  })

  test('fails closed without a live credential or for another workspace', async () => {
    const { adapter, vault, client, invoke, request, version } = await fixture()
    await expect(
      adapter.execute(
        { ...request, workspaceId: ids.otherWorkspace },
        version,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'MCP_CREDENTIAL_SCOPE_MISMATCH', effectState: 'none' })
    await vault.revoke(ids.credential, 'svc_agent-hq')
    await expect(invoke()).rejects.toMatchObject({ executorCode: 'MCP_CREDENTIAL_MISSING' })
    expect(client.invocations).toBe(0)
  })

  test('blocks secret echo and never surfaces transport errors that contain the secret', async () => {
    const { client, invoke } = await fixture()
    client.behaviour = 'echo'
    const echoed = await invoke().catch((error) => error)
    expect(echoed).toMatchObject({ executorCode: 'MCP_CREDENTIAL_EGRESS_BLOCKED' })
    expect(JSON.stringify(echoed).includes(secret)).toBe(false)
    expect(String(echoed.message).includes(secret)).toBe(false)

    client.behaviour = 'leaky-error'
    const leaked = await invoke().catch((error) => error)
    expect(leaked).toMatchObject({ executorCode: 'MCP_PROTOCOL_ERROR' })
    expect(JSON.stringify(leaked).includes(secret)).toBe(false)
    expect(String(leaked.message).includes(secret)).toBe(false)
  })

  test('requires a credential broker when a registration names a connector', () => {
    const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
    expect(
      () =>
        new McpAdapter({
          registration: {
            serverId: 'issues',
            credentialRef: 'vault://connector/issues',
            connectorRef: 'connector:issues',
          },
          workspaceId: ids.workspace,
          client: new FixtureConnectorClient(),
          registry,
          gateway: new ToolGateway(registry),
          ids: makeIds(),
        })
    ).toThrow(McpAdapterError)
  })
})
