import { afterEach, describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { generateKeyPairSync, sign } from 'node:crypto'
import { loadManagedCloudConfiguration } from '@control-plane/config'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { ControlApiFixtures, ErrorResponseEnvelopeSchema } from '@control-plane/contracts'
import {
  CommandInboxService,
  InMemoryCommandAcceptanceRepository,
  executionConstraintFixtures,
} from '@control-plane/domain'
import { withTestApplication } from '@control-plane/testing'
import { createControlApiApplication, createOpenApiDocument } from './application.ts'
import {
  ConfiguredCredentialRevocationChecker,
  Ed25519ServiceCredentialVerifier,
  PolicyServiceAuthenticator,
  createInternalServicePrincipal,
} from './auth/service-authentication.ts'
import { createManagedCloudControlApiComposition, start } from './index.ts'
import {
  DurableExecutionAcceptanceService,
  RestateExecutionWorkflowDispatcher,
} from './executions/execution-acceptance.service.ts'
import { DurableExecutionValidationService } from './executions/execution-validation.service.ts'
import { RepositoryProfileResolutionService } from './queries/profile-resolution.service.ts'
import { RepositoryProjectStateResolutionService } from './queries/project-state-resolution.service.ts'
import { RepositoryContextPackageResolutionService } from './queries/context-package-resolution.service.ts'
import { InMemoryRuntimeDiscoveryRepository } from './runtime-discovery/runtime-discovery.repository.ts'

class FakeProcessAdapter {
  exitCode = undefined
  listeners = new Map()

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener)
  }

  setExitCode(code) {
    this.exitCode = code
  }

  async emit(event, value) {
    await Promise.all([...(this.listeners.get(event) ?? [])].map((listener) => listener(value)))
  }
}

const metadata = {
  serviceName: 'control-api',
  version: '1.4.0',
  commitSha: 'abc123',
  environment: 'test',
  instanceId: 'control-api-test',
}
const applications = []

async function createApplication(
  logs = [],
  serviceAuthenticator,
  runtimeDiscoveryRepository,
  executionValidationService,
  executionAcceptanceService,
  profileResolutionService,
  projectStateResolutionService,
  contextPackageResolutionService
) {
  const application = await createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    logger: { write: (entry) => logs.push(entry) },
    metadata,
    readiness: () => ({ status: 'ready', metadata }),
    executionAcceptanceService,
    executionValidationService,
    profileResolutionService,
    projectStateResolutionService,
    contextPackageResolutionService,
    serviceAuthenticator,
    runtimeDiscoveryRepository,
  })
  applications.push(application)
  return application
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()))
})

