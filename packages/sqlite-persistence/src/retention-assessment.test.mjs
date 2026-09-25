import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandInboxService } from '@control-plane/domain'
import {
  SqliteCommandAcceptanceRepository,
  SqliteExecutionEventRepository,
  SqlitePersistenceProvider,
} from './index.js'

const ids = {
  commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}

const receivedAt = '2026-08-24T10:00:00.000Z'
// Acceptance enforces the 30-day retention floor; this is exactly the floor,
// already past at the assessment instant.
const expiredAt = '2026-09-23T10:00:00.000Z'
const liveAt = '2099-01-01T00:00:00.000Z'
const assessedAt = new Date('2026-09-24T12:00:00.000Z')
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000

function commandInput(overrides = {}) {
  return {
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    commandId: ids.commandId,
    requestId: ids.requestId,
    idempotencyKey: 'retention-assessment-0001',
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      agentId: ids.agentId,
    },
    executionPlan: {
      executionPlanId: ids.executionPlanId,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schemaVersion: 1,
    },
    receivedAt,
    retentionExpiresAt: expiredAt,
    ...overrides,
  }
}

const scope = {
  callerPrincipalId: 'svc_agent-hq',
  operation: 'execution.accept',
  workspaceId: ids.workspaceId,
  projectId: ids.projectId,
  idempotencyKey: 'retention-assessment-0001',
}

async function accept(provider, overrides = {}) {
  const service = new CommandInboxService({
    repository: new SqliteCommandAcceptanceRepository(provider),
    executionIdFactory: () => ids.executionId,
    executionPlanValidator: { validate: async () => true },
    now: () => receivedAt,
  })
  return service.acceptExecution(commandInput(overrides))
}

// Terminal-state and reconciliation transitions belong to the lifecycle the
// retirement primitive already covers; this suite inspects the eligibility of
// a given stored state, so it patches the stored record directly.
async function patchStored(provider, namespace, state) {
  await provider.transaction(async (transaction) => {
    const [record] = await transaction.list(namespace)
    await transaction.put({
      namespace,
      id: record.id,
      value: { ...record.value, ...state },
      expectedRevision: record.revision,
    })
  })
}

async function seedRaw(provider, namespace, id, value) {
  await provider.transaction((transaction) => transaction.put({ namespace, id, value }))
}

function eventDraft(eventId, overrides = {}) {
  return {
    eventId,
    executionId: ids.executionId,
    sequence: 1,
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
    payload: { step: 'assessment' },
    occurredAt: receivedAt,
    recordedAt: receivedAt,
    retentionExpiresAt: expiredAt,
    ...overrides,
  }
}

