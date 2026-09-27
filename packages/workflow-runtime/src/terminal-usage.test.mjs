import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { runExecutionLifecycle } from './execution-workflow.ts'
import { WorkflowJobStore } from './embedded-job-store.ts'

const input = {
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
  executionPlan: {
    executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    contentDigest: `sha256:${'a'.repeat(64)}`,
    schemaVersion: 1,
  },
  deadlineAt: '2026-09-27T15:00:00.000Z',
}
const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const usage = {
  inputTokens: 11,
  outputTokens: 3,
  durationMs: 20,
  cost: { amount: '0.002', currency: 'USD' },
  accounting: {
    schemaVersion: 1,
    sourceId: 'provider-measurement:terminal',
    fundingSource: 'hq_managed',
    currency: 'USD',
    chargedMicrounits: 2000,
    costExact: true,
  },
}

function activities(outcome) {
  const statuses = []
  return {
    statuses,
    ensureAttempt: async () => ({ attemptId }),
    persistStatus: async (value) => statuses.push(value),
    dispatch: async () => outcome,
    cleanup: async () => {},
    cancelActive: async () => {},
  }
}

test.each(['completed', 'failed', 'cancelled'])(
  'workflow preserves measured terminal %s evidence through cold queue reopen',
  async (status) => {
    const directory = await mkdtemp(join(tmpdir(), 'm11-workflow-terminal-usage-'))
    const provider = new SqlitePersistenceProvider({ path: join(directory, 'queue.sqlite') })
    try {
      await provider.migrate()
      let queue = new WorkflowJobStore(provider)
      const at = '2026-09-27T14:00:00.000Z'
      await queue.enqueue({ workflowKey: input.executionId, input, at })
      const [job] = await queue.claimDue({
        owner: 'usage-fixture',
        leaseMs: 60_000,
        now: at,
        limit: 1,
      })
      const outcome = {
        outcome: status,
        terminalUsage: usage,
        ...(status === 'completed' ? { resultReference: 'art_measured' } : {}),
        ...(status === 'failed' ? { failureCode: 'RUNTIME_FAILED', retryable: false } : {}),
      }
      const result = await runExecutionLifecycle(input, activities(outcome))
      expect(result).toMatchObject({ status, terminalUsage: usage })
      expect(usage.accounting.chargedMicrounits).toBe(2000)
      await queue.complete({
        workflowKey: job.workflowKey,
        owner: job.lease.owner,
        token: job.lease.token,
        outcome: result,
        at: '2026-09-27T14:00:01.000Z',
      })
      provider.close({ checkpoint: true })
      await provider.migrate()
      queue = new WorkflowJobStore(provider)
      const reopened = await queue.get(input.executionId)
      expect(reopened.status).toBe('succeeded')
      expect(reopened.outcome).toEqual(result)
      expect(reopened.outcome.terminalUsage).toEqual(usage)
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('missing usage remains absent rather than a fabricated zero charge', async () => {
  const result = await runExecutionLifecycle(input, activities({ outcome: 'cancelled' }))
  expect(result.status).toBe('cancelled')
  expect(result).not.toHaveProperty('terminalUsage')
})

test('malformed measured usage fails before terminal status is committed', async () => {
  const port = activities({ outcome: 'completed', terminalUsage: { ...usage, inputTokens: -1 } })
  await expect(runExecutionLifecycle(input, port)).rejects.toThrow()
  expect(port.statuses.some((value) => value.state === 'completed')).toBe(false)
})

test('terminal control after a measured outcome retains evidence rather than erasing spend', async () => {
  const result = await runExecutionLifecycle(
    input,
    activities({ outcome: 'completed', terminalUsage: usage }),
    {
      checkTerminal: async () => ({ cancelled: true }),
    }
  )
  expect(result).toMatchObject({ status: 'cancelled', terminalUsage: usage })
})

test('malformed evidence cannot prevent active cancellation', async () => {
  const port = activities({
    outcome: 'completed',
    terminalUsage: { inputTokens: -1, outputTokens: 0, durationMs: 0 },
  })
  let cancellations = 0
  port.cancelActive = async () => {
    cancellations += 1
  }
  await expect(
    runExecutionLifecycle(input, port, { checkTerminal: async () => ({ cancelled: true }) })
  ).rejects.toThrow()
  expect(cancellations).toBe(1)
  expect(port.statuses.some((value) => value.state === 'cancelled')).toBe(false)
})
