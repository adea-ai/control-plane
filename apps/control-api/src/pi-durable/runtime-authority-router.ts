import type { NodePiDurableCompositionOptions } from '@control-plane/pi-durable-adapter'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'

type AuthorityPort = Pick<NodePiDurableCompositionOptions, 'resolveAdmission' | 'assertAuthority'>

/** Host-only routing by immutable plan lineage. A child never falls back to lead authority. */
export function createPiLeadRuntimeAuthorityRouter(
  lead: AuthorityPort,
  child?: AuthorityPort
): AuthorityPort {
  function selected(hasParent: boolean): AuthorityPort {
    if (!hasParent) return lead
    if (!child) throw new Error('PI_CHILD_AUTHORITY_REQUIRED')
    return child
  }
  return {
    async resolveAdmission(request) {
      return selected(
        Boolean(assertExecutionPlanIntegrity(request.executionPlan).parentExecutionPlan)
      ).resolveAdmission(request)
    },
    async assertAuthority(authority) {
      await selected(
        Boolean(assertExecutionPlanIntegrity(authority.request.executionPlan).parentExecutionPlan)
      ).assertAuthority(authority)
    },
  }
}
