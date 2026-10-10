import {
  canonicalJsonStringify,
  IdentifierSchemas,
  ModelSelectionReferenceSchema,
} from '@control-plane/contracts'
import {
  ExecutionAttemptSchema,
  ExecutionSchema,
  type ExecutionRepository,
} from '@control-plane/domain'
import {
  assertExecutionPlanIntegrity,
  type ExecutionPlanRepository,
} from '@control-plane/execution-plan'
import {
  ChildAdmissionRequestSchema,
  type DelegationRepository,
} from '@control-plane/orchestration'
import { RuntimeStartRequestSchema, type RuntimeStartRequest } from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { ProductionChildBudgetCurrentSchema } from './production-child-budget-admission.js'
import { ProductionLeadProductEvidenceSchema } from './production-lead-product.js'

/**
 * Server-owned current authority for child admission and child runtime start.
 *
 * Every authority field (original actor, audience reader, lead revision, expiry and
 * requested child selection) is read from retained server records: the parent attempt and
 * execution, the lead intent and its ready marker, the admitted parent tool call, the child
 * delegation record, and the fresh product evidence. Caller input contributes only identifiers
 * that are then checked against those records. The two reads must agree or the child is refused.
 */

type Pin = { executionPlanId: string; contentDigest: string }
type ProductReader = {
  readCurrent(input: {
    schemaVersion: 'pi-lead-intent/v1'
    intentId: string
    workspaceId: string
    principalId: string
  }): Promise<unknown | undefined>
}
type IntentReader = {
  getByAttempt(attemptId: string): Promise<unknown | undefined>
  marker(intentId: string): unknown | undefined
}

const LiveExecution = new Set(['accepted', 'queued', 'starting', 'running', 'awaiting_input'])
const LiveAttempt = new Set(['queued', 'starting', 'running', 'awaiting_input'])
const LiveDelegation = new Set(['requested', 'dispatched', 'running', 'awaiting_input'])
const AdmittedToolCall = new Set(['authorized', 'executing', 'succeeded'])
const DelegateOperation = 'delegate-child'

const IntentSchema = z
  .object({
    intentId: z.string().min(1),
    workspaceId: IdentifierSchemas.workspaceId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    canonicalActorPrincipalId: z.string().min(1),
    authorityRevision: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
    allowedPrincipalIds: z.array(z.string().min(1)).min(1),
  })
  .passthrough()
const MarkerSchema = z
  .object({
    state: z.string(),
    workspaceId: IdentifierSchemas.workspaceId,
    actorPrincipalId: z.string().min(1),
    intent: z.unknown(),
    planPin: z
      .object({ executionPlanId: z.string().min(1), contentDigest: z.string().min(1) })
      .passthrough(),
  })
  .passthrough()
const ToolCallSchema = z
  .object({
    toolCallId: IdentifierSchemas.toolCallId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    workspaceId: IdentifierSchemas.workspaceId,
    operation: z.string().min(1),
    status: z.string().min(1),
  })
  .passthrough()

function deny(): never {
  throw new Error('PI_CHILD_MODEL_AUTHORITY_DENIED')
}
const sameJson = (left: unknown, right: unknown) =>
  canonicalJsonStringify(left) === canonicalJsonStringify(right)

export interface ProductionChildCurrentOptions {
  readonly executions: Pick<ExecutionRepository, 'getExecution' | 'getAttempt'>
  readonly plans: Pick<ExecutionPlanRepository, 'get'>
  readonly intents: IntentReader
  readonly delegations: Pick<DelegationRepository, 'get' | 'findByChild'>
  readonly toolCalls: { get(toolCallId: string): Promise<unknown | undefined> }
  readonly product: ProductReader
  readonly now?: () => string
}

