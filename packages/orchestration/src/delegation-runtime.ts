import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import type { ExecutionAttempt, ExecutionLifecycleService } from '@control-plane/domain'
import {
  ExecutionPlanSchema,
  type ExecutionPlan,
  type ExecutionPlanRepository,
} from '@control-plane/execution-plan'
import {
  RuntimeExecutionHandleSchema,
  RuntimeStartRequestSchema,
  type RuntimeAdapter,
  type RuntimeAttemptBudgetAuthority,
  type RuntimeStartRequest,
} from '@control-plane/runtime-sdk'
import {
  ToolExecutionRequestSchema,
  type ToolExecutor,
  type ToolExecutionRequest,
  type ToolVersion,
} from '@control-plane/tool-sdk'
import { z } from 'zod'
import {
  ChildProgressInputSchema,
  DelegateInputSchema,
  DispatchInputSchema,
  type DelegationRecord,
  type DelegationRepository,
  type DelegationService,
} from './delegation.js'

/** Trusted host identity. No model, credential, audience or current-attempt inference. */
export const DelegationRuntimeAdmissionRequestSchema = z
  .object({
    schemaVersion: z.literal('delegation-runtime-admission/v1'),
    parentExecutionId: IdentifierSchemas.executionId,
    parentAttemptId: IdentifierSchemas.attemptId,
    delegationId: IdentifierSchemas.delegationId,
    childAttemptId: IdentifierSchemas.attemptId,
  })
  .strict()
export type DelegationRuntimeAdmissionRequest = z.output<
  typeof DelegationRuntimeAdmissionRequestSchema
>
export const DelegateChildToolInputSchema = z
  .object({ objective: z.string().trim().min(1).max(8192) })
  .strict()

export interface CanonicalDelegationAdmission {
  readonly identity: DelegationRuntimeAdmissionRequest
  readonly record: DelegationRecord
  readonly plan: ExecutionPlan
  readonly attempt: ExecutionAttempt
}

export class DelegationRuntimeAdmissionError extends Error {
  constructor() {
    super('DELEGATION_RUNTIME_ADMISSION_DENIED')
    this.name = 'DelegationRuntimeAdmissionError'
  }
}
function deny(): never {
  throw new DelegationRuntimeAdmissionError()
}
function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) deny()
}
const active = new Set(['queued', 'starting', 'running', 'awaiting_input'])

/** Resolves only persisted canonical child identities. Runtime owns model/funding authority. */
export class CanonicalDelegationRuntimeBridge {
  constructor(
    readonly options: {
      readonly records: DelegationRepository
      readonly lifecycle: ExecutionLifecycleService
      readonly plans: ExecutionPlanRepository
      readonly delegations: Pick<DelegationService, 'recordChildProgress'>
      readonly runtime: Pick<RuntimeAdapter, 'start'>
      readonly runtimeConnectionId: string
      /** Re-read originating tool call/approval, actor, policy, provider and funding. */
      readonly assertAuthority: (admission: CanonicalDelegationAdmission) => Promise<void>
      /** Must recover the same separately authorized reservation on replay. */
      readonly reserveBudget: (
        admission: CanonicalDelegationAdmission
      ) => Promise<RuntimeAttemptBudgetAuthority>
    }
  ) {
    IdentifierSchemas.runtimeConnectionId.parse(options.runtimeConnectionId)
  }

