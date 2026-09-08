import { describe, expect, test } from 'bun:test'
import {
  composeProviderContextPackage,
  contextPackageSerializationFixtures,
} from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { ManagedPiRemoteCommandFactory } from './managed-pi-remote-command.js'
import { InMemoryRuntimeCommandRepository } from '@control-plane/domain'
import { DurableRemoteWorkflowRuntime } from './remote-workflow-runtime.js'

const ids = {
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
  runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
  interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  responseId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}

describe('managed Pi remote command factory', () => {
  test.each(['grant', 'deny', 'input'])(
    'durable %s response replay retains the first remote command and rejects a stale response',
    async (action) => {
      const plan = createExecutionPlanTestFixture()
      const commands = new InMemoryRuntimeCommandRepository()
      const interaction = respondedInteraction(action, action === 'input' ? 'continue' : undefined)
      let clock = '2026-08-25T12:06:00.000Z'
      const factory = new ManagedPiRemoteCommandFactory({
        contextPackages: { get: async () => undefined },
        runtimeDiscovery: { getRuntimeConnection: async () => runtimeConnection() },
        executions: {
          getExecution: async () => ({
            executionId: ids.executionId,
            correlation: plan.correlation,
          }),
        },
        interactions: { get: async () => interaction },
        now: () => new Date(clock),
      })
      const observed = []
      const createRuntime = () =>
        new DurableRemoteWorkflowRuntime({
          attempts: { getAttempt: async () => attempt() },
          commands,
          factory,
          waiter: {
            wait: async ({ command }) => {
              observed.push(command)
              return { outcome: 'completed' }
            },
          },
        })
      const input = {
        executionId: ids.executionId,
        attemptId: ids.attemptId,
        interactionId: ids.interactionId,
        responseId: ids.responseId,
        action,
        effectKey: `workflow:interaction:${action}`,
      }
      await createRuntime().applyInteraction(input)
      clock = '2026-08-25T12:31:00.000Z'
      await Promise.all(Array.from({ length: 8 }, () => createRuntime().applyInteraction(input)))
      expect(observed).toHaveLength(9)
      for (const record of observed) expect(record).toEqual(observed[0])
      expect(observed[0].issuedAt).toBe('2026-08-25T12:06:00.000Z')
      expect(observed[0].commandEnvelope.operation).toBe(
        action === 'input' ? 'runtime.input' : 'runtime.approval'
      )
      expect(observed[0].commandEnvelope.payload.parameters).toMatchObject(
        action === 'input'
          ? { text: 'continue' }
          : { decision: action === 'grant' ? 'approve' : 'deny' }
      )
      await expect(
        createRuntime().applyInteraction({ ...input, responseId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
      ).rejects.toThrow('REMOTE_RUNTIME_INTERACTION_STALE')
      expect(observed).toHaveLength(9)
      expect(await commands.get(observed[0].commandId)).toEqual(observed[0])
      await expect(
        createRuntime().applyInteraction({ ...input, effectKey: `${input.effectKey}:new` })
      ).rejects.toThrow('REMOTE_RUNTIME_COMMAND_EXPIRED')
    }
  )

  test('durable cancellation replay preserves the first payload and lease across clock changes', async () => {
    const plan = createExecutionPlanTestFixture()
    const commands = new InMemoryRuntimeCommandRepository()
    let clock = '2026-08-25T12:06:00.000Z'
    let adapterVersion = '1.0.0'
    const factory = new ManagedPiRemoteCommandFactory({
      contextPackages: { get: async () => undefined },
      runtimeDiscovery: {
        getRuntimeConnection: async () =>
          runtimeConnection({
            versions: {
              adapter: adapterVersion,
              driver: '1.0.0',
              harness: '0.52.1',
              protocol: '1.5.0',
            },
          }),
      },
      executions: {
        getExecution: async () => ({ executionId: ids.executionId, correlation: plan.correlation }),
      },
      interactions: { get: async () => undefined },
      now: () => new Date(clock),
    })
    const observed = []
    const createRuntime = () =>
      new DurableRemoteWorkflowRuntime({
        attempts: { getAttempt: async () => attempt() },
        commands,
        factory,
        waiter: {
          wait: async ({ command }) => {
            observed.push(command)
            return { outcome: 'cancelled' }
          },
        },
      })
    const input = {
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      effectKey: 'workflow:cancel:stable',
      reason: 'user_request',
    }
    await createRuntime().cancel(input)
    clock = '2026-08-25T12:12:00.000Z'
    await Promise.all(Array.from({ length: 8 }, () => createRuntime().cancel(input)))
    expect(observed).toHaveLength(9)
    for (const replay of observed) expect(replay).toEqual(observed[0])
    expect(observed[1].expiresAt).toBe('2026-08-25T12:11:00.000Z')
    adapterVersion = '2.0.0'
    await expect(createRuntime().cancel(input)).rejects.toThrow('REMOTE_RUNTIME_COMMAND_CONFLICT')
    expect(await commands.get(observed[0].commandId)).toEqual(observed[0])
  })

  test('builds one deterministic command from the frozen plan, route, and scoped grant', async () => {
    const contextPackage = composeProviderContextPackage(
      contextPackageSerializationFixtures.futurePi,
      {
        callerContextRefs: [],
        localProjectGrantRefs: ['grant:runtime-node:test'],
        contributions: [],
      }
    )
    const plan = {
      ...createExecutionPlanTestFixture(),
      contextPackage: {
        contextPackageId: contextPackage.contextPackageId,
        contentDigest: contextPackage.contentDigest,
        schemaVersion: contextPackage.schemaVersion,
        compilerVersion: contextPackage.compiler.version,
      },
    }
    const scopes = []
    let clock = '2026-08-25T12:00:00.000Z'
    const factory = new ManagedPiRemoteCommandFactory({
      contextPackages: { get: async () => contextPackage },
      runtimeDiscovery: {
        getRuntimeConnection: async (scope) => {
          scopes.push(scope)
          return runtimeConnection({
            family: 'managed-pi',
            access: {
              localProjectGrant: { required: false, state: 'not_required' },
              entitlement: { state: 'allowed' },
            },
          })
        },
      },
      executions: { getExecution: async () => undefined },
      interactions: { get: async () => undefined },
      now: () => new Date(clock),
    })
    const input = {
      executionId: ids.executionId,
      attempt: attempt(),
      executionPlan: plan,
      effectKey: 'workflow:execution-lifecycle-v1:dispatch',
    }

    const first = await factory.createExecute(input)
    const replay = await factory.createExecute(input)

    expect(replay).toEqual(first)
    expect(first).toMatchObject({
      type: 'command',
      family: 'runtime',
      operation: 'runtime.execute',
      nodeId: ids.runtimeNodeRefId,
      workspaceId: plan.correlation.workspaceId,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      runtimeConnectionId: ids.runtimeConnectionId,
      driver: { family: 'managed-pi', version: '1.0.0' },
      payload: {
        version: 1,
        parameters: {
          grantRef: 'grant:runtime-node:test',
          configuration: {
            executionPlanId: plan.executionPlanId,
            executionPlanDigest: plan.contentDigest,
          },
        },
      },
    })
    expect(first.commandId).toMatch(/^cmd_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(first.traceId).toMatch(/^trc_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(scopes).toEqual([
      {
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        runtimeConnectionId: ids.runtimeConnectionId,
      },
      {
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        runtimeConnectionId: ids.runtimeConnectionId,
      },
    ])
    const commands = new InMemoryRuntimeCommandRepository()
    const observed = []
    const runtime = new DurableRemoteWorkflowRuntime({
      attempts: { getAttempt: async () => attempt() },
      commands,
      factory,
      waiter: {
        wait: async ({ command }) => {
          observed.push(command)
          return { outcome: 'completed' }
        },
      },
    })
    const dispatch = {
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      executionPlan: plan,
      effectKey: input.effectKey,
    }
    await runtime.dispatch(dispatch)
    clock = '2026-08-25T12:31:00.000Z'
    await runtime.dispatch(dispatch)
    expect(observed).toHaveLength(2)
    expect(observed[1]).toEqual(observed[0])
    expect(observed[1].expiresAt).toBe('2026-08-25T12:30:00.000Z')
    await expect(
      runtime.dispatch({ ...dispatch, effectKey: `${dispatch.effectKey}:new` })
    ).rejects.toThrow('REMOTE_RUNTIME_COMMAND_EXPIRED')
  })

  test('fails closed without exactly one immutable local project grant', async () => {
    const plan = createExecutionPlanTestFixture()
    const contextPackage = contextPackageSerializationFixtures.futurePi
    const factory = new ManagedPiRemoteCommandFactory({
      contextPackages: { get: async () => contextPackage },
      runtimeDiscovery: { getRuntimeConnection: async () => runtimeConnection() },
      executions: { getExecution: async () => undefined },
      interactions: { get: async () => undefined },
    })

    await expect(
      factory.createExecute({
        executionId: ids.executionId,
        attempt: attempt(),
        executionPlan: plan,
        effectKey: 'workflow:execution-lifecycle-v1:dispatch',
      })
    ).rejects.toThrow('REMOTE_RUNTIME_PROJECT_GRANT_REQUIRED')
  })

  test.each([
    {
      action: 'input',
      value: { answer: 42 },
      operation: 'runtime.input',
      capability: 'interaction.user-input',
      parameters: {
        handleId: `managed-pi:${ids.attemptId}`,
        interactionId: ids.interactionId,
        text: JSON.stringify({ answer: 42 }),
      },
    },
    {
      action: 'grant',
      operation: 'runtime.approval',
      capability: 'interaction.approval',
      parameters: {
        handleId: `managed-pi:${ids.attemptId}`,
        interactionId: ids.interactionId,
        decision: 'approve',
      },
    },
    {
      action: 'deny',
      operation: 'runtime.approval',
      capability: 'interaction.approval',
      parameters: {
        handleId: `managed-pi:${ids.attemptId}`,
        interactionId: ids.interactionId,
        decision: 'deny',
      },
    },
    {
      action: 'cancel',
      operation: 'runtime.cancel',
      capability: 'execution.cancel',
      parameters: {
        handleId: `managed-pi:${ids.attemptId}`,
        requestedAt: '2026-08-25T12:05:00.000Z',
      },
    },
  ])('translates a durable $action interaction response', async (expected) => {
    const plan = createExecutionPlanTestFixture()
    const interaction = respondedInteraction(expected.action, expected.value)
    const factory = new ManagedPiRemoteCommandFactory({
      contextPackages: { get: async () => undefined },
      runtimeDiscovery: { getRuntimeConnection: async () => runtimeConnection() },
      executions: {
        getExecution: async () => ({
          executionId: ids.executionId,
          correlation: plan.correlation,
        }),
      },
      interactions: { get: async () => interaction },
      now: () => new Date('2026-08-25T12:05:01.000Z'),
    })

    const command = await factory.createInteraction({
      executionId: ids.executionId,
      attempt: attempt(),
      response: {
        interactionId: ids.interactionId,
        responseId: ids.responseId,
        action: expected.action,
      },
      effectKey: `workflow:execution-lifecycle-v1:${expected.action}`,
    })

    expect(command).toMatchObject({
      operation: expected.operation,
      requiredCapabilities: [expected.capability],
      payload: { version: 1, parameters: expected.parameters },
    })
    const afterDeadline = factory.createInteraction({
      executionId: ids.executionId,
      attempt: { ...attempt(), deadlineAt: '2026-08-25T12:05:00.000Z' },
      response: {
        interactionId: ids.interactionId,
        responseId: ids.responseId,
        action: expected.action,
      },
      effectKey: `workflow:execution-lifecycle-v1:${expected.action}:expired`,
    })
    if (expected.action === 'cancel') {
      expect(await afterDeadline).toMatchObject({
        operation: 'runtime.cancel',
        issuedAt: '2026-08-25T12:05:01.000Z',
        expiresAt: '2026-08-25T12:10:01.000Z',
        payload: { version: 1, parameters: expected.parameters },
      })
    } else {
      await expect(afterDeadline).rejects.toThrow('REMOTE_RUNTIME_COMMAND_EXPIRED')
    }
  })

  test('fails closed when an interaction response is stale or unsupported', async () => {
    const plan = createExecutionPlanTestFixture()
    const factory = new ManagedPiRemoteCommandFactory({
      contextPackages: { get: async () => undefined },
      runtimeDiscovery: { getRuntimeConnection: async () => runtimeConnection() },
      executions: {
        getExecution: async () => ({
          executionId: ids.executionId,
          correlation: plan.correlation,
        }),
      },
      interactions: { get: async () => respondedInteraction('resume') },
    })

    await expect(
      factory.createInteraction({
        executionId: ids.executionId,
        attempt: attempt(),
        response: {
          interactionId: ids.interactionId,
          responseId: ids.responseId,
          action: 'resume',
        },
        effectKey: 'workflow:execution-lifecycle-v1:resume',
      })
    ).rejects.toThrow('REMOTE_RUNTIME_INTERACTION_UNSUPPORTED')

    await expect(
      factory.createInteraction({
        executionId: ids.executionId,
        attempt: attempt(),
        response: {
          interactionId: ids.interactionId,
          responseId: 'cmd_01JABCDEF0123456789ABCDEFG',
          action: 'resume',
        },
        effectKey: 'workflow:execution-lifecycle-v1:resume',
      })
    ).rejects.toThrow('REMOTE_RUNTIME_INTERACTION_STALE')
  })

  test('creates an attempt-bound cancellation command without an interaction record', async () => {
    const plan = createExecutionPlanTestFixture()
    const factory = new ManagedPiRemoteCommandFactory({
      contextPackages: { get: async () => undefined },
      runtimeDiscovery: { getRuntimeConnection: async () => runtimeConnection() },
      executions: {
        getExecution: async () => ({
          executionId: ids.executionId,
          correlation: plan.correlation,
        }),
      },
      interactions: { get: async () => undefined },
      now: () => new Date('2026-08-25T12:06:00.000Z'),
    })

    const command = await factory.createCancel({
      executionId: ids.executionId,
      attempt: { ...attempt(), deadlineAt: '2026-08-25T12:05:00.000Z' },
      effectKey: 'workflow:execution-lifecycle-v1:cancel-active:cancelled',
      reason: 'user_request',
    })

    expect(command).toMatchObject({
      operation: 'runtime.cancel',
      requiredCapabilities: ['execution.cancel'],
      expiresAt: '2026-08-25T12:11:00.000Z',
      payload: {
        version: 1,
        parameters: {
          handleId: `managed-pi:${ids.attemptId}`,
          requestedAt: '2026-08-25T12:06:00.000Z',
        },
      },
    })
  })
})

function respondedInteraction(action, value) {
  return {
    interactionId: ids.interactionId,
    executionId: ids.executionId,
    attemptId: ids.attemptId,
    kind:
      action === 'input'
        ? 'input'
        : action === 'grant'
          ? 'permission'
          : action === 'resume'
            ? 'resume'
            : action === 'cancel'
              ? 'cancel'
              : 'approval',
    prompt: { title: 'Continue?' },
    allowedActions: [action],
    allowedPrincipalIds: ['principal:test'],
    state: 'responded',
    version: 2,
    requestedAt: '2026-08-25T12:00:00.000Z',
    expiresAt: '2026-08-25T12:10:00.000Z',
    response: {
      responseId: ids.responseId,
      action,
      respondingPrincipalId: 'principal:test',
      respondedAt: '2026-08-25T12:05:00.000Z',
      ...(value === undefined ? {} : { value }),
    },
    resolvedAt: '2026-08-25T12:05:00.000Z',
  }
}

function attempt() {
  return {
    attemptId: ids.attemptId,
    executionId: ids.executionId,
    deadlineAt: '2026-08-25T12:30:00.000Z',
    runtime: {
      runtimeDefinitionId: ids.runtimeDefinitionId,
      runtimeNodeRefId: ids.runtimeNodeRefId,
      runtimeConnectionId: ids.runtimeConnectionId,
    },
  }
}

function runtimeConnection(overrides = {}) {
  return {
    runtimeConnectionId: ids.runtimeConnectionId,
    runtimeDefinitionId: ids.runtimeDefinitionId,
    family: 'pi',
    connectionType: 'managed_local',
    location: 'local_device',
    status: 'available',
    node: {
      runtimeNodeRefId: ids.runtimeNodeRefId,
      location: 'remote_host',
      status: 'online',
      health: 'online',
      observedAt: '2026-08-25T12:00:00.000Z',
    },
    connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
    freshness: {
      state: 'fresh',
      observedAt: '2026-08-25T12:00:00.000Z',
      expiresAt: '2026-08-25T12:01:00.000Z',
    },
    versions: { adapter: '1.0.0', driver: '1.0.0', harness: '0.52.1', protocol: '1.5.0' },
    capabilities: ['filesystem.read', 'stream.output'],
    capabilityDetails: [
      { name: 'filesystem.read', support: 'supported' },
      { name: 'stream.output', support: 'supported' },
    ],
    compatibility: { state: 'compatible', limitations: [] },
    access: {
      localProjectGrant: { required: true, state: 'granted' },
      entitlement: { state: 'allowed' },
    },
    eligibility: { state: 'eligible', reasons: [], degradations: [], remediation: [] },
    observedAt: '2026-08-25T12:00:00.000Z',
    limitations: [],
    ...overrides,
  }
}
