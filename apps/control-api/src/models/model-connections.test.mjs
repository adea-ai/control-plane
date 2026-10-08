import { afterEach, expect, test } from 'bun:test'
import { CredentialApiFixtures } from '@control-plane/contracts'
import {
  ModelSelectionService,
  InMemoryModelSelectionRepository,
} from '@control-plane/model-gateway'
import { createControlApiApplication, createOpenApiDocument } from '../application.ts'
import { PolicyServiceAuthenticator } from '../auth/service-authentication.ts'
import { ConfiguredModelConnectionService } from './model-connections.service.ts'
const connection = {
  connectionRef: `mconn_${'1'.repeat(32)}`,
  revision: 1,
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  ownerRef: 'svc_workspace-admin',
  credentialRef: 'crd_01JABCDEF0123456789ABCDEFG',
  credentialRevision: 1,
  provider: 'openai',
  accountRef: 'account:byo-one',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  status: 'active',
  models: ['gpt-5'],
  workspaceGrant: {
    grantRef: 'grant:one',
    revision: 1,
    status: 'active',
    expiresAt: '2026-10-09T12:00:00.000Z',
  },
}

const metadata = {
  serviceName: 'control-api',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'models-api',
}
const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}
const principalId = 'svc_workspace-admin'
const read = (operation, parameters, workspaceId = connection.workspaceId) => ({
  ...CredentialApiFixtures.get.request,
  caller: { servicePrincipalId: principalId },
  workspaceId,
  operation,
  requestedAt: '2026-10-08T12:00:00.000Z',
  parameters,
})
const command = (payload) => ({
  ...CredentialApiFixtures.rotate.request,
  caller: { servicePrincipalId: principalId },
  workspaceId: connection.workspaceId,
  operation: 'model-defaults.set',
  issuedAt: '2026-10-08T12:00:00.000Z',
  payload,
})
let app
let scope = ['credential:read', 'credential:write']
let logs = []
let credentialStatus = 'active'
afterEach(async () => {
  await app?.close()
  app = undefined
})
async function fixture(enabled = true) {
  scope = ['credential:read', 'credential:write']
  logs = []
  credentialStatus = 'active'
  const repository = new InMemoryModelSelectionRepository()
  await repository.saveConnection(0, connection)
  const selections = new ModelSelectionService({
    repository,
    vault: {
      metadata: async () => ({
        credentialId: connection.credentialRef,
        workspaceId: connection.workspaceId,
        provider: 'openai',
        revision: 1,
        status: credentialStatus,
      }),
    },
    qualification: { evaluate: async () => 'READY' },
    now: () => '2026-10-08T12:00:00.000Z',
  })
  app = await createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    logger: { write: (entry) => logs.push(entry) },
    metadata,
    readiness: () => ({ status: 'ready', metadata }),
    ...(enabled
      ? { modelConnectionService: new ConfiguredModelConnectionService(selections) }
      : {}),
    serviceAuthenticator: new PolicyServiceAuthenticator({
      audience: 'control-plane',
      issuer: 'https://models.example',
      logger: { write: (entry) => logs.push(entry) },
      verifier: {
        verify: async () => ({
          credentialKind: 'service',
          credentialId: 'fixture',
          keyId: 'fixture-key',
          audience: 'control-plane',
          issuer: 'https://models.example',
          principalId,
          issuedAt: '2026-10-08T11:00:00.000Z',
          expiresAt: '2026-10-08T13:00:00.000Z',
          scopes: scope,
          workspaceIds: [connection.workspaceId],
          projectIds: [],
        }),
      },
      revocationChecker: { isRevoked: async () => false },
      now: () => new Date('2026-10-08T12:00:00.000Z'),
    }),
  })
  return { repository }
}
const post = (path, payload, authorized = true) =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: `/v1/model-connections/${path}`,
      ...(authorized ? { headers: { authorization: 'Bearer fixture-token' } } : {}),
      payload,
    })

