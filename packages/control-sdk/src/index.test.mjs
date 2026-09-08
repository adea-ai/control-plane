import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import {
  ControlApiFixtures,
  ControlPlaneClient,
  ControlPlaneClientError,
  PublicContractManifest,
} from './index.ts'

describe('Control Plane SDK public client', () => {
  test('interaction command sends exact scope and validates the acknowledgement', async () => {
    const calls = []
    const client = new ControlPlaneClient({
      baseUrl: 'https://control-plane.test/root/',
      credential: 'interaction-token',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        return Response.json(ControlApiFixtures.interactionResponse.response)
      },
    })
    expect(
      await client.respondToInteraction(ControlApiFixtures.interactionResponse.request)
    ).toEqual(ControlApiFixtures.interactionResponse.response)
    expect(calls[0].url).toBe('https://control-plane.test/root/v1/interactions/respond')
    expect(calls[0].init.headers.authorization).toBe('Bearer interaction-token')
    expect(JSON.parse(calls[0].init.body)).toEqual(ControlApiFixtures.interactionResponse.request)
    await expect(
      client.respondToInteraction({
        ...ControlApiFixtures.interactionResponse.request,
        respondingPrincipalId: 'svc_other',
      })
    ).rejects.toThrow()
    expect(calls).toHaveLength(1)
    const invalid = new ControlPlaneClient({
      baseUrl: 'https://control-plane.test',
      credential: 'token',
      fetch: async () =>
        Response.json({
          ...ControlApiFixtures.interactionResponse.response,
          data: { ...ControlApiFixtures.interactionResponse.response.data, status: 'completed' },
        }),
    })
    await expect(
      invalid.respondToInteraction(ControlApiFixtures.interactionResponse.request)
    ).rejects.toBeInstanceOf(ControlPlaneClientError)
  })
  test('sends validated requests with service authentication and correlation headers', async () => {
    const calls = []
    const client = new ControlPlaneClient({
      baseUrl: 'https://control-plane.test/root/',
      credential: async () => 'service-token',
      fetch: async (url, init) => {
        calls.push({ url, init })
        return globalThis.Response.json(ControlApiFixtures.profileResolution.response)
      },
    })

    const response = await client.resolveProfile(ControlApiFixtures.profileResolution.request)

    expect(response).toEqual(ControlApiFixtures.profileResolution.response)
    expect(calls).toHaveLength(1)
    expect(String(calls[0].url)).toBe('https://control-plane.test/root/v1/profiles/resolve')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.redirect).toBe('error')
    expect(calls[0].init.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer service-token',
      'content-type': 'application/json',
      'x-correlation-id': 'trc_01JABCDEF0123456789ABCDEFG',
      'x-request-id': 'req_01JABCDEF0123456789ABCDEFG',
    })
  })

  test('submits execution acceptance commands through the versioned idempotent operation', async () => {
    const calls = []
    const client = new ControlPlaneClient({
      baseUrl: 'https://control-plane.test',
      credential: 'service-token',
      fetch: async (url, init) => {
        calls.push({ url, init })
        return globalThis.Response.json(ControlApiFixtures.executionAcceptance.response)
      },
    })

    const response = await client.acceptExecution(ControlApiFixtures.executionAcceptance.request)

    expect(response).toEqual(ControlApiFixtures.executionAcceptance.response)
    expect(String(calls[0].url)).toBe('https://control-plane.test/v1/executions/accept')
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      operation: 'execution.accept',
      idempotencyKey: 'intent-01JABCDEF0123456789ABCDEFG',
    })
  })

  test('lists and gets normalized runtime and session discovery models through versioned operations', async () => {
    const calls = []
    const response = runtimeDiscoveryResponse()
    const sessionResponse = externalSessionDiscoveryResponse()
    const client = new ControlPlaneClient({
      baseUrl: 'https://control-plane.test',
      credential: 'service-token',
      fetch: async (url, init) => {
        calls.push({ url, init })
        if (String(url).includes('/external-sessions/')) {
          return globalThis.Response.json(
            String(url).endsWith('/get')
              ? {
                  ...sessionResponse,
                  data: { externalSession: sessionResponse.data.externalSessions[0] },
                }
              : sessionResponse
          )
        }
        return globalThis.Response.json(
          String(url).endsWith('/get')
            ? {
                ...response,
                data: { runtimeConnection: response.data.runtimeConnections[0] },
              }
            : response
        )
      },
    })

    await expect(client.listRuntimeConnections(runtimeDiscoveryRequest())).resolves.toEqual(
      response
    )
    await expect(
      client.getRuntimeConnection({
        ...runtimeDiscoveryRequest(),
        operation: 'runtime-connection.get',
        parameters: {
          runtimeConnectionId: response.data.runtimeConnections[0].runtimeConnectionId,
        },
      })
    ).resolves.toEqual({
      ...response,
      data: { runtimeConnection: response.data.runtimeConnections[0] },
    })
    await expect(client.listExternalSessions(externalSessionDiscoveryRequest())).resolves.toEqual(
      sessionResponse
    )
    await expect(
      client.getExternalSession({
        ...externalSessionDiscoveryRequest(),
        operation: 'external-session.get',
        parameters: {
          externalSessionId: sessionResponse.data.externalSessions[0].externalSessionId,
        },
      })
    ).resolves.toEqual({
      ...sessionResponse,
      data: { externalSession: sessionResponse.data.externalSessions[0] },
    })

    expect(String(calls[0].url)).toBe('https://control-plane.test/v1/runtime-connections/list')
    expect(String(calls[1].url)).toBe('https://control-plane.test/v1/runtime-connections/get')
    expect(String(calls[2].url)).toBe('https://control-plane.test/v1/external-sessions/list')
    expect(String(calls[3].url)).toBe('https://control-plane.test/v1/external-sessions/get')
  })

  test('protects service credentials from insecure remote transport', () => {
    expect(
      () =>
        new ControlPlaneClient({
          baseUrl: 'http://control-plane.test',
          credential: 'service-token',
        })
    ).toThrow('HTTPS')

    expect(
      () =>
        new ControlPlaneClient({
          baseUrl: 'http://127.0.0.1:4321',
          credential: 'stub-token',
        })
    ).not.toThrow()
  })

  test('fails closed on normalized server errors without retaining credentials', async () => {
    const client = new ControlPlaneClient({
      baseUrl: 'https://control-plane.test',
      credential: 'super-secret-token',
      fetch: async () =>
        globalThis.Response.json(
          {
            ...ControlApiFixtures.authentication.response,
            data: undefined,
            error: {
              class: 'authentication',
              code: 'SERVICE_CREDENTIAL_REVOKED',
              message: 'Service credential is not accepted',
              retryable: false,
              source: 'auth',
            },
          },
          { status: 401 }
        ),
    })

    await expect(
      client.verifyAuthentication(ControlApiFixtures.authentication.request)
    ).rejects.toMatchObject({
      name: 'ControlPlaneClientError',
      code: 'SERVICE_CREDENTIAL_REVOKED',
      errorClass: 'authentication',
      retryable: false,
      status: 401,
    })

    try {
      await client.verifyAuthentication(ControlApiFixtures.authentication.request)
    } catch (error) {
      expect(error).toBeInstanceOf(ControlPlaneClientError)
      expect(JSON.stringify(error)).not.toContain('super-secret-token')
    }
  })

  test('rejects malformed success payloads and incompatible contract majors', async () => {
    const malformedClient = new ControlPlaneClient({
      baseUrl: 'https://control-plane.test',
      credential: 'token',
      fetch: async () => globalThis.Response.json({ data: { profile: { databaseId: 42 } } }),
    })
    await expect(
      malformedClient.resolveProfile(ControlApiFixtures.profileResolution.request)
    ).rejects.toMatchObject({ code: 'INVALID_CONTROL_PLANE_RESPONSE', retryable: false })

    const incompatibleClient = new ControlPlaneClient({
      baseUrl: 'https://control-plane.test',
      credential: 'token',
      fetch: async () =>
        globalThis.Response.json({
          ...ControlApiFixtures.runtimeList.response,
          contractVersion: { major: 1, minor: 0 },
        }),
    })
    await expect(
      incompatibleClient.listRuntimes(ControlApiFixtures.runtimeList.request)
    ).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT_VERSION', retryable: false })
  })

  test('publishes only the contracts dependency and stable public entry points', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const releaseManifest = JSON.parse(
      await readFile(new URL('../../../.release-please-manifest.json', import.meta.url), 'utf8')
    )
    const publicModule = await import('./index.ts')
    const serializedExports = Object.keys(publicModule).join(' ').toLowerCase()

    expect(manifest).toMatchObject({
      name: '@control-plane/sdk',
      license: 'Apache-2.0',
      dependencies: { '@control-plane/contracts': 'workspace:^' },
      publishConfig: { access: 'public', provenance: true },
    })
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.version).toBe(releaseManifest['packages/control-sdk'])
    expect(manifest.private).toBeUndefined()
    expect(PublicContractManifest.current).toEqual({ major: 3, minor: 0 })
    for (const prohibited of [
      'database',
      'drizzle',
      'temporal',
      'langgraph',
      'secret-manager',
      'executionplancompiler',
    ]) {
      expect(serializedExports).not.toContain(prohibited)
      expect(JSON.stringify(manifest).toLowerCase()).not.toContain(prohibited)
    }
  })
})

