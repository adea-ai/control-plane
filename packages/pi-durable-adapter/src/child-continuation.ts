import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import {
  ExecutionSchema,
  ExecutionAttemptSchema,
  AttemptRuntimeSchema,
  ExecutionPlanPinSchema,
} from '@control-plane/domain'
import { assertExecutionPlanIntegrity, type ExecutionPlan } from '@control-plane/execution-plan'
import {
  RuntimeExecutionHandleSchema,
  RuntimeAttemptBudgetAuthoritySchema,
  RuntimeStartRequestSchema,
  type RuntimeExecutionHandle,
} from '@control-plane/runtime-sdk'
import { DurableToolCallRequestSchema, ToolCallSchema } from '@control-plane/tool-sdk'
import { toolRequestDigest, toolInputMatchesDigest } from '@control-plane/tool-execution'
import {
  PiDurableAdmissionSchema,
  ProviderSelectionReferenceSchema,
  type DurableExecutionAuthority,
} from './contracts.js'
import { PiDurableToolSourceSchema, piDurableToolSourceKey } from './tool-source.js'

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Ref = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/)
const Revision = z.number().int().positive().safe()
const RuntimeMetadata = AttemptRuntimeSchema.nullable()
  .transform((runtime) => {
    if (runtime?.routingDecision) {
      Object.freeze(runtime.routingDecision.policy)
      Object.freeze(runtime.routingDecision.reasonCodes)
      Object.freeze(runtime.routingDecision)
    }
    return runtime
  })
  .readonly()
const Approval = z
  .strictObject({
    interactionId: IdentifierSchemas.interactionId.optional(),
    principalRef: Ref.optional(),
    grantRef: Ref,
    grantRevision: Revision,
  })
  .refine((value) => (value.interactionId === undefined) === (value.principalRef === undefined))
  .readonly()

/** Host-retained evidence only. This record is neither a model credential nor
 * a current actor/scope/provider/spending authorization or publication grant.
 */
