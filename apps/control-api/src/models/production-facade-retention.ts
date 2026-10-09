import type { DurableExecutionAuthority } from '@control-plane/pi-durable-adapter'
import type { ExecutionModelSelectionBinding } from '@control-plane/model-gateway'
import type { NodePiDurableLeadCompositionOptions } from '../pi-durable/node-composition.js'

/** Drop reference-only caches after canonical terminal AND released/reconciled allocation.
 * Unknown physical sends keep their holds; this helper cannot settle or release any budget.
 */
export function createProductionFacadeRetention(options: {
  executions: NodePiDurableLeadCompositionOptions['admission']['executions']
  ledger: NodePiDurableLeadCompositionOptions['usage']['ledger']
  forgetNative(authority: DurableExecutionAuthority): void
  forgetCanonical(binding: ExecutionModelSelectionBinding): void
}) {
  const authorities = new Map<string, DurableExecutionAuthority>()
  const bindings = new Map<string, ExecutionModelSelectionBinding>()
  const key = (executionId: string, attemptId: string) => `${executionId}/${attemptId}`
  const authorityKey = (authority: DurableExecutionAuthority) => {
    if (!authority.request.executionId) throw new Error('PI_PRODUCTION_EXECUTION_REQUIRED')
    return key(authority.request.executionId, authority.request.attemptId)
  }
  let collecting: Promise<void> | undefined
  return {
    rememberAuthority(authority: DurableExecutionAuthority) {
      authorities.set(authorityKey(authority), authority)
    },
    rememberBinding(binding: ExecutionModelSelectionBinding) {
      bindings.set(key(binding.executionId, binding.attemptId), binding)
    },
    async resolveProvider<T>(
      authority: DurableExecutionAuthority,
      resolve: () => Promise<T>
    ): Promise<T> {
      authorities.set(authorityKey(authority), authority)
      return resolve()
    },
    collect() {
      collecting ??= (async () => {
        for (const [identity, authority] of authorities) {
          const binding = bindings.get(identity)
          if (!binding) {
            authorities.delete(identity)
            continue
          }
          const attempt = await options.executions.getAttempt(binding.attemptId)
          if (
            !attempt ||
            attempt.executionId !== binding.executionId ||
            !['completed', 'failed', 'cancelled', 'timed_out'].includes(attempt.state)
          )
            continue
          try {
            await options.ledger.assertRuntimeAttemptReleased(
              binding.workspaceId,
              binding.executionId,
              binding.attemptId
            )
          } catch {
            continue
          } // Unknown holds/unfinished canonical allocation are intentionally retained.
          options.forgetNative(authority)
          options.forgetCanonical(binding)
          authorities.delete(identity)
          bindings.delete(identity)
        }
      })().finally(() => {
        collecting = undefined
      })
      return collecting
    },
  }
}
