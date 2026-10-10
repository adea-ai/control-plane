import type { Context } from '@earendil-works/chord'
import type {
  RuntimeCancelRequest,
  RuntimeStartRequest,
  RuntimeSessionOperation,
} from '@control-plane/runtime-sdk'
import { RuntimeAdapterError, RuntimeSessionOperationSchema } from '@control-plane/runtime-sdk'
import type { DurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare'
import type { CloudflareReconciliationAuthority } from './reconciliation.js'
import {
  CloudflareReadOnlySessions,
  CloudflareSessionJournal,
  parseBinding,
  sessionError,
} from './sessions.js'
import type { CloudflareSessionAuthority, CloudflareSessionBinding } from './sessions.js'
import { CloudflarePiRuntimeAdapter } from './adapter.js'
import { CloudflarePiHost } from './host.js'
import type { CloudflareCurrentAuthority, CloudflarePiEngine } from './host.js'
import { CloudflareOwnerJournal } from './owner.js'
import type { CloudflareOwnerPins, CloudflareOwnerStorage } from './owner.js'
import {
  assertCloudflareTaskCompatibility,
  pinCloudflareTaskCatalog,
} from './task-compatibility.js'
import type { CloudflareNativeTaskCatalog } from './task-compatibility.js'
import type { RegistryReader } from '@earendil-works/pi-durable'
import { openCloudflarePiStorage } from './storage.js'

export interface CloudflareOwnerContext {
  readonly storage: CloudflareOwnerStorage & DurableObjectSqliteStorage
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}

/** Server-owned bindings. An HTTP/model payload cannot supply these ports or owner pins. */
export interface CloudflareOwnerBindings {
  readonly context: Context
  readonly pins: CloudflareOwnerPins
  readonly reconciliation?: CloudflareReconciliationAuthority
  readonly sessionAuthority?: CloudflareSessionAuthority
  readonly nativeTaskCatalog?: CloudflareNativeTaskCatalog
  readonly authority: CloudflareCurrentAuthority
  readonly now: () => number
  readonly openEngine: (
    storage: Awaited<ReturnType<typeof openCloudflarePiStorage>>,
    registry: RegistryReader
  ) => Promise<CloudflarePiEngine>
}

/** Thin initialization/alarm seam. Production Worker routing and capability activation remain unavailable. */
export class CloudflarePiDurableOwner {
  private readonly ready: Promise<{
    journal: CloudflareOwnerJournal
    host: CloudflarePiHost
    sessions?: CloudflareReadOnlySessions
  }>

  constructor(
    context: CloudflareOwnerContext,
    private readonly bindings: CloudflareOwnerBindings
  ) {
    const pins = Object.freeze({ ...bindings.pins })
    const catalog = bindings.nativeTaskCatalog
      ? pinCloudflareTaskCatalog(bindings.nativeTaskCatalog, pins)
      : undefined
    this.ready = context.blockConcurrencyWhile(async () => {
      const journal = new CloudflareOwnerJournal(context.storage, pins, bindings.now)
      // On every constructor reentry, repair persisted wake intent before serving events.
      await journal.repairAlarm()
      const host = new CloudflarePiHost(
        journal,
        pins,
        bindings.authority,
        async (_task, beforeEffect) => {
          if (!catalog)
            throw new RuntimeAdapterError({
              code: 'CLOUDFLARE_TASK_CATALOG_UNAVAILABLE',
              classification: 'unsupported',
              message: 'CLOUDFLARE_TASK_CATALOG_UNAVAILABLE',
              retryable: false,
            })
          const storage = await openCloudflarePiStorage(context.storage)
          try {
            await assertCloudflareTaskCompatibility(
              storage,
              catalog,
              beforeEffect,
              bindings.context
            )
            await beforeEffect()
            const engine = await bindings.openEngine(storage, catalog.registry)
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
        },
        bindings.reconciliation
      )
      const sessions = bindings.sessionAuthority
        ? new CloudflareReadOnlySessions(
            journal,
            new CloudflareSessionJournal(context.storage, journal),
            pins,
            bindings.authority,
            bindings.sessionAuthority,
            () => openCloudflarePiStorage(context.storage),
            bindings.context,
            bindings.now
          )
        : undefined
      return { journal, host, ...(sessions ? { sessions } : {}) }
    })
  }

  /** Explicit local composition only; does not register or activate a Worker profile. */
  runtimeAdapter(): CloudflarePiRuntimeAdapter {
    return new CloudflarePiRuntimeAdapter(this, this.bindings.now)
  }

  /** Trusted composition only: verify an existing canonical session/native record, never mint authority. */
  async bindSession(binding: CloudflareSessionBinding): Promise<void> {
    const snapshot = parseBinding(binding)
    const { sessions } = await this.ready
    if (!sessions) throw sessionError('CLOUDFLARE_SESSION_UNSUPPORTED', 'unsupported')
    await sessions.bind(snapshot)
  }

  async session(operation: RuntimeSessionOperation) {
    const snapshot = RuntimeSessionOperationSchema.parse(operation)
    const { sessions } = await this.ready
    if (!sessions) throw sessionError('CLOUDFLARE_SESSION_UNSUPPORTED', 'unsupported')
    return sessions.operation(snapshot)
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

  async timedEvents(attemptId: string, afterSequence = 0) {
    return (await this.ready).host.timedEvents(attemptId, afterSequence)
  }

  async reconcile(attemptId: string) {
    return (await this.ready).host.reconcile(attemptId)
  }

  async cancel(attemptId: string, request?: RuntimeCancelRequest) {
    return (await this.ready).host.cancel(attemptId, request)
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
