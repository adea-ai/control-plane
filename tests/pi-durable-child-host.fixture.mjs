import assert from 'node:assert/strict'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import {
  CanonicalDelegationCommandResolver,
  InMemoryDelegationToolAdmissionRepository,
  assertDelegationToolParentPlan,
} from '../packages/orchestration/src/delegation-tool-admission.ts'
import {
  CanonicalDelegationRuntimeBridge,
  GovernedDelegateChildExecutor,
} from '../packages/orchestration/src/delegation-runtime.ts'
import {
  createFixture,
  delegationInput,
  ids,
  parentPlanInput,
} from '../packages/orchestration/src/delegation-fixtures.mjs'
import {
  InMemoryToolCallRepository,
  InMemoryToolRateLimiter,
  InMemoryToolRegistryRepository,
  PolicyControlledToolExecutionService,
  StaticToolPolicyAuthorizer,
  ToolGateway,
  ToolRegistry,
} from '../packages/tool-execution/src/index.ts'

// Test-only server compiler recipe. Runtime/provider/authority ports are explicit
// injected host dependencies; default runtime is a scripted fixture, not Pi.
export const parentAttemptId = 'att_01JABCDEF0123456789ABCDEFG'
export const connectionId = 'rtc_01JBBCDEF0123456789ABCDEFG'
export const toolId = 'tld_01JABCDEF0123456789ABCDEFG'
export const versionId = 'tlv_01JABCDEF0123456789ABCDEFG'
export const identity = {
  schemaVersion: 'delegation-runtime-admission/v1',
  parentExecutionId: ids.parentExecutionId,
  parentAttemptId,
  delegationId: ids.delegationId,
  childAttemptId: ids.childAttemptId,
}

