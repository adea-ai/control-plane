import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlApiFixtures } from '@control-plane/contracts'
import { CommandInboxService, ExecutionAttemptSchema, ExecutionSchema } from '@control-plane/domain'
import {
  SqliteCommandAcceptanceRepository,
  SqliteExecutionCancellationRepository,
  SqliteExecutionRepository,
  SqliteInteractionRepository,
  SqlitePersistenceProvider,
  SqliteReceiptRetention,
  SqliteReconciliationEffects,
} from './index.js'

const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000
const acceptedAt = '2026-05-01T10:00:00.000Z'
const now = new Date(Date.parse(acceptedAt) + thirtyDaysMs + 1_000)
const receiptOwnerId = 'exe_01JABCDEF0123456789ABCDEFG'
const receiptInteractionId = 'int_01JABCDEF0123456789ABCDEFG'
const receiptAttemptId = 'att_01JABCDEF0123456789ABCDEFG'
const receiptScope = ControlApiFixtures.executionAcceptance.request

const storedId = (id) => `r-${createHash('sha256').update(id).digest('hex')}`

function interactionReceipt(overrides = {}) {
  return {
    request: {
      ...ControlApiFixtures.interactionResponse.request,
      idempotencyKey: 'interaction-receipt-fixture-1',
      payload: {
        ...ControlApiFixtures.interactionResponse.request.payload,
        executionId: receiptOwnerId,
        attemptId: receiptAttemptId,
        interactionId: receiptInteractionId,
      },
    },
    acceptedAt,
    ...overrides,
  }
}

function cancellationReceipt(overrides = {}) {
  return {
    request: {
      ...ControlApiFixtures.executionCancellation.request,
      idempotencyKey: 'cancellation-receipt-fixture-1',
      payload: { executionId: receiptOwnerId },
    },
    acceptedAt,
    ...overrides,
  }
}

async function seedTerminalReceiptOwner(provider, terminalAt = '2026-04-30T10:00:00.000Z') {
  const accepted = '2026-01-01T10:00:00.000Z'
  const execution = ExecutionSchema.parse({
    executionId: receiptOwnerId,
    state: 'failed',
    version: 2,
    correlation: {
      workspaceId: receiptScope.workspaceId,
      projectId: receiptScope.projectId,
      taskId: receiptScope.payload.taskId,
      agentId: receiptScope.payload.agentId,
      requestId: receiptScope.requestId,
    },
    executionPlan: receiptScope.payload.executionPlan,
    attemptCount: 1,
    latestAttemptId: receiptAttemptId,
    acceptedAt: accepted,
    terminalAt,
    createdAt: accepted,
    updatedAt: terminalAt,
    failure: { classification: 'unknown', code: 'RETENTION_FIXTURE_TERMINAL' },
  })
  await seed(provider, 'executions', storedId(receiptOwnerId), execution)
  await seed(
    provider,
    'execution-attempts',
    storedId(receiptAttemptId),
    ExecutionAttemptSchema.parse({
      attemptId: receiptAttemptId,
      executionId: receiptOwnerId,
      sequence: 1,
      state: 'failed',
      version: 2,
      acceptedAt: accepted,
      queuedAt: accepted,
      terminalAt,
      createdAt: accepted,
      updatedAt: terminalAt,
      failure: { classification: 'runtime_error', code: 'RETENTION_FIXTURE_ATTEMPT' },
    })
  )
  await new SqliteInteractionRepository(provider).insert({
    interactionId: receiptInteractionId,
    executionId: receiptOwnerId,
    attemptId: receiptAttemptId,
    kind: 'approval',
    prompt: { title: 'Approve the operation' },
    allowedActions: ['approve', 'deny'],
    allowedPrincipalIds: ['svc_agent-hq'],
    state: 'responded',
    version: 2,
    requestedAt: '2026-04-29T10:00:00.000Z',
    expiresAt: '2026-04-30T10:00:00.000Z',
    response: {
      responseId: 'cmd_01JABCDEF0123456789ABCDEFG',
      action: 'approve',
      respondingPrincipalId: 'svc_agent-hq',
      respondedAt: acceptedAt,
    },
  })
}

async function seed(provider, namespace, id, value) {
  await provider.transaction((transaction) => transaction.put({ namespace, id, value }))
}

