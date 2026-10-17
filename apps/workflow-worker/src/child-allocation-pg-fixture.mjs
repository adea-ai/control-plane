import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import {
  ExecutionAttemptSchema,
  ExecutionLifecycleService,
  ExecutionSchema,
  previewLifecycleTransition,
} from '@control-plane/domain'
import { deriveExecutionPlan, ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  PostgresContextPackageRepository,
  PostgresDelegationRepository,
  PostgresDurableUsageStore,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  PostgresToolCallRepository,
} from '@control-plane/database'
import { DurableUsageLedger } from '@control-plane/usage-ledger'

// A real PostgreSQL parent (running execution and attempt, open budget, admitted tool call) plus
// candidates for the transactional child allocator. The lead's own attempt reservation is written
// directly, as in the SQLite journey: root admission has its own PostgreSQL integration suite.
export const acceptedAt = '2026-10-09T12:00:00.000Z'
export const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
export const parentExecutionId = 'exe_01JABCDEF0123456789ABCDEFG'
export const parentAttemptId = 'att_01JABCDEF0123456789ABCDEFG'
export const parentAttemptKey = `runtime-attempt:${parentAttemptId}`
const parentContext = contextPackageSerializationFixtures.futurePi
const digest = (character) => `sha256:${character.repeat(64)}`

export async function createChildAllocationFixture(
  isolated,
  { maximumTotal, allowance, budget = { maximumMicrounits: 10_000_000, maximumTokens: 250_000 } }
) {
  const plans = new PostgresExecutionPlanRepository(isolated.application)
  const contexts = new PostgresContextPackageRepository(isolated.application)
  const executions = new PostgresExecutionRepository(isolated.application)
  const lifecycle = new ExecutionLifecycleService(executions)
  const usageStore = new PostgresDurableUsageStore(isolated.application)
  const ledger = new DurableUsageLedger({ store: usageStore, now: () => acceptedAt })

  const parentInput = (statedAllowance) => {
    const input = createExecutionPlanTestFixtureInputs({ contextPackage: parentContext })
    input.correlation.workspaceId = workspaceId
    input.constraints.limits.childExecutions.maximumTotal = maximumTotal
    input.constraints.limits.concurrency.maximumParallel = maximumTotal
    input.constraints.limits.budget.maximumMicrounits = budget.maximumMicrounits
    input.constraints.limits.tokens.maximumTotal = budget.maximumTokens
    if (statedAllowance === undefined) {
      delete input.constraints.limits.childExecutions.budgetAllowance
    } else {
      input.constraints.limits.childExecutions.budgetAllowance = statedAllowance
    }
    return input
  }
  const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(parentInput(allowance))
  await contexts.put(parentContext)
  await plans.put(parentPlan)

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
  await ledger.openBudget({
    workspaceId,
    executionId: parentExecutionId,
    currency: 'USD',
    maximumMicrounits: budget.maximumMicrounits,
    maximumTokens: budget.maximumTokens,
    source: { sourceId: 'child-allocation-parent-budget', idempotencyKey: 'parent-open' },
  })
  // The lead's attempt holds everything except the allowance its plan states for children.
  if (allowance !== undefined) {
    await ledger.reserve({
      workspaceId,
      executionId: parentExecutionId,
      attemptId: parentAttemptId,
      reservationKey: parentAttemptKey,
      maximumMicrounits: budget.maximumMicrounits - allowance.maximumMicrounits,
      maximumTokens: budget.maximumTokens - allowance.maximumTokens,
      source: { sourceId: parentAttemptId, idempotencyKey: `${parentAttemptKey}:reserve` },
    })
  }

  const toolCalls = new PostgresToolCallRepository(isolated.application, workspaceId)
  const toolCallId = 'tlc_01JABCDEF0123456789ABCDEFG'
  if (
    !(await toolCalls.insert({
      toolCallId,
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
    }))
  )
    throw new Error('FIXTURE_TOOL_CALL_NOT_INSERTED')

  const delegations = new PostgresDelegationRepository(isolated.application)
  const suffixes = ['B', 'C', 'D', 'E', 'F']
  let ordinal = 0
  async function candidate() {
    ordinal += 1
    const suffix = suffixes[ordinal - 1]
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
    // The child states the parent's constraints, so its own plan holds back the same allowance.
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
      admittedToolCallId: toolCallId,
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
      admittedToolCallId: toolCallId,
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
      childPlan,
    }
  }

  return {
    plans,
    executions,
    lifecycle,
    usageStore,
    ledger,
    delegations,
    parentPlan,
    parentInput,
    candidate,
    // Allocates through the real PostgreSQL allocator and returns what the bridge would pass to
    // `reserveBudget`.
    async allocate(child) {
      const allocated = await delegations.allocate({
        ...child,
        assertCurrent: async () => undefined,
      })
      if (!allocated) throw new Error('FIXTURE_ALLOCATION_NOT_WRITTEN')
      return {
        identity: {
          schemaVersion: 'delegation-runtime-admission/v1',
          parentExecutionId,
          parentAttemptId,
          delegationId: child.delegationId,
          childAttemptId: child.childAttemptId,
        },
        record: child.delegation,
        plan: child.childPlan,
        attempt: child.attempt,
      }
    },
    async rowsFor(child) {
      return {
        execution: await executions.getExecution(child.childExecutionId),
        attempt: await executions.getAttempt(child.childAttemptId),
        delegation: await delegations.get(child.delegationId),
        budget: await usageStore.transaction(workspaceId, (tx) =>
          tx.getBudget(child.childExecutionId)
        ),
      }
    },
  }
}
