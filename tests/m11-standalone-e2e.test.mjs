import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, test } from 'bun:test'
import { AcpAdapter, AcpDriver, ReferenceAcpTransport } from '@control-plane/acp-adapter'
import { ControlApiFixtures } from '@control-plane/contracts'
import { ControlPlaneClient } from '@control-plane/sdk'
import {
  createControlApiApplication,
  createPrivateApiAuthentication,
} from '../apps/control-api/dist/index.js'
import {
  createFilesystemCheckpoint,
  restoreFilesystemCheckpoint,
  verifyFilesystemCheckpoint,
} from '@control-plane/deployment'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  LangGraphOrchestrationAdapter,
  LangGraphSqliteCheckpointSaver,
  deterministicInterruptGraph,
} from '../packages/langgraph-adapter/src/index.ts'
import { OrchestrationGraphSegmentActivities } from '../packages/workflow-runtime/src/index.ts'
import {
  LocalControlPlaneComposition,
  createLocalManagedPiRuntime,
} from '@control-plane/local-control-plane'
import { ManagedPiAdapter, ManagedPiDriver } from '@control-plane/managed-pi-adapter'
import {
  DirectLocalRuntimeTransport,
  ExternalSessionRegistry,
  InMemoryExternalSessionRepository,
  InMemoryRuntimeConnectionRepository,
  RecordingRuntimeAvailabilityChangePublisher,
  RuntimeConnectionRegistry,
  RuntimeHealthIngestionService,
} from '@control-plane/runtime-sdk'
import {
  DefaultRuntimeInventoryNormalizer,
  InMemoryRuntimeNodeCoordination,
  RecordingGatewayMetrics,
  RecordingRuntimeNodeReachabilityPublisher,
  RuntimeGatewayWebSocketLifecycle,
  RuntimeInventoryIngestionService,
  RuntimeInventoryMessageHandler,
  RuntimeNodeChannelAuthenticator,
  SyntheticRuntimeNodeIdentityAuthority,
} from '../apps/runtime-gateway/dist/index.js'
import { writeManagedPiRpcFixture } from '../packages/managed-pi-adapter/src/test-support/managed-pi-rpc-fixture.mjs'

const observedAt = '2026-08-30T12:00:00.000Z'
const workflowId = 'wfl_01JABCDEF0123456789ABCDEFG'

