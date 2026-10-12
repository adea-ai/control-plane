import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import {
  InMemoryProjectStateRepository,
  InMemoryStatePromotionProposalRepository,
  ProjectStateService,
  RecordingProjectStateEventPublisher,
} from '@control-plane/domain'
import {
  ChildProgressEvidenceBuffer,
  ChildProgressLeadDispatcher,
  ChildProgressLeadFeed,
  ChildUsageLedger,
  ParallelDelegationCoordinator,
} from '@control-plane/orchestration'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import {
  SqliteChildUsageOutcomeRepository,
  SqliteContextPackageRepository,
  SqliteDelegationEventPublisher,
  SqliteDelegationRepository,
  SqliteDurableUsageStore,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { createFixture, ids } from '../packages/orchestration/src/delegation-fixtures.mjs'

// Actual composition: TWO sibling children under ONE real parent, composed
// through the canonical coordinator admission (ParallelDelegationCoordinator
// + DelegationService) over durable SQLite, with canonical reservations in
// the durable usage ledger, the lead feed carrying retained progress and
// human input, canonical cascade cancellation, and restart replay. The
// governed executor's single-child guard is not touched: this flow uses the
// coordinator path, whose parent-plan limit (childExecutions.maximumTotal,
// 20 in this plan) legitimately admits two siblings.
const AT = '2026-08-25T18:25:00.000Z'

const branchIds = [
  {
    delegationId: 'dlg_01JBBCDEF0123456789ABCDEFG',
    childExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
    childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
    taskId: 'tsk_01JBBCDEF0123456789ABCDEFG',
    requestId: 'req_01JBBCDEF0123456789ABCDEFG',
    runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG',
    role: 'researcher',
    compiledAt: '2026-08-25T18:20:01.000Z',
  },
  {
    delegationId: 'dlg_01JCBCDEF0123456789ABCDEFG',
    childExecutionId: 'exe_01JCBCDEF0123456789ABCDEFG',
    childAttemptId: 'att_01JCBCDEF0123456789ABCDEFG',
    taskId: 'tsk_01JCBCDEF0123456789ABCDEFG',
    requestId: 'req_01JCBCDEF0123456789ABCDEFG',
    runtimeConnectionId: 'rtc_01JCBCDEF0123456789ABCDEFG',
    role: 'implementer',
    compiledAt: '2026-08-25T18:20:02.000Z',
  },
]
const groupId = 'dgr_01JABCDEF0123456789ABCDEFG'
const humanInteractionId = 'int_01JBBCDEF0123456789ABCDEFG'

function fanOutInput(parentPlan) {
  return {
    delegationGroupId: groupId,
    parentExecutionId: ids.parentExecutionId,
    parentPlan,
    parentContextPackage: contextPackageSerializationFixtures.futurePi,
    acceptedAt: '2026-08-25T18:20:00.000Z',
    deadlineAt: '2026-08-25T18:40:00.000Z',
    branches: branchIds.map((branch) => branchInput(parentPlan, branch)),
  }
}

function branchInput(parentPlan, branch) {
  const constraints = globalThis.structuredClone(parentPlan.constraints)
  constraints.tools.grants[0].operations = ['read']
  constraints.limits.budget.maximumMicrounits = 400_000
  constraints.limits.tokens.maximumTotal = 4_000
  constraints.limits.duration.maximumMs = 1_800_000
  constraints.limits.concurrency.maximumParallel = 1
  return {
    delegationId: branch.delegationId,
    childExecutionId: branch.childExecutionId,
    childAttemptId: branch.childAttemptId,
    role: branch.role,
    objective: `Complete ${branch.role} branch`,
    context: {
      allowedStateItemIds: [],
      allowedArtifactIds: [],
      maximumBytes: 512,
      maximumTokens: 128,
      successCriteria: [`Return ${branch.role} artifact`],
      returnContractRef: 'contract://execution-result/v1',
    },
    childPlan: {
      correlation: {
        ...parentPlan.correlation,
        taskId: branch.taskId,
        requestId: branch.requestId,
      },
      constraints,
      runtimeRequirements: parentPlan.runtimeRequirements,
      outputContract: parentPlan.outputContract,
      compiledAt: branch.compiledAt,
    },
    policy: {
      cancellation: 'cascade',
      deadline: 'bounded_by_parent',
      failure: 'retry',
      maximumRetries: 1,
    },
    runtime: { runtimeConnectionId: branch.runtimeConnectionId },
  }
}

test('two siblings under one real parent compose through coordinator admission, durable usage, lead human input, cancellation and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'two-siblings-'))
  let provider = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
  await provider.migrate()
  try {
    // Canonical child-progress path: DelegationService publishes through
    // the lead feed, which wraps the durable publication inbox.
    const publications = new SqliteDelegationEventPublisher(provider, ids.parentExecutionId)
    const dispatcher = new ChildProgressLeadDispatcher({
      buffer: new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId }),
    })
    const leadFeed = new ChildProgressLeadFeed({
      publications,
      dispatcher,
      generationOf: () => 1,
    })
    const fixture = await createFixture(undefined, {
      executions: new SqliteExecutionRepository(provider),
      plans: new SqliteExecutionPlanRepository(provider),
      contexts: new SqliteContextPackageRepository(provider),
      delegations: new SqliteDelegationRepository(provider),
      events: leadFeed,
    })
    const projectState = new ProjectStateService(
      new InMemoryProjectStateRepository(),
      new InMemoryStatePromotionProposalRepository(),
      new RecordingProjectStateEventPublisher()
    )
    await projectState.initialize({
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      at: '2026-08-25T18:19:00.000Z',
    })
    const parallel = new ParallelDelegationCoordinator({
      delegations: fixture.service,
      projectState,
      contexts: new SqliteContextPackageRepository(provider),
    })
    const usage = new DurableUsageLedger({
      store: new SqliteDurableUsageStore(provider),
      now: () => AT,
    })

    // 1. Coordinator admission: two sibling children under the ONE parent.
    const branches = await parallel.fanOut(fanOutInput(fixture.parentPlan))
    expect(branches).toHaveLength(2)
    const records = await fixture.delegations.listByParent(ids.parentExecutionId)
    expect(records).toHaveLength(2)
    expect(new Set(records.map((record) => record.parentExecutionId))).toEqual(
      new Set([ids.parentExecutionId])
    )
    expect(new Set(records.map((record) => record.delegationId))).toEqual(
      new Set(branchIds.map((branch) => branch.delegationId))
    )
    for (const record of records) {
      const child = await fixture.lifecycle.getExecution(record.childExecutionId)
      expect(child.parentExecutionId).toBe(ids.parentExecutionId)
      expect(child.latestAttemptId).toBe(record.childAttemptId)
    }

    // 2. Canonical reservations in the durable usage ledger, mirrored as
    // explicit estimated/reserved cost-state evidence per sibling.
    await usage.openBudget({
      workspaceId: ids.workspaceId,
      executionId: ids.parentExecutionId,
      currency: 'USD',
      maximumMicrounits: 10_000_000,
      maximumTokens: 250_000,
      source: { sourceId: 'manager:two-siblings', idempotencyKey: 'budget:two-siblings' },
    })
    const childUsage = new Map()
    const outcomeRepos = new Map()
    for (const record of records) {
      const reservationKey = `runtime-attempt:${record.childAttemptId}`
      await usage.openBudget({
        workspaceId: ids.workspaceId,
        executionId: record.childExecutionId,
        parentExecutionId: ids.parentExecutionId,
        currency: 'USD',
        maximumMicrounits: 400_000,
        maximumTokens: 4_000,
        source: {
          sourceId: `child-budget:${record.delegationId}`,
          idempotencyKey: `child-budget-open:${record.delegationId}`,
        },
      })
      await usage.reserve({
        workspaceId: ids.workspaceId,
        executionId: record.childExecutionId,
        attemptId: record.childAttemptId,
        reservationKey,
        maximumMicrounits: 400_000,
        maximumTokens: 4_000,
        source: {
          sourceId: `child-reserved:${record.delegationId}`,
          idempotencyKey: `child-reserved:${record.delegationId}`,
        },
      })
      const identity = {
        parentExecutionId: ids.parentExecutionId,
        delegationId: record.delegationId,
        childExecutionId: record.childExecutionId,
        childAttemptId: record.childAttemptId,
      }
      const ledger = new ChildUsageLedger()
      ledger.recordEstimate(identity, {
        currency: 'USD',
        maximumMicrounits: 400_000,
        source: 'branch-child-plan',
      })
      ledger.recordReservation(identity, {
        schemaVersion: 1,
        workspaceId: ids.workspaceId,
        executionId: record.childExecutionId,
        attemptId: record.childAttemptId,
        executionPlanId: record.childExecutionPlanId,
        executionPlanDigest: record.childExecutionPlanDigest,
        reservationKey,
        currency: 'USD',
        maximumMicrounits: 400_000,
        maximumTokens: 4_000,
      })
      expect(ledger.status(identity).costState).toBe('reserved')
      childUsage.set(record.delegationId, { ledger, identity })
      const repository = new SqliteChildUsageOutcomeRepository(provider, record.delegationId)
      outcomeRepos.set(record.delegationId, repository)
      expect(await repository.save({ revision: 1, snapshot: ledger.snapshot() })).toEqual({
        revision: 1,
      })
    }

    // 3. Retained progress for BOTH children through the service/feed.
    for (const record of records) {
      const progress = await fixture.service.recordChildProgress({
        delegationId: record.delegationId,
        childAttemptId: record.childAttemptId,
        state: 'running',
        observedAt: '2026-08-25T18:21:00.000Z',
      })
      expect(progress.record.state).toBe('running')
    }
    const retained = await fixture.delegations.listByParent(ids.parentExecutionId)
    expect(retained.every((record) => record.state === 'running')).toBe(true)

    // 4. Lead human input lands alongside the children's routine progress,
    // ahead of any batching.
    leadFeed.acceptHumanInput({
      interactionId: humanInteractionId,
      kind: 'input',
      receivedAt: '2026-08-25T18:21:30.000Z',
    })
    const humanDeliveries = leadFeed.takeDeliveries()
    expect(humanDeliveries).toHaveLength(1)
    expect(humanDeliveries[0]).toMatchObject({ kind: 'human_input', sequence: 1 })

    // 5. Usage THROUGH the canonical ledger for each sibling: reserve then
    // settle, leaving durable entries per child.
    for (const record of records) {
      await usage.settle({
        workspaceId: ids.workspaceId,
        executionId: record.childExecutionId,
        reservationKey: `runtime-attempt:${record.childAttemptId}`,
        source: {
          sourceId: `child-settle:${record.delegationId}`,
          idempotencyKey: `child-settle:${record.delegationId}`,
        },
      })
      const entries = await usage.entries(ids.workspaceId, record.childExecutionId)
      expect(entries.some((entry) => entry.kind === 'reservation')).toBe(true)
      expect(entries.some((entry) => entry.kind === 'settlement')).toBe(true)
    }

    // 6. Canonical cascade cancellation of both siblings.
    const cancelled = await fixture.service.cancelChildren({
      parentExecutionId: ids.parentExecutionId,
      cancelledAt: '2026-08-25T18:26:00.000Z',
    })
    expect(cancelled).toHaveLength(2)
    expect(cancelled.every((execution) => execution.state === 'cancelled')).toBe(true)
    const afterCancel = await fixture.delegations.listByParent(ids.parentExecutionId)
    expect(afterCancel.every((record) => record.state === 'cancelled')).toBe(true)

    // 7. The lead receives terminal evidence packets for both children.
    const evidence = leadFeed.takeDeliveries().filter((d) => d.kind === 'evidence')
    expect(evidence.length).toBeGreaterThan(0)
    const cancelledEntries = evidence
      .flatMap((delivery) => delivery.packet.entries)
      .filter((entry) => entry.phase === 'cancelled')
    expect(new Set(cancelledEntries.map((entry) => entry.delegationId))).toEqual(
      new Set(branchIds.map((branch) => branch.delegationId))
    )
    expect(JSON.stringify(evidence)).not.toContain('Complete researcher branch')

    // 8. Real restart: close and reopen the durable store.
    provider.close()
    provider = new SqlitePersistenceProvider({ path: join(directory, 'canonical.sqlite') })
    await provider.migrate()

    const replayedPublications = new SqliteDelegationEventPublisher(provider, ids.parentExecutionId)
    const replayDispatcher = new ChildProgressLeadDispatcher({
      buffer: new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId }),
    })
    const replayFeed = new ChildProgressLeadFeed({
      publications: replayedPublications,
      dispatcher: replayDispatcher,
      generationOf: () => 1,
    })
    const replayed = await replayFeed.replay()
    expect(replayed.foldedEventCount).toBeGreaterThan(0)
    expect(replayed.rejectedEventCount).toBe(0)
    expect(replayFeed.takeDeliveries().length).toBeGreaterThan(0)
    const replayAgain = await replayFeed.replay()
    expect(replayAgain.foldedEventCount).toBe(0)
    expect(replayAgain.duplicateEventCount).toBeGreaterThan(0)
    expect(replayFeed.takeDeliveries()).toEqual([])

    // Retained identity: the same parent, delegations and attempts survive.
    const reopenedRepository = new SqliteDelegationRepository(provider)
    const reopened = await reopenedRepository.listByParent(ids.parentExecutionId)
    expect(reopened).toHaveLength(2)
    expect(new Set(reopened.map((record) => record.childAttemptId))).toEqual(
      new Set(branchIds.map((branch) => branch.childAttemptId))
    )
    expect(reopened.every((record) => record.state === 'cancelled')).toBe(true)

    // Cost states and usage restore from durable bytes after restart.
    const reopenedUsage = new DurableUsageLedger({
      store: new SqliteDurableUsageStore(provider),
      now: () => AT,
    })
    for (const record of reopened) {
      const stored = await new SqliteChildUsageOutcomeRepository(
        provider,
        record.delegationId
      ).load()
      expect(stored.revision).toBe(1)
      const restarted = new ChildUsageLedger()
      restarted.restore(stored.snapshot)
      expect(restarted.status(childUsage.get(record.delegationId).identity)).toStrictEqual(
        childUsage
          .get(record.delegationId)
          .ledger.status(childUsage.get(record.delegationId).identity)
      )
      const entries = await reopenedUsage.entries(ids.workspaceId, record.childExecutionId)
      expect(entries.some((entry) => entry.kind === 'settlement')).toBe(true)
    }
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
