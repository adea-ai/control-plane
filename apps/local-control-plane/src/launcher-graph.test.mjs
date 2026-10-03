import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'bun:test'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { canonicalJsonStringify, ControlApiFixtures } from '@control-plane/contracts'
import { executionConstraintFixtures } from '@control-plane/domain'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { FilesystemObjectStore } from '@control-plane/object-store'
import {
  SqliteContextPackageRepository,
  SqliteCommandAcceptanceRepository,
  SqliteDurableUsageStore,
  SqliteExecutionRepository,
  SqliteInteractionRepository,
  SqlitePersistenceProvider,
  SqliteProjectStateRepository,
  SqliteToolCallRepository,
  SqliteToolRegistryRepository,
  SqliteVersionedCatalogRepository,
} from '@control-plane/sqlite-persistence'
import { ToolRegistry } from '@control-plane/tool-execution/registry'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { start } from './index.ts'
import { seedSystemCatalogOwners } from './test-catalog-owners.mjs'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const toolDefinitionId = 'tld_01JABCDEF0123456789ABCDEFG'
const toolVersionId = 'tlv_01JABCDEF0123456789ABCDEFG'
const toolName = 'local-object-store-json'
const toolVersion = '1.0.0'
const configuredTariff = { currency: 'USD', costMicrounits: 25 }
const resourceLedger = process.env['CONTROL_PLANE_LOCAL_RESOURCE_LEDGER']

