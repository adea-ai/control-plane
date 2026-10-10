import { expect, test } from 'bun:test'
import { ControlApiFixtures, ErrorResponseEnvelopeSchema } from '@control-plane/contracts'
import { createControlApiApplication, createOpenApiDocument } from '../application.ts'
import { PolicyServiceAuthenticator } from '../auth/service-authentication.ts'

const request = {
  ...ControlApiFixtures.executionAcceptance.request,
  operation: 'execution.admission-stop',
  payload: { reasonClass: 'incident_response', reason: 'Controller proof' },
}
const result = {
  contractVersion: request.contractVersion,
  requestId: request.requestId,
  correlation: request.correlation,
  data: {
    commandId: request.commandId,
    workspaceId: request.workspaceId,
    operation: 'execution.admission-stop',
    outcome: 'applied',
    admission: 'stopped',
  },
}
const metadata = {
  serviceName: 'control-api',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'admission-control-test',
}
async function withApp(options, run) {
  const calls = []
  const claims = {
    audience: 'control-plane',
    credentialId: 'credential-admission-control-test',
    credentialKind: 'service',
    expiresAt: '2026-08-23T13:00:00.000Z',
    issuedAt: '2026-08-23T12:00:00.000Z',
    issuer: 'https://agent-hq.example',
    keyId: 'test-key',
    principalId: request.caller.servicePrincipalId,
    workspaceIds: [request.workspaceId],
    projectIds: [request.projectId],
    scopes: ['execution:admission'],
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
          admissionControlService: {
            stop: async (...args) => {
              calls.push(['stop', ...args])
              if (options.error) throw new Error(options.error)
              return result
            },
            resume: async (...args) => {
              calls.push(['resume', ...args])
              if (options.error) throw new Error(options.error)
              return {
                ...result,
                data: {
                  ...result.data,
                  operation: 'execution.admission-resume',
                  admission: 'open',
                },
              }
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
  url = '/v1/executions/admission-stop',
  headers = { authorization: 'Bearer valid-admission-token' }
) => application.inject({ method: 'POST', url, headers, payload })

test('versioned admission routes require a scoped authenticated caller and commit audited outcomes', async () =>
  withApp({}, async (application, calls) => {
    expect(createOpenApiDocument(application).paths['/v1/executions/admission-stop']).toBeDefined()
    const response = await inject(application)
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual(result)
    expect(calls).toEqual([
      [
        'stop',
        request,
        {
          kind: 'agent_hq_service',
          principalId: request.caller.servicePrincipalId,
          projectIds: [request.projectId],
          scopes: ['execution:admission'],
          workspaceIds: [request.workspaceId],
        },
      ],
    ])
  }))

test('the resume route maps to the resume operation of the same audited control', async () =>
  withApp({}, async (application, calls) => {
    const resume = { ...request, operation: 'execution.admission-resume' }
    const response = await inject(application, resume, '/v1/executions/admission-resume')
    expect(response.statusCode).toBe(202)
    expect(response.json().data).toMatchObject({
      operation: 'execution.admission-resume',
      admission: 'open',
    })
    expect(calls[0][0]).toBe('resume')
    expect(calls[0][1]).toEqual(resume)
  }))

test.each([
  { scopes: ['execution:accept'] },
  { workspaceIds: [`${request.workspaceId.slice(0, -1)}H`] },
  { projectIds: [`${request.projectId.slice(0, -1)}H`] },
])('wrong credential scope cannot invoke the admission control %#', async (claims) =>
  withApp({ claims }, async (application, calls) => {
    expect((await inject(application)).statusCode).toBe(403)
    expect(calls).toEqual([])
  })
)

test('missing credentials and malformed commands are rejected before service invocation', async () =>
  withApp({}, async (application, calls) => {
    expect(
      (await inject(application, request, '/v1/executions/admission-stop', {})).statusCode
    ).toBe(401)
    const malformed = await inject(application, {
      ...request,
      payload: { reasonClass: 'unbounded_free_text', reason: 'x' },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error.code).toBe('ADMISSION_CONTROL_INVALID')
    expect(calls).toEqual([])
  }))

test.each([
  ['ADMISSION_CONTROL_SCOPE_FORBIDDEN', 403, 'authorization'],
  ['ADMISSION_CONTROL_ACTOR_INVALID', 403, 'authorization'],
  ['ADMISSION_CONTROL_COMMAND_CONFLICT', 409, 'conflict'],
  ['ADMISSION_CONTROL_COMMAND_INVALID', 400, 'validation'],
  ['private infrastructure detail', 503, 'runtime_unavailable'],
])(
  'normalizes command errors without exposing infrastructure details: %s',
  async (error, status, errorClass) =>
    withApp({ error }, async (application, calls) => {
      const response = await inject(application)
      expect(response.statusCode).toBe(status)
      const envelope = ErrorResponseEnvelopeSchema.parse(response.json())
      expect(envelope.requestId).toBe(request.requestId)
      expect(envelope.error.class).toBe(errorClass)
      expect(envelope.error.retryable).toBe(status === 503)
      if (status === 503) expect(envelope.error.code).toBe('ADMISSION_CONTROL_UNAVAILABLE')
      expect(response.body).not.toContain('private infrastructure detail')
      expect(calls).toHaveLength(1)
    })
)

test('profiles without an admission control service fail closed with explicit unavailability', async () =>
  withApp({ unconfigured: true }, async (application) => {
    const response = await inject(application)
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('ADMISSION_CONTROL_UNAVAILABLE')
  }))
