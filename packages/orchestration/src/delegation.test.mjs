import { describe, expect, test } from 'bun:test'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import {
  ExecutionLifecycleService,
  InMemoryExecutionRepository,
  executionConstraintFixtures,
} from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  ExecutionPlanError,
  InMemoryExecutionPlanRepository,
} from '@control-plane/execution-plan'
import {
  GraphDefinitionCatalog,
  GraphDefinitionExecutionAuthority,
  InMemoryGraphDefinitionRepository,
} from './graph-catalog.ts'
import {
  DelegationService,
  delegationInputLegacyDigest,
  InMemoryDelegationRepository,
  decideDelegationFailure,
} from './delegation.ts'

const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  projectId: 'prj_01JABCDEF0123456789ABCDEFG',
  taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
  childTaskId: 'tsk_01JBBCDEF0123456789ABCDEFG',
  agentId: 'agt_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  childRequestId: 'req_01JBBCDEF0123456789ABCDEFG',
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  skillId: 'skl_01JABCDEF0123456789ABCDEFG',
  skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  childExecutionId: 'exe_01JBBCDEF0123456789ABCDEFG',
  childAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
  delegationId: 'dlg_01JABCDEF0123456789ABCDEFG',
}
const digest = (character) => `sha256:${character.repeat(64)}`