export async function createGovernedChildHostFixture({
  decision = 'allow',
  approval = 'approved',
  onAuthority,
  onBudget,
  storage = {},
  runtimeAdapter,
  reserveChildBudget,
  sourceKey = `pi-tool:${'a'.repeat(64)}`,
  retainAdmission = true,
  initializeParentRunning = true,
  onCommandAuthority,
  workspace,
  principalRef = 'user:original',
  childAdmission,
  childAllocator,
  delegationService,
} = {}) {
  const planInput = parentPlanInput()
  planInput.constraints.limits.childExecutions.maximumTotal = 1
  const parentPlan = workspace?.parentPlan ?? new ExecutionPlanCompiler('1.0.0').compile(planInput)
  const f = await createFixture(undefined, {
    ...storage,
    parentPlan,
    parentContext: workspace?.parentContext,
    scopeAdmission: workspace?.scopeAdmission,
    ...(childAdmission ? { childAdmission } : {}),
    ...(childAllocator ? { childAllocator } : {}),
  })
  if (delegationService) f.service = delegationService
  await f.lifecycle.createAttempt({
    executionId: ids.parentExecutionId,
    attemptId: parentAttemptId,
    expectedExecutionVersion: 1,
    queuedAt: '2026-08-25T18:00:01.000Z',
    runtime: { runtimeConnectionId: connectionId },
  })
  if (initializeParentRunning) {
    let parent = await f.lifecycle.getExecution(ids.parentExecutionId)
    for (const state of ['queued', 'starting', 'running'])
      parent = await f.lifecycle.transitionExecution({
        executionId: parent.executionId,
        expectedVersion: parent.version,
        to: state,
        transitionedAt: '2026-08-25T18:00:02.000Z',
      })
    let attempt = await f.executions.getAttempt(parentAttemptId)
    for (const state of ['starting', 'running'])
      attempt = await f.lifecycle.transitionAttempt({
        attemptId: parentAttemptId,
        expectedVersion: attempt.version,
        to: state,
        transitionedAt: '2026-08-25T18:00:02.000Z',
      })
  }
  const starts = []
  const sessions = new Map()
  const runtime = {
    async start(request) {
      starts.push(structuredClone(request))
      if (runtimeAdapter) return runtimeAdapter.start(request)
      const retained = sessions.get(request.idempotencyKey)
      if (retained) {
        assert.deepEqual(request, retained.request)
        return retained.handle
      }
      const handle = {
        handleId: `pi-durable:${'a'.repeat(32)}`,
        attemptId: request.attemptId,
        externalSessionId: 'ses_01JBBCDEF0123456789ABCDEFG',
        startedAt: '2026-08-25T18:02:01.000Z',
      }
      sessions.set(request.idempotencyKey, { request, handle })
      return handle
    },
  }
  const bridgeOptions = {
    records: f.delegations,
    lifecycle: f.lifecycle,
    plans: f.plans,
    delegations: f.service,
    runtime,
    runtimeConnectionId: connectionId,
    async assertAuthority(admission) {
      const call = await calls.get(admission.record.admittedToolCallId)
      if (
        !call ||
        call.executionId !== admission.identity.parentExecutionId ||
        call.attemptId !== admission.identity.parentAttemptId ||
        !['executing', 'succeeded'].includes(call.status)
      )
        throw new Error('current tool authority rejected')
      await onAuthority?.(admission, f)
    },
    async reserveBudget(admission) {
      await onBudget?.(admission, f)
      if (reserveChildBudget) return reserveChildBudget(admission, f)
      return {
        schemaVersion: 1,
        workspaceId: ids.workspaceId,
        executionId: admission.record.childExecutionId,
        attemptId: admission.attempt.attemptId,
        executionPlanId: admission.plan.executionPlanId,
        executionPlanDigest: admission.plan.contentDigest,
        reservationKey: `runtime-attempt:${admission.attempt.attemptId}`,
        currency: 'USD',
        maximumMicrounits: 500000,
        maximumTokens: 5000,
      }
    },
  }
  const bridge = new CanonicalDelegationRuntimeBridge(bridgeOptions)
  const command = {
    delegation: {
      ...(workspace?.command ?? delegationInput(f)),
      parentIntentId: workspace?.parentIntentId ?? '11111111-1111-4111-8111-111111111112',
      parentAttemptId,
      childAttemptId: ids.childAttemptId,
      admittedToolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
    },
    dispatch: {
      delegationId: ids.delegationId,
      childAttemptId: ids.childAttemptId,
      runtime: { runtimeConnectionId: connectionId },
      dispatchedAt: '2026-08-25T18:02:00.000Z',
    },
  }
  const admissions =
    storage.admissions ?? new InMemoryDelegationToolAdmissionRepository(ids.workspaceId)
  let resolver
  const executor = new GovernedDelegateChildExecutor({
    toolDefinitionId: toolId,
    toolVersionId: versionId,
    parentExecutionId: ids.parentExecutionId,
    parentAttemptId,
    lifecycle: f.lifecycle,
    plans: f.plans,
    delegations: f.service,
    bridge,
    async assertAuthority(request, canonicalParentPlan) {
      assertDelegationToolParentPlan(
        await resolver.getAdmission(request.requestId),
        canonicalParentPlan
      )
    },
    async resolveCommand(request) {
      await storage.contexts?.put(command.delegation.childPlan.contextPackage)
      return resolver.resolve(request)
    },
  })
  const registry = new ToolRegistry(new InMemoryToolRegistryRepository())
  await registry.createDefinition({
    toolDefinitionId: toolId,
    name: 'delegate-child',
    displayName: 'Delegate child',
    description: 'Admit one bounded child.',
    ownership: { scope: 'workspace', workspaceId: ids.workspaceId },
    createdAt: '2026-08-25T17:00:00.000Z',
  })
  const version = await registry.publishVersion({
    toolDefinitionId: toolId,
    toolVersionId: versionId,
    semanticVersion: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: { objective: { type: 'string', minLength: 1, maxLength: 8192 } },
      required: ['objective'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    operations: [
      {
        name: 'delegate-child',
        requiredCapabilities: ['delegation.create'],
        riskClass: 'high',
        approvalMode: 'always',
        idempotency: 'provider_key',
      },
    ],
    executor: { type: 'internal', reference: 'pi-delegate-child-v1' },
    limits: { maxInputBytes: 16384, maxOutputBytes: 4096, timeoutMs: 30000 },
    createdAt: '2026-08-25T17:00:00.000Z',
    publishedAt: '2026-08-25T17:00:00.000Z',
  })
  const gateway = new ToolGateway(registry)
  gateway.registerExecutor('internal', 'pi-delegate-child-v1', executor)
  const calls = storage.calls ?? new InMemoryToolCallRepository()
  const service = new PolicyControlledToolExecutionService({
    gateway,
    calls,
    authorizer: new StaticToolPolicyAuthorizer({
      effect: decision,
      decisionId: 'child-policy-v1',
      policyVersion: 'v1',
      reasonCode: decision === 'allow' ? 'GRANTED' : 'POLICY_DENIED',
      requiresApproval: true,
      evaluatedAt: '2026-08-25T18:01:00.000Z',
    }),
    approvals: {
      async review(request) {
        return {
          state: approval,
          interactionId: request.interactionId,
          decisionPrincipalRef: 'user:original',
        }
      },
    },
    rateLimiter: new InMemoryToolRateLimiter(),
    now: () => '2026-08-25T18:02:00.000Z',
  })
  const request = {
    toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
    idempotencyKey: 'lead-child-command-v1',
    requestedAt: '2026-08-25T18:01:00.000Z',
    policySnapshotRef: 'policy://workspace/v1',
    requestId: ids.requestId,
    executionId: ids.parentExecutionId,
    attemptId: parentAttemptId,
    workspaceId: ids.workspaceId,
    profileId: ids.profileId,
    toolDefinitionId: toolId,
    toolVersionId: versionId,
    operation: 'delegate-child',
    input: { objective: command.delegation.objective },
    grant: {
      workspaceId: ids.workspaceId,
      profileId: ids.profileId,
      toolDefinitionId: toolId,
      toolVersionId: versionId,
      operations: ['delegate-child'],
    },
    audit: { principalRef, traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
    approval: {
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
      allowedPrincipalIds: [principalRef],
      requestedAt: '2026-08-25T18:01:00.000Z',
      expiresAt: '2026-08-25T18:10:00.000Z',
    },
  }
  resolver = new CanonicalDelegationCommandResolver({
    admissions,
    calls,
    // Current original actor/scope/provider/funding composition is an external port;
    // this fixture separately exercises its denial/cancellation hooks on the bridge.
    async assertAuthority(admission) {
      await onCommandAuthority?.(admission)
    },
  })
  const admission = {
    schemaVersion: 'delegation-tool-admission/v1',
    sourceKey,
    request,
    command,
  }
  if (retainAdmission) await admissions.retain(admission)
  return {
    ...f,
    bridge,
    bridgeOptions,
    command,
    executor,
    service,
    request,
    starts,
    sessions,
    version,
    admissions,
    admission,
    resolver,
    calls,
  }
}
