import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deriveContextPackage } from '@control-plane/context'
import {
  ExecutionLifecycleService,
  InMemoryInteractionRepository,
  InteractionService,
} from '@control-plane/domain'
import {
  SqliteChildUsageOutcomeRepository,
  SqliteDelegationEventPublisher,
  SqliteDelegationRepository,
  SqliteToolCallRepository,
} from '@control-plane/sqlite-persistence'
import { DelegationRecordSchema } from '@control-plane/orchestration'
import {
  InMemoryToolRateLimiter,
  InMemoryToolRegistryRepository,
  InteractionToolApprovalCoordinator,
  PolicyControlledToolExecutionService,
  ToolGateway,
  ToolRegistry,
} from '@control-plane/tool-execution'
import { createProductionFactoryFixture } from './pi-production-factory.fixture.mjs'

const id = (prefix, suffix = '01JABCDEF0123456789ABCDEFG') => `${prefix}_${suffix}`
const childSuffix = '01JBBCDEF0123456789ABCDEFG'

function deferred() {
  let resolve
  const promise = new Promise((done) => (resolve = done))
  return { promise, resolve }
}

function functionCallResponse() {
  const item = {
    id: 'fc_production_child_fixture',
    type: 'function_call',
    status: 'completed',
    name: 'delegate_child',
    call_id: 'call_production_child_fixture',
    arguments: JSON.stringify({ objective: 'Inspect the bounded child objective' }),
  }
  const events = [
    { type: 'response.created', response: { id: 'resp_child_fixture', status: 'in_progress' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: 'response.function_call_arguments.done',
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_child_fixture',
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )
}

function childrenFactory({ denyCurrentScopeRead = true, selfComposed = false } = {}) {
  return async ({
    persistence,
    repositories,
    workspaceId,
    actorPrincipalId,
    leasePrincipalRef,
    state,
    at,
  }) => {
    const toolDefinitionId = id('tld')
    const toolVersionId = id('tlv')
    const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
    await registry.createDefinition({
      toolDefinitionId,
      name: 'delegate-child',
      displayName: 'Governed child dispatch',
      description: 'Dispatches a bounded child through canonical orchestration.',
      ownership: { scope: 'workspace', workspaceId },
      createdAt: at,
    })
    await registry.publishVersion({
      toolVersionId,
      toolDefinitionId,
      semanticVersion: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: { objective: { type: 'string', minLength: 1, maxLength: 8192 } },
        required: ['objective'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { accepted: { type: 'boolean' } },
        required: ['accepted'],
        additionalProperties: false,
      },
      operations: [
        {
          name: 'delegate-child',
          requiredCapabilities: [],
          riskClass: 'high',
          approvalMode: 'never',
          idempotency: 'provider_key',
        },
      ],
      executor: { type: 'connector', reference: 'production-child-fixture-v1' },
      limits: { maxInputBytes: 8192, maxOutputBytes: 1024, timeoutMs: 5000 },
      createdAt: at,
      publishedAt: at,
    })
    const gateway = new ToolGateway(registry)
    gateway.registerExecutor('connector', 'production-child-fixture-v1', {
      async execute() {
        state.toolExecutorCalls++
        return { output: { accepted: true } }
      },
    })
    const interactions = new InMemoryInteractionRepository()
    const approvals = new InteractionToolApprovalCoordinator(
      new InteractionService(interactions),
      interactions
    )
    const service = new PolicyControlledToolExecutionService({
      gateway,
      calls: new SqliteToolCallRepository(persistence, workspaceId),
      authorizer: {
        async authorize() {
          state.toolAuthorizationCalls++
          // The canonical helper's final current-authority read must deny this effect.
          if (denyCurrentScopeRead) state.denyNextScopeAuthorityRead = true
          return {
            effect: 'allow',
            decisionId: 'production-child-policy-decision',
            policyVersion: 'production-child-fixture@1',
            reasonCode: 'ALLOW',
            requiresApproval: false,
            evaluatedAt: at,
          }
        },
      },
      approvals,
      rateLimiter: new InMemoryToolRateLimiter(),
      now: () => at,
    })
    state.toolService = service
    const delegationRecords = new SqliteDelegationRepository(persistence)
    state.delegationRecords = delegationRecords
    const lifecycle = new ExecutionLifecycleService(repositories.executions)
    const events = {
      async publish(event, key) {
        await new SqliteDelegationEventPublisher(persistence, event.parentExecutionId).publish(
          event,
          key
        )
        state.retainedEvents.push(structuredClone(event))
        state.wakeOrder.push(`retained:${event.type}`)
      },
      async list() {
        if (!state.parentExecutionId) return []
        return new SqliteDelegationEventPublisher(persistence, state.parentExecutionId).list()
      },
    }
    const scopeAdmission = {
      authority: state.scopeAuthority,
      resolveCallerPrincipalId: async () => actorPrincipalId,
      now: () => at,
    }
    state.prepareChildToolRequest = async (authority, verified) => {
      expect(verified.objective).toBe('Inspect the bounded child objective')
      const requestId = id('req')
      state.toolCallId = id('tlc')
      return {
        toolCallId: state.toolCallId,
        idempotencyKey: `pi-child:${verified.sourceKey.slice(-48)}`,
        requestedAt: at,
        policySnapshotRef: 'policy://production-child-fixture/v1',
        requestId,
        executionId: authority.request.executionId,
        attemptId: authority.request.attemptId,
        workspaceId,
        profileId: authority.request.executionPlan.profile.profileId,
        toolDefinitionId,
        toolVersionId,
        operation: 'delegate-child',
        input: { objective: verified.objective },
        grant: {
          workspaceId,
          profileId: authority.request.executionPlan.profile.profileId,
          toolDefinitionId,
          toolVersionId,
          operations: ['delegate-child'],
          expiresAt: new Date(Date.parse(at) + 240_000).toISOString(),
        },
        audit: { principalRef: actorPrincipalId, traceId: id('trc') },
      }
    }
    return {
      ...(selfComposed
        ? {}
        : {
            authority: {
              readCurrent: async () => undefined,
              admit: async () => {
                throw new Error('CHILD_RUNTIME_NOT_EXPECTED')
              },
              assertCurrent: async () => {},
            },
            forgetCanonicalModels: () => {},
          }),
      tools: { service, interactions },
      delegation: {
        records: delegationRecords,
        lifecycle,
        plans: repositories.plans,
        events,
        scopeAdmission,
        ...(selfComposed ? {} : { readCurrent: async () => undefined }),
      },
      usageOutcomes: (delegationId) =>
        new SqliteChildUsageOutcomeRepository(persistence, delegationId),
      createGovernedDelegateChild(delegationService) {
        state.governedDelegationService = delegationService
        const cancelChildren = delegationService.cancelChildren.bind(delegationService)
        delegationService.cancelChildren = async (input) => {
          state.cancelChildCalls.push(structuredClone(input))
          return cancelChildren(input)
        }
        return {
          async prepare(authority, verified) {
            return state.prepareChildToolRequest(authority, verified)
          },
        }
      },
      modelAuthority: {
        ...(selfComposed
          ? {}
          : {
              forExecution: async () => {
                throw new Error('CHILD_MODEL_NOT_EXPECTED')
              },
              readRecordedDecision: async () => {
                throw new Error('CHILD_MODEL_NOT_EXPECTED')
              },
            }),
        leasePrincipalRef,
        modelAlias: 'reasoning.standard',
      },
      runtime: {
        // Explicit test wake port required by the production child composition contract.
        // Captured advisory delivery is not Adea authorization or canonical timeline acceptance.
        childTimelineDelivery: {
          principalId: 'svc_adea',
          notify: async (input) => {
            state.childTimelineNotifications ??= []
            state.childTimelineNotifications.push(structuredClone(input))
          },
        },
        childProgress: { scan: async () => ({ reconciled: 0, pending: 0 }) },
        consumeParentInbox: async () => {},
        onParentInboxWake: async () => {
          const snapshot = await events.list()
          state.parentInboxWakeSnapshots.push(snapshot)
          state.wakeOrder.push(`wake:${snapshot.at(-1)?.type ?? 'empty'}`)
        },
      },
    }
  }
}

async function waitFor(predicate, label) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`TEST_WAIT_TIMEOUT:${label}`)
}

