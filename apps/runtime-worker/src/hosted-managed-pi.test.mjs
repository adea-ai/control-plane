import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { executionConstraintFixtures } from '@control-plane/domain'
import {
  ManagedPiAdapter,
  ManagedPiDriver,
  translateExecutionPlanToManagedPi,
} from '@control-plane/managed-pi-adapter'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { GatewayResultEnvelopeSchema } from '@control-plane/runtime-gateway-protocol'
import {
  evaluateRuntimeEligibility,
  RemoteRuntimeGatewayTransport,
  routeRuntimeConnections,
  runRuntimeAdapterConformance,
} from '@control-plane/runtime-sdk'
import {
  HostedManagedPiClient,
  HostedManagedPiTerminalBridge,
  HostedManagedPiWorker,
  InMemoryHostedArtifactStore,
  ObjectStoreHostedArtifactStore,
  ReferenceRuntimeHostProvider,
  buildHostedManagedPiRuntimeConnection,
} from './hosted-managed-pi.ts'

const hostedPiAdapter = (client) =>
  new ManagedPiAdapter({
    transport: new RemoteRuntimeGatewayTransport(
      new ManagedPiDriver({ client, adapterVersion: '1.0.0' })
    ),
  })

const now = '2026-08-25T12:00:00.000Z'
const digest = (character) => `sha256:${character.repeat(64)}`
const ids = {
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
  runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
}

function plan() {
  return {
    schemaVersion: 1,
    executionPlanId: ids.executionPlanId,
    contentDigest: digest('a'),
    profile: {
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
      version: 3,
      revision: 2,
      schemaVersion: 1,
      contentDigest: digest('b'),
    },
    skills: [
      {
        skillId: 'skl_01JABCDEF0123456789ABCDEFG',
        skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
        revision: 4,
        schemaVersion: 1,
        semanticVersion: '2.1.0',
        contentDigest: digest('c'),
      },
    ],
    contextPackage: {
      contextPackageId: 'ctx_01JABCDEF0123456789ABCDEFG',
      contentDigest: digest('d'),
      schemaVersion: 1,
      compilerVersion: '1.0.0',
    },
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
      { capability: 'execution.cancel', necessity: 'required', minimumSupport: 'supported' },
    ],
    constraints: globalThis.structuredClone(executionConstraintFixtures.write),
    policySnapshot: globalThis.structuredClone(executionConstraintFixtures.write.policySnapshot),
    outputContract: { contractRef: 'contract://execution-result/v1' },
  }
}

function fixture(scenario = 'complete') {
  const artifactStore = new InMemoryHostedArtifactStore({ now: () => now })
  const host = new ReferenceRuntimeHostProvider({
    now: () => now,
    scenario,
    artifactStore,
    maximumConcurrent: 2,
  })
  const client = new HostedManagedPiClient({
    host,
    now: () => new Date(now),
    resolveAuthority: async () => ({
      modelGrantRefs: ['authz:model:managed-default'],
      toolGrantRefs: ['authz:tool:project-files:read'],
    }),
  })
  return {
    artifactStore,
    host,
    client,
    adapter: hostedPiAdapter(client),
  }
}

