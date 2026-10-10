import { canonicalJsonStringify, executionScopesEqual } from '@control-plane/contracts'
import {
  ExecutionAttemptSchema,
  ExecutionPlanPinSchema,
  ExecutionSchema,
  InteractionRequestSchema,
  type ExecutionRepository,
  type InteractionRepository,
} from '@control-plane/domain'
import {
  assertExecutionPlanIntegrity,
  type ExecutionPlanRepository,
} from '@control-plane/execution-plan'
import { ExecutionModelSelectionBindingSchema } from '@control-plane/model-gateway'
import type { NodePiDurableCompositionOptions } from '@control-plane/pi-durable-adapter'
import { toolInputMatchesDigest } from '@control-plane/tool-execution'
import type { SqlitePiDurableLeadIntentStore } from './node-admission.js'
import type { AcceptedModelFundingExecutionAuthority } from '../models/recorded-model-funding.js'

type ToolComposition = NonNullable<NodePiDurableCompositionOptions['tools']>

export type CurrentPiDurableToolRequest = Parameters<ToolComposition['assertAuthority']>[0]
export type PiDurableToolAuthorityBoundary = 'admission' | 'approval' | 'effect' | 'publication'

export interface CreatePiDurableCurrentToolAuthorityOptions {
  /** Host-created reader; re-derives the accepted plan, actor, current audience and scope. */
  readonly currentExecutionAuthority: AcceptedModelFundingExecutionAuthority
  /** The same immutable accepted intent store used by canonical execution admission. */
  readonly intents: Pick<SqlitePiDurableLeadIntentStore, 'getByAttempt' | 'marker'>
  readonly executions: Pick<ExecutionRepository, 'getExecution' | 'getAttempt'>
  readonly plans: Pick<ExecutionPlanRepository, 'get'>
  readonly service: ToolComposition['service']
  /** Must be the same retained repository used by the service's approval coordinator. */
  readonly interactions: Pick<InteractionRepository, 'get'>
  readonly now?: () => string
}

export interface PiDurableCurrentToolAuthority {
  readonly assertCurrent: (
    request: CurrentPiDurableToolRequest,
    boundary: PiDurableToolAuthorityBoundary
  ) => Promise<void>
}

const liveExecutionStates = new Set(['accepted', 'queued', 'starting', 'running', 'awaiting_input'])
const liveAttemptStates = new Set(['queued', 'starting', 'running', 'awaiting_input'])

/**
 * Re-derives current authority for one durable tool call. This host-only port
 * never returns a truthy authorization value and never retains prompt/input or
 * credentials. The Pi effect gate owns the durable request digest/replay fence.
 */