test('supported start launcher bootstraps the pinned JSON tool and resumes an authorized graph after a cold restart', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'local-graph-launcher-'))
  const configPath = join(dataDirectory, 'graph-tool.json')
  const port = await freeLoopbackPort()
  let service
  let observer
  let objects
  try {
    const inputs = await seedPlanCatalog(dataDirectory)
    const config = graphToolConfig()
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
    await recordLauncherListener(port)
    const environment = {
      APP_ENV: 'test',
      INSTANCE_ID: 'local-graph-launcher-test',
      LOCAL_CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_LOCAL_GRAPH_CONFIG: configPath,
    }

    service = await startLocal(dataDirectory, environment)
    expect(service.readiness().status).toBe('ready')
    const token = (await readFile(join(dataDirectory, 'auth', 'local-api.token'), 'utf8')).trim()
    const baseUrl = `http://127.0.0.1:${port}`

    observer = await openPersistence(dataDirectory)
    const registry = new ToolRegistry(new SqliteToolRegistryRepository(observer, workspaceId))
    const version = await registry.readVersion(toolVersionId, workspaceId)
    expect(version.lifecycle).toBe('published')
    expect(version).toMatchObject({
      toolDefinitionId,
      semanticVersion: toolVersion,
      operations: [
        {
          name: 'store-json',
          riskClass: 'medium',
          approvalMode: 'always',
          requiredCapabilities: ['object-store.write'],
        },
      ],
      executor: { type: 'internal', reference: 'local.object-store-json.v1' },
    })

    const graphDefinition = {
      graphDefinitionId: 'launcher-store-json',
      graphVersion: '1.0.0',
      schemaVersion: 1,
      nodes: [
        {
          node: 'store',
          operation: {
            kind: 'tool',
            name: 'store',
            toolPin: {
              toolDefinitionId,
              toolVersionId,
              contentDigest: version.contentDigest,
              operation: 'store-json',
            },
          },
        },
      ],
      edges: [
        { from: '__start__', to: 'store' },
        { from: 'store', to: '__end__' },
      ],
      schemas: {
        input: 'local.graph-json-object.v1',
        state: 'local.graph-state.v1',
        output: 'local.graph-json-object.v1',
      },
      requiredCapabilities: ['graph.tool-pins.v1'],
      compatibility: {
        contractMajorVersions: [1],
        compilerVersions: ['1.0.0'],
        adapterVersions: ['1.4.12'],
      },
    }
    const graphPublishRequest = {
      ...ControlApiFixtures.executionValidation.request,
      operation: 'graph.publish',
      workspaceId,
      idempotencyKey: 'launcher-graph-publish-0001',
      issuedAt: new Date().toISOString(),
      payload: { definition: graphDefinition },
    }
    delete graphPublishRequest.projectId
    const publishedGraph = await post(baseUrl, '/v1/graphs/publish', graphPublishRequest, token)
    expect(publishedGraph.status).toBe(200)
    const graphReference = publishedGraph.body.data.definition.reference

    const validationRequest = createValidationRequest(inputs, graphReference)
    const validation = await post(baseUrl, '/v1/executions/validate', validationRequest, token)
    expect(validation.status).toBe(200)
    expect(validation.body.data.valid).toBe(true)
    const executionPlan = validation.body.data.executionPlan
    const acceptanceRequest = createAcceptanceRequest(inputs, validationRequest, executionPlan)
    const acceptance = await post(baseUrl, '/v1/executions/accept', acceptanceRequest, token)
    if (acceptance.status !== 202) throw new Error(JSON.stringify(acceptance))
    expect(acceptance.status).toBe(202)
    const executionId = acceptance.body.data.executionId
    const attemptId = `att_${executionId.slice(4)}`

    const calls = new SqliteToolCallRepository(observer, workspaceId)
    const pendingCall = await waitFor(async () => {
      const current = await calls.listByExecution(executionId)
      return current.find((candidate) => candidate.status === 'awaiting_approval')
    })
    expect(pendingCall).toBeDefined()
    const interactionId = pendingCall.approvalInteractionId
    const interaction = await new SqliteInteractionRepository(observer).get(interactionId)
    expect(interaction).toMatchObject({ state: 'pending' })
    const objectKey = artifactRef(workspaceId, executionId, pendingCall.idempotencyKey)
    objects = new FilesystemObjectStore({
      rootDirectory: join(dataDirectory, 'artifacts'),
      maxObjectBytes: 12 * 1024 * 1024,
    })
    await expect(objects.head(objectKey)).rejects.toThrow()
    expect(
      await new DurableUsageLedger({ store: new SqliteDurableUsageStore(observer) }).summary(
        workspaceId,
        executionId
      )
    ).toMatchObject({ reservedMicrounits: 25, spentMicrounits: 0 })

    observer.close()
    observer = undefined
    await service.shutdown('launcher-cold-checkpoint')
    service = undefined
    await expectPortClosed(port)

    service = await startLocal(dataDirectory, environment)
    expect(service.readiness().status).toBe('ready')
    observer = await openPersistence(dataDirectory)
    const resumedCall = (
      await new SqliteToolCallRepository(observer, workspaceId).listByExecution(executionId)
    )[0]
    expect(resumedCall).toMatchObject({
      status: 'awaiting_approval',
      idempotencyKey: pendingCall.idempotencyKey,
      approvalInteractionId: interactionId,
      toolVersionId,
    })
    await expect(objects.head(objectKey)).rejects.toThrow()

    const currentInteraction = await new SqliteInteractionRepository(observer).get(interactionId)
    const responseRequest = {
      ...ControlApiFixtures.interactionResponse.request,
      requestId: 'req_01JABCDEF0123456789ABCDEFH',
      commandId: 'cmd_01JABCDEF0123456789ABCDEFH',
      workspaceId,
      projectId: inputs.correlation.projectId,
      idempotencyKey: 'launcher-graph-approval-0001',
      payload: {
        executionId,
        attemptId,
        interactionId,
        expectedVersion: currentInteraction.version,
        action: 'approve',
      },
    }
    const response = await post(baseUrl, '/v1/interactions/respond', responseRequest, token)
    expect(response.status).toBe(202)

    await waitFor(async () => {
      const call = await new SqliteToolCallRepository(observer, workspaceId).getByIdempotencyKey(
        workspaceId,
        pendingCall.idempotencyKey
      )
      const execution = await new SqliteExecutionRepository(observer).getExecution(executionId)
      return call?.status === 'succeeded' && execution?.state === 'completed'
    }, 5_000)
    const saved = await objects.get(objectKey)
    const expectedBytes = new TextEncoder().encode(
      canonicalJsonStringify({ message: 'authorized after cold restart' })
    )
    const expectedDigest = `sha256:${createHash('sha256').update(expectedBytes).digest('hex')}`
    expect(saved.key).toBe(objectKey)
    expect(new TextDecoder().decode(saved.body)).toBe(
      canonicalJsonStringify({ message: 'authorized after cold restart' })
    )
    expect(saved.sha256).toBe(expectedDigest)
    expect(saved.metadata).toMatchObject({
      'workspace-id': workspaceId,
      'project-id': inputs.correlation.projectId,
      'execution-id': executionId,
      sensitivity: 'internal',
    })

    const successfulCall = await new SqliteToolCallRepository(
      observer,
      workspaceId
    ).getByIdempotencyKey(workspaceId, pendingCall.idempotencyKey)
    expect(successfulCall.result.output).toEqual({
      artifactRef: objectKey,
      contentDigest: expectedDigest,
      size: expectedBytes.byteLength,
    })
    expect(
      (await new SqliteExecutionRepository(observer).getExecution(executionId)).terminalResultRef
    ).toBe(objectKey)
    expect(
      await new SqliteCommandAcceptanceRepository(observer).getByExecutionId(executionId)
    ).toMatchObject({
      status: 'completed',
      resultReference: objectKey,
    })
    expect(
      await new SqliteToolCallRepository(observer, workspaceId).listByExecution(executionId)
    ).toHaveLength(1)
    expect(
      await new DurableUsageLedger({ store: new SqliteDurableUsageStore(observer) }).summary(
        workspaceId,
        executionId
      )
    ).toMatchObject({ spentMicrounits: configuredTariff.costMicrounits, reservedMicrounits: 0 })
    observer.close()
    observer = undefined
    await service.shutdown('launcher-replay-checkpoint')
    service = undefined
    await expectPortClosed(port)
    service = await startLocal(dataDirectory, environment)
    expect(service.readiness().status).toBe('ready')
    const replay = await post(baseUrl, '/v1/executions/accept', acceptanceRequest, token)
    expect(replay.status).toBe(202)
    expect(replay.body.data.replayed).toBe(true)
    observer = await openPersistence(dataDirectory)
    expect(
      await new SqliteToolCallRepository(observer, workspaceId).listByExecution(executionId)
    ).toHaveLength(1)
    expect(
      await new DurableUsageLedger({ store: new SqliteDurableUsageStore(observer) }).summary(
        workspaceId,
        executionId
      )
    ).toMatchObject({ spentMicrounits: configuredTariff.costMicrounits, reservedMicrounits: 0 })
    observer.close()
    observer = undefined
    await service.shutdown('launcher-config-change-checkpoint')
    service = undefined
    await expectPortClosed(port)

    await writeFile(
      configPath,
      `${JSON.stringify({ ...config, costMicrounits: config.costMicrounits + 1 }, null, 2)}\n`
    )
    await recordLauncherListener(port)
    await expect(startLocal(dataDirectory, environment)).rejects.toThrow('Service startup failed')
    await expectPortClosed(port)
  } finally {
    observer?.close()
    objects?.close()
    if (service) await service.shutdown('launcher-test-finally')
    await expectPortClosed(port)
    await rm(dataDirectory, { recursive: true, force: true })
  }
}, 60_000)

