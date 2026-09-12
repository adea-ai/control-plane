import type { ContextCommandRecord } from '@control-plane/domain'
import type { ContextCommandDeliveryService } from './context-command-delivery.js'
import type { ActiveRuntimeNodeChannelRecord } from './websocket-coordination.js'

/** One bounded page per connection/heartbeat; durable node admission prevents re-execution. */
export class ContextCommandRecoveryService {
  constructor(
    readonly delivery: Pick<ContextCommandDeliveryService, 'redeliverPending'>,
    readonly authorize: (record: ContextCommandRecord) => Promise<void>,
    readonly limit = 32
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw new Error('CONTEXT_RECOVERY_LIMIT_INVALID')
  }

  async recover(
    source: ActiveRuntimeNodeChannelRecord,
    nextSequence: () => Promise<number>,
    afterCommandId?: string
  ): Promise<{ nextAfterCommandId?: string }> {
    const page = await this.delivery.redeliverPending(source, {
      limit: this.limit,
      nextSequence,
      authorize: this.authorize,
      ...(afterCommandId ? { afterCommandId } : {}),
    })
    return page.nextAfterCommandId ? { nextAfterCommandId: page.nextAfterCommandId } : {}
  }
}
