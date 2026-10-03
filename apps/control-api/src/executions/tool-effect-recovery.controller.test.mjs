import { expect, test } from 'bun:test'
import { ControlApiFixtures, ErrorResponseEnvelopeSchema } from '@control-plane/contracts'
import { createControlApiApplication, createOpenApiDocument } from '../application.ts'
import { PolicyServiceAuthenticator } from '../auth/service-authentication.ts'

const base = ControlApiFixtures.executionAcceptance.request
const inspectRequest = {
  caller: base.caller,
  contractVersion: base.contractVersion,
  requestId: base.requestId,
  workspaceId: base.workspaceId,
  projectId: base.projectId,
  correlation: base.correlation,
  operation: 'execution.tool-effect.inspect',
  requestedAt: base.issuedAt,
  parameters: {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
  },
}
const reconcileRequest = {
  ...base,
  operation: 'execution.tool-effect.reconcile',
  payload: {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
    expectedRevision: 3,
    action: 'resume',
  },
}
const metadata = {
  serviceName: 'control-api',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'tool-effect-recovery-test',
}

async function withApp(options, run) {
  const calls = []
  const claims = {
    audience: 'control-plane',
    credentialId: 'credential-tool-effect-recovery-test',
    credentialKind: 'service',
    expiresAt: '2026-08-23T13:00:00.000Z',
    issuedAt: '2026-08-23T12:00:00.000Z',
    issuer: 'https://agent-hq.example',
    keyId: 'test-key',
    principalId: base.caller.servicePrincipalId,
    workspaceIds: [base.workspaceId],
    projectIds: [base.projectId],
    scopes: ['execution:reconcile'],
    ...options.claims,
  }
  const application = await createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    metadata,
    logger: { write: () => undefined },
    serviceAuthenticator: new PolicyServiceAuthenticator({
      audience: 'control-plane',
      issuer: claims.issuer,
      clockSkewMs: 30_000,
      now: () => new Date('2026-08-23T12:00:00.000Z'),
      logger: { write: () => undefined },
      verifier: { verify: async () => claims },
      revocationChecker: { isRevoked: async () => false },
    }),
    ...(options.unconfigured
      ? {}
      : {
          toolEffectRecoveryService: {
            inspect: async (...args) => {
              calls.push(['inspect', ...args])
              if (options.error) throw new Error(options.error)
              return { calls: [], redacted: true }
            },
            reconcile: async (...args) => {
              calls.push(['reconcile', ...args])
              if (options.error) throw new Error(options.error)
              return { outcome: 'recovery_scheduled' }
            },
          },
        }),
  })
  try {
    await run(application, calls)
  } finally {
    await application.close()
  }
}

const inject = (application, url, payload, headers = { authorization: 'Bearer recovery-token' }) =>
  application.inject({ method: 'POST', url, headers, payload })

test('authenticated inspect and reconcile routes expose only bounded service results', async () =>
  withApp({}, async (application, calls) => {
    const paths = createOpenApiDocument(application).paths
    expect(paths['/v1/executions/tool-effects/inspect']).toBeDefined()
    expect(paths['/v1/executions/tool-effects/reconcile']).toBeDefined()

    const inspected = await inject(
      application,
      '/v1/executions/tool-effects/inspect',
      inspectRequest
    )
    expect(inspected.statusCode).toBe(200)
    expect(inspected.json()).toEqual({ calls: [], redacted: true })

    const reconciled = await inject(
      application,
      '/v1/executions/tool-effects/reconcile',
      reconcileRequest
    )
    expect(reconciled.statusCode).toBe(202)
    expect(reconciled.json()).toEqual({ outcome: 'recovery_scheduled' })
    expect(calls.map(([operation]) => operation)).toEqual(['inspect', 'reconcile'])
    expect(calls[0][1]).toMatchObject({
      operation: inspectRequest.operation,
      parameters: inspectRequest.parameters,
    })
    expect(calls[0][2]).toMatchObject({
      principalId: base.caller.servicePrincipalId,
      workspaceIds: [base.workspaceId],
      projectIds: [base.projectId],
      scopes: ['execution:reconcile'],
    })
  }))

test.each([
  { scopes: ['execution:accept'] },
  { workspaceIds: [`${base.workspaceId.slice(0, -1)}H`] },
  { projectIds: [`${base.projectId.slice(0, -1)}H`] },
])('reconciliation scope and tenant claims are enforced before service calls %#', async (claims) =>
  withApp({ claims }, async (application, calls) => {
    expect(
      (await inject(application, '/v1/executions/tool-effects/inspect', inspectRequest)).statusCode
    ).toBe(403)
    expect(calls).toEqual([])
  })
)

test('missing credentials and malformed operations are rejected before service invocation', async () =>
  withApp({}, async (application, calls) => {
    expect(
      (await inject(application, '/v1/executions/tool-effects/inspect', inspectRequest, {}))
        .statusCode
    ).toBe(401)
    expect(
      (
        await inject(application, '/v1/executions/tool-effects/inspect', {
          ...inspectRequest,
          operation: 'execution.inspect',
        })
      ).statusCode
    ).toBe(400)
    expect(calls).toEqual([])
  }))

test.each([
  ['TOOL_EFFECT_SCOPE_REJECTED', 403],
  ['TOOL_EFFECT_STALE_REVISION', 409],
  ['private storage detail', 503],
])('normalizes recovery service errors without exposing internals: %s', async (error, status) =>
  withApp({ error }, async (application) => {
    const response = await inject(
      application,
      '/v1/executions/tool-effects/reconcile',
      reconcileRequest
    )
    expect(response.statusCode).toBe(status)
    const normalized = ErrorResponseEnvelopeSchema.parse(response.json())
    expect(normalized.requestId).toBe(reconcileRequest.requestId)
    expect(normalized.error.class).toBe(
      status === 403 ? 'authorization' : status === 409 ? 'conflict' : 'runtime_unavailable'
    )
    expect(response.body).not.toContain('private storage detail')
  })
)

test('unconfigured profiles fail closed for recovery endpoints', async () =>
  withApp({ unconfigured: true }, async (application) => {
    const response = await inject(
      application,
      '/v1/executions/tool-effects/inspect',
      inspectRequest
    )
    expect(response.statusCode).toBe(503)
  }))