export const PiChildContinuationGrantSchema = z
  .strictObject({
    schemaVersion: z.literal('pi-child-continuation/v1'),
    grantRef: z.string().regex(/^pcc_[a-f0-9]{32}$/),
    workspaceId: IdentifierSchemas.workspaceId,
    canonicalActorPrincipalId: Ref,
    parent: z
      .strictObject({
        executionId: IdentifierSchemas.executionId,
        attemptId: IdentifierSchemas.attemptId,
        executionPlan: ExecutionPlanPinSchema.readonly(),
        runtime: RuntimeMetadata,
      })
      .readonly(),
    child: z
      .strictObject({
        executionId: IdentifierSchemas.executionId,
        attemptId: IdentifierSchemas.attemptId,
        executionPlan: ExecutionPlanPinSchema.readonly(),
        runtime: RuntimeMetadata,
        handle: RuntimeExecutionHandleSchema.readonly(),
        admissionDigest: Digest,
        startRequestDigest: Digest,
      })
      .readonly(),
    source: PiDurableToolSourceSchema.readonly(),
    sourceKey: z.string().regex(/^pi-tool:[a-f0-9]{64}$/),
    requestDigest: Digest,
    admittedToolCallId: IdentifierSchemas.toolCallId,
    approval: Approval,
    selection: ProviderSelectionReferenceSchema.readonly(),
    budget: RuntimeAttemptBudgetAuthoritySchema,
    authorityRevision: Revision,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .superRefine((grant, context) => {
    if (
      grant.parent.executionId === grant.child.executionId ||
      grant.parent.attemptId === grant.child.attemptId ||
      grant.source.workspaceId !== grant.workspaceId ||
      grant.source.parentExecutionId !== grant.parent.executionId ||
      grant.source.parentAttemptId !== grant.parent.attemptId ||
      piDurableToolSourceKey(grant.source) !== grant.sourceKey ||
      grant.child.handle.attemptId !== grant.child.attemptId ||
      !grant.child.handle.externalSessionId ||
      grant.budget.workspaceId !== grant.workspaceId ||
      grant.budget.executionId !== grant.child.executionId ||
      grant.budget.attemptId !== grant.child.attemptId ||
      grant.budget.executionPlanId !== grant.child.executionPlan.executionPlanId ||
      grant.budget.executionPlanDigest !== grant.child.executionPlan.contentDigest ||
      Date.parse(grant.createdAt) >= Date.parse(grant.expiresAt) ||
      Date.parse(grant.child.handle.startedAt) > Date.parse(grant.createdAt)
    )
      context.addIssue({ code: 'custom', message: 'Continuation identity is inconsistent' })
  })
  .readonly()
export type PiChildContinuationGrant = z.output<typeof PiChildContinuationGrantSchema>
export interface PiChildContinuationGrantRepository {
  retain(
    grant: PiChildContinuationGrant
  ): Promise<{ grant: PiChildContinuationGrant; replayed: boolean }>
  getByChildAttempt(
    workspaceId: string,
    attemptId: string
  ): Promise<PiChildContinuationGrant | undefined>
}

function digest(input: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(input)).digest('hex')}`
}
export function piChildContinuationRequestDigest(input: unknown): string {
  return digest(DurableToolCallRequestSchema.parse(input))
}
export function piChildContinuationAdmissionDigest(input: unknown): string {
  return digest(PiDurableAdmissionSchema.parse(input))
}
export function piChildContinuationStartRequestDigest(input: unknown): string {
  const request = RuntimeStartRequestSchema.parse(input)
  assertExecutionPlanIntegrity(request.executionPlan)
  return digest(request)
}
function rejected(): never {
  throw new Error('PI_CHILD_CONTINUATION_REJECTED')
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right)
}
function pin(plan: ExecutionPlan) {
  return {
    executionPlanId: plan.executionPlanId,
    contentDigest: plan.contentDigest,
    schemaVersion: plan.schemaVersion,
  }
}
function parse(input: unknown): PiChildContinuationGrant {
  const result = PiChildContinuationGrantSchema.safeParse(input)
  if (!result.success) rejected()
  return result.data
}
function assertTime(grant: PiChildContinuationGrant, now: string) {
  const result = z.iso.datetime().safeParse(now)
  if (
    !result.success ||
    Date.parse(now) < Date.parse(grant.createdAt) ||
    Date.parse(now) >= Date.parse(grant.expiresAt)
  )
    rejected()
}

/** Exact original child admission. This validates immutable evidence; it does
 * not read any current authority and cannot renew a grant's fixed expiration.
 */
export function assertGrantMatchesAuthority(
  input: unknown,
  authority: DurableExecutionAuthority
): PiChildContinuationGrant {
  try {
    const grant = parse(input)
    const request = RuntimeStartRequestSchema.parse(authority.request)
    const admission = PiDurableAdmissionSchema.parse(authority.admission)
    const plan = assertExecutionPlanIntegrity(request.executionPlan)
    if (
      request.executionId !== grant.child.executionId ||
      request.attemptId !== grant.child.attemptId ||
      plan.correlation.workspaceId !== grant.workspaceId ||
      !same(pin(plan), grant.child.executionPlan) ||
      !same(plan.parentExecutionPlan, {
        executionPlanId: grant.parent.executionPlan.executionPlanId,
        contentDigest: grant.parent.executionPlan.contentDigest,
      }) ||
      admission.canonicalActorPrincipalId !== grant.canonicalActorPrincipalId ||
      admission.authority.revision !== grant.authorityRevision ||
      !same(admission.selection, grant.selection) ||
      !same(request.attemptBudget, grant.budget) ||
      piChildContinuationAdmissionDigest(admission) !== grant.child.admissionDigest ||
      piChildContinuationStartRequestDigest(request) !== grant.child.startRequestDigest ||
      Date.parse(grant.expiresAt) > Date.parse(admission.authority.expiresAt)
    )
      rejected()
    return grant
  } catch {
    rejected()
  }
}

/** Mint-time full originating governed request check. The host must additionally
 * verify a succeeded canonical ToolCall and the fresh live native source using
 * verifyPiDurableToolSource. Historical resume must never invoke that live verifier.
 */
export function assertPiChildContinuationRequest(
  input: unknown,
  requestInput: unknown
): PiChildContinuationGrant {
  try {
    const grant = parse(input)
    const request = DurableToolCallRequestSchema.parse(requestInput)
    if (
      piChildContinuationRequestDigest(request) !== grant.requestDigest ||
      request.workspaceId !== grant.workspaceId ||
      request.executionId !== grant.parent.executionId ||
      request.attemptId !== grant.parent.attemptId ||
      request.toolCallId !== grant.admittedToolCallId ||
      request.operation !== 'delegate-child' ||
      request.audit.principalRef !== grant.canonicalActorPrincipalId ||
      Date.parse(request.requestedAt) > Date.parse(grant.createdAt) ||
      (request.grant.expiresAt !== undefined &&
        Date.parse(grant.expiresAt) > Date.parse(request.grant.expiresAt)) ||
      request.approval?.interactionId !== grant.approval.interactionId ||
      (request.approval !== undefined &&
        (!grant.approval.principalRef ||
          !request.approval.allowedPrincipalIds.includes(grant.approval.principalRef) ||
          Date.parse(grant.expiresAt) > Date.parse(request.approval.expiresAt)))
    )
      rejected()
    return grant
  } catch {
    rejected()
  }
}

/** Canonical successful effect evidence. Approval grant revision/current policy
 * still require the authoritative host reader; ToolCall.revision is a different pin.
 */
export function assertPiChildContinuationToolCall(
  input: unknown,
  requestInput: unknown,
  callInput: unknown
): PiChildContinuationGrant {
  try {
    const grant = assertPiChildContinuationRequest(input, requestInput)
    const request = DurableToolCallRequestSchema.parse(requestInput)
    const call = ToolCallSchema.parse(callInput)
    const output = z
      .strictObject({
        delegationId: IdentifierSchemas.delegationId,
        childExecutionId: IdentifierSchemas.executionId,
        childAttemptId: IdentifierSchemas.attemptId,
        externalSessionId: RuntimeExecutionHandleSchema.shape.externalSessionId.unwrap(),
      })
      .parse(call.result?.output)
    if (
      call.status !== 'succeeded' ||
      call.policyDecision?.effect !== 'allow' ||
      call.requestDigest !== toolRequestDigest(request) ||
      !toolInputMatchesDigest(request.input, call.inputDigest) ||
      call.toolCallId !== request.toolCallId ||
      call.executionId !== request.executionId ||
      call.attemptId !== request.attemptId ||
      call.workspaceId !== request.workspaceId ||
      call.principalRef !== grant.canonicalActorPrincipalId ||
      call.profileId !== request.profileId ||
      call.toolDefinitionId !== request.toolDefinitionId ||
      call.toolVersionId !== request.toolVersionId ||
      call.operation !== request.operation ||
      call.idempotencyKey !== request.idempotencyKey ||
      call.policySnapshotRef !== request.policySnapshotRef ||
      call.requestedAt !== request.requestedAt ||
      call.approvalInteractionId !== grant.approval.interactionId ||
      call.approvalPrincipalRef !== grant.approval.principalRef ||
      !call.completedAt ||
      Date.parse(call.completedAt) > Date.parse(grant.createdAt) ||
      call.result?.toolDefinitionId !== request.toolDefinitionId ||
      call.result.toolVersionId !== request.toolVersionId ||
      call.result.operation !== request.operation ||
      call.result.audit.principalRef !== grant.canonicalActorPrincipalId ||
      call.result.audit.traceId !== request.audit.traceId ||
      !same(call.result.executor, call.executor) ||
      output.childExecutionId !== grant.child.executionId ||
      output.childAttemptId !== grant.child.attemptId ||
      output.externalSessionId !== grant.child.handle.externalSessionId
    )
      rejected()
    return grant
  } catch {
    rejected()
  }
}

export interface PiChildContinuationSnapshot {
  readonly parentExecution: unknown
  readonly parentAttempt: unknown
  readonly childExecution: unknown
  readonly childAttempt: unknown
  readonly parentPlan: unknown
  readonly childPlan: unknown
  readonly childHandle: RuntimeExecutionHandle
}
/** Canonical current rows, supplied by a trusted host transaction. Full context
 * derivation, succeeded tool/approval/source proofs and present policy are separate
 * mandatory host checks. Completion relaxes only the parent lifecycle on resume.
 */
export function assertPiChildContinuationSnapshot(
  input: unknown,
  snapshot: PiChildContinuationSnapshot,
  options: { readonly mode: 'retain' | 'resume'; readonly now: string }
): PiChildContinuationGrant {
  try {
    const grant = parse(input)
    assertTime(grant, options.now)
    if (!['retain', 'resume'].includes(options.mode)) rejected()
    const parent = ExecutionSchema.parse(snapshot.parentExecution)
    const parentAttempt = ExecutionAttemptSchema.parse(snapshot.parentAttempt)
    const child = ExecutionSchema.parse(snapshot.childExecution)
    const childAttempt = ExecutionAttemptSchema.parse(snapshot.childAttempt)
    const parentPlan = assertExecutionPlanIntegrity(snapshot.parentPlan)
    const childPlan = assertExecutionPlanIntegrity(snapshot.childPlan)
    const handle = RuntimeExecutionHandleSchema.parse(snapshot.childHandle)
    const parentActive =
      ['running', 'awaiting_input'].includes(parent.state) &&
      ['running', 'awaiting_input'].includes(parentAttempt.state)
    const parentCompleted = parent.state === 'completed' && parentAttempt.state === 'completed'
    if (
      !(parentActive || (options.mode === 'resume' && parentCompleted)) ||
      [parent, parentAttempt, child, childAttempt].some(
        (record) =>
          record.deadlineAt !== undefined &&
          Date.parse(grant.expiresAt) > Date.parse(record.deadlineAt)
      ) ||
      !['accepted', 'queued', 'starting', 'running', 'awaiting_input'].includes(child.state) ||
      !['queued', 'starting', 'running', 'awaiting_input'].includes(childAttempt.state) ||
      parent.executionId !== grant.parent.executionId ||
      parent.latestAttemptId !== grant.parent.attemptId ||
      parentAttempt.attemptId !== grant.parent.attemptId ||
      parentAttempt.executionId !== parent.executionId ||
      parentAttempt.sequence !== parent.attemptCount ||
      child.executionId !== grant.child.executionId ||
      child.latestAttemptId !== grant.child.attemptId ||
      childAttempt.attemptId !== grant.child.attemptId ||
      childAttempt.executionId !== child.executionId ||
      childAttempt.sequence !== child.attemptCount ||
      child.parentExecutionId !== parent.executionId ||
      !same(parentAttempt.runtime ?? null, grant.parent.runtime) ||
      !same(childAttempt.runtime ?? null, grant.child.runtime) ||
      !same(parent.executionPlan, grant.parent.executionPlan) ||
      !same(child.executionPlan, grant.child.executionPlan) ||
      !same(pin(parentPlan), grant.parent.executionPlan) ||
      !same(pin(childPlan), grant.child.executionPlan) ||
      !same(parent.correlation, parentPlan.correlation) ||
      !same(child.correlation, childPlan.correlation) ||
      parent.correlation.workspaceId !== grant.workspaceId ||
      child.correlation.workspaceId !== grant.workspaceId ||
      !same(childPlan.parentExecutionPlan, {
        executionPlanId: parentPlan.executionPlanId,
        contentDigest: parentPlan.contentDigest,
      }) ||
      !same(childPlan.profile, parentPlan.profile) ||
      !same(childPlan.skills, parentPlan.skills) ||
      !same(childPlan.policySnapshot, parentPlan.policySnapshot) ||
      !same(childPlan.outputContract, parentPlan.outputContract) ||
      !same(handle, grant.child.handle) ||
      (parentAttempt.runtime?.externalSessionId !== undefined &&
        parentAttempt.runtime.externalSessionId !== grant.source.externalSessionId) ||
      (childAttempt.runtime?.externalSessionId !== undefined &&
        childAttempt.runtime.externalSessionId !== handle.externalSessionId)
    )
      rejected()
    return grant
  } catch {
    rejected()
  }
}

const Current = z.strictObject({
  revoked: z.boolean(),
  actorActive: z.boolean(),
  scopeActive: z.boolean(),
  providerActive: z.boolean(),
  spendingActive: z.boolean(),
  canonicalActorPrincipalId: Ref,
  authorityRevision: Revision,
  approval: Approval,
  selection: ProviderSelectionReferenceSchema,
  budget: RuntimeAttemptBudgetAuthoritySchema,
})
export type PiChildContinuationCurrentAuthority = z.output<typeof Current>
export interface PiChildContinuationCurrentAuthorityPort {
  /** Server-owned fresh actor, scope, provider and recorded spending reads.
   * No model call, credential transfer or publication is admitted by this port.
   */
  readCurrent(
    grant: PiChildContinuationGrant,
    authority: DurableExecutionAuthority
  ): Promise<PiChildContinuationCurrentAuthority>
}
export async function assertCurrentPiChildContinuation(
  input: unknown,
  authority: DurableExecutionAuthority,
  port: PiChildContinuationCurrentAuthorityPort,
  now: () => string
): Promise<PiChildContinuationGrant> {
  try {
    if (typeof port?.readCurrent !== 'function' || typeof now !== 'function') rejected()
    const grant = assertGrantMatchesAuthority(input, authority)
    assertTime(grant, now())
    const current = Current.parse(await port.readCurrent(grant, structuredClone(authority)))
    assertTime(grant, now())
    assertGrantMatchesAuthority(grant, authority)
    if (
      current.revoked ||
      !current.actorActive ||
      !current.scopeActive ||
      !current.providerActive ||
      !current.spendingActive ||
      current.canonicalActorPrincipalId !== grant.canonicalActorPrincipalId ||
      current.authorityRevision !== grant.authorityRevision ||
      !same(current.approval, grant.approval) ||
      !same(current.selection, grant.selection) ||
      !same(current.budget, grant.budget)
    )
      rejected()
    return grant
  } catch {
    rejected()
  }
}
