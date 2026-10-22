import { describe, expect, test } from 'bun:test'
import process from 'node:process'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  ExecutionAttemptSchema,
  ExecutionLifecycleService,
  ExecutionSchema,
  previewLifecycleTransition,
} from '@control-plane/domain'
import { deriveExecutionPlan, ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { eq } from 'drizzle-orm'
import { PostgresDelegationRepository } from './delegation-repository.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { createPostgresConnection } from './connection.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { PostgresExecutionRepository } from './execution-repository.ts'
import { PostgresToolCallRepository } from './tool-repositories.ts'
import { usageBudgetStates } from './schema/usage-budget-state.ts'
import { createIsolatedTestDatabase } from './testing.ts'
import { PostgresDurableUsageStore } from './usage-store.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const acceptedAt = '2026-10-09T12:00:00.000Z'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const parentExecutionId = 'exe_01JABCDEF0123456789ABCDEFG'
const parentAttemptId = 'att_01JABCDEF0123456789ABCDEFG'
const parentContext = contextPackageSerializationFixtures.futurePi
const digest = (character) => `sha256:${character.repeat(64)}`

/**
 * An isolated PostgreSQL database with one running canonical parent, the
 * repositories the admission path uses, and a `candidate()` factory that
 * mints distinct canonical children.
 *
 * The limit overrides are the parent's stated limits, so a qualification can
 * bind the one dimension it proves without touching the others.
 */
async function withAdmissionFixture(
  run,
  {
    maximumTotal = 2,
    maximumParallel = 1,
    maximumDepth = 1,
    childAllowance = { maximumMicrounits: 4_000_000, maximumTokens: 100_000 },
    parentBudget = { maximumMicrounits: 100_000_000, maximumTokens: 100_000 },
  } = {}
) {
  const credentials = {
    administration: loadDatabaseCredentials(process.env, 'administration'),
    application: loadDatabaseCredentials(process.env, 'application'),
    migration: loadDatabaseCredentials(process.env, 'migration'),
  }
  const isolated = await createIsolatedTestDatabase(credentials)
  try {
    await isolated.migrate()
    const plans = new PostgresExecutionPlanRepository(isolated.application)
    const contexts = new PostgresContextPackageRepository(isolated.application)
    const parentInput = createExecutionPlanTestFixtureInputs({ contextPackage: parentContext })
    parentInput.correlation.workspaceId = workspaceId
    parentInput.constraints.limits.childExecutions.maximumTotal = maximumTotal
    parentInput.constraints.limits.concurrency.maximumParallel = maximumParallel
    parentInput.constraints.limits.childExecutions.maximumDepth = maximumDepth
    if (childAllowance !== null) {
      parentInput.constraints.limits.childExecutions.budgetAllowance = childAllowance
    }
    const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(parentInput)
    await contexts.put(parentContext)
    await plans.put(parentPlan)

    const executions = new PostgresExecutionRepository(isolated.application)
    const lifecycle = new ExecutionLifecycleService(executions)
    await lifecycle.createExecution({
      executionId: parentExecutionId,
      correlation: parentPlan.correlation,
      executionPlan: {
        executionPlanId: parentPlan.executionPlanId,
        contentDigest: parentPlan.contentDigest,
        schemaVersion: parentPlan.schemaVersion,
      },
      acceptedAt,
    })
    await lifecycle.createAttempt({
      executionId: parentExecutionId,
      attemptId: parentAttemptId,
      expectedExecutionVersion: 1,
      queuedAt: acceptedAt,
    })
    await lifecycle.transitionExecution({
      executionId: parentExecutionId,
      expectedVersion: 2,
      to: 'queued',
      transitionedAt: '2026-10-09T12:00:01.000Z',
    })
    await lifecycle.transitionExecution({
      executionId: parentExecutionId,
      expectedVersion: 3,
      to: 'running',
      transitionedAt: '2026-10-09T12:00:02.000Z',
    })
    await lifecycle.transitionAttempt({
      attemptId: parentAttemptId,
      expectedVersion: 1,
      to: 'running',
      transitionedAt: '2026-10-09T12:00:02.000Z',
    })
    const usageStore = new PostgresDurableUsageStore(isolated.application)
    const ledger = new DurableUsageLedger({ store: usageStore, now: () => acceptedAt })
    await ledger.openBudget({
      workspaceId,
      executionId: parentExecutionId,
      currency: 'USD',
      maximumMicrounits: parentBudget.maximumMicrounits,
      maximumTokens: parentBudget.maximumTokens,
      source: { sourceId: 'child-admission-parent-budget', idempotencyKey: 'parent-open' },
    })

    const toolCalls = new PostgresToolCallRepository(isolated.application, workspaceId)
    const parentToolCall = {
      toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
      requestDigest: digest('a'),
      executionId: parentExecutionId,
      attemptId: parentAttemptId,
      workspaceId,
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      principalRef: 'service:runtime-worker',
      toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
      toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
      operation: 'records.write',
      inputDigest: digest('b'),
      policySnapshotRef: 'policy://workspace/v1',
      executor: { type: 'connector', reference: 'records-v1' },
      idempotencyKey: 'child-admission-parent-tool-call-0001',
      status: 'requested',
      revision: 1,
      requestedAt: acceptedAt,
      history: [{ status: 'requested', at: acceptedAt }],
    }
    expect(await toolCalls.insert(parentToolCall)).toBe(true)

    const delegations = new PostgresDelegationRepository(isolated.application)
    let ordinal = 0
    async function candidate() {
      ordinal += 1
      const suffix = ['B', 'C', 'D'][ordinal - 1]
      const childExecutionId = `exe_01JABCDEF0123456789ABCDE${suffix}1`
      const childAttemptId = `att_01JABCDEF0123456789ABCDE${suffix}1`
      const delegationId = `dlg_01JABCDEF0123456789ABCDE${suffix}1`
      const taskId = `tsk_01JABCDEF0123456789ABCDE${suffix}1`
      const requestId = `req_01JABCDEF0123456789ABCDE${suffix}1`
      const childContext = deriveContextPackage(parentContext, {
        objective: `Child ${suffix}`,
        allowedStateItemIds: [],
        allowedArtifactIds: [],
        budgets: {
          maximumBytes: Math.min(512, parentContext.budgets.maximumBytes),
          maximumTokens: Math.min(128, parentContext.budgets.maximumTokens),
        },
        successCriteria: ['Return bounded child evidence'],
        returnContract: { contractRef: 'contract://adapter-result/v1' },
        compiledAt: acceptedAt,
      })
      await contexts.put(childContext)
      const childPlan = deriveExecutionPlan(parentPlan, {
        correlation: { ...parentPlan.correlation, taskId, requestId },
        contextPackage: childContext,
        constraints: parentPlan.constraints,
        runtimeRequirements: parentPlan.runtimeRequirements,
        outputContract: parentPlan.outputContract,
        compiledAt: acceptedAt,
      })
      await plans.put(childPlan)
      const execution = ExecutionSchema.parse({
        executionId: childExecutionId,
        correlation: childPlan.correlation,
        executionPlan: {
          executionPlanId: childPlan.executionPlanId,
          contentDigest: childPlan.contentDigest,
          schemaVersion: childPlan.schemaVersion,
        },
        parentExecutionId,
        state: 'accepted',
        version: 1,
        attemptCount: 0,
        acceptedAt,
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      })
      const attempt = ExecutionAttemptSchema.parse({
        attemptId: childAttemptId,
        executionId: childExecutionId,
        sequence: 1,
        state: 'queued',
        version: 1,
        acceptedAt,
        queuedAt: acceptedAt,
        runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      })
      const queuedExecution = ExecutionSchema.parse({
        ...previewLifecycleTransition(execution, { to: 'queued', transitionedAt: acceptedAt }),
        attemptCount: 1,
        latestAttemptId: childAttemptId,
      })
      const childDispatch = {
        delegationId,
        childAttemptId,
        runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
        dispatchedAt: acceptedAt,
      }
      const request = {
        workspaceId,
        parentIntentId: 'intent:integration-parent',
        parentExecutionId,
        parentAttemptId,
        parentExecutionVersion: 4,
        parentPlan: {
          executionPlanId: parentPlan.executionPlanId,
          contentDigest: parentPlan.contentDigest,
          schemaVersion: parentPlan.schemaVersion,
        },
        admittedToolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
        delegationId,
        childRequestId: requestId,
        childExecutionId,
        childAttemptId,
        childDispatch,
        childPlan: {
          executionPlanId: childPlan.executionPlanId,
          contentDigest: childPlan.contentDigest,
          schemaVersion: childPlan.schemaVersion,
        },
        role: 'researcher',
        profileVersionId: parentPlan.profile.profileVersionId,
        originalActorPrincipalId: 'usr_01JABCDEF0123456789ABCDEFG',
        childRequestDigest: digest(suffix.toLowerCase()),
        acceptedAt,
      }
      const delegation = {
        delegationId,
        parentExecutionId,
        parentAttemptId,
        admittedToolCallId: request.admittedToolCallId,
        childExecutionId,
        parentExecutionPlanId: parentPlan.executionPlanId,
        parentExecutionPlanDigest: parentPlan.contentDigest,
        childExecutionPlanId: childPlan.executionPlanId,
        childExecutionPlanDigest: childPlan.contentDigest,
        contextPackageId: childContext.contextPackageId,
        contextPackageDigest: childContext.contentDigest,
        role: request.role,
        profileVersionId: request.profileVersionId,
        objective: `Child ${suffix}`,
        policy: {
          cancellation: 'cascade',
          deadline: 'bounded_by_parent',
          failure: 'manual',
          maximumRetries: 0,
        },
        state: 'requested',
        pendingDispatch: childDispatch,
        retryCount: 0,
        inputDigest: request.childRequestDigest,
        revision: 1,
        acceptedAt,
        updatedAt: acceptedAt,
      }
      const receipt = {
        schemaVersion: 'pi-child-admission/v1',
        ...request,
        authorityRevision: 1,
        productRevision: 'product:rev-1',
        productReaderPrincipalId: 'svc_product-reader',
        selectionRef: `selection:child-${suffix}`,
        selectionRevision: ordinal,
        expiresAt: '2999-01-01T00:00:00.000Z',
      }
      return {
        childExecutionId,
        childAttemptId,
        delegationId,
        request,
        receipt,
        execution: queuedExecution,
        attempt,
        delegation,
      }
    }

    await run({
      delegations,
      executions,
      toolCalls,
      usageStore,
      ledger,
      candidate,
      parentToolCall,
      // The isolated database's own name and the application credential, so a
      // case can reach the same database through a client it owns.
      name: isolated.name,
      credentials,
    })
  } finally {
    await isolated.dispose()
  }
}

/**
 * The same database, reached through a client this test owns. The client is
 * separate from the fixture's, so closing and recreating it proves the
 * committed state is the database's and not a connection's.
 */
function ownedApplicationConnection(credentials, databaseName) {
  const url = new URL(credentials.url)
  url.pathname = `/${databaseName}`
  return createPostgresConnection({ role: 'application', url: url.toString() })
}
describe.skipIf(!enabled)('PostgreSQL child budget admission', () => {
  test('denials leave no allocation and concurrent requests serialize the parallel limit', async () => {
    await withAdmissionFixture(
      async ({ delegations, executions, toolCalls, usageStore, candidate, parentToolCall }) => {
        const denied = await candidate()
        await expect(
          delegations.allocate({
            ...denied,
            assertCurrent: async () => {
              throw new Error('child audience revoked')
            },
          })
        ).rejects.toThrow('child audience revoked')
        expect(await executions.getExecution(denied.childExecutionId)).toBeUndefined()
        expect(await executions.getAttempt(denied.childAttemptId)).toBeUndefined()
        expect(await delegations.get(denied.delegationId)).toBeUndefined()
        await expect(
          usageStore.transaction(workspaceId, (transaction) =>
            transaction.getBudget(denied.childExecutionId)
          )
        ).resolves.toBeUndefined()
        expect(
          (
            await usageStore.transaction(workspaceId, (transaction) =>
              transaction.getBudget(parentExecutionId)
            )
          )?.reservations
        ).toEqual([])

        const contenders = [await candidate(), await candidate()]
        let transactionReader
        let observedByReader
        const results = await Promise.allSettled(
          contenders.map((childCandidate) =>
            delegations.allocate({
              ...childCandidate,
              assertCurrent: async (reader) => {
                transactionReader = reader
                observedByReader = {
                  execution: await reader.getExecution(parentExecutionId),
                  attempt: await reader.getAttempt(parentAttemptId),
                  toolCall: await reader.getToolCall(parentToolCall.toolCallId),
                }
              },
            })
          )
        )
        expect(
          results.filter((result) => result.status === 'fulfilled' && result.value)
        ).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
        expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
          code: 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED',
        })
        expect(await delegations.listByParent(parentExecutionId)).toHaveLength(1)
        const winnerIndex = results.findIndex((result) => result.status === 'fulfilled')
        const loser = contenders[1 - winnerIndex]
        expect(await executions.getExecution(loser.childExecutionId)).toBeUndefined()
        expect(await executions.getAttempt(loser.childAttemptId)).toBeUndefined()
        expect(await delegations.get(loser.delegationId)).toBeUndefined()
        await expect(
          usageStore.transaction(workspaceId, (transaction) =>
            transaction.getBudget(loser.childExecutionId)
          )
        ).resolves.toBeUndefined()
        expect(
          (
            await usageStore.transaction(workspaceId, (transaction) =>
              transaction.getBudget(parentExecutionId)
            )
          )?.reservations
        ).toHaveLength(1)

        const winner = contenders[winnerIndex]
        // The parent has 100M available and the child plan asks for its whole ceiling, but the
        // parent plan states 4M of 10M (and 100k of 250k tokens, scaled to the 100k parent budget).
        expect(
          await usageStore.transaction(workspaceId, (transaction) =>
            transaction.getBudget(winner.childExecutionId)
          )
        ).toMatchObject({ maximumMicrounits: 4_000_000, maximumTokens: 40_000 })
        expect(observedByReader).toEqual({
          execution: await executions.getExecution(parentExecutionId),
          attempt: await executions.getAttempt(parentAttemptId),
          toolCall: await toolCalls.get(parentToolCall.toolCallId),
        })
        await expect(transactionReader.getExecution(parentExecutionId)).rejects.toThrow(
          'CHILD_ADMISSION_READER_CLOSED'
        )
        await expect(transactionReader.getAttempt(parentAttemptId)).rejects.toThrow(
          'CHILD_ADMISSION_READER_CLOSED'
        )
        await expect(transactionReader.getToolCall(parentToolCall.toolCallId)).rejects.toThrow(
          'CHILD_ADMISSION_READER_CLOSED'
        )
        const retainedWinner = await delegations.get(winner.delegationId)
        expect(retainedWinner).toMatchObject({
          state: 'requested',
          pendingDispatch: winner.request.childDispatch,
        })
        expect(
          await delegations.compareAndSet(retainedWinner.revision, {
            ...retainedWinner,
            childAttemptId: winner.childAttemptId,
            pendingDispatch: undefined,
            runtimeConnectionId: winner.request.childDispatch.runtime.runtimeConnectionId,
            state: 'dispatched',
            revision: retainedWinner.revision + 1,
            updatedAt: winner.request.childDispatch.dispatchedAt,
          })
        ).toBe(true)
        expect(await delegations.get(winner.delegationId)).toMatchObject({
          childAttemptId: winner.childAttemptId,
          state: 'dispatched',
        })
      }
    )
  }, 60_000)

  test('the total child limit denies the admission and leaves no allocation on PostgreSQL', async () => {
    await withAdmissionFixture(
      async ({ delegations, executions, usageStore, candidate }) => {
        const admitted = await candidate()
        await expect(
          delegations.allocate({ ...admitted, assertCurrent: async () => undefined })
        ).resolves.toBe(true)
        const denied = await candidate()
        await expect(
          delegations.allocate({ ...denied, assertCurrent: async () => undefined })
        ).rejects.toMatchObject({ code: 'DELEGATION_LIMIT_EXCEEDED' })
        expect(await executions.getExecution(denied.childExecutionId)).toBeUndefined()
        expect(await executions.getAttempt(denied.childAttemptId)).toBeUndefined()
        expect(await delegations.get(denied.delegationId)).toBeUndefined()
        await expect(
          usageStore.transaction(workspaceId, (transaction) =>
            transaction.getBudget(denied.childExecutionId)
          )
        ).resolves.toBeUndefined()
        expect(await delegations.listByParent(parentExecutionId)).toHaveLength(1)
        expect(
          (
            await usageStore.transaction(workspaceId, (transaction) =>
              transaction.getBudget(parentExecutionId)
            )
          )?.reservations
        ).toHaveLength(1)
      },
      { maximumTotal: 1, maximumParallel: 2 }
    )
  }, 60_000)

  test('the depth limit denies the admission and leaves no allocation on PostgreSQL', async () => {
    await withAdmissionFixture(
      async ({ delegations, executions, usageStore, candidate }) => {
        const denied = await candidate()
        await expect(
          delegations.allocate({ ...denied, assertCurrent: async () => undefined })
        ).rejects.toMatchObject({ code: 'DELEGATION_DEPTH_EXCEEDED' })
        expect(await executions.getExecution(denied.childExecutionId)).toBeUndefined()
        expect(await executions.getAttempt(denied.childAttemptId)).toBeUndefined()
        expect(await delegations.get(denied.delegationId)).toBeUndefined()
        await expect(
          usageStore.transaction(workspaceId, (transaction) =>
            transaction.getBudget(denied.childExecutionId)
          )
        ).resolves.toBeUndefined()
        expect(await delegations.listByParent(parentExecutionId)).toHaveLength(0)
        expect(
          (
            await usageStore.transaction(workspaceId, (transaction) =>
              transaction.getBudget(parentExecutionId)
            )
          )?.reservations
        ).toEqual([])
      },
      { maximumDepth: 0, childAllowance: null }
    )
  }, 60_000)

  test('the child budget limit denies the admission and leaves no allocation on PostgreSQL', async () => {
    await withAdmissionFixture(
      async ({ delegations, executions, usageStore, candidate }) => {
        const denied = await candidate()
        // The parent's own budget is empty, so the child's budget cannot be
        // funded from it. The budget fence is the one limit the child
        // admission path enforces inside its own transaction, after the
        // execution and attempt rows are written: the denial has to roll all
        // of them back.
        await expect(
          delegations.allocate({ ...denied, assertCurrent: async () => undefined })
        ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
        expect(await executions.getExecution(denied.childExecutionId)).toBeUndefined()
        expect(await executions.getAttempt(denied.childAttemptId)).toBeUndefined()
        expect(await delegations.get(denied.delegationId)).toBeUndefined()
        await expect(
          usageStore.transaction(workspaceId, (transaction) =>
            transaction.getBudget(denied.childExecutionId)
          )
        ).resolves.toBeUndefined()
        expect(await delegations.listByParent(parentExecutionId)).toHaveLength(0)
        expect(
          (
            await usageStore.transaction(workspaceId, (transaction) =>
              transaction.getBudget(parentExecutionId)
            )
          )?.reservations
        ).toEqual([])
      },
      { parentBudget: { maximumMicrounits: 0, maximumTokens: 0 } }
    )
  }, 60_000)

  test('a retried child keeps its parallel slot and cannot mint a second allocation on PostgreSQL', async () => {
    await withAdmissionFixture(async ({ delegations, executions, usageStore, candidate }) => {
      const admitted = await candidate()
      await expect(
        delegations.allocate({ ...admitted, assertCurrent: async () => undefined })
      ).resolves.toBe(true)
      const childBudgetBefore = await usageStore.transaction(workspaceId, (transaction) =>
        transaction.getBudget(admitted.childExecutionId)
      )
      const parentBudgetBefore = await usageStore.transaction(workspaceId, (transaction) =>
        transaction.getBudget(parentExecutionId)
      )
      // The retry returns the SAME child to an active state, so it keeps its
      // parallel slot: a retry is neither a free slot nor a second child.
      const stored = await delegations.get(admitted.delegationId)
      expect(
        await delegations.compareAndSet(stored.revision, {
          ...stored,
          state: 'requested',
          retryCount: stored.retryCount + 1,
          revision: stored.revision + 1,
          updatedAt: '2026-10-09T12:00:05.000Z',
        })
      ).toBe(true)
      const sibling = await candidate()
      await expect(
        delegations.allocate({ ...sibling, assertCurrent: async () => undefined })
      ).rejects.toMatchObject({ code: 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED' })
      expect(await executions.getExecution(sibling.childExecutionId)).toBeUndefined()
      expect(await delegations.get(sibling.delegationId)).toBeUndefined()
      // Re-admitting the retried child is an identity conflict, never a second
      // allocation: no second child budget and no second parent reservation.
      await expect(
        delegations.allocate({ ...admitted, assertCurrent: async () => undefined })
      ).resolves.toBe(false)
      expect(await delegations.listByParent(parentExecutionId)).toHaveLength(1)
      // Neither the child envelope nor the parent holdback moved: the retry
      // minted no second budget and no second parent reservation.
      expect(
        await usageStore.transaction(workspaceId, (transaction) =>
          transaction.getBudget(admitted.childExecutionId)
        )
      ).toStrictEqual(childBudgetBefore)
      expect(
        await usageStore.transaction(workspaceId, (transaction) =>
          transaction.getBudget(parentExecutionId)
        )
      ).toStrictEqual(parentBudgetBefore)
      expect(parentBudgetBefore?.reservations).toHaveLength(1)
    })
  }, 60_000)

  test('a concurrent retry of one identity allocates once and a recreated client observes the same parent reservation', async () => {
    await withAdmissionFixture(
      async ({ delegations, candidate, name, credentials }) => {
        const admitted = await candidate()
        const admit = (repository) =>
          repository.allocate({ ...admitted, assertCurrent: async () => undefined })

        // The retry race: one identity submitted twice at once. The parent lock
        // serializes them, so exactly one allocates and the other observes the
        // committed identity instead of allocating it again.
        const raced = await Promise.allSettled([admit(delegations), admit(delegations)])
        expect(raced.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
        expect(
          raced.filter((result) => result.status === 'fulfilled' && result.value)
        ).toHaveLength(1)
        expect(
          raced.filter((result) => result.status === 'fulfilled' && !result.value)
        ).toHaveLength(1)

        // A client that reconnects to the same database observes the same
        // committed allocation and refuses to allocate the identity again.
        const owned = ownedApplicationConnection(credentials.application, name)
        try {
          const reconnected = new PostgresDelegationRepository(owned.database)
          expect(await admit(reconnected)).toBe(false)
          expect(await reconnected.listByParent(parentExecutionId)).toHaveLength(1)
          expect(await reconnected.get(admitted.delegationId)).toMatchObject({
            delegationId: admitted.delegationId,
          })
          expect(
            await new PostgresExecutionRepository(owned.database).getExecution(
              admitted.childExecutionId
            )
          ).toMatchObject({ executionId: admitted.childExecutionId })
          const reconnectedStore = new PostgresDurableUsageStore(owned.database)
          expect(
            await reconnectedStore.transaction(workspaceId, (transaction) =>
              transaction.getBudget(admitted.childExecutionId)
            )
          ).toMatchObject({ maximumMicrounits: 4_000_000, maximumTokens: 40_000 })
          const parentBudget = await reconnectedStore.transaction(workspaceId, (transaction) =>
            transaction.getBudget(parentExecutionId)
          )
          expect(parentBudget?.reservations).toHaveLength(1)

          // The broader CP #1030 hosted operations measurement producer reads
          // this exact reservation array: a non-array is malformed, and every
          // element must carry an integral, non-negative charged amount.
          const [row] = await owned.database
            .select({ state: usageBudgetStates.state })
            .from(usageBudgetStates)
            .where(eq(usageBudgetStates.executionId, parentExecutionId))
          expect(Array.isArray(row?.state?.reservations)).toBe(true)
          expect(row?.state?.reservations).toHaveLength(1)
          const [reservation] = row?.state?.reservations ?? []
          expect(reservation?.reservationKey).toBe(`child:${admitted.childExecutionId}`)
          expect(reservation?.childExecutionId).toBe(admitted.childExecutionId)
          expect(reservation?.status).toBe('open')
          expect(Number.isInteger(reservation?.chargedMicrounits)).toBe(true)
          expect(reservation?.chargedMicrounits).toBeGreaterThanOrEqual(0)
        } finally {
          await owned.close()
        }
      },
      { maximumTotal: 2, maximumParallel: 1 }
    )
  }, 60_000)
})
