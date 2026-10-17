import type { NodePiDurableCompositionOptions } from '@control-plane/pi-durable-adapter'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'

type AuthorityPort = Pick<
  NodePiDurableCompositionOptions,
  'resolveAdmission' | 'assertAuthority' | 'assertReadAuthority' | 'assertRecoveryAuthority'
>

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
    async assertAuthority(authority, purpose) {
      await selected(
        Boolean(assertExecutionPlanIntegrity(authority.request.executionPlan).parentExecutionPlan)
      ).assertAuthority(authority, purpose)
    },
    async assertRecoveryAuthority(authority) {
      const port = selected(
        Boolean(assertExecutionPlanIntegrity(authority.request.executionPlan).parentExecutionPlan)
      )
      await (port.assertRecoveryAuthority ?? port.assertAuthority)(authority)
    },
    async assertReadAuthority(authority) {
      const port = selected(
        Boolean(assertExecutionPlanIntegrity(authority.request.executionPlan).parentExecutionPlan)
      )
      await (port.assertReadAuthority ?? port.assertRecoveryAuthority ?? port.assertAuthority)(
        authority
      )
    },
  }
}