describe('M11 standalone execution composition', () => {
  test('SDK invokes the authenticated interaction HTTP route with private credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-m11-interaction-sdk-'))
    let application
    try {
      const authentication = await createPrivateApiAuthentication(directory)
      const credential = (await readFile(authentication.credentialFile, 'utf8')).trim()
      const calls = []
      const metadata = {
        serviceName: 'control-api',
        version: 'test',
        commitSha: 'test',
        environment: 'test',
        instanceId: 'interaction-sdk',
      }
      application = await createControlApiApplication({
        metadata,
        logger: { write: () => undefined },
        health: () => ({ status: 'ok', metadata }),
        readiness: () => ({ status: 'ready', metadata }),
        serviceAuthenticator: authentication.authenticator,
        interactionCommandService: {
          respond: async (input, principal) => {
            calls.push({ input, principal })
            return ControlApiFixtures.interactionResponse.response
          },
        },
      })
      // Exercise the real HTTP router without leaving a listening test server behind.
      const fetch = async (url, init) => {
        const response = await application.inject({
          method: init.method,
          url: new URL(url).pathname,
          headers: init.headers,
          payload: init.body,
        })
        return new Response(response.body, {
          status: response.statusCode,
          headers: response.headers,
        })
      }
      const client = new ControlPlaneClient({
        baseUrl: 'http://127.0.0.1',
        credential,
        fetch,
      })
      expect(
        await client.respondToInteraction(ControlApiFixtures.interactionResponse.request)
      ).toEqual(ControlApiFixtures.interactionResponse.response)
      expect(calls).toEqual([
        { input: ControlApiFixtures.interactionResponse.request, principal: 'svc_agent-hq' },
      ])
      const unauthorized = new ControlPlaneClient({
        baseUrl: 'http://127.0.0.1',
        credential: 'invalid',
        fetch,
      })
      await expect(
        unauthorized.respondToInteraction(ControlApiFixtures.interactionResponse.request)
      ).rejects.toMatchObject({
        status: 401,
        code: 'PRIVATE_API_AUTHENTICATION_FAILED',
        errorClass: 'authentication',
      })
      expect(calls).toHaveLength(1)
    } finally {
      await application?.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
  test.each(['restart', 'checkpoint-restore'])(
    'resumes a graph approval after restarting real Local Restate and SQLite (%s)',
    async (recoveryMode) => {
      const directory = await mkdtemp(join(tmpdir(), 'control-plane-m11-graph-restate-'))
      let dataDirectory = join(directory, 'original')
      const plan = createExecutionPlanTestFixture()
      let executionId, artifactId, resultKey
      const graph = {
        graphDefinitionId: 'local-restate-recovery',
        graphVersion: '1.0.0',
        contentDigest: `sha256:${'a'.repeat(64)}`,
      }
      const operations = []
      const registration = deterministicInterruptGraph(graph)
      const createLocal = () =>
        new LocalControlPlaneComposition({
          dataDirectory,
          runtimeTransport: createDirectManagedPiAdapter(),
          workflowEndpointPort: 19080,
          graphActivitiesFactory: ({ persistence }) =>
            new OrchestrationGraphSegmentActivities(
              new LangGraphOrchestrationAdapter({
                checkpointer: new LangGraphSqliteCheckpointSaver(
                  persistence,
                  plan.correlation.workspaceId
                ),
                graphs: [
                  {
                    reference: graph,
                    build(context) {
                      const runnable = registration.build(context)
                      return {
                        invoke: async (input, config) => {
                          const state = await runnable.invoke(input, config)
                          if (state.output?.decision === undefined) return state
                          await local.objectStore.put({
                            key: resultKey,
                            body: new TextEncoder().encode(JSON.stringify(state.output)),
                            contentType: 'application/json',
                            metadata: { execution: executionId },
                          })
                          return { ...state, output: { ...state.output, artifactRef: artifactId } }
                        },
                      }
                    },
                  },
                ],
                operations: {
                  invoke: async ({ name }) => {
                    operations.push(name)
                    return { value: name }
                  },
                  cancel: async () => true,
                },
                events: { publish: async () => {} },
              })
            ),
        })
      let local = createLocal()
      const post = (path, body) =>
        fetch(`http://127.0.0.1:8080/execution-lifecycle/${executionId}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        })
      try {
        await local.start()
        await local.executionPlans.put(plan)
        const acceptedAt = new Date().toISOString()
        const deadlineAt = new Date(Date.now() + 90000).toISOString()
        const executionPlan = {
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
          schemaVersion: plan.schemaVersion,
        }
        const accepted = await local.commands.acceptExecution({
          ...command(plan),
          receivedAt: acceptedAt,
          retentionExpiresAt: new Date(Date.parse(acceptedAt) + 30 * 86400000).toISOString(),
        })
        executionId = accepted.execution.executionId
        artifactId = `art_${executionId.slice(4)}`
        resultKey = `graph-results/${executionId}/result.json`
        const input = {
          executionId,
          workflowId: `wfl_${executionId.slice(4)}`,
          executionPlan,
          deadlineAt,
          graph: {
            workspaceId: plan.correlation.workspaceId,
            reference: graph,
            threadId: 'local-restate-thread',
            input: { objective: 'recover graph approval' },
          },
        }
        expect((await post('run/send', input)).ok).toBe(true)
        const waitDeadline = Date.now() + 15000
        while ((await local.executions.getExecution(executionId)).state !== 'awaiting_input') {
          if (Date.now() > waitDeadline) throw new Error('GRAPH_RESTATE_APPROVAL_TIMEOUT')
          await delay(25)
        }
        expect(operations).toEqual(['prepare'])
        const retainedArtifact = await local.objectStore.put({
          key: 'recovery/preexisting.json',
          body: new TextEncoder().encode('{"retained":true}'),
          contentType: 'application/json',
          metadata: { execution: executionId },
        })
        await local.close()
        if (recoveryMode === 'checkpoint-restore') {
          const checkpointDirectory = join(directory, 'checkpoint')
          const checkpoint = await createFilesystemCheckpoint({
            sourceDirectory: dataDirectory,
            destinationDirectory: checkpointDirectory,
            profile: 'local',
          })
          expect(await verifyFilesystemCheckpoint(checkpointDirectory)).toEqual(checkpoint)
          dataDirectory = join(directory, 'restored')
          await restoreFilesystemCheckpoint({
            checkpointDirectory,
            destinationDirectory: dataDirectory,
          })
        }
        local = createLocal()
        await local.start()
        expect((await local.objectStore.get('recovery/preexisting.json')).sha256).toBe(
          retainedArtifact.sha256
        )
        expect((await local.executions.getExecution(executionId)).state).toBe('awaiting_input')
        const invalidResponse = await post('respondToInteraction', {
          interactionId: 'approval-1',
          responseId: 'invalid-graph-response',
          action: 'approve',
          value: 'not-an-input-response',
        })
        expect(invalidResponse.status).toBe(400)
        expect(
          (
            await post('respondToInteraction', {
              interactionId: 'approval-1',
              responseId: 'graph-response-one',
              action: 'approve',
            })
          ).ok
        ).toBe(true)
        const execution = await waitForTerminalExecution(local, executionId)
        expect(execution.state).toBe('completed')
        expect(execution.terminalResultRef).toBe(artifactId)
        expect(
          JSON.parse(new TextDecoder().decode((await local.objectStore.get(resultKey)).body))
        ).toEqual({ decision: 'approve' })
        const result = await fetch(
          `http://127.0.0.1:8080/restate/workflow/execution-lifecycle/${executionId}/attach`,
          { signal: AbortSignal.timeout(15000) }
        )
        expect(result.ok).toBe(true)
        expect(await result.json()).toMatchObject({
          status: 'completed',
          graphCheckpointId: expect.any(String),
        })
        expect(operations).toEqual(['prepare', 'finalize'])
      } finally {
        await local.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
    60000
  )

  test.each([
    ['managed-pi', createDirectManagedPiAdapter],
    ['acp', createDirectAcpAdapter],
  ])(
    'runs and recovers %s through Local without a Runtime Gateway',
    async (family, createAdapter) => {
      const directory = await mkdtemp(join(tmpdir(), 'control-plane-m11-local-'))
      let publishDiscovery = async () => {
        throw new Error('M11_SESSION_PROJECTION_UNCONFIGURED')
      }
      const adapter = createAdapter((input) => publishDiscovery(input))
      const inspection = await adapter.inspect()
      expect(inspection).toMatchObject({
        health: 'healthy',
        metadata: { transportKind: 'direct-local' },
      })

      const first = composition(directory, adapter)
      publishDiscovery = ({ scope, model }) =>
        first.runtimeDiscoveryRepository.putExternalSession(scope, model)
      let executionId
      let attemptId
      let resultReference
      try {
        await first.start()
        expect(await first.manifest()).toMatchObject({
          profile: 'local',
          topology: { externalServices: 0, runtimeTransport: 'direct-local' },
        })
        const plan = family === 'acp' ? createAcpExecutionPlan() : createExecutionPlanTestFixture()
        await first.executionPlans.put(plan)
        const accepted = await first.commands.acceptExecution(command(plan))
        executionId = accepted.execution.executionId
        attemptId = `att_${executionId.slice(4)}`
        const activities = first.executionLifecycleActivities
        await activities.persistStatus(status(executionId, 'queued'))
        await activities.ensureAttempt({
          executionId,
          workflowId,
          effectKey: `${workflowId}:attempt`,
        })
        await activities.persistStatus(status(executionId, 'starting', attemptId))
        await activities.persistStatus(status(executionId, 'running', attemptId))
        const outcome = await activities.dispatch({
          executionId,
          attemptId,
          executionPlan: plan,
          effectKey: `${workflowId}:dispatch`,
        })
        expect(outcome).toMatchObject({ outcome: 'completed' })
        resultReference = outcome.resultReference
        await activities.persistStatus({
          ...status(executionId, 'completed', attemptId),
          resultReference,
        })
        if (family === 'acp') {
          await adapter.session({ operation: 'list' })
          expect(
            await first.runtimeDiscoveryRepository.listExternalSessions({
              workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
              projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            })
          ).toEqual([
            expect.objectContaining({
              externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
              state: 'active',
            }),
          ])
        }
      } finally {
        await first.close()
      }

      const restarted = composition(directory, adapter)
      try {
        await restarted.start()
        expect(await restarted.executions.getExecution(executionId)).toMatchObject({
          state: 'completed',
          latestAttemptId: attemptId,
          terminalResultRef: resultReference,
        })
        expect(await restarted.executions.getAttempt(attemptId)).toMatchObject({
          state: 'completed',
          terminalResultRef: resultReference,
        })
        expect(await restarted.commandRepository.getByExecutionId(executionId)).toMatchObject({
          status: 'completed',
          resultReference,
        })
        if (family === 'acp') {
          expect(
            await restarted.runtimeDiscoveryRepository.listExternalSessions({
              workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
              projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            })
          ).toHaveLength(1)
        }
      } finally {
        await restarted.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
    30_000
  )

  test.each(['complete', 'cancel'])(
    'accepts and settles Local execution through real Restate: %s',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'control-plane-m11-restate-'))
      const client =
        mode === 'cancel' ? new PendingManagedPiClient() : new CompletedManagedPiClient()
      const local = new LocalControlPlaneComposition({
        dataDirectory: directory,
        runtimeTransport: createManagedPiAdapterWithClient(client),
        workflowEndpointPort: 19080,
      })
      try {
        await local.start()
        const plan = createExecutionPlanTestFixture()
        await local.executionPlans.put(plan)
        const issuedAt = new Date().toISOString()
        const response = await local.executionAcceptanceService.accept(
          {
            ...ControlApiFixtures.executionAcceptance.request,
            requestId: plan.correlation.requestId,
            workspaceId: plan.correlation.workspaceId,
            projectId: plan.correlation.projectId,
            issuedAt,
            payload: {
              taskId: plan.correlation.taskId,
              agentId: plan.correlation.agentId,
              executionPlan: {
                executionPlanId: plan.executionPlanId,
                contentDigest: plan.contentDigest,
                schemaVersion: plan.schemaVersion,
              },
              deadlineAt: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
              retentionExpiresAt: new Date(Date.parse(issuedAt) + 30 * 86_400_000).toISOString(),
            },
          },
          'svc_m11-standalone'
        )
        expect(response.data.status).toBe('processing')
        if (mode === 'cancel') {
          const deadline = Date.now() + 5000
          while (!client.progressEntered && Date.now() < deadline) await delay(20)
          expect(client.progressEntered).toBe(true)
          const cancellation = await fetch(
            `http://127.0.0.1:8080/execution-lifecycle/${response.data.executionId}/cancelExecution`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
              signal: AbortSignal.timeout(5000),
            }
          )
          expect(cancellation.ok).toBe(true)
          const attached = await fetch(
            `http://127.0.0.1:8080/restate/workflow/execution-lifecycle/${response.data.executionId}/attach`,
            { signal: AbortSignal.timeout(5000) }
          )
          expect(attached.ok).toBe(true)
          expect((await attached.json()).status).toBe('cancelled')
          expect(client.cancelCalls).toBe(1)
        }
        const execution = await waitForTerminalExecution(local, response.data.executionId)
        const attached = await fetch(
          `http://127.0.0.1:8080/restate/workflow/execution-lifecycle/${response.data.executionId}/attach`,
          { signal: AbortSignal.timeout(5000) }
        )
        expect(attached.ok).toBe(true)
        expect((await attached.json()).status).toBe(mode === 'cancel' ? 'cancelled' : 'completed')
        expect(execution).toMatchObject(
          mode === 'cancel'
            ? { state: 'cancelled' }
            : {
                state: 'completed',
                terminalResultRef: `art_${response.data.executionId.slice(4)}`,
              }
        )
      } finally {
        if (client instanceof PendingManagedPiClient) client.release.resolve()
        await local.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
    60_000
  )

  test('SDK response settles a real Restate interaction and replays a lost HTTP ACK without another runtime input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-m11-http-interaction-'))
    const runtime = new InputManagedPiClient()
    const local = new LocalControlPlaneComposition({
      dataDirectory: directory,
      runtimeTransport: createManagedPiAdapterWithClient(runtime),
      workflowEndpointPort: 19080,
    })
    let application
    try {
      await local.start()
      const authentication = await createPrivateApiAuthentication(directory)
      const credential = (await readFile(authentication.credentialFile, 'utf8')).trim()
      const metadata = {
        serviceName: 'control-api',
        version: 'test',
        commitSha: 'test',
        environment: 'test',
        instanceId: 'http-interaction',
      }
      application = await createControlApiApplication({
        metadata,
        logger: { write: () => undefined },
        health: () => ({ status: 'ok', metadata }),
        readiness: () => ({ status: 'ready', metadata }),
        serviceAuthenticator: authentication.authenticator,
        executionAcceptanceService: local.executionAcceptanceService,
        interactionCommandService: local.interactionCommandService,
      })
      await application.listen(0, '127.0.0.1')
      const address = application.getHttpServer().address()
      let loseAcknowledgement = true
      const sdk = new ControlPlaneClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credential,
        fetch: async (url, init) => {
          const response = await fetch(url, init)
          if (
            new URL(url).pathname === '/v1/interactions/respond' &&
            response.ok &&
            loseAcknowledgement
          ) {
            loseAcknowledgement = false
            await response.arrayBuffer()
            throw new Error('M11_LOST_HTTP_ACK')
          }
          return response
        },
      })
      const plan = createExecutionPlanTestFixture()
      await local.executionPlans.put(plan)
      const issuedAt = new Date().toISOString()
      const accepted = await sdk.acceptExecution({
        ...ControlApiFixtures.executionAcceptance.request,
        requestId: plan.correlation.requestId,
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        issuedAt,
        payload: {
          taskId: plan.correlation.taskId,
          agentId: plan.correlation.agentId,
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            schemaVersion: plan.schemaVersion,
          },
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          retentionExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        },
      })
      const deadline = Date.now() + 10_000
      let execution
      do {
        execution = await local.executions.getExecution(accepted.data.executionId)
        if (execution.state === 'awaiting_input') break
        await delay(20)
      } while (Date.now() < deadline)
      expect(execution.state).toBe('awaiting_input')
      const pending = await local.interactions.get(runtime.interactionId)
      expect(pending).toMatchObject({ state: 'pending', allowedPrincipalIds: ['svc_agent-hq'] })
      const responseCommand = {
        ...ControlApiFixtures.interactionResponse.request,
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        issuedAt,
        payload: {
          executionId: accepted.data.executionId,
          attemptId: execution.latestAttemptId,
          interactionId: runtime.interactionId,
          expectedVersion: pending.version,
          action: 'input',
          value: 'continue safely',
        },
      }
      await expect(sdk.respondToInteraction(responseCommand)).rejects.toThrow('M11_LOST_HTTP_ACK')
      expect((await waitForTerminalExecution(local, accepted.data.executionId)).state).toBe(
        'completed'
      )
      const attached = await fetch(
        `http://127.0.0.1:8080/restate/workflow/execution-lifecycle/${accepted.data.executionId}/attach`,
        { signal: AbortSignal.timeout(5000) }
      )
      expect(attached.ok).toBe(true)
      expect((await attached.json()).status).toBe('completed')
      const replay = await sdk.respondToInteraction({
        ...responseCommand,
        commandId: `${responseCommand.commandId.slice(0, -1)}H`,
      })
      expect(replay.data).toMatchObject({
        status: 'accepted',
        replayed: true,
        responseId: responseCommand.commandId,
      })
      expect(runtime.inputs).toHaveLength(1)
      expect(runtime.inputs[0].text).toBe('continue safely')
      await expect(
        sdk.respondToInteraction({
          ...responseCommand,
          payload: { ...responseCommand.payload, value: 'changed' },
        })
      ).rejects.toMatchObject({ status: 409, code: 'INTERACTION_COMMAND_PAYLOAD_CONFLICT' })
      expect(runtime.inputs).toHaveLength(1)
      expect(await local.executions.listAttempts(accepted.data.executionId)).toHaveLength(1)
    } finally {
      await application?.close()
      await local.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)

  test.each(['complete', 'cancel'])(
    'runs the packaged managed Pi RPC client through Local Restate (%s)',
    async (mode) => {
      const realExecutable = process.env.M11_REAL_PI_EXECUTABLE
      const realAgentDirectory = process.env.M11_REAL_PI_AGENT_DIRECTORY
      if (Boolean(realExecutable) !== Boolean(realAgentDirectory))
        throw new Error('M11_REAL_PI_CONFIGURATION_INCOMPLETE')
      const directory = await mkdtemp(join(tmpdir(), 'control-plane-m11-pi-rpc-'))
      const executablePath = realExecutable ?? join(directory, 'pi-fixture.mjs')
      const promptRecord = join(directory, 'prompt-record.json')
      if (!realExecutable) await writeManagedPiRpcFixture(executablePath)
      const local = new LocalControlPlaneComposition({
        dataDirectory: directory,
        runtimeFactory: (repositories) => {
          const runtime = createLocalManagedPiRuntime(repositories, {
            executablePath,
            provider: realExecutable ? 'fixture' : 'fixture-provider',
            model: realExecutable ? 'fixture' : 'fixture-model',
            modelAlias: 'reasoning.standard',
            modelCapabilities: ['tool_calling', 'structured_output'],
            providerClass: 'managed',
            dataResidency: 'us',
            environment: {
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              ...(realAgentDirectory ? { PI_CODING_AGENT_DIR: realAgentDirectory } : {}),
              ...(!realExecutable && mode === 'cancel'
                ? { MOCK_MODE: 'hold', MOCK_RECORD_PATH: promptRecord }
                : {}),
            },
          })
          if (realExecutable && mode === 'cancel') {
            const cleanup = runtime.cleanup.bind(runtime)
            runtime.cleanup = async (handle) => {
              try {
                const response = await fetch(process.env.M11_REAL_PI_CANCELLATION_READY_URL, {
                  signal: AbortSignal.timeout(1000),
                })
                expect((await response.json()).closed).toBe(true)
              } finally {
                await cleanup(handle)
              }
            }
          }
          return runtime
        },
        workflowEndpointPort: 19083,
      })
      const plan = createExecutionPlanTestFixture({
        profileCapabilityRequirements: ['stream.output'],
        skillRequiredCapabilities: [],
      })
      let application
      try {
        await local.start()
        const authentication = await createPrivateApiAuthentication(directory)
        const credential = (await readFile(authentication.credentialFile, 'utf8')).trim()
        const metadata = {
          serviceName: 'control-api',
          version: 'test',
          commitSha: 'test',
          environment: 'test',
          instanceId: 'native-pi-cancel',
        }
        application = await createControlApiApplication({
          metadata,
          logger: { write: () => undefined },
          health: () => ({ status: 'ok', metadata }),
          readiness: () => ({ status: 'ready', metadata }),
          serviceAuthenticator: authentication.authenticator,
          executionAcceptanceService: local.executionAcceptanceService,
          executionCancellationService: local.executionCancellationService,
        })
        await application.listen(0, '127.0.0.1')
        const address = application.getHttpServer().address()
        let loseCancellationAck = true
        const sdk = new ControlPlaneClient({
          baseUrl: `http://127.0.0.1:${address.port}`,
          credential,
          fetch: async (url, init) => {
            const response = await fetch(url, init)
            if (
              new URL(url).pathname === '/v1/executions/cancel' &&
              response.ok &&
              loseCancellationAck
            ) {
              loseCancellationAck = false
              await response.arrayBuffer()
              throw new Error('M11_LOST_CANCELLATION_ACK')
            }
            return response
          },
        })
        await local.catalog.insertAgentProfileVersion(managedPiProfileVersion())
        await local.catalog.insertSkillVersion(managedPiSkillVersion())
        await local.contextPackages.put(contextPackageSerializationFixtures.futurePi)
        await local.executionPlans.put(plan)
        const issuedAt = new Date().toISOString()
        const response = await sdk.acceptExecution({
          ...ControlApiFixtures.executionAcceptance.request,
          requestId: plan.correlation.requestId,
          workspaceId: plan.correlation.workspaceId,
          projectId: plan.correlation.projectId,
          issuedAt,
          payload: {
            taskId: plan.correlation.taskId,
            agentId: plan.correlation.agentId,
            executionPlan: {
              executionPlanId: plan.executionPlanId,
              contentDigest: plan.contentDigest,
              schemaVersion: plan.schemaVersion,
            },
            deadlineAt: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
            retentionExpiresAt: new Date(Date.parse(issuedAt) + 30 * 86_400_000).toISOString(),
          },
        })
        if (mode === 'cancel') {
          await waitForNativePiPrompt(realExecutable, promptRecord)
          const requestCommand = {
            ...ControlApiFixtures.executionAcceptance.request,
            commandId: 'cmd_01JABCDEF0123456789ABCDEFH',
            operation: 'execution.cancel',
            issuedAt: new Date().toISOString(),
            payload: { executionId: response.data.executionId },
          }
          await expect(sdk.cancelExecution(requestCommand)).rejects.toThrow(
            'M11_LOST_CANCELLATION_ACK'
          )
          const replay = await sdk.cancelExecution({
            ...requestCommand,
            commandId: 'cmd_01JABCDEF0123456789ABCDEFJ',
          })
          expect(replay.data).toMatchObject({
            commandId: requestCommand.commandId,
            replayed: true,
            status: 'accepted',
          })
        }
        const execution = await waitForTerminalExecution(local, response.data.executionId)
        {
          const attached = await fetch(
            `http://127.0.0.1:8080/restate/workflow/execution-lifecycle/${response.data.executionId}/attach`,
            { signal: AbortSignal.timeout(5000) }
          )
          expect(attached.ok).toBe(true)
          expect((await attached.json()).status).toBe(mode === 'cancel' ? 'cancelled' : 'completed')
        }
        expect(await local.executions.listAttempts(execution.executionId)).toHaveLength(1)
        if (mode === 'cancel') {
          expect(execution.state).toBe('cancelled')
          expect(execution.terminalResultRef).toBeUndefined()
          return
        }
        expect(execution).toMatchObject({
          state: 'completed',
          terminalResultRef: `art_${response.data.executionId.slice(4)}`,
        })
        const result = await local.objectStore.get(
          `executions/${execution.executionId}/attempts/${execution.latestAttemptId}/result.json`
        )
        expect(JSON.parse(new TextDecoder().decode(result.body))).toMatchObject({
          outcome: 'completed',
          output: { text: realExecutable ? 'verified real Pi' : 'fixture result' },
          usage: { inputTokens: 11, outputTokens: 3 },
        })
      } finally {
        await application?.close()
        await local.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
    60_000
  )

  test('persists signed live RuntimeNode inventory through the gateway after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-m11-discovery-'))
    const local = composition(directory)
    const runtimeNodeRefId = 'rnr_01JABCDEF0123456789ABCDEFG'
    const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
    const issuer = 'https://identity.control-plane.test'
    const audience = 'control-plane-runtime-gateway'
    const authority = new SyntheticRuntimeNodeIdentityAuthority({
      issuer,
      audience,
      now: () => new Date(observedAt),
    })
    const device = authority.registerNode({ nodeId: runtimeNodeRefId, workspaceId })
    const issued = authority.issueCredential(device, { channelGeneration: 1 })
    const challenge = 'm11-live-inventory-challenge'
    const authenticator = new RuntimeNodeChannelAuthenticator({
      identityValidator: authority.validationPort(),
      logger: { write: () => undefined },
      now: () => new Date(observedAt),
    })
    const channel = await authenticator.authenticate(
      device.authenticationAttempt(issued.credential, challenge),
      {
        issuer,
        audience,
        nodeId: runtimeNodeRefId,
        workspaceId,
        channelGeneration: 1,
        challenge,
      }
    )
    const registry = new RuntimeConnectionRegistry(new InMemoryRuntimeConnectionRepository())
    const changes = new RecordingRuntimeAvailabilityChangePublisher()
    const metrics = new RecordingGatewayMetrics()
    const inventory = new RuntimeInventoryIngestionService({
      registry,
      changes,
      checkpoints: local.runtimeInventoryCheckpoints,
      projections: local.runtimeDiscoveryRepository,
      normalizer: new DefaultRuntimeInventoryNormalizer(),
      metrics,
      health: new RuntimeHealthIngestionService({
        registry,
        changes,
        policy: {
          adapterMajor: 1,
          driverMajor: 1,
          harnessMajor: 1,
          protocolMajor: 1,
          healthTtlMs: 60_000,
          maximumCapabilityTtlMs: 60_000,
        },
      }),
    })
    const socket = new RecordingGatewaySocket()
    const lifecycle = new RuntimeGatewayWebSocketLifecycle({
      instanceId: 'm11-live-gateway',
      coordination: new InMemoryRuntimeNodeCoordination(),
      reachability: new RecordingRuntimeNodeReachabilityPublisher(),
      metrics,
      messages: new RuntimeInventoryMessageHandler({ inventory }),
      limits: {
        maxConnections: 8,
        maxConnectionsPerWorkspace: 4,
        maxFrameBytes: 64 * 1024,
        maxBufferedBytes: 64 * 1024,
        heartbeatTimeoutMs: 15_000,
        idleTimeoutMs: 30_000,
      },
      now: () => new Date(observedAt),
    })

    try {
      await local.start()
      expect(
        lifecycle.open({
          connectionId: 'm11-live-connection',
          authenticatedChannel: channel,
          socket,
        })
      ).toBeTrue()
      await lifecycle.receive(
        'm11-live-connection',
        JSON.stringify(runtimeNodeHello(runtimeNodeRefId, workspaceId))
      )
      await lifecycle.receive(
        'm11-live-connection',
        JSON.stringify(runtimeNodeInventory(runtimeNodeRefId, workspaceId))
      )
      expect(socket.sent).toHaveLength(1)
      expect(
        await local.runtimeDiscoveryRepository.listRuntimeConnections({ workspaceId })
      ).toEqual([
        expect.objectContaining({
          family: 'managed-pi',
          node: expect.objectContaining({ runtimeNodeRefId, health: 'online' }),
          connection: expect.objectContaining({ availability: 'healthy' }),
        }),
      ])
    } finally {
      await lifecycle.close()
      authenticator.close()
      await local.close()
    }

    const restarted = composition(directory)
    try {
      await restarted.start()
      expect(
        await restarted.runtimeDiscoveryRepository.listRuntimeConnections({ workspaceId })
      ).toHaveLength(1)
    } finally {
      await restarted.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function waitForNativePiPrompt(realExecutable, promptRecord) {
  const deadline = Date.now() + 15000
  if (realExecutable && !process.env.M11_REAL_PI_CANCELLATION_READY_URL)
    throw new Error('M11_REAL_PI_CANCELLATION_READY_URL_REQUIRED')
  while (Date.now() < deadline) {
    if (realExecutable) {
      const response = await fetch(process.env.M11_REAL_PI_CANCELLATION_READY_URL, {
        signal: AbortSignal.timeout(1000),
      })
      if ((await response.json()).ready === true) return
    } else {
      try {
        await readFile(promptRecord)
        return
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    await delay(25)
  }
  throw new Error('M11_NATIVE_PI_PROMPT_NOT_STARTED')
}

async function waitForTerminalExecution(runtimeComposition, executionId) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const execution = await runtimeComposition.executions.getExecution(executionId)
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(execution.state)) {
      return execution
    }
    await delay(100)
  }
  throw new Error('M11_LOCAL_RESTATE_EXECUTION_TIMEOUT')
}

function createAcpExecutionPlan() {
  return createExecutionPlanTestFixture({
    profileCapabilityRequirements: ['stream.output', 'execution.cancel'],
    skillRequiredCapabilities: [],
  })
}

function composition(dataDirectory, runtimeTransport) {
  return new LocalControlPlaneComposition({
    dataDirectory,
    runtimeTransport,
    workflowRuntime: {
      profile: 'local',
      start: async () => undefined,
      health: async () => ({ ready: true, component: 'restate', version: '1.7.9' }),
      stop: async () => undefined,
    },
    endpointFactory: {
      create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
    },
  })
}

function command(plan) {
  return {
    callerPrincipalId: 'svc_m11-standalone',
    operation: 'execution.accept',
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    requestId: plan.correlation.requestId,
    idempotencyKey: 'm11-standalone-execution',
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
    receivedAt: observedAt,
    retentionExpiresAt: '2026-09-30T12:00:00.000Z',
  }
}

function status(executionId, state, attemptId) {
  return {
    executionId,
    ...(attemptId === undefined ? {} : { attemptId }),
    state,
    effectKey: `${workflowId}:${state}`,
  }
}

function createDirectManagedPiAdapter() {
  return createManagedPiAdapterWithClient(new CompletedManagedPiClient())
}

function createManagedPiAdapterWithClient(client) {
  return new ManagedPiAdapter({
    transport: new DirectLocalRuntimeTransport(
      new ManagedPiDriver({ client, adapterVersion: '1.0.0' })
    ),
  })
}

function createDirectAcpAdapter(publishDiscovery) {
  const externalSessions = new Map()
  const nativeSessions = new Map()
  return new AcpAdapter({
    transport: new DirectLocalRuntimeTransport(
      new AcpDriver({
        transport: new FilesystemCapableAcpTransport({ now: () => observedAt }),
        adapterVersion: '1.0.0',
        externalSessionId: (nativeSessionId) => {
          if (!externalSessions.has(nativeSessionId)) {
            externalSessions.set(nativeSessionId, 'ses_01JABCDEF0123456789ABCDEFG')
          }
          return externalSessions.get(nativeSessionId)
        },
        interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
        now: () => new Date(observedAt),
        externalSessions: {
          registry: new ExternalSessionRegistry(new InMemoryExternalSessionRepository()),
          runtimeConnection: acpConnection,
          nodeStatus: () => 'online',
          workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          opaqueNativeSessionId: (nativeSessionId) => {
            if (!nativeSessions.has(nativeSessionId)) {
              nativeSessions.set(nativeSessionId, 'nses_01JABCDEF0123456789ABCDEFG')
            }
            return nativeSessions.get(nativeSessionId)
          },
          resolveNativeSessionId: async (opaqueNativeSessionId) =>
            [...nativeSessions.entries()].find(
              ([, opaque]) => opaque === opaqueNativeSessionId
            )?.[0],
          capabilityTtlMs: 300_000,
          authorize: async () => true,
          publishDiscovery,
        },
      })
    ),
  })
}

function acpConnection() {
  return {
    runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
    identityDigest: `sha256:${'9'.repeat(64)}`,
    connectionType: 'external_local',
    runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
    runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
    location: 'local_device',
    opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFG',
    adapterVersion: '1.0.0',
    driverVersion: '1.0.0',
    harnessVersion: '2.4.0',
    protocolVersion: '2.0.0',
    status: 'connected',
    health: 'healthy',
    availabilityState: 'healthy',
    capabilities: [
      'session.create',
      'session.list',
      'session.resume',
      'session.close',
      'session.history',
      'session.load',
      'stream.output',
      'execution.cancel',
      'filesystem.read',
    ].map((name) => ({ name, support: 'supported' })),
    capabilitySnapshotVersion: 1,
    capabilitySnapshotObservedAt: observedAt,
    capabilitySnapshotExpiresAt: '2026-08-30T12:05:00.000Z',
    capabilityVerification: 'verified',
    compatibilityState: 'compatible',
    limitations: [],
    diagnostics: [],
    lastDiscoveredAt: observedAt,
    lastHeartbeatAt: observedAt,
    lastHealthCheckAt: observedAt,
    version: 1,
    createdAt: observedAt,
    updatedAt: observedAt,
  }
}

class CompletedManagedPiClient {
  executions = new Map()

  async inspect() {
    return {
      driverVersion: '1.0.0',
      runtimeVersion: '0.52.1',
      protocolVersion: '1.0.0',
      health: 'healthy',
      capabilities: [
        { name: 'stream.output', support: 'supported' },
        { name: 'execution.cancel', support: 'supported' },
        { name: 'interaction.user-input', support: 'supported' },
        { name: 'interaction.approval', support: 'supported' },
        { name: 'filesystem.read', support: 'supported' },
      ],
      limitations: [],
      observedAt,
    }
  }

  async start(startCommand) {
    const handle = {
      handleId: `managed-pi:${startCommand.attemptId}`,
      attemptId: startCommand.attemptId,
      startedAt: observedAt,
    }
    this.executions.set(handle.handleId, handle)
    return handle
  }

  async *progress() {
    yield { sequence: 1, occurredAt: observedAt, kind: 'status', state: 'running' }
    yield { sequence: 2, occurredAt: observedAt, kind: 'output', text: 'completed' }
    yield {
      sequence: 3,
      occurredAt: observedAt,
      kind: 'usage',
      inputTokens: 3,
      outputTokens: 2,
      durationMs: 10,
    }
    yield { sequence: 4, occurredAt: observedAt, kind: 'status', state: 'succeeded' }
  }

  async status(handle) {
    this.#require(handle)
    return {
      state: 'succeeded',
      observedAt,
      result: {
        output: { ok: true },
        usage: { inputTokens: 3, outputTokens: 2, durationMs: 10 },
        artifacts: [],
      },
    }
  }

  submitInput(handle) {
    return this.status(handle)
  }

  submitApproval(handle) {
    return this.status(handle)
  }

  async cancel(handle, request) {
    this.#require(handle)
    return { state: 'cancelled', observedAt: request.requestedAt }
  }

  reconcile(handle) {
    return this.status(handle)
  }

  async session() {
    throw new Error('CAPABILITY_UNSUPPORTED')
  }

  async cleanup(handle) {
    this.#require(handle)
  }

  #require(handle) {
    if (!this.executions.has(handle.handleId)) throw new Error('MANAGED_PI_EXECUTION_MISSING')
  }
}

