import { expect, test } from 'bun:test'
import { PublicContractFixtures } from '@control-plane/contracts'
import { createControlApiApplication } from '../application.ts'
import { PolicyServiceAuthenticator } from '../auth/service-authentication.ts'
import {
  PI_DURABLE_MANAGEMENT_CURRENT_OPERATION,
  parsePiDurableManagementCurrentAssertion,
  PiDurableManagementCurrentController,
  UnavailablePiDurableCurrentToolAuthority,
} from './management-current.controller.ts'

const request = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  input: { objective: 'exact retained tool input' },
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
}
const { projectId: _projectId, ...envelopeBase } = PublicContractFixtures.request
const envelope = {
  ...envelopeBase,
  operation: PI_DURABLE_MANAGEMENT_CURRENT_OPERATION,
  parameters: { boundary: 'effect', request },
}
const servicePrincipal = {
  kind: 'agent_hq_service',
  principalId: envelope.caller.servicePrincipalId,
  projectIds: [],
  scopes: ['execution:read'],
  workspaceIds: [envelope.workspaceId],
}
const metadata = {
  serviceName: 'control-api',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'management-current-test',
}

function controller(authority) {
  return new PiDurableManagementCurrentController(authority)
}

function fastifyRequest() {
  return { servicePrincipal }
}

async function refusal(promise) {
  try {
    await promise
    throw new Error('EXPECTED_REFUSAL')
  } catch (error) {
    return error?.getResponse?.() ?? error?.response ?? error
  }
}

async function withApp(options, run) {
  const calls = []
  const claims = {
    audience: 'control-plane',
    credentialId: 'credential-management-current-test',
    credentialKind: 'service',
    expiresAt: '2026-08-23T13:00:00.000Z',
    issuedAt: '2026-08-23T12:00:00.000Z',
    issuer: 'https://agent-hq.example',
    keyId: 'test-key',
    principalId: envelope.caller.servicePrincipalId,
    projectIds: [],
    scopes: ['execution:read'],
    workspaceIds: [envelope.workspaceId],
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
          piDurableCurrentToolAuthority: {
            async assertCurrent(candidate, boundary) {
              calls.push({ boundary, candidate })
              if (options.error) throw new Error(options.error)
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
  payload = envelope,
  headers = { authorization: 'Bearer management-current-token' }
) =>
  application.inject({
    method: 'POST',
    url: '/v1/pi-durable/management-current/assert',
    headers,
    payload,
  })

test('passes the exact canonical request and boundary through and asserts without a grant', async () => {
  const calls = []
  const authority = {
    async assertCurrent(candidate, boundary) {
      calls.push({ boundary, candidate })
    },
  }
  const result = await controller(authority).assert(envelope, fastifyRequest())
  expect(result).toEqual({ asserted: true })
  expect(calls).toEqual([{ boundary: 'effect', candidate: request }])
})

test('the assertion is repeatable and never consumes an approval', async () => {
  let calls = 0
  const authority = {
    async assertCurrent() {
      calls++
    },
  }
  const instance = controller(authority)
  expect(await instance.assert(envelope, fastifyRequest())).toEqual({ asserted: true })
  expect(await instance.assert(envelope, fastifyRequest())).toEqual({ asserted: true })
  expect(calls).toBe(2)
})

test('a canonical rejection, a missing principal or a malformed envelope fails closed', async () => {
  const rejecting = {
    async assertCurrent() {
      throw new Error('PI_TOOL_AUTHORITY_REJECTED')
    },
  }
  expect(await refusal(controller(rejecting).assert(envelope, fastifyRequest()))).toEqual({
    code: 'PI_MANAGEMENT_CURRENT_UNAVAILABLE',
    message: 'Management current authority is unavailable',
  })
  expect(await refusal(controller(rejecting).assert(envelope, {}))).toMatchObject({
    code: 'PI_MANAGEMENT_CURRENT_UNAVAILABLE',
  })

  let calls = 0
  const counting = {
    async assertCurrent() {
      calls++
    },
  }
  const instance = controller(counting)
  for (const body of [
    null,
    {},
    { ...envelope, operation: 'execution.inspect' },
    { ...envelope, parameters: { boundary: 'effect', request, extra: true } },
    { ...envelope, parameters: { boundary: 'unknown', request } },
    { ...envelope, parameters: { boundary: 'effect', request: 1 } },
  ]) {
    expect(await refusal(instance.assert(body, fastifyRequest()))).toMatchObject({
      code: 'PI_MANAGEMENT_CURRENT_UNAVAILABLE',
    })
  }
  expect(calls).toBe(0)
})

test('the parser accepts only the exact two-key boundary envelope', () => {
  expect(parsePiDurableManagementCurrentAssertion({ boundary: 'effect', request })).toEqual({
    boundary: 'effect',
    request,
  })
  for (const invalid of [
    null,
    [],
    {},
    { request },
    { boundary: 'effect' },
    { boundary: 'nope', request },
    { boundary: 1, request },
    { boundary: 'effect', request, extra: 1 },
  ])
    expect(() => parsePiDurableManagementCurrentAssertion(invalid)).toThrow(
      'PI_MANAGEMENT_CURRENT_REQUEST_INVALID'
    )
})

test('the unavailable default fails closed with the canonical error code', async () => {
  await expect(new UnavailablePiDurableCurrentToolAuthority().assertCurrent()).rejects.toThrow(
    'PI_TOOL_AUTHORITY_REJECTED'
  )
})

test('the authenticated route asserts through the canonical authority and is repeatable', async () =>
  withApp({}, async (application, calls) => {
    const first = await inject(application)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ asserted: true })
    const second = await inject(application)
    expect(second.statusCode).toBe(200)
    expect(calls).toEqual([
      { boundary: 'effect', candidate: request },
      { boundary: 'effect', candidate: request },
    ])
  }))

test('scope, credential and authority failures are refused without a truthy grant', async () => {
  await withApp({ claims: { scopes: ['execution:reconcile'] } }, async (application) => {
    expect((await inject(application)).statusCode).toBe(403)
  })
  await withApp({}, async (application) => {
    expect((await inject(application, envelope, {})).statusCode).toBe(401)
  })
  await withApp({ error: 'PI_TOOL_AUTHORITY_REJECTED' }, async (application) => {
    const response = await inject(application)
    expect(response.statusCode).toBe(503)
    expect(response.body).not.toContain('PI_TOOL_AUTHORITY_REJECTED')
  })
})

test('an unconfigured host fails closed for the route', async () =>
  withApp({ unconfigured: true }, async (application) => {
    expect((await inject(application)).statusCode).toBe(503)
  }))