describe('Control API', () => {
  test('exposes only readiness through public component diagnostics', async () => {
    let ready = true
    let probeFails = false
    const application = await createControlApiApplication({
      health: () => ({ status: 'ok', metadata }),
      logger: { write: () => undefined },
      metadata,
      readiness: () => ({ status: 'ready', metadata }),
      dependencyReadiness: () => {
        if (probeFails) throw new Error('/private/storage/internal-host')
        return Promise.resolve(ready)
      },
      componentManifest: async () => {
        throw new Error('The public route must never serialize private manifests')
      },
    })
    applications.push(application)
    const response = await application.inject({ method: 'GET', url: '/v1/components' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({ schemaVersion: 1, ready: true })
    ready = false
    const unavailable = await application.inject({ method: 'GET', url: '/v1/components' })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.json()).toEqual({ schemaVersion: 1, ready: false })
    ready = true
    probeFails = true
    const failed = await application.inject({ method: 'GET', url: '/v1/components' })
    expect(failed.statusCode).toBe(503)
    expect(failed.json()).toEqual({ schemaVersion: 1, ready: false })
  })

  test('verifies an authenticated service principal through the public contract', async () => {
    const application = await createApplication(
      [],
      policyAuthenticator({
        claims: {
          ...validServiceClaims(),
          scopes: ControlApiFixtures.authentication.response.data.principal.scopes,
        },
      })
    )

    const response = await application.inject({
      method: 'POST',
      url: '/v1/authentication/verify',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: ControlApiFixtures.authentication.request,
    })

    expect(response.json()).toEqual(ControlApiFixtures.authentication.response)
    expect(response.statusCode).toBe(200)
  })

  test('resolves the latest published profile through the public contract', async () => {
    const profile = executionProfile(executionConstraintFixtures.read)
    const service = new RepositoryProfileResolutionService({
      getAgentProfileVersion: async () => undefined,
      listAgentProfileVersions: async () => [
        { ...profile, lifecycle: 'draft', version: 4 },
        profile,
      ],
    })
    const application = await createApplication(
      [],
      policyAuthenticator({
        claims: { ...validServiceClaims(), scopes: ['profile:resolve'] },
      }),
      undefined,
      undefined,
      undefined,
      service
    )

    const response = await application.inject({
      method: 'POST',
      url: '/v1/profiles/resolve',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: ControlApiFixtures.profileResolution.request,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(ControlApiFixtures.profileResolution.response)
  })

  test('resolves an immutable ProjectState revision through the public contract', async () => {
    const reference = ControlApiFixtures.projectStateReference
    const state = {
      schemaVersion: 1,
      ...reference,
      items: [],
      createdAt: '2026-08-23T11:00:00.000Z',
      updatedAt: '2026-08-23T11:00:00.000Z',
    }
    const service = new RepositoryProjectStateResolutionService({
      get: async () => state,
      getAtRevision: async () => state,
    })
    const application = await createApplication(
      [],
      policyAuthenticator({
        claims: { ...validServiceClaims(), scopes: ['project-state:read'] },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      service
    )

    const response = await application.inject({
      method: 'POST',
      url: '/v1/project-states/resolve',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: ControlApiFixtures.projectStateResolution.request,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(ControlApiFixtures.projectStateResolution.response)
  })

  test('resolves a scoped ContextPackage reference through the public contract', async () => {
    const package_ = contextPackageSerializationFixtures.futurePi
    const service = new RepositoryContextPackageResolutionService({
      getById: async () => package_,
    })
    const application = await createApplication(
      [],
      policyAuthenticator({
        claims: { ...validServiceClaims(), scopes: ['context:read'] },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service
    )
    const request = {
      ...ControlApiFixtures.contextPackageResolution.request,
      workspaceId: package_.projectState.workspaceId,
      projectId: package_.projectState.projectId,
      parameters: { contextPackageId: package_.contextPackageId },
    }

    const response = await application.inject({
      method: 'POST',
      url: '/v1/context-packages/resolve',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: request,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.contextPackage).toEqual({
      contextPackageId: package_.contextPackageId,
      contentDigest: package_.contentDigest,
      schemaVersion: package_.schemaVersion,
      compilerVersion: package_.compiler.version,
    })
  })

  test('exposes health, readiness, and security headers', async () => {
    await withTestApplication(createApplication, async (application) => {
      const health = await application.inject({ method: 'GET', url: '/health' })
      const ready = await application.inject({ method: 'GET', url: '/ready' })

      expect(health.statusCode).toBe(200)
      expect(health.json()).toEqual({ status: 'ok', metadata })
      expect(ready.json()).toEqual({ status: 'ready', metadata })
      expect(health.headers['x-content-type-options']).toBe('nosniff')
      expect(health.headers['x-request-id']).toBeString()
      expect(health.headers['x-correlation-id']).toBeString()
    })
  })

  test('drops readiness when a live deployment dependency is unavailable', async () => {
    const application = await createControlApiApplication({
      health: () => ({ status: 'ok', metadata }),
      logger: { write: () => undefined },
      metadata,
      readiness: () => ({ status: 'ready', metadata }),
      dependencyReadiness: async () => false,
    })
    applications.push(application)
    const response = await application.inject({ method: 'GET', url: '/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'not_ready', metadata })
  })

  test('keeps dependency probe failures on the readiness contract', async () => {
    const application = await createControlApiApplication({
      health: () => ({ status: 'ok', metadata }),
      logger: { write: () => undefined },
      metadata,
      readiness: () => ({ status: 'ready', metadata }),
      dependencyReadiness: async () => {
        throw new Error('probe failed')
      },
    })
    applications.push(application)
    const response = await application.inject({ method: 'GET', url: '/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'not_ready', metadata })
  })

  test('serves a versioned endpoint and propagates request context through responses and logs', async () => {
    const logs = []
    const application = await createApplication(logs)

    const response = await application.inject({
      method: 'GET',
      url: '/v1/system/echo?message=hello',
      headers: {
        'x-correlation-id': 'correlation-123',
        'x-request-id': 'request-123',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-request-id']).toBe('request-123')
    expect(response.headers['x-correlation-id']).toBe('correlation-123')
    expect(response.json()).toEqual({
      data: { message: 'hello' },
      meta: { correlationId: 'correlation-123', requestId: 'request-123' },
    })
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'http.request.completed',
        details: expect.objectContaining({
          correlationId: 'correlation-123',
          requestId: 'request-123',
          statusCode: 200,
        }),
      })
    )
  })

  test('keeps a secret canary out of public API responses and request logs', async () => {
    const secretCanary = 'secret-canary-public-api-9f4a'
    const logs = []
    const application = await createApplication(logs)

    const response = await application.inject({
      method: 'GET',
      url: '/ready',
      headers: { authorization: `Bearer ${secretCanary}` },
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.stringify({ body: response.body, headers: response.headers, logs })).not.toContain(
      secretCanary
    )
  })

  test('propagates valid W3C trace context through the HTTP boundary', async () => {
    const logs = []
    const application = await createApplication(logs)
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

    const response = await application.inject({
      method: 'GET',
      url: '/v1/system/echo?message=hello',
      headers: { traceparent },
    })

    expect(response.headers.traceparent).toBe(traceparent)
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'http.request.completed',
        details: expect.objectContaining({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736' }),
      })
    )
  })

  test('replaces unsafe external context identifiers', async () => {
    const application = await createApplication()

    const response = await application.inject({
      method: 'GET',
      url: '/v1/system/echo?message=hello',
      headers: {
        'x-correlation-id': 'unsafe correlation id',
        'x-request-id': 'unsafe request id',
      },
    })

    expect(response.headers['x-request-id']).not.toBe('unsafe request id')
    expect(response.headers['x-correlation-id']).toBe(response.headers['x-request-id'])
  })

  test('normalizes validation and not-found errors without exposing internals', async () => {
    const application = await createApplication()

    const validation = await application.inject({ method: 'GET', url: '/v1/system/echo' })
    const notFound = await application.inject({ method: 'GET', url: '/v1/unknown' })

    expect(validation.statusCode).toBe(400)
    expect(validation.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        details: [expect.objectContaining({ field: 'message' })],
        message: 'Request validation failed',
      },
      meta: {
        correlationId: validation.headers['x-correlation-id'],
        requestId: validation.headers['x-request-id'],
      },
    })
    expect(notFound.statusCode).toBe(404)
    expect(notFound.json().error).toEqual({ code: 'NOT_FOUND', message: 'Resource not found' })
    expect(JSON.stringify(notFound.json())).not.toContain('stack')
  })

  test('keeps service authentication fail-closed behind an explicit extension point', async () => {
    const application = await createApplication()

    const response = await application.inject({
      method: 'POST',
      url: '/v1/system/authenticated',
      payload: scopedRequest(),
    })

    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('SERVICE_AUTH_NOT_CONFIGURED')
  })

  test('fails closed when execution validation is not configured', async () => {
    const application = await createApplication(
      [],
      policyAuthenticator({
        claims: { ...validServiceClaims(), scopes: ['execution:validate'] },
      })
    )

    const response = await application.inject({
      method: 'POST',
      url: '/v1/executions/validate',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: ControlApiFixtures.executionValidation.request,
    })

    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('EXECUTION_VALIDATION_NOT_CONFIGURED')
  })

  test('resolves durable evidence and persists the execution plan before returning success', async () => {
    const contextPackage = contextPackageSerializationFixtures.futurePi
    const constraints = executionConstraintFixtures.write
    const profile = executionProfile(constraints)
    const skill = executionSkill()
    const persistedPlans = []
    let evidenceReads = 0
    let allowEvidenceReads = true
    let clockReads = 0
    const commandRecords = new Map()
    const readEvidence = (value) => {
      if (!allowEvidenceReads) throw new Error('UNEXPECTED_REPLAY_EVIDENCE_READ')
      evidenceReads += 1
      return globalThis.structuredClone(value)
    }
    const service = new DurableExecutionValidationService({
      compilerVersion: '1.0.0',
      now: () =>
        new Date(Date.parse('2026-09-07T12:00:00.000Z') + clockReads++ * 1000).toISOString(),
      contextPackages: {
        get: async () => readEvidence(contextPackage),
      },
      commands: {
        get: async (scope) => globalThis.structuredClone(commandRecords.get(JSON.stringify(scope))),
        commit: async (record, plan) => {
          const key = JSON.stringify(record.scope)
          const existing = commandRecords.get(key)
          if (existing) {
            if (existing.payloadHash !== record.payloadHash)
              throw new Error('EXECUTION_VALIDATION_COMMAND_CONFLICT')
            return globalThis.structuredClone(existing)
          }
          persistedPlans.push(globalThis.structuredClone(plan))
          commandRecords.set(key, globalThis.structuredClone(record))
          return record
        },
      },
      profiles: { getAgentProfileVersion: async () => readEvidence(profile) },
      projectStates: {
        getAtRevision: async () =>
          readEvidence({
            schemaVersion: 1,
            workspaceId: contextPackage.projectState.workspaceId,
            projectId: contextPackage.projectState.projectId,
            revision: contextPackage.projectState.revision,
            items: [],
            createdAt: '2026-08-23T11:00:00.000Z',
            updatedAt: '2026-08-23T11:00:00.000Z',
          }),
      },
      skills: { getSkillVersion: async () => readEvidence(skill) },
    })
    const request = executionValidationRequest(contextPackage, constraints)

    await expect(service.validate(request, '')).rejects.toMatchObject({ status: 403 })
    await expect(service.validate(request)).rejects.toMatchObject({ status: 403 })
    await expect(service.validate(request, 'service:another-caller')).rejects.toMatchObject({
      status: 403,
    })
    expect(persistedPlans).toHaveLength(0)
    expect(evidenceReads).toBe(0)
    const response = await service.validate(request, request.caller.servicePrincipalId)
    expect(clockReads).toBe(1)
    expect(persistedPlans[0].compiledAt).toBe('2026-09-07T12:00:00.000Z')
    allowEvidenceReads = false
    const application = await createApplication(
      [],
      policyAuthenticator({
        claims: { ...validServiceClaims(), scopes: ['execution:validate'] },
      }),
      undefined,
      service
    )
    const httpResponse = await application.inject({
      method: 'POST',
      url: '/v1/executions/validate',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: request,
    })

    expect(response.data.valid).toBe(true)
    expect(response.data.executionPlan).toEqual({
      executionPlanId: persistedPlans[0].executionPlanId,
      contentDigest: persistedPlans[0].contentDigest,
    })
    expect(persistedPlans[0].correlation).toMatchObject({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      taskId: request.payload.taskId,
      agentId: request.payload.agentId,
    })
    expect(httpResponse.statusCode).toBe(200)
    expect(httpResponse.json().data.executionPlan).toEqual(response.data.executionPlan)
    expect(persistedPlans).toHaveLength(1)
    expect(evidenceReads).toBe(4)
    expect(clockReads).toBe(1)
    const retried = await service.validate(
      {
        ...request,
        requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        issuedAt: '2026-09-08T12:00:00.000Z',
        payloadHash: '0'.repeat(64),
      },
      request.caller.servicePrincipalId
    )
    expect(retried.data.executionPlan).toEqual(response.data.executionPlan)
    expect(retried.requestId).toBe('req_01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(clockReads).toBe(1)
    const deniedReplay = await application.inject({
      method: 'POST',
      url: '/v1/executions/validate',
      payload: request,
    })
    expect(deniedReplay.statusCode).toBe(401)

    await expect(
      service.validate(
        {
          ...request,
          payload: {
            ...request.payload,
            policySnapshot: { ...request.payload.policySnapshot, revision: 999 },
          },
        },
        request.caller.servicePrincipalId
      )
    ).rejects.toMatchObject({ status: 409 })
    const conflict = await application.inject({
      method: 'POST',
      url: '/v1/executions/validate',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: {
        ...request,
        payload: { ...request.payload, outputContractRef: 'contract://different/v1' },
      },
    })
    expect(conflict.statusCode).toBe(409)
    allowEvidenceReads = true
    await expect(
      service.validate(
        {
          ...request,
          idempotencyKey: 'validation-rejection-0001',
          payload: {
            ...request.payload,
            policySnapshot: { ...request.payload.policySnapshot, revision: 999 },
          },
        },
        request.caller.servicePrincipalId
      )
    ).rejects.toMatchObject({ status: 422 })
    const competing = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.validate(
          { ...request, idempotencyKey: 'validation-concurrent-0001' },
          request.caller.servicePrincipalId
        )
      )
    )
    for (const result of competing)
      expect(result.data.executionPlan).toEqual(competing[0].data.executionPlan)
    expect(persistedPlans).toHaveLength(2)
    const inline = {
      ...request,
      idempotencyKey: 'inline-validation-0001',
      payload: {
        ...request.payload,
        contextPackage: undefined,
        contextInputs: {
          objective: 'Complete the task',
          candidates: [],
          successCriteria: ['Done'],
          returnContract: { contractRef: request.payload.outputContractRef },
          budgets: { maximumBytes: 10000, maximumTokens: 1000 },
        },
      },
    }
    await expect(service.validate(inline, request.caller.servicePrincipalId)).rejects.toMatchObject(
      { status: 503 }
    )
    const authoringCalls = []
    service.options.contextAuthoring = {
      createForCommand: async (...args) => {
        authoringCalls.push(args)
        return {
          contextPackageId: contextPackage.contextPackageId,
          contentDigest: contextPackage.contentDigest,
        }
      },
    }
    const inlineResponse = await application.inject({
      method: 'POST',
      url: '/v1/executions/validate',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: inline,
    })
    expect(inlineResponse.statusCode).toBe(200)
    expect(authoringCalls).toEqual([
      [
        request.caller.servicePrincipalId,
        inline.idempotencyKey,
        {
          ...inline.payload.contextInputs,
          workspaceId: request.workspaceId,
          projectId: request.projectId,
          projectStateRevision: request.payload.projectState.revision,
        },
      ],
    ])
    allowEvidenceReads = false
    service.options.contextAuthoring = undefined
    const inlineReplay = await service.validate(inline, request.caller.servicePrincipalId)
    expect(inlineReplay.data.executionPlan).toEqual(inlineResponse.json().data.executionPlan)
    expect(authoringCalls).toHaveLength(1)
    await expect(
      service.validate(
        {
          ...inline,
          payload: {
            ...inline.payload,
            contextInputs: { ...inline.payload.contextInputs, objective: 'Changed' },
          },
        },
        request.caller.servicePrincipalId
      )
    ).rejects.toMatchObject({ status: 409 })
  })

  test('rejects malformed and unauthorized execution validation requests before composition', async () => {
    const wrongScope = await createApplication(
      [],
      policyAuthenticator({ claims: validServiceClaims() })
    )
    const forbidden = await wrongScope.inject({
      method: 'POST',
      url: '/v1/executions/validate',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: ControlApiFixtures.executionValidation.request,
    })
    const malformed = await wrongScope.inject({
      method: 'POST',
      url: '/v1/executions/validate',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: { operation: 'execution.validate' },
    })

    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error.code).toBe('SERVICE_CREDENTIAL_SCOPE_MISMATCH')
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error.code).toBe('SERVICE_REQUEST_ENVELOPE_INVALID')
  })

  test('accepts one durable execution and submits one Restate workflow across replay', async () => {
    const fixture = executionAcceptanceFixture()

    const first = await fixture.service.accept(
      ControlApiFixtures.executionAcceptance.request,
      'svc_agent-hq'
    )
    const replay = await fixture.service.accept(
      ControlApiFixtures.executionAcceptance.request,
      'svc_agent-hq'
    )

    expect(first.data).toMatchObject({
      executionId: fixture.executionId,
      status: 'processing',
      replayed: false,
    })
    expect(replay.data).toEqual({ ...first.data, replayed: true })
    expect(fixture.submissions).toHaveLength(1)
    expect(fixture.repository.executionCount).toBe(1)
  })

  test('carries exact marketplace pins into the durable workflow submission', async () => {
    const fixture = executionAcceptanceFixture()
    const marketplacePluginReferences = [
      {
        canonicalContentDigest: `sha256:${'f'.repeat(64)}`,
        pluginId: 'plugin:openai-official:gmail',
        releaseId: `release:${'e'.repeat(64)}`,
      },
    ]
    const request = {
      ...ControlApiFixtures.executionAcceptance.request,
      payload: {
        ...ControlApiFixtures.executionAcceptance.request.payload,
        marketplacePluginReferences,
      },
    }

    await fixture.service.accept(request, 'svc_agent-hq')

    expect(fixture.submissions[0]).toMatchObject({ marketplacePluginReferences })
  })

  test('rejects an acceptance payload conflict without another execution or workflow', async () => {
    const fixture = executionAcceptanceFixture()
    await fixture.service.accept(ControlApiFixtures.executionAcceptance.request, 'svc_agent-hq')

    await expect(
      fixture.service.accept(
        { ...ControlApiFixtures.executionAcceptance.request, payloadHash: 'a'.repeat(64) },
        'svc_agent-hq'
      )
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' } })

    expect(fixture.submissions).toHaveLength(1)
    expect(fixture.repository.executionCount).toBe(1)
  })

  test('reports short command retention as a client validation error before dispatch', async () => {
    const fixture = executionAcceptanceFixture()
    const original = ControlApiFixtures.executionAcceptance.request
    const request = {
      ...original,
      payload: {
        ...original.payload,
        retentionExpiresAt: new Date(Date.parse(original.issuedAt) + 86_400_000).toISOString(),
      },
    }
    await expect(fixture.service.accept(request, 'svc_agent-hq')).rejects.toMatchObject({
      status: 400,
      response: { code: 'INVALID_COMMAND_RETENTION' },
    })
    expect(fixture.submissions).toHaveLength(0)
    expect(fixture.repository.executionCount).toBe(0)
  })

  test.each([
    ['at or before issuance', '2026-08-23T12:00:00.000Z', '2026-09-22T12:00:00.000Z'],
    ['after command retention', '2026-08-24T11:00:00.000Z', '2026-08-24T10:00:00.000Z'],
    ['after the managed command lifetime', '2026-08-24T12:00:00.001Z', '2026-09-22T12:00:00.000Z'],
  ])('rejects a workflow deadline %s', async (_case, deadlineAt, retentionExpiresAt) => {
    const fixture = executionAcceptanceFixture()
    const request = {
      ...ControlApiFixtures.executionAcceptance.request,
      payload: {
        ...ControlApiFixtures.executionAcceptance.request.payload,
        deadlineAt,
        retentionExpiresAt,
      },
    }

    await expect(fixture.service.accept(request, 'svc_agent-hq')).rejects.toMatchObject({
      response: { code: 'INVALID_EXECUTION_DEADLINE' },
    })
    expect(fixture.submissions).toHaveLength(0)
    expect(fixture.repository.executionCount).toBe(0)
  })

  test('records reconciliation-required when Restate delivery is uncertain after acceptance', async () => {
    const fixture = executionAcceptanceFixture({ dispatchFailure: true })

    await expect(
      fixture.service.accept(ControlApiFixtures.executionAcceptance.request, 'svc_agent-hq')
    ).rejects.toThrow('Restate workflow submission is unavailable')

    const command = await fixture.repository.get({
      callerPrincipalId: 'svc_agent-hq',
      operation: 'execution.accept',
      workspaceId: ControlApiFixtures.executionAcceptance.request.workspaceId,
      projectId: ControlApiFixtures.executionAcceptance.request.projectId,
      idempotencyKey: ControlApiFixtures.executionAcceptance.request.idempotencyKey,
    })
    expect(command).toMatchObject({
      status: 'reconciliation_required',
      errorReference: `restate://submission-unconfirmed/${fixture.executionId}`,
    })
  })

  test('submits the workflow through private Restate ingress and accepts deterministic resubmission', async () => {
    const calls = []
    const dispatcher = new RestateExecutionWorkflowDispatcher({
      ingressUrl: 'http://control-planerestate.railway.internal:8080',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        return {
          status: 202,
          text: async () => JSON.stringify({ invocationId: 'inv_01JABC', status: 'Accepted' }),
        }
      },
    })
    const input = workflowSubmissionInput()

    await dispatcher.submit(input)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      `http://control-planerestate.railway.internal:8080/execution-lifecycle/${input.executionId}/run/send`
    )
    expect(calls[0].init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
    })
    expect(JSON.parse(calls[0].init.body)).toEqual(input)

    const replay = new RestateExecutionWorkflowDispatcher({
      ingressUrl: 'http://control-planerestate.railway.internal:8080',
      fetch: async () => ({ status: 409 }),
    })
    await expect(replay.submit(input)).resolves.toBeUndefined()
  })

  test('requires execution:accept scope before invoking the acceptance service', async () => {
    const calls = []
    const acceptanceService = {
      accept: async (envelope, principalId) => {
        calls.push({ envelope, principalId })
        return ControlApiFixtures.executionAcceptance.response
      },
    }
    const forbiddenApplication = await createApplication(
      [],
      policyAuthenticator({ claims: validServiceClaims() }),
      undefined,
      undefined,
      acceptanceService
    )
    const forbidden = await forbiddenApplication.inject({
      method: 'POST',
      url: '/v1/executions/accept',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: ControlApiFixtures.executionAcceptance.request,
    })
    expect(forbidden.statusCode).toBe(403)
    expect(calls).toHaveLength(0)

    const authorizedApplication = await createApplication(
      [],
      policyAuthenticator({
        claims: { ...validServiceClaims(), scopes: ['execution:accept'] },
      }),
      undefined,
      undefined,
      acceptanceService
    )
    const accepted = await authorizedApplication.inject({
      method: 'POST',
      url: '/v1/executions/accept',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: ControlApiFixtures.executionAcceptance.request,
    })
    expect(accepted.statusCode).toBe(202)
    expect(calls).toEqual([
      {
        envelope: ControlApiFixtures.executionAcceptance.request,
        principalId: 'svc_agent-hq',
      },
    ])
  })

  test('authenticates an Agent HQ service principal and enforces envelope scope', async () => {
    const logs = []
    const claims = validServiceClaims()
    const authenticator = policyAuthenticator({ claims, logs })
    const application = await createApplication(logs, authenticator)

    const response = await application.inject({
      method: 'POST',
      url: '/v1/system/authenticated',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: scopedRequest(),
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().data).toEqual({
      authenticated: true,
      principalId: 'svc_agent-hq',
    })
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'service_auth.succeeded',
        details: expect.objectContaining({ principalId: 'svc_agent-hq' }),
      })
    )
  })

  test('verifies signed Ed25519 service credentials by trusted key and explicit revocation', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const publicJwk = publicKey.export({ format: 'jwk' })
    const claims = validServiceClaims()
    const verifier = new Ed25519ServiceCredentialVerifier([
      { keyId: claims.keyId, publicKey: publicJwk.x },
    ])
    const token = signedServiceCredential(privateKey, claims)

    expect(await verifier.verify(token)).toEqual(claims)
    await expect(verifier.verify(tamperCredential(token))).rejects.toThrow()
    await expect(
      verifier.verify(signedServiceCredential(privateKey, claims, { kid: 'unknown-key' }))
    ).rejects.toThrow()
    await expect(
      verifier.verify(signedServiceCredential(privateKey, claims, { alg: 'none' }))
    ).rejects.toThrow()

    const revocations = new ConfiguredCredentialRevocationChecker([claims.credentialId])
    expect(await revocations.isRevoked(claims.credentialId)).toBe(true)
    expect(await revocations.isRevoked('active-credential')).toBe(false)
  })

  test('rejects user, device, and provider credential classes', async () => {
    for (const credentialKind of ['browser_session', 'runtime_device', 'provider']) {
      const application = await createApplication(
        [],
        policyAuthenticator({ claims: { ...validServiceClaims(), credentialKind } })
      )
      const response = await authenticatedRequest(application, `secret-${credentialKind}`)

      expect(response.statusCode).toBe(401)
      expect(response.json().error.code).toBe('SERVICE_CREDENTIAL_CLASS_REJECTED')
    }
  })

  test('normalizes missing credentials and invalid versioned envelopes', async () => {
    const application = await createApplication(
      [],
      policyAuthenticator({ claims: validServiceClaims() })
    )
    const missingCredential = await application.inject({
      method: 'POST',
      url: '/v1/system/authenticated',
      payload: scopedRequest(),
    })
    const invalidEnvelope = await application.inject({
      method: 'POST',
      url: '/v1/system/authenticated',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: { caller: { servicePrincipalId: 'svc_agent-hq' } },
    })

    expect(missingCredential.statusCode).toBe(401)
    expect(missingCredential.json().error.code).toBe('SERVICE_CREDENTIAL_REQUIRED')
    expect(invalidEnvelope.statusCode).toBe(400)
    expect(invalidEnvelope.json().error.code).toBe('SERVICE_REQUEST_ENVELOPE_INVALID')
  })

  test('fails closed for malformed, wrong-audience, expired, revoked, and scope-conflicting credentials', async () => {
    const cases = [
      {
        authenticator: (logs) =>
          policyAuthenticator({ logs, verifierError: new Error('invalid signature') }),
        code: 'SERVICE_CREDENTIAL_MALFORMED',
        token: 'raw-malformed-secret',
      },
      {
        authenticator: (logs) =>
          policyAuthenticator({
            claims: { ...validServiceClaims(), audience: 'runtime-node' },
            logs,
          }),
        code: 'SERVICE_CREDENTIAL_INVALID_AUDIENCE',
        token: 'raw-wrong-audience-secret',
      },
      {
        authenticator: (logs) =>
          policyAuthenticator({
            claims: { ...validServiceClaims(), issuer: 'https://untrusted.example' },
            logs,
          }),
        code: 'SERVICE_CREDENTIAL_INVALID_ISSUER',
        token: 'raw-wrong-issuer-secret',
      },
      {
        authenticator: (logs) =>
          policyAuthenticator({
            claims: {
              ...validServiceClaims(),
              expiresAt: '2026-08-23T11:59:29.000Z',
              issuedAt: '2026-08-23T11:00:00.000Z',
            },
            logs,
          }),
        code: 'SERVICE_CREDENTIAL_EXPIRED',
        token: 'raw-expired-secret',
      },
      {
        authenticator: (logs) =>
          policyAuthenticator({ claims: validServiceClaims(), logs, revoked: true }),
        code: 'SERVICE_CREDENTIAL_REVOKED',
        token: 'raw-revoked-secret',
      },
      {
        authenticator: (logs) =>
          policyAuthenticator({
            claims: {
              ...validServiceClaims(),
              workspaceIds: ['wsp_01JBBCDEF0123456789ABCDEFG'],
            },
            logs,
          }),
        code: 'SERVICE_CREDENTIAL_SCOPE_MISMATCH',
        token: 'raw-scope-secret',
      },
      {
        authenticator: (logs) => policyAuthenticator({ claims: validServiceClaims(), logs }),
        code: 'SERVICE_CREDENTIAL_SCOPE_MISMATCH',
        request: {
          ...scopedRequest(),
          caller: { servicePrincipalId: 'svc_another-caller' },
        },
        token: 'raw-caller-secret',
      },
      {
        authenticator: (logs) =>
          policyAuthenticator({
            claims: { ...validServiceClaims(), scopes: ['runtime:read'] },
            logs,
          }),
        code: 'SERVICE_CREDENTIAL_SCOPE_MISMATCH',
        token: 'raw-operation-scope-secret',
      },
    ]

    for (const testCase of cases) {
      const logs = []
      const application = await createApplication(logs, testCase.authenticator(logs))
      const response = await authenticatedRequest(application, testCase.token, testCase.request)

      expect(response.statusCode).toBe(testCase.code.endsWith('SCOPE_MISMATCH') ? 403 : 401)
      expect(response.json().error.code).toBe(testCase.code)
      expect(JSON.stringify(logs)).not.toContain(testCase.token)
      expect(JSON.stringify(response.json())).not.toContain(testCase.token)
    }
  })

  test('requires explicit least-privilege scopes for internal service principals', () => {
    expect(() =>
      createInternalServicePrincipal({ principalId: 'svc_worker', scopes: [] })
    ).toThrow()
    expect(() =>
      createInternalServicePrincipal({ principalId: 'svc_worker', scopes: ['*'] })
    ).toThrow()
    expect(
      createInternalServicePrincipal({
        principalId: 'svc_worker',
        scopes: ['execution:dispatch'],
      })
    ).toEqual({
      kind: 'internal_service',
      principalId: 'svc_worker',
      projectIds: [],
      scopes: ['execution:dispatch'],
      workspaceIds: [],
    })
  })

  test('serves scoped normalized runtime and external-session read models without native state', async () => {
    const repository = discoveryRepository()
    const application = await createApplication(
      [],
      policyAuthenticator({ claims: validServiceClaims() }),
      repository
    )

    const runtimeList = await application.inject({
      method: 'POST',
      url: '/v1/runtime-connections/list',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: discoveryRequest('runtime-connection.list', {
        limit: 1,
        runtimeNodeRefId: runtimeModel().node.runtimeNodeRefId,
        states: ['stale'],
        requiredCapabilities: ['session.resume'],
      }),
    })
    const runtimeGet = await application.inject({
      method: 'POST',
      url: '/v1/runtime-connections/get',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: discoveryRequest('runtime-connection.get', {
        runtimeConnectionId: runtimeModel().runtimeConnectionId,
        runtimeNodeRefId: runtimeModel().node.runtimeNodeRefId,
      }),
    })
    const runtimes = await application.inject({
      method: 'POST',
      url: '/v1/runtimes/list',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: discoveryRequest('runtime.list', {
        status: 'unavailable',
        requiredCapabilities: ['session.resume'],
      }),
    })
    const sessionList = await application.inject({
      method: 'POST',
      url: '/v1/external-sessions/list',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: discoveryRequest('external-session.list', {
        limit: 50,
        states: ['revoked'],
      }),
    })

    expect(runtimeList.statusCode).toBe(200)
    expect(runtimeList.json().data.runtimeConnections).toHaveLength(1)
    expect(runtimeList.json().data.runtimeConnections[0]).toMatchObject({
      node: { health: 'online' },
      connection: { health: 'degraded', availability: 'stale' },
      freshness: { state: 'stale' },
      eligibility: {
        state: 'ineligible',
        reasons: ['REQUIRED_CAPABILITY_INSUFFICIENT', 'RUNTIME_STALE'],
      },
    })
    expect(runtimeGet.statusCode).toBe(200)
    expect(runtimes.statusCode).toBe(200)
    expect(runtimes.json().data.runtimes).toEqual([
      {
        runtimeNodeRefId: runtimeModel().node.runtimeNodeRefId,
        runtimeConnectionId: runtimeModel().runtimeConnectionId,
        runtimeDefinitionId: runtimeModel().runtimeDefinitionId,
        family: runtimeModel().family,
        location: runtimeModel().node.location,
        status: 'unavailable',
        observedAt: runtimeModel().observedAt,
        capabilities: runtimeModel().capabilities,
        limitations: runtimeModel().limitations,
      },
    ])
    expect(sessionList.statusCode).toBe(200)
    expect(sessionList.json().data.externalSessions[0].capabilitySummary.controls.resume).toEqual({
      available: false,
      reason: 'SESSION_REVOKED',
    })
    const serialized = JSON.stringify({
      runtime: runtimeGet.json(),
      sessions: sessionList.json(),
    })
    for (const prohibited of [
      '/Users/example',
      'opaqueNativeRef',
      'opaqueNativeSessionId',
      'processHandle',
      'nativeConfig',
      'nativeSessionState',
      'super-secret-native-token',
    ]) {
      expect(serialized).not.toContain(prohibited)
    }
  })

  test('rejects cross-workspace discovery and returns scoped not-found results', async () => {
    const repository = discoveryRepository()
    const application = await createApplication(
      [],
      policyAuthenticator({ claims: validServiceClaims() }),
      repository
    )
    const crossWorkspace = await application.inject({
      method: 'POST',
      url: '/v1/runtime-connections/list',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: {
        ...discoveryRequest('runtime-connection.list', {
          limit: 50,
          states: [],
          requiredCapabilities: [],
        }),
        workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG',
      },
    })
    const missing = await application.inject({
      method: 'POST',
      url: '/v1/external-sessions/get',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: discoveryRequest('external-session.get', {
        externalSessionId: 'ses_01JBBCDEF0123456789ABCDEFG',
      }),
    })
    const malformed = await application.inject({
      method: 'POST',
      url: '/v1/runtime-connections/list',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: discoveryRequest('runtime-connection.list', {
        limit: 101,
        states: [],
        requiredCapabilities: [],
      }),
    })

    expect(crossWorkspace.statusCode).toBe(403)
    expect(crossWorkspace.json().error.code).toBe('SERVICE_CREDENTIAL_SCOPE_MISMATCH')
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('EXTERNAL_SESSION_NOT_FOUND')
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    })
    expect(
      ErrorResponseEnvelopeSchema.parse(malformed.json()).error.details.diagnostics
    ).toContainEqual(expect.objectContaining({ field: 'parameters.limit' }))
  })

  test('generates versioned OpenAPI paths', async () => {
    const application = await createApplication()

    const document = createOpenApiDocument(application)

    expect(document.openapi).toStartWith('3.')
    expect(document.paths).toHaveProperty('/v1/system/echo')
    expect(document.paths).toHaveProperty('/v1/executions/validate')
    expect(document.paths).toHaveProperty('/v1/executions/accept')
    expect(document.paths).toHaveProperty('/v1/runtime-connections/list')
    expect(document.paths).toHaveProperty('/v1/runtimes/list')
    expect(document.paths).toHaveProperty('/v1/external-sessions/list')
    expect(document.paths).toHaveProperty('/v1/marketplace/catalog')
    expect(document.paths).toHaveProperty('/v1/marketplace/install')
    expect(document.paths).toHaveProperty('/health')
    expect(document.components?.securitySchemes).toHaveProperty('service-bearer')
  })

  test('closes the Fastify application through shared graceful shutdown', async () => {
    const processAdapter = new FakeProcessAdapter()
    const started = await start({
      environment: {
        APP_ENV: 'test',
        COMMIT_SHA: 'abc123',
        CONTROL_API_PORT: '3000',
        INSTANCE_ID: 'control-api-test',
        SERVICE_VERSION: '1.4.0',
      },
      listen: false,
      logger: { write: () => undefined },
      processAdapter,
    })
    await processAdapter.emit('SIGTERM')

    await expect(started.application.inject('/health')).rejects.toThrow('already been closed')
    expect(processAdapter.exitCode).toBe(0)
    expect(started.runtime.readiness().status).toBe('not_ready')
  })

  test('wires runtime discovery through the production start boundary', async () => {
    const processAdapter = new FakeProcessAdapter()
    const started = await start({
      environment: {
        APP_ENV: 'test',
        COMMIT_SHA: 'abc123',
        CONTROL_API_PORT: '3000',
        INSTANCE_ID: 'control-api-test',
        SERVICE_VERSION: '1.4.0',
      },
      listen: false,
      logger: { write: () => undefined },
      processAdapter,
      runtimeDiscoveryRepository: discoveryRepository(),
      serviceAuthenticator: policyAuthenticator({ claims: validServiceClaims() }),
    })

    const response = await started.application.inject({
      method: 'POST',
      url: '/v1/runtime-connections/list',
      headers: { authorization: 'Bearer valid-agent-hq-token' },
      payload: discoveryRequest('runtime-connection.list', {
        limit: 50,
        states: [],
        requiredCapabilities: [],
      }),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data.runtimeConnections).toHaveLength(1)

    await processAdapter.emit('SIGTERM')
  })

  test('probes and closes the Neon connection around managed Cloud startup', async () => {
    const processAdapter = new FakeProcessAdapter()
    const lifecycle = []
    const started = await start({
      environment: managedCloudEnvironment(),
      listen: false,
      logger: { write: () => undefined },
      processAdapter,
      postgresConnectionFactory: () => ({
        database: {},
        check: async () => lifecycle.push('checked'),
        close: async () => lifecycle.push('closed'),
      }),
    })

    expect(lifecycle).toEqual(['checked'])
    expect(started.runtime.readiness().status).toBe('ready')
    const authentication = await started.application.inject({
      method: 'POST',
      url: '/v1/system/authenticated',
      headers: { authorization: 'Bearer invalid-signed-service-credential' },
      payload: scopedRequest(),
    })
    expect(authentication.statusCode).toBe(401)
    expect(authentication.json().error.code).toBe('SERVICE_CREDENTIAL_MALFORMED')

    await processAdapter.emit('SIGTERM')

    expect(lifecycle).toEqual(['checked', 'closed'])
    expect(started.runtime.readiness().status).toBe('not_ready')
  })

  test('fails managed Cloud startup closed and releases PostgreSQL when readiness probing fails', async () => {
    const lifecycle = []
    const logs = []

    await expect(
      start({
        environment: managedCloudEnvironment(),
        listen: false,
        logger: { write: (entry) => logs.push(entry) },
        processAdapter: new FakeProcessAdapter(),
        postgresConnectionFactory: () => ({
          database: {},
          check: async () => {
            lifecycle.push('checked')
            throw new Error('postgresql://app:must-not-leak@example.neon.tech/control_plane')
          },
          close: async () => lifecycle.push('closed'),
        }),
      })
    ).rejects.toThrow('Service startup failed')

    expect(lifecycle).toEqual(['checked', 'closed'])
    expect(JSON.stringify(logs)).not.toContain('must-not-leak')
  })

  test('constructs the durable validator and signed authenticator from one Cloud composition', () => {
    const composition = createManagedCloudControlApiComposition(
      loadManagedCloudConfiguration(managedCloudEnvironment(), 'control-api'),
      { write: () => undefined },
      () => ({ database: {}, check: async () => undefined, close: async () => undefined })
    )

    expect(composition.executionValidationService).toBeInstanceOf(DurableExecutionValidationService)
    expect(composition.executionAcceptanceService).toBeInstanceOf(DurableExecutionAcceptanceService)
    expect(composition.serviceAuthenticator).toBeInstanceOf(PolicyServiceAuthenticator)
  })
})

function executionAcceptanceFixture(options = {}) {
  const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
  const repository = new InMemoryCommandAcceptanceRepository()
  const submissions = []
  const now = () => '2026-08-23T12:00:01.000Z'
  const service = new DurableExecutionAcceptanceService({
    commands: new CommandInboxService({
      repository,
      executionIdFactory: () => executionId,
      executionPlanValidator: { validate: async () => true },
      now,
    }),
    dispatcher: {
      submit: async (input) => {
        submissions.push(globalThis.structuredClone(input))
        if (options.dispatchFailure) throw new Error('private Restate details must not escape')
      },
    },
    now,
  })
  return { executionId, repository, service, submissions }
}

function workflowSubmissionInput() {
  return {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
    executionPlan: {
      executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
      contentDigest: `sha256:${'e'.repeat(64)}`,
      schemaVersion: 1,
    },
    deadlineAt: '2026-08-23T13:00:00.000Z',
  }
}

function managedCloudEnvironment() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const trustedKey = publicKey.export({ format: 'jwk' }).x
  return {
    APP_ENV: 'staging',
    SERVICE_VERSION: '1.4.0',
    COMMIT_SHA: 'abc123',
    INSTANCE_ID: 'control-api-staging',
    DATABASE_URL:
      'postgresql://app:database-secret@example.neon.tech/control_plane?sslmode=require',
    CONTROL_PLANE_SECRET_ENCRYPTION_KEY:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    CONTROL_PLANE_SERVICE_AUTH_ISSUER: 'https://agent-hq.example',
    CONTROL_PLANE_SERVICE_AUTH_TRUSTED_KEYS: JSON.stringify([
      { keyId: 'agent-hq-2026-08', publicKey: trustedKey },
    ]),
    CONTROL_PLANE_SERVICE_AUTH_REVOKED_CREDENTIAL_IDS: '[]',
    R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    R2_BUCKET: 'ctrl-plane',
    R2_REGION: 'auto',
    R2_ACCESS_KEY_ID: 'access-key',
    R2_SECRET_ACCESS_KEY: 'secret-key-that-is-not-logged',
    RESTATE_INGRESS_URL: 'http://control-planerestate.railway.internal:8080',
  }
}

function validServiceClaims() {
  return {
    audience: 'control-plane',
    credentialId: 'credential-agent-hq-2026-08',
    credentialKind: 'service',
    expiresAt: '2026-08-23T13:00:00.000Z',
    issuedAt: '2026-08-23T12:00:00.000Z',
    issuer: 'https://agent-hq.example',
    keyId: 'agent-hq-2026-08',
    principalId: 'svc_agent-hq',
    projectIds: ['prj_01JABCDEF0123456789ABCDEFG'],
    scopes: ['runtime:read', 'system:authenticate'],
    workspaceIds: ['wsp_01JABCDEF0123456789ABCDEFG'],
  }
}

function signedServiceCredential(privateKey, claims, headerOverrides = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', kid: claims.keyId, typ: 'JWT', ...headerOverrides })
  ).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signingInput = `${header}.${payload}`
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

function tamperCredential(credential) {
  const [header, payload, signature] = credential.split('.')
  const replacement = signature[0] === 'A' ? 'B' : 'A'
  return `${header}.${payload}.${replacement}${signature.slice(1)}`
}

function scopedRequest() {
  return {
    caller: { servicePrincipalId: 'svc_agent-hq' },
    contractVersion: { major: 1, minor: 0 },
    correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
    operation: 'runtime.list',
    parameters: {},
    projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    requestedAt: '2026-08-23T12:00:00.000Z',
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  }
}

function executionValidationRequest(contextPackage, constraints) {
  return {
    ...ControlApiFixtures.executionValidation.request,
    payload: {
      ...ControlApiFixtures.executionValidation.request.payload,
      contextPackage: {
        contextPackageId: contextPackage.contextPackageId,
        contentDigest: contextPackage.contentDigest,
        schemaVersion: contextPackage.schemaVersion,
        compilerVersion: contextPackage.compiler.version,
      },
      projectState: contextPackage.projectState,
      policySnapshot: {
        policySnapshotId: constraints.policySnapshot.policyId,
        revision: constraints.policySnapshot.version,
        contentDigest: constraints.policySnapshot.digest,
      },
      runtimeRequirements: ['stream.output'],
      outputContractRef: 'contract://execution-result/v1',
    },
  }
}

function executionProfile(constraints) {
  return {
    profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
    profileId: 'prf_01JABCDEF0123456789ABCDEFG',
    version: 3,
    revision: 2,
    lifecycle: 'published',
    contentDigest: `sha256:${'a'.repeat(64)}`,
    definition: {
      schemaVersion: 1,
      roleInstructions: 'Complete the assigned task safely.',
      skills: [
        {
          skillId: 'skl_01JABCDEF0123456789ABCDEFG',
          skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'b'.repeat(64)}`,
        },
      ],
      capabilityRequirements: ['filesystem.read'],
      executionConstraints: globalThis.structuredClone(constraints),
      outputContractRefs: ['contract://execution-result/v1'],
    },
    createdAt: '2026-08-22T12:00:00.000Z',
    lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
  }
}

function executionSkill() {
  return {
    skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
    skillId: 'skl_01JABCDEF0123456789ABCDEFG',
    revision: 4,
    lifecycle: 'published',
    manifest: {
      schemaVersion: 1,
      semanticVersion: '2.1.0',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      requiredCapabilities: ['filesystem.read'],
      requiredTools: [{ toolId: 'project-files', versionRange: '^1.0.0' }],
      compatibleProfileSchemaVersions: [1],
      compatibleContractMajorVersions: [1],
    },
    content: { instructions: 'Inspect and update project files.', artifactRefs: [] },
    createdAt: '2026-08-22T12:00:00.000Z',
    lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
  }
}

function discoveryRequest(operation, parameters) {
  return {
    caller: { servicePrincipalId: 'svc_agent-hq' },
    contractVersion: { major: 1, minor: 0 },
    correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
    operation,
    parameters,
    projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    requestedAt: '2026-08-24T12:00:00.000Z',
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  }
}

function runtimeModel() {
  return {
    runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
    runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
    family: 'codex',
    connectionType: 'managed_local',
    location: 'local_device',
    status: 'unavailable',
    node: {
      runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
      location: 'local_device',
      status: 'online',
      health: 'online',
      observedAt: '2026-08-24T11:59:00.000Z',
    },
    connection: { status: 'degraded', health: 'degraded', availability: 'stale' },
    freshness: {
      state: 'stale',
      observedAt: '2026-08-24T11:50:00.000Z',
      expiresAt: '2026-08-24T11:55:00.000Z',
    },
    versions: { adapter: '1.2.0', driver: '1.1.0', harness: '2.0.0' },
    capabilities: ['session.resume'],
    capabilityDetails: [
      { name: 'session.resume', support: 'degraded', limitations: ['HISTORY_UNAVAILABLE'] },
    ],
    compatibility: { state: 'incompatible', limitations: ['DRIVER_MAJOR_MISMATCH'] },
    access: {
      localProjectGrant: { required: true, state: 'missing' },
      entitlement: { state: 'allowed', class: 'standard' },
    },
    eligibility: {
      state: 'ineligible',
      reasons: ['REQUIRED_CAPABILITY_INSUFFICIENT', 'RUNTIME_STALE'],
      degradations: [],
      remediation: [{ code: 'REFRESH_RUNTIME', label: 'Refresh runtime health and capabilities' }],
    },
    observedAt: '2026-08-24T11:50:00.000Z',
    limitations: ['HISTORY_UNAVAILABLE'],
    opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFG',
    rawPath: '/Users/example/.runtime',
    processHandle: 4412,
    credentials: { token: 'super-secret-native-token' },
    nativeConfig: { unrestricted: true },
  }
}

function externalSessionModel() {
  return {
    externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
    runtimeConnectionId: runtimeModel().runtimeConnectionId,
    projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    state: 'revoked',
    recoverable: false,
    display: { origin: 'native_discovery', displayName: 'Review session' },
    freshness: {
      state: 'expired',
      observedAt: '2026-08-24T11:00:00.000Z',
      expiresAt: '2026-08-24T11:05:00.000Z',
    },
    capabilitySummary: {
      version: 4,
      operations: ['session.resume'],
      controls: {
        reference: { available: true },
        resume: { available: false, reason: 'SESSION_REVOKED' },
        load: { available: false, reason: 'SESSION_REVOKED' },
        close: { available: false, reason: 'SESSION_REVOKED' },
        history: { available: false, reason: 'SESSION_REVOKED' },
      },
    },
    limitations: ['SESSION_REVOKED'],
    opaqueNativeSessionId: 'nses_01JABCDEF0123456789ABCDEFG',
    nativeSessionState: { messages: ['private'] },
  }
}

function discoveryRepository() {
  return new InMemoryRuntimeDiscoveryRepository(
    [
      {
        workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
        model: runtimeModel(),
      },
    ],
    [
      {
        workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
        projectId: 'prj_01JABCDEF0123456789ABCDEFG',
        runtimeNodeRefId: runtimeModel().node.runtimeNodeRefId,
        model: externalSessionModel(),
      },
    ]
  )
}

function authenticatedRequest(application, token, payload = scopedRequest()) {
  return application.inject({
    method: 'POST',
    url: '/v1/system/authenticated',
    headers: { authorization: `Bearer ${token}` },
    payload,
  })
}

function policyAuthenticator({ claims, logs = [], revoked = false, verifierError } = {}) {
  return new PolicyServiceAuthenticator({
    audience: 'control-plane',
    clockSkewMs: 30_000,
    issuer: 'https://agent-hq.example',
    logger: { write: (entry) => logs.push(entry) },
    now: () => new Date('2026-08-23T12:00:00.000Z'),
    revocationChecker: { isRevoked: async () => revoked },
    verifier: {
      verify: async () => {
        if (verifierError) throw verifierError
        return claims
      },
    },
  })
}
