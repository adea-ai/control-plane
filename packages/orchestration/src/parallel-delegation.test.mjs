import { describe, expect, test } from 'bun:test'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import {
  ParallelDelegationCoordinator,
  ParallelDelegationError,
  findPromotionConflicts,
} from './parallel-delegation.ts'

const ids = {
  parent: 'exe_01JABCDEF0123456789ABCDEFG',
  childA: 'exe_01JBBCDEF0123456789ABCDEFG',
  childB: 'exe_01JCBCDEF0123456789ABCDEFG',
  group: 'dgr_01JABCDEF0123456789ABCDEFG',
  profile: 'pfv_01JABCDEF0123456789ABCDEFG',
}
const digest = (character) => `sha256:${character.repeat(64)}`

describe('parallel delegation, inherited budgets, and state promotion', () => {
  test('fans out pinned child contexts to independently selected runtimes', async () => {
    const fixture = setup()
    const branches = await fixture.coordinator.fanOut(fanOutInput())

    expect(branches).toHaveLength(2)
    expect(new Set(branches.map(({ contextPackage }) => contextPackage.contentDigest)).size).toBe(2)
    expect(fixture.delegated.map(({ delegationGroupId }) => delegationGroupId)).toEqual([
      ids.group,
      ids.group,
    ])
    expect(fixture.dispatched.map(({ runtime }) => runtime.runtimeConnectionId)).toEqual([
      'rtc_01JABCDEF0123456789ABCDEFG',
      'rtc_01JBBCDEF0123456789ABCDEFG',
    ])
  })

  test('rejects aggregate cost, token, and concurrency exhaustion before side effects', async () => {
    for (const mutate of [
      (input) => (input.parentPlan.constraints.limits.budget.maximumMicrounits = 99),
      (input) => (input.parentPlan.constraints.limits.tokens.maximumTotal = 99),
      (input) => (input.parentPlan.constraints.limits.concurrency.maximumParallel = 1),
    ]) {
      const fixture = setup()
      const input = fanOutInput()
      mutate(input)
      await expect(fixture.coordinator.fanOut(input)).rejects.toBeInstanceOf(
        ParallelDelegationError
      )
      expect(fixture.delegated).toHaveLength(0)
    }
  })

  test('validates every child authority boundary before dispatching any branch', async () => {
    let validationCount = 0
    const fixture = setup({
      deriveChildPlan() {
        validationCount += 1
        if (validationCount === 2) throw new Error('CHILD_SCOPE_EXPANSION')
        return {}
      },
    })
    await expect(fixture.coordinator.fanOut(fanOutInput())).rejects.toThrow('CHILD_SCOPE_EXPANSION')
    expect(fixture.delegated).toHaveLength(0)
    expect(fixture.dispatched).toHaveLength(0)
  })

  test('fans in partial success explicitly and never treats active work as complete', async () => {
    const fixture = setup()
    fixture.children.push(completedRecord(ids.childA, 'art_01JABCDEF0123456789ABCDEFG'), {
      ...completedRecord(ids.childB),
      state: 'failed',
      failureCode: 'RUNTIME_LOST',
    })
    await expect(
      fixture.coordinator.fanIn({
        parentExecutionId: ids.parent,
        delegationGroupId: ids.group,
        allowPartial: false,
      })
    ).rejects.toMatchObject({ code: 'DELEGATION_GROUP_INCOMPLETE' })
    const partial = await fixture.coordinator.fanIn({
      parentExecutionId: ids.parent,
      delegationGroupId: ids.group,
      allowPartial: true,
    })
    expect(partial).toMatchObject({ artifactRefs: ['art_01JABCDEF0123456789ABCDEFG'] })
    expect(partial.failed).toHaveLength(1)
  })

  test('creates reviewable promotions only with the exact child plan and context provenance', async () => {
    const fixture = setup()
    const child = completedRecord(ids.childA, 'art_01JABCDEF0123456789ABCDEFG')
    const input = promotionInput(child)
    const proposal = await fixture.coordinator.createPromotion(input)
    expect(proposal.sourceExecutionId).toBe(ids.childA)
    expect(fixture.promotions[0].operations[0].item.provenance).toMatchObject({
      executionPlan: {
        executionPlanId: child.childExecutionPlanId,
        contentDigest: child.childExecutionPlanDigest,
      },
      contextPackage: {
        contextPackageId: child.contextPackageId,
        contentDigest: child.contextPackageDigest,
      },
    })

    const expanded = globalThis.structuredClone(input)
    expanded.operations[0].item.provenance.contextPackage.contentDigest = digest('f')
    await expect(fixture.coordinator.createPromotion(expanded)).rejects.toMatchObject({
      code: 'PROMOTION_PROVENANCE_MISMATCH',
    })
  })

  test('surfaces competing child writes for review instead of silently overwriting state', () => {
    const child = completedRecord(ids.childA)
    const first = promotionInput(child).operations
    const second = globalThis.structuredClone(first)
    second[0].item.itemId = 'psi_01JBBCDEF0123456789ABCDEFG'
    expect(
      findPromotionConflicts([
        { proposalId: 'spp_01JABCDEF0123456789ABCDEFG', operations: first },
        { proposalId: 'spp_01JBBCDEF0123456789ABCDEFG', operations: second },
      ])
    ).toEqual([
      {
        leftProposalId: 'spp_01JABCDEF0123456789ABCDEFG',
        rightProposalId: 'spp_01JBBCDEF0123456789ABCDEFG',
        target: 'key:research.finding',
      },
    ])
  })
})

