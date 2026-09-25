import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteExecutionRepository, SqlitePersistenceProvider } from './index.js'

const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const attemptId = 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const projectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const taskId = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const agentId = 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const requestId = 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const executionPlanId = 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const acceptedAt = '2026-05-01T10:00:00.000Z'
const terminalAt = '2026-05-02T10:00:00.000Z'
const ninetyDaysMs = 90 * 24 * 60 * 60 * 1_000

// The store derives record ids by hashing the logical id, so a fixture that
// wants to look like a stored record has to use the same derivation.
function storedId(value) {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

function terminalExecution(overrides = {}) {
  return {
    executionId,
    state: 'completed',
    version: 2,
    correlation: { workspaceId, projectId, taskId, agentId, requestId },
    executionPlan: {
      executionPlanId,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schemaVersion: 1,
    },
    attemptCount: 0,
    acceptedAt,
    terminalAt,
    createdAt: acceptedAt,
    updatedAt: terminalAt,
    ...overrides,
  }
}

async function seedExecution(provider, overrides = {}) {
  await provider.transaction((transaction) =>
    transaction.put({
      namespace: 'executions',
      id: storedId(executionId),
      value: terminalExecution(overrides),
    })
  )
}

async function seedAttempt(provider, state) {
  await provider.transaction((transaction) =>
    transaction.put({
      namespace: 'execution-attempts',
      id: storedId(attemptId),
      value: {
        attemptId,
        executionId,
        sequence: 1,
        state,
        version: 1,
        acceptedAt,
        createdAt: acceptedAt,
        updatedAt: terminalAt,
        ...(state === 'completed' ? { terminalAt } : {}),
      },
    })
  )
}

async function withProvider(run) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-execution-retention-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    return await run(provider)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('SQLite execution retention deletion (#194)', () => {
  test('an unreferenced terminal execution becomes eligible and leaves with its attempt', async () => {
    await withProvider(async (provider) => {
      await seedExecution(provider)
      await seedAttempt(provider, 'completed')
      const repository = new SqliteExecutionRepository(provider)
      const now = new Date(Date.parse(terminalAt) + ninetyDaysMs + 1_000)

      const dry = await repository.deleteEligibleExecutions(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: true,
      })
      expect(dry.eligible).toBe(1)
      expect(dry.deleted).toBe(0)

      const applied = await repository.deleteEligibleExecutions(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(applied.deleted).toBe(1)
      expect(applied.raced).toBe(0)
      expect(await repository.getExecution(executionId)).toBeUndefined()
      expect(await provider.transaction((t) => t.list('execution-attempts'))).toHaveLength(0)
    })
  }, 60000)

  test('the retention window is measured from the terminal instant', async () => {
    await withProvider(async (provider) => {
      await seedExecution(provider)
      const repository = new SqliteExecutionRepository(provider)
      const beforeDeadline = new Date(Date.parse(terminalAt) + ninetyDaysMs - 60_000)
      const atDeadline = new Date(Date.parse(terminalAt) + ninetyDaysMs)

      const early = await repository.deleteEligibleExecutions(beforeDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(early.deleted).toBe(0)
      expect(early.retainedByReason).toEqual({ not_expired: 1 })

      const boundary = await repository.deleteEligibleExecutions(atDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(boundary.deleted).toBe(0)
      expect(boundary.retainedByReason).toEqual({ not_expired: 1 })

      const past = await repository.deleteEligibleExecutions(new Date(atDeadline.getTime() + 1), {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(past.deleted).toBe(1)
    })
  }, 60000)

  test('every surviving reference retains the execution', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteExecutionRepository(provider)
      const now = new Date(Date.parse(terminalAt) + ninetyDaysMs + 1_000)

      // 1. acceptance record
      await seedExecution(provider)
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'command-by-execution',
          id: storedId(executionId),
          value: storedId('cmd-fixture'),
        })
      )
      const accepted = await repository.deleteEligibleExecutions(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(accepted.deleted).toBe(0)
      expect(accepted.retainedByReason).toEqual({ reference_pending: 1 })
      await provider.transaction((transaction) =>
        transaction.delete('command-by-execution', storedId(executionId))
      )

      // 2. an execution event
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'execution-events',
          id: 'r-evt-1',
          value: {
            eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            executionId,
            sequence: 1,
            type: 'execution.completed',
            schemaVersion: 1,
            correlation: {
              workspaceId,
              projectId,
              taskId,
              agentId,
              requestId,
              traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            },
            payload: {},
            payloadBytes: 2,
            payloadHash: 'a'.repeat(64),
            occurredAt: terminalAt,
            recordedAt: terminalAt,
            retentionExpiresAt: '2026-09-01T00:00:00.000Z',
            publication: { status: 'published', attempts: 1, version: 2 },
          },
        })
      )
      const withEvent = await repository.deleteEligibleExecutions(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(withEvent.retainedByReason).toEqual({ reference_pending: 1 })
      await provider.transaction((transaction) => transaction.delete('execution-events', 'r-evt-1'))

      // 3. a reconciliation checkpoint
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'reconciliation-checkpoints',
          id: storedId(executionId),
          value: {
            checkpointId: `rcp_${'a'.repeat(32)}`,
            executionId,
            commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            pendingEventCount: 0,
            observationHash: 'c'.repeat(64),
            reason: 'accepted_unstarted',
            action: 'none',
            state: 'resolved',
            diagnostics: [],
            version: 1,
            checkedAt: terminalAt,
            updatedAt: terminalAt,
          },
        })
      )
      const withCheckpoint = await repository.deleteEligibleExecutions(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(withCheckpoint.retainedByReason).toEqual({ reference_pending: 1 })
      await provider.transaction((transaction) =>
        transaction.delete('reconciliation-checkpoints', storedId(executionId))
      )

      // 4. a non-terminal attempt: it is the attempt's own lifecycle, not a
      // reference to remove, so nothing is deleted and the reason differs.
      await seedAttempt(provider, 'running')
      const withActiveAttempt = await repository.deleteEligibleExecutions(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(withActiveAttempt.deleted).toBe(0)
      expect(withActiveAttempt.retainedByReason).toEqual({ reference_pending: 1 })
      expect(
        await provider.transaction((transaction) => transaction.list('execution-attempts'))
      ).toHaveLength(1)
    })
  }, 60000)

  test('an unbounded policy retains executions and non-terminal ones are never candidates', async () => {
    await withProvider(async (provider) => {
      await seedExecution(provider)
      const repository = new SqliteExecutionRepository(provider)
      const now = new Date(Date.parse(terminalAt) + ninetyDaysMs + 1_000)

      const unbounded = await repository.deleteEligibleExecutions(now, {
        policyRetainMs: null,
        dryRun: false,
      })
      expect(unbounded.deleted).toBe(0)
      expect(unbounded.retainedByReason).toEqual({ unbounded_class: 1 })

      const applied = await repository.deleteEligibleExecutions(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(applied.deleted).toBe(1)

      // A running execution has no terminal instant, so it is not a
      // candidate at all.
      await seedExecution(provider, { state: 'running', terminalAt: undefined })
      const running = await repository.deleteEligibleExecutions(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(running.scanned).toBe(0)
      expect(await repository.getExecution(executionId)).toBeDefined()
    })
  }, 60000)
})
