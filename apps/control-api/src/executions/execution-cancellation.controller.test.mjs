import { expect, test } from 'bun:test'
import { ControlApiFixtures, ErrorResponseEnvelopeSchema } from '@control-plane/contracts'
import { createControlApiApplication, createOpenApiDocument } from '../application.ts'
import { PolicyServiceAuthenticator } from '../auth/service-authentication.ts'

const request = {
  ...ControlApiFixtures.executionAcceptance.request,
  operation: 'execution.cancel',
  payload: {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  },
}
const result = {
  contractVersion: request.contractVersion,
  requestId: request.requestId,
  correlation: request.correlation,
  data: {
    commandId: request.commandId,
    ...request.payload,
    status: 'accepted',
    replayed: false,
  },
}
const metadata = {
  serviceName: 'control-api',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'cancellation-test',
}
async function withApp(options, run) {
  const calls = []
  const claims = {
    audience: 'control-plane',
    credentialId: 'credential-cancellation-test',
    credentialKind: 'service',
    expiresAt: '2026-08-23T13:00:00.000Z',
    issuedAt: '2026-08-23T12:00:00.000Z',
    issuer: 'https://agent-hq.example',
    keyId: 'test-key',
    principalId: request.caller.servicePrincipalId,
    workspaceIds: [request.workspaceId],
    projectIds: [request.projectId],
    scopes: ['execution:cancel'],
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
      clockSkewMs: 30000,
      now: () => new Date('2026-08-23T12:00:00.000Z'),
      logger: { write: () => undefined },
      verifier: { verify: async () => claims },
      revocationChecker: { isRevoked: async () => false },
    }),
    ...(options.unconfigured
      ? {}
      : {
          executionCancellationService: {
            cancel: async (...args) => {
              calls.push(args)
              if (options.error) throw new Error(options.error)
              return result
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
const inject = (
  application,
  payload = request,
  headers = { authorization: 'Bearer valid-cancellation-token' }
) => application.inject({ method: 'POST', url: '/v1/executions/cancel', headers, payload })

test('versioned cancellation route requires a scoped authenticated caller and returns signal acceptance', async () =>
  withApp({}, async (application, calls) => {
    expect(createOpenApiDocument(application).paths['/v1/executions/cancel']).toBeDefined()
    const response = await inject(application)
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual(result)
    expect(calls).toEqual([[request, request.caller.servicePrincipalId]])
  }))

test.each([
  { scopes: ['execution:accept'] },
  { workspaceIds: [`${request.workspaceId.slice(0, -1)}H`] },
  { projectIds: [`${request.projectId.slice(0, -1)}H`] },
])('wrong credential scope cannot invoke the cancellation service %#', async (claims) =>
  withApp({ claims }, async (application, calls) => {
    expect((await inject(application)).statusCode).toBe(403)
    expect(calls).toEqual([])
  })
)

test('missing credentials and spoofed command authority are rejected before service invocation', async () =>
  withApp({}, async (application, calls) => {
    expect((await inject(application, request, {})).statusCode).toBe(401)
    expect(
      (await inject(application, { ...request, respondingPrincipalId: 'svc_other' })).statusCode
    ).toBe(400)
    expect(calls).toEqual([])
  }))

test.each([
  ['EXECUTION_CANCELLATION_CALLER_MISMATCH', 403],
  ['EXECUTION_CANCELLATION_SCOPE_REJECTED', 403],
  ['EXECUTION_CANCELLATION_PAYLOAD_CONFLICT', 409],
  ['EXECUTION_CANCELLATION_EXECUTION_INACTIVE', 409],
  ['private infrastructure detail', 503],
])('normalizes command errors without exposing infrastructure details: %s', async (error, status) =>
  withApp({ error }, async (application) => {
    const response = await inject(application)
    expect(response.statusCode).toBe(status)
    const envelope = ErrorResponseEnvelopeSchema.parse(response.json())
    expect(envelope.requestId).toBe(request.requestId)
    expect(envelope.error.class).toBe(
      status === 403 ? 'authorization' : status === 409 ? 'conflict' : 'runtime_unavailable'
    )
    expect(envelope.error.retryable).toBe(status === 503)
    expect(response.body).not.toContain('private infrastructure detail')
  })
)

test('profiles without durable cancellation service fail closed', async () =>
  withApp({ unconfigured: true }, async (application) => {
    expect((await inject(application)).statusCode).toBe(503)
  }))