test('retains each derived branch context before delegating it when the durable contexts port is provided', async () => {
  let fixture
  const retained = []
  const coordinator = new ParallelDelegationCoordinator({
    contexts: {
      async put(contextPackage) {
        // Capturing how many delegates already happened proves the ordering:
        // the derived context is retained strictly before its child plan.
        retained.push({
          contextPackage,
          delegatesBeforePut: fixture ? fixture.delegated.length : 0,
        })
      },
    },
    delegations: {
      async delegate(input) {
        fixture.delegated.push(input)
        return { record: requestedRecord(input), execution: {}, plan: {} }
      },
      deriveChildPlan: () => ({}),
      async dispatchChild(input) {
        fixture.dispatched.push(input)
        return { record: {}, attempt: {} }
      },
      async listChildren() {
        return []
      },
    },
    projectState: {
      async createPromotionProposal(input) {
        return { ...input, revision: 1, state: 'candidate' }
      },
    },
  })
  fixture = { delegated: [], dispatched: [], coordinator }

  const branches = await coordinator.fanOut(fanOutInput())
  expect(branches).toHaveLength(2)
  // One retained context per branch, each retained BEFORE that branch's
  // delegate call — durable plan repositories need the row to exist first.
  expect(retained).toHaveLength(2)
  expect(retained.map((entry) => entry.delegatesBeforePut)).toStrictEqual([0, 1])
  expect(new Set(retained.map((entry) => entry.contextPackage.contentDigest)).size).toBe(2)
  expect(retained.map((entry) => entry.contextPackage.contentDigest).toSorted()).toStrictEqual(
    fixture.delegated.map((input) => input.childPlan.contextPackage.contentDigest).toSorted()
  )
})

function setup(options = {}) {
  const delegated = []
  const dispatched = []
  const children = []
  const promotions = []
  const coordinator = new ParallelDelegationCoordinator({
    ...(options.contexts ? { contexts: options.contexts } : {}),
    delegations: {
      async delegate(input) {
        delegated.push(input)
        return {
          record: requestedRecord(input),
          execution: {},
          plan: {},
        }
      },
      deriveChildPlan: options.deriveChildPlan ?? (() => ({})),
      async dispatchChild(input) {
        dispatched.push(input)
        return { record: {}, attempt: {} }
      },
      async listChildren() {
        return children
      },
    },
    projectState: {
      async createPromotionProposal(input) {
        promotions.push(input)
        return { ...input, revision: 1, state: 'candidate' }
      },
    },
  })
  return { coordinator, delegated, dispatched, children, promotions }
}

function fanOutInput() {
  return {
    delegationGroupId: ids.group,
    parentExecutionId: ids.parent,
    parentContextPackage: contextPackageSerializationFixtures.futurePi,
    parentPlan: {
      profile: { profileVersionId: ids.profile },
      constraints: {
        limits: {
          budget: { currency: 'USD', maximumMicrounits: 1_000 },
          tokens: { maximumTotal: 1_000 },
          duration: { maximumMs: 60_000 },
          concurrency: { maximumParallel: 2 },
          childExecutions: { maximumTotal: 4, maximumDepth: 2 },
        },
      },
    },
    acceptedAt: '2026-08-25T19:00:00.000Z',
    deadlineAt: '2026-08-25T19:01:00.000Z',
    branches: [
      branch('A', 'dlg_01JABCDEF0123456789ABCDEFG', ids.childA),
      branch('B', 'dlg_01JBBCDEF0123456789ABCDEFG', ids.childB),
    ],
  }
}