function managedPiProfileVersion() {
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
      capabilityRequirements: ['stream.output'],
      executionConstraints: createExecutionPlanTestFixture().constraints,
      outputContractRefs: ['contract://execution-result/v1'],
    },
    createdAt: '2026-08-22T12:00:00.000Z',
    lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
  }
}

function managedPiSkillVersion() {
  return {
    skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
    skillId: 'skl_01JABCDEF0123456789ABCDEFG',
    revision: 4,
    lifecycle: 'published',
    manifest: {
      schemaVersion: 1,
      semanticVersion: '2.1.0',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      requiredCapabilities: [],
      requiredTools: [{ toolId: 'project-files', versionRange: '^1.0.0' }],
      dependencies: [],
      conflicts: [],
      supersedes: [],
      compatibleProfileSchemaVersions: [1],
      compatibleContractMajorVersions: [1],
    },
    content: { instructions: 'Return the bounded result.', artifactRefs: [] },
    createdAt: '2026-08-22T12:00:00.000Z',
    lifecycleMetadata: { publishedAt: '2026-08-22T12:00:00.000Z' },
  }
}

class PendingManagedPiClient extends CompletedManagedPiClient {
  release = Promise.withResolvers()
  progressEntered = false
  cancelCalls = 0

  async *progress() {
    this.progressEntered = true
    await this.release.promise
    yield { sequence: 1, occurredAt: observedAt, kind: 'status', state: 'cancelled' }
  }

