import assert from 'node:assert/strict'

export async function awaitLocalWorkflowOutcome(
  local,
  executionId,
  expectedStatus,
  timeoutMs = 10000
) {
  assert.equal(
    local.durableExecution,
    'embedded-sqlite',
    'LOCAL_CERTIFICATION_REQUIRES_EMBEDDED_SQLITE'
  )
  assert.ok(local.workflowJobs, 'LOCAL_CERTIFICATION_WORKFLOW_QUEUE_MISSING')
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const job = await local.workflowJobs.get(executionId)
    if (job?.status === 'succeeded') {
      assert.equal(job.outcome?.executionId, executionId, 'LOCAL_WORKFLOW_EXECUTION_MISMATCH')
      assert.equal(job.outcome.status, expectedStatus, 'LOCAL_WORKFLOW_OUTCOME_MISMATCH')
      return job.outcome
    }
    if (job?.status === 'failed' && job.runAt === undefined)
      throw new Error(`LOCAL_WORKFLOW_FAILED:${job.lastError?.message ?? executionId}`)
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error(`LOCAL_WORKFLOW_TIMEOUT:${executionId}`)
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
  }
}