describe('hosted managed Pi runtime worker', () => {
  test('replays an admitted launch after client restart and clock advance without renewing its deadline', async () => {
    const { host } = fixture('running')
    let currentTime = now
    const makeClient = () =>
      new HostedManagedPiClient({
        host,
        now: () => new Date(currentTime),
        resolveAuthority: async () => ({
          modelGrantRefs: ['authz:model:managed-default'],
          toolGrantRefs: ['authz:tool:project-files:read'],
        }),
      })
    const command = {
      attemptId: ids.attemptId,
      idempotencyKey: 'hosted-pi:late-launch-replay',
      configuration: translateExecutionPlanToManagedPi(plan(), '1.0.0'),
    }
    const handle = await makeClient().start(command)
    const originalLaunch = host.launches()[0]
    currentTime = '2026-08-26T12:00:00.000Z'
    expect(await makeClient().start(command)).toEqual(handle)
    expect(host.launches()).toEqual([originalLaunch])
    expect(host.effectCount(ids.attemptId)).toBe(1)
    const changed = structuredClone(command)
    changed.configuration.limits.duration.maximumMs += 1
    await expect(makeClient().start(changed)).rejects.toMatchObject({
      code: 'HOSTED_PI_IDEMPOTENCY_CONFLICT',
    })
    await expect(
      makeClient().start({ ...command, attemptId: `att_${'1'.repeat(26)}` })
    ).rejects.toMatchObject({
      code: 'HOSTED_PI_IDEMPOTENCY_CONFLICT',
    })
  })

  test('replays an admitted launch when the host is now at capacity', async () => {
    const artifactStore = new InMemoryHostedArtifactStore({ now: () => now })
    const host = new ReferenceRuntimeHostProvider({
      now: () => now,
      scenario: 'running',
      artifactStore,
      maximumConcurrent: 1,
    })
    const client = new HostedManagedPiClient({
      host,
      now: () => new Date(now),
      resolveAuthority: async () => ({
        modelGrantRefs: ['authz:model:managed-default'],
        toolGrantRefs: ['authz:tool:project-files:read'],
      }),
    })
    const command = {
      attemptId: ids.attemptId,
      idempotencyKey: 'hosted-pi:full-host-replay',
      configuration: translateExecutionPlanToManagedPi(plan(), '1.0.0'),
    }
    const handle = await client.start(command)
    expect((await host.inspect()).capacity.active).toBe(1)
    expect(await client.start(command)).toEqual(handle)
    expect(host.effectCount(ids.attemptId)).toBe(1)
    await expect(
      client.start({ ...command, idempotencyKey: 'hosted-pi:new-launch' })
    ).rejects.toMatchObject({
      code: 'HOSTED_PI_CAPACITY_UNAVAILABLE',
    })
  })

  test('publishes terminal hosted output as an Artifact-backed gateway result', async () => {
    const artifactStore = new InMemoryHostedArtifactStore({ now: () => now })
    const bridge = new HostedManagedPiTerminalBridge({ artifactStore })
    const command = gatewayCommand()

    expect(
      await bridge.result({
        command,
        status: { state: 'running', observedAt: now },
        sequence: 7,
      })
    ).toBeUndefined()

    const result = await bridge.result({
      command,
      status: {
        state: 'succeeded',
        observedAt: now,
        result: {
          output: { answer: 'hosted-managed-pi-complete' },
          usage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
          artifacts: [],
        },
      },
      sequence: 8,
    })

    expect(GatewayResultEnvelopeSchema.parse(result)).toMatchObject({
      type: 'result',
      sequence: 8,
      commandId: command.commandId,
      status: 'succeeded',
      result: {
        artifact: {
          artifactId: `art_${'0'.repeat(25)}1`,
          mediaType: 'application/json',
        },
      },
    })
    expect(artifactStore.references()).toHaveLength(1)
  })

  test('maps terminal hosted failures without persisting false success artifacts', async () => {
    const artifactStore = new InMemoryHostedArtifactStore({ now: () => now })
    const bridge = new HostedManagedPiTerminalBridge({ artifactStore })
    const command = gatewayCommand()
    const error = {
      code: 'HOSTED_PI_WORKER_CRASHED',
      classification: 'infrastructure',
      message: 'Hosted managed Pi worker crashed',
      retryable: true,
    }

    expect(
      await bridge.result({
        command,
        status: { state: 'errored', observedAt: now, error },
        sequence: 9,
      })
    ).toMatchObject({ status: 'failed', result: { data: { error } } })
    expect(
      await bridge.result({
        command,
        status: { state: 'cancelled', observedAt: now },
        sequence: 10,
      })
    ).toMatchObject({ status: 'cancelled', result: { data: {} } })
    expect(artifactStore.references()).toHaveLength(0)
  })

  test('persists one replay-safe terminal Artifact through the configured ObjectStore', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-hosted-artifact-'))
    const objectStore = new FilesystemObjectStore({
      rootDirectory: directory,
      maxObjectBytes: 1024 * 1024,
    })
    const artifactStore = new ObjectStoreHostedArtifactStore(objectStore)
    try {
      const first = await artifactStore.persist({
        attemptId: ids.attemptId,
        mediaType: 'application/json',
        value: { nested: { answer: 'complete' }, ok: true },
      })
      const replay = await new ObjectStoreHostedArtifactStore(objectStore).persist({
        attemptId: ids.attemptId,
        mediaType: 'application/json',
        value: { ok: true, nested: { answer: 'complete' } },
      })
      expect(replay).toEqual(first)
      expect(first).toMatchObject({
        artifactId: `art_${ids.attemptId.slice(4)}`,
        mediaType: 'application/json',
        locator: `artifact://runtime-results/${ids.attemptId}/result.json`,
      })
      expect(await objectStore.get(`runtime-results/${ids.attemptId}/result.json`)).toMatchObject({
        sha256: first.digest,
        size: first.sizeBytes,
      })
      await expect(
        new ObjectStoreHostedArtifactStore(objectStore).persist({
          attemptId: ids.attemptId,
          mediaType: 'application/json',
          value: { ok: false },
        })
      ).rejects.toThrow('HOSTED_ARTIFACT_RESULT_CONFLICT')
    } finally {
      objectStore.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('uses the same normalized plan as local managed Pi under bounded delegated authority', async () => {
    const { adapter, host, artifactStore } = fixture()
    const handle = await adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'hosted-pi:start',
      executionPlan: plan(),
    })
    const progress = []
    for await (const event of adapter.progress(handle)) progress.push(event)

    const request = host.launches()[0]
    expect(request.configuration).toEqual(translateExecutionPlanToManagedPi(plan(), '1.0.0'))
    expect(request).toMatchObject({
      authority: {
        modelGrantRefs: ['authz:model:managed-default'],
        toolGrantRefs: ['authz:tool:project-files:read'],
      },
      sandbox: plan().constraints.limits.sandbox,
      maximumDurationMs: plan().constraints.limits.duration.maximumMs,
    })
    expect(progress.map(({ type }) => type)).toEqual([
      'status',
      'output',
      'usage',
      'artifact',
      'status',
    ])
    expect(await adapter.status(handle)).toMatchObject({
      state: 'completed',
      result: { artifacts: [{ locator: 'artifact://hosted-managed-pi/result' }] },
    })
    expect(artifactStore.references()).toHaveLength(1)
    expect(JSON.stringify(host.launches())).not.toMatch(
      /\/Users\/|\/workspace|credential|apiKey|accessToken|privateKey|process\.env/
    )
  })

  test('passes common adapter conformance without granting the worker ambient host access', async () => {
    const { adapter, host } = fixture('running')
    const report = await runRuntimeAdapterConformance({
      adapter,
      executionPlan: plan(),
      attemptId: ids.attemptId,
      complete: async (handle) => {
        host.complete(handle.handleId)
        return adapter.status(handle)
      },
    })

    expect(report.passed).toBeTrue()
    expect(host.launches()).toHaveLength(1)
  })

  test('classifies worker crash and reconciles retained attempts after client restart', async () => {
    const crashed = fixture('crash')
    const crashedHandle = await crashed.adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'hosted-pi:crash',
      executionPlan: plan(),
    })
    expect(await crashed.adapter.status(crashedHandle)).toMatchObject({
      state: 'failed',
      error: {
        code: 'HOSTED_PI_WORKER_CRASHED',
        classification: 'infrastructure',
        retryable: true,
      },
    })
    expect(
      await crashed.adapter.start({
        attemptId: ids.attemptId,
        idempotencyKey: 'hosted-pi:crash',
        executionPlan: plan(),
      })
    ).toEqual(crashedHandle)
    expect(crashed.host.effectCount(ids.attemptId)).toBe(1)

    const running = fixture('running')
    const handle = await running.adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'hosted-pi:restart',
      executionPlan: plan(),
    })
    const restartedClient = new HostedManagedPiClient({
      host: running.host,
      now: () => new Date(now),
      resolveAuthority: async () => ({ modelGrantRefs: [], toolGrantRefs: [] }),
    })
    const restartedAdapter = hostedPiAdapter(restartedClient)

    expect(await restartedAdapter.reconcile(handle)).toMatchObject({ state: 'running' })
    expect(running.host.effectCount(ids.attemptId)).toBe(1)
  })

  test('cancels and releases a hosted sandbox with bounded terminal state', async () => {
    const running = fixture('running')
    const handle = await running.adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'hosted-pi:cancel',
      executionPlan: plan(),
    })

    expect(
      await running.adapter.cancel(handle, {
        idempotencyKey: 'hosted-pi:cancel-control',
        requestedAt: now,
      })
    ).toMatchObject({ state: 'cancelled' })
    await running.adapter.cleanup(handle)
    await running.adapter.cleanup(handle)
    expect(running.host.cleanupCount(handle.handleId)).toBe(1)
  })

  test('fails closed before allocation when the plan exceeds host limits', async () => {
    const bounded = fixture('running')
    const oversized = plan()
    oversized.constraints.limits.duration.maximumMs = 3_600_001

    await expect(
      bounded.adapter.start({
        attemptId: ids.attemptId,
        idempotencyKey: 'hosted-pi:oversized',
        executionPlan: oversized,
      })
    ).rejects.toMatchObject({
      code: 'HOSTED_PI_RESOURCE_LIMIT_UNSUPPORTED',
      classification: 'unsupported',
      retryable: false,
    })
    expect(bounded.host.launches()).toHaveLength(0)
  })

  test('publishes managed RuntimeConnection health and provider-neutral scaling readiness', async () => {
    const { host } = fixture('running')
    const worker = new HostedManagedPiWorker({ host, targetUtilizationPermille: 700 })
    const connection = buildHostedManagedPiRuntimeConnection({
      runtimeConnectionId: ids.runtimeConnectionId,
      runtimeDefinitionId: ids.runtimeDefinitionId,
      observedAt: now,
      host: await host.inspect(),
    })
    const eligibility = evaluateRuntimeEligibility({
      eligibilityVersion: 1,
      evaluatedAt: now,
      executionPlan: {
        executionPlanId: ids.executionPlanId,
        contentDigest: plan().contentDigest,
        runtimeRequirements: plan().runtimeRequirements,
      },
      candidate: { family: 'pi', nodeStatus: 'not_applicable', connection },
      policy: {
        snapshot: plan().policySnapshot,
        allowedFamilies: ['pi'],
        allowedLocations: ['agent_hq_cloud'],
        deniedRuntimeConnectionIds: [],
        requireVerifiedCapabilities: true,
        security: { status: 'allowed' },
      },
      localProjectGrant: { required: false, status: 'not_required' },
      entitlement: { status: 'allowed', class: 'hosted-pi' },
    })
    const routing = routeRuntimeConnections({
      routingVersion: 1,
      executionPlanId: ids.executionPlanId,
      evaluatedAt: now,
      policy: {
        policyId: 'hosted-pi-routing',
        version: 1,
        digest: digest('f'),
        weights: {
          explicitConnection: 1,
          preferredFamily: 1,
          preferredDeployment: 1,
          locality: 1,
          health: 10,
          load: 10,
          queue: 10,
          entitlement: 1,
          cost: 1,
        },
      },
      candidates: [
        {
          runtimeConnectionId: ids.runtimeConnectionId,
          family: 'pi',
          deployment: 'managed',
          eligibility,
          signals: {
            locality: 50,
            health: 100,
            loadPermille: 0,
            queueDepth: 0,
            entitlementPriority: 50,
            costClass: 'medium',
          },
        },
      ],
    })

    expect(connection).toMatchObject({
      connectionType: 'managed_cloud',
      location: 'agent_hq_cloud',
      status: 'connected',
      health: 'healthy',
    })
    expect(routing.selected?.runtimeConnectionId).toBe(ids.runtimeConnectionId)
    expect(await worker.readiness()).toEqual({ ready: true, reason: 'READY' })
    expect(await worker.scaling()).toMatchObject({ currentCapacity: 2, desiredCapacity: 2 })
    host.setQueued(3)
    expect(await worker.scaling()).toMatchObject({ queued: 3, desiredCapacity: 5 })

    host.setHealth('unavailable')
    expect(await worker.readiness()).toEqual({ ready: false, reason: 'HOST_UNAVAILABLE' })
  })
})

function gatewayCommand() {
  return {
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 5 },
    sequence: 6,
    nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    sentAt: now,
    channelGeneration: 1,
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    idempotencyKey: 'hosted-pi:gateway',
    payloadHash: digest('e'),
    issuedAt: now,
    expiresAt: '2026-08-25T12:01:00.000Z',
    family: 'runtime',
    operation: 'runtime.execute',
    driver: { family: 'managed-pi', version: '1.0.0' },
    runtimeConnectionId: ids.runtimeConnectionId,
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: ids.attemptId,
    requiredCapabilities: ['runtime.execute'],
    payload: { version: 1, parameters: { fixture: true } },
  }
}