describe('durable parent and child delegation', () => {
  test('creates a first-class child with immutable narrowed plan and inspectable lineage', async () => {
    const fixture = await createFixture()
    const delegated = await fixture.service.delegate(delegationInput(fixture))
    expect(delegated.execution).toMatchObject({
      executionId: ids.childExecutionId,
      parentExecutionId: ids.parentExecutionId,
      state: 'accepted',
    })
    expect(delegated.plan.parentExecutionPlan).toEqual({
      executionPlanId: fixture.parentPlan.executionPlanId,
      contentDigest: fixture.parentPlan.contentDigest,
    })
    expect(delegated.plan.constraints.tools.grants[0].operations).toEqual(['read'])
    expect((await fixture.service.listChildren(ids.parentExecutionId))[0]).toMatchObject({
      delegationId: ids.delegationId,
      childExecutionId: ids.childExecutionId,
      role: 'researcher',
    })

    const replay = await fixture.service.delegate(delegationInput(fixture))
    expect(replay.record).toEqual(delegated.record)
    expect(await fixture.executions.listAttempts(ids.childExecutionId)).toHaveLength(0)
  })

  test('rejects every child authority expansion before durable child creation', async () => {
    const fixture = await createFixture()
    const input = delegationInput(fixture)
    input.childPlan.constraints.tools.grants[0].operations.push('admin')
    await expect(fixture.service.delegate(input)).rejects.toBeInstanceOf(ExecutionPlanError)
    await expect(fixture.lifecycle.getExecution(ids.childExecutionId)).rejects.toMatchObject({
      code: 'EXECUTION_MISSING',
    })
  })

  for (const scenario of [
    'missing-authority',
    'unpublished',
    'wrong-digest',
    'wrong-workspace',
    'incompatible',
    'invalid-input',
    'deprecated',
    'revoked',
  ]) {
    test(`rejects child graph admission before persistence: ${scenario}`, async () => {
      const graph = await graphFixture(scenario)
      const fixture = await createFixture(
        scenario === 'missing-authority' ? undefined : graph.authority
      )
      const input = delegationInput(fixture)
      input.childPlan.graph = graph.selection
      const derived = fixture.service.deriveChildPlan(input.parentPlan, input.childPlan)
      await expect(fixture.service.delegate(input)).rejects.toMatchObject({
        code: 'GRAPH_ADMISSION_DENIED',
      })
      expect(await fixture.plans.get(derived)).toBeUndefined()
      await expect(fixture.lifecycle.getExecution(ids.childExecutionId)).rejects.toMatchObject({
        code: 'EXECUTION_MISSING',
      })
      expect(await fixture.service.listChildren(ids.parentExecutionId)).toEqual([])
      expect(fixture.events).toEqual([])
    })
  }

  test('accepts an admitted child graph and replays the same child after deprecation', async () => {
    const graph = await graphFixture()
    const fixture = await createFixture(graph.authority)
    const input = delegationInput(fixture)
    input.childPlan.graph = graph.selection
    const accepted = await fixture.service.delegate(input)
    expect(accepted.plan.graph).toEqual(graph.selection)
    expect(await fixture.plans.get(accepted.plan)).toEqual(accepted.plan)
    await graph.catalog.deprecate({
      reference: graph.selection.reference,
      expectedRevision: 1,
      changedAt: '2026-08-25T18:02:00.000Z',
      reason: 'replaced',
    })
    expect(await fixture.service.delegate(input)).toEqual(accepted)
    const unauthorized = new DelegationService({
      delegations: fixture.delegations,
      lifecycle: fixture.lifecycle,
      plans: fixture.plans,
      events: { async publish() {} },
    })
    await expect(unauthorized.delegate(input)).rejects.toMatchObject({
      code: 'GRAPH_ADMISSION_DENIED',
    })
    expect(await fixture.service.listChildren(ids.parentExecutionId)).toHaveLength(1)
    expect(fixture.events).toHaveLength(1)
  })

  test('dispatches the child independently to another runtime and emits parent progress', async () => {
    const fixture = await createFixture()
    await fixture.service.delegate(delegationInput(fixture))
    const dispatched = await fixture.service.dispatchChild({
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      runtime: {
        runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG',
        runtimeDefinitionId: 'rtd_01JBBCDEF0123456789ABCDEFG',
      },
      dispatchedAt: '2026-08-25T18:02:00.000Z',
    })
    expect(dispatched.attempt.runtime.runtimeConnectionId).toBe('rtc_01JBBCDEF0123456789ABCDEFG')
    expect(fixture.events.at(-1)).toMatchObject({
      type: 'delegation.dispatched',
      parentExecutionId: ids.parentExecutionId,
      childExecutionId: ids.childExecutionId,
    })
  })

  test('normalizes child progress and a duplicate durable result into parent events', async () => {
    const fixture = await createFixture()
    await fixture.service.delegate(delegationInput(fixture))
    await fixture.service.dispatchChild({
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
      dispatchedAt: '2026-08-25T18:02:00.000Z',
    })
    await fixture.service.recordChildProgress({
      delegationId: ids.delegationId,
      state: 'running',
      observedAt: '2026-08-25T18:02:10.000Z',
    })
    const completedInput = {
      delegationId: ids.delegationId,
      state: 'completed',
      observedAt: '2026-08-25T18:03:00.000Z',
      terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
    }
    const completed = await fixture.service.recordChildProgress(completedInput)
    const replay = await fixture.service.recordChildProgress(completedInput)

    expect(replay.record).toEqual(completed.record)
    expect((await fixture.lifecycle.getExecution(ids.childExecutionId)).state).toBe('completed')
    expect(fixture.events.slice(-2).map(({ type }) => type)).toEqual([
      'delegation.progress',
      'delegation.completed',
    ])
  })

  test('replays a retained terminal outcome after publication fails', async () => {
    const fixture = await createFixture()
    await fixture.service.delegate(delegationInput(fixture))
    await fixture.service.dispatchChild({
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
      dispatchedAt: '2026-08-25T18:02:00.000Z',
    })
    await fixture.service.recordChildProgress({
      delegationId: ids.delegationId,
      state: 'running',
      observedAt: '2026-08-25T18:02:10.000Z',
    })
    const completion = {
      delegationId: ids.delegationId,
      state: 'completed',
      observedAt: '2026-08-25T18:03:00.000Z',
      terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
    }
    const interrupted = new DelegationService({
      ...fixture,
      events: {
        async publish() {
          throw new Error('publication unavailable')
        },
      },
    })
    await expect(interrupted.recordChildProgress(completion)).rejects.toThrow(
      'publication unavailable'
    )
    expect((await fixture.delegations.get(ids.delegationId)).state).toBe('completed')
    await fixture.service.recordChildProgress(completion)
    expect(fixture.events.filter((event) => event.type === 'delegation.completed')).toHaveLength(1)
  })

  test('recovers publication acknowledged by the inbox before the sender loses its receipt', async () => {
    const fixture = await createFixture()
    await fixture.service.delegate(delegationInput(fixture))
    await fixture.service.dispatchChild({
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
      dispatchedAt: '2026-08-25T18:02:00.000Z',
    })
    await fixture.service.recordChildProgress({
      delegationId: ids.delegationId,
      state: 'running',
      observedAt: '2026-08-25T18:02:10.000Z',
    })
    const inbox = new Map()
    const deliveredKeys = []
    const events = {
      async publish(event, key) {
        deliveredKeys.push(key)
        inbox.set(key, event)
      },
    }
    const interrupted = new DelegationService({
      ...fixture,
      delegations: {
        get: (id) => fixture.delegations.get(id),
        compareAndSet: (revision, record) =>
          record.terminalPublication?.status === 'published'
            ? Promise.reject(new Error('crashed before acknowledgement'))
            : fixture.delegations.compareAndSet(revision, record),
      },
      events,
    })
    const completion = {
      delegationId: ids.delegationId,
      state: 'completed',
      observedAt: '2026-08-25T18:03:00.000Z',
      terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFG',
    }
    await expect(interrupted.recordChildProgress(completion)).rejects.toThrow(
      'crashed before acknowledgement'
    )
    const pending = await fixture.delegations.get(ids.delegationId)
    expect(pending.terminalPublication.status).toBe('pending')
    const restarted = new DelegationService({ ...fixture, events })
    await restarted.reconcileChildPublications(ids.parentExecutionId)
    expect((await fixture.delegations.get(ids.delegationId)).terminalPublication.status).toBe(
      'published'
    )
    expect(new Set(deliveredKeys).size).toBe(1)
    expect(deliveredKeys).toHaveLength(2)
    expect(inbox.size).toBe(1)
    await restarted.recordChildProgress({ ...completion, observedAt: '2026-08-25T18:04:00.000Z' })
    await expect(
      restarted.recordChildProgress({
        ...completion,
        terminalResultRef: 'art_01JBBCDEF0123456789ABCDEFH',
      })
    ).rejects.toMatchObject({ code: 'DELEGATION_STATE_CONFLICT' })
    expect(deliveredKeys).toHaveLength(2)
    expect(JSON.stringify(pending.terminalPublication)).not.toContain(
      'Research the bounded question'
    )
  })

  test('retries a failed attempt without terminating the stable child execution', async () => {
    const fixture = await createFixture()
    await fixture.service.delegate(delegationInput(fixture))
    await fixture.service.dispatchChild({
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      runtime: { runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG' },
      dispatchedAt: '2026-08-25T18:02:00.000Z',
    })
    await fixture.service.recordChildProgress({
      delegationId: ids.delegationId,
      state: 'running',
      observedAt: '2026-08-25T18:02:10.000Z',
    })
    const failed = await fixture.service.recordChildProgress({
      delegationId: ids.delegationId,
      state: 'failed',
      observedAt: '2026-08-25T18:02:20.000Z',
      failure: {
        classification: 'runtime_unavailable',
        code: 'RUNTIME_LOST',
        retryable: true,
      },
    })
    expect(failed).toMatchObject({
      resolution: 'retry',
      record: { state: 'requested', retryCount: 1 },
    })
    expect((await fixture.lifecycle.getExecution(ids.childExecutionId)).state).toBe('running')
    expect(fixture.events.at(-1)).toMatchObject({
      type: 'delegation.failed',
      details: { resolution: 'retry' },
    })
  })

  test('applies explicit retry, fallback, partial-failure, and manual policies', () => {
    expect(
      decideDelegationFailure({
        policy: 'retry',
        retryCount: 0,
        maximumRetries: 2,
        retryable: true,
      })
    ).toBe('retry')
    expect(
      decideDelegationFailure({
        policy: 'fallback',
        retryCount: 2,
        maximumRetries: 2,
        retryable: true,
        fallbackAvailable: true,
      })
    ).toBe('fallback')
    expect(
      decideDelegationFailure({
        policy: 'allow_partial',
        retryCount: 0,
        maximumRetries: 0,
        retryable: false,
      })
    ).toBe('continue_parent')
    expect(
      decideDelegationFailure({
        policy: 'manual',
        retryCount: 0,
        maximumRetries: 0,
        retryable: false,
      })
    ).toBe('manual_intervention')
    expect(
      decideDelegationFailure({
        policy: 'fail_parent',
        retryCount: 0,
        maximumRetries: 0,
        retryable: false,
      })
    ).toBe('fail_parent')
  })

  test('a delegation persisted pre-cutover replays via the legacy digest', async () => {
    const fixture = await createFixture()
    const input = delegationInput(fixture)
    const legacyDigest = delegationInputLegacyDigest(input)
    const inner = new InMemoryDelegationRepository()
    const preCutover = {
      async insert(record) {
        // The first write simulates a record stored before the cutover.
        return inner.insert({ ...record, inputDigest: legacyDigest })
      },
      get(id) {
        return inner.get(id)
      },
      findByChild(childExecutionId) {
        return inner.findByChild(childExecutionId)
      },
      listByParent(parentExecutionId) {
        return inner.listByParent(parentExecutionId)
      },
      async compareAndSet(expectedRevision, record) {
        return inner.compareAndSet(expectedRevision, record)
      },
    }
    const service = new DelegationService({
      delegations: preCutover,
      lifecycle: fixture.lifecycle,
      plans: fixture.plans,
      events: { async publish() {} },
    })

    const first = await service.delegate(input)
    expect(first.record.inputDigest).toBe(legacyDigest)
    // Replay computes the current s2 form plus the legacy candidate: the
    // pre-cutover receipt must resolve to replay, never DELEGATION_CONFLICT.
    const replay = await service.delegate(input)
    expect(replay.record.delegationId).toBe(first.record.delegationId)
  })

  test('cascades parent cancellation only when the immutable delegation policy requires it', async () => {
    const fixture = await createFixture()
    await fixture.service.delegate(delegationInput(fixture))
    const cancelled = await fixture.service.cancelChildren({
      parentExecutionId: ids.parentExecutionId,
      cancelledAt: '2026-08-25T18:03:00.000Z',
    })
    expect(cancelled).toHaveLength(1)
    expect((await fixture.lifecycle.getExecution(ids.childExecutionId)).state).toBe('cancelled')
  })
})

async function createFixture(graphs) {
  const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(parentPlanInput())
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
    acceptedAt: '2026-08-25T18:00:00.000Z',
    deadlineAt: '2026-08-25T19:00:00.000Z',
  })
  const events = []
  const delegations = new InMemoryDelegationRepository()
  const service = new DelegationService({
    delegations,
    lifecycle,
    plans,
    graphs,
    events: {
      async publish(event) {
        events.push(event)
      },
    },
  })
  return { parentPlan, executions, lifecycle, plans, events, service, delegations }
}

