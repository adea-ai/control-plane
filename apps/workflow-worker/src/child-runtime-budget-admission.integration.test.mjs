import { describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { DurableChildRuntimeBudgetAdmission } from './child-runtime-budget-admission.ts'
import { RuntimeBudgetAdmissionError } from './runtime-budget-admission-error.ts'
import {
  createChildAllocationFixture,
  parentAttemptId,
  parentAttemptKey,
  parentExecutionId,
  workspaceId,
} from './child-allocation-pg-fixture.mjs'

// The same child allowance journeys as the SQLite suite (`tests/child-runtime-budget-admission.test.mjs`),
// over the PostgreSQL allocator, usage store and plan repository. What the allowance bounds is
// outstanding child funding plus settled spending, not a one-off total: a child that settles below
// its ceiling returns the difference. The lead's own attempt reservation is written directly by the
// fixture; root admission has its own PostgreSQL suite.
const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const allowance = { maximumMicrounits: 4_000_000, maximumTokens: 100_000 }
const source = (key) => ({ sourceId: key, idempotencyKey: key })

async function withFixture(options, run) {
  const isolated = await createIsolatedTestDatabase({
    administration: loadDatabaseCredentials(process.env, 'administration'),
    application: loadDatabaseCredentials(process.env, 'application'),
    migration: loadDatabaseCredentials(process.env, 'migration'),
  })
  try {
    await isolated.migrate()
    const f = await createChildAllocationFixture(isolated, options)
    const admission = new DurableChildRuntimeBudgetAdmission({
      store: f.usageStore,
      plans: f.plans,
    })
    await run(f, admission)
  } finally {
    await isolated.dispose()
  }
}

const summaryOf = (f, executionId) => f.ledger.summary(workspaceId, executionId)
const noRows = (rows) =>
  expect(rows).toEqual({
    execution: undefined,
    attempt: undefined,
    delegation: undefined,
    budget: undefined,
  })

describe.skipIf(!enabled)('PostgreSQL child allowance', () => {
  test('an omitted allowance can fund from a settled lead reservation while its attempt is still running', async () => {
    await withFixture({ maximumTotal: 2 }, async (f) => {
      expect(f.parentPlan.constraints.limits.childExecutions).not.toHaveProperty('budgetAllowance')
      await f.ledger.reserve({
        workspaceId,
        executionId: parentExecutionId,
        attemptId: parentAttemptId,
        reservationKey: parentAttemptKey,
        maximumMicrounits: 10_000_000,
        maximumTokens: 250_000,
        source: source('omitted-lead-reserve'),
      })
      const settled = await f.ledger.settle({
        workspaceId,
        executionId: parentExecutionId,
        reservationKey: parentAttemptKey,
        source: source('omitted-lead-settle'),
      })
      expect(settled.releasedMicrounits).toBe(10_000_000)
      await expect(f.executions.getExecution(parentExecutionId)).resolves.toMatchObject({
        state: 'running',
      })
      await expect(f.executions.getAttempt(parentAttemptId)).resolves.toMatchObject({
        state: 'running',
      })

      const child = await f.candidate()
      await f.allocate(child)
      expect(await summaryOf(f, child.childExecutionId)).toMatchObject({
        maximumMicrounits: 10_000_000,
        maximumTokens: 250_000,
      })

      // Zero cannot express a separate accepted-plan policy: allowance values must be positive.
      expect(() =>
        new ExecutionPlanCompiler('1.0.0').compile(
          f.parentInput({ maximumMicrounits: 0, maximumTokens: 0 })
        )
      ).toThrow()
    })
  }, 90_000)

  test('after the lead reservation settles while its attempt remains running, funding and spend bound siblings', async () => {
    await withFixture({ maximumTotal: 4, allowance }, async (f, admission) => {
      // The lead's reservation settles before its attempt transitions: the full envelope is
      // released while the parent execution and attempt remain running.
      await f.ledger.settle({
        workspaceId,
        executionId: parentExecutionId,
        reservationKey: parentAttemptKey,
        source: source('lead-settle'),
      })
      expect(await f.executions.getExecution(parentExecutionId)).toMatchObject({ state: 'running' })
      expect(await f.executions.getAttempt(parentAttemptId)).toMatchObject({ state: 'running' })
      expect(await summaryOf(f, parentExecutionId)).toMatchObject({
        availableMicrounits: 10_000_000,
        availableTokens: 250_000,
      })

      // The child plan asks for 10M, but the parent plan states 4M for children.
      const first = await f.candidate()
      const firstAdmitted = await f.allocate(first)
      expect(await summaryOf(f, first.childExecutionId)).toMatchObject({
        maximumMicrounits: 4_000_000,
        maximumTokens: 100_000,
      })
      expect(await summaryOf(f, parentExecutionId)).toMatchObject({
        availableMicrounits: 6_000_000,
      })

      // Outstanding funding: a sibling finds the allowance used up, however much of the freed
      // balance is left, and nothing is left behind.
      const refused = await f.candidate()
      await expect(f.allocate(refused)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
      noRows(await f.rowsFor(refused))
      expect(await summaryOf(f, parentExecutionId)).toMatchObject({
        availableMicrounits: 6_000_000,
      })

      // The funded child reserves its attempt through the production admission over PostgreSQL:
      // 4M funded less the 1.6M its own plan holds back (the same 4M of 10M share).
      expect(await admission.reserve(firstAdmitted)).toMatchObject({
        executionId: first.childExecutionId,
        maximumMicrounits: 4_000_000 - 1_600_000,
        maximumTokens: 100_000 - 40_000,
      })

      // Settled spending: the child spends 1M micro and 10k tokens, settles and is finalized. Its
      // funding settles at what it charged, so only the unspent difference is allowance again.
      const key = `runtime-attempt:${first.childAttemptId}`
      await f.ledger.charge({
        workspaceId,
        executionId: first.childExecutionId,
        attemptId: first.childAttemptId,
        reservationKey: key,
        kind: 'model_usage',
        quantity: { unit: 'tokens', value: 10_000 },
        costMicrounits: 1_000_000,
        fundingSource: 'hq_managed',
        source: source('first-charge'),
      })
      await f.ledger.settle({
        workspaceId,
        executionId: first.childExecutionId,
        reservationKey: key,
        source: source('first-settle'),
      })
      await f.ledger.finalizeBudget({
        workspaceId,
        executionId: first.childExecutionId,
        source: source('first-finalize'),
      })
      const second = await f.candidate()
      await f.allocate(second)
      expect(await summaryOf(f, second.childExecutionId)).toMatchObject({
        maximumMicrounits: 3_000_000,
        maximumTokens: 90_000,
      })
      // Allowance 4M = 1M spent + 3M outstanding: the next sibling gets nothing more.
      const exhausted = await f.candidate()
      await expect(f.allocate(exhausted)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
      noRows(await f.rowsFor(exhausted))
    })
  }, 90_000)

  test('the child admission binds the parent plan statement the allocator funded under', async () => {
    await withFixture({ maximumTotal: 2, allowance }, async (f, admission) => {
      const child = await f.candidate()
      const admitted = await f.allocate(child)
      const before = await f.ledger.entries(workspaceId, child.childExecutionId)

      // Parent plans that differ only in the statement they make: a smaller allowance, and none.
      const smaller = new ExecutionPlanCompiler('1.0.0').compile(
        f.parentInput({ maximumMicrounits: 3_000_000, maximumTokens: 100_000 })
      )
      const silent = new ExecutionPlanCompiler('1.0.0').compile(f.parentInput(undefined))
      for (const other of [smaller, silent]) {
        expect(other.contentDigest).not.toBe(f.parentPlan.contentDigest)
        await f.plans.put(other)
        // Pointing the delegation at the other plan changes the statement the opening fingerprint
        // is recomputed with, so the allocator's receipt no longer matches.
        await expect(
          admission.reserve({
            ...admitted,
            record: {
              ...admitted.record,
              parentExecutionPlanId: other.executionPlanId,
              parentExecutionPlanDigest: other.contentDigest,
            },
            plan: {
              ...admitted.plan,
              parentExecutionPlan: {
                ...admitted.plan.parentExecutionPlan,
                executionPlanId: other.executionPlanId,
                contentDigest: other.contentDigest,
              },
            },
          })
        ).rejects.toThrow(RuntimeBudgetAdmissionError)
        expect(await f.ledger.entries(workspaceId, child.childExecutionId)).toEqual(before)
      }
      // The plan the child was actually funded under is accepted, and replays the same envelope.
      const reserved = await admission.reserve(admitted)
      expect(reserved).toMatchObject({ executionId: child.childExecutionId })
      expect(await admission.reserve(admitted)).toEqual(reserved)
    })
  }, 90_000)

  test('once the lead is cancelled the allocator refuses before any funding is considered', async () => {
    await withFixture({ maximumTotal: 2, allowance }, async (f) => {
      await f.ledger.settle({
        workspaceId,
        executionId: parentExecutionId,
        reservationKey: parentAttemptKey,
        source: source('lead-settle'),
      })
      await f.lifecycle.transitionAttempt({
        attemptId: parentAttemptId,
        expectedVersion: 2,
        to: 'cancelled',
        transitionedAt: '2026-10-09T12:00:10.000Z',
      })
      const child = await f.candidate()
      const parentBefore = await summaryOf(f, parentExecutionId)
      // Ten million is available again, but the allocator needs an active parent attempt.
      await expect(f.allocate(child)).rejects.toMatchObject({ code: 'CHILD_ADMISSION_DENIED' })
      noRows(await f.rowsFor(child))
      expect(await summaryOf(f, parentExecutionId)).toEqual(parentBefore)
      expect(parentBefore).toMatchObject({ availableMicrounits: 10_000_000 })
    })
  }, 90_000)
})
