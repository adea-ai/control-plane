import { expect, test } from 'bun:test'
import { deriveContextPackage } from '@control-plane/context'
import {
  ExecutionLifecycleService,
  InMemoryInteractionRepository,
  InteractionService,
} from '@control-plane/domain'
import {
  SqliteDelegationEventPublisher,
  SqliteDelegationRepository,
  SqliteToolCallRepository,
} from '@control-plane/sqlite-persistence'
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

function childrenFactory() {
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
        return { accepted: true }
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
          state.denyNextScopeAuthorityRead = true
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
    return {
      authority: {
        readCurrent: async () => undefined,
        admit: async () => {
          throw new Error('CHILD_RUNTIME_NOT_EXPECTED')
        },
        assertCurrent: async () => {},
      },
      forgetCanonicalModels: () => {},
      tools: { service, interactions },
      delegation: {
        records: delegationRecords,
        lifecycle,
        plans: repositories.plans,
        events,
        scopeAdmission,
        readCurrent: async () => undefined,
      },
      createGovernedDelegateChild(delegationService) {
        state.governedDelegationService = delegationService
        const cancelChildren = delegationService.cancelChildren.bind(delegationService)
        delegationService.cancelChildren = async (input) => {
          state.cancelChildCalls.push(structuredClone(input))
          return cancelChildren(input)
        }
        return {
          async prepare(authority, verified) {
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
          },
        }
      },
      modelAuthority: {
        forExecution: async () => {
          throw new Error('CHILD_MODEL_NOT_EXPECTED')
        },
        readRecordedDecision: async () => {
          throw new Error('CHILD_MODEL_NOT_EXPECTED')
        },
        leasePrincipalRef,
        modelAlias: 'reasoning.standard',
      },
      runtime: {
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

    const replayed = await host.composition.piDurableLeadService.cancel(
      cancelCommand,
      host.principal
    )
    expect(replayed.data.state).toBe('failed')
    expect(host.state.cancelChildCalls).toHaveLength(2)
    expect(
      host.state.retainedEvents.filter((event) => event.type === 'delegation.cancelled')
    ).toHaveLength(1)
    expect(host.state.physicalSends).toBe(1)
    expect(host.state.toolExecutorCalls).toBe(0)
  } finally {
    releaseProvider.resolve()
    await host.close()
  }
}, 30000)