export function createPiDurableCurrentToolAuthority(
  options: CreatePiDurableCurrentToolAuthorityOptions
): PiDurableCurrentToolAuthority {
  const now = options.now ?? (() => new Date().toISOString())
  const approvalRepository = (options.service.approvals as unknown as { repository?: unknown })
    .repository
  if (
    typeof options.currentExecutionAuthority?.resolveForReader !== 'function' ||
    typeof options.currentExecutionAuthority?.assertCurrent !== 'function' ||
    typeof options.intents?.getByAttempt !== 'function' ||
    typeof options.intents?.marker !== 'function' ||
    typeof options.executions?.getExecution !== 'function' ||
    typeof options.executions?.getAttempt !== 'function' ||
    typeof options.plans?.get !== 'function' ||
    typeof options.service?.gateway?.prepare !== 'function' ||
    typeof options.service?.calls?.get !== 'function' ||
    typeof options.interactions?.get !== 'function' ||
    approvalRepository !== options.interactions
  )
    throw new PiDurableCurrentToolAuthorityError()

  return {
    async assertCurrent(input, boundary) {
      try {
        if (!isBoundary(boundary)) reject()
        const request = structuredClone(input)
        const currentTime = Date.parse(now())
        if (!Number.isFinite(currentTime)) reject()

        const intent = await options.intents.getByAttempt(request.attemptId)
        if (!intent) reject()
        const marker = options.intents.marker(intent.intentId)
        if (
          !marker ||
          marker.state !== 'ready' ||
          marker.intent.intentId !== intent.intentId ||
          marker.intent.workspaceId !== intent.workspaceId ||
          marker.intent.executionId !== intent.executionId ||
          marker.intent.attemptId !== intent.attemptId ||
          marker.workspaceId !== intent.workspaceId ||
          canonicalJsonStringify(marker.intent) !== canonicalJsonStringify(intent)
        )
          reject()

        const bindingInput = {
          workspaceId: intent.workspaceId,
          executionId: intent.executionId,
          attemptId: intent.attemptId,
          principalId: marker.actorPrincipalId,
          selectionRef: intent.selectionRef,
          selectionRevision: intent.selectionRevision,
        }
        const bindingInputTime = currentTime
        const bindingInputResult =
          await options.currentExecutionAuthority.resolveForReader(bindingInput)
        if (!bindingInputResult) reject()
        const binding = ExecutionModelSelectionBindingSchema.parse(bindingInputResult)

        const [executionInput, attemptInput, planInput] = await Promise.all([
          options.executions.getExecution(intent.executionId),
          options.executions.getAttempt(intent.attemptId),
          options.plans.get(marker.planPin),
        ])
        const execution = ExecutionSchema.parse(executionInput)
        const attempt = ExecutionAttemptSchema.parse(attemptInput)
        const plan = assertExecutionPlanIntegrity(planInput)
        const planPin = ExecutionPlanPinSchema.parse(marker.planPin)
        const grant = request.grant
        const prepared = await options.service.gateway.prepare({
          requestId: request.requestId,
          executionId: request.executionId,
          attemptId: request.attemptId,
          workspaceId: request.workspaceId,
          profileId: request.profileId,
          toolDefinitionId: request.toolDefinitionId,
          toolVersionId: request.toolVersionId,
          operation: request.operation,
          input: request.input,
          grant,
          audit: request.audit,
        })
        const call = await options.service.calls.get(request.toolCallId)
        const approval = request.approval
          ? await readApproval(options.interactions, request, currentTime)
          : undefined

        if (
          intent.executionId !== request.executionId ||
          intent.attemptId !== request.attemptId ||
          intent.workspaceId !== request.workspaceId ||
          !intent.canonicalActorPrincipalId ||
          request.audit.principalRef !== intent.canonicalActorPrincipalId ||
          binding.canonicalActorPrincipalId !== intent.canonicalActorPrincipalId ||
          binding.workspaceId !== intent.workspaceId ||
          binding.executionId !== intent.executionId ||
          binding.attemptId !== intent.attemptId ||
          binding.principalRef !== intent.principalRef ||
          binding.authorityRevision !== intent.authorityRevision ||
          binding.selectionRef !== intent.selectionRef ||
          binding.selectionRevision !== intent.selectionRevision ||
          binding.executionPlanId !== planPin.executionPlanId ||
          binding.executionPlanDigest !== planPin.contentDigest ||
          binding.executionPlanSchemaVersion !== planPin.schemaVersion ||
          execution.executionId !== intent.executionId ||
          execution.latestAttemptId !== intent.attemptId ||
          attempt.attemptId !== intent.attemptId ||
          attempt.executionId !== intent.executionId ||
          !liveExecutionStates.has(execution.state) ||
          !liveAttemptStates.has(attempt.state) ||
          !same(execution.executionPlan, planPin) ||
          plan.executionPlanId !== planPin.executionPlanId ||
          plan.contentDigest !== planPin.contentDigest ||
          plan.schemaVersion !== planPin.schemaVersion ||
          !same(plan.correlation, execution.correlation) ||
          plan.profile.profileId !== request.profileId ||
          !executionScopesEqual(plan.correlation, intent) ||
          plan.correlation.workspaceId !== request.workspaceId ||
          prepared.version.toolDefinitionId !== request.toolDefinitionId ||
          prepared.version.toolVersionId !== request.toolVersionId ||
          prepared.operation.name !== request.operation ||
          grant.workspaceId !== request.workspaceId ||
          grant.profileId !== request.profileId ||
          grant.toolDefinitionId !== request.toolDefinitionId ||
          grant.toolVersionId !== request.toolVersionId ||
          !grant.operations.includes(request.operation) ||
          !Number.isFinite(Date.parse(request.requestedAt)) ||
          Date.parse(request.requestedAt) < Date.parse(execution.acceptedAt) ||
          Date.parse(request.requestedAt) > currentTime ||
          (grant.expiresAt !== undefined &&
            (!Number.isFinite(Date.parse(grant.expiresAt)) ||
              Date.parse(grant.expiresAt) <= currentTime)) ||
          !Number.isFinite(Date.parse(intent.expiresAt)) ||
          Date.parse(intent.expiresAt) <= currentTime ||
          (execution.deadlineAt !== undefined &&
            (!Number.isFinite(Date.parse(execution.deadlineAt)) ||
              Date.parse(execution.deadlineAt) <= currentTime)) ||
          (attempt.deadlineAt !== undefined &&
            (!Number.isFinite(Date.parse(attempt.deadlineAt)) ||
              Date.parse(attempt.deadlineAt) <= currentTime)) ||
          (approval &&
            call?.approvalInteractionId !== undefined &&
            call.approvalInteractionId !== approval.interaction.interactionId) ||
          (approval?.approved &&
            call?.approvalPrincipalRef !== undefined &&
            call.approvalPrincipalRef !== approval.interaction.response?.respondingPrincipalId) ||
          (!approval && call?.approvalInteractionId !== undefined) ||
          (call !== undefined && !matchesToolCall(call, request, prepared.version.executor))
        )
          reject()

        const approvalRequired =
          prepared.operation.approvalMode === 'always' ||
          call?.policyDecision?.requiresApproval === true
        const effectHasStarted =
          call?.startedAt !== undefined ||
          call?.status === 'executing' ||
          call?.status === 'succeeded' ||
          call?.status === 'reconciliation_required'
        if (
          boundary === 'effect' &&
          (!call || call.status !== 'executing' || call.startedAt === undefined)
        )
          reject()
        const approvalMustBeCurrent = approvalRequired || approval !== undefined
        if (boundary === 'effect' || (boundary === 'publication' && effectHasStarted)) {
          if (
            approvalMustBeCurrent &&
            (!approval?.approved ||
              call?.approvalPrincipalRef !== approval.interaction.response?.respondingPrincipalId)
          )
            reject()
        }
        if (boundary === 'admission' && prepared.operation.approvalMode === 'always' && !approval)
          reject()
        if (boundary === 'approval' && !approval) reject()

        const finalTime = Date.parse(now())
        assertCurrentDeadlines(
          finalTime,
          bindingInputTime,
          intent.expiresAt,
          grant.expiresAt,
          execution.deadlineAt,
          attempt.deadlineAt,
          approval?.interaction.expiresAt
        )
        await options.currentExecutionAuthority.assertCurrent(binding)

        // The canonical authority read above is awaited. Re-read retained mutable
        // evidence after it so approval revocation/version changes and deadlines
        // crossed during that read cannot authorize the effect on stale snapshots.
        const currentCall = await options.service.calls.get(request.toolCallId)
        const currentApproval = request.approval
          ? await readApproval(options.interactions, request, Date.parse(now()))
          : undefined
        if (!same(call, currentCall) || !same(approval?.interaction, currentApproval?.interaction))
          reject()
        assertCurrentDeadlines(
          Date.parse(now()),
          finalTime,
          intent.expiresAt,
          grant.expiresAt,
          execution.deadlineAt,
          attempt.deadlineAt,
          currentApproval?.interaction.expiresAt
        )
      } catch {
        throw new PiDurableCurrentToolAuthorityError()
      }
    },
  }
}

