import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonStringify, ControlApiFixtures } from '@control-plane/contracts'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import {
  PostgresCatalogRepository,
  PostgresCommandAcceptanceRepository,
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  PostgresGraphDefinitionRepository,
  PostgresInteractionRepository,
  PostgresRuntimeDiscoveryRepository,
  PostgresToolCallRepository,
  PostgresToolRegistryRepository,
  PostgresDurableUsageStore,
} from '@control-plane/database'
import { createIsolatedTestDatabase, integrationTestTimeout } from '@control-plane/database/testing'
import { VersionedCatalog } from '@control-plane/domain'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { GraphDefinitionCatalog } from '@control-plane/orchestration'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { LangGraphPostgresCheckpointProvider } from '@control-plane/langgraph-adapter'
import { ToolRegistry } from '@control-plane/tool-execution'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { loadDatabaseCredentials } from '@control-plane/config'
import { start } from './index.ts'
import { RuntimeDiscoveryAttemptRouter } from '@control-plane/workflow-worker'

const enabled =
  process.env.RUN_DATABASE_INTEGRATION === 'true' &&
  process.env.RUN_HOSTED_GRAPH_RESTATE_INTEGRATION === 'true'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const toolDefinitionId = 'tld_01JABCDEF0123456789ABCDEFG'
const toolVersionId = 'tlv_01JABCDEF0123456789ABCDEFG'

