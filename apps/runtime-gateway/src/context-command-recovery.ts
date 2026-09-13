import type { ContextCommandRecord } from '@control-plane/domain'
import type { ContextCommandDeliveryService } from './context-command-delivery.js'
import type { ActiveRuntimeNodeChannelRecord } from './websocket-coordination.js'

/** One bounded page per connection/heartbeat; durable node admission prevents re-execution. */
export class ContextCommandRecoveryService {
  constructor(
    readonly delivery: Pick<ContextCommandDeliveryService, 'redeliverPending'>,
    readonly authorize: (record: ContextCommandRecord) => Promise<void>,
    readonly limit = 32,
    readonly timeoutMs = 10000
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw new Error('CONTEXT_RECOVERY_LIMIT_INVALID')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
      throw new Error('CONTEXT_RECOVERY_TIMEOUT_INVALID')
  }

  async recover(
    source: ActiveRuntimeNodeChannelRecord,
    nextSequence: () => Promise<number>,
    afterCommandId?: string,
    callerSignal?: AbortSignal
  ): Promise<{ nextAfterCommandId?: string; timedOut?: boolean }> {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, ...(callerSignal ? [callerSignal] : [])])
    let timedOut = false
    let lastVisited: string | undefined
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(new Error(timedOut ? 'CONTEXT_RECOVERY_TIMEOUT' : 'CONTEXT_RECOVERY_ABORTED'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const page = await Promise.race([
        this.delivery.redeliverPending(source, {
          limit: this.limit,
          nextSequence,
          authorize: this.authorize,
          signal,
          onVisited: (commandId) => {
            lastVisited = commandId
          },
          ...(afterCommandId ? { afterCommandId } : {}),
        }),
        aborted,
      ])
      signal.throwIfAborted()
      return page.nextAfterCommandId ? { nextAfterCommandId: page.nextAfterCommandId } : {}
    } catch (error) {
      // Preserve completed page progress, but never skip the in-flight ambiguous command.
      if (timedOut && lastVisited) return { nextAfterCommandId: lastVisited, timedOut: true }
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }
}