async function readApproval(
  interactions: Pick<InteractionRepository, 'get'>,
  request: CurrentPiDurableToolRequest,
  currentTime: number
) {
  const approval = request.approval
  if (!approval) reject()
  const interaction = InteractionRequestSchema.parse(await interactions.get(approval.interactionId))
  const audience = [...approval.allowedPrincipalIds].toSorted()
  const retainedAudience = [...interaction.allowedPrincipalIds].toSorted()
  const responded = interaction.response
  const approved =
    interaction.state === 'responded' &&
    responded?.action === 'approve' &&
    responded.value === undefined &&
    interaction.allowedPrincipalIds.includes(responded.respondingPrincipalId)
  if (
    interaction.interactionId !== approval.interactionId ||
    interaction.executionId !== request.executionId ||
    interaction.attemptId !== request.attemptId ||
    interaction.kind !== 'approval' ||
    interaction.prompt.title !== `Approve ${request.operation}` ||
    interaction.prompt.detailsReference !== `artifact://tool-call/${request.toolCallId}` ||
    canonicalJsonStringify(interaction.allowedActions.toSorted()) !==
      canonicalJsonStringify(['approve', 'deny']) ||
    canonicalJsonStringify(audience) !== canonicalJsonStringify(retainedAudience) ||
    interaction.requestedAt !== approval.requestedAt ||
    interaction.expiresAt !== approval.expiresAt ||
    Date.parse(interaction.requestedAt) > currentTime ||
    Date.parse(interaction.expiresAt) <= currentTime ||
    interaction.state === 'expired' ||
    interaction.state === 'cancelled' ||
    (interaction.state === 'responded' &&
      (!responded ||
        (responded.action !== 'approve' && responded.action !== 'deny') ||
        responded.value !== undefined ||
        !interaction.allowedPrincipalIds.includes(responded.respondingPrincipalId) ||
        Date.parse(responded.respondedAt) < Date.parse(interaction.requestedAt) ||
        Date.parse(responded.respondedAt) > Date.parse(interaction.expiresAt) ||
        Date.parse(responded.respondedAt) > currentTime))
  )
    reject()
  return { interaction, approved }
}

