import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import {
  createControlApiApplication,
  createPrivateApiAuthentication,
} from '@control-plane/control-api'
import {
  CommandInboxService,
  ExecutionLifecycleService,
  VersionedCatalog,
} from '@control-plane/domain'
import {
  ExecutionPlanAcceptanceValidator,
  ExecutionPlanCompiler,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  PostgresCatalogRepository,
  PostgresCommandAcceptanceRepository,
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
} from '@control-plane/database'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import { HostedServerControlPlaneComposition } from './composition.ts'
import { hostedDependencyReadiness } from './dependency-readiness.js'
import { integrationTestTimeout } from '@control-plane/database/testing'

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
  let graphCalls

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
    graphCalls = []
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
      graphActivities: {
        async runGraphSegment(input) {
          graphCalls.push({ operation: 'runGraphSegment', input })
          return { outcome: 'continue', checkpointId: 'hosted-pg-checkpoint' }
        },
        async resumeGraphSegment(input) {
          graphCalls.push({ operation: 'resumeGraphSegment', input })
          return { outcome: 'continue', checkpointId: 'hosted-pg-checkpoint' }
        },
        async continueGraphSegment(input) {
          graphCalls.push({ operation: 'continueGraphSegment', input })
          return { outcome: 'continue', checkpointId: 'hosted-pg-checkpoint' }
        },
        async cancelGraphSegment(input) {
          graphCalls.push({ operation: 'cancelGraphSegment', input })
          return true
        },
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
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    const cleanupErrors = []
    for (const cleanup of [
      () => application?.close(),
      () => composition?.close(),
      () => isolated?.dispose(),
      () =>
        dataDirectory === undefined
          ? undefined
          : rm(dataDirectory, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'HOSTED_HTTP_INTEGRATION_CLEANUP_FAILED')
    }
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

  test(
    'hosted-server graph activities require a durable PostgreSQL allowance before forwarding',
    async () => {
      const acceptedAt = '2026-09-27T00:00:00.000Z'
      const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
      const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
      const workflowId = 'wfl_01JABCDEF0123456789ABCDEFG'
      const inputs = createExecutionPlanTestFixtureInputs()
      inputs.profile.definition.skills = []
      inputs.skills = []
      // This server-owned registration authorizes only the injected graph fixture.
      // It does not establish default production graph-catalog composition.
      const registeredSelection = {
        reference: {
          graphDefinitionId: 'hosted-pg-graph',
          graphVersion: '1.0.0',
          contentDigest: `sha256:${'a'.repeat(64)}`,
        },
        input: { objective: 'forward graph operation' },
      }
      const registeredWorkspaceId = inputs.correlation.workspaceId
      inputs.graph = structuredClone(registeredSelection)

      const database = isolated.application
      const catalogRepository = new PostgresCatalogRepository(database)
      const catalog = new VersionedCatalog(catalogRepository, catalogRepository)
      await catalog.createAgentProfile({
        profileId: inputs.profile.profileId,
        displayName: 'Hosted graph admission fixture',
        ownership: { scope: 'system' },
        createdAt: inputs.profile.createdAt,
      })
      const draft = await catalog.createAgentProfileDraft({
        profileId: inputs.profile.profileId,
        profileVersionId: inputs.profile.profileVersionId,
        version: inputs.profile.version,
        definition: inputs.profile.definition,
        createdAt: inputs.profile.createdAt,
      })
      inputs.profile = await catalog.publishAgentProfileVersion({
        profileVersionId: draft.profileVersionId,
        expectedRevision: draft.revision,
        publishedAt: acceptedAt,
      })
      await new PostgresContextPackageRepository(database).put(
        contextPackageSerializationFixtures.futurePi
      )
      const plans = new PostgresExecutionPlanRepository(database)
      const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
      await plans.put(plan)

      const acceptance = new CommandInboxService({
        repository: new PostgresCommandAcceptanceRepository(database, { budgetAdmission: true }),
        executionIdFactory: () => executionId,
        executionPlanValidator: new ExecutionPlanAcceptanceValidator(plans, {
          catalog: { profiles: catalogRepository, skills: catalogRepository },
          graphs: {
            validate: async (workspaceId, selection) =>
              workspaceId === registeredWorkspaceId &&
              isDeepStrictEqual(selection, registeredSelection),
            authorize: async (workspaceId, reference) =>
              workspaceId === registeredWorkspaceId &&
              isDeepStrictEqual(reference, registeredSelection.reference),
          },
        }),
        now: () => acceptedAt,
      })
      const { execution } = await acceptance.acceptExecution({
        callerPrincipalId: 'svc_hosted-graph-admission-test',
        operation: 'execution.accept',
        commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
        requestId: plan.correlation.requestId,
        idempotencyKey: 'hosted-graph-admission-0001',
        payloadHash: 'a'.repeat(64),
        correlation: {
          workspaceId: plan.correlation.workspaceId,
          projectId: plan.correlation.projectId,
          taskId: plan.correlation.taskId,
          agentId: plan.correlation.agentId,
        },
        executionPlan: {
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
          schemaVersion: plan.schemaVersion,
        },
        receivedAt: acceptedAt,
        retentionExpiresAt: '2026-10-27T00:00:00.000Z',
      })
      // This graph-only proof creates a real durable attempt without claiming hosted runtime
      // discovery, routing, or provider transport acceptance.
      const attempt = await new ExecutionLifecycleService(
        new PostgresExecutionRepository(database)
      ).createAttempt({
        executionId,
        attemptId,
        expectedExecutionVersion: execution.version,
        queuedAt: '2026-09-27T00:00:01.000Z',
        deadlineAt: execution.deadlineAt,
      })
      const graph = plan.graph.reference
      const threadId = `graph:${executionId}`
      const runInput = {
        executionId,
        attemptId: attempt.attemptId,
        workspaceId: plan.correlation.workspaceId,
        workflowId,
        graph,
        threadId,
        input: plan.graph.input,
        idempotencyKey: 'hosted-pg-graph-run',
      }
      const resumeInput = {
        executionId,
        attemptId: attempt.attemptId,
        workspaceId: plan.correlation.workspaceId,
        workflowId,
        graph,
        threadId,
        checkpointId: 'hosted-pg-checkpoint',
        response: { action: 'approve' },
        idempotencyKey: 'hosted-pg-graph-resume',
      }
      const continueInput = {
        executionId,
        attemptId: attempt.attemptId,
        workspaceId: plan.correlation.workspaceId,
        workflowId,
        graph,
        threadId,
        checkpointId: 'hosted-pg-checkpoint',
        idempotencyKey: 'hosted-pg-graph-continue',
      }

      for (const [operation, operationInput] of [
        ['runGraphSegment', runInput],
        ['resumeGraphSegment', resumeInput],
        ['continueGraphSegment', continueInput],
      ]) {
        expect(await composition.executionLifecycleActivities[operation](operationInput)).toEqual({
          outcome: 'continue',
          checkpointId: 'hosted-pg-checkpoint',
        })
      }
      expect(graphCalls.map(({ operation, input }) => ({ operation, input }))).toEqual([
        { operation: 'runGraphSegment', input: runInput },
        { operation: 'resumeGraphSegment', input: resumeInput },
        { operation: 'continueGraphSegment', input: continueInput },
      ])

      await database.$client.unsafe('delete from usage_budget_states where execution_id = $1', [
        executionId,
      ])
      const snapshot = async () => {
        const [budgets, entries, receipts] = await Promise.all([
          database.$client.unsafe(
            'select * from usage_budget_states where execution_id = $1 order by workspace_id',
            [executionId]
          ),
          database.$client.unsafe(
            'select * from usage_ledger_entries where execution_id = $1 order by sequence',
            [executionId]
          ),
          database.$client.unsafe(
            'select * from usage_operation_receipts where execution_id = $1 order by idempotency_key',
            [executionId]
          ),
        ])
        return { budgets, entries, receipts }
      }
      const beforeDeniedGraphOperations = await snapshot()
      const callsBeforeDenial = graphCalls.length
      for (const [operation, operationInput] of [
        ['runGraphSegment', runInput],
        ['resumeGraphSegment', resumeInput],
        ['continueGraphSegment', continueInput],
      ]) {
        await expect(
          composition.executionLifecycleActivities[operation](operationInput)
        ).rejects.toMatchObject({ code: 'RUNTIME_BUDGET_ADMISSION_DENIED' })
        expect(graphCalls).toHaveLength(callsBeforeDenial)
      }
      expect(await snapshot()).toEqual(beforeDeniedGraphOperations)

      await composition.executionLifecycleActivities.cancelActive({
        executionId,
        attemptId: attempt.attemptId,
        workflowId,
        effectKey: 'hosted-pg-graph-cancel-after-denial',
        reason: 'deadline',
        graph: {
          workspaceId: plan.correlation.workspaceId,
          reference: graph,
          threadId,
        },
      })
      expect(graphCalls.at(-1)).toEqual({
        operation: 'cancelGraphSegment',
        input: {
          executionId,
          attemptId: attempt.attemptId,
          workspaceId: plan.correlation.workspaceId,
          workflowId,
          graph,
          threadId,
          reason: 'deadline',
          idempotencyKey: 'hosted-pg-graph-cancel-after-denial',
        },
      })
      expect(await snapshot()).toEqual(beforeDeniedGraphOperations)
    },
    integrationTestTimeout()
  )
})