function runtimeDiscoveryRequest() {
  return {
    caller: { servicePrincipalId: 'svc_agent-hq' },
    contractVersion: { major: 3, minor: 0 },
    correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
    operation: 'runtime-connection.list',
    parameters: { limit: 50, states: [], requiredCapabilities: [] },
    projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    requestedAt: '2026-08-24T12:00:00.000Z',
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  }
}

function runtimeDiscoveryResponse() {
  return {
    contractVersion: { major: 3, minor: 0 },
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
    data: {
      runtimeConnections: [
        {
          runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
          runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
          family: 'codex',
          connectionType: 'managed_cloud',
          location: 'agent_hq_cloud',
          status: 'available',
          connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
          freshness: {
            state: 'fresh',
            observedAt: '2026-08-24T11:59:00.000Z',
            expiresAt: '2026-08-24T12:05:00.000Z',
          },
          versions: { adapter: '1.2.0', driver: '1.1.0', harness: '2.0.0' },
          capabilities: ['session.resume'],
          capabilityDetails: [{ name: 'session.resume', support: 'supported' }],
          compatibility: { state: 'compatible', limitations: [] },
          access: {
            localProjectGrant: { required: false, state: 'not_required' },
            entitlement: { state: 'allowed', class: 'standard' },
          },
          eligibility: {
            state: 'eligible',
            reasons: [],
            degradations: [],
            remediation: [],
          },
          observedAt: '2026-08-24T11:59:00.000Z',
          limitations: [],
        },
      ],
      page: {},
    },
  }
}

function externalSessionDiscoveryRequest() {
  return {
    ...runtimeDiscoveryRequest(),
    operation: 'external-session.list',
    parameters: { limit: 50, states: [] },
  }
}

function externalSessionDiscoveryResponse() {
  return {
    contractVersion: { major: 3, minor: 0 },
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
    data: {
      externalSessions: [
        {
          externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
          runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
          projectId: 'prj_01JABCDEF0123456789ABCDEFG',
          state: 'offline',
          recoverable: true,
          display: { origin: 'native_discovery', displayName: 'Planning session' },
          freshness: {
            state: 'fresh',
            observedAt: '2026-08-24T11:59:00.000Z',
            expiresAt: '2026-08-24T12:05:00.000Z',
          },
          capabilitySummary: {
            version: 1,
            operations: ['session.resume'],
            controls: {
              reference: { available: true },
              resume: { available: false, reason: 'RUNTIME_OFFLINE' },
              load: { available: false, reason: 'RUNTIME_OFFLINE' },
              close: { available: false, reason: 'RUNTIME_OFFLINE' },
              history: { available: false, reason: 'RUNTIME_OFFLINE' },
            },
          },
          limitations: ['RUNTIME_OFFLINE'],
        },
      ],
      page: {},
    },
  }
}