function matchesToolCall(
  call: NonNullable<Awaited<ReturnType<ToolComposition['service']['calls']['get']>>>,
  request: CurrentPiDurableToolRequest,
  executor: unknown
): boolean {
  return (
    call.toolCallId === request.toolCallId &&
    call.executionId === request.executionId &&
    call.attemptId === request.attemptId &&
    call.workspaceId === request.workspaceId &&
    call.profileId === request.profileId &&
    call.principalRef === request.audit.principalRef &&
    call.toolDefinitionId === request.toolDefinitionId &&
    call.toolVersionId === request.toolVersionId &&
    call.operation === request.operation &&
    toolInputMatchesDigest(request.input, call.inputDigest) &&
    call.policySnapshotRef === request.policySnapshotRef &&
    call.idempotencyKey === request.idempotencyKey &&
    call.requestedAt === request.requestedAt &&
    same(call.executor, executor)
  )
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right)
}

function assertCurrentDeadlines(
  currentTime: number,
  notBefore: number,
  intentExpiry: string,
  grantExpiry: string | undefined,
  executionDeadline: string | undefined,
  attemptDeadline: string | undefined,
  approvalExpiry: string | undefined
): void {
  const deadlines = [
    intentExpiry,
    grantExpiry,
    executionDeadline,
    attemptDeadline,
    approvalExpiry,
  ].filter((value): value is string => value !== undefined)
  if (
    !Number.isFinite(currentTime) ||
    currentTime < notBefore ||
    deadlines.some(
      (value) => !Number.isFinite(Date.parse(value)) || Date.parse(value) <= currentTime
    )
  )
    reject()
}

function isBoundary(value: unknown): value is PiDurableToolAuthorityBoundary {
  return (
    value === 'admission' || value === 'approval' || value === 'effect' || value === 'publication'
  )
}

function reject(): never {
  throw new PiDurableCurrentToolAuthorityError()
}

export class PiDurableCurrentToolAuthorityError extends Error {
  readonly code = 'PI_TOOL_AUTHORITY_REJECTED'

  constructor() {
    super('PI_TOOL_AUTHORITY_REJECTED')
    this.name = 'PiDurableCurrentToolAuthorityError'
  }
}
