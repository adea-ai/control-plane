import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlApiFixtures } from '@control-plane/contracts'
import {
  SqliteGraphDefinitionRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { RepositoryGraphAdministrationService } from './graph-administration.service.ts'

const base = ControlApiFixtures.executionValidation.request
const request = {
  ...base,
  operation: 'graph.publish',
  idempotencyKey: 'graph:publish:api:1',
  payload: {
    definition: {
      graphDefinitionId: 'graph:api',
      graphVersion: '1.0.0',
      schemaVersion: 1,
      nodes: [{ node: 'run', operation: { kind: 'runtime', name: 'execute' } }],
      edges: [
        { from: '__start__', to: 'run' },
        { from: 'run', to: '__end__' },
      ],
      schemas: { input: 'schema:input', state: 'schema:state', output: 'schema:output' },
      requiredCapabilities: [],
      compatibility: {
        contractMajorVersions: [1],
        compilerVersions: ['1.0.0'],
        adapterVersions: ['1.0.0'],
      },
    },
  },
}
delete request.projectId
const principal = request.caller.servicePrincipalId

async function setup(run) {
  const directory = await mkdtemp(join(tmpdir(), 'graph-admin-api-'))
  const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await persistence.migrate()
    const service = new RepositoryGraphAdministrationService({
      repository: (workspaceId) => new SqliteGraphDefinitionRepository(persistence, workspaceId),
      now: () => new Date('2026-09-30T23:00:00.000Z'),
    })
    await run(service, persistence)
  } finally {
    await persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('graph administration publishes, changes lifecycle and replays original receipt with current response identity', async () => {
  await setup(async (service) => {
    const published = await service.publish(request, principal)
    const version = published.data.definition
    expect(version).toMatchObject({ revision: 1, lifecycle: 'published' })
    const change = {
      ...request,
      operation: 'graph.deprecate',
      idempotencyKey: 'graph:deprecate:api:1',
      payload: {
        reference: version.reference,
        expectedRevision: 1,
        reason: 'replacement available',
      },
    }
    expect((await service.deprecate(change, principal)).data.definition).toMatchObject({
      revision: 2,
      lifecycle: 'deprecated',
    })
    const replayRequest = {
      ...request,
      requestId: 'req_01JABCDEF0123456789ABCDEFF',
      issuedAt: '2026-09-30T23:10:00.000Z',
    }
    const replay = await service.publish(replayRequest, principal)
    expect(replay.requestId).toBe(replayRequest.requestId)
    expect(replay.data.definition).toEqual(version)
    await expect(
      service.publish(
        {
          ...request,
          payload: {
            definition: { ...request.payload.definition, requiredCapabilities: ['tool.invoke'] },
          },
        },
        principal
      )
    ).rejects.toMatchObject({ status: 409 })
    expect((await service.deprecate(change, principal)).data.definition.revision).toBe(2)
    const revoke = {
      ...change,
      operation: 'graph.revoke',
      idempotencyKey: 'graph:revoke:api:1',
      payload: { ...change.payload, expectedRevision: 2, reason: 'revoked after review' },
    }
    expect((await service.revoke(revoke, principal)).data.definition).toMatchObject({
      revision: 3,
      lifecycle: 'revoked',
    })
    const resolution = {
      caller: request.caller,
      workspaceId: request.workspaceId,
      requestId: request.requestId,
      contractVersion: request.contractVersion,
      correlation: request.correlation,
      operation: 'graph.resolve',
      requestedAt: request.issuedAt,
      parameters: { reference: version.reference },
    }
    expect((await service.resolve(resolution, principal)).data.definition.lifecycle).toBe('revoked')
    await expect(
      service.resolve({ ...resolution, workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' }, principal)
    ).rejects.toMatchObject({ status: 404 })
  })
})

test('graph administration rejects mismatched caller, malformed authority fields and credentials before persistence', async () => {
  await setup(async (service, persistence) => {
    await expect(service.publish(request, 'svc_other-admin')).rejects.toMatchObject({ status: 403 })
    await expect(
      service.publish({ ...request, projectId: base.projectId }, principal)
    ).rejects.toThrow()
    const canary = 'secret-canary-admin-9cde'
    const published = await service.publish(request, principal)
    await expect(
      service.revoke(
        {
          ...request,
          operation: 'graph.revoke',
          payload: {
            reference: published.data.definition.reference,
            expectedRevision: 1,
            reason: `Bearer ${canary}`,
          },
        },
        principal
      )
    ).rejects.toMatchObject({ status: 422 })
    expect(
      await persistence.transaction((transaction) => transaction.list('graph-definition-commands'))
    ).toHaveLength(1)
  })
})

test('HTTP graph catalog routes enforce credential, operation and workspace scopes before durable mutation', async () => {
  const { PolicyServiceAuthenticator } = await import('../auth/service-authentication.ts')
  const { createControlApiApplication } = await import('../application.ts')
  await setup(async (service, persistence) => {
    const metadata = {
      serviceName: 'control-api',
      version: '1.0.0',
      commitSha: 'abc123',
      environment: 'test',
      instanceId: 'graph-api-test',
    }
    let claims = {
      credentialKind: 'service',
      credentialId: 'graph-admin-fixture',
      keyId: 'graph-key',
      audience: 'control-plane',
      issuer: 'https://graph-api.example',
      principalId: principal,
      issuedAt: '2026-09-30T22:00:00.000Z',
      expiresAt: '2026-09-30T23:55:00.000Z',
      scopes: ['graph:publish', 'graph:manage', 'graph:resolve'],
      workspaceIds: [request.workspaceId],
      projectIds: [],
    }
    const originalClaims = claims
    const authenticator = new PolicyServiceAuthenticator({
      audience: claims.audience,
      issuer: claims.issuer,
      now: () => new Date('2026-09-30T23:00:00.000Z'),
      logger: { write() {} },
      revocationChecker: { isRevoked: async () => false },
      verifier: { verify: async () => claims },
    })
    const app = await createControlApiApplication({
      metadata,
      logger: { write() {} },
      health: () => ({ status: 'ok', metadata }),
      readiness: () => ({ status: 'ready', metadata }),
      serviceAuthenticator: authenticator,
      graphAdministrationService: service,
    })
    const post = (path, payload, authorized = true) =>
      app.inject({
        method: 'POST',
        url: `/v1/graphs/${path}`,
        payload,
        ...(authorized ? { headers: { authorization: 'Bearer graph-admin-fixture' } } : {}),
      })
    try {
      expect((await post('publish', request, false)).statusCode).toBe(401)
      claims = { ...originalClaims, scopes: ['graph:resolve'] }
      expect((await post('publish', request)).statusCode).toBe(403)
      claims = originalClaims
      expect(
        (await post('publish', { ...request, caller: { servicePrincipalId: 'svc_other-admin' } }))
          .statusCode
      ).toBe(403)
      expect(
        (await post('publish', { ...request, workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' }))
          .statusCode
      ).toBe(403)
      expect(
        await persistence.transaction((transaction) =>
          transaction.list('graph-definition-commands')
        )
      ).toHaveLength(0)
      const published = await post('publish', request)
      expect(published.statusCode).toBe(200)
      const version = published.json().data.definition
      const deprecation = {
        ...request,
        operation: 'graph.deprecate',
        idempotencyKey: 'graph:http:deprecate:1',
        payload: { reference: version.reference, expectedRevision: 1, reason: 'replacement' },
      }
      expect((await post('deprecate', deprecation)).json().data.definition.lifecycle).toBe(
        'deprecated'
      )
      expect((await post('publish', request)).json().data.definition).toEqual(version)
      expect(
        (
          await post('publish', {
            ...request,
            payload: {
              definition: { ...request.payload.definition, requiredCapabilities: ['tool.invoke'] },
            },
          })
        ).statusCode
      ).toBe(409)
      const resolution = {
        caller: request.caller,
        workspaceId: request.workspaceId,
        requestId: request.requestId,
        contractVersion: request.contractVersion,
        correlation: request.correlation,
        operation: 'graph.resolve',
        requestedAt: request.issuedAt,
        parameters: { reference: version.reference },
      }
      expect((await post('resolve', resolution)).json().data.definition.lifecycle).toBe(
        'deprecated'
      )
    } finally {
      await app.close()
    }
  })
})
