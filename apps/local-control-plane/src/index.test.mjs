import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { DirectLocalRuntimeTransport, TransportedRuntimeAdapter } from '@control-plane/runtime-sdk'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import {
  DirectRuntimeActivityPort,
  LocalApiServer,
  LocalControlPlaneComposition,
  createLocalApiAuthentication,
  resolveEmbeddedDeploymentProfile,
  resolveLocalApiHost,
  resolveLocalRuntimeOptions,
} from './index.ts'

describe('Local Control Plane composition', () => {
  test('packages managed Pi only from explicit non-secret launcher configuration', () => {
    expect(resolveLocalRuntimeOptions({})).toEqual({})
    expect(() => resolveLocalRuntimeOptions({ CONTROL_PLANE_LOCAL_RUNTIME: 'managed-pi' })).toThrow(
      'LOCAL_MANAGED_PI_MODEL_CONFIGURATION_REQUIRED'
    )
    expect(() =>
      resolveLocalRuntimeOptions({ CONTROL_PLANE_LOCAL_RUNTIME: 'remote-gateway' })
    ).toThrow('LOCAL_RUNTIME_FAMILY_INVALID')

    const resolved = resolveLocalRuntimeOptions({
      CONTROL_PLANE_LOCAL_RUNTIME: 'managed-pi',
      CONTROL_PLANE_MANAGED_PI_EXECUTABLE: '/opt/pi/bin/pi',
      CONTROL_PLANE_MANAGED_PI_PROVIDER: 'openai-codex',
      CONTROL_PLANE_MANAGED_PI_MODEL: 'gpt-5.4',
      CONTROL_PLANE_MANAGED_PI_MODEL_ALIAS: 'reasoning.standard',
      CONTROL_PLANE_MANAGED_PI_MODEL_CAPABILITIES: 'tool_calling,structured_output',
      CONTROL_PLANE_MANAGED_PI_PROVIDER_CLASS: 'managed',
      CONTROL_PLANE_MANAGED_PI_DATA_RESIDENCY: 'us',
      PATH: '/opt/pi/bin:/usr/bin',
      HOME: '/Users/runtime',
      CONTROL_PLANE_DATABASE_URL: 'must-not-reach-pi',
    })
    expect(resolved.runtimeFactory).toBeFunction()
  })

  test('binds loopback by default and permits only explicit socket bind addresses', () => {
    expect(resolveLocalApiHost()).toBe('127.0.0.1')
    expect(resolveLocalApiHost('0.0.0.0')).toBe('0.0.0.0')
    expect(() => resolveLocalApiHost('public.example.com')).toThrow(
      'LOCAL_CONTROL_PLANE_BIND_HOST_INVALID'
    )
  })

  test('reports hosted-simple only when explicitly selected', () => {
    expect(resolveEmbeddedDeploymentProfile()).toBe('local')
    expect(resolveEmbeddedDeploymentProfile('hosted-simple')).toBe('hosted-simple')
    expect(() => resolveEmbeddedDeploymentProfile('hosted-server')).toThrow(
      'EMBEDDED_DEPLOYMENT_PROFILE_INVALID'
    )
  })

  test('starts one zero-external-service topology with durable local adapters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-local-'))
    const calls = []
    const workflow = {
      profile: 'local',
      start: async () => calls.push('workflow:start'),
      health: async () => ({ ready: true, component: 'restate', version: '1.7.8' }),
      stop: async () => calls.push('workflow:stop'),
    }
    const composition = new LocalControlPlaneComposition({
      dataDirectory: directory,
      workflowRuntime: workflow,
      runtimeTransport: { transportKind: 'direct-local' },
      endpointFactory: {
        create: async () => ({
          run: async () => calls.push('endpoint:start'),
          shutdown: async () => calls.push('endpoint:stop'),
        }),
      },
    })
    try {
      await composition.start()
      const manifest = await composition.manifest()
      expect(calls).toEqual(['endpoint:start', 'workflow:start'])
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        profile: 'local',
        topology: {
          externalServices: 0,
          runtimeTransport: 'direct-local',
          persistence: 'sqlite',
          objectStore: 'filesystem',
          remoteControl: 'disabled',
        },
      })
      expect(manifest.components.every(({ ready }) => ready)).toBe(true)
      expect((await composition.discovery.resolve('restate')).private).toBe(true)
      expect(composition.executionEvents).toBeDefined()
      expect(composition.statePromotionProposals).toBeDefined()
      expect(composition.reconciliationCheckpoints).toBeDefined()
      expect(composition.runtimeCommands).toBeDefined()
      expect(composition.runtimeInventoryCheckpoints).toBeDefined()
      expect(composition.runtimeEventEffects).toBeDefined()
    } finally {
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
    expect(calls).toEqual(['endpoint:start', 'workflow:start', 'workflow:stop', 'endpoint:stop'])
  })

  test('exposes loopback-only component health through the versioned API boundary', async () => {
    const manifest = {
      schemaVersion: 1,
      profile: 'local',
      version: '1.0.0',
      dataDirectory: '/tmp/control-plane',
      components: [{ ready: true, component: 'sqlite-persistence', version: '1' }],
      topology: {
        externalServices: 0,
        runtimeTransport: 'direct-local',
        restateVersion: '1.7.8',
        persistence: 'sqlite',
        objectStore: 'filesystem',
        remoteControl: 'disabled',
      },
    }
    const server = new LocalApiServer({
      port: 0,
      manifest: async () => manifest,
      health: () => ({ status: 'ok', metadata: { serviceName: 'local-control-plane' } }),
      readiness: () => ({ status: 'ready', metadata: { serviceName: 'local-control-plane' } }),
    })
    try {
      await server.start()
      const response = await globalThis.fetch(`${server.address}/v1/components`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ schemaVersion: 1, ready: true })
      const readiness = await globalThis.fetch(`${server.address}/ready`)
      expect(await readiness.json()).toEqual({
        status: 'ready',
        metadata: { serviceName: 'local-control-plane' },
      })
      manifest.components[0].ready = false
      const unavailable = await globalThis.fetch(`${server.address}/v1/components`)
      expect(unavailable.status).toBe(503)
      expect(await unavailable.json()).toEqual({ schemaVersion: 1, ready: false })
    } finally {
      await server.close()
    }
  })

  test('constructs and starts optional outbound remote control against durable acceptance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-local-relay-'))
    const calls = []
    const composition = new LocalControlPlaneComposition({
      dataDirectory: directory,
      workflowRuntime: {
        profile: 'local',
        start: async () => calls.push('workflow:start'),
        health: async () => ({ ready: true, component: 'restate', version: '1.7.8' }),
        stop: async () => calls.push('workflow:stop'),
      },
      endpointFactory: {
        create: async () => ({
          run: async () => calls.push('endpoint:start'),
          shutdown: async () => calls.push('endpoint:stop'),
        }),
      },
      remoteControlFactory: (acceptance) => {
        expect(typeof acceptance.accept).toBe('function')
        return {
          start: async () => calls.push('relay:start'),
          stop: () => calls.push('relay:stop'),
          health: async () => ({
            ready: true,
            component: 'remote-control-relay',
            version: '1',
            details: { direction: 'outbound', listener: false },
          }),
        }
      },
    })
    try {
      await composition.start()
      expect(await composition.manifest()).toMatchObject({
        topology: { remoteControl: 'outbound' },
      })
      expect(calls).toEqual(['endpoint:start', 'workflow:start', 'relay:start'])
    } finally {
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
    expect(calls).toEqual([
      'endpoint:start',
      'workflow:start',
      'relay:start',
      'relay:stop',
      'workflow:stop',
      'endpoint:stop',
    ])
  })

  test('fails execution acceptance closed when no direct runtime is configured', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-local-no-runtime-'))
    const composition = new LocalControlPlaneComposition({
      dataDirectory: directory,
      workflowRuntime: {
        profile: 'local',
        start: async () => undefined,
        health: async () => ({ ready: true, component: 'restate', version: '1.7.8' }),
        stop: async () => undefined,
      },
      endpointFactory: {
        create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
      },
    })
    try {
      await composition.start()
      await expect(
        composition.executionAcceptanceService.accept({}, 'svc_agent-hq')
      ).rejects.toMatchObject({
        response: { code: 'EXECUTION_ACCEPTANCE_NOT_CONFIGURED' },
      })
    } finally {
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('executes and replays a completed runtime effect through direct transport only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-direct-runtime-'))
    const persistence = new SqlitePersistenceProvider({
      path: join(directory, 'control-plane.sqlite'),
    })
    const objectStore = new FilesystemObjectStore({
      rootDirectory: join(directory, 'artifacts'),
      maxObjectBytes: 1024 * 1024,
    })
    const handle = {
      handleId: 'local:att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      startedAt: '2026-08-29T00:00:00.000Z',
    }
    let starts = 0
    const cancellations = []
    const driver = {
      start: async (request) => {
        starts += 1
        return {
          handleId: `local:${request.attemptId}`,
          attemptId: request.attemptId,
          startedAt: handle.startedAt,
        }
      },
      progress: async function* () {},
      status: async (runtimeHandle) => ({
        handle: runtimeHandle,
        state: 'completed',
        observedAt: '2026-08-29T00:00:01.000Z',
        result: {
          outcome: 'completed',
          output: { ok: true },
          usage: { inputTokens: 1, outputTokens: 1, durationMs: 10 },
          artifacts: [],
        },
      }),
      cancel: async (runtimeHandle, request) => {
        cancellations.push(request)
        return {
          handle: runtimeHandle,
          state: 'cancelled',
          observedAt: request.requestedAt,
        }
      },
      cleanup: async () => undefined,
    }
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'test')
    const activities = new DirectRuntimeActivityPort(persistence, objectStore, adapter)
    try {
      await persistence.migrate()
      const input = {
        executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        attemptId: handle.attemptId,
        executionPlan: {
          correlation: {
            workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          },
          executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          contentDigest: `sha256:${'a'.repeat(64)}`,
          schemaVersion: 1,
          runtimeRequirements: [],
        },
        effectKey: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV:execution-lifecycle-v1:dispatch',
      }
      const first = await activities.dispatch(input)
      const replay = await activities.dispatch(input)
      expect(first).toEqual(replay)
      expect(first).toMatchObject({ outcome: 'completed' })
      expect(starts).toBe(1)
      await expect(
        activities.cancel({
          executionId: input.executionId,
          attemptId: 'att_01JABCDEF0123456789ABCDEFG',
          effectKey: `${input.effectKey}:stale-cancel`,
          reason: 'user_request',
        })
      ).rejects.toThrow('RUNTIME_HANDLE_ATTEMPT_MISMATCH')
      expect(cancellations).toHaveLength(0)
      await activities.cancel({
        executionId: input.executionId,
        attemptId: input.attemptId,
        effectKey: `${input.effectKey}:cancel`,
        reason: 'user_request',
      })
      expect(cancellations).toHaveLength(1)
      const preCancelled = {
        ...input,
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        effectKey: 'wfl_01JABCDEF0123456789ABCDEFG:execution-lifecycle-v1:dispatch',
      }
      await activities.cancel({
        executionId: preCancelled.executionId,
        attemptId: preCancelled.attemptId,
        effectKey: `${preCancelled.effectKey}:cancel`,
        reason: 'deadline',
      })
      await expect(activities.dispatch(preCancelled)).resolves.toEqual({ outcome: 'cancelled' })
      expect(cancellations).toHaveLength(2)
      expect(
        (
          await objectStore.get(
            `executions/${input.executionId}/attempts/${input.attemptId}/result.json`
          )
        ).body
      ).toBeTruthy()
    } finally {
      persistence.close()
      objectStore.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('resumes a direct runtime with the durable interaction input value', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-direct-input-'))
    const persistence = new SqlitePersistenceProvider({
      path: join(directory, 'control-plane.sqlite'),
    })
    const objectStore = new FilesystemObjectStore({
      rootDirectory: join(directory, 'artifacts'),
      maxObjectBytes: 1024 * 1024,
    })
    const handle = {
      handleId: 'local:att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      startedAt: '2026-08-29T00:00:00.000Z',
    }
    const submitted = []
    const driver = {
      start: async () => handle,
      progress: async function* () {
        yield {
          handleId: handle.handleId,
          sequence: 1,
          occurredAt: '2026-08-29T00:00:01.000Z',
          type: 'interaction',
          data: { interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAV', kind: 'input' },
        }
      },
      status: async () => ({
        handle,
        state: 'awaiting_input',
        observedAt: '2026-08-29T00:00:01.000Z',
      }),
      submitInput: async (runtimeHandle, request) => {
        submitted.push(request)
        return {
          handle: runtimeHandle,
          state: 'completed',
          observedAt: '2026-08-29T00:00:02.000Z',
          result: {
            outcome: 'completed',
            output: { answer: request.text },
            usage: { inputTokens: 1, outputTokens: 1, durationMs: 10 },
            artifacts: [],
          },
        }
      },
      cleanup: async () => undefined,
    }
    const activities = new DirectRuntimeActivityPort(
      persistence,
      objectStore,
      new TransportedRuntimeAdapter(new DirectLocalRuntimeTransport(driver), 'test')
    )
    const input = {
      executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      attemptId: handle.attemptId,
      executionPlan: {
        correlation: {
          workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        },
        executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        schemaVersion: 1,
        runtimeRequirements: [],
      },
      effectKey: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV:execution-lifecycle-v1:dispatch',
    }
    try {
      await persistence.migrate()
      expect(await activities.dispatch(input)).toEqual({
        outcome: 'awaiting_input',
        interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      })
      expect(
        await activities.applyInteraction({
          interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          responseId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          action: 'input',
          value: 'continue safely',
          executionId: input.executionId,
          attemptId: input.attemptId,
          effectKey: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV:execution-lifecycle-v1:interaction',
        })
      ).toMatchObject({ outcome: 'completed' })
      expect(submitted).toEqual([
        {
          interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          idempotencyKey: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV:execution-lifecycle-v1:interaction',
          text: 'continue safely',
        },
      ])
    } finally {
      persistence.close()
      objectStore.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('persists direct runtime completion through the shared durable lifecycle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-local-lifecycle-'))
    const plan = createExecutionPlanTestFixture()
    const handle = {
      handleId: 'local:att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      startedAt: '2026-08-29T00:00:00.000Z',
    }
    const composition = new LocalControlPlaneComposition({
      dataDirectory: directory,
      workflowRuntime: {
        profile: 'local',
        start: async () => undefined,
        health: async () => ({ ready: true, component: 'restate', version: '1.7.8' }),
        stop: async () => undefined,
      },
      endpointFactory: {
        create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
      },
      runtimeTransport: new TransportedRuntimeAdapter(
        new DirectLocalRuntimeTransport({
          start: async ({ attemptId }) => ({ ...handle, attemptId }),
          progress: async function* () {},
          status: async (runtimeHandle) => ({
            handle: runtimeHandle,
            state: 'completed',
            observedAt: '2026-08-29T00:00:01.000Z',
            result: {
              outcome: 'completed',
              output: { ok: true },
              usage: { inputTokens: 1, outputTokens: 1, durationMs: 10 },
              artifacts: [],
            },
          }),
          cleanup: async () => undefined,
        }),
        'test'
      ),
    })
    try {
      await composition.start()
      await composition.executionPlans.put(plan)
      const accepted = await composition.commands.acceptExecution({
        callerPrincipalId: 'svc_agent-hq',
        operation: 'execution.accept',
        commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        requestId: plan.correlation.requestId,
        idempotencyKey: 'local-durable-lifecycle',
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
        receivedAt: '2026-08-29T00:00:00.000Z',
        retentionExpiresAt: '2026-09-29T00:00:00.000Z',
      })
      const executionId = accepted.execution.executionId
      const attemptId = `att_${executionId.slice(4)}`
      const workflowId = 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV'
      const activities = composition.executionLifecycleActivities

      await activities.persistStatus({
        executionId,
        state: 'queued',
        effectKey: `${workflowId}:queued`,
      })
      await activities.ensureAttempt({
        executionId,
        workflowId,
        effectKey: `${workflowId}:attempt`,
      })
      await activities.persistStatus({
        executionId,
        attemptId,
        state: 'starting',
        effectKey: `${workflowId}:starting`,
      })
      const outcome = await activities.dispatch({
        executionId,
        attemptId,
        executionPlan: {
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
          schemaVersion: plan.schemaVersion,
        },
        effectKey: `${workflowId}:dispatch`,
      })
      await activities.persistStatus({
        executionId,
        attemptId,
        state: 'completed',
        effectKey: `${workflowId}:completed`,
        resultReference: outcome.resultReference,
      })

      expect(await composition.executions.getExecution(executionId)).toMatchObject({
        state: 'completed',
        latestAttemptId: attemptId,
        terminalResultRef: outcome.resultReference,
      })
      expect(await composition.executions.getAttempt(attemptId)).toMatchObject({
        state: 'completed',
        terminalResultRef: outcome.resultReference,
      })
      expect(await composition.commandRepository.getByExecutionId(executionId)).toMatchObject({
        status: 'completed',
        resultReference: outcome.resultReference,
      })
    } finally {
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('keeps the loopback API credential outside SQLite in an owner-only file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-local-auth-'))
    try {
      const authentication = await createLocalApiAuthentication(directory)
      const credential = (await readFile(authentication.credentialFile, 'utf8')).trim()
      expect((await stat(authentication.credentialFile)).mode & 0o077).toBe(0)
      await expect(
        authentication.authenticator.authenticate(
          {
            headers: { authorization: `Bearer ${credential}` },
            body: {
              caller: { servicePrincipalId: 'svc_agent-hq' },
              workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
              projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            },
          },
          ['execution:accept']
        )
      ).resolves.toMatchObject({ principalId: 'svc_agent-hq' })
      await expect(
        authentication.authenticator.authenticate(
          { headers: { authorization: 'Bearer invalid' }, body: {} },
          ['execution:accept']
        )
      ).rejects.toMatchObject({ status: 401 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
