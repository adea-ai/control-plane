import { canonicalJsonStringify } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity, type ExecutionPlan } from '@control-plane/execution-plan'
import {
  ManagedModelRequestSchema,
  ModelExecutionTargetSchema,
  ModelSelectionError,
  ModelGatewayError,
  type ManagedModelGateway,
  type ModelExecutionTarget,
  type ModelSelectionService,
  type RuntimeProviderSelection,
} from '@control-plane/model-gateway'

export interface PiLeadModelAdmissionInput {
  readonly evidence: {
    readonly workspaceId: string
    readonly selectionRef: string
    readonly selectionRevision: number
    readonly allowedPrincipalIds: readonly string[]
    readonly canonicalActorPrincipalId?: string
  }
  readonly plan: ExecutionPlan
  readonly ids: {
    readonly executionId: string
    readonly attemptId: string
    readonly requestId: string
  }
  readonly actorPrincipalId: string
}

/** R1's assertProviderReady callback, before any marker/command/attempt/budget.
 * Node already checks the canonical product intent and current kernel scope.
 * buildRequest is a server-owned route/policy projection, never client input.
 */
export function createPiLeadModelAdmissionReadiness(options: {
  selections: Pick<ModelSelectionService, 'resolveSelection' | 'assertReady'>
  gateway: Pick<ManagedModelGateway, 'assertRequestReady'>
  target: ModelExecutionTarget
  buildRequest(
    input: PiLeadModelAdmissionInput,
    selection: RuntimeProviderSelection
  ): Promise<unknown>
}) {
  const target = ModelExecutionTargetSchema.parse(options.target)
  return async (input: PiLeadModelAdmissionInput): Promise<void> => {
    try {
      const plan = assertExecutionPlanIntegrity(input.plan)
      if (
        plan.correlation.workspaceId !== input.evidence.workspaceId ||
        plan.correlation.requestId !== input.ids.requestId ||
        (Number(plan.schemaVersion) > 1 && !input.evidence.canonicalActorPrincipalId) ||
        (input.evidence.canonicalActorPrincipalId !== undefined &&
          input.evidence.canonicalActorPrincipalId !== input.actorPrincipalId)
      )
        throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
      const selection = await options.selections.resolveSelection({
        workspaceId: input.evidence.workspaceId,
        selectionRef: input.evidence.selectionRef,
        selectionRevision: input.evidence.selectionRevision,
      })
      if (
        ['harness', 'harnessVersion', 'providerBinding', 'location'].some(
          (key) => Reflect.get(selection, key) !== Reflect.get(target, key)
        )
      )
        throw new ModelSelectionError('SELECTION_CHANGED')
      await options.selections.assertReady(selection)
      const request = ManagedModelRequestSchema.parse(
        await options.buildRequest({ ...input, plan }, selection)
      )
      const requirement = plan.constraints.models.find((model) => model.alias === request.alias)
      if (
        request.workspaceId !== input.evidence.workspaceId ||
        request.executionId !== input.ids.executionId ||
        request.attemptId !== input.ids.attemptId ||
        request.requestId !== input.ids.requestId ||
        !request.selection ||
        canonicalJsonStringify(request.selection) !== canonicalJsonStringify(selection) ||
        request.policySnapshot.digest !== plan.policySnapshot.digest ||
        !requirement ||
        canonicalJsonStringify(requirement) !== canonicalJsonStringify(request.requirement) ||
        request.settings.maxOutputTokens + request.routing.estimatedInputTokens >
          plan.constraints.limits.tokens.maximumTotal ||
        request.settings.timeoutMs > plan.constraints.limits.duration.maximumMs
      )
        throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
      await options.gateway.assertRequestReady(request)
      // Authority can change during policy evaluation; the final read still precedes admission.
      await options.selections.assertReady(selection)
    } catch (error) {
      if (error instanceof ModelSelectionError) throw error
      if (error instanceof ModelGatewayError) {
        if (error.code === 'MODEL_POLICY_DENIED')
          throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
        if (error.code === 'MODEL_UNAVAILABLE') throw new ModelSelectionError('MODEL_UNAVAILABLE')
      }
      throw new ModelSelectionError('READINESS_UNAVAILABLE')
    }
  }
}
