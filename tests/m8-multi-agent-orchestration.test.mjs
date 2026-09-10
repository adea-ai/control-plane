import { describe, expect, test } from 'bun:test'
import { MemorySaver } from '@langchain/langgraph'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import {
  ExecutionLifecycleService,
  InMemoryExecutionRepository,
  InMemoryProjectStateRepository,
  InMemoryStatePromotionProposalRepository,
  ProjectStateService,
  RecordingProjectStateEventPublisher,
  executionConstraintFixtures,
} from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  InMemoryExecutionPlanRepository,
} from '@control-plane/execution-plan'
import {
  LangGraphOrchestrationAdapter,
  deterministicInterruptGraph,
} from '@control-plane/langgraph-adapter'
import {
  DelegationService,
  InMemoryDelegationRepository,
  ParallelDelegationCoordinator,
  ParallelDelegationError,
  findPromotionConflicts,
} from '@control-plane/orchestration'
import { InMemoryUsageLedger } from '@control-plane/usage-ledger'
import { OrchestrationGraphSegmentActivities } from '../apps/workflow-worker/dist/graph-segment-activity.js'

const digest = (character) => `sha256:${character.repeat(64)}`
const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  projectId: 'prj_01JABCDEF0123456789ABCDEFG',
  taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
  researchTaskId: 'tsk_01JBBCDEF0123456789ABCDEFG',
  implementationTaskId: 'tsk_01JCBCDEF0123456789ABCDEFG',
  agentId: 'agt_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  researchRequestId: 'req_01JBBCDEF0123456789ABCDEFG',
  implementationRequestId: 'req_01JCBCDEF0123456789ABCDEFG',
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  skillId: 'skl_01JABCDEF0123456789ABCDEFG',
  skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  researchExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  implementationExecutionId: 'exe_01JCBCDEF0123456789ABCDEFG',
  researchAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
  implementationAttemptId: 'att_01JCBCDEF0123456789ABCDEFG',
  researchDelegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
  implementationDelegationId: 'dlg_01JBBCDEF0123456789ABCDEFG',
  groupId: 'dgr_01JABCDEF0123456789ABCDEFG',
  workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
}

