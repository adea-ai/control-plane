import { expect, test } from 'bun:test'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import {
  DurableChildRuntimeBudgetAdmission,
  RuntimeBudgetAdmissionError,
} from '@control-plane/workflow-worker'
import {
  acceptedAt,
  fixture,
  ids,
} from '../packages/sqlite-persistence/src/child-allocation-fixture.mjs'

// The delegated child's runtime attempt is reserved by the production
// DurableChildRuntimeBudgetAdmission (the bridge's reserveBudget seam) over the budget the real
// transactional SQLite allocator opened, funded and clamped from a real parent. Only the lead's own
// attempt reservation is written directly: the lead has no accepted command in this fixture, and
// root admission is covered by workflow-worker's own suite.
const allowance = { maximumMicrounits: 4_000_000, maximumTokens: 100_000 }
const parentAttemptKey = `runtime-attempt:${ids.parentAttemptId}`

async function runningLead(f) {
  const ledger = new DurableUsageLedger({ store: f.usageStore, now: () => acceptedAt })
  // The lead's attempt reserves everything except the child allowance its plan states.
  await ledger.reserve({
    workspaceId: ids.workspaceId,
    executionId: ids.parentExecutionId,
    attemptId: ids.parentAttemptId,
    reservationKey: parentAttemptKey,
    maximumMicrounits: 10_000_000 - allowance.maximumMicrounits,
    maximumTokens: 250_000 - allowance.maximumTokens,
    source: { sourceId: ids.parentAttemptId, idempotencyKey: `${parentAttemptKey}:reserve` },
  })
  return ledger
}

async function allocated(child) {
  expect(
    await child.allocator.allocate({
      request: child.request,
      receipt: child.receipt,
      execution: child.childExecution,
      attempt: child.childAttempt,
      delegation: child.delegation,
      assertCurrent: async () => undefined,
    })
  ).toBe(true)
  return {
    identity: {
      delegationId: child.delegation.delegationId,
      parentExecutionId: ids.parentExecutionId,
      parentAttemptId: ids.parentAttemptId,
      childAttemptId: child.request.childAttemptId,
    },
    record: child.delegation,
    plan: child.childPlan,
    attempt: child.childAttempt,
  }
}

const entriesOf = (ledger, executionId) => ledger.entries(ids.workspaceId, executionId)
const summaryOf = (ledger, executionId) => ledger.summary(ids.workspaceId, executionId)