describe.skipIf(!enabled)('Hosted Server graph over PostgreSQL and Restate', () => {
  let isolated
  let directory
  let databaseUrl
  let environment
  let configuration
  let dataDirectory
  let service
  let publicKey
  let checkpointProvider

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    process.stderr.write(`[hosted-graph-restate-db] isolated=${isolated.name}\n`)
    await isolated.migrate()
    // The same least-privileged application role backs the normal start() path
    // below; it must verify migrated graph schemas without owning or creating them.
    await isolated.assertApplicationCannotCreateOrAlter()
    directory = await realpath(await mkdtemp(join(tmpdir(), 'hosted-graph-restate-')))
    dataDirectory = join(directory, 'server-data')
    const database = new URL(loadDatabaseCredentials(process.env, 'application').url)
    database.pathname = `/${isolated.name}`
    databaseUrl = database.toString()
    checkpointProvider = LangGraphPostgresCheckpointProvider.fromConnectionString(databaseUrl)
    configuration = {
      schemaVersion: 1,
      toolDefinitionId,
      toolVersionId,
      currency: 'USD',
      costMicrounits: 25,
      createdAt: '2026-10-03T00:00:00.000Z',
      publishedAt: '2026-10-03T00:00:00.000Z',
    }
    const configPath = join(directory, 'hosted-graph-tool.json')
    await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 })
    const identityFile = process.env.HOSTED_GRAPH_TEST_PUBLIC_KEY_FILE
    if (!identityFile) throw new Error('HOSTED_GRAPH_TEST_PUBLIC_KEY_FILE_REQUIRED')
    publicKey = (await readFile(identityFile, 'utf8')).trim()
    if (!/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(publicKey)) {
      throw new Error('HOSTED_GRAPH_TEST_PUBLIC_KEY_INVALID')
    }
    environment = {
      APP_ENV: 'test',
      DATABASE_URL: databaseUrl,
      CONTROL_PLANE_DATA_DIR: dataDirectory,
      CONTROL_PLANE_HOSTED_GRAPH_ENABLED: 'true',
      CONTROL_PLANE_HOSTED_GRAPH_TOOL_CONFIG: configPath,
      HOSTED_CONTROL_PLANE_PORT: requiredEnvironment('HOSTED_GRAPH_TEST_API_PORT'),
      CONTROL_PLANE_BIND_HOST: '127.0.0.1',
      RESTATE_ADMIN_URL: requiredEnvironment('HOSTED_GRAPH_TEST_RESTATE_ADMIN_URL'),
      RESTATE_INGRESS_URL: requiredEnvironment('HOSTED_GRAPH_TEST_RESTATE_INGRESS_URL'),
      RESTATE_REQUEST_IDENTITY_PUBLIC_KEY: publicKey,
      WORKFLOW_DEPLOYMENT_URI: requiredEnvironment('HOSTED_GRAPH_TEST_DEPLOYMENT_URI'),
    }
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    const cleanupErrors = []
    for (const cleanup of [
      () => service?.shutdown('hosted graph integration complete'),
      () => checkpointProvider?.close(),
      () => isolated?.dispose(),
      () => (directory === undefined ? undefined : rm(directory, { recursive: true, force: true })),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'HOSTED_GRAPH_RESTATE_CLEANUP_FAILED')
    }
  })

  test(
    'accepts, checkpoints, parks, cold-resumes, writes one artifact, and charges once',
    async () => {
      const workspaceDatabase = isolated.application
      const inputs = createExecutionPlanTestFixtureInputs()
      inputs.correlation.requestId = uniqueIdentifier('req')
      inputs.profile.definition.skills = []
      inputs.skills = []
      inputs.constraints = {
        ...inputs.constraints,
        tools: {
          default: 'deny',
          grants: [
            {
              tool: { toolId: 'hosted-object-store-json', versionRange: '^1.0.0' },
              operations: ['store-json'],
              requiredCapabilities: ['object-store.write'],
              riskClass: 'write',
              approval: 'always',
            },
          ],
        },
      }
      inputs.profile.definition.executionConstraints = inputs.constraints
      const now = new Date().toISOString()
      const pinned = await publishGraph(workspaceDatabase, workspaceId, configuration, now)
      const document = { headline: 'Hosted graph output', labels: ['cold-resume', 'approved'] }
      inputs.graph = { reference: pinned.reference, input: document }

      const catalogRepository = new PostgresCatalogRepository(workspaceDatabase)
      const catalog = new VersionedCatalog(catalogRepository, catalogRepository)
      await catalog.createAgentProfile({
        profileId: inputs.profile.profileId,
        displayName: 'Hosted graph integration profile',
        ownership: { scope: 'system' },
        createdAt: inputs.profile.createdAt,
      })
      const profileDraft = await catalog.createAgentProfileDraft({
        profileId: inputs.profile.profileId,
        profileVersionId: inputs.profile.profileVersionId,
        version: inputs.profile.version,
        definition: inputs.profile.definition,
        createdAt: inputs.profile.createdAt,
      })
      inputs.profile = await catalog.publishAgentProfileVersion({
        profileVersionId: profileDraft.profileVersionId,
        expectedRevision: profileDraft.revision,
        publishedAt: now,
      })
      await new PostgresContextPackageRepository(workspaceDatabase).put(
        contextPackageSerializationFixtures.futurePi
      )
      const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
      await new PostgresExecutionPlanRepository(workspaceDatabase).put(plan)
      // The existing execution lifecycle opens a provider runtime attempt before
      // choosing its graph branch. Seed only the durable discovery projection
      // needed for that routing precondition; graph execution below remains the
      // real Hosted Restate graph activity and does not call this mock runtime.
      const runtimeDiscovery = new PostgresRuntimeDiscoveryRepository(workspaceDatabase)
      await runtimeDiscovery.putRuntimeConnection(
        workspaceId,
        runtimeDiscoveryProjection(plan.runtimeRequirements.map(({ capability }) => capability))
      )
      const route = await new RuntimeDiscoveryAttemptRouter({
        discovery: runtimeDiscovery,
      }).resolve({
        execution: { correlation: { workspaceId, projectId: plan.correlation.projectId } },
        executionPlan: plan,
      })
      expect(route).toMatchObject({ runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' })

      const request = {
        ...ControlApiFixtures.executionAcceptance.request,
        requestId: inputs.correlation.requestId,
        commandId: uniqueIdentifier('cmd'),
        idempotencyKey: `hosted-graph-${randomUUID()}`,
        issuedAt: now,
        payloadHash: digest({ plan: plan.contentDigest, graph: pinned.reference }),
        correlation: { traceId: uniqueIdentifier('trc') },
        projectId: plan.correlation.projectId,
        workspaceId: plan.correlation.workspaceId,
        payload: {
          ...ControlApiFixtures.executionAcceptance.request.payload,
          taskId: plan.correlation.taskId,
          agentId: plan.correlation.agentId,
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            schemaVersion: plan.schemaVersion,
          },
          deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          retentionExpiresAt: new Date(Date.now() + 48 * 24 * 60 * 60_000).toISOString(),
        },
      }

      // Negative control: the ordinary default has no graph authority and rejects this plan.
      // Public-launcher baseline: with the default disabled graph adapter, the
      // same accepted graph request is rejected before durable admission.
      const disabledEnvironment = { ...environment }
      delete disabledEnvironment.CONTROL_PLANE_HOSTED_GRAPH_ENABLED
      delete disabledEnvironment.CONTROL_PLANE_HOSTED_GRAPH_TOOL_CONFIG
      disabledEnvironment.CONTROL_PLANE_DATA_DIR = join(directory, 'disabled')
      const disabled = await start({
        environment: disabledEnvironment,
        compositionOptions: {
          connection: createTestConnection(workspaceDatabase),
          workflowEndpointPort: Number(requiredEnvironment('HOSTED_GRAPH_TEST_ENDPOINT_PORT')),
        },
      })
      try {
        const disabledCredential = (
          await readFile(join(directory, 'disabled', 'auth', 'local-api.token'), 'utf8')
        ).trim()
        const disabledResponse = await fetch(
          `http://127.0.0.1:${environment.HOSTED_CONTROL_PLANE_PORT}/v1/executions/accept`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${disabledCredential}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(request),
          }
        )
        expect(disabledResponse.status).toBeGreaterThanOrEqual(400)
        expect(disabledResponse.status).toBeLessThan(500)
        expect(await disabledResponse.json()).toMatchObject({
          error: { code: 'INVALID_EXECUTION_PLAN_REFERENCE' },
        })
        expect(
          await new PostgresCommandAcceptanceRepository(workspaceDatabase).get({
            callerPrincipalId: 'svc_agent-hq',
            operation: request.operation,
            workspaceId,
            projectId: request.projectId,
            idempotencyKey: request.idempotencyKey,
          })
        ).toBeUndefined()
      } finally {
        await disabled.shutdown('disabled graph baseline complete')
      }

      service = await start({
        environment,
        compositionOptions: {
          connection: createTestConnection(workspaceDatabase),
          workflowEndpointPort: Number(requiredEnvironment('HOSTED_GRAPH_TEST_ENDPOINT_PORT')),
        },
      })
      expect(service.readiness().status).toBe('ready')
      const credential = (
        await readFile(join(dataDirectory, 'auth', 'local-api.token'), 'utf8')
      ).trim()
      const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }
      const apiBase = `http://127.0.0.1:${environment.HOSTED_CONTROL_PLANE_PORT}`
      expect((await fetch(`${apiBase}/ready`)).status).toBe(200)

      const acceptedResponse = await fetch(`${apiBase}/v1/executions/accept`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      })
      const acceptedBody = await acceptedResponse.text()
      if (acceptedResponse.status !== 202) {
        throw new Error(`HOSTED_GRAPH_ACCEPTANCE_FAILED:${acceptedResponse.status}:${acceptedBody}`)
      }
      const accepted = JSON.parse(acceptedBody)
      expect(accepted.data).toMatchObject({ status: 'processing', replayed: false })
      const executionId = accepted.data.executionId
      const executionRepository = new PostgresExecutionRepository(workspaceDatabase)
      const calls = new PostgresToolCallRepository(workspaceDatabase, workspaceId)
      const interactions = new PostgresInteractionRepository(workspaceDatabase)
      const waiting = await waitForValue(async () => {
        const callRows = await calls.listByExecution(executionId)
        const call = callRows[0]
        if (call?.status === 'awaiting_approval' && call.approvalInteractionId) return { call }
        if (
          call &&
          ['succeeded', 'failed', 'denied', 'reconciliation_required'].includes(call.status)
        ) {
          const execution = await executionRepository.getExecution(executionId)
          return { unexpectedCall: call, executionState: execution?.state }
        }
        const execution = await executionRepository.getExecution(executionId)
        if (
          execution &&
          ['completed', 'failed', 'cancelled', 'timed_out', 'reconciliation_required'].includes(
            execution.state
          )
        ) {
          return {
            terminalExecution: execution,
            callStatuses: callRows.map(({ status }) => status),
          }
        }
        return undefined
      }, 30_000)
      if ('unexpectedCall' in waiting) {
        const history = waiting.unexpectedCall.history
          .map(({ status, reasonCode }) => `${status}${reasonCode ? `:${reasonCode}` : ''}`)
          .join(',')
        throw new Error(
          `HOSTED_GRAPH_CALL_DID_NOT_WAIT_FOR_APPROVAL:${waiting.unexpectedCall.status}:${waiting.unexpectedCall.errorCode ?? 'no-code'}:${waiting.executionState ?? 'no-execution'}:${history}`
        )
      }
      if ('terminalExecution' in waiting) {
        throw new Error(
          `HOSTED_GRAPH_TERMINATED_BEFORE_APPROVAL:${waiting.terminalExecution.state}:${waiting.callStatuses.join(',')}`
        )
      }
      const waitingCall = waiting.call
      const interactionId = waitingCall.approvalInteractionId
      const operationIdempotencyKey = waitingCall.idempotencyKey
      expect(operationIdempotencyKey).toMatch(/^graph-op-v1:[a-f0-9]{64}$/)
      const callSuffix = graphToolCallSuffix(operationIdempotencyKey)
      expect(waitingCall.toolCallId).toBe(`tlc_${callSuffix}`)
      expect(interactionId).toBe(`int_${callSuffix}`)
      let interaction = await waitForValue(async () => {
        const row = await interactions.get(interactionId)
        return row?.state === 'pending' ? row : undefined
      }, 30_000)
      expect(interaction).toMatchObject({ state: 'pending', kind: 'approval' })
      expect(waitingCall).toMatchObject({
        status: 'awaiting_approval',
        approvalInteractionId: interactionId,
        idempotencyKey: operationIdempotencyKey,
      })
      const storageThreadId = `${workspaceId}:${executionId}:graph:${executionId}`
      const waitingCheckpoint = await waitForValue(() => checkpointProvider.latest(storageThreadId))
      expect(waitingCheckpoint).toMatchObject({ threadId: storageThreadId })
      const ledger = new DurableUsageLedger({
        store: new PostgresDurableUsageStore(workspaceDatabase),
      })
      expect(
        (await ledger.entries(workspaceId, executionId)).filter(
          ({ kind }) => kind === 'tool_charge'
        )
      ).toHaveLength(0)
      const waitingObjectStore = new FilesystemObjectStore({
        rootDirectory: join(dataDirectory, 'artifacts'),
        maxObjectBytes: 64 * 1024 * 1024,
      })
      try {
        await expect(
          waitingObjectStore.get(waitingCall.result?.output?.artifactRef ?? 'art_missing')
        ).rejects.toMatchObject({ code: 'OBJECT_STORE_NOT_FOUND' })
      } finally {
        await waitingObjectStore.close()
      }

      await service.shutdown('cold graph checkpoint restart')
      service = undefined
      service = await start({
        environment,
        compositionOptions: {
          connection: createTestConnection(workspaceDatabase),
          workflowEndpointPort: Number(requiredEnvironment('HOSTED_GRAPH_TEST_ENDPOINT_PORT')),
        },
      })
      expect(service.readiness().status).toBe('ready')
      interaction = await interactions.get(interactionId)
      expect(interaction).toMatchObject({ state: 'pending', version: 1 })
      const resumedCheckpoint = await checkpointProvider.latest(storageThreadId)
      expect(resumedCheckpoint).toMatchObject({
        threadId: storageThreadId,
        checkpointId: waitingCheckpoint.checkpointId,
      })

      const responseCommand = {
        ...ControlApiFixtures.interactionResponse.request,
        issuedAt: new Date().toISOString(),
        commandId: uniqueIdentifier('cmd'),
        requestId: uniqueIdentifier('req'),
        idempotencyKey: `hosted-graph-approval-${randomUUID()}`,
        payloadHash: digest({ interactionId, action: 'approve' }),
        correlation: { traceId: uniqueIdentifier('trc') },
        projectId: plan.correlation.projectId,
        workspaceId,
        payload: {
          executionId,
          attemptId: waitingCall.attemptId,
          interactionId,
          expectedVersion: interaction.version,
          action: 'approve',
        },
      }
      const approvalResponse = await fetch(`${apiBase}/v1/interactions/respond`, {
        method: 'POST',
        headers,
        body: JSON.stringify(responseCommand),
      })
      expect(approvalResponse.status).toBe(202)
      expect((await approvalResponse.json()).data).toMatchObject({
        executionId,
        interactionId,
        status: 'accepted',
      })

      await waitForValue(async () => {
        const execution = await executionRepository.getExecution(executionId)
        return execution?.state === 'completed' ? execution : undefined
      }, 30_000)
      expect(await checkpointProvider.latest(storageThreadId)).toBeDefined()
      const finalInteraction = await interactions.get(interactionId)
      expect(finalInteraction).toMatchObject({
        state: 'responded',
        response: { action: 'approve' },
      })
      const finishedCalls = await calls.listByExecution(executionId)
      expect(finishedCalls).toHaveLength(1)
      const call = finishedCalls[0]
      expect(call).toMatchObject({
        status: 'succeeded',
        idempotencyKey: operationIdempotencyKey,
      })
      const output = call.result?.output
      expect(output).toMatchObject({
        contentDigest: `sha256:${digestBytes(new TextEncoder().encode(canonicalJsonStringify(document)))}`,
        size: new TextEncoder().encode(canonicalJsonStringify(document)).byteLength,
      })
      const objectStore = new FilesystemObjectStore({
        rootDirectory: join(dataDirectory, 'artifacts'),
        maxObjectBytes: 64 * 1024 * 1024,
      })
      try {
        const stored = await objectStore.get(output.artifactRef)
        expect(Buffer.from(stored.body).toString('utf8')).toBe(canonicalJsonStringify(document))
        expect(stored.sha256).toBe(output.contentDigest)
        expect(stored.metadata).toMatchObject({
          'workspace-id': workspaceId,
          'project-id': plan.correlation.projectId,
          'execution-id': executionId,
          sensitivity: 'internal',
        })
      } finally {
        await objectStore.close()
      }
      const entries = await ledger.entries(workspaceId, executionId)
      const charges = entries.filter(({ kind }) => kind === 'tool_charge')
      expect(charges).toHaveLength(1)
      expect(charges[0]).toMatchObject({
        costMicrounits: 25,
        quantity: { unit: 'calls', value: 1 },
      })
      expect(await ledger.summary(workspaceId, executionId)).toMatchObject({
        spentMicrounits: 25,
        reservedMicrounits: 0,
      })

      const publishedTool = await new ToolRegistry(
        new PostgresToolRegistryRepository(workspaceDatabase, workspaceId)
      ).readVersion(toolVersionId, workspaceId)
      expect(publishedTool).toMatchObject({ lifecycle: 'published', semanticVersion: '1.0.0' })
      expect(publishedTool.contentDigest).toBe(pinned.toolPin.contentDigest)

      const replay = await fetch(`${apiBase}/v1/executions/accept`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      })
      expect(replay.status).toBe(202)
      expect((await replay.json()).data).toMatchObject({ executionId, replayed: true })
      expect(await calls.listByExecution(executionId)).toHaveLength(1)
      expect(
        (await ledger.entries(workspaceId, executionId)).filter(
          ({ kind }) => kind === 'tool_charge'
        )
      ).toHaveLength(1)
    },
    integrationTestTimeout(60_000)
  )
})