function delegationInput({ parentPlan }) {
  const constraints = globalThis.structuredClone(parentPlan.constraints)
  constraints.tools.grants[0].operations = ['read']
  constraints.limits.budget.maximumMicrounits = 1_000_000
  constraints.limits.tokens.maximumTotal = 10_000
  constraints.limits.duration.maximumMs = 600_000
  const contextPackage = deriveContextPackage(contextPackageSerializationFixtures.futurePi, {
    objective: 'Complete focused research',
    allowedStateItemIds: [],
    allowedArtifactIds: [],
    budgets: { maximumBytes: 512, maximumTokens: 128 },
    successCriteria: ['Return evidence'],
    returnContract: { contractRef: 'contract://adapter-result/v1' },
    compiledAt: '2026-08-25T18:01:00.000Z',
  })
  return {
    delegationId: ids.delegationId,
    parentExecutionId: ids.parentExecutionId,
    childExecutionId: ids.childExecutionId,
    role: 'researcher',
    profileVersionId: ids.profileVersionId,
    objective: 'Research the bounded question',
    parentPlan,
    childPlan: {
      correlation: {
        ...parentPlan.correlation,
        taskId: ids.childTaskId,
        requestId: ids.childRequestId,
      },
      contextPackage,
      constraints,
      runtimeRequirements: parentPlan.runtimeRequirements,
      outputContract: parentPlan.outputContract,
      compiledAt: '2026-08-25T18:01:00.000Z',
    },
    policy: {
      cancellation: 'cascade',
      deadline: 'bounded_by_parent',
      failure: 'retry',
      maximumRetries: 2,
    },
    acceptedAt: '2026-08-25T18:01:00.000Z',
    deadlineAt: '2026-08-25T18:10:00.000Z',
  }
}