describe('M8 multi-agent orchestration acceptance', () => {
  test('runs a durable manager, parallel children, approval recovery, fan-in, promotion, and settlement', async () => {
    const fixture = await createFixture()
    const graph = await runManagerApprovalAcrossRestart()
    expect(graph).toMatchObject({
      interrupted: { outcome: 'awaiting_input' },
      resumed: {
        outcome: 'completed',
      },
    })

    const branches = await fixture.parallel.fanOut(fanOutInput(fixture.parentPlan))
    expect(branches.map(({ record }) => record.childExecutionId)).toEqual([
      ids.researchExecutionId,
      ids.implementationExecutionId,
    ])
    expect(branches.map(({ record }) => record.runtimeConnectionId)).toEqual([
      'rtc_01JABCDEF0123456789ABCDEFG',
      'rtc_01JBBCDEF0123456789ABCDEFG',
    ])
    expect(branches.every(({ record }) => record.parentExecutionId === ids.parentExecutionId)).toBe(
      true
    )
    expect(branches.every(({ contextPackage }) => contextPackage.parentContextPackage)).toBe(true)

    await completeChild(
      fixture.delegations,
      ids.researchDelegationId,
      'art_01JBBCDEF0123456789ABCDEFG'
    )
    await completeChild(
      fixture.delegations,
      ids.implementationDelegationId,
      'art_01JCBCDEF0123456789ABCDEFG'
    )
    const fanIn = await fixture.parallel.fanIn({
      parentExecutionId: ids.parentExecutionId,
      delegationGroupId: ids.groupId,
      allowPartial: false,
    })
    expect(fanIn.artifactRefs).toEqual([
      'art_01JBBCDEF0123456789ABCDEFG',
      'art_01JCBCDEF0123456789ABCDEFG',
    ])

    const proposals = []
    for (const [index, child] of fanIn.completed.entries()) {
      const proposal = await fixture.parallel.createPromotion({
        proposalId:
          index === 0 ? 'spp_01JABCDEF0123456789ABCDEFG' : 'spp_01JBBCDEF0123456789ABCDEFG',
        workspaceId: ids.workspaceId,
        projectId: ids.projectId,
        baseRevision: 0,
        child,
        operations: [promotionOperation(child, index)],
        createdAt: `2026-08-25T20:0${index + 3}:00.000Z`,
        expiresAt: '2026-08-26T20:00:00.000Z',
      })
      expect(proposal.state).toBe('candidate')
      const approved = await fixture.projectState.approvePromotion({
        proposalId: proposal.proposalId,
        reviewingPrincipalRef: 'principal://agent-hq/user/42',
        reviewedAt: `2026-08-25T20:0${index + 5}:00.000Z`,
      })
      proposals.push(
        await fixture.projectState.mergePromotion({
          proposalId: approved.proposalId,
          mutationId:
            index === 0 ? 'stm_01JABCDEF0123456789ABCDEFG' : 'stm_01JBBCDEF0123456789ABCDEFG',
          mergedAt: `2026-08-25T20:0${index + 7}:00.000Z`,
        })
      )
    }
    expect(proposals.map(({ state }) => state)).toEqual(['merged', 'merged'])
    expect(
      (
        await fixture.projectState.getHistory({
          workspaceId: ids.workspaceId,
          projectId: ids.projectId,
        })
      ).at(-1).revision
    ).toBe(2)

    const replay = await fixture.delegations.recordChildProgress({
      delegationId: ids.researchDelegationId,
      state: 'completed',
      observedAt: '2026-08-25T20:02:00.000Z',
      terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
    })
    expect(replay.record.state).toBe('completed')

    const parentQueued = await fixture.lifecycle.transitionExecution({
      executionId: ids.parentExecutionId,
      expectedVersion: 1,
      to: 'queued',
      transitionedAt: '2026-08-25T20:00:00.000Z',
    })
    const parentRunning = await fixture.lifecycle.transitionExecution({
      executionId: ids.parentExecutionId,
      expectedVersion: parentQueued.version,
      to: 'running',
      transitionedAt: '2026-08-25T20:01:00.000Z',
    })
    const parentCompleted = await fixture.lifecycle.transitionExecution({
      executionId: ids.parentExecutionId,
      expectedVersion: parentRunning.version,
      to: 'completed',
      transitionedAt: '2026-08-25T20:10:00.000Z',
      terminalResultRef: 'art_01JABCDEF0123456789ABCDEFG',
    })
    expect(parentCompleted.state).toBe('completed')

    const ledger = settlementLedger()
    for (const childExecutionId of [ids.researchExecutionId, ids.implementationExecutionId]) {
      ledger.openBudget({
        workspaceId: ids.workspaceId,
        executionId: childExecutionId,
        parentExecutionId: ids.parentExecutionId,
        currency: 'USD',
        maximumMicrounits: 400_000,
        maximumTokens: 4_000,
        source: {
          sourceId: `child:${childExecutionId}`,
          idempotencyKey: `budget:${childExecutionId}`,
        },
      })
      ledger.settle({
        workspaceId: ids.workspaceId,
        executionId: ids.parentExecutionId,
        reservationKey: `child:${childExecutionId}`,
        source: {
          sourceId: `child:${childExecutionId}`,
          idempotencyKey: `settle:${childExecutionId}`,
        },
      })
    }
    expect(ledger.summary(ids.workspaceId, ids.parentExecutionId)).toMatchObject({
      reservedMicrounits: 0,
      settled: true,
    })
    expect(fixture.events.some(({ type }) => type === 'delegation.completed')).toBe(true)
  })

  test('converges required runtime, cancellation, budget, privilege, conflict, and duplicate failures', async () => {
    const runtimeFixture = await createFixture()
    await runtimeFixture.parallel.fanOut({
      ...fanOutInput(runtimeFixture.parentPlan),
      branches: [fanOutInput(runtimeFixture.parentPlan).branches[0]],
    })
    await runtimeFixture.delegations.recordChildProgress({
      delegationId: ids.researchDelegationId,
      state: 'running',
      observedAt: '2026-08-25T20:01:00.000Z',
    })
    const unavailable = await runtimeFixture.delegations.recordChildProgress({
      delegationId: ids.researchDelegationId,
      state: 'failed',
      observedAt: '2026-08-25T20:02:00.000Z',
      failure: {
        classification: 'runtime_unavailable',
        code: 'RUNTIME_LOST',
        retryable: true,
      },
    })
    expect(unavailable).toMatchObject({ resolution: 'retry', record: { state: 'requested' } })

    const cancellationFixture = await createFixture()
    await cancellationFixture.parallel.fanOut({
      ...fanOutInput(cancellationFixture.parentPlan),
      branches: [fanOutInput(cancellationFixture.parentPlan).branches[0]],
    })
    await cancellationFixture.delegations.cancelChildren({
      parentExecutionId: ids.parentExecutionId,
      cancelledAt: '2026-08-25T20:01:00.000Z',
    })
    await expect(
      cancellationFixture.delegations.recordChildProgress({
        delegationId: ids.researchDelegationId,
        state: 'completed',
        observedAt: '2026-08-25T20:01:00.000Z',
        terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
      })
    ).rejects.toMatchObject({ code: 'DELEGATION_STATE_CONFLICT' })

    const budgetInput = fanOutInput((await createFixture()).parentPlan)
    budgetInput.branches[0].childPlan.constraints.limits.budget.maximumMicrounits = 9_000_000
    budgetInput.branches[1].childPlan.constraints.limits.budget.maximumMicrounits = 9_000_000
    await expect((await createFixture()).parallel.fanOut(budgetInput)).rejects.toBeInstanceOf(
      ParallelDelegationError
    )
    const ledger = settlementLedger()
    ledger.openBudget({
      workspaceId: ids.workspaceId,
      executionId: ids.researchExecutionId,
      parentExecutionId: ids.parentExecutionId,
      currency: 'USD',
      maximumMicrounits: 10_000_000,
      maximumTokens: 1,
      source: { sourceId: 'child:research', idempotencyKey: 'budget:all' },
    })
    expect(() =>
      ledger.openBudget({
        workspaceId: ids.workspaceId,
        executionId: ids.implementationExecutionId,
        parentExecutionId: ids.parentExecutionId,
        currency: 'USD',
        maximumMicrounits: 1,
        maximumTokens: 1,
        source: { sourceId: 'child:research', idempotencyKey: 'budget:overflow' },
      })
    ).toThrow('BUDGET_EXHAUSTED')

    const privilegeFixture = await createFixture()
    const privilegeInput = fanOutInput(privilegeFixture.parentPlan)
    privilegeInput.branches[1].childPlan.constraints.tools.grants[0].operations.push('admin')
    await expect(privilegeFixture.parallel.fanOut(privilegeInput)).rejects.toThrow()
    expect(await privilegeFixture.delegations.listChildren(ids.parentExecutionId)).toHaveLength(0)

    const child = completedRecordForConflict()
    const first = promotionOperation(child, 0)
    const second = globalThis.structuredClone(first)
    second.item.itemId = 'psi_01JCBCDEF0123456789ABCDEFG'
    expect(
      findPromotionConflicts([
        { proposalId: 'spp_01JABCDEF0123456789ABCDEFG', operations: [first] },
        { proposalId: 'spp_01JBBCDEF0123456789ABCDEFG', operations: [second] },
      ])
    ).toHaveLength(1)

    const duplicateFixture = await createFixture()
    const [duplicateBranch] = await duplicateFixture.parallel.fanOut({
      ...fanOutInput(duplicateFixture.parentPlan),
      branches: [fanOutInput(duplicateFixture.parentPlan).branches[0]],
    })
    const duplicateDispatch = await duplicateFixture.delegations.dispatchChild({
      delegationId: duplicateBranch.record.delegationId,
      childAttemptId: ids.researchAttemptId,
      runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
      dispatchedAt: '2026-08-25T20:00:00.000Z',
    })
    expect(duplicateDispatch.record.childAttemptId).toBe(ids.researchAttemptId)
  })
})

