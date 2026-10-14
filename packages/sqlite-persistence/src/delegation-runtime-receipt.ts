import { canonicalJsonStringify } from '@control-plane/contracts'
import type { PersistenceTransaction } from '@control-plane/deployment'
import { ExecutionSchema, ExecutionAttemptSchema } from '@control-plane/domain'
import {
  assertChildAdmissionReceiptMatches,
  ChildAdmissionRequestSchema,
  ChildAdmissionReceiptSchema,
  ChildRuntimeLookupReceiptSchema,
  DelegationRecordSchema,
  DelegationToolAdmissionSchema,
  childRuntimeDigest,
  type ChildRuntimeLookupReceipt,
  type ChildRuntimeLookupSnapshot,
} from '@control-plane/orchestration'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { recordId } from './record-storage.js'
import { childAdmissionNamespace, childRuntimeLookupNamespace } from './delegation-child-mapping.js'
import { assertSqliteStoredPlanReference } from './repositories.js'
import { readToolCallIn } from './tool-repositories.js'

export { childRuntimeLookupNamespace }

/** Reads through the caller's open transaction only. Historical receipts prove
 * identity, never current access. Authority is separately checked by the host port.
 */
export async function readChildRuntimeContext(
  tx: PersistenceTransaction,
  delegationId: string,
  requestInput?: ChildRuntimeLookupReceipt['request']
): Promise<ChildRuntimeLookupSnapshot> {
  const record = DelegationRecordSchema.parse(
    (await tx.get('delegations', recordId(delegationId)))?.value
  )
  const admissionRow = await tx.get(childAdmissionNamespace, recordId(delegationId))
  const rawAdmission = admissionRow?.value as unknown as
    | { request?: unknown; receipt?: unknown }
    | undefined
  const admission = {
    request: ChildAdmissionRequestSchema.parse(rawAdmission?.request),
    receipt: ChildAdmissionReceiptSchema.parse(rawAdmission?.receipt),
  }
  const pin = admission.request
  assertChildAdmissionReceiptMatches(pin, admission.receipt, pin.acceptedAt)
  const saved = await tx.get(childRuntimeLookupNamespace, recordId(pin.childAttemptId))
  const retained = saved ? ChildRuntimeLookupReceiptSchema.parse(saved.value) : undefined
  const request = requestInput ?? retained?.request
  if (!request) throw new Error('CHILD_RUNTIME_LOOKUP_MISSING')
  const compilerIndex = await tx.get(
    `delegation-tool-call-admissions-${pin.workspaceId.toLowerCase()}`,
    recordId(pin.admittedToolCallId)
  )
  const requestId = (compilerIndex?.value as { requestId?: unknown } | undefined)?.requestId
  if (typeof requestId !== 'string') throw new Error('CHILD_RUNTIME_LOOKUP_STALE')
  const compiler = DelegationToolAdmissionSchema.parse(
    (
      await tx.get(
        `delegation-tool-admissions-${pin.workspaceId.toLowerCase()}`,
        recordId(requestId)
      )
    )?.value
  )
  const call = await readToolCallIn(tx, pin.workspaceId, pin.admittedToolCallId)
  const parent = ExecutionSchema.parse(
    (await tx.get('executions', recordId(pin.parentExecutionId)))?.value
  )
  const parentAttempt = ExecutionAttemptSchema.parse(
    (await tx.get('execution-attempts', recordId(pin.parentAttemptId)))?.value
  )
  const child = ExecutionSchema.parse(
    (await tx.get('executions', recordId(pin.childExecutionId)))?.value
  )
  const childAttempt = ExecutionAttemptSchema.parse(
    (await tx.get('execution-attempts', recordId(pin.childAttemptId)))?.value
  )
  const plan = await assertSqliteStoredPlanReference(tx, pin.childPlan)
  const parentPlan = await assertSqliteStoredPlanReference(tx, pin.parentPlan)
  assertExecutionPlanIntegrity(request.executionPlan)
  if (
    record.delegationId !== delegationId ||
    pin.delegationId !== delegationId ||
    record.parentExecutionId !== pin.parentExecutionId ||
    record.parentAttemptId !== pin.parentAttemptId ||
    record.childExecutionId !== pin.childExecutionId ||
    record.childAttemptId !== pin.childAttemptId ||
    record.admittedToolCallId !== pin.admittedToolCallId ||
    record.runtimeConnectionId !== pin.childDispatch.runtime.runtimeConnectionId ||
    record.childExecutionPlanId !== pin.childPlan.executionPlanId ||
    record.childExecutionPlanDigest !== pin.childPlan.contentDigest ||
    record.parentExecutionPlanId !== pin.parentPlan.executionPlanId ||
    record.parentExecutionPlanDigest !== pin.parentPlan.contentDigest ||
    parent.executionId !== pin.parentExecutionId ||
    parent.latestAttemptId !== pin.parentAttemptId ||
    parent.correlation.workspaceId !== pin.workspaceId ||
    parent.executionPlan.executionPlanId !== pin.parentPlan.executionPlanId ||
    parent.executionPlan.contentDigest !== pin.parentPlan.contentDigest ||
    parentAttempt.attemptId !== pin.parentAttemptId ||
    parentAttempt.executionId !== parent.executionId ||
    parentAttempt.sequence !== parent.attemptCount ||
    child.executionId !== pin.childExecutionId ||
    child.parentExecutionId !== parent.executionId ||
    child.latestAttemptId !== pin.childAttemptId ||
    child.correlation.workspaceId !== pin.workspaceId ||
    child.executionPlan.executionPlanId !== pin.childPlan.executionPlanId ||
    child.executionPlan.contentDigest !== pin.childPlan.contentDigest ||
    childAttempt.attemptId !== pin.childAttemptId ||
    childAttempt.executionId !== child.executionId ||
    childAttempt.sequence !== child.attemptCount ||
    childAttempt.runtime?.runtimeConnectionId !== record.runtimeConnectionId ||
    request.executionId !== pin.childExecutionId ||
    request.attemptId !== pin.childAttemptId ||
    canonicalJsonStringify(request.executionPlan) !== canonicalJsonStringify(plan) ||
    !call ||
    call.executionId !== pin.parentExecutionId ||
    call.attemptId !== pin.parentAttemptId ||
    call.principalRef !== pin.originalActorPrincipalId ||
    call.workspaceId !== pin.workspaceId ||
    compiler.request.toolCallId !== pin.admittedToolCallId ||
    compiler.request.audit.principalRef !== pin.originalActorPrincipalId ||
    compiler.request.executionId !== pin.parentExecutionId ||
    compiler.request.attemptId !== pin.parentAttemptId ||
    compiler.request.workspaceId !== pin.workspaceId ||
    call.idempotencyKey !== compiler.request.idempotencyKey ||
    call.toolDefinitionId !== compiler.request.toolDefinitionId ||
    call.toolVersionId !== compiler.request.toolVersionId ||
    call.profileId !== compiler.request.profileId ||
    call.operation !== compiler.request.operation ||
    call.inputDigest !== childRuntimeDigest(compiler.request.input) ||
    call.policySnapshotRef !== compiler.request.policySnapshotRef ||
    compiler.command.delegation.delegationId !== pin.delegationId ||
    compiler.command.delegation.childExecutionId !== pin.childExecutionId ||
    compiler.command.dispatch.childAttemptId !== pin.childAttemptId ||
    compiler.command.dispatch.runtime.runtimeConnectionId !== record.runtimeConnectionId ||
    canonicalJsonStringify(compiler.command.delegation.parentPlan) !==
      canonicalJsonStringify(parentPlan)
  )
    throw new Error('CHILD_RUNTIME_LOOKUP_STALE')
  if (
    requestInput &&
    (!['running', 'awaiting_input'].includes(parent.state) ||
      !['queued', 'starting', 'running', 'awaiting_input'].includes(childAttempt.state) ||
      !['dispatched', 'running', 'awaiting_input'].includes(record.state) ||
      !['executing', 'succeeded'].includes(call.status))
  )
    throw new Error('CHILD_RUNTIME_LOOKUP_STALE')
  const receipt = ChildRuntimeLookupReceiptSchema.parse({
    schemaVersion: 'child-runtime-lookup/v1',
    workspaceId: pin.workspaceId,
    originalActorPrincipalId: pin.originalActorPrincipalId,
    parentExecutionId: pin.parentExecutionId,
    parentAttemptId: pin.parentAttemptId,
    admittedToolCallId: pin.admittedToolCallId,
    delegationId,
    childExecutionId: pin.childExecutionId,
    childAttemptId: pin.childAttemptId,
    runtimeConnectionId: pin.childDispatch.runtime.runtimeConnectionId,
    compilerAdmissionDigest: childRuntimeDigest(compiler),
    childAdmissionDigest: childRuntimeDigest(admission),
    request,
    requestDigest: childRuntimeDigest(request),
  })
  if (retained && canonicalJsonStringify(retained) !== canonicalJsonStringify(receipt))
    throw new Error('CHILD_RUNTIME_LOOKUP_CONFLICT')
  return {
    receipt,
    fence: childRuntimeDigest({
      record,
      parent,
      parentAttempt,
      child,
      childAttempt,
      compiler,
      admission,
      call,
    }),
  }
}
