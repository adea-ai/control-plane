// Shared SQLite child-allocation fixture: a real running parent, its budget, and children whose
// allocation runs through the transactional allocator.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import {
  ExecutionAttemptSchema,
  ExecutionLifecycleService,
  ExecutionSchema,
  previewLifecycleTransition,
} from '@control-plane/domain'
import { deriveExecutionPlan, ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { SqliteDelegationRepository } from './delegation-repository.ts'
import { SqliteContextPackageRepository } from './repositories-extra.ts'
import { SqliteExecutionPlanRepository } from './repositories.ts'
import { SqliteExecutionRepository } from './repositories.ts'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteDurableUsageStore } from './usage-store.ts'

const digest = (character) => `sha256:${character.repeat(64)}`
export const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  parentAttemptId: 'att_01JABCDEF0123456789ABCDEFG',
  childTaskId: 'tsk_01JBBCDEF0123456789ABCDEFG',
  childRequestId: 'req_01JBBCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  actor: 'usr_01JABCDEF0123456789ABCDEFG',
  toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
}
export const acceptedAt = '2026-10-09T12:00:00.000Z'

export async function fixture({
  parentBudget = { maximumMicrounits: 10_000_000, maximumTokens: 250_000 },
  maximumTotal = 1,
  maximumParallel = 1,
  maximumDepth = 2,
  startParent = true,
  childAllowance,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-child-budget-admission-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  await provider.migrate()
  const compiler = new ExecutionPlanCompiler('1.0.0')
  // The parent plan, optionally stating a different child allowance (or none, with `null`).
  const parentPlanStating = (statedAllowance) => {
    const parentInput = createExecutionPlanTestFixtureInputs()
    parentInput.correlation.workspaceId = ids.workspaceId
    parentInput.correlation.taskId = 'tsk_01JABCDEF0123456789ABCDEFG'
    parentInput.correlation.requestId = 'req_01JABCDEF0123456789ABCDEFG'
    parentInput.constraints.limits.childExecutions.maximumTotal = maximumTotal
    parentInput.constraints.limits.childExecutions.maximumDepth = maximumDepth
    parentInput.constraints.limits.concurrency.maximumParallel = maximumParallel
    if (statedAllowance !== null && statedAllowance !== undefined) {
      parentInput.constraints.limits.childExecutions.budgetAllowance = statedAllowance
    }
    return compiler.compile(parentInput)
  }
  const canonicalParentPlan = parentPlanStating(childAllowance)
  const parentContextPackage = contextPackageSerializationFixtures.futurePi
  const executionPlans = new SqliteExecutionPlanRepository(provider)
  const contexts = new SqliteContextPackageRepository(provider)
  await contexts.put(parentContextPackage)
  await executionPlans.put(canonicalParentPlan)

  const executions = new SqliteExecutionRepository(provider)
  const lifecycle = new ExecutionLifecycleService(executions)
  const parentExecution = ExecutionSchema.parse({
    executionId: ids.parentExecutionId,
    state: 'accepted',
    version: 1,
    correlation: canonicalParentPlan.correlation,
    executionPlan: {
      executionPlanId: canonicalParentPlan.executionPlanId,
      contentDigest: canonicalParentPlan.contentDigest,
      schemaVersion: canonicalParentPlan.schemaVersion,
    },
    attemptCount: 0,
    acceptedAt,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  })
  await executions.insertExecution(parentExecution)
  const parentAttempt = await lifecycle.createAttempt({
    executionId: ids.parentExecutionId,
    attemptId: ids.parentAttemptId,
    expectedExecutionVersion: 1,
    queuedAt: '2026-10-09T12:00:01.000Z',
  })
  let parentExecutionVersion = 2
  let parentAttemptVersion = 1
  if (startParent) {
    await lifecycle.transitionExecution({
      executionId: ids.parentExecutionId,
      expectedVersion: parentExecutionVersion,
      to: 'queued',
      transitionedAt: '2026-10-09T12:00:02.000Z',
    })
    parentExecutionVersion += 1
    await lifecycle.transitionExecution({
      executionId: ids.parentExecutionId,
      expectedVersion: parentExecutionVersion,
      to: 'running',
      transitionedAt: '2026-10-09T12:00:03.000Z',
    })
    parentExecutionVersion += 1
    await lifecycle.transitionAttempt({
      attemptId: ids.parentAttemptId,
      expectedVersion: parentAttemptVersion,
      to: 'running',
      transitionedAt: '2026-10-09T12:00:03.000Z',
    })
    parentAttemptVersion += 1
  }
  const usageStore = new SqliteDurableUsageStore(provider)
  const ledger = new DurableUsageLedger({ store: usageStore, now: () => acceptedAt })
  await ledger.openBudget({
    workspaceId: ids.workspaceId,
    executionId: ids.parentExecutionId,
    currency: 'USD',
    ...parentBudget,
    source: { sourceId: 'root-admission-fixture', idempotencyKey: 'root-budget-open' },
  })

  let nextChild = 0
  async function childAdmission() {
    nextChild += 1
    const childExecutionId =
      nextChild === 1 ? ids.childExecutionId : 'exe_01JDBCDEF0123456789ABCDEFG'
    const childAttemptId =
      nextChild === 1 ? 'att_01JBBCDEF0123456789ABCDEFG' : 'att_01JDBCDEF0123456789ABCDEFG'
    const delegationId = nextChild === 1 ? ids.delegationId : 'dlg_01JDBCDEF0123456789ABCDEFG'
    const childTaskId = nextChild === 1 ? ids.childTaskId : 'tsk_01JDBCDEF0123456789ABCDEFG'
    const childRequestId = nextChild === 1 ? ids.childRequestId : 'req_01JDBCDEF0123456789ABCDEFG'
    const childContext = deriveContextPackage(parentContextPackage, {
      objective: 'Run one bounded child task',
      allowedStateItemIds: [],
      allowedArtifactIds: [],
      budgets: {
        maximumBytes: Math.min(512, parentContextPackage.budgets.maximumBytes),
        maximumTokens: Math.min(128, parentContextPackage.budgets.maximumTokens),
      },
      successCriteria: ['Return focused evidence'],
      returnContract: { contractRef: 'contract://adapter-result/v1' },
      compiledAt: acceptedAt,
    })
    await contexts.put(childContext)
    const childCorrelation = {
      ...canonicalParentPlan.correlation,
      taskId: childTaskId,
      requestId: childRequestId,
    }
    const childPlan = deriveExecutionPlan(canonicalParentPlan, {
      correlation: childCorrelation,
      contextPackage: childContext,
      constraints: canonicalParentPlan.constraints,
      runtimeRequirements: canonicalParentPlan.runtimeRequirements,
      outputContract: canonicalParentPlan.outputContract,
      compiledAt: acceptedAt,
    })
    await executionPlans.put(childPlan)
    const childExecution = ExecutionSchema.parse({
      executionId: childExecutionId,
      state: 'accepted',
      version: 1,
      correlation: childPlan.correlation,
      executionPlan: {
        executionPlanId: childPlan.executionPlanId,
        contentDigest: childPlan.contentDigest,
        schemaVersion: childPlan.schemaVersion,
      },
      parentExecutionId: ids.parentExecutionId,
      attemptCount: 0,
      acceptedAt,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    })
    const childAttempt = ExecutionAttemptSchema.parse({
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
    const queuedChildExecution = ExecutionSchema.parse({
      ...previewLifecycleTransition(childExecution, { to: 'queued', transitionedAt: acceptedAt }),
      attemptCount: 1,
      latestAttemptId: childAttemptId,
    })
    const childRequestDigest = digest(nextChild === 1 ? 'c' : 'd')
    const childDispatch = {
      delegationId,
      childAttemptId,
      runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
      dispatchedAt: acceptedAt,
    }
    const request = {
      workspaceId: ids.workspaceId,
      parentIntentId: 'intent:child-budget-fixture',
      parentExecutionId: ids.parentExecutionId,
      parentAttemptId: ids.parentAttemptId,
      parentExecutionVersion,
      parentPlan: {
        executionPlanId: canonicalParentPlan.executionPlanId,
        contentDigest: canonicalParentPlan.contentDigest,
        schemaVersion: canonicalParentPlan.schemaVersion,
      },
      admittedToolCallId: ids.toolCallId,
      delegationId,
      childRequestId: childPlan.correlation.requestId,
      childExecutionId,
      childAttemptId,
      childDispatch,
      childPlan: {
        executionPlanId: childPlan.executionPlanId,
        contentDigest: childPlan.contentDigest,
        schemaVersion: childPlan.schemaVersion,
      },
      role: 'researcher',
      profileVersionId: canonicalParentPlan.profile.profileVersionId,
      originalActorPrincipalId: ids.actor,
      childRequestDigest,
      acceptedAt,
    }
    const delegation = {
      delegationId,
      parentExecutionId: ids.parentExecutionId,
      parentAttemptId: ids.parentAttemptId,
      admittedToolCallId: ids.toolCallId,
      childExecutionId,
      parentExecutionPlanId: canonicalParentPlan.executionPlanId,
      parentExecutionPlanDigest: canonicalParentPlan.contentDigest,
      childExecutionPlanId: childPlan.executionPlanId,
      childExecutionPlanDigest: childPlan.contentDigest,
      contextPackageId: childPlan.contextPackage.contextPackageId,
      contextPackageDigest: childPlan.contextPackage.contentDigest,
      role: 'researcher',
      profileVersionId: canonicalParentPlan.profile.profileVersionId,
      objective: 'Run one bounded child task',
      policy: {
        cancellation: 'cascade',
        deadline: 'bounded_by_parent',
        failure: 'manual',
        maximumRetries: 0,
      },
      state: 'requested',
      pendingDispatch: childDispatch,
      retryCount: 0,
      inputDigest: childRequestDigest,
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
      selectionRef: 'selection:child-role',
      selectionRevision: nextChild,
      expiresAt: '2999-01-01T00:00:00.000Z',
    }
    return {
      childExecution: queuedChildExecution,
      childAttempt,
      request,
      receipt,
      delegation,
      allocator: new SqliteDelegationRepository(provider),
      executionRepository: executions,
      usageStore,
      childPlan,
      get childIds() {
        return { childExecutionId, delegationId }
      },
    }
  }
  return {
    directory,
    provider,
    executions,
    canonicalParentPlan,
    parentPlanStating,
    parentAttempt,
    parentAttemptVersion,
    usageStore,
    childAdmission,
    async close() {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