  async resolve(input: unknown): Promise<CanonicalDelegationAdmission> {
    const identity = DelegationRuntimeAdmissionRequestSchema.parse(input)
    const record = await this.options.records.get(identity.delegationId)
    const parent = await this.options.lifecycle.getExecution(identity.parentExecutionId)
    const parentAttempt = await this.options.lifecycle.repository.getAttempt(
      identity.parentAttemptId
    )
    if (
      !record ||
      !record.admittedToolCallId ||
      record.parentExecutionId !== identity.parentExecutionId ||
      record.parentAttemptId !== identity.parentAttemptId ||
      record.childAttemptId !== identity.childAttemptId ||
      !['dispatched', 'running', 'awaiting_input'].includes(record.state) ||
      !['running', 'awaiting_input'].includes(parent.state) ||
      parent.latestAttemptId !== identity.parentAttemptId ||
      !parentAttempt ||
      parentAttempt.executionId !== parent.executionId ||
      !active.has(parentAttempt.state) ||
      parent.executionPlan.executionPlanId !== record.parentExecutionPlanId ||
      parent.executionPlan.contentDigest !== record.parentExecutionPlanDigest
    )
      deny()
    const child = await this.options.lifecycle.getExecution(record.childExecutionId)
    const attempt = await this.options.lifecycle.repository.getAttempt(identity.childAttemptId)
    const stored = await this.options.plans.get({
      executionPlanId: record.childExecutionPlanId,
      contentDigest: record.childExecutionPlanDigest,
    })
    if (
      !stored ||
      !attempt ||
      attempt.executionId !== child.executionId ||
      child.parentExecutionId !== parent.executionId ||
      child.latestAttemptId !== identity.childAttemptId ||
      !active.has(child.state) ||
      !active.has(attempt.state) ||
      attempt.runtime?.runtimeConnectionId !== this.options.runtimeConnectionId ||
      record.runtimeConnectionId !== this.options.runtimeConnectionId ||
      child.executionPlan.executionPlanId !== record.childExecutionPlanId ||
      child.executionPlan.contentDigest !== record.childExecutionPlanDigest
    )
      deny()
    const plan = ExecutionPlanSchema.parse(stored)
    if (
      plan.parentExecutionPlan?.executionPlanId !== record.parentExecutionPlanId ||
      plan.parentExecutionPlan.contentDigest !== record.parentExecutionPlanDigest ||
      plan.contextPackage.contextPackageId !== record.contextPackageId ||
      plan.contextPackage.contentDigest !== record.contextPackageDigest ||
      plan.correlation.workspaceId !== parent.correlation.workspaceId
    )
      deny()
    return { identity, record, plan, attempt }
  }

  async resolveStart(input: unknown, signal?: AbortSignal): Promise<RuntimeStartRequest> {
    assertNotAborted(signal)
    const admission = await this.resolve(input)
    assertNotAborted(signal)
    await this.options.assertAuthority(structuredClone(admission))
    assertNotAborted(signal)
    const attemptBudget = await this.options.reserveBudget(structuredClone(admission))
    assertNotAborted(signal)
    // Authority can change while budget resolution awaits. Re-read before inference admission.
    const current = await this.resolve(admission.identity)
    assertNotAborted(signal)
    await this.options.assertAuthority(structuredClone(current))
    assertNotAborted(signal)
    return RuntimeStartRequestSchema.parse({
      attemptId: current.attempt.attemptId,
      executionId: current.record.childExecutionId,
      executionPlan: current.plan,
      idempotencyKey: `delegation:${current.record.delegationId}:attempt:${current.attempt.attemptId}`,
      attemptBudget,
    })
  }

  async startChild(input: unknown, signal?: AbortSignal) {
    const request = await this.resolveStart(input, signal)
    assertNotAborted(signal)
    const handle = RuntimeExecutionHandleSchema.parse(await this.options.runtime.start(request))
    if (handle.attemptId !== request.attemptId) deny()
    return handle
  }

  async recordProgress(identityInput: unknown, progressInput: unknown) {
    const identity = DelegationRuntimeAdmissionRequestSchema.parse(identityInput)
    const progress = ChildProgressInputSchema.parse(progressInput)
    const record = await this.options.records.get(identity.delegationId)
    if (
      !record ||
      record.parentExecutionId !== identity.parentExecutionId ||
      record.parentAttemptId !== identity.parentAttemptId ||
      progress.delegationId !== identity.delegationId ||
      progress.childAttemptId !== identity.childAttemptId
    )
      deny()
    // Evidence remains retainable after parent cancellation; child attempt fencing is canonical.
    return this.options.delegations.recordChildProgress(progress)
  }
}

