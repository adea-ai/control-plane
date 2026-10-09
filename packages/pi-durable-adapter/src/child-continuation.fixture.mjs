import { ExecutionLifecycleService, InMemoryExecutionRepository } from '@control-plane/domain'
import { ExecutionPlanCompiler, deriveExecutionPlan } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { toolRequestDigest, toolInputDigest } from '@control-plane/tool-execution'
import {
  piChildContinuationRequestDigest,
  piChildContinuationAdmissionDigest,
  piChildContinuationStartRequestDigest,
} from './child-continuation.ts'
import { piDurableToolSourceKey } from './tool-source.ts'
export const id = (prefix, child = false) =>
  `${prefix}_${child ? '01JBBCDEF0123456789ABCDEFG' : '01JABCDEF0123456789ABCDEFG'}`
export const at = '2026-10-08T00:00:00.000Z'
export const createdAt = '2026-10-08T00:01:00.000Z'
export const expiresAt = '2026-10-08T00:10:00.000Z'
export const deadlineAt = '2026-10-08T01:00:00.000Z'
export async function fixture() {
  const inputs = createExecutionPlanTestFixtureInputs()
  const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
  const childPlan = deriveExecutionPlan(parentPlan, {
    correlation: { ...parentPlan.correlation, taskId: id('tsk', true), requestId: id('req', true) },
    contextPackage: inputs.contextPackage,
    constraints: parentPlan.constraints,
    runtimeRequirements: parentPlan.runtimeRequirements,
    outputContract: parentPlan.outputContract,
    compiledAt: parentPlan.compiledAt,
  })
  const planPin = (plan) => ({
    executionPlanId: plan.executionPlanId,
    contentDigest: plan.contentDigest,
    schemaVersion: plan.schemaVersion,
  })
  const repository = new InMemoryExecutionRepository()
  const lifecycle = new ExecutionLifecycleService(repository)
  for (const [plan, child] of [
    [parentPlan, false],
    [childPlan, true],
  ]) {
    let execution = await lifecycle.createExecution({
      executionId: id('exe', child),
      correlation: plan.correlation,
      executionPlan: planPin(plan),
      acceptedAt: at,
      ...(child ? { parentExecutionId: id('exe') } : {}),
    })
    let attempt = await lifecycle.createAttempt({
      executionId: execution.executionId,
      attemptId: id('att', child),
      expectedExecutionVersion: execution.version,
      queuedAt: at,
    })
    execution = await repository.getExecution(execution.executionId)
    for (const state of ['queued', 'starting', 'running'])
      execution = await lifecycle.transitionExecution({
        executionId: execution.executionId,
        expectedVersion: execution.version,
        to: state,
        transitionedAt: at,
      })
    for (const state of ['starting', 'running'])
      attempt = await lifecycle.transitionAttempt({
        attemptId: attempt.attemptId,
        expectedVersion: attempt.version,
        to: state,
        transitionedAt: at,
      })
  }
  const handle = {
    handleId: 'pi-durable:child',
    attemptId: id('att', true),
    externalSessionId: id('ses', true),
    startedAt: at,
  }
  const budget = {
    schemaVersion: 1,
    workspaceId: parentPlan.correlation.workspaceId,
    executionId: id('exe', true),
    attemptId: id('att', true),
    executionPlanId: childPlan.executionPlanId,
    executionPlanDigest: childPlan.contentDigest,
    reservationKey: `runtime-attempt:${id('att', true)}`,
    currency: 'USD',
    maximumMicrounits: 1000,
    maximumTokens: 100,
  }
  const authority = {
    request: {
      executionId: id('exe', true),
      attemptId: id('att', true),
      idempotencyKey: 'retained-child:one',
      executionPlan: childPlan,
      attemptBudget: budget,
    },
    admission: {
      schemaVersion: 'pi-durable-admission/v1',
      prompt: 'Original child objective',
      canonicalActorPrincipalId: 'actor:original',
      selection: { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 },
      authority: {
        revision: 1,
        principalRef: 'lease:child',
        scopeRef: 'scope:child',
        expiresAt: deadlineAt,
      },
    },
  }
  const source = {
    schemaVersion: 'pi-tool-source/v1',
    workspaceId: budget.workspaceId,
    parentExecutionId: id('exe'),
    parentAttemptId: id('att'),
    runtimeHandleId: 'pi-durable:parent',
    externalSessionId: id('ses'),
    admittedTurnKey: 'retained-turn:one',
    conversationId: '1',
    taskId: '2',
    assistantEntryId: '3',
    callId: 'delegate_call:one',
  }
  const request = {
    requestId: id('req'),
    toolCallId: id('tlc'),
    executionId: id('exe'),
    attemptId: id('att'),
    workspaceId: budget.workspaceId,
    profileId: parentPlan.profile.profileId,
    toolDefinitionId: id('tld'),
    toolVersionId: id('tlv'),
    operation: 'delegate-child',
    input: { objective: 'Original child objective' },
    idempotencyKey: 'native-child:one',
    requestedAt: at,
    policySnapshotRef: 'policy://continuation/v1',
    grant: {
      workspaceId: budget.workspaceId,
      profileId: parentPlan.profile.profileId,
      toolDefinitionId: id('tld'),
      toolVersionId: id('tlv'),
      operations: ['delegate-child'],
      expiresAt: deadlineAt,
    },
    audit: { principalRef: 'actor:original', traceId: id('trc') },
    approval: {
      interactionId: id('int'),
      allowedPrincipalIds: ['actor:approver'],
      requestedAt: at,
      expiresAt: deadlineAt,
    },
  }
  const grant = {
    schemaVersion: 'pi-child-continuation/v1',
    grantRef: `pcc_${'b'.repeat(32)}`,
    workspaceId: budget.workspaceId,
    canonicalActorPrincipalId: 'actor:original',
    parent: {
      executionId: id('exe'),
      attemptId: id('att'),
      executionPlan: planPin(parentPlan),
      runtime: null,
    },
    child: {
      executionId: id('exe', true),
      attemptId: id('att', true),
      executionPlan: planPin(childPlan),
      runtime: null,
      handle,
      admissionDigest: piChildContinuationAdmissionDigest(authority.admission),
      startRequestDigest: piChildContinuationStartRequestDigest(authority.request),
    },
    source,
    sourceKey: piDurableToolSourceKey(source),
    requestDigest: piChildContinuationRequestDigest(request),
    admittedToolCallId: id('tlc'),
    approval: {
      interactionId: id('int'),
      principalRef: 'actor:approver',
      grantRef: 'grant:original',
      grantRevision: 1,
    },
    selection: authority.admission.selection,
    budget,
    authorityRevision: 1,
    createdAt,
    expiresAt,
  }
  const executor = { type: 'internal', reference: 'pi-delegate-child-v1' }
  const call = {
    toolCallId: request.toolCallId,
    requestDigest: toolRequestDigest(request),
    executionId: request.executionId,
    attemptId: request.attemptId,
    workspaceId: request.workspaceId,
    profileId: request.profileId,
    principalRef: request.audit.principalRef,
    toolDefinitionId: request.toolDefinitionId,
    toolVersionId: request.toolVersionId,
    operation: request.operation,
    inputDigest: toolInputDigest(request.input),
    policySnapshotRef: request.policySnapshotRef,
    policyDecision: {
      effect: 'allow',
      decisionId: 'decision:one',
      policyVersion: 'v1',
      reasonCode: 'GRANTED',
      requiresApproval: true,
      evaluatedAt: at,
    },
    approvalInteractionId: id('int'),
    approvalPrincipalRef: 'actor:approver',
    executor,
    idempotencyKey: request.idempotencyKey,
    status: 'succeeded',
    revision: 5,
    requestedAt: at,
    authorizedAt: at,
    startedAt: at,
    completedAt: at,
    history: [{ status: 'succeeded', at }],
    result: {
      toolDefinitionId: request.toolDefinitionId,
      toolVersionId: request.toolVersionId,
      operation: request.operation,
      output: {
        delegationId: id('dlg'),
        childExecutionId: id('exe', true),
        childAttemptId: id('att', true),
        externalSessionId: handle.externalSessionId,
      },
      artifactRefs: [],
      executor,
      attempts: 1,
      audit: {
        principalRef: 'actor:original',
        traceId: id('trc'),
        contentDigest: `sha256:${'c'.repeat(64)}`,
      },
    },
  }
  const snapshot = async () => ({
    parentExecution: await repository.getExecution(id('exe')),
    parentAttempt: await repository.getAttempt(id('att')),
    childExecution: await repository.getExecution(id('exe', true)),
    childAttempt: await repository.getAttempt(id('att', true)),
    parentPlan,
    childPlan,
    childHandle: handle,
  })
  const current = () => ({
    revoked: false,
    actorActive: true,
    scopeActive: true,
    providerActive: true,
    spendingActive: true,
    canonicalActorPrincipalId: grant.canonicalActorPrincipalId,
    authorityRevision: grant.authorityRevision,
    approval: grant.approval,
    selection: grant.selection,
    budget: grant.budget,
  })
  return { grant, authority, request, call, snapshot, lifecycle, repository, current }
}
