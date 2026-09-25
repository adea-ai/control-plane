import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider, SqliteReceiptRetention } from './index.js'

const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000
const acceptedAt = '2026-05-01T10:00:00.000Z'
const now = new Date(Date.parse(acceptedAt) + thirtyDaysMs + 1_000)

function interactionReceipt(overrides = {}) {
  return {
    request: {
      caller: { servicePrincipalId: 'svc_agent-hq' },
      workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      operation: 'interaction.respond',
      idempotencyKey: 'interaction-receipt-fixture-1',
      interactionId: 'itx_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      responseId: 'irp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      payloadHash: `sha256:${'a'.repeat(64)}`,
    },
    acceptedAt,
    ...overrides,
  }
}

function cancellationReceipt(overrides = {}) {
  return {
    request: {
      caller: { servicePrincipalId: 'svc_agent-hq' },
      workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      operation: 'execution.cancel',
      idempotencyKey: 'cancellation-receipt-fixture-1',
      executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      payloadHash: `sha256:${'b'.repeat(64)}`,
    },
    acceptedAt,
    ...overrides,
  }
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
  test('confirmed receipts past the window are deleted from both namespaces', async () => {
    await withProvider(async (provider) => {
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

  test('the window runs from the acceptance instant', async () => {
    await withProvider(async (provider) => {
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
