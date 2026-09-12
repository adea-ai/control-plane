import { describe, expect, test } from 'bun:test'
import { loadManagedCloudConfiguration } from '@control-plane/config'
import { CommandInboxService } from '@control-plane/domain'
import { DurableExecutionLifecycleActivities } from './cloud-execution-activities.ts'
import { createManagedCloudWorkflowWorkerComposition, start } from './index.ts'
import { DurableRemoteWorkflowRuntime } from './remote-workflow-runtime.ts'
import { RuntimeDiscoveryAttemptRouter } from './runtime-attempt-router.ts'

class FakeProcessAdapter {
  listeners = new Map()
  on(event, listener) {
    this.listeners.set(event, listener)
  }
  off(event) {
    this.listeners.delete(event)
  }
  setExitCode() {}
}

class RecordingMetricAdapter {
  emissions = []
  add(name, value, attributes) {
    this.emissions.push({ name, value, attributes })
  }
  record(name, value, attributes) {
    this.emissions.push({ name, value, attributes })
  }
}

describe('workflow worker telemetry', () => {
  test('wires explicit remote execution and discovery without a certification runtime', () => {
    const configuration = loadManagedCloudConfiguration(
      { ...managedCloudEnvironment(), CONTROL_PLANE_CLOUD_RUNTIME: 'remote' },
      'workflow-worker'
    )
    const composition = createManagedCloudWorkflowWorkerComposition(
      configuration,
      undefined,
      undefined,
      () => ({ database: {}, check: async () => undefined, close: async () => undefined })
    )
    expect(composition.runtime).toBeInstanceOf(DurableRemoteWorkflowRuntime)
    expect(composition.runtimeRouter).toBeInstanceOf(RuntimeDiscoveryAttemptRouter)
    expect(composition.activities).toBeInstanceOf(DurableExecutionLifecycleActivities)
    expect(() =>
      createManagedCloudWorkflowWorkerComposition(
        { ...configuration, runtime: { mode: 'disabled' } },
        undefined,
        undefined,
        () => {
          throw new Error('MUST_NOT_ALLOCATE')
        }
      )
    ).toThrow('MANAGED_CLOUD_RUNTIME_NOT_CONFIGURED')
  })

  test('starts and closes production remote mode without opening the certification object store', async () => {
    const lifecycle = []
    const runtime = await start({
      environment: {
        ...managedCloudEnvironment(),
        APP_ENV: 'production',
        CONTROL_PLANE_CLOUD_RUNTIME: 'remote',
      },
      logger: { write: () => undefined },
      processAdapter: new FakeProcessAdapter(),
      restateEndpointFactory: {
        create: async () => ({
          run: async () => lifecycle.push('endpoint'),
          shutdown: async () => lifecycle.push('endpoint-closed'),
        }),
      },
      postgresConnectionFactory: () => ({
        database: {},
        check: async () => lifecycle.push('database'),
        close: async () => lifecycle.push('database-closed'),
      }),
      objectStoreFactory: () => {
        throw new Error('REMOTE_MUST_NOT_OPEN_CERTIFICATION_STORE')
      },
    })
    expect(runtime.readiness().status).toBe('ready')
    await runtime.shutdown('test-complete')
    expect(lifecycle).toEqual(['database', 'endpoint', 'endpoint-closed', 'database-closed'])
  })
  test('emits a correlated initialization span through an injectable adapter', async () => {
    const spans = []
    const logs = []
    const endpoint = { run: async () => undefined, shutdown: async () => undefined }
    const runtime = await start({
      restateEndpointFactory: { create: async () => endpoint },
      environment: {
        APP_ENV: 'test',
        COMMIT_SHA: 'abc123',
        INSTANCE_ID: 'worker-1',
        SERVICE_VERSION: '1.0.0',
      },
      logger: { write: (entry) => logs.push(entry) },
      processAdapter: new FakeProcessAdapter(),
      traceAdapter: {
        startSpan(input) {
          spans.push(input)
          return { context: undefined, end: () => undefined }
        },
      },
    })

    expect(runtime.readiness().status).toBe('ready')
    expect(spans).toEqual([
      expect.objectContaining({
        name: 'service.worker.initialize',
        attributes: expect.objectContaining({
          'service.name': 'workflow-worker',
          'control.correlation_id': 'worker-1',
        }),
      }),
    ])
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'service.started',
        metadata: expect.objectContaining({ instanceId: 'worker-1' }),
      })
    )
    await runtime.shutdown('test-complete')
  })

  test('composes durable activities from the managed Cloud Neon boundary', () => {
    const composition = createManagedCloudWorkflowWorkerComposition(
      loadManagedCloudConfiguration(managedCloudEnvironment(), 'workflow-worker'),
      runtimePort(),
      undefined,
      () => ({ database: {}, check: async () => undefined, close: async () => undefined })
    )

    expect(composition.activities).toBeInstanceOf(DurableExecutionLifecycleActivities)
    expect(composition.commands).toBeInstanceOf(CommandInboxService)
  })

  test('passes the consistency emitter from an injected adapter into the composed command inbox', async () => {
    const adapter = new RecordingMetricAdapter()
    const composition = createManagedCloudWorkflowWorkerComposition(
      loadManagedCloudConfiguration(managedCloudEnvironment(), 'workflow-worker'),
      runtimePort(),
      undefined,
      () => ({ database: {}, check: async () => undefined, close: async () => undefined }),
      adapter
    )
    expect(composition.commands).toBeInstanceOf(CommandInboxService)
    // Swap the durable repository for a canned replay so the duplicate outcome is
    // emitted through the injected adapter and nowhere else.
    const record = {
      executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      payloadHash: 'a'.repeat(64),
      retentionExpiresAt: new Date(Date.now() + 600000).toISOString(),
    }
    composition.commands.repository = {
      get: async () => record,
      getByExecutionId: async () => record,
      getExecution: async () => ({ executionId: record.executionId }),
      accept: async () => {
        throw new Error('REPLAY_MUST_NOT_ACCEPT')
      },
      compareAndSet: async () => {
        throw new Error('REPLAY_MUST_NOT_TRANSITION')
      },
    }
    const receivedAt = new Date().toISOString()
    await composition.commands.acceptExecution({
      callerPrincipalId: 'svc_worker',
      operation: 'execution.accept',
      commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      idempotencyKey: 'consistency-metrics-replay-key-1',
      payloadHash: record.payloadHash,
      correlation: {
        workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
      executionPlan: {
        executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        contentDigest: `sha256:${'b'.repeat(64)}`,
        schemaVersion: 1,
      },
      receivedAt,
      retentionExpiresAt: new Date(Date.parse(receivedAt) + 600000).toISOString(),
    })
    expect(adapter.emissions).toEqual([
      {
        name: 'control.command_inbox.duplicate.count',
        value: 1,
        attributes: {
          'service.name': 'workflow-worker',
          outcome: 'duplicate',
        },
      },
    ])
  })

  test('starts the managed Cloud worker with an explicit consistency metric adapter', async () => {
    const adapter = new RecordingMetricAdapter()
    const lifecycle = []
    const endpoint = {
      run: async () => undefined,
      shutdown: async () => lifecycle.push('endpoint'),
    }
    const runtime = await start({
      environment: managedCloudEnvironment(),
      logger: { write: () => undefined },
      processAdapter: new FakeProcessAdapter(),
      workflowRuntime: runtimePort(),
      restateEndpointFactory: { create: async () => endpoint },
      postgresConnectionFactory: () => ({
        database: {},
        check: async () => lifecycle.push('checked'),
        close: async () => lifecycle.push('postgres'),
      }),
      metricAdapter: adapter,
    })

    expect(runtime.readiness().status).toBe('ready')
    await runtime.shutdown('test-complete')
    expect(lifecycle).toEqual(['checked', 'endpoint', 'postgres'])
    // Startup itself emits no consistency metric; the adapter stays reserved for
    // command-inbox outcomes and must never be driven by unrelated spans.
    expect(adapter.emissions).toEqual([])
  })

  test('probes and closes Neon around managed Cloud worker startup', async () => {
    const processAdapter = new FakeProcessAdapter()
    const lifecycle = []
    const endpoint = {
      run: async () => undefined,
      shutdown: async () => lifecycle.push('endpoint'),
    }
    const runtime = await start({
      environment: managedCloudEnvironment(),
      logger: { write: () => undefined },
      processAdapter,
      workflowRuntime: runtimePort(),
      restateEndpointFactory: { create: async () => endpoint },
      postgresConnectionFactory: () => ({
        database: {},
        check: async () => lifecycle.push('checked'),
        close: async () => lifecycle.push('postgres'),
      }),
    })

    expect(lifecycle).toEqual(['checked'])
    expect(runtime.readiness().status).toBe('ready')
    await runtime.shutdown('test-complete')
    expect(lifecycle).toEqual(['checked', 'endpoint', 'postgres'])
  })

  test('composes and closes the staging certification runtime through R2', async () => {
    const lifecycle = []
    const endpoint = {
      run: async () => undefined,
      shutdown: async () => lifecycle.push('endpoint'),
    }
    const runtime = await start({
      environment: managedCloudEnvironment(),
      logger: { write: () => undefined },
      processAdapter: new FakeProcessAdapter(),
      restateEndpointFactory: { create: async () => endpoint },
      postgresConnectionFactory: () => ({
        database: {},
        check: async () => lifecycle.push('postgres-checked'),
        close: async () => lifecycle.push('postgres'),
      }),
      objectStoreFactory: () => ({
        put: async () => undefined,
        get: async () => undefined,
        head: async () => undefined,
        delete: async () => undefined,
        close: () => lifecycle.push('r2'),
      }),
    })

    expect(runtime.readiness().status).toBe('ready')
    await runtime.shutdown('test-complete')
    expect(lifecycle).toEqual(['postgres-checked', 'endpoint', 'postgres', 'r2'])
  })

  test('fails production startup before accepting certification workflows', async () => {
    const calls = []
    await expect(
      start({
        environment: { ...managedCloudEnvironment(), APP_ENV: 'production' },
        logger: { write: () => undefined },
        processAdapter: new FakeProcessAdapter(),
        restateEndpointFactory: {
          create: async () => {
            calls.push('endpoint')
            return { run: async () => undefined, shutdown: async () => undefined }
          },
        },
        postgresConnectionFactory: () => {
          calls.push('postgres')
          return { database: {}, check: async () => undefined, close: async () => undefined }
        },
        objectStoreFactory: () => {
          calls.push('r2')
          return {}
        },
      })
    ).rejects.toThrow('Service startup failed')
    expect(calls).toEqual([])
  })

  test('keeps the production endpoint ready while Cloud execution is disabled', async () => {
    const lifecycle = []
    const runtime = await start({
      environment: {
        ...managedCloudEnvironment(),
        APP_ENV: 'production',
        CONTROL_PLANE_CLOUD_RUNTIME: 'disabled',
      },
      logger: { write: () => undefined },
      processAdapter: new FakeProcessAdapter(),
      restateEndpointFactory: {
        create: async () => ({
          run: async () => lifecycle.push('endpoint-ready'),
          shutdown: async () => lifecycle.push('endpoint-closed'),
        }),
      },
      postgresConnectionFactory: () => ({
        database: {},
        check: async () => lifecycle.push('postgres-ready'),
        close: async () => lifecycle.push('postgres-closed'),
      }),
      objectStoreFactory: () => {
        throw new Error('DISABLED_RUNTIME_MUST_NOT_OPEN_R2')
      },
    })

    expect(runtime.readiness().status).toBe('ready')
    expect(lifecycle).toEqual(['postgres-ready', 'endpoint-ready'])
    await runtime.shutdown('test-complete')
    expect(lifecycle).toEqual([
      'postgres-ready',
      'endpoint-ready',
      'endpoint-closed',
      'postgres-closed',
    ])
  })
})

function runtimePort() {
  return {
    dispatch: async () => ({ outcome: 'failed', failureCode: 'TEST', retryable: false }),
    applyInteraction: async () => ({ outcome: 'failed', failureCode: 'TEST', retryable: false }),
    cleanup: async () => undefined,
  }
}

function managedCloudEnvironment() {
  return {
    APP_ENV: 'staging',
    COMMIT_SHA: 'abc123',
    INSTANCE_ID: 'worker-1',
    SERVICE_VERSION: '1.0.0',
    DATABASE_URL:
      'postgresql://app:database-secret@example.neon.tech/control_plane?sslmode=require',
    CONTROL_PLANE_SECRET_ENCRYPTION_KEY:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    RESTATE_REQUEST_IDENTITY_PUBLIC_KEY: 'publickeyv1_w7YHemBctH5Ck2nQRQ47iBBqhNHy4FV7t2Usbye2A6f',
    R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    R2_BUCKET: 'ctrl-plane',
    R2_REGION: 'auto',
    R2_ACCESS_KEY_ID: 'access-key',
    R2_SECRET_ACCESS_KEY: 'secret-key-that-is-not-logged',
    CONTROL_PLANE_CLOUD_RUNTIME: 'certification',
  }
}
