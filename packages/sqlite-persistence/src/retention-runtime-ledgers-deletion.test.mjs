import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
  SqliteRuntimeCommandRepository,
} from './index.js'

const ninetyDaysMs = 90 * 24 * 60 * 60 * 1_000
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000
const issuedAt = '2026-05-01T10:00:00.000Z'
const settledAt = '2026-05-02T10:00:00.000Z'
const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'

function storedId(value) {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

function commandRecord(commandId, overrides = {}) {
  return {
    commandId,
    executionId,
    attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    idempotencyKey: 'runtime-command-fixture-0001',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    commandEnvelope: { operation: 'runtime.cancel' },
    issuedAt,
    expiresAt: '2026-05-03T10:00:00.000Z',
    status: 'succeeded',
    version: 1,
    deliveryAttempts: 1,
    // Delivered commands must carry complete dispatch and acknowledgement
    // metadata; the schema rejects partial sets.
    lastChannelGeneration: 1,
    lastSequence: 1,
    firstDispatchedAt: settledAt,
    lastDispatchedAt: settledAt,
    acknowledgementReference: 'ack-runtime-fixture-0001',
    acknowledgementDisposition: 'accepted',
    acknowledgedAt: settledAt,
    resultStatus: 'succeeded',
    resultRecordedAt: settledAt,
    createdAt: issuedAt,
    updatedAt: settledAt,
    ...overrides,
  }
}

async function seedCommand(provider, commandId, overrides = {}) {
  await provider.transaction((transaction) =>
    transaction.put({
      namespace: 'runtime-commands',
      id: storedId(commandId),
      value: commandRecord(commandId, overrides),
    })
  )
}

async function seedReceipt(provider, commandId, sequence = 1) {
  await provider.transaction((transaction) =>
    transaction.put({
      namespace: 'runtime-event-receipts',
      id: storedId(`progress:${commandId}:${sequence}`),
      value: {
        commandId,
        messageKind: 'progress',
        messageSequence: sequence,
        frameHash: `s2:${'b'.repeat(64)}`,
        outcome: 'applied',
      },
    })
  )
}

async function seedExecution(provider) {
  await provider.transaction((transaction) =>
    transaction.put({
      namespace: 'executions',
      id: storedId(executionId),
      value: {
        executionId,
        state: 'completed',
        version: 2,
        correlation: {
          workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        },
        executionPlan: {
          executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          contentDigest: `sha256:${'c'.repeat(64)}`,
          schemaVersion: 1,
        },
        attemptCount: 0,
        acceptedAt: '2026-04-01T10:00:00.000Z',
        terminalAt: '2026-04-02T10:00:00.000Z',
        createdAt: '2026-04-01T10:00:00.000Z',
        updatedAt: '2026-04-02T10:00:00.000Z',
      },
    })
  )
}

async function withProvider(run) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-runtime-retention-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    return await run(provider)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('SQLite runtime-ledger retention deletion (#194)', () => {
  test('a settled command is deleted with its receipts', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteRuntimeCommandRepository(provider)
      const commandId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV'
      await seedCommand(provider, commandId)
      await seedReceipt(provider, commandId, 1)
      await seedReceipt(provider, commandId, 2)
      const now = new Date(Date.parse(settledAt) + thirtyDaysMs + 1_000)

      const dry = await repository.deleteEligibleRuntimeCommands(now, {
        policyRetainMs: thirtyDaysMs,
        dryRun: true,
      })
      expect(dry.eligible).toBe(1)
      expect(dry.deleted).toBe(0)

      const applied = await repository.deleteEligibleRuntimeCommands(now, {
        policyRetainMs: thirtyDaysMs,
        dryRun: false,
      })
      expect(applied.deleted).toBe(1)
      expect(await provider.transaction((t) => t.list('runtime-commands'))).toHaveLength(0)
      expect(await provider.transaction((t) => t.list('runtime-event-receipts'))).toHaveLength(0)
    })
  }, 60000)

  test('expired and unresolved commands are reconciliation work, never candidates', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteRuntimeCommandRepository(provider)
      const expired = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FBW'
      const acknowledged = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FCX'
      // Expired without a result, and acknowledged but without a result.
      await seedCommand(provider, expired, {
        status: 'expired',
        deliveryAttempts: 0,
        lastChannelGeneration: undefined,
        lastSequence: undefined,
        firstDispatchedAt: undefined,
        lastDispatchedAt: undefined,
        acknowledgementReference: undefined,
        acknowledgementDisposition: undefined,
        acknowledgedAt: undefined,
        resultStatus: undefined,
        resultRecordedAt: undefined,
      })
      await seedCommand(provider, acknowledged, {
        status: 'acknowledged',
        resultStatus: undefined,
        resultRecordedAt: undefined,
      })
      const now = new Date(Date.parse(settledAt) + thirtyDaysMs + 1_000)

      const applied = await repository.deleteEligibleRuntimeCommands(now, {
        policyRetainMs: thirtyDaysMs,
        dryRun: false,
      })
      expect(applied.deleted).toBe(0)
      expect(applied.scanned).toBe(0)
      expect(await provider.transaction((t) => t.list('runtime-commands'))).toHaveLength(2)
    })
  }, 60000)

  test('the window runs from the recorded result', async () => {
    await withProvider(async (provider) => {
      const repository = new SqliteRuntimeCommandRepository(provider)
      const commandId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FDY'
      await seedCommand(provider, commandId)

      const inside = new Date(Date.parse(settledAt) + thirtyDaysMs - 1_000)
      const early = await repository.deleteEligibleRuntimeCommands(inside, {
        policyRetainMs: thirtyDaysMs,
        dryRun: false,
      })
      expect(early.deleted).toBe(0)
      expect(early.retainedByReason).toEqual({ not_expired: 1 })

      const boundary = await repository.deleteEligibleRuntimeCommands(
        new Date(Date.parse(settledAt) + thirtyDaysMs),
        { policyRetainMs: thirtyDaysMs, dryRun: false }
      )
      expect(boundary.deleted).toBe(0)

      const past = await repository.deleteEligibleRuntimeCommands(
        new Date(Date.parse(settledAt) + thirtyDaysMs + 1),
        { policyRetainMs: thirtyDaysMs, dryRun: false }
      )
      expect(past.deleted).toBe(1)
    })
  }, 60000)

  test('an execution with runtime commands is retained, and freed once they go', async () => {
    await withProvider(async (provider) => {
      await seedExecution(provider)
      const commandId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FEZ'
      await seedCommand(provider, commandId)
      const executions = new SqliteExecutionRepository(provider)
      const runtimeCommands = new SqliteRuntimeCommandRepository(provider)
      // Past both windows: the command's 30-day and the execution's 90-day.
      const now = new Date('2026-08-01T10:00:00.000Z')

      // The command outlives the execution's own window, so the execution is
      // retained: its runtime ledger is deleted by its own class first.
      const retained = await executions.deleteEligibleExecutions(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(retained.deleted).toBe(0)
      expect(retained.retainedByReason).toEqual({ reference_pending: 1 })
      expect(await executions.getExecution(executionId)).toBeDefined()

      expect(
        (
          await runtimeCommands.deleteEligibleRuntimeCommands(now, {
            policyRetainMs: thirtyDaysMs,
            dryRun: false,
          })
        ).deleted
      ).toBe(1)

      const freed = await executions.deleteEligibleExecutions(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(freed.deleted).toBe(1)
      expect(await executions.getExecution(executionId)).toBeUndefined()
    })
  }, 60000)
})
