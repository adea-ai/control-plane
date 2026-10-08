import { expect, test } from 'bun:test'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { RuntimeDiscoveryAttemptRouter } from './runtime-attempt-router.ts'
import { ManagedPiRemoteCommandFactory } from './managed-pi-remote-command.ts'

function workspacePlan() {
  const plan = createExecutionPlanTestFixture()
  const { projectId: _projectId, ...correlation } = plan.correlation
  return {
    ...plan,
    schemaVersion: 2,
    correlation: { ...correlation, executionScope: { schemaVersion: 1, kind: 'workspace' } },
  }
}

test('legacy runtime router rejects workspace scope before discovery', async () => {
  let reads = 0
  const router = new RuntimeDiscoveryAttemptRouter({
    discovery: {
      listRuntimeConnections: async () => {
        reads++
        return []
      },
    },
  })
  const executionPlan = workspacePlan()
  await expect(
    router.resolve({
      execution: { correlation: executionPlan.correlation },
      executionPlan,
    })
  ).rejects.toThrow('WORKFLOW_RUNTIME_SCOPE_UNSUPPORTED')
  expect(reads).toBe(0)
})

test('legacy router rejects mismatched real projects before discovery', async () => {
  let reads = 0
  const router = new RuntimeDiscoveryAttemptRouter({
    discovery: {
      listRuntimeConnections: async () => {
        reads++
        return []
      },
    },
  })
  const executionPlan = createExecutionPlanTestFixture()
  await expect(
    router.resolve({
      execution: {
        correlation: { ...executionPlan.correlation, projectId: 'prj_01JABCDEF0123456789ABCDEFH' },
      },
      executionPlan,
    })
  ).rejects.toThrow('WORKFLOW_RUNTIME_SCOPE_UNSUPPORTED')
  expect(reads).toBe(0)
})

test('legacy remote Pi execute rejects workspace scope before context or runtime discovery', async () => {
  let reads = 0
  const factory = new ManagedPiRemoteCommandFactory({
    contextPackages: {
      get: async () => {
        reads++
        return undefined
      },
    },
    runtimeDiscovery: {
      getRuntimeConnection: async () => {
        reads++
        return undefined
      },
    },
    executions: { getExecution: async () => undefined },
    interactions: { get: async () => undefined },
  })
  await expect(
    factory.createExecute({
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      attempt: {},
      executionPlan: workspacePlan(),
      effectKey: 'workspace-denial',
    })
  ).rejects.toThrow('REMOTE_RUNTIME_WORKSPACE_SCOPE_UNSUPPORTED')
  expect(reads).toBe(0)
})

test('legacy remote Pi cancellation rejects persisted workspace scope before runtime discovery', async () => {
  let reads = 0
  const plan = workspacePlan()
  const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
  const factory = new ManagedPiRemoteCommandFactory({
    contextPackages: { get: async () => undefined },
    runtimeDiscovery: {
      getRuntimeConnection: async () => {
        reads++
        return undefined
      },
    },
    executions: { getExecution: async () => ({ executionId, correlation: plan.correlation }) },
    interactions: { get: async () => undefined },
  })
  await expect(
    factory.createCancel({ executionId, attempt: {}, effectKey: 'workspace-denial' })
  ).rejects.toThrow('REMOTE_RUNTIME_WORKSPACE_SCOPE_UNSUPPORTED')
  expect(reads).toBe(0)
})