async function runManagerApprovalAcrossRestart() {
  const checkpointer = new MemorySaver()
  const graph = {
    graphDefinitionId: 'manager-graph',
    graphVersion: '1.0.0',
    contentDigest: digest('e'),
  }
  const options = {
    graphs: [deterministicInterruptGraph(graph)],
    checkpointer,
    operations: {
      async invoke(operation) {
        return {
          value:
            operation.name === 'finalize'
              ? { artifactRef: 'art_01JABCDEF0123456789ABCDEFG' }
              : operation.name,
        }
      },
      async cancel() {
        return true
      },
    },
    events: { async publish() {} },
    now: () => '2026-08-25T20:00:00.000Z',
  }
  const base = {
    executionId: ids.parentExecutionId,
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    workspaceId: ids.workspaceId,
    workflowId: ids.workflowId,
    graph,
    threadId: 'manager-thread-m8',
    idempotencyKey: 'm8:manager:segment',
  }
  const firstWorker = new OrchestrationGraphSegmentActivities(
    new LangGraphOrchestrationAdapter(options)
  )
  const interrupted = await firstWorker.runGraphSegment({
    ...base,
    input: { objective: 'Coordinate bounded children' },
  })
  const restartedWorker = new OrchestrationGraphSegmentActivities(
    new LangGraphOrchestrationAdapter(options)
  )
  const resumed = await restartedWorker.resumeGraphSegment({
    ...base,
    checkpointId: interrupted.checkpointId,
    response: { action: 'approve' },
  })
  return { interrupted, resumed }
}