function branch(suffix, delegationId, childExecutionId) {
  return {
    delegationId,
    childExecutionId,
    childAttemptId: `att_01J${suffix}BCDEF0123456789ABCDEFG`,
    role: suffix === 'A' ? 'researcher' : 'implementer',
    objective: `Complete branch ${suffix}`,
    context: {
      allowedStateItemIds: [],
      allowedArtifactIds: [],
      maximumBytes: 512,
      maximumTokens: 128,
      successCriteria: [`Return branch ${suffix}`],
      returnContractRef: 'contract://adapter-result/v1',
    },
    childPlan: {
      constraints: {
        limits: {
          budget: { maximumMicrounits: 400 },
          tokens: { maximumTotal: 400 },
          duration: { maximumMs: 30_000 },
        },
      },
      compiledAt: `2026-08-25T19:00:0${suffix === 'A' ? 1 : 2}.000Z`,
    },
    policy: {
      cancellation: 'cascade',
      deadline: 'bounded_by_parent',
      failure: 'allow_partial',
      maximumRetries: 0,
    },
    runtime: {
      runtimeConnectionId:
        suffix === 'A' ? 'rtc_01JABCDEF0123456789ABCDEFG' : 'rtc_01JBBCDEF0123456789ABCDEFG',
    },
  }
}

function requestedRecord(input) {
  return {
    ...completedRecord(input.childExecutionId),
    delegationId: input.delegationId,
    delegationGroupId: input.delegationGroupId,
    state: 'requested',
  }
}

function completedRecord(childExecutionId, terminalResultRef) {
  return {
    delegationId:
      childExecutionId === ids.childA
        ? 'dlg_01JABCDEF0123456789ABCDEFG'
        : 'dlg_01JBBCDEF0123456789ABCDEFG',
    delegationGroupId: ids.group,
    parentExecutionId: ids.parent,
    childExecutionId,
    parentExecutionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    parentExecutionPlanDigest: digest('a'),
    childExecutionPlanId: 'pln_01JBBCDEF0123456789ABCDEFG',
    childExecutionPlanDigest: digest('b'),
    contextPackageId: 'ctx_01JABCDEF0123456789ABCDEFG',
    contextPackageDigest: digest('c'),
    role: 'researcher',
    profileVersionId: ids.profile,
    objective: 'Complete bounded work',
    policy: {
      cancellation: 'cascade',
      deadline: 'bounded_by_parent',
      failure: 'allow_partial',
      maximumRetries: 0,
    },
    state: 'completed',
    retryCount: 0,
    inputDigest: digest('d'),
    revision: 3,
    acceptedAt: '2026-08-25T19:00:00.000Z',
    updatedAt: '2026-08-25T19:01:00.000Z',
    ...(terminalResultRef ? { terminalResultRef } : {}),
  }
}

function promotionInput(child) {
  return {
    proposalId: 'spp_01JABCDEF0123456789ABCDEFG',
    workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
    projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    baseRevision: 1,
    child,
    operations: [
      {
        kind: 'append',
        item: {
          itemId: 'psi_01JABCDEF0123456789ABCDEFG',
          key: 'research.finding',
          value: { result: 'bounded' },
          sensitivity: 'internal',
          freshness: { observedAt: '2026-08-25T19:01:00.000Z' },
          provenance: {
            sourceKind: 'execution',
            sourceExecutionId: child.childExecutionId,
            sourcePrincipalRef: 'principal://control-plane/runtime-worker',
            artifactRefs: child.terminalResultRef ? [child.terminalResultRef] : [],
            executionPlan: {
              executionPlanId: child.childExecutionPlanId,
              contentDigest: child.childExecutionPlanDigest,
            },
            contextPackage: {
              contextPackageId: child.contextPackageId,
              contentDigest: child.contextPackageDigest,
            },
            capturedAt: '2026-08-25T19:01:00.000Z',
          },
        },
      },
    ],
    createdAt: '2026-08-25T19:01:00.000Z',
    expiresAt: '2026-08-26T19:01:00.000Z',
  }
}
