import { expect, test } from 'bun:test'
import { SqliteExecutionPlanRepository } from '@control-plane/sqlite-persistence'
import { ExecutionLifecycleService } from '@control-plane/domain'
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

const childAdmission = (f) =>
  new DurableChildRuntimeBudgetAdmission({
    store: f.usageStore,
    plans: new SqliteExecutionPlanRepository(f.provider),
  })

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
    const admission = childAdmission(f)
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
    const admission = childAdmission(f)
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
    const admission = childAdmission(f)
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

test('the child admission binds the parent plan statement the allocator funded under', async () => {
  const f = await fixture({
    maximumTotal: 2,
    maximumParallel: 2,
    maximumDepth: 2,
    childAllowance: allowance,
  })
  try {
    const ledger = await runningLead(f)
    const admission = childAdmission(f)
    const child = await f.childAdmission()
    const delegated = await allocated(child)
    const before = await entriesOf(ledger, child.childIds.childExecutionId)
    const plans = new SqliteExecutionPlanRepository(f.provider)
    // Parent plans that differ only in the statement they make: a smaller allowance, and none.
    for (const statement of [{ maximumMicrounits: 3_000_000, maximumTokens: 100_000 }, null]) {
      const other = f.parentPlanStating(statement)
      expect(other.contentDigest).not.toBe(f.canonicalParentPlan.contentDigest)
      await plans.put(other)
      // Pointing the delegation at the other plan changes the statement the opening fingerprint is
      // recomputed with, so the allocator's receipt no longer matches.
      await expect(
        admission.reserve({
          ...delegated,
          record: {
            ...delegated.record,
            parentExecutionPlanId: other.executionPlanId,
            parentExecutionPlanDigest: other.contentDigest,
          },
          plan: {
            ...delegated.plan,
            parentExecutionPlan: {
              ...delegated.plan.parentExecutionPlan,
              executionPlanId: other.executionPlanId,
              contentDigest: other.contentDigest,
            },
          },
        })
      ).rejects.toThrow(RuntimeBudgetAdmissionError)
      expect(await entriesOf(ledger, child.childIds.childExecutionId)).toEqual(before)
    }
    // The plan the child was actually funded under is accepted.
    expect(await admission.reserve(delegated)).toMatchObject({
      executionId: child.childIds.childExecutionId,
    })
  } finally {
    await f.close()
  }
})

test('allocation after the lead reservation settles while its attempt remains running respects the stated allowance', async () => {
  const f = await fixture({
    maximumTotal: 2,
    maximumParallel: 2,
    maximumDepth: 2,
    childAllowance: allowance,
  })
  try {
    const ledger = await runningLead(f)
    // The lead's reservation settles before its attempt transitions: the full envelope is released
    // while the parent execution and attempt remain running.
    await ledger.settle({
      workspaceId: ids.workspaceId,
      executionId: ids.parentExecutionId,
      reservationKey: parentAttemptKey,
      source: { sourceId: 'lead-settle', idempotencyKey: 'lead-settle' },
    })
    expect(await f.executions.getExecution(ids.parentExecutionId)).toMatchObject({
      state: 'running',
    })
    expect(await f.executions.getAttempt(ids.parentAttemptId)).toMatchObject({ state: 'running' })
    expect(await summaryOf(ledger, ids.parentExecutionId)).toMatchObject({
      availableMicrounits: 10_000_000,
      availableTokens: 250_000,
    })
    const first = await f.childAdmission()
    const second = await f.childAdmission()
    const delegated = await allocated(first)

    // The child plan asks for 10M, but the parent plan states 4M for children.
    expect(await summaryOf(ledger, first.childIds.childExecutionId)).toMatchObject({
      maximumMicrounits: allowance.maximumMicrounits,
      maximumTokens: allowance.maximumTokens,
    })
    expect(await summaryOf(ledger, ids.parentExecutionId)).toMatchObject({
      availableMicrounits: 10_000_000 - allowance.maximumMicrounits,
    })
    // A sibling finds the allowance used up, however much of the freed balance is left, and no
    // execution, attempt, budget or delegation row is left behind.
    await expect(allocated(second)).rejects.toThrow('BUDGET_EXHAUSTED')
    expect(await f.executions.getExecution(second.childIds.childExecutionId)).toBeUndefined()
    await expect(
      f.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(second.childIds.childExecutionId)
      )
    ).resolves.toBeUndefined()
    // The funded child still reserves its attempt through the production admission, which verifies
    // the opening receipt that carries the parent's statement.
    expect(await childAdmission(f).reserve(delegated)).toMatchObject({
      executionId: first.childIds.childExecutionId,
      maximumMicrounits: 4_000_000 - 1_600_000,
    })
  } finally {
    await f.close()
  }
})

test('once the lead attempt has ended the allocator refuses before any funding is considered', async () => {
  const f = await fixture({
    maximumTotal: 2,
    maximumParallel: 2,
    maximumDepth: 2,
    childAllowance: allowance,
  })
  try {
    const ledger = await runningLead(f)
    await ledger.settle({
      workspaceId: ids.workspaceId,
      executionId: ids.parentExecutionId,
      reservationKey: parentAttemptKey,
      source: { sourceId: 'lead-settle', idempotencyKey: 'lead-settle' },
    })
    await new ExecutionLifecycleService(f.executions).transitionAttempt({
      attemptId: ids.parentAttemptId,
      expectedVersion: f.parentAttemptVersion,
      to: 'cancelled',
      transitionedAt: '2026-10-09T12:00:10.000Z',
    })
    const child = await f.childAdmission()
    // The production path needs an active parent attempt, so the ledger cap is a second line of
    // defence for the window where the usage reservation is settled but the attempt has not ended.
    await expect(
      child.allocator.allocate({
        request: child.request,
        receipt: child.receipt,
        execution: child.childExecution,
        attempt: child.childAttempt,
        delegation: child.delegation,
        assertCurrent: async () => undefined,
      })
    ).rejects.toMatchObject({ code: 'CHILD_ADMISSION_DENIED' })
    expect(await f.executions.getExecution(child.childIds.childExecutionId)).toBeUndefined()
    await expect(
      f.usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(child.childIds.childExecutionId)
      )
    ).resolves.toBeUndefined()
    expect(await summaryOf(ledger, ids.parentExecutionId)).toMatchObject({
      availableMicrounits: 10_000_000,
      reservedMicrounits: 0,
    })
  } finally {
    await f.close()
  }
})