async function createFixture() {
  const parentPlan = compileParentPlan()
  const executions = new InMemoryExecutionRepository()
  const lifecycle = new ExecutionLifecycleService(executions)
  const plans = new InMemoryExecutionPlanRepository()
  await plans.put(parentPlan)
  await lifecycle.createExecution({
    executionId: ids.parentExecutionId,
    correlation: parentPlan.correlation,
    executionPlan: {
      executionPlanId: parentPlan.executionPlanId,
      contentDigest: parentPlan.contentDigest,
      schemaVersion: parentPlan.schemaVersion,
    },
    acceptedAt: '2026-08-25T20:00:00.000Z',
    deadlineAt: '2026-08-25T21:00:00.000Z',
  })
  const events = []
  const delegations = new DelegationService({
    delegations: new InMemoryDelegationRepository(),
    lifecycle,
    plans,
    events: {
      async publish(event) {
        events.push(event)
      },
    },
  })
  const projectState = new ProjectStateService(
    new InMemoryProjectStateRepository(),
    new InMemoryStatePromotionProposalRepository(),
    new RecordingProjectStateEventPublisher()
  )
  await projectState.initialize({
    workspaceId: ids.workspaceId,
    projectId: ids.projectId,
    at: '2026-08-25T19:59:00.000Z',
  })
  const parallel = new ParallelDelegationCoordinator({ delegations, projectState })
  return { parentPlan, lifecycle, delegations, projectState, parallel, events }
}

function fanOutInput(parentPlan) {
  return {
    delegationGroupId: ids.groupId,
    parentExecutionId: ids.parentExecutionId,
    parentPlan,
    parentContextPackage: contextPackageSerializationFixtures.futurePi,
    acceptedAt: '2026-08-25T20:00:00.000Z',
    deadlineAt: '2026-08-25T20:30:00.000Z',
    branches: [
      branch(parentPlan, {
        delegationId: ids.researchDelegationId,
        childExecutionId: ids.researchExecutionId,
        childAttemptId: ids.researchAttemptId,
        taskId: ids.researchTaskId,
        requestId: ids.researchRequestId,
        role: 'researcher',
        runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
        compiledAt: '2026-08-25T20:00:01.000Z',
      }),
      branch(parentPlan, {
        delegationId: ids.implementationDelegationId,
        childExecutionId: ids.implementationExecutionId,
        childAttemptId: ids.implementationAttemptId,
        taskId: ids.implementationTaskId,
        requestId: ids.implementationRequestId,
        role: 'implementer',
        runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG',
        compiledAt: '2026-08-25T20:00:02.000Z',
      }),
    ],
  }
}

function branch(parentPlan, input) {
  const constraints = globalThis.structuredClone(parentPlan.constraints)
  constraints.tools.grants[0].operations = ['read']
  constraints.limits.budget.maximumMicrounits = 400_000
  constraints.limits.tokens.maximumTotal = 4_000
  constraints.limits.duration.maximumMs = 1_800_000
  constraints.limits.concurrency.maximumParallel = 1
  return {
    delegationId: input.delegationId,
    childExecutionId: input.childExecutionId,
    childAttemptId: input.childAttemptId,
    role: input.role,
    objective: `Complete ${input.role} branch`,
    context: {
      allowedStateItemIds: [],
      allowedArtifactIds: [],
      maximumBytes: 512,
      maximumTokens: 128,
      successCriteria: [`Return ${input.role} artifact`],
      returnContractRef: 'contract://adapter-result/v1',
    },
    childPlan: {
      correlation: {
        ...parentPlan.correlation,
        taskId: input.taskId,
        requestId: input.requestId,
      },
      constraints,
      runtimeRequirements: parentPlan.runtimeRequirements,
      outputContract: parentPlan.outputContract,
      compiledAt: input.compiledAt,
    },
    policy: {
      cancellation: 'cascade',
      deadline: 'bounded_by_parent',
      failure: 'retry',
      maximumRetries: 1,
    },
    runtime: { runtimeConnectionId: input.runtimeConnectionId },
  }
}

