import { createHash } from 'node:crypto'
import {
  RuntimeAvailabilityChangeSchema,
  type RuntimeAvailabilityChange,
} from '@control-plane/runtime-sdk'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { outboxEvents } from './schema/messaging.js'

export interface RuntimeHealthEventDelivery {
  readonly version: 1
  /** Stable opaque deduplication key, not the database record ID. */
  readonly deliveryKey: string
  readonly change: RuntimeAvailabilityChange
}

/** Internal service boundary. Receivers must durably deduplicate deliveryKey before acknowledging. */
export interface RuntimeHealthEventTransport {
  deliver(
    event: RuntimeHealthEventDelivery,
    signal: AbortSignal
  ): Promise<{ readonly acceptedDeliveryKey: string }>
}

export class PostgresRuntimeHealthEventDispatcher {
  #running: Promise<{ delivered: number; failed: number; conflicts: number }> | undefined

  constructor(
    readonly database: Pick<ControlPlaneDatabase, 'select' | 'update'>,
    readonly transport: RuntimeHealthEventTransport,
    readonly now: () => Date = () => new Date(),
    readonly timeoutMs = 10_000
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error('INVALID_RUNTIME_HEALTH_DISPATCH_TIMEOUT')
  }

  async #deliver(event: RuntimeHealthEventDelivery) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.transport.deliver(event, controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('RUNTIME_HEALTH_DELIVERY_TIMEOUT'))
          }, this.timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  dispatchBatch(limit: number): Promise<{ delivered: number; failed: number; conflicts: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw new Error('INVALID_RUNTIME_HEALTH_DISPATCH_LIMIT')
    this.#running ??= this.#dispatch(limit).finally(() => {
      this.#running = undefined
    })
    return this.#running
  }

  async #dispatch(limit: number) {
    const rows = await this.database
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateType, 'runtime_connection'),
          eq(outboxEvents.eventType, 'runtime.availability_changed'),
          inArray(outboxEvents.status, ['pending', 'failed'])
        )
      )
      .orderBy(asc(outboxEvents.updatedAt), asc(outboxEvents.id))
      .limit(limit)
    const result = { delivered: 0, failed: 0, conflicts: 0 }
    for (const row of rows) {
      let accepted = false
      try {
        const change = RuntimeAvailabilityChangeSchema.parse(row.payload)
        if (change.runtimeConnectionId !== row.aggregateId)
          throw new Error('HEALTH_EVENT_SCOPE_MISMATCH')
        const deliveryKey = `sha256:${createHash('sha256').update(`runtime-health:v1:${row.id}`).digest('hex')}`
        const acknowledgement = await this.#deliver({ version: 1, deliveryKey, change })
        accepted = acknowledgement.acceptedDeliveryKey === deliveryKey
      } catch {
        // Keep payloads, credentials and untrusted transport errors out of diagnostics.
      }
      const attemptedAt = this.now()
      if (!Number.isFinite(attemptedAt.getTime()))
        throw new Error('INVALID_RUNTIME_HEALTH_DISPATCH_TIME')
      const updated = await this.database
        .update(outboxEvents)
        .set({
          status: accepted ? 'published' : 'failed',
          attempts: Math.min(row.attempts + 1, 2_147_483_647),
          revision: row.revision + 1n,
          updatedAt: attemptedAt,
          publishedAt: accepted ? attemptedAt : null,
        })
        .where(
          and(
            eq(outboxEvents.id, row.id),
            eq(outboxEvents.revision, row.revision),
            inArray(outboxEvents.status, ['pending', 'failed'])
          )
        )
        .returning({ id: outboxEvents.id })
      if (updated.length === 0) result.conflicts++
      else if (accepted) result.delivered++
      else result.failed++
    }
    return result
  }
}