/** Register only behind the existing policy/approval tool service and Pi effect gate. */
export class GovernedDelegateChildExecutor implements ToolExecutor {
  constructor(
    readonly options: {
      readonly toolDefinitionId: string
      readonly toolVersionId: string
      readonly parentExecutionId: string
      readonly parentAttemptId: string
      readonly lifecycle: ExecutionLifecycleService
      readonly plans: ExecutionPlanRepository
      readonly delegations: Pick<DelegationService, 'delegate' | 'dispatchChild'>
      readonly bridge: CanonicalDelegationRuntimeBridge
      readonly assertAuthority: (
        request: ToolExecutionRequest,
        parentPlan: ExecutionPlan
      ) => Promise<void>
      /** Server compiler resolves the recorded toolCallId for this request, never guesses it;
       * recovers stable IDs, timestamps and bounded context across process restarts. */
      readonly resolveCommand: (
        request: ToolExecutionRequest
      ) => Promise<{ readonly delegation: unknown; readonly dispatch: unknown }>
    }
  ) {}

  async execute(input: ToolExecutionRequest, version: ToolVersion, signal: AbortSignal) {
    const request = ToolExecutionRequestSchema.parse(input)
    const toolInput = DelegateChildToolInputSchema.parse(request.input)
    if (
      signal.aborted ||
      request.operation !== 'delegate-child' ||
      request.toolDefinitionId !== this.options.toolDefinitionId ||
      request.toolVersionId !== this.options.toolVersionId ||
      version.toolDefinitionId !== request.toolDefinitionId ||
      version.toolVersionId !== request.toolVersionId ||
      request.executionId !== this.options.parentExecutionId ||
      request.attemptId !== this.options.parentAttemptId
    )
      deny()
    const parent = await this.options.lifecycle.getExecution(request.executionId)
    const parentPlan = await this.options.plans.get(parent.executionPlan)
    if (
      !parentPlan ||
      parent.latestAttemptId !== request.attemptId ||
      !['running', 'awaiting_input'].includes(parent.state) ||
      parent.correlation.workspaceId !== request.workspaceId ||
      parentPlan.profile.profileId !== request.profileId ||
      parentPlan.constraints.limits.childExecutions.maximumTotal !== 1
    )
      deny()
    const command = await this.options.resolveCommand(structuredClone(request))
    const delegation = DelegateInputSchema.parse(command.delegation)
    const dispatch = DispatchInputSchema.parse(command.dispatch)
    if (
      signal.aborted ||
      delegation.parentExecutionId !== request.executionId ||
      delegation.parentAttemptId !== request.attemptId ||
      !delegation.admittedToolCallId ||
      delegation.objective !== toolInput.objective ||
      canonicalJsonStringify(delegation.parentPlan) !== canonicalJsonStringify(parentPlan) ||
      dispatch.delegationId !== delegation.delegationId
    )
      deny()
    await this.options.assertAuthority(structuredClone(request), structuredClone(parentPlan))
    const currentParent = await this.options.lifecycle.getExecution(request.executionId)
    if (
      signal.aborted ||
      currentParent.latestAttemptId !== request.attemptId ||
      !['running', 'awaiting_input'].includes(currentParent.state)
    )
      deny()
    await this.options.delegations.delegate(delegation)
    assertNotAborted(signal)
    await this.options.delegations.dispatchChild(dispatch)
    assertNotAborted(signal)
    const identity: DelegationRuntimeAdmissionRequest = {
      schemaVersion: 'delegation-runtime-admission/v1',
      parentExecutionId: request.executionId,
      parentAttemptId: request.attemptId,
      delegationId: delegation.delegationId,
      childAttemptId: dispatch.childAttemptId,
    }
    const handle = await this.options.bridge.startChild(identity, signal)
    return {
      output: {
        delegationId: identity.delegationId,
        childExecutionId: delegation.childExecutionId,
        childAttemptId: identity.childAttemptId,
        ...(handle.externalSessionId ? { externalSessionId: handle.externalSessionId } : {}),
      },
    }
  }
}
