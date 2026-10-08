import type { Context } from '@earendil-works/chord'
import type { RuntimeStartRequest } from '@control-plane/runtime-sdk'
import type { DurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare'
import { CloudflarePiHost } from './host.js'
import type { CloudflareCurrentAuthority, CloudflarePiEngine } from './host.js'
import { CloudflareOwnerJournal } from './owner.js'
import type { CloudflareOwnerPins, CloudflareOwnerStorage } from './owner.js'
import { openCloudflarePiStorage } from './storage.js'

export interface CloudflareOwnerContext {
  readonly storage: CloudflareOwnerStorage & DurableObjectSqliteStorage
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}

/** Server-owned bindings. An HTTP/model payload cannot supply these ports or owner pins. */
export interface CloudflareOwnerBindings {
  readonly context: Context
  readonly pins: CloudflareOwnerPins
  readonly authority: CloudflareCurrentAuthority
  readonly now: () => number
  readonly openEngine: (
    storage: Awaited<ReturnType<typeof openCloudflarePiStorage>>
  ) => Promise<CloudflarePiEngine>
}

/** Thin initialization/alarm seam. Production Worker routing and capability activation remain unavailable. */
export class CloudflarePiDurableOwner {
  private readonly ready: Promise<{ journal: CloudflareOwnerJournal; host: CloudflarePiHost }>

  constructor(
    context: CloudflareOwnerContext,
    private readonly bindings: CloudflareOwnerBindings
  ) {
    const pins = Object.freeze({ ...bindings.pins })
    this.ready = context.blockConcurrencyWhile(async () => {
      const journal = new CloudflareOwnerJournal(context.storage, pins)
      // On every constructor reentry, repair persisted wake intent before serving events.
      await journal.repairAlarm()
      const host = new CloudflarePiHost(journal, pins, bindings.authority, async () => {
        const storage = await openCloudflarePiStorage(context.storage)
        try {
          const engine = await bindings.openEngine(storage)
          return {
            run: (task, effect) => engine.run(task, effect),
            close: async () => {
              try {
                await engine.close()
              } finally {
                await storage.close(bindings.context)
              }
            },
          }
        } catch (error) {
          await storage.close(bindings.context)
          throw error
        }
      })
      return { journal, host }
    })
  }

  async accept(request: RuntimeStartRequest) {
    const { host } = await this.ready
    return host.accept(request, this.bindings.now())
  }

  async read(attemptId: string) {
    return (await this.ready).host.read(attemptId)
  }
  async events(attemptId: string, afterSequence = 0) {
    return (await this.ready).host.events(attemptId, afterSequence)
  }

  async cancel(attemptId: string) {
    return (await this.ready).host.cancel(attemptId)
  }

  async alarm(): Promise<void> {
    const { journal, host } = await this.ready
    const failures: unknown[] = []
    let afterAttemptId = ''
    try {
      for (let batch = journal.pending(); batch.length; batch = journal.pending(afterAttemptId)) {
        for (const record of batch) {
          afterAttemptId = record.task.request.attemptId
          try {
            await host.wake(afterAttemptId)
          } catch (error) {
            failures.push(error)
          }
        }
      }
    } finally {
      journal.refreshWake(this.bindings.now() + 30_000)
      await journal.repairAlarm()
    }
    if (failures.length) throw new AggregateError(failures, 'CLOUDFLARE_WAKE_BATCH_INCOMPLETE')
  }
}