test('retained child model funding can resume after its parent and attempt complete', async () => {
  const providerReached = deferred()
  const releaseProvider = deferred()
  let host
  host = await createProductionFactoryFixture({
    childrenFactory: childrenFactory({ denyCurrentScopeRead: false, selfComposed: true }),
    physicalResponder: async () => {
      providerReached.resolve()
      await releaseProvider.promise
      throw new Error('TEST_PARENT_PROVIDER_RELEASED')
    },
  })
  try {
    const intentId = host.setIntent()
    const prepared = (
      await host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).data
    const dispatch = (
      await host.composition.piDurableLeadService.dispatch(
        host.command('pi-durable.lead.dispatch', {
          intentId,
          preparationRef: prepared.preparationRef,
        }),
        host.principal
      )
    ).data
    await providerReached.promise

    const parentPlan = host.parentPlanForIntent(intentId)
    const parentContext = await host.repositories.contexts.get(parentPlan.contextPackage)
    const parent = await host.repositories.executions.getExecution(dispatch.executionId)
    const parentAttemptId = parent.latestAttemptId
    expect(parent.state).toBe('running')

    // Use the production child tool request builder and durable tool service so the
    // retained delegation points at an actually authorized, succeeded call.
    const toolRequest = await host.state.prepareChildToolRequest(
      {
        request: {
          executionId: dispatch.executionId,
          attemptId: parentAttemptId,
          executionPlan: parentPlan,
        },
      },
      {
        objective: 'Inspect the bounded child objective',
        sourceKey: 'source:completed-parent-child',
      }
    )
    const toolOutcome = await host.state.toolService.execute(toolRequest)
    expect(toolOutcome.state).toBe('succeeded')
    expect(toolOutcome.call).toMatchObject({
      toolCallId: host.state.toolCallId,
      status: 'succeeded',
    })

    const childExecutionId = id('exe', childSuffix)
    const childAttemptId = id('att', childSuffix)
    const childDispatch = {
      delegationId: id('dlg', childSuffix),
      childAttemptId,
      runtime: { runtimeConnectionId: id('rtc', childSuffix) },
      dispatchedAt: host.at,
    }
    const childPlanContext = deriveContextPackage(parentContext, {
      objective: 'Inspect the bounded child objective',
      allowedStateItemIds: [],
      allowedArtifactIds: [],
      budgets: parentContext.budgets,
      successCriteria: parentContext.successCriteria,
      returnContract: parentContext.returnContract,
      compiledAt: host.at,
    })
    const childInput = {
      delegationId: childDispatch.delegationId,
      parentExecutionId: dispatch.executionId,
      parentAttemptId,
      childExecutionId,
      role: 'researcher',
      profileVersionId: parentPlan.profile.profileVersionId,
      objective: 'Inspect the bounded child objective',
      parentPlan,
      childPlan: {
        correlation: {
          ...parentPlan.correlation,
          taskId: id('tsk', childSuffix),
          requestId: id('req', childSuffix),
        },
        contextPackage: childPlanContext,
        constraints: structuredClone(parentPlan.constraints),
        runtimeRequirements: structuredClone(parentPlan.runtimeRequirements),
        outputContract: structuredClone(parentPlan.outputContract),
        compiledAt: host.at,
      },
      policy: {
        cancellation: 'cascade',
        deadline: 'bounded_by_parent',
        failure: 'manual',
        maximumRetries: 0,
      },
      acceptedAt: host.at,
      ...(parent.deadlineAt ? { deadlineAt: parent.deadlineAt } : {}),
    }
    await host.repositories.contexts.put(childPlanContext)
    const selections = host.composition.modelConnectionService.selections
    const defaults = await selections.getDefaults(host.workspaceId)
    await selections.setDefaults(defaults.revision, {
      ...defaults,
      revision: defaults.revision + 1,
      child: {
        connectionRef: host.models.refs.connectionRef,
        providerModel: host.models.refs.providerModel,
      },
    })
    const proposedChildPlan = host.state.governedDelegationService.deriveChildPlan(
      parentPlan,
      childInput.childPlan
    )
    const parentBeforeAllocation = await host.repositories.executions.getExecution(
      dispatch.executionId
    )
    await host.composition.childAuthorityCurrent.readAdmission({
      workspaceId: host.workspaceId,
      parentIntentId: intentId,
      parentExecutionId: dispatch.executionId,
      parentAttemptId,
      parentExecutionVersion: parentBeforeAllocation.version,
      parentPlan: {
        executionPlanId: parentPlan.executionPlanId,
        contentDigest: parentPlan.contentDigest,
        schemaVersion: parentPlan.schemaVersion,
      },
      admittedToolCallId: host.state.toolCallId,
      delegationId: childDispatch.delegationId,
      childRequestId: proposedChildPlan.correlation.requestId,
      childExecutionId,
      childAttemptId,
      childDispatch,
      childPlan: {
        executionPlanId: proposedChildPlan.executionPlanId,
        contentDigest: proposedChildPlan.contentDigest,
        schemaVersion: proposedChildPlan.schemaVersion,
      },
      role: childInput.role,
      profileVersionId: childInput.profileVersionId,
      originalActorPrincipalId: host.actorPrincipalId,
      childRequestDigest: `sha256:${'c'.repeat(64)}`,
      acceptedAt: childInput.acceptedAt,
    })
    const lifecycle = new ExecutionLifecycleService(host.repositories.executions)
    await host.repositories.plans.put(proposedChildPlan)
    await lifecycle.createExecution({
      executionId: childExecutionId,
      correlation: proposedChildPlan.correlation,
      executionPlan: {
        executionPlanId: proposedChildPlan.executionPlanId,
        contentDigest: proposedChildPlan.contentDigest,
        schemaVersion: proposedChildPlan.schemaVersion,
      },
      parentExecutionId: dispatch.executionId,
      acceptedAt: host.at,
      ...(parent.deadlineAt ? { deadlineAt: parent.deadlineAt } : {}),
    })
    await lifecycle.createAttempt({
      executionId: childExecutionId,
      attemptId: childAttemptId,
      expectedExecutionVersion: 1,
      queuedAt: host.at,
      runtime: childDispatch.runtime,
      ...(parent.deadlineAt ? { deadlineAt: parent.deadlineAt } : {}),
    })
    const acceptedChild = await host.repositories.executions.getExecution(childExecutionId)
    await lifecycle.transitionExecution({
      executionId: childExecutionId,
      expectedVersion: acceptedChild.version,
      to: 'queued',
      transitionedAt: host.at,
    })
    const retainedDelegation = DelegationRecordSchema.parse({
      delegationId: childDispatch.delegationId,
      parentExecutionId: dispatch.executionId,
      parentAttemptId,
      admittedToolCallId: host.state.toolCallId,
      childExecutionId,
      childAttemptId,
      parentExecutionPlanId: parentPlan.executionPlanId,
      parentExecutionPlanDigest: parentPlan.contentDigest,
      childExecutionPlanId: proposedChildPlan.executionPlanId,
      childExecutionPlanDigest: proposedChildPlan.contentDigest,
      contextPackageId: proposedChildPlan.contextPackage.contextPackageId,
      contextPackageDigest: proposedChildPlan.contextPackage.contentDigest,
      role: childInput.role,
      profileVersionId: childInput.profileVersionId,
      objective: childInput.objective,
      policy: childInput.policy,
      state: 'dispatched',
      runtimeConnectionId: childDispatch.runtime.runtimeConnectionId,
      retryCount: 0,
      inputDigest: `sha256:${'d'.repeat(64)}`,
      revision: 1,
      acceptedAt: host.at,
      ...(parent.deadlineAt ? { deadlineAt: parent.deadlineAt } : {}),
      updatedAt: host.at,
    })
    expect(await host.state.delegationRecords.insert(retainedDelegation)).toBe(true)
    const currentParent = await host.repositories.executions.getExecution(dispatch.executionId)
    const completedAt = new Date(Date.parse(host.at) + 10).toISOString()
    const completedParent = await lifecycle.transitionExecution({
      executionId: dispatch.executionId,
      expectedVersion: currentParent.version,
      to: 'completed',
      transitionedAt: completedAt,
      terminalResultRef: id('art', childSuffix),
    })
    const currentAttempt = await host.repositories.executions.getAttempt(parentAttemptId)
    const completedAttempt = await lifecycle.transitionAttempt({
      attemptId: parentAttemptId,
      expectedVersion: currentAttempt.version,
      to: 'completed',
      transitionedAt: completedAt,
      terminalResultRef: id('art', childSuffix),
    })
    expect(completedParent.state).toBe('completed')
    expect(completedAttempt.state).toBe('completed')

    // A completed parent cannot allocate a new child; only its already-retained child
    // may pass the continuation/current-funding path.
    const refusedSuffix = '01JDDDDEF0123456789ABCDEFG'
    await expect(
      host.composition.childAuthorityCurrent.readAdmission({
        workspaceId: host.workspaceId,
        parentIntentId: intentId,
        parentExecutionId: dispatch.executionId,
        parentAttemptId,
        parentExecutionVersion: completedParent.version,
        parentPlan: {
          executionPlanId: parentPlan.executionPlanId,
          contentDigest: parentPlan.contentDigest,
          schemaVersion: parentPlan.schemaVersion,
        },
        admittedToolCallId: host.state.toolCallId,
        delegationId: id('dlg', refusedSuffix),
        childRequestId: id('req', refusedSuffix),
        childExecutionId: id('exe', refusedSuffix),
        childAttemptId: id('att', refusedSuffix),
        childDispatch: {
          delegationId: id('dlg', refusedSuffix),
          childAttemptId: id('att', refusedSuffix),
          runtime: { runtimeConnectionId: id('rtc', refusedSuffix) },
          dispatchedAt: host.at,
        },
        childPlan: {
          executionPlanId: proposedChildPlan.executionPlanId,
          contentDigest: proposedChildPlan.contentDigest,
          schemaVersion: proposedChildPlan.schemaVersion,
        },
        role: 'researcher',
        profileVersionId: parentPlan.profile.profileVersionId,
        originalActorPrincipalId: host.actorPrincipalId,
        childRequestDigest: `sha256:${'b'.repeat(64)}`,
        acceptedAt: host.at,
      })
    ).rejects.toThrow('PI_CHILD_MODEL_AUTHORITY_DENIED')

    const request = {
      executionId: childExecutionId,
      attemptId: childAttemptId,
      idempotencyKey: 'completed-parent-retained-child-model',
      executionPlan: proposedChildPlan,
    }
    const binding = await host.composition.childModelBinding({
      executionId: childExecutionId,
      attemptId: childAttemptId,
    })
    const parentFunding = host.records.get(intentId)
    const decision = structuredClone(parentFunding.decision)
    const ownerRef = 'payer:completed-parent-retained-child'
    const fundingOwner = { ...decision.fundingOwner, ownerRef }
    decision.executionPlanId = binding.executionPlanId
    decision.executionPlanDigest = binding.executionPlanDigest
    decision.selectionRef = binding.selectionRef
    decision.selectionRevision = binding.selectionRevision
    decision.canonicalActorPrincipalId = binding.canonicalActorPrincipalId
    decision.authorityRevision = binding.authorityRevision
    decision.fundingOwner = fundingOwner
    decision.grant = {
      ...decision.grant,
      authorizationId: 'fixture-child-spend:completed-parent',
      evidenceRef: 'fixture-child-decision:completed-parent',
      workspaceId: binding.workspaceId,
      executionId: binding.executionId,
      attemptId: binding.attemptId,
      principalRef: binding.principalRef,
      alias: binding.modelAlias,
      policySnapshotDigest: binding.policySnapshotDigest,
    }
    const fundingDirectory = join(host.directory, 'private-funding')
    const recordDirectory = join(fundingDirectory, binding.workspaceId, binding.executionId)
    const payerDirectory = join(fundingDirectory, binding.workspaceId, 'payers')
    await mkdir(recordDirectory, { recursive: true, mode: 0o700 })
    await mkdir(payerDirectory, { recursive: true, mode: 0o700 })
    await writeFile(
      join(recordDirectory, `${binding.attemptId}.json`),
      JSON.stringify({
        schemaVersion: 'recorded-funding-host/v1',
        binding,
        decision,
        status: 'active',
        expiresAt: host.expiresAt,
      }),
      { mode: 0o600 }
    )
    await writeFile(
      join(payerDirectory, `${createHash('sha256').update(ownerRef).digest('hex')}.json`),
      JSON.stringify({
        schemaVersion: 'recorded-funding-payer/v1',
        workspaceId: binding.workspaceId,
        authorizationRef: decision.grant.authorizationId,
        fundingOwner,
        status: 'active',
        expiresAt: host.expiresAt,
      }),
      { mode: 0o600 }
    )

    const admission = await host.composition.childAuthority.resolveAdmission(request)
    expect(admission.prompt).toBe('Inspect the bounded child objective')
    expect(admission.selection).toEqual({
      selectionRef: binding.selectionRef,
      selectionRevision: binding.selectionRevision,
    })

    const readExecution = host.repositories.executions.getExecution.bind(
      host.repositories.executions
    )
    const readAttempt = host.repositories.executions.getAttempt.bind(host.repositories.executions)
    host.repositories.executions.getExecution = async (executionId) => {
      const current = await readExecution(executionId)
      if (executionId !== dispatch.executionId) return current
      const { terminalResultRef: _result, ...withoutResult } = current
      return { ...withoutResult, state: 'cancelled' }
    }
    host.repositories.executions.getAttempt = async (attemptId) => {
      const current = await readAttempt(attemptId)
      if (attemptId !== parentAttemptId) return current
      const { terminalResultRef: _result, ...withoutResult } = current
      return { ...withoutResult, state: 'cancelled' }
    }
    try {
      await expect(
        host.composition.childAuthority.assertAuthority({ request, admission })
      ).rejects.toThrow('PI_CHILD_MODEL_AUTHORITY_DENIED')
    } finally {
      host.repositories.executions.getExecution = readExecution
      host.repositories.executions.getAttempt = readAttempt
    }

    host.state.revoked = true
    await expect(
      host.composition.childAuthority.assertAuthority({ request, admission })
    ).rejects.toThrow('PI_CHILD_MODEL_AUTHORITY_DENIED')
  } finally {
    releaseProvider.resolve()
    await host.close()
  }
}, 30000)