test('failed graph tool bootstrap does not pin config before an operator corrects a registry conflict', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'local-graph-launcher-repair-'))
  const configPath = join(dataDirectory, 'graph-tool.json')
  const port = await freeLoopbackPort()
  let service
  let persistence
  try {
    const initial = graphToolConfig()
    const corrected = {
      ...initial,
      toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFH',
      toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFH',
    }
    persistence = await openPersistence(dataDirectory)
    const registry = new ToolRegistry(new SqliteToolRegistryRepository(persistence, workspaceId))
    await registry.createDefinition({
      toolDefinitionId: initial.toolDefinitionId,
      name: 'occupied-tool',
      displayName: 'Existing tool',
      description: 'Intentionally conflicts with the first launcher bootstrap',
      ownership: { scope: 'workspace', workspaceId },
      createdAt: initial.createdAt,
    })
    persistence.close()
    persistence = undefined

    const environment = {
      APP_ENV: 'test',
      INSTANCE_ID: 'local-graph-launcher-repair-test',
      LOCAL_CONTROL_PLANE_PORT: String(port),
      CONTROL_PLANE_LOCAL_GRAPH_CONFIG: configPath,
    }
    await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`)
    await recordLauncherListener(port)
    await expect(startLocal(dataDirectory, environment)).rejects.toThrow('Service startup failed')
    await expectPortClosed(port)

    await writeFile(configPath, `${JSON.stringify(corrected, null, 2)}\n`)
    await recordLauncherListener(port)
    service = await startLocal(dataDirectory, environment)
    expect(service.readiness().status).toBe('ready')
    persistence = await openPersistence(dataDirectory)
    const repairedRegistry = new ToolRegistry(
      new SqliteToolRegistryRepository(persistence, workspaceId)
    )
    expect(
      (await repairedRegistry.readVersion(corrected.toolVersionId, workspaceId)).lifecycle
    ).toBe('published')
    expect(
      await persistence.transaction((transaction) =>
        transaction.get('local-graph-launcher-config', workspaceId)
      )
    ).toMatchObject({ value: { schemaVersion: 1 } })
  } finally {
    persistence?.close()
    if (service) await service.shutdown('launcher-repair-test-finally')
    await expectPortClosed(port)
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

for (const scenario of [
  {
    name: 'incomplete operator config',
    config: (() => {
      const { publishedAt: _omitted, ...incomplete } = graphToolConfig()
      return incomplete
    })(),
  },
  {
    name: 'conflicting graph activity injection',
    config: graphToolConfig(),
    compositionOptions: { graphActivities: {} },
  },
  {
    name: 'missing direct runtime',
    config: graphToolConfig(),
    compositionOptions: { runtimeTransport: undefined },
  },
]) {
  test(`supported start fails closed for ${scenario.name} before listening`, async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'local-graph-launcher-invalid-'))
    const configPath = join(dataDirectory, 'graph-tool.json')
    const port = await freeLoopbackPort()
    try {
      await writeFile(configPath, `${JSON.stringify(scenario.config, null, 2)}\n`)
      await recordLauncherListener(port)
      await expect(
        startLocal(
          dataDirectory,
          {
            APP_ENV: 'test',
            INSTANCE_ID: 'local-graph-launcher-invalid-test',
            LOCAL_CONTROL_PLANE_PORT: String(port),
            CONTROL_PLANE_LOCAL_GRAPH_CONFIG: configPath,
          },
          scenario.compositionOptions
        )
      ).rejects.toThrow('Service startup failed')
      await expectPortClosed(port)
    } finally {
      await expectPortClosed(port)
      await rm(dataDirectory, { recursive: true, force: true })
    }
  })
}

function graphToolConfig() {
  return {
    schemaVersion: 1,
    workspaceId,
    toolDefinitionId,
    toolVersionId,
    ...configuredTariff,
    createdAt: '2026-10-02T00:00:00.000Z',
    publishedAt: '2026-10-02T00:01:00.000Z',
  }
}

async function seedPlanCatalog(dataDirectory) {
  const persistence = new SqlitePersistenceProvider({
    path: join(dataDirectory, 'control-plane.sqlite'),
  })
  try {
    await persistence.migrate()
    const inputs = createExecutionPlanTestFixtureInputs({
      contextPackage: contextPackageSerializationFixtures.futurePi,
      profileCapabilityRequirements: [],
      skillRequiredCapabilities: [],
    })
    const constraints = structuredClone(executionConstraintFixtures.write)
    constraints.tools.grants = [
      {
        tool: { toolId: toolName, versionRange: toolVersion },
        operations: ['store-json'],
        requiredCapabilities: ['object-store.write'],
        riskClass: 'write',
        approval: 'always',
      },
    ]
    constraints.interaction.approvals = 'required'
    inputs.constraints = constraints
    inputs.profile.definition.executionConstraints = constraints
    inputs.profile.definition.capabilityRequirements = []
    inputs.skills[0].manifest.requiredCapabilities = []
    inputs.skills[0].manifest.requiredTools = [{ toolId: toolName, versionRange: toolVersion }]

    const catalog = new SqliteVersionedCatalogRepository(persistence)
    await seedSystemCatalogOwners(catalog, inputs.profile, inputs.skills)
    await catalog.insertAgentProfileVersion(inputs.profile)
    for (const skill of inputs.skills) await catalog.insertSkillVersion(skill)
    await new SqliteContextPackageRepository(persistence).put(inputs.contextPackage)
    await new SqliteProjectStateRepository(persistence).create({
      schemaVersion: 1,
      ...inputs.contextPackage.projectState,
      items: [],
      createdAt: inputs.compiledAt,
      updatedAt: inputs.compiledAt,
    })
    return inputs
  } finally {
    persistence.close()
  }
}

function artifactRef(artifactWorkspaceId, executionId, idempotencyKey) {
  const requestId = `req_${createHash('sha256')
    .update(idempotencyKey)
    .digest('hex')
    .slice(0, 26)
    .toUpperCase()}`
  const suffix = createHash('sha256')
    .update(canonicalJsonStringify([artifactWorkspaceId, executionId, requestId]))
    .digest('hex')
    .slice(0, 26)
    .toUpperCase()
  return `art_${suffix}`
}

function createValidationRequest(inputs, graphReference) {
  const base = ControlApiFixtures.executionValidation.request
  return {
    ...base,
    workspaceId,
    projectId: inputs.correlation.projectId,
    issuedAt: new Date().toISOString(),
    idempotencyKey: 'launcher-graph-validation-0001',
    payload: {
      ...base.payload,
      taskId: inputs.correlation.taskId,
      agentId: inputs.correlation.agentId,
      profileVersionId: inputs.profile.profileVersionId,
      skillVersionIds: inputs.skills.map((skill) => skill.skillVersionId),
      projectState: inputs.contextPackage.projectState,
      contextPackage: {
        contextPackageId: inputs.contextPackage.contextPackageId,
        contentDigest: inputs.contextPackage.contentDigest,
        schemaVersion: inputs.contextPackage.schemaVersion,
        compilerVersion: inputs.contextPackage.compiler.version,
      },
      policySnapshot: {
        policySnapshotId: inputs.constraints.policySnapshot.policyId,
        revision: inputs.constraints.policySnapshot.version,
        contentDigest: inputs.constraints.policySnapshot.digest,
      },
      runtimeRequirements: ['stream.output'],
      outputContractRef: inputs.outputContract.contractRef,
      graph: { reference: graphReference, input: { message: 'authorized after cold restart' } },
    },
  }
}

function createAcceptanceRequest(inputs, validationRequest, planReference) {
  const base = ControlApiFixtures.executionAcceptance.request
  const now = Date.now()
  return {
    ...base,
    workspaceId,
    projectId: inputs.correlation.projectId,
    requestId: validationRequest.requestId,
    correlation: validationRequest.correlation,
    operation: 'execution.accept',
    idempotencyKey: 'launcher-graph-accept-0001',
    payloadHash: 'b'.repeat(64),
    issuedAt: new Date(now).toISOString(),
    payload: {
      ...base.payload,
      taskId: inputs.correlation.taskId,
      agentId: inputs.correlation.agentId,
      executionPlan: { ...planReference, schemaVersion: 1 },
      deadlineAt: new Date(now + 5 * 60_000).toISOString(),
      retentionExpiresAt: new Date(now + 45 * 24 * 60 * 60_000).toISOString(),
    },
  }
}

async function startLocal(dataDirectory, environment, compositionOverrides = {}) {
  return start({
    apiHost: '127.0.0.1',
    environment,
    logger: { write() {} },
    processAdapter: createProcessAdapter(),
    compositionOptions: {
      dataDirectory,
      // Graph execution does not dispatch a model/runtime node; keep this explicit local
      // transport fixture so the test exercises only the real graph/tool admission path.
      runtimeTransport: { transportKind: 'direct-local' },
      ...compositionOverrides,
    },
  })
}

function createProcessAdapter() {
  const listeners = new Map()
  return {
    on(event, listener) {
      const bucket = listeners.get(event) ?? new Set()
      bucket.add(listener)
      listeners.set(event, bucket)
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    setExitCode() {},
  }
}

async function post(baseUrl, url, payload, token) {
  const response = await fetch(new URL(url, baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  return { status: response.status, body }
}

async function openPersistence(dataDirectory) {
  const persistence = new SqlitePersistenceProvider({
    path: join(dataDirectory, 'control-plane.sqlite'),
  })
  await persistence.migrate()
  return persistence
}

async function waitFor(read, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await Bun.sleep(25)
  }
  throw new Error('LOCAL_GRAPH_LAUNCHER_TEST_TIMEOUT')
}

async function freeLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('LOCAL_TEST_PORT_UNAVAILABLE')
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}

async function recordLauncherListener(port) {
  if (resourceLedger === undefined) return
  await mkdir(dirname(resourceLedger), { recursive: true })
  await appendFile(
    resourceLedger,
    `\n${new Date().toISOString()} planned Local launcher start() attempt: PID ${process.pid}, loopback 127.0.0.1:${port}; the test expects a bounded supported service start/shutdown or startup rejection before the listener opens, and verifies the port is closed before removing its temporary data directory. No child process.\n`
  )
}

async function expectPortClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = createServer()
    socket.once('error', reject)
    socket.listen(port, '127.0.0.1', () => {
      socket.close((error) => (error ? reject(error) : resolve()))
    })
  })
}