export function createProductionChildCurrent(options: ProductionChildCurrentOptions) {
  const now = options.now ?? (() => new Date().toISOString())
  const nowMs = () => {
    const at = Date.parse(now())
    if (!Number.isFinite(at)) deny()
    return at
  }

  /** The retained parent: execution, attempt, lead intent, ready marker, audience and selection. */
  async function parent(input: { executionId: string; attemptId: string; plan: Pin }) {
    const at = nowMs()
    const execution = ExecutionSchema.parse(
      await options.executions.getExecution(input.executionId)
    )
    const attempt = ExecutionAttemptSchema.parse(
      await options.executions.getAttempt(input.attemptId)
    )
    if (
      !LiveExecution.has(execution.state) ||
      !LiveAttempt.has(attempt.state) ||
      execution.latestAttemptId !== attempt.attemptId ||
      attempt.executionId !== execution.executionId ||
      execution.executionPlan.executionPlanId !== input.plan.executionPlanId ||
      execution.executionPlan.contentDigest !== input.plan.contentDigest ||
      [execution.deadlineAt, attempt.deadlineAt].some(
        (deadline) => deadline !== undefined && at >= Date.parse(deadline)
      )
    )
      deny()
    const intent = IntentSchema.parse(await options.intents.getByAttempt(attempt.attemptId))
    if (
      intent.executionId !== execution.executionId ||
      intent.attemptId !== attempt.attemptId ||
      intent.workspaceId !== execution.correlation.workspaceId ||
      at >= Date.parse(intent.expiresAt)
    )
      deny()
    const marker = MarkerSchema.parse(options.intents.marker(intent.intentId))
    if (
      marker.state !== 'ready' ||
      marker.workspaceId !== intent.workspaceId ||
      !sameJson(marker.intent, intent) ||
      marker.planPin.executionPlanId !== input.plan.executionPlanId ||
      marker.planPin.contentDigest !== input.plan.contentDigest
    )
      deny()
    // The marker actor is the transport principal. The audience check below decides whether it may read.
    const reader = marker.actorPrincipalId
    if (!intent.allowedPrincipalIds.includes(reader)) deny()
    const evidence = ProductionLeadProductEvidenceSchema.parse(
      await options.product.readCurrent({
        schemaVersion: 'pi-lead-intent/v1',
        intentId: intent.intentId,
        workspaceId: intent.workspaceId,
        principalId: reader,
      })
    )
    if (
      evidence.workspaceId !== intent.workspaceId ||
      evidence.intentId !== intent.intentId ||
      evidence.canonicalActorPrincipalId !== intent.canonicalActorPrincipalId ||
      !evidence.allowedPrincipalIds.includes(reader) ||
      at >= Date.parse(evidence.expiresAt)
    )
      deny()
    const requested = evidence.requestedModelSelections?.child
    return {
      intentId: intent.intentId,
      workspaceId: intent.workspaceId,
      canonicalActorPrincipalId: intent.canonicalActorPrincipalId,
      productReaderPrincipalId: reader,
      authorityRevision: intent.authorityRevision,
      expiresAt:
        Date.parse(evidence.expiresAt) < Date.parse(intent.expiresAt)
          ? evidence.expiresAt
          : intent.expiresAt,
      ...(requested ? { requestedSelection: ModelSelectionReferenceSchema.parse(requested) } : {}),
    }
  }

  /** The admitted parent tool call must be the delegate operation, owned by that parent attempt. */
  async function assertAdmittedCall(
    toolCallId: string,
    expected: { executionId: string; attemptId: string; workspaceId: string }
  ) {
    const call = ToolCallSchema.parse(await options.toolCalls.get(toolCallId))
    if (
      call.toolCallId !== toolCallId ||
      call.executionId !== expected.executionId ||
      call.attemptId !== expected.attemptId ||
      call.workspaceId !== expected.workspaceId ||
      call.operation !== DelegateOperation ||
      !AdmittedToolCall.has(call.status)
    )
      deny()
  }

  /** Reads twice; a change between reads means the authority moved and the child is refused. */
  async function stable<T>(read: () => Promise<T>): Promise<T> {
    const first = await read()
    const second = await read()
    if (!sameJson(first, second)) throw new Error('PI_CHILD_MODEL_AUTHORITY_CHANGED')
    return second
  }

  return {
    /** Admission preflight: the child record does not exist yet, so identity comes from the server-built request. */
    readAdmission(input: unknown) {
      return stable(async () => {
        const request = ChildAdmissionRequestSchema.parse(input)
        const actor = await parent({
          executionId: request.parentExecutionId,
          attemptId: request.parentAttemptId,
          plan: request.parentPlan,
        })
        if (
          actor.workspaceId !== request.workspaceId ||
          actor.intentId !== request.parentIntentId ||
          actor.canonicalActorPrincipalId !== request.originalActorPrincipalId
        )
          deny()
        await assertAdmittedCall(request.admittedToolCallId, {
          executionId: request.parentExecutionId,
          attemptId: request.parentAttemptId,
          workspaceId: request.workspaceId,
        })
        return ProductionChildBudgetCurrentSchema.parse({
          workspaceId: actor.workspaceId,
          parentIntentId: actor.intentId,
          childRequestId: request.childRequestId,
          executionId: request.childExecutionId,
          attemptId: request.childAttemptId,
          executionPlanId: request.childPlan.executionPlanId,
          executionPlanDigest: request.childPlan.contentDigest,
          parentExecutionPlanId: request.parentPlan.executionPlanId,
          parentExecutionPlanDigest: request.parentPlan.contentDigest,
          canonicalActorPrincipalId: actor.canonicalActorPrincipalId,
          productReaderPrincipalId: actor.productReaderPrincipalId,
          authorityRevision: actor.authorityRevision,
          expiresAt: actor.expiresAt,
          ...(actor.requestedSelection ? { requestedSelection: actor.requestedSelection } : {}),
        })
      })
    },
    /** Runtime start: the retained child delegation must bind the presented child plan and attempt. */
    readRuntime(input: unknown) {
      return stable(async () => {
        const start: RuntimeStartRequest = RuntimeStartRequestSchema.parse(input)
        const plan = assertExecutionPlanIntegrity(start.executionPlan)
        if (!plan.parentExecutionPlan) deny()
        const executionId = start.executionId ?? deny()
        const delegation = await options.delegations.findByChild(executionId)
        if (
          !delegation ||
          !LiveDelegation.has(delegation.state) ||
          delegation.childAttemptId !== start.attemptId ||
          !delegation.parentAttemptId ||
          !delegation.admittedToolCallId ||
          delegation.childExecutionPlanId !== plan.executionPlanId ||
          delegation.childExecutionPlanDigest !== plan.contentDigest ||
          delegation.parentExecutionPlanId !== plan.parentExecutionPlan.executionPlanId ||
          delegation.parentExecutionPlanDigest !== plan.parentExecutionPlan.contentDigest
        )
          deny()
        const actor = await parent({
          executionId: delegation.parentExecutionId,
          attemptId: delegation.parentAttemptId,
          plan: {
            executionPlanId: plan.parentExecutionPlan.executionPlanId,
            contentDigest: plan.parentExecutionPlan.contentDigest,
          },
        })
        if (actor.workspaceId !== plan.correlation.workspaceId) deny()
        await assertAdmittedCall(delegation.admittedToolCallId, {
          executionId: delegation.parentExecutionId,
          attemptId: delegation.parentAttemptId,
          workspaceId: actor.workspaceId,
        })
        return ProductionChildBudgetCurrentSchema.parse({
          workspaceId: actor.workspaceId,
          parentIntentId: actor.intentId,
          childRequestId: plan.correlation.requestId,
          executionId: start.executionId,
          attemptId: start.attemptId,
          executionPlanId: plan.executionPlanId,
          executionPlanDigest: plan.contentDigest,
          parentExecutionPlanId: plan.parentExecutionPlan.executionPlanId,
          parentExecutionPlanDigest: plan.parentExecutionPlan.contentDigest,
          canonicalActorPrincipalId: actor.canonicalActorPrincipalId,
          productReaderPrincipalId: actor.productReaderPrincipalId,
          authorityRevision: actor.authorityRevision,
          expiresAt: actor.expiresAt,
          ...(actor.requestedSelection ? { requestedSelection: actor.requestedSelection } : {}),
        })
      })
    },
  }
}