test('reserves a delegated child attempt from the budget its allocation funded, once, and keeps parent and child independent', async () => {
  const f = await fixture({
    maximumTotal: 2,
    maximumParallel: 2,
    maximumDepth: 2,
    childAllowance: allowance,
  })
  try {
    const ledger = await runningLead(f)
    const admission = new DurableChildRuntimeBudgetAdmission({ store: f.usageStore })
    const child = await f.childAdmission()
    const delegated = await allocated(child)
    const childId = child.childIds.childExecutionId

    // Funded from the lead's unreserved balance: the whole allowance, not the plan's larger ceiling.
    expect(await summaryOf(ledger, childId)).toMatchObject({
      maximumMicrounits: allowance.maximumMicrounits,
      maximumTokens: allowance.maximumTokens,
    })
    const leadBefore = await summaryOf(ledger, ids.parentExecutionId)
    expect(leadBefore).toMatchObject({
      availableMicrounits: 0,
      availableTokens: 0,
      spentMicrounits: 0,
    })

    const authority = await admission.reserve(delegated)
    // The child's plan states the same allowance against its own 10M ceiling; it was funded 4M of
    // that, so it holds back 4M * 4M / 10M for its own children and the attempt keeps the rest.
    expect(authority).toMatchObject({
      schemaVersion: 1,
      workspaceId: ids.workspaceId,
      executionId: childId,
      attemptId: child.request.childAttemptId,
      reservationKey: `runtime-attempt:${child.request.childAttemptId}`,
      currency: 'USD',
      maximumMicrounits: 4_000_000 - 1_600_000,
      maximumTokens: 100_000 - 40_000,
      executionPlanId: child.childPlan.executionPlanId,
      executionPlanDigest: child.childPlan.contentDigest,
    })
    expect(Object.isFrozen(authority)).toBe(true)

    // The child's budget is its own: the lead's ledger did not move.
    expect(await summaryOf(ledger, ids.parentExecutionId)).toEqual(leadBefore)
    expect(await summaryOf(ledger, childId)).toMatchObject({
      reservedMicrounits: authority.maximumMicrounits,
      reservedTokens: authority.maximumTokens,
      availableMicrounits: 1_600_000,
      availableTokens: 40_000,
      spentMicrounits: 0,
    })

    // Retry: the same envelope, no second reservation or entry.
    const entries = await entriesOf(ledger, childId)
    expect(await admission.reserve(delegated)).toEqual(authority)
    expect(await admission.reserve(structuredClone(delegated))).toEqual(authority)
    expect(await entriesOf(ledger, childId)).toEqual(entries)
    expect(entries.filter((entry) => entry.kind === 'reservation')).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test('a second sibling cannot be funded once the first took the whole allowance, and the first still reserves', async () => {
  const f = await fixture({
    maximumTotal: 2,
    maximumParallel: 2,
    maximumDepth: 2,
    childAllowance: allowance,
  })
  try {
    const ledger = await runningLead(f)
    const admission = new DurableChildRuntimeBudgetAdmission({ store: f.usageStore })
    const first = await f.childAdmission()
    const second = await f.childAdmission()
    const firstDelegated = await allocated(first)
    // The first child took the whole allowance: allocating a second fails closed with no funding.
    await expect(allocated(second)).rejects.toThrow('BUDGET_EXHAUSTED')
    const firstAuthority = await admission.reserve(firstDelegated)
    expect(firstAuthority.maximumMicrounits).toBe(2_400_000)
    expect(await summaryOf(ledger, ids.parentExecutionId)).toMatchObject({
      availableMicrounits: 0,
      reservedMicrounits: 10_000_000,
    })
  } finally {
    await f.close()
  }
})

test('refuses a child whose funding, opening receipt or identity does not match the delegation', async () => {
  const f = await fixture({
    maximumTotal: 2,
    maximumParallel: 2,
    maximumDepth: 2,
    childAllowance: allowance,
  })
  try {
    const ledger = await runningLead(f)
    const admission = new DurableChildRuntimeBudgetAdmission({ store: f.usageStore })
    const child = await f.childAdmission()
    const delegated = await allocated(child)
    const childId = child.childIds.childExecutionId
    const before = await entriesOf(ledger, childId)
    const denied = async (admissionInput) => {
      await expect(admission.reserve(admissionInput)).rejects.toThrow(RuntimeBudgetAdmissionError)
      expect(await entriesOf(ledger, childId)).toEqual(before)
    }

    // A different delegation cannot claim this child's opening receipt.
    await denied({
      ...delegated,
      record: { ...delegated.record, delegationId: 'dlg_01JZBCDEF0123456789ABCDEFG' },
    })
    // Neither can a record that names another parent, a different plan, or another child.
    await denied({
      ...delegated,
      record: { ...delegated.record, parentExecutionId: 'exe_01JZBCDEF0123456789ABCDEFG' },
      identity: { ...delegated.identity, parentExecutionId: 'exe_01JZBCDEF0123456789ABCDEFG' },
    })
    await denied({
      ...delegated,
      record: { ...delegated.record, childExecutionPlanDigest: `sha256:${'e'.repeat(64)}` },
    })
    await denied({
      ...delegated,
      attempt: { ...delegated.attempt, executionId: 'exe_01JZBCDEF0123456789ABCDEFG' },
    })
    // A child that was never allocated has no budget to reserve from.
    const stranger = await f.childAdmission()
    await denied({ ...delegated, record: stranger.delegation, plan: stranger.childPlan })

    // A finalized (settled) child budget can no longer be reserved from.
    await ledger.finalizeBudget({
      workspaceId: ids.workspaceId,
      executionId: childId,
      source: { sourceId: 'finalize-child', idempotencyKey: 'finalize-child' },
    })
    await expect(admission.reserve(delegated)).rejects.toThrow(RuntimeBudgetAdmissionError)
  } finally {
    await f.close()
  }
})
