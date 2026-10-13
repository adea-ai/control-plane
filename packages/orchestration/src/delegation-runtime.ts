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
  ChildReceiptReadBindingSchema,
  type ChildReceiptReadAuthority,
  type ChildRuntimeLookupReceipt,
  type ChildRuntimeLookupSnapshot,
  type RecoveredChildSessionMapping,
} from './child-runtime-receipt.js'
import type { ChildAdmissionReader } from './child-admission.js'
import {
  ChildProgressInputSchema,
  DelegateInputSchema,
  DispatchInputSchema,
  type DelegationRecord,
  type DelegationRepository,
  type DelegationService,
  type DelegationEventPublisher,
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

/** Storage-owned receipt seam. Retaining evidence grants no runtime or spend authority. */
export interface DelegationRuntimeReceiptRepository {
  retainChildRuntimeStart(input: {
    delegationId: string
    request: RuntimeStartRequest
  }): Promise<void>
  getChildRuntimeStart(delegationId: string): Promise<ChildRuntimeLookupSnapshot>
  bindRecoveredChildSession(input: {
    snapshot: ChildRuntimeLookupSnapshot
    externalSessionId: string
    assertCurrent: (reader: ChildAdmissionReader) => Promise<void>
  }): Promise<RecoveredChildSessionMapping>

  bindChildSession(
    expectedRevision: number,
    mapping: {
      workspaceId: string
      parentExecutionId: string
      delegationId: string
      childExecutionId: string
      childAttemptId: string
      runtimeConnectionId: string
      externalSessionId: string
    }
  ): Promise<unknown>
  recoverTerminalPublication(
    delegationId: string,
    publisher: DelegationEventPublisher
  ): Promise<DelegationRecord>
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
      /** Configure together for canonical native-session retention and terminal replay. */
      readonly childReceipts?: DelegationRuntimeReceiptRepository
      readonly terminalPublisher?: DelegationEventPublisher
      /** Host wiring must independently authenticate/qualify this port; JSON/schema is not authentication. */
      readonly receiptReadAuthority?: ChildReceiptReadAuthority
      readonly nativeReceiptReader?: {
        readonly runtimeConnectionId: string
        findExistingHandle(request: RuntimeStartRequest): Promise<unknown>
      }
      /** Re-read originating tool call/approval, actor, policy, provider and funding. */
      readonly assertAuthority: (admission: CanonicalDelegationAdmission) => Promise<void>
      /** Must recover the same separately authorized reservation on replay. */
      readonly reserveBudget: (
        admission: CanonicalDelegationAdmission
      ) => Promise<RuntimeAttemptBudgetAuthority>
    }
  ) {
    IdentifierSchemas.runtimeConnectionId.parse(options.runtimeConnectionId)
    if ((options.childReceipts === undefined) !== (options.terminalPublisher === undefined)) deny()
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
    // The host authority check also awaits: canonical cancellation/attempt fences must
    // be read after it returns, including recovery callers without an AbortSignal.
    const final = await this.resolve(admission.identity)
    assertNotAborted(signal)
    return RuntimeStartRequestSchema.parse({
      attemptId: final.attempt.attemptId,
      executionId: final.record.childExecutionId,
      executionPlan: final.plan,
      idempotencyKey: `delegation:${final.record.delegationId}:attempt:${final.attempt.attemptId}`,
      attemptBudget,
    })
  }

  async startChild(input: unknown, signal?: AbortSignal) {
    const identity = DelegationRuntimeAdmissionRequestSchema.parse(input)
    const request = await this.resolveStart(identity, signal)
    if (this.options.childReceipts) {
      await this.options.childReceipts.retainChildRuntimeStart({
        delegationId: identity.delegationId,
        request,
      })
      assertNotAborted(signal)
      const retained = await this.resolve(identity)
      assertNotAborted(signal)
      // Retention awaits after resolveStart's authority check. Refresh the host
      // proof without reserving again, then fence canonical state after its await.
      await this.options.assertAuthority(structuredClone(retained))
      assertNotAborted(signal)
      await this.resolve(identity)
    }
    assertNotAborted(signal)
    const handle = RuntimeExecutionHandleSchema.parse(await this.options.runtime.start(request))
    if (handle.attemptId !== request.attemptId) deny()
    if (this.options.childReceipts) {
      if (!handle.externalSessionId) deny()
      const record = await this.options.records.get(identity.delegationId)
      if (
        !record ||
        record.parentExecutionId !== identity.parentExecutionId ||
        record.parentAttemptId !== identity.parentAttemptId ||
        record.childExecutionId !== request.executionId ||
        record.childAttemptId !== handle.attemptId
      )
        deny()
      // A native effect has already returned. Retain that evidence without asking
      // for new spending/dispatch authority; storage fences this exact current attempt.
      await this.options.childReceipts.bindChildSession(record.revision, {
        workspaceId: ExecutionPlanSchema.parse(request.executionPlan).correlation.workspaceId,
        parentExecutionId: identity.parentExecutionId,
        delegationId: record.delegationId,
        childExecutionId: request.executionId,
        childAttemptId: handle.attemptId,
        runtimeConnectionId: this.options.runtimeConnectionId,
        externalSessionId: handle.externalSessionId,
      })
    }
    return handle
  }

  async recoverChildSession(input: unknown) {
    const identity = DelegationRuntimeAdmissionRequestSchema.parse(input)
    const store = this.options.childReceipts
    const reader = this.options.nativeReceiptReader
    const authority = this.options.receiptReadAuthority
    if (
      !store ||
      !reader ||
      !authority ||
      typeof authority.assertQualified !== 'function' ||
      typeof authority.assertCurrent !== 'function' ||
      typeof authority.now !== 'function'
    )
      deny()
    const snapshot = await store.getChildRuntimeStart(identity.delegationId)
    const r = snapshot.receipt
    if (
      r.parentExecutionId !== identity.parentExecutionId ||
      r.parentAttemptId !== identity.parentAttemptId ||
      r.childAttemptId !== identity.childAttemptId ||
      r.runtimeConnectionId !== this.options.runtimeConnectionId ||
      reader.runtimeConnectionId !== r.runtimeConnectionId
    )
      deny()
    const first = await this.#receiptRead(r, authority, reader)
    // This reader is metadata-only. No start/resolveStart, spending or inference path is called.
    const untrusted = await reader.findExistingHandle(structuredClone(r.request))
    const after = await this.#receiptRead(r, authority, reader)
    if (canonicalJsonStringify(first) !== canonicalJsonStringify(after)) deny()
    if (untrusted === undefined) throw new Error('CHILD_NATIVE_RECEIPT_MISSING')
    const handle = RuntimeExecutionHandleSchema.parse(untrusted)
    if (handle.attemptId !== r.childAttemptId || !handle.externalSessionId) deny()
    const mapping = await store.bindRecoveredChildSession({
      snapshot,
      externalSessionId: handle.externalSessionId,
      assertCurrent: async (transactionReader) => {
        const final = await this.#receiptRead(r, authority, reader, transactionReader)
        if (canonicalJsonStringify(first) !== canonicalJsonStringify(final)) deny()
      },
    })
    return { mapping, handle }
  }

  async #receiptRead(
    receipt: ChildRuntimeLookupReceipt,
    authority: ChildReceiptReadAuthority,
    nativeReceiptReader: object,
    reader?: ChildAdmissionReader
  ) {
    const scope = {
      workspaceId: receipt.workspaceId,
      runtimeConnectionId: receipt.runtimeConnectionId,
      nativeReceiptReader,
    }
    await authority.assertQualified(scope)
    const binding = ChildReceiptReadBindingSchema.parse(
      await authority.assertCurrent(structuredClone(receipt), reader)
    )
    await authority.assertQualified(scope)
    if (
      binding.workspaceId !== receipt.workspaceId ||
      binding.runtimeConnectionId !== receipt.runtimeConnectionId ||
      binding.originalActorPrincipalId !== receipt.originalActorPrincipalId ||
      binding.readerPrincipalId !== authority.readerPrincipalId ||
      binding.audienceRef !== authority.audienceRef ||
      !Number.isFinite(Date.parse(authority.now())) ||
      Date.parse(binding.expiresAt) <= Date.parse(authority.now())
    )
      deny()
    return binding
  }

  /** Terminal replay is receipt delivery only: it must not start a runtime or refresh authority. */
  async recoverTerminalPublication(identityInput: unknown): Promise<DelegationRecord> {
    const identity = DelegationRuntimeAdmissionRequestSchema.parse(identityInput)
    const record = await this.options.records.get(identity.delegationId)
    const receipts = this.options.childReceipts
    const publisher = this.options.terminalPublisher
    if (
      !receipts ||
      !publisher ||
      !record ||
      record.parentExecutionId !== identity.parentExecutionId ||
      record.parentAttemptId !== identity.parentAttemptId ||
      record.childAttemptId !== identity.childAttemptId ||
      !record.terminalPublication
    )
      deny()
    return receipts.recoverTerminalPublication(record.delegationId, publisher)
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
      parentPlan.constraints.limits.childExecutions.maximumTotal < 1
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
    await this.options.delegations.delegate({ ...delegation, initialDispatch: dispatch })
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