async function publishGraph(database, workspaceIdInput, config, publishedAt) {
  const toolPin = (await import('./hosted-graph-tool-operations.ts')).createHostedGraphToolBinding(
    config
  ).pin
  const catalog = new GraphDefinitionCatalog(
    new PostgresGraphDefinitionRepository(database, workspaceIdInput)
  )
  const published = await catalog.publish({
    publishedAt,
    definition: {
      graphDefinitionId: 'hosted:approval-cold-resume',
      graphVersion: '1.0.0',
      schemaVersion: 1,
      nodes: [{ node: 'store-result', operation: { kind: 'tool', name: 'store', toolPin } }],
      edges: [
        { from: '__start__', to: 'store-result' },
        { from: 'store-result', to: '__end__' },
      ],
      schemas: { input: 'schema:json', state: 'schema:json', output: 'schema:json' },
      requiredCapabilities: ['graph.tool-pins.v1'],
      compatibility: {
        contractMajorVersions: [1],
        compilerVersions: ['1.0.0'],
        adapterVersions: ['1.4.12'],
      },
    },
  })
  return { ...published, toolPin }
}

function graphToolCallSuffix(idempotencyKey) {
  const suffix = createHash('sha256')
    .update(idempotencyKey)
    .digest('hex')
    .slice(0, 26)
    .toUpperCase()
  return suffix
}