  async cancel(handle, request) {
    this.cancelCalls++
    this.release.resolve()
    return super.cancel(handle, request)
  }

  async status() {
    return { state: this.cancelCalls ? 'cancelled' : 'running', observedAt }
  }
}

class InputManagedPiClient extends CompletedManagedPiClient {
  interactionId = 'int_01JABCDEF0123456789ABCDEFG'
  inputs = []
  async *progress() {
    yield {
      sequence: 1,
      occurredAt: observedAt,
      kind: 'interaction',
      interactionId: this.interactionId,
      interactionKind: 'input',
      prompt: 'Provide fixture input',
    }
  }
  async status(handle) {
    return this.inputs.length ? super.status(handle) : { state: 'waiting_input', observedAt }
  }
  async submitInput(handle, input) {
    this.inputs.push(input)
    return super.status(handle)
  }
}

class FilesystemCapableAcpTransport extends ReferenceAcpTransport {
  async request(method, params) {
    const result = await super.request(method, params)
    if (method !== 'initialize') return result
    return {
      ...result,
      capabilities: {
        ...result.capabilities,
        _meta: {
          controlPlane: {
            capabilities: [
              'stream.output',
              'execution.cancel',
              'interaction.user-input',
              'interaction.approval',
              'filesystem.read',
              'session.create',
              'session.list',
              'session.resume',
              'session.close',
              'session.history',
              'session.load',
            ],
            driverVersion: '1.0.0',
          },
        },
      },
    }
  }
}

