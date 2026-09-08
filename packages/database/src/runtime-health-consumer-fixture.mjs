import { isDeepStrictEqual } from 'node:util'
import { and, eq } from 'drizzle-orm'
import { RuntimeAvailabilityChangeSchema } from '@control-plane/runtime-sdk'
import { inboxMessages, outboxEvents } from './schema/messaging.ts'

// Standalone conformance fixture, not an Agent HQ receiver or production route.
export async function acceptRuntimeHealthFixture(database, event) {
  if (event.version !== 1 || !/^sha256:[a-f0-9]{64}$/.test(event.deliveryKey))
    throw new Error('INVALID_HEALTH_DELIVERY')
  const payload = {
    version: 1,
    deliveryKey: event.deliveryKey,
    change: RuntimeAvailabilityChangeSchema.parse(event.change),
  }
  await database.transaction(async (transaction) => {
    const inserted = await transaction
      .insert(inboxMessages)
      .values({
        consumer: 'm11-health-consumer',
        messageId: event.deliveryKey,
        payload,
      })
      .onConflictDoNothing()
      .returning({ id: inboxMessages.id })
    if (inserted.length === 0) {
      const [existing] = await transaction
        .select()
        .from(inboxMessages)
        .where(
          and(
            eq(inboxMessages.consumer, 'm11-health-consumer'),
            eq(inboxMessages.messageId, event.deliveryKey)
          )
        )
        .limit(1)
      if (!existing || !isDeepStrictEqual(existing.payload, payload))
        throw new Error('HEALTH_DELIVERY_KEY_CONFLICT')
      return
    }
    await transaction.insert(outboxEvents).values({
      aggregateType: 'm11-health-consumer-effect',
      aggregateId: event.deliveryKey,
      eventType: 'fixture.health.applied',
      payload: payload.change,
    })
  })
  return { acceptedDeliveryKey: event.deliveryKey }
}
