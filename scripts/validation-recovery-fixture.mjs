import { deepStrictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { createExecutionPlanTestFixture } from '../packages/execution-plan/src/testing.ts'
import {
  assertExecutionPlanIntegrity,
  assertExecutionValidationCommandPlan,
  executionValidationCommandKey,
} from '../packages/execution-plan/src/index.ts'

export function validationRecoveryFixture(marker) {
  const plan = createExecutionPlanTestFixture()
  const record = {
    scope: {
      callerPrincipalId: 'svc_recovery-fixture',
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      operation: 'execution.validate',
      idempotencyKey: `postgres-validation:${marker}`,
    },
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    requestId: plan.correlation.requestId,
    payloadHash: `sha256:${createHash('sha256').update(marker).digest('hex')}`,
    executionPlan: { executionPlanId: plan.executionPlanId, contentDigest: plan.contentDigest },
    recordedAt: '2026-09-07T12:00:00.000Z',
  }
  return {
    plan,
    record,
    commandKey: executionValidationCommandKey(record.scope),
    assertRecovered(recoveredRecord, recoveredPlan) {
      const parsedPlan = assertExecutionPlanIntegrity(recoveredPlan)
      deepStrictEqual(assertExecutionValidationCommandPlan(recoveredRecord, parsedPlan), record)
      deepStrictEqual(parsedPlan, plan)
    },
  }
}