async function seedExecution(provider) {
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

describe('SQLite retention assessment (#194)', () => {
  test('an expired active command is retained with its owner state as the reason', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-assess-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await accept(provider)
      const repository = new SqliteCommandAcceptanceRepository(provider)

      const assessment = await repository.assessExpiredInbox(assessedAt, {
        policyRetainMs: thirtyDaysMs,
      })
      expect(assessment.classId).toBe('command-inbox')
      expect(assessment.scanned).toBe(1)
      expect(assessment.eligible).toBe(0)
      expect(assessment.retainedByReason).toEqual({ non_terminal_owner: 1 })
      expect(assessment.truncated).toBe(false)

      // Read-only: the command is still resolvable by execution id.
      expect(await repository.getByExecutionId(ids.executionId)).toBeDefined()
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a terminal command is retained until its rejection key is reserved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-assess-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await accept(provider)
      await patchStored(provider, 'executions', { state: 'completed', terminalAt: expiredAt })
      await patchStored(provider, 'command-inbox', {
        status: 'completed',
        terminalAt: expiredAt,
        resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      })
      const repository = new SqliteCommandAcceptanceRepository(provider)

      const before = await repository.assessExpiredInbox(assessedAt, {
        policyRetainMs: thirtyDaysMs,
      })
      expect(before.retainedByReason).toEqual({ rejection_key_absent: 1 })
      expect(before.eligible).toBe(0)

      expect(await repository.retireExpiredCommand(scope, assessedAt.toISOString())).toBe(true)

      const after = await repository.assessExpiredInbox(assessedAt, {
        policyRetainMs: thirtyDaysMs,
      })
      expect(after.eligible).toBe(1)
      expect(after.retainedByReason).toEqual({})
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('an unresolved reconciliation retains an otherwise eligible command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-assess-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await accept(provider)
      await patchStored(provider, 'executions', { state: 'completed', terminalAt: expiredAt })
      await patchStored(provider, 'command-inbox', {
        status: 'completed',
        terminalAt: expiredAt,
        resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        reconciliationRequiredAt: expiredAt,
      })
      const repository = new SqliteCommandAcceptanceRepository(provider)
      expect(await repository.retireExpiredCommand(scope, assessedAt.toISOString())).toBe(true)

      const assessment = await repository.assessExpiredInbox(assessedAt, {
        policyRetainMs: thirtyDaysMs,
      })
      expect(assessment.retainedByReason).toEqual({ reference_pending: 1 })
      expect(assessment.eligible).toBe(0)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('live records are not candidates and an unbounded policy retains everything', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-assess-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await accept(provider, { retentionExpiresAt: liveAt })
      const repository = new SqliteCommandAcceptanceRepository(provider)

      const live = await repository.assessExpiredInbox(assessedAt, { policyRetainMs: thirtyDaysMs })
      expect(live.scanned).toBe(0)
      expect(live.eligible).toBe(0)

      const unbounded = await repository.assessExpiredInbox(new Date('2099-06-01T00:00:00.000Z'), {
        policyRetainMs: null,
      })
      expect(unbounded.scanned).toBe(1)
      expect(unbounded.retainedByReason).toEqual({ unbounded_class: 1 })
      expect(unbounded.eligible).toBe(0)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('events assess publication and owner state before age', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-assess-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await seedExecution(provider)
      const events = new SqliteExecutionEventRepository(provider)
      await events.append(eventDraft('evt_01ARZ3NDEKTSV4RRFFQ69G5FAV'))
      await events.append(eventDraft('evt_01ARZ3NDEKTSV4RRFFQ69G5FBW'))
      await events.append(eventDraft('evt_01ARZ3NDEKTSV4RRFFQ69G5FCX'))
      // Second and third events get distinct sequences.
      const all = await provider.transaction((transaction) => transaction.list('execution-events'))
      expect(all).toHaveLength(3)

      const pending = await events.assessExpiredEvents(assessedAt, {
        policyRetainMs: thirtyDaysMs,
      })
      expect(pending.classId).toBe('execution-events')
      expect(pending.scanned).toBe(3)
      expect(pending.eligible).toBe(0)
      expect(pending.retainedByReason).toEqual({ unsettled_publication: 3 })

      // Publish every event: publication settles, the owner is terminal, so
      // they become eligible.
      for (const record of all) {
        await provider.transaction(async (transaction) => {
          const current = await transaction.get('execution-events', record.id)
          await transaction.put({
            namespace: 'execution-events',
            id: record.id,
            value: {
              ...current.value,
              publication: { status: 'published', attempts: 1, version: 1, publishedAt: expiredAt },
            },
            expectedRevision: current.revision,
          })
        })
      }
      const settled = await events.assessExpiredEvents(assessedAt, {
        policyRetainMs: thirtyDaysMs,
      })
      expect(settled.eligible).toBe(3)
      expect(settled.retainedByReason).toEqual({})

      // Read-only: nothing was deleted.
      expect(await provider.transaction((t) => t.list('execution-events'))).toHaveLength(3)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('an event whose owner is still active is retained by owner state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-assess-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const events = new SqliteExecutionEventRepository(provider)
      await events.append(eventDraft('evt_01ARZ3NDEKTSV4RRFFQ69G5FDY'))
      const assessment = await events.assessExpiredEvents(assessedAt, {
        policyRetainMs: thirtyDaysMs,
      })
      // No execution record at all is not terminal, so the event stays.
      expect(assessment.retainedByReason).toEqual({ non_terminal_owner: 1 })
      expect(assessment.eligible).toBe(0)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('an unbounded events policy retains even settled candidates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-assess-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await seedExecution(provider)
      const events = new SqliteExecutionEventRepository(provider)
      await events.append(eventDraft('evt_01ARZ3NDEKTSV4RRFFQ69G5FEZ'))
      const assessment = await events.assessExpiredEvents(assessedAt, { policyRetainMs: null })
      expect(assessment.retainedByReason).toEqual({ unbounded_class: 1 })
      expect(assessment.eligible).toBe(0)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('the scan bound truncates instead of paging without limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-assess-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      // Seeded directly: this covers the bound, and a candidate without its
      // owner execution must be retained rather than crash the pass.
      await seedRaw(provider, 'command-inbox', 'expired-one', {
        callerPrincipalId: 'svc_agent-hq',
        operation: 'execution.accept',
        workspaceId: ids.workspaceId,
        projectId: ids.projectId,
        idempotencyKey: 'retention-assessment-0001',
        commandId: ids.commandId,
        requestId: ids.requestId,
        taskId: ids.taskId,
        agentId: ids.agentId,
        payloadHash: 'a'.repeat(64),
        status: 'accepted',
        executionId: ids.executionId,
        executionPlan: {
          executionPlanId: ids.executionPlanId,
          contentDigest: `sha256:${'b'.repeat(64)}`,
          schemaVersion: 1,
        },
        version: 1,
        conflictCount: 0,
        receivedAt,
        lastSeenAt: receivedAt,
        retentionExpiresAt: expiredAt,
      })
      await seedRaw(provider, 'command-inbox', 'expired-two', {
        callerPrincipalId: 'svc_agent-hq',
        operation: 'execution.accept',
        workspaceId: ids.workspaceId,
        projectId: ids.projectId,
        idempotencyKey: 'retention-assessment-0002',
        commandId: ids.commandId,
        requestId: ids.requestId,
        taskId: ids.taskId,
        agentId: ids.agentId,
        payloadHash: 'a'.repeat(64),
        status: 'accepted',
        executionId: ids.executionId,
        executionPlan: {
          executionPlanId: ids.executionPlanId,
          contentDigest: `sha256:${'b'.repeat(64)}`,
          schemaVersion: 1,
        },
        version: 1,
        conflictCount: 0,
        receivedAt,
        lastSeenAt: receivedAt,
        retentionExpiresAt: expiredAt,
      })
      const repository = new SqliteCommandAcceptanceRepository(provider)

      const bounded = await repository.assessExpiredInbox(assessedAt, {
        policyRetainMs: thirtyDaysMs,
        bound: 1,
      })
      expect(bounded.scanned).toBe(1)
      expect(bounded.truncated).toBe(true)

      const unbounded = await repository.assessExpiredInbox(assessedAt, {
        policyRetainMs: thirtyDaysMs,
        bound: 10,
      })
      expect(unbounded.scanned).toBe(2)
      expect(unbounded.truncated).toBe(false)
      expect(unbounded.retainedByReason).toEqual({ non_terminal_owner: 2 })
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
