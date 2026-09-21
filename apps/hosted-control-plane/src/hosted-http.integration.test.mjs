import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  createControlApiApplication,
  createPrivateApiAuthentication,
} from '@control-plane/control-api'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import { HostedServerControlPlaneComposition } from './composition.ts'
import { hostedDependencyReadiness } from './dependency-readiness.js'

const integrationEnabled = process.env.RUN_DATABASE_INTEGRATION === 'true'

// Boots the real hosted-server composition over an isolated PostgreSQL
// database and drives the production control-api HTTP surface in-process,
// mirroring what apps/hosted-control-plane start() assembles.
describe.skipIf(!integrationEnabled)('hosted control plane HTTP surface', () => {
  let isolated
  let composition
  let application
  let dataDirectory
  let credential

  const metadata = {
    serviceName: 'control-api',
    version: 'integration-test',
    commitSha: 'test',
    environment: 'test',
    instanceId: 'hosted-http-e2e',
  }

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
    dataDirectory = await mkdtemp(join(tmpdir(), 'hosted-http-e2e-'))
    composition = new HostedServerControlPlaneComposition({
      dataDirectory,
      // Discovery labels only: the real connection is injected below.
      databaseUrl: 'postgresql://control_plane_app:secret@127.0.0.1:54329/control_plane',
      connection: {
        database: isolated.application,
        check: async () => undefined,
        close: async () => undefined,
      },
      endpointFactory: {
        create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
      },
      workflowRuntime: {
        start: async () => undefined,
        stop: async () => undefined,
        health: async () => ({ ready: true, component: 'test', version: '1' }),
      },
    })
    await composition.start()

    const authentication = await createPrivateApiAuthentication(dataDirectory)
    credential = (await readFile(authentication.credentialFile, 'utf8')).trim()
    application = await createControlApiApplication({
      executionAcceptanceService: composition.executionAcceptanceService,
      interactionCommandService: composition.interactionCommandService,
      executionCancellationService: composition.executionCancellationService,
      executionValidationService: composition.executionValidationService,
      profileResolutionService: composition.profileResolutionService,
      projectStateResolutionService: composition.projectStateResolutionService,
      contextPackageResolutionService: composition.contextPackageResolutionService,
      runtimeDiscoveryRepository: composition.runtimeDiscoveryRepository,
      serviceAuthenticator: authentication.authenticator,
      dependencyReadiness: () => hostedDependencyReadiness(composition),
      componentManifest: () => composition.manifest(),
      health: () => ({ status: 'ok', metadata }),
      readiness: () => ({ status: 'ready', metadata }),
      logger: { write: () => undefined },
      metadata,
    })
  }, 60_000)

  afterAll(async () => {
    await application?.close().catch(() => undefined)
    await composition?.close().catch(() => undefined)
    await isolated?.dispose()
    await rm(dataDirectory, { recursive: true, force: true })
  })

  test('readiness is database-aware and green over the real composition', async () => {
    const ready = await application.inject({ method: 'GET', url: '/ready' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json().status).toBe('ready')
  })

  test('health reports liveness with the hosted component manifest', async () => {
    const health = await application.inject({ method: 'GET', url: '/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json().status).toBe('ok')
  })

  test('unauthenticated private API calls fail closed', async () => {
    const denied = await application.inject({
      method: 'POST',
      url: '/v1/system/authenticated',
      headers: { authorization: 'Bearer not-a-real-credential' },
      payload: {},
    })
    expect(denied.statusCode).toBe(401)
  })

  test('authenticated calls pass through the private API boundary', async () => {
    const ok = await application.inject({
      method: 'POST',
      url: '/v1/system/authenticated',
      headers: { authorization: `Bearer ${credential}` },
      payload: { caller: { servicePrincipalId: 'svc_agent-hq' } },
    })
    // Nest defaults POST handlers to 201 without an explicit @HttpCode.
    expect(ok.statusCode).toBe(201)
    expect(ok.json().data.authenticated).toBe(true)
    expect(typeof ok.json().data.principalId).toBe('string')
  })

  test('versioned request stack answers over the hosted composition', async () => {
    const echo = await application.inject({
      method: 'GET',
      url: '/v1/system/echo?message=hosted-e2e',
    })
    expect(echo.statusCode).toBe(200)
    expect(echo.json().data.message).toBe('hosted-e2e')
  })
})