function parentPlanInput() {
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
    content: { instructions: 'Inspect project files.', artifactRefs: [] },
    createdAt: '2026-08-25T17:00:00.000Z',
    lifecycleMetadata: { publishedAt: '2026-08-25T17:00:00.000Z' },
  }
  return {
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
        roleInstructions: 'Coordinate safely.',
        skills: [
          { skillId: ids.skillId, skillVersionId: ids.skillVersionId, contentDigest: digest('b') },
        ],
        capabilityRequirements: ['filesystem.read'],
        executionConstraints: globalThis.structuredClone(executionConstraintFixtures.write),
        outputContractRefs: ['contract://execution-result/v1'],
      },
      createdAt: '2026-08-25T17:00:00.000Z',
      lifecycleMetadata: { publishedAt: '2026-08-25T17:00:00.000Z' },
    },
    skills: [skill],
    contextPackage: globalThis.structuredClone(contextPackageSerializationFixtures.futurePi),
    constraints: globalThis.structuredClone(executionConstraintFixtures.write),
    requestConstraints: [],
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
    ],
    outputContract: { contractRef: 'contract://execution-result/v1' },
    compiledAt: '2026-08-25T17:00:00.000Z',
  }
}

async function graphFixture(scenario) {
  const repository = new InMemoryGraphDefinitionRepository()
  const catalog = new GraphDefinitionCatalog(repository)
  const published = await catalog.publish({
    definition: {
      graphDefinitionId: 'worker-graph',
      graphVersion: '1.0.0',
      schemaVersion: 1,
      nodes: [{ node: 'work', operation: { kind: 'runtime', name: 'execute' } }],
      edges: [
        { from: '__start__', to: 'work' },
        { from: 'work', to: '__end__' },
      ],
      schemas: {
        input: 'schema://worker/input/v1',
        state: 'schema://worker/state/v1',
        output: 'schema://worker/output/v1',
      },
      requiredCapabilities: ['runtime.invoke'],
      compatibility: {
        contractMajorVersions: [1],
        compilerVersions: ['1.0.0'],
        adapterVersions: ['1.4.12'],
      },
    },
    publishedAt: '2026-08-25T17:00:00.000Z',
  })
  if (scenario === 'deprecated' || scenario === 'revoked')
    await catalog[scenario === 'deprecated' ? 'deprecate' : 'revoke']({
      reference: published.reference,
      expectedRevision: 1,
      changedAt: '2026-08-25T17:30:00.000Z',
      reason: 'retired',
    })
  const other = new InMemoryGraphDefinitionRepository()
  const authority = new GraphDefinitionExecutionAuthority({
    repository: (workspaceId) =>
      workspaceId === ids.workspaceId && scenario !== 'wrong-workspace' ? repository : other,
    environment: {
      capabilities: ['runtime.invoke'],
      contractMajorVersion: 1,
      compilerVersion: '1.0.0',
      adapterVersion: scenario === 'incompatible' ? '2.0.0' : '1.4.12',
    },
    validateDefinitionAndInput: (_definition, input) =>
      Object.keys(input).length === 1 && input.objective === 'review',
  })
  return {
    catalog,
    authority,
    selection: {
      reference: {
        ...published.reference,
        ...(scenario === 'unpublished' ? { graphVersion: '2.0.0' } : {}),
        ...(scenario === 'wrong-digest' ? { contentDigest: digest('f') } : {}),
      },
      input: { objective: scenario === 'invalid-input' ? 'invalid' : 'review' },
    },
  }
}