async function withProvider(run) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-receipt-retention-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    return await run(provider)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('SQLite interaction-receipt retention deletion (#194)', () => {
  test('an old accepted cancellation remains a resume guard while its execution is active', async () => {
    await withProvider(async (provider) => {
      const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
      const acceptRequest = ControlApiFixtures.executionAcceptance.request
      const commands = new SqliteCommandAcceptanceRepository(provider)
      const executions = new SqliteExecutionRepository(provider)
      const accepted = await new CommandInboxService({
        repository: commands,
        executionIdFactory: () => executionId,
        executionPlanValidator: { validate: async () => true },
        now: () => '2026-05-02T10:00:00.000Z',
      }).acceptExecution({
        callerPrincipalId: acceptRequest.caller.servicePrincipalId,
        operation: acceptRequest.operation,
        commandId: acceptRequest.commandId,
        requestId: acceptRequest.requestId,
        idempotencyKey: 'retention-resume-guard-active',
        payloadHash: acceptRequest.payloadHash,
        correlation: {
          workspaceId: acceptRequest.workspaceId,
          projectId: acceptRequest.projectId,
          taskId: acceptRequest.payload.taskId,
          agentId: acceptRequest.payload.agentId,
        },
        executionPlan: acceptRequest.payload.executionPlan,
        receivedAt: '2026-05-02T10:00:00.000Z',
        retentionExpiresAt: '2026-06-01T10:00:00.000Z',
      })
      const cancellationRequest = {
        ...ControlApiFixtures.executionCancellation.request,
        idempotencyKey: 'retention-cancel-active-execution-1',
        payload: { executionId },
      }
      await seed(provider, 'execution-cancellation-receipts', 'r-active-cancellation', {
        request: cancellationRequest,
        acceptedAt,
      })

      const result = await new SqliteReceiptRetention(provider).sweepEligibleInteractionReceipts(
        now,
        { policyRetainMs: thirtyDaysMs, dryRun: false }
      )

      expect(result).toMatchObject({ deleted: 0, retainedByReason: { non_terminal_owner: 1 } })
      expect(
        await provider.transaction((transaction) =>
          transaction.get('execution-cancellation-receipts', 'r-active-cancellation')
        )
      ).toBeDefined()

      const submissions = []
      await new SqliteReconciliationEffects({
        executions,
        commands,
        events: { rearmPendingDelivery: async () => 0 },
        workflowSubmitter: { submit: async (input) => submissions.push(input) },
        cancellations: new SqliteExecutionCancellationRepository(provider),
        now: () => '2026-06-02T10:00:00.000Z',
      }).resumeWorkflow({ executionId, checkpointId: `rcp_${'a'.repeat(32)}` })
      expect(submissions).toEqual([])
      expect(accepted.command.status).toBe('accepted')
    })
  }, 60000)

  test('confirmed receipts past the window are deleted from both namespaces', async () => {
    await withProvider(async (provider) => {
      await seedTerminalReceiptOwner(provider)
      await seed(provider, 'interaction-command-receipts', 'r-interaction', interactionReceipt())
      await seed(
        provider,
        'execution-cancellation-receipts',
        'r-cancellation',
        cancellationReceipt()
      )
      const retention = new SqliteReceiptRetention(provider)

      const dry = await retention.sweepEligibleInteractionReceipts(now, {
        policyRetainMs: thirtyDaysMs,
        dryRun: true,
      })
      expect(dry.eligible).toBe(2)
      expect(dry.deleted).toBe(0)

      const applied = await retention.sweepEligibleInteractionReceipts(now, {
        policyRetainMs: thirtyDaysMs,
        dryRun: false,
      })
      expect(applied.deleted).toBe(2)
      expect(
        await provider.transaction((t) => t.list('interaction-command-receipts'))
      ).toHaveLength(0)
      expect(
        await provider.transaction((t) => t.list('execution-cancellation-receipts'))
      ).toHaveLength(0)
    })
  }, 60000)

  test('bound one limits deletions and journals across both receipt namespaces', async () => {
    await withProvider(async (provider) => {
      await seedTerminalReceiptOwner(provider)
      await seed(provider, 'interaction-command-receipts', 'a-interaction', interactionReceipt())
      await seed(
        provider,
        'execution-cancellation-receipts',
        'b-cancellation',
        cancellationReceipt()
      )
      const journal = []
      const result = await new SqliteReceiptRetention(provider).sweepEligibleInteractionReceipts(
        now,
        {
          policyRetainMs: thirtyDaysMs,
          bound: 1,
          dryRun: false,
          journal: async (operations) => journal.push(...operations),
        }
      )

      expect(result).toMatchObject({ scanned: 1, eligible: 1, deleted: 1, truncated: true })
      expect(journal).toHaveLength(1)
      expect(
        (await provider.transaction((t) => t.list('interaction-command-receipts'))).length +
          (await provider.transaction((t) => t.list('execution-cancellation-receipts'))).length
      ).toBe(1)
    })
  }, 60000)

  test('a retained first namespace candidate consumes the shared bound before journaling', async () => {
    await withProvider(async (provider) => {
      await seedTerminalReceiptOwner(provider)
      await seed(
        provider,
        'interaction-command-receipts',
        'a-unconfirmed-interaction',
        interactionReceipt({ acceptedAt: undefined })
      )
      await seed(
        provider,
        'execution-cancellation-receipts',
        'b-cancellation',
        cancellationReceipt()
      )
      const journal = []
      const result = await new SqliteReceiptRetention(provider).sweepEligibleInteractionReceipts(
        now,
        {
          policyRetainMs: thirtyDaysMs,
          bound: 1,
          dryRun: false,
          journal: async (operations) => journal.push(...operations),
        }
      )

      expect(result).toMatchObject({
        scanned: 1,
        eligible: 0,
        deleted: 0,
        truncated: true,
        retainedByReason: { unconfirmed_signal: 1 },
      })
      expect(journal).toHaveLength(0)
      expect(
        await provider.transaction((t) => t.list('interaction-command-receipts'))
      ).toHaveLength(1)
      expect(
        await provider.transaction((t) => t.list('execution-cancellation-receipts'))
      ).toHaveLength(1)
    })
  }, 60000)

  test('zero bound reports truncation without journaling or deleting', async () => {
    await withProvider(async (provider) => {
      await seed(provider, 'interaction-command-receipts', 'a-interaction', interactionReceipt())
      const journal = []
      const result = await new SqliteReceiptRetention(provider).sweepEligibleInteractionReceipts(
        now,
        {
          policyRetainMs: thirtyDaysMs,
          bound: 0,
          dryRun: false,
          journal: async (operations) => journal.push(...operations),
        }
      )

      expect(result).toMatchObject({ scanned: 0, eligible: 0, deleted: 0, truncated: true })
      expect(journal).toHaveLength(0)
      expect(
        await provider.transaction((t) => t.list('interaction-command-receipts'))
      ).toHaveLength(1)
    })
  }, 60000)

  test('an unconfirmed receipt is the lost-ack identity and is never a candidate', async () => {
    await withProvider(async (provider) => {
      await seed(
        provider,
        'interaction-command-receipts',
        'r-unconfirmed',
        interactionReceipt({ acceptedAt: undefined })
      )
      const retention = new SqliteReceiptRetention(provider)

      const applied = await retention.sweepEligibleInteractionReceipts(now, {
        policyRetainMs: thirtyDaysMs,
        dryRun: false,
      })
      expect(applied.deleted).toBe(0)
      expect(applied.retainedByReason).toEqual({ unconfirmed_signal: 1 })
      expect(
        await provider.transaction((t) => t.list('interaction-command-receipts'))
      ).toHaveLength(1)
    })
  }, 60000)

  test('a receipt lookup whose interaction row contains another JSON id is retained', async () => {
    await withProvider(async (provider) => {
      await seedTerminalReceiptOwner(provider)
      const interactions = new SqliteInteractionRepository(provider)
      const storedInteraction = await interactions.get(receiptInteractionId)
      await provider.transaction(async (transaction) => {
        const id = storedId(receiptInteractionId)
        const record = await transaction.get('interaction-requests', id)
        await transaction.put({
          namespace: 'interaction-requests',
          id,
          expectedRevision: record.revision,
          value: { ...storedInteraction, interactionId: 'int_01JABCDEF0123456789ABCDEFH' },
        })
      })
      await seed(
        provider,
        'interaction-command-receipts',
        'r-json-id-mismatch',
        interactionReceipt()
      )

      const result = await new SqliteReceiptRetention(provider).sweepEligibleInteractionReceipts(
        now,
        { policyRetainMs: thirtyDaysMs, dryRun: false }
      )

      expect(result).toMatchObject({ deleted: 0, retainedByReason: { non_terminal_owner: 1 } })
      expect(
        await provider.transaction((transaction) =>
          transaction.get('interaction-command-receipts', 'r-json-id-mismatch')
        )
      ).toBeDefined()
    })
  }, 60000)

  test('an interaction receipt attempt from another execution is not a settled owner attempt', async () => {
    await withProvider(async (provider) => {
      await seedTerminalReceiptOwner(provider)
      const otherExecutionId = 'exe_01JABCDEF0123456789ABCDEFH'
      const otherAttemptId = 'att_01JABCDEF0123456789ABCDEFH'
      const otherInteractionId = 'int_01JABCDEF0123456789ABCDEFH'
      const execution = ExecutionSchema.parse({
        executionId: otherExecutionId,
        state: 'queued',
        version: 2,
        correlation: {
          workspaceId: receiptScope.workspaceId,
          projectId: receiptScope.projectId,
          taskId: receiptScope.payload.taskId,
          agentId: receiptScope.payload.agentId,
          requestId: receiptScope.requestId,
        },
        executionPlan: receiptScope.payload.executionPlan,
        attemptCount: 1,
        latestAttemptId: otherAttemptId,
        acceptedAt: '2026-01-01T10:00:00.000Z',
        queuedAt: '2026-01-02T10:00:00.000Z',
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-02T10:00:00.000Z',
      })
      await seed(provider, 'executions', storedId(otherExecutionId), execution)
      await seed(
        provider,
        'execution-attempts',
        storedId(otherAttemptId),
        ExecutionAttemptSchema.parse({
          attemptId: otherAttemptId,
          executionId: otherExecutionId,
          sequence: 1,
          state: 'queued',
          version: 1,
          acceptedAt: '2026-01-01T10:00:00.000Z',
          queuedAt: '2026-01-02T10:00:00.000Z',
          createdAt: '2026-01-01T10:00:00.000Z',
          updatedAt: '2026-01-02T10:00:00.000Z',
        })
      )
      await new SqliteInteractionRepository(provider).insert({
        interactionId: otherInteractionId,
        executionId: receiptOwnerId,
        attemptId: otherAttemptId,
        kind: 'approval',
        prompt: { title: 'Approve the cross-owner action' },
        allowedActions: ['approve', 'deny'],
        allowedPrincipalIds: ['svc_agent-hq'],
        state: 'responded',
        version: 2,
        requestedAt: '2026-04-29T10:00:00.000Z',
        expiresAt: '2026-04-30T10:00:00.000Z',
        response: {
          responseId: 'cmd_01JABCDEF0123456789ABCDEFH',
          action: 'approve',
          respondingPrincipalId: 'svc_agent-hq',
          respondedAt: acceptedAt,
        },
      })
      const crossOwnerReceipt = interactionReceipt()
      crossOwnerReceipt.request.payload.attemptId = otherAttemptId
      crossOwnerReceipt.request.payload.interactionId = otherInteractionId
      await seed(
        provider,
        'interaction-command-receipts',
        'r-cross-owner-attempt',
        crossOwnerReceipt
      )

      const result = await new SqliteReceiptRetention(provider).sweepEligibleInteractionReceipts(
        now,
        { policyRetainMs: thirtyDaysMs, dryRun: false }
      )

      expect(result).toMatchObject({ deleted: 0, retainedByReason: { unsettled_publication: 1 } })
      expect(
        await provider.transaction((transaction) =>
          transaction.get('interaction-command-receipts', 'r-cross-owner-attempt')
        )
      ).toBeDefined()
    })
  }, 60000)

  test('the window runs from the acceptance instant', async () => {
    await withProvider(async (provider) => {
      await seedTerminalReceiptOwner(provider)
      await seed(provider, 'interaction-command-receipts', 'r-window', interactionReceipt())
      const retention = new SqliteReceiptRetention(provider)

      const inside = new Date(Date.parse(acceptedAt) + thirtyDaysMs - 1_000)
      expect(
        (
          await retention.sweepEligibleInteractionReceipts(inside, {
            policyRetainMs: thirtyDaysMs,
            dryRun: false,
          })
        ).retainedByReason
      ).toEqual({ not_expired: 1 })

      const boundary = await retention.sweepEligibleInteractionReceipts(
        new Date(Date.parse(acceptedAt) + thirtyDaysMs),
        { policyRetainMs: thirtyDaysMs, dryRun: false }
      )
      expect(boundary.deleted).toBe(0)

      const past = await retention.sweepEligibleInteractionReceipts(
        new Date(Date.parse(acceptedAt) + thirtyDaysMs + 1),
        { policyRetainMs: thirtyDaysMs, dryRun: false }
      )
      expect(past.deleted).toBe(1)
    })
  }, 60000)

  test('terminal settlement after acceptance restarts the replay window', async () => {
    await withProvider(async (provider) => {
      await seedTerminalReceiptOwner(provider)
      const checkpointSettlementAt = '2026-05-20T10:00:00.000Z'
      await seed(provider, 'reconciliation-checkpoints', storedId('d'.repeat(64)), {
        checkpointId: `rcp_${'d'.repeat(32)}`,
        executionId: receiptOwnerId,
        commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
        pendingEventCount: 0,
        observationHash: 'd'.repeat(64),
        reason: 'accepted_unstarted',
        action: 'none',
        state: 'resolved',
        diagnostics: [],
        version: 2,
        checkedAt: checkpointSettlementAt,
        updatedAt: checkpointSettlementAt,
        resolvedAt: checkpointSettlementAt,
      })
      await seed(
        provider,
        'interaction-command-receipts',
        'r-late-settlement',
        interactionReceipt()
      )
      const retention = new SqliteReceiptRetention(provider)

      const beforeDeadline = await retention.sweepEligibleInteractionReceipts(now, {
        policyRetainMs: thirtyDaysMs,
        dryRun: false,
      })
      expect(beforeDeadline).toMatchObject({ deleted: 0, retainedByReason: { not_expired: 1 } })
      const afterDeadline = await retention.sweepEligibleInteractionReceipts(
        new Date(Date.parse(checkpointSettlementAt) + thirtyDaysMs + 1),
        { policyRetainMs: thirtyDaysMs, dryRun: false }
      )
      expect(afterDeadline.deleted).toBe(1)
    })
  }, 60000)

  test('a recent terminal execution keeps an old confirmed receipt', async () => {
    await withProvider(async (provider) => {
      await seedTerminalReceiptOwner(provider, '2026-05-30T10:00:00.000Z')
      await seed(
        provider,
        'execution-cancellation-receipts',
        'r-recent-terminal',
        cancellationReceipt()
      )
      const result = await new SqliteReceiptRetention(provider).sweepEligibleInteractionReceipts(
        now,
        { policyRetainMs: thirtyDaysMs, dryRun: false }
      )
      expect(result).toMatchObject({ deleted: 0, retainedByReason: { not_expired: 1 } })
      expect(
        await provider.transaction((transaction) =>
          transaction.get('execution-cancellation-receipts', 'r-recent-terminal')
        )
      ).toBeDefined()
    })
  }, 60000)

  test('missing owners and receipt/owner scope mismatches fail closed', async () => {
    await withProvider(async (provider) => {
      await seedTerminalReceiptOwner(provider)
      const baseline = cancellationReceipt()
      const missingOwner = {
        ...baseline,
        request: {
          ...baseline.request,
          payload: { executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        },
      }
      const scopeMismatch = {
        ...baseline,
        request: { ...baseline.request, workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' },
      }
      await seed(provider, 'execution-cancellation-receipts', 'r-missing-owner', missingOwner)
      await seed(provider, 'execution-cancellation-receipts', 'r-scope-mismatch', scopeMismatch)

      const result = await new SqliteReceiptRetention(provider).sweepEligibleInteractionReceipts(
        now,
        { policyRetainMs: thirtyDaysMs, dryRun: false }
      )
      expect(result).toMatchObject({
        deleted: 0,
        retainedByReason: { non_terminal_owner: 2 },
      })
      expect(
        await provider.transaction((transaction) =>
          transaction.list('execution-cancellation-receipts')
        )
      ).toHaveLength(2)
    })
  }, 60000)

  test('an unbounded policy retains confirmed receipts', async () => {
    await withProvider(async (provider) => {
      await seed(
        provider,
        'execution-cancellation-receipts',
        'r-cancellation',
        cancellationReceipt()
      )
      const retention = new SqliteReceiptRetention(provider)
      const applied = await retention.sweepEligibleInteractionReceipts(now, {
        policyRetainMs: null,
        dryRun: false,
      })
      expect(applied.deleted).toBe(0)
      expect(applied.retainedByReason).toEqual({ unbounded_class: 1 })
    })
  }, 60000)
})
