import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  ControlApiFixtures,
  ProjectStateInitializationResponseSchema,
  canonicalJsonStringify,
} from '@control-plane/contracts'
import { InMemoryProjectStateRepository } from '@control-plane/domain'
import { createControlApiApplication, createOpenApiDocument } from '../application.ts'
import { PolicyServiceAuthenticator } from '../auth/service-authentication.ts'
import { RepositoryProjectStateInitializationService } from './project-state-initialization.service.ts'

const metadata = {
  serviceName: 'control-api',
  version: '1.4.0',
  commitSha: 'abc123',
  environment: 'test',
  instanceId: 'control-api-test',
}
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const projectId = 'prj_01JABCDEF0123456789ABCDEFG'
const otherProjectId = 'prj_01JBBCDEF0123456789ABCDEFG'
const initializedAt = '2026-10-06T12:00:00.000Z'
const scope = 'project-state:initialize'
const applications = []

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()))
})

describe('POST /v1/project-states/initialize', () => {
  test('creates an empty revision zero and returns the public reference', async () => {
    const repository = new InMemoryProjectStateRepository()
    const application = await createApplication({ repository })

    const response = await initialize(application, request())

    expect(response.statusCode).toBe(200)
    const body = ProjectStateInitializationResponseSchema.parse(response.json())
    expect(body.data).toEqual({
      projectState: { workspaceId, projectId, revision: 0 },
      commandId: request().commandId,
      initializedAt,
    })
    expect(await repository.getHistory(workspaceId, projectId)).toEqual([
      {
        schemaVersion: 1,
        workspaceId,
        projectId,
        revision: 0,
        items: [],
        createdAt: initializedAt,
        updatedAt: initializedAt,
      },
    ])
  })

  test('an exact retry returns the original result without a second revision', async () => {
    const repository = new InMemoryProjectStateRepository()
    let now = initializedAt
    const application = await createApplication({ repository, now: () => new Date(now) })
    const first = await initialize(application, request())
    now = '2026-10-06T12:01:00.000Z'
    const retry = await initialize(application, {
      ...request(),
      commandId: 'cmd_01JBBCDEF0123456789ABCDEFG',
      requestId: 'req_01JBBCDEF0123456789ABCDEFG',
    })

    expect(retry.statusCode).toBe(200)
    expect(retry.json().data).toEqual(first.json().data)
    expect(retry.json().requestId).toBe('req_01JBBCDEF0123456789ABCDEFG')
    expect(await repository.getHistory(workspaceId, projectId)).toHaveLength(1)
  })

  test('another command for an initialized project is a typed conflict', async () => {
    const application = await createApplication({
      repository: new InMemoryProjectStateRepository(),
    })
    await initialize(application, request())

    const response = await initialize(application, {
      ...request(),
      idempotencyKey: 'project-state-init:another-key',
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('PROJECT_STATE_ALREADY_INITIALIZED')
  })

  test('reusing an idempotency key under another principal assertion cannot replay', async () => {
    const repository = new InMemoryProjectStateRepository()
    const service = new RepositoryProjectStateInitializationService(repository, {
      now: () => new Date(initializedAt),
    })
    await service.initialize(request(), 'svc_agent-hq')
    await expect(
      service.initialize({ ...request(), caller: { servicePrincipalId: 'svc_other' } }, 'svc_other')
    ).rejects.toMatchObject({
      response: { code: 'PROJECT_STATE_ALREADY_INITIALIZED' },
    })
  })

  test('the same idempotency key with a different payload is an idempotency conflict', async () => {
    const repository = new InMemoryProjectStateRepository()
    await new RepositoryProjectStateInitializationService(repository, {
      now: () => new Date(initializedAt),
    }).initialize(request(), 'svc_agent-hq')
    // The contract payload is empty, so model a receipt whose stored hash differs.
    const conflicting = new RepositoryProjectStateInitializationService(
      {
        initializeWithReceipt: async () => ({
          outcome: 'exists',
          receipt: {
            workspaceId,
            projectId,
            callerId: 'svc_agent-hq',
            commandId: request().commandId,
            idempotencyKey: request().idempotencyKey,
            payloadHash: 'f'.repeat(64),
            initializedAt,
          },
        }),
        getAtRevision: (...args) => repository.getAtRevision(...args),
      },
      { now: () => new Date(initializedAt) }
    )
    await expect(conflicting.initialize(request(), 'svc_agent-hq')).rejects.toMatchObject({
      response: { code: 'PROJECT_STATE_IDEMPOTENCY_CONFLICT' },
    })
  })

  test('denies a credential without the initialize scope', async () => {
    const repository = new InMemoryProjectStateRepository()
    const application = await createApplication({
      repository,
      scopes: ['project-state:read'],
    })

    const response = await initialize(application, request())

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('SERVICE_CREDENTIAL_SCOPE_MISMATCH')
    expect(await repository.get(workspaceId, projectId)).toBeUndefined()
  })

  test('denies a project that is not in the credential grants', async () => {
    const repository = new InMemoryProjectStateRepository()
    const application = await createApplication({ repository })

    const response = await initialize(application, { ...request(), projectId: otherProjectId })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('SERVICE_CREDENTIAL_SCOPE_MISMATCH')
    expect(await repository.get(workspaceId, otherProjectId)).toBeUndefined()
  })

  test('denies a workspace that is not in the credential grants', async () => {
    const repository = new InMemoryProjectStateRepository()
    const application = await createApplication({ repository })
    const otherWorkspaceId = 'wsp_01JBBCDEF0123456789ABCDEFG'

    const response = await initialize(application, { ...request(), workspaceId: otherWorkspaceId })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('SERVICE_CREDENTIAL_SCOPE_MISMATCH')
    expect(await repository.get(otherWorkspaceId, projectId)).toBeUndefined()
  })

  test('requires the envelope project', async () => {
    const repository = new InMemoryProjectStateRepository()
    const application = await createApplication({ repository })
    const { projectId: _projectId, ...withoutProject } = request()

    const response = await initialize(application, withoutProject)

    expect(response.statusCode).toBe(400)
    expect(await repository.get(workspaceId, projectId)).toBeUndefined()
  })

  test('rejects a mismatched caller assertion and payload hash before persistence', async () => {
    const repository = new InMemoryProjectStateRepository()
    const application = await createApplication({ repository })

    const wrongCaller = await initialize(application, {
      ...request(),
      caller: { servicePrincipalId: 'svc_other' },
    })
    const wrongHash = await initialize(application, { ...request(), payloadHash: 'a'.repeat(64) })
    const extraPayload = await initialize(application, { ...request(), payload: { items: [] } })

    expect(wrongCaller.statusCode).toBe(403)
    expect(wrongHash.statusCode).toBe(400)
    expect(wrongHash.json().error.code).toBe('PROJECT_STATE_PAYLOAD_HASH_MISMATCH')
    expect(extraPayload.statusCode).toBe(400)
    expect(await repository.get(workspaceId, projectId)).toBeUndefined()
  })

  test('fails closed without authentication or composition', async () => {
    const unauthenticated = await createControlApiApplication({
      health: () => ({ status: 'ok', metadata }),
      logger: { write: () => {} },
      metadata,
      readiness: () => ({ status: 'ready', metadata }),
    })
    applications.push(unauthenticated)
    const noAuth = await initialize(unauthenticated, request())
    expect(noAuth.statusCode).toBe(503)

    const unconfigured = await createControlApiApplication({
      health: () => ({ status: 'ok', metadata }),
      logger: { write: () => {} },
      metadata,
      readiness: () => ({ status: 'ready', metadata }),
      serviceAuthenticator: policyAuthenticator([scope]),
    })
    applications.push(unconfigured)
    const response = await initialize(unconfigured, request())
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('PROJECT_STATE_INITIALIZATION_NOT_CONFIGURED')
  })

  test('is declared in the OpenAPI document', async () => {
    const application = await createApplication({
      repository: new InMemoryProjectStateRepository(),
    })
    const document = createOpenApiDocument(application)
    expect(document.paths['/v1/project-states/initialize']?.post).toBeDefined()
  })
})

function request() {
  const payload = {}
  return {
    ...ControlApiFixtures.projectStateInitialization.request,
    payload,
    payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
  }
}

async function createApplication({ repository, scopes = [scope], now }) {
  const application = await createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    logger: { write: () => {} },
    metadata,
    readiness: () => ({ status: 'ready', metadata }),
    serviceAuthenticator: policyAuthenticator(scopes),
    projectStateInitializationService: new RepositoryProjectStateInitializationService(repository, {
      now: now ?? (() => new Date(initializedAt)),
    }),
  })
  applications.push(application)
  return application
}

function initialize(application, payload) {
  return application.inject({
    method: 'POST',
    url: '/v1/project-states/initialize',
    headers: { authorization: 'Bearer valid-agent-hq-token' },
    payload,
  })
}

function policyAuthenticator(scopes) {
  return new PolicyServiceAuthenticator({
    audience: 'control-plane',
    clockSkewMs: 30_000,
    issuer: 'https://agent-hq.example',
    logger: { write: () => {} },
    now: () => new Date('2026-08-23T12:00:00.000Z'),
    revocationChecker: { isRevoked: async () => false },
    verifier: {
      verify: async () => ({
        audience: 'control-plane',
        credentialId: 'credential-agent-hq-2026-08',
        credentialKind: 'service',
        expiresAt: '2026-08-23T13:00:00.000Z',
        issuedAt: '2026-08-23T12:00:00.000Z',
        issuer: 'https://agent-hq.example',
        keyId: 'agent-hq-2026-08',
        principalId: 'svc_agent-hq',
        projectIds: [projectId],
        scopes,
        workspaceIds: [workspaceId],
      }),
    },
  })
}
