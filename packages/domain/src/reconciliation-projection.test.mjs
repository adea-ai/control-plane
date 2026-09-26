import { expect, test } from 'bun:test'
import {
  CommandInboxService,
  InMemoryCommandAcceptanceRepository,
  createReconciliationEffects,
} from './index.ts'

test('workflow reconciliation preserves marketplace pins from accepted execution', async () => {
  const now = '2026-09-26T12:00:00.000Z'
  const commands = new InMemoryCommandAcceptanceRepository()
  const marketplacePluginReferences = [
    {
      pluginId: 'plugin:control-plane:guard-fixture',
      releaseId: `release:${'a'.repeat(64)}`,
      canonicalContentDigest: `sha256:${'b'.repeat(64)}`,
    },
  ]
  const accepted = await new CommandInboxService({
    repository: commands,
    executionIdFactory: () => 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    executionPlanValidator: { validate: async () => true },
    now: () => now,
  }).acceptExecution({
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    idempotencyKey: 'reconciliation-marketplace-pins-0001',
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    },
    executionPlan: {
      executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      contentDigest: `sha256:${'c'.repeat(64)}`,
      schemaVersion: 1,
    },
    marketplacePluginReferences,
    receivedAt: now,
    retentionExpiresAt: '2026-10-27T12:00:00.000Z',
  })
  const submissions = []
  const effects = createReconciliationEffects({
    executions: { getExecution: async () => accepted.execution },
    commands,
    events: {
      rearmPendingDelivery: async () => {
        throw new Error('UNEXPECTED_REARM')
      },
    },
    workflowSubmitter: { submit: async (input) => submissions.push(input) },
    now: () => now,
  })
  const input = {
    executionId: accepted.execution.executionId,
    checkpointId: `rcp_${'a'.repeat(32)}`,
  }
  await effects.resumeWorkflow(input)
  expect(submissions).toHaveLength(1)
  expect(submissions[0].marketplacePluginReferences).toEqual(marketplacePluginReferences)
  expect(submissions[0].executionPlan).toEqual(accepted.execution.executionPlan)
  expect((await commands.getByExecutionId(input.executionId)).status).toBe('processing')
  await effects.resumeWorkflow(input)
  expect(submissions).toHaveLength(1)
})