test('actual production composition uses the canonical Pi tool authority and shared delegation service for durable child-stop publication', async () => {
  const providerReached = deferred()
  const releaseProvider = deferred()
  const authorityDenied = deferred()
  let host
  host = await createProductionFactoryFixture({
    childrenFactory: childrenFactory(),
    onScopeAuthorityDenial: () => authorityDenied.resolve(),
    physicalResponder: async ({ body }) => {
      expect(body.tools?.map((tool) => tool.name)).toEqual(['delegate_child'])
      providerReached.resolve()
      await releaseProvider.promise
      return functionCallResponse()
    },
  })
  try {
    const intentId = host.setIntent()
    const prepared = (
      await host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).data
    const dispatch = (
      await host.composition.piDurableLeadService.dispatch(
        host.command('pi-durable.lead.dispatch', {
          intentId,
          preparationRef: prepared.preparationRef,
        }),
        host.principal
      )
    ).data
    await providerReached.promise

    const parentPlan = host.parentPlanForIntent(intentId)
    const parentContext = await host.repositories.contexts.get(parentPlan.contextPackage)
    expect(parentContext).toBeDefined()
    const parent = await host.repositories.executions.getExecution(dispatch.executionId)
    expect(parent.latestAttemptId).toBeTruthy()
    expect(parent.state).toBe('running')
    const parentAttemptId = parent.latestAttemptId
    // Target-bound observation through the REAL production composition: the
    // installed adapter's runtime session is exactly what dispatch reports as
    // the observed target (server-owned session + plan task), proving the
    // composition invokes the adapter for observation rather than relying on
    // an isolated policy mock.
    expect(dispatch.observedTarget).toBeDefined()
    expect(dispatch.observedTarget.sessionId).toBe(dispatch.runtimeSessionId)
    expect(typeof dispatch.observedTarget.taskId).toBe('string')
    host.state.parentExecutionId = dispatch.executionId
    const childExecutionId = id('exe', childSuffix)
    const childAttemptId = id('att', childSuffix)
    const childPlanContext = deriveContextPackage(parentContext, {
      objective: 'Retained queued child for cancellation proof',
      allowedStateItemIds: [],
      allowedArtifactIds: [],
      budgets: parentContext.budgets,
      successCriteria: parentContext.successCriteria,
      returnContract: parentContext.returnContract,
      compiledAt: host.at,
    })
    const childInput = {
      delegationId: id('dlg', childSuffix),
      parentExecutionId: dispatch.executionId,
      parentAttemptId,
      childExecutionId,
      role: 'researcher',
      profileVersionId: parentPlan.profile.profileVersionId,
      objective: 'Retained queued child for cancellation proof',
      parentPlan,
      childPlan: {
        correlation: {
          ...parentPlan.correlation,
          taskId: id('tsk', childSuffix),
          requestId: id('req', childSuffix),
        },
        contextPackage: childPlanContext,
        constraints: structuredClone(parentPlan.constraints),
        runtimeRequirements: structuredClone(parentPlan.runtimeRequirements),
        outputContract: structuredClone(parentPlan.outputContract),
        compiledAt: host.at,
      },
      policy: {
        cancellation: 'cascade',
        deadline: 'bounded_by_parent',
        failure: 'manual',
        maximumRetries: 0,
      },
      acceptedAt: host.at,
      ...(parent.deadlineAt ? { deadlineAt: parent.deadlineAt } : {}),
    }
    await host.repositories.contexts.put(childPlanContext)
    const delegated = await host.state.governedDelegationService.delegate(childInput)
    const childDispatchAt = host.at
    await host.state.governedDelegationService.dispatchChild({
      delegationId: delegated.record.delegationId,
      childAttemptId,
      runtime: { runtimeConnectionId: id('rtc', childSuffix) },
      dispatchedAt: childDispatchAt,
    })

    releaseProvider.resolve()
    await authorityDenied.promise
    await waitFor(async () => {
      const call = await host.state.toolService?.calls?.get?.(host.state.toolCallId)
      return call?.status === 'reconciliation_required'
    }, 'canonical effect denial')
    const deniedCall = await host.state.toolService.calls.get(host.state.toolCallId)
    expect(deniedCall).toMatchObject({
      status: 'reconciliation_required',
      errorCode: 'PI_EFFECT_AUTHORITY_REJECTED',
    })
    expect(host.state.scopeAuthorityDenials).toBe(1)
    expect(host.state.toolAuthorizationCalls).toBe(1)
    expect(host.state.toolExecutorCalls).toBe(0)
    expect(host.state.physicalSends).toBe(1)

    const childExecutionBeforeStop =
      await host.repositories.executions.getExecution(childExecutionId)
    const childAttemptBeforeStop = await host.repositories.executions.getAttempt(childAttemptId)
    const cancelCommand = host.command('pi-durable.lead.cancel', {
      dispatchId: dispatch.dispatchId,
    })
    const cancelled = await host.composition.piDurableLeadService.cancel(
      cancelCommand,
      host.principal
    )
    expect(cancelled.data.state).toBe('failed')
    expect(cancelled.data.status).toMatchObject({
      state: 'failed',
      error: { code: 'PI_CHILD_DELEGATION_DENIED' },
    })
    // CP935 contract (Root-adjudicated authoritative): a lead-stop must NOT
    // implicitly cancel child sessions — child cancellation is a separate,
    // explicitly authorized operation. Prove the lead-stop leaves the
    // dispatched child untouched.
    expect(host.state.cancelChildCalls).toEqual([])
    expect(await host.repositories.executions.getExecution(childExecutionId)).toEqual(
      childExecutionBeforeStop
    )
    expect(await host.repositories.executions.getAttempt(childAttemptId)).toEqual(
      childAttemptBeforeStop
    )
    expect(
      host.state.retainedEvents.filter((event) => event.type === 'delegation.cancelled')
    ).toHaveLength(0)

    // Separately invoke the governed child-cancel path with its own
    // authorization; it durably cancels the child and publishes the terminal
    // packet exactly once.
    const cancelChildren = () =>
      host.state.governedDelegationService.cancelChildren({
        parentExecutionId: dispatch.executionId,
        cancelledAt: host.at,
      })
    await cancelChildren()
    expect(host.state.cancelChildCalls).toEqual([
      { parentExecutionId: dispatch.executionId, cancelledAt: host.at },
    ])
    expect(await host.repositories.executions.getExecution(childExecutionId)).toMatchObject({
      state: 'cancelled',
    })
    expect(await host.repositories.executions.getAttempt(childAttemptId)).toMatchObject({
      state: 'cancelled',
    })
    const terminalEvents = host.state.retainedEvents.filter(
      (event) => event.type === 'delegation.cancelled'
    )
    expect(terminalEvents).toHaveLength(1)
    expect(terminalEvents[0]).toMatchObject({
      parentExecutionId: dispatch.executionId,
      childExecutionId,
      details: { state: 'cancelled', childAttemptId, reason: 'parent_cancelled' },
    })
    const terminalIndex = host.state.wakeOrder.indexOf('retained:delegation.cancelled')
    const terminalWakeIndex = host.state.wakeOrder.indexOf('wake:delegation.cancelled')
    expect(terminalIndex).toBeGreaterThanOrEqual(0)
    expect(terminalWakeIndex).toBeGreaterThan(terminalIndex)
    expect(host.state.parentInboxWakeSnapshots.at(-1)).toContainEqual(terminalEvents[0])

    // A repeated child-cancel is idempotent (terminal packet published once),
    // and a lead-stop replay still never cascades to children.
    await cancelChildren()
    expect(host.state.cancelChildCalls).toHaveLength(2)
    expect(
      host.state.retainedEvents.filter((event) => event.type === 'delegation.cancelled')
    ).toHaveLength(1)
    const replayed = await host.composition.piDurableLeadService.cancel(
      cancelCommand,
      host.principal
    )
    expect(replayed.data.state).toBe('failed')
    expect(host.state.cancelChildCalls).toHaveLength(2)
    expect(host.state.physicalSends).toBe(1)
    expect(host.state.toolExecutorCalls).toBe(0)
  } finally {
    releaseProvider.resolve()
    await host.close()
  }
}, 30000)
