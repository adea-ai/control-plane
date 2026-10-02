import { expect, test } from 'bun:test'
import { runExecutionLifecycle } from './execution-workflow.ts'
import { WorkflowJobOutcomeSchema } from './embedded-job-store.ts'
import { OrchestrationGraphSegmentActivities } from './graph-segment-activity.ts'

const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const graph = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  threadId: `graph:${executionId}`,
  reference: {
    graphDefinitionId: 'uncertain-tool',
    graphVersion: '1.0.0',
    contentDigest: 'sha256:' + 'a'.repeat(64),
  },
  input: {},
}

test('an unconfirmed graph effect survives activity and workflow boundaries without terminal cleanup', async () => {
  const segments = new OrchestrationGraphSegmentActivities({
    run: async () => ({ status: 'reconciliation_required', state: {}, events: [] }),
  })
  const statuses = []
  let cleanups = 0
  const result = await runExecutionLifecycle(
    {
      executionId,
      workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
      executionPlan: {
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        contentDigest: 'sha256:' + 'b'.repeat(64),
        schemaVersion: 1,
      },
      graph,
    },
    {
      ensureAttempt: async () => ({ attemptId }),
      persistStatus: async (input) => {
        statuses.push(input.state)
      },
      runGraphSegment: segments.runGraphSegment.bind(segments),
      cleanup: async () => {
        cleanups++
      },
    }
  )
  expect(result.status).toBe('reconciliation_required')
  expect(statuses).toContain('reconciliation_required')
  expect(
    statuses.some((state) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(state))
  ).toBe(false)
  expect(cleanups).toBe(0)
  expect(WorkflowJobOutcomeSchema.parse(result).status).toBe('reconciliation_required')
})
