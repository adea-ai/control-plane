import {
  ExecutionModelSelectionBindingSchema,
  ModelSelectionError,
  createExecutionBoundModelSelectionService,
  resolveModelSelectionFundingView,
  type CurrentModelExecutionAuthority,
  type ExecutionModelSelectionBinding,
  type ModelSelectionService,
  type RecordedModelFundingAuthority,
} from '@control-plane/model-gateway'
import type { ConfiguredModelConnectionService } from './model-connections.service.js'

type Reader = Parameters<NonNullable<ConfiguredModelConnectionService['fundingView']>['resolve']>[0]
export interface AcceptedModelFundingExecutionAuthority extends CurrentModelExecutionAuthority {
  /** Authenticated server read: authorize the transport reader against the accepted
   * product intent/audience and derive the original actor and exact plan/attempt pin.
   * Never turn caller parameters into an accepted binding or infer a product actor.
   */
  resolveForReader(input: Reader): Promise<ExecutionModelSelectionBinding | undefined>
}

/** Explicit read composition, sharing the server's authenticated recorded decision
 * with native spending authority but projecting payer display separately. No lease/send.
 */
export function createRecordedModelFundingViewResolver(options: {
  selections: Pick<ModelSelectionService, 'resolveSelection' | 'assertReady' | 'withCredential'>
  executionAuthority: AcceptedModelFundingExecutionAuthority
  fundingAuthority: RecordedModelFundingAuthority
  now?: () => string
}): NonNullable<ConfiguredModelConnectionService['fundingView']> {
  return {
    async resolve(input) {
      let binding: ExecutionModelSelectionBinding
      try {
        binding = ExecutionModelSelectionBindingSchema.parse(
          await options.executionAuthority.resolveForReader(structuredClone(input))
        )
      } catch {
        throw new ModelSelectionError('PROVIDER_POLICY_DENIED')
      }
      if (
        binding.workspaceId !== input.workspaceId ||
        binding.executionId !== input.executionId ||
        binding.attemptId !== input.attemptId ||
        binding.selectionRef !== input.selectionRef ||
        binding.selectionRevision !== input.selectionRevision
      )
        throw new ModelSelectionError('SELECTION_CHANGED')
      const selections = createExecutionBoundModelSelectionService({
        selections: options.selections,
        binding,
        currentExecutionAuthority: options.executionAuthority,
      })
      return resolveModelSelectionFundingView({
        binding,
        selections,
        fundingAuthority: options.fundingAuthority,
        ...(options.now ? { now: options.now } : {}),
      })
    },
  }
}