async function completeChild(service, delegationId, terminalResultRef) {
  await service.recordChildProgress({
    delegationId,
    state: 'running',
    observedAt: '2026-08-25T20:01:00.000Z',
  })
  return service.recordChildProgress({
    delegationId,
    state: 'completed',
    observedAt: '2026-08-25T20:02:00.000Z',
    terminalResultRef,
  })
}

function promotionOperation(child, index) {
  return {
    kind: 'append',
    item: {
      itemId: index === 0 ? 'psi_01JABCDEF0123456789ABCDEFG' : 'psi_01JBBCDEF0123456789ABCDEFG',
      key: index === 0 ? 'research.finding' : 'implementation.result',
      value: { artifactRef: child.terminalResultRef },
      sensitivity: 'internal',
      freshness: { observedAt: '2026-08-25T20:02:00.000Z' },
      provenance: {
        sourceKind: 'execution',
        sourceExecutionId: child.childExecutionId,
        sourcePrincipalRef: 'principal://control-plane/runtime-worker',
        artifactRefs: [child.terminalResultRef],
        executionPlan: {
          executionPlanId: child.childExecutionPlanId,
          contentDigest: child.childExecutionPlanDigest,
        },
        contextPackage: {
          contextPackageId: child.contextPackageId,
          contentDigest: child.contextPackageDigest,
        },
        capturedAt: '2026-08-25T20:02:00.000Z',
      },
    },
  }
}

function settlementLedger() {
  const ledger = new InMemoryUsageLedger({ now: () => '2026-08-25T20:10:00.000Z' })
  ledger.openBudget({
    workspaceId: ids.workspaceId,
    executionId: ids.parentExecutionId,
    currency: 'USD',
    maximumMicrounits: 10_000_000,
    maximumTokens: 250_000,
    source: { sourceId: 'manager:m8', idempotencyKey: 'budget:manager:m8' },
  })
  return ledger
}

function completedRecordForConflict() {
  return {
    childExecutionId: ids.researchExecutionId,
    childExecutionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    childExecutionPlanDigest: digest('a'),
    contextPackageId: contextPackageSerializationFixtures.futurePi.contextPackageId,
    contextPackageDigest: contextPackageSerializationFixtures.futurePi.contentDigest,
    terminalResultRef: 'art_01JABCDEF0123456789ABCDEFG',
  }
}

function compileParentPlan() {
  const constraints = globalThis.structuredClone(executionConstraintFixtures.write)
  const skill = {
    skillVersionId: ids.skillVersionId,
    skillId: ids.skillId,
    revision: 1,
    lifecycle: 'published',
    manifest: {
      schemaVersion: 1,
      semanticVersion: '1.0.0',
      contentDigest: digest('b'),
      requiredCapabilities: ['filesystem.read'],
      requiredTools: [{ toolId: 'project-files', versionRange: '^1.0.0' }],
      compatibleProfileSchemaVersions: [1],
      compatibleContractMajorVersions: [1],
    },
    content: { instructions: 'Coordinate bounded child work.', artifactRefs: [] },
    createdAt: '2026-08-25T19:00:00.000Z',
    lifecycleMetadata: { publishedAt: '2026-08-25T19:00:00.000Z' },
  }
  return new ExecutionPlanCompiler('1.0.0').compile({
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      agentId: ids.agentId,
      requestId: ids.requestId,
    },
    profile: {
      profileVersionId: ids.profileVersionId,
      profileId: ids.profileId,
      version: 1,
      revision: 1,
      lifecycle: 'published',
      contentDigest: digest('a'),
      definition: {
        schemaVersion: 1,
        roleInstructions: 'Manage parallel child agents safely.',
        skills: [
          {
            skillId: ids.skillId,
            skillVersionId: ids.skillVersionId,
            contentDigest: digest('b'),
          },
        ],
        capabilityRequirements: ['filesystem.read'],
        executionConstraints: constraints,
        outputContractRefs: ['contract://execution-result/v1'],
      },
      createdAt: '2026-08-25T19:00:00.000Z',
      lifecycleMetadata: { publishedAt: '2026-08-25T19:00:00.000Z' },
    },
    skills: [skill],
    contextPackage: globalThis.structuredClone(contextPackageSerializationFixtures.futurePi),
    constraints,
    requestConstraints: [],
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
    ],
    outputContract: { contractRef: 'contract://execution-result/v1' },
    compiledAt: '2026-08-25T19:00:00.000Z',
  })
}
