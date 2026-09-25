import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteExecutionEventRepository, SqlitePersistenceProvider } from './index.js'

const ids = {
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}
const receivedAt = '2026-08-24T10:00:00.000Z'
const expiredAt = '2026-09-01T10:00:00.000Z'
const assessedAt = new Date('2026-09-24T12:00:00.000Z')
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000

function eventDraft(eventId, overrides = {}) {
  return {
    eventId,
    executionId: ids.executionId,
    type: 'execution.progress',
    schemaVersion: 1,
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      agentId: ids.agentId,
      requestId: ids.requestId,
      traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    },
    payload: { step: 'retention' },
    occurredAt: receivedAt,
    recordedAt: receivedAt,
    retentionExpiresAt: expiredAt,
    ...overrides,
  }
}

async function seedTerminalExecution(provider) {
  await provider.transaction((transaction) =>
    transaction.put({
      namespace: 'executions',
      id: `r-${createHash('sha256').update(ids.executionId).digest('hex')}`,
      value: {
        executionId: ids.executionId,
        state: 'completed',
        version: 1,
        correlation: {
          workspaceId: ids.workspaceId,
          projectId: ids.projectId,
          taskId: ids.taskId,
          agentId: ids.agentId,
          requestId: ids.requestId,
        },
        executionPlan: {
          executionPlanId: ids.executionPlanId,
          contentDigest: `sha256:${'b'.repeat(64)}`,
          schemaVersion: 1,
        },
        attemptCount: 0,
        acceptedAt: receivedAt,
        terminalAt: expiredAt,
        createdAt: receivedAt,
        updatedAt: expiredAt,
      },
    })
  )
}

async function publish(provider, eventId) {
  await provider.transaction(async (transaction) => {
    const record = await transaction.get(
      'execution-events',
      `r-${createHash('sha256').update(eventId).digest('hex')}`
    )
    if (record === undefined) throw new Error(`missing event ${eventId}`)
    await transaction.put({
      namespace: 'execution-events',
      id: record.id,
      value: {
        ...record.value,
        publication: { status: 'published', attempts: 1, version: 1, publishedAt: expiredAt },
      },
      expectedRevision: record.revision,
    })
  })
}

describe('SQLite execution-event retention deletion (#194)', () => {
  test('deletion preserves the deduplication identity and never reuses a sequence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-event-retention-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await seedTerminalExecution(provider)
      const events = new SqliteExecutionEventRepository(provider)
      const first = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV'
      const second = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FBW'
      expect((await events.append(eventDraft(first)))?.sequence).toBe(1)
      expect((await events.append(eventDraft(second)))?.sequence).toBe(2)
      await publish(provider, first)
      await publish(provider, second)

      // Dry run: both eligible, nothing removed.
      const dry = await events.deleteEligibleEvents(assessedAt, {
        policyRetainMs: thirtyDaysMs,
        dryRun: true,
      })
      expect(dry.dryRun).toBe(true)
      expect(dry.eligible).toBe(2)
      expect(dry.deleted).toBe(0)
      expect(await events.get(first)).toBeDefined()

      const applied = await events.deleteEligibleEvents(assessedAt, {
        policyRetainMs: thirtyDaysMs,
        dryRun: false,
      })
      expect(applied.deleted).toBe(2)
      expect(applied.raced).toBe(0)
      expect(await events.get(first)).toBeUndefined()
      expect(await events.get(second)).toBeUndefined()
      expect(await provider.transaction((t) => t.list('retired-execution-event-ids'))).toHaveLength(
        2
      )

      // A retry of a retired event id must not resurrect the event.
      expect(await events.append(eventDraft(first))).toBeUndefined()
      expect(await events.get(first)).toBeUndefined()

      // The next appended event continues above the historical maximum.
      const third = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FCX'
      const appended = await events.append(eventDraft(third))
      expect(appended?.sequence).toBe(3)

      // Nothing left for a second pass over the deleted rows.
      const again = await events.deleteEligibleEvents(assessedAt, {
        policyRetainMs: thirtyDaysMs,
        dryRun: false,
      })
      expect(again.deleted).toBe(0)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)

  test('pending publication and live owners are never deleted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-event-retention-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await seedTerminalExecution(provider)
      const events = new SqliteExecutionEventRepository(provider)
      const pending = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FDY'
      await events.append(eventDraft(pending))

      const assessment = await events.deleteEligibleEvents(assessedAt, {
        policyRetainMs: thirtyDaysMs,
        dryRun: false,
      })
      expect(assessment.deleted).toBe(0)
      expect(assessment.retainedByReason).toEqual({ unsettled_publication: 1 })
      expect(await events.get(pending)).toBeDefined()

      // Publish it but make the owner non-terminal: still retained.
      await publish(provider, pending)
      await provider.transaction(async (transaction) => {
        const record = await transaction.get(
          'executions',
          `r-${createHash('sha256').update(ids.executionId).digest('hex')}`
        )
        await transaction.put({
          namespace: 'executions',
          id: record.id,
          value: { ...record.value, state: 'running', terminalAt: undefined },
          expectedRevision: record.revision,
        })
      })
      const running = await events.deleteEligibleEvents(assessedAt, {
        policyRetainMs: thirtyDaysMs,
        dryRun: false,
      })
      expect(running.deleted).toBe(0)
      expect(running.retainedByReason).toEqual({ non_terminal_owner: 1 })
      expect(await events.get(pending)).toBeDefined()
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)

  test('an unbounded policy retains even settled candidates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-event-retention-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await seedTerminalExecution(provider)
      const events = new SqliteExecutionEventRepository(provider)
      const eventId = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FEZ'
      await events.append(eventDraft(eventId))
      await publish(provider, eventId)

      const applied = await events.deleteEligibleEvents(assessedAt, {
        policyRetainMs: null,
        dryRun: false,
      })
      expect(applied.deleted).toBe(0)
      expect(applied.retainedByReason).toEqual({ unbounded_class: 1 })
      expect(await events.get(eventId)).toBeDefined()
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)
})
