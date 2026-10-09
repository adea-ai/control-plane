import { canonicalJsonStringify } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import type { DurableExecutionAuthority } from '@control-plane/pi-durable-adapter'
import type { ProductionPiLeadCompositionOptions } from './production-model-composition.js'

/** Only drops reference caches after canonical terminal state and released/reconciled usage.
 * Never settles unknown sends, renews grants or authorizes models.
 */
export function createProductionChildModelRetention(options: {
  executions: ProductionPiLeadCompositionOptions['admission']['executions']
  ledger: ProductionPiLeadCompositionOptions['ledger']
  maximum: number
  forgetNative(authority: DurableExecutionAuthority): void
  forgetCanonical(authority: DurableExecutionAuthority): void
}) {
  if (!Number.isSafeInteger(options.maximum) || options.maximum < 1 || options.maximum > 4096)
    throw new Error('PI_CHILD_MODEL_FACADE_LIMIT_INVALID')
  const authorities = new Map<string, DurableExecutionAuthority>()
  let collecting: Promise<void> | undefined
  return {
    remember(authority: DurableExecutionAuthority) {
      if (!authority.request.executionId) throw new Error('PI_CHILD_MODEL_EXECUTION_REQUIRED')
      const key = `${authority.request.executionId}/${authority.request.attemptId}`
      const retained = authorities.get(key)
      if (retained && canonicalJsonStringify(retained) !== canonicalJsonStringify(authority))
        throw new Error('PI_CHILD_MODEL_BINDING_CHANGED')
      if (!retained && authorities.size >= options.maximum)
        throw new Error('PI_CHILD_MODEL_FACADE_LIMIT_EXCEEDED')
      authorities.set(key, structuredClone(authority))
    },
    collect() {
      collecting ??= (async () => {
        for (const [key, authority] of authorities) {
          const attempt = await options.executions.getAttempt(authority.request.attemptId)
          if (
            !attempt ||
            attempt.executionId !== authority.request.executionId ||
            !['completed', 'failed', 'cancelled', 'timed_out'].includes(attempt.state)
          )
            continue
          try {
            await options.ledger.assertRuntimeAttemptReleased(
              assertExecutionPlanIntegrity(authority.request.executionPlan).correlation.workspaceId,
              attempt.executionId,
              attempt.attemptId
            )
          } catch {
            continue
          } // Uncertain sends preserve their holds and caches.
          options.forgetNative(authority)
          options.forgetCanonical(authority)
          authorities.delete(key)
        }
      })().finally(() => {
        collecting = undefined
      })
      return collecting
    },
  }
}