test('authenticated model surfaces expose readiness, CAS defaults and selected override without secrets', async () => {
  await fixture()
  const listed = await post('list', read('model-connections.list', { target }))
  expect(listed.statusCode).toBe(200)
  expect(listed.json().data.connections[0].models[0].readiness).toEqual({
    ready: true,
    reasonCode: 'READY',
  })
  const choice = { connectionRef: connection.connectionRef, providerModel: 'gpt-5' }
  const saved = await post(
    'defaults/set',
    command({ expectedRevision: 0, lead: choice, child: choice })
  )
  expect(saved.statusCode).toBe(200)
  expect(saved.json().data.defaults.revision).toBe(1)
  expect(
    (await post('defaults/set', command({ expectedRevision: 0, lead: choice, child: choice })))
      .statusCode
  ).toBe(200)
  expect(
    (await post('defaults/set', command({ expectedRevision: 0, direct: choice }))).statusCode
  ).toBe(409)
  const resolved = await post(
    'selection/resolve',
    read('model-selection.resolve', { role: 'direct', target, override: choice })
  )
  expect(resolved.statusCode).toBe(200)
  expect(resolved.json().data.selection).toMatchObject({
    schemaVersion: 'model-selection/v1',
    fundingSource: 'byo_api',
    credentialRevision: 1,
    configurationRevision: 1,
  })
  const absent = await post(
    'selection/resolve',
    read('model-selection.resolve', { role: 'direct', target })
  )
  expect(absent.statusCode).toBe(409)
  const document = createOpenApiDocument(app)
  expect(document.paths['/v1/model-connections/list']).toBeDefined()
  expect(document.paths['/v1/model-connections/defaults/set']).toBeDefined()
})

test('model APIs deny missing auth, workspace/caller mismatch, stale credentials and unsupported configuration', async () => {
  await fixture()
  expect((await post('list', read('model-connections.list', { target }), false)).statusCode).toBe(
    401
  )
  expect(
    (
      await post(
        'list',
        read('model-connections.list', { target }, 'wsp_01JABCDEF0123456789ABCDEFH')
      )
    ).statusCode
  ).toBe(403)
  expect(
    (
      await post('list', {
        ...read('model-connections.list', { target }),
        caller: { servicePrincipalId: 'svc_other' },
      })
    ).statusCode
  ).toBe(403)
  credentialStatus = 'revoked'
  const listed = await post('list', read('model-connections.list', { target }))
  expect(listed.json().data.connections[0].models[0].readiness).toEqual({
    ready: false,
    reasonCode: 'CREDENTIAL_REVOKED',
  })
  scope = ['credential:read']
  expect((await post('defaults/set', command({ expectedRevision: 0 }))).statusCode).toBe(403)
})

test('strict secret-bearing requests and unavailable integration expose bounded errors only', async () => {
  await fixture()
  const canary = 'SECRET-canary-raw-api-key'
  const response = await post('defaults/set', command({ expectedRevision: 0, secret: canary }))
  expect(response.statusCode).toBe(400)
  expect(JSON.stringify([response.json(), logs])).not.toContain(canary)
  await app.close()
  app = undefined
  await fixture(false)
  expect((await post('list', read('model-connections.list', { target }))).statusCode).toBe(503)
})

test('connection create derives account/grant from trusted authority and revocation blocks subsequent resolution', async () => {
  const { repository } = await fixture()
  const { ModelConnectionAdministration } = await import('@control-plane/model-gateway')
  const vault = {
    metadata: async () => ({
      credentialId: connection.credentialRef,
      workspaceId: connection.workspaceId,
      provider: 'openai',
      status: 'active',
      revision: 1,
    }),
  }
  const selections = new ModelSelectionService({
    repository,
    vault,
    qualification: { evaluate: async () => 'READY' },
    now: () => '2026-10-08T12:00:00.000Z',
  })
  const administration = new ModelConnectionAdministration({
    repository,
    vault,
    grants: {
      authorize: async () => ({
        accountRef: connection.accountRef,
        authKind: 'api_key',
        fundingSource: 'byo_api',
        models: ['gpt-5'],
        workspaceGrant: connection.workspaceGrant,
      }),
    },
  })
  const service = new ConfiguredModelConnectionService(selections, administration)
  const create = {
    ...command({ credentialRef: connection.credentialRef, credentialRevision: 1 }),
    operation: 'model-connections.create',
  }
  const created = await service.create(create, principalId)
  expect(created.data.connection.accountRef).toBe(connection.accountRef)
  expect(await service.create(create, principalId)).toEqual(created)
  const revoke = {
    ...command({ connectionRef: created.data.connection.connectionRef, expectedRevision: 1 }),
    operation: 'model-connections.revoke',
  }
  expect((await service.revoke(revoke, principalId)).data.connection.status).toBe('revoked')
  await expect(
    service.resolve(
      read('model-selection.resolve', {
        role: 'direct',
        target,
        override: { connectionRef: created.data.connection.connectionRef, providerModel: 'gpt-5' },
      }),
      principalId
    )
  ).rejects.toMatchObject({ response: { code: 'CONNECTION_REVOKED' } })
  await expect(service.create(create, principalId)).rejects.toMatchObject({
    response: { code: 'SELECTION_CHANGED' },
  })
})