function runtimeDiscoveryProjection(requiredCapabilities) {
  const observedAt = new Date().toISOString()
  return {
    runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
    runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
    family: 'mock',
    connectionType: 'managed_local',
    location: 'local_device',
    status: 'available',
    node: {
      runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
      location: 'local_device',
      status: 'online',
      health: 'online',
      observedAt,
    },
    connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
    freshness: {
      state: 'fresh',
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60 * 60_000).toISOString(),
    },
    versions: { adapter: '1.0.0', driver: '1.0.0', harness: '1.0.0' },
    capabilities: requiredCapabilities,
    capabilityDetails: requiredCapabilities.map((name) => ({ name, support: 'supported' })),
    compatibility: { state: 'compatible', limitations: [] },
    access: {
      localProjectGrant: { required: true, state: 'granted' },
      entitlement: { state: 'allowed' },
    },
    eligibility: { state: 'eligible', reasons: [], degradations: [], remediation: [] },
    observedAt,
    limitations: [],
  }
}

function createTestConnection(database) {
  return { database, check: async () => undefined, close: async () => undefined }
}

async function waitForValue(read, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('HOSTED_GRAPH_RESTATE_WAIT_TIMEOUT')
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name}_REQUIRED`)
  return value
}

function digest(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
}

function digestBytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function uniqueIdentifier(prefix) {
  return `${prefix}_${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 26).toUpperCase()}`
}