class RecordingGatewaySocket {
  sent = []

  bufferedAmount() {
    return 0
  }

  send(value) {
    this.sent.push(JSON.parse(value))
  }

  close() {}
}

function runtimeNodeHello(nodeId, workspaceId) {
  return {
    type: 'hello',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 2 },
    sequence: 0,
    nodeId,
    workspaceId,
    traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    sentAt: observedAt,
    channelGeneration: 1,
    supportedVersions: [{ major: 1, minor: 2 }],
    lastAcknowledgedSequence: 0,
  }
}

function runtimeNodeInventory(nodeId, workspaceId) {
  return {
    type: 'inventory',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 2 },
    sequence: 1,
    nodeId,
    workspaceId,
    traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    sentAt: observedAt,
    channelGeneration: 1,
    mode: 'snapshot',
    snapshotVersion: 1,
    observedAt,
    runtimeDrivers: [
      {
        opaqueRef: 'nref_01JABCDEF0123456789ABCDEFG',
        driverFamily: 'managed-pi',
        adapterVersion: '1.0.0',
        driverVersion: '1.0.0',
        harnessVersion: '1.0.0',
        protocolVersion: { major: 1, minor: 2 },
        health: 'healthy',
        capabilities: ['stream.output', 'execution.cancel'],
        limitations: [],
      },
    ],
    contextProviders: [],
    removedRuntimeRefs: [],
  }
}
