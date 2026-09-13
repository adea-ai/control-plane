import { createHash } from 'node:crypto'
import {
  RuntimeChannelSequenceRequestSchema,
  type RuntimeChannelSequenceRequest,
  type RuntimeChannelSequenceRepository,
} from '@control-plane/runtime-sdk'
import { eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { runtimeChannelSequences } from './schema/runtime-channel-sequences.js'

export class PostgresRuntimeChannelSequenceRepository implements RuntimeChannelSequenceRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async reserve(input: RuntimeChannelSequenceRequest): Promise<number> {
    const request = RuntimeChannelSequenceRequestSchema.parse(input)
    const channel = request.channel
    const identity = JSON.stringify([
      channel.workspaceId,
      channel.nodeId,
      channel.gatewayInstanceId,
      channel.connectionId,
      channel.channelGeneration,
    ])
    const id = createHash('sha256').update(identity).digest('hex')
    return this.database.transaction(async (tx) => {
      // Transaction-scoped locking also serializes first insert across gateway instances.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`runtime-sequence:${id}`}, 0))`
      )
      const [stored] = await tx
        .select()
        .from(runtimeChannelSequences)
        .where(eq(runtimeChannelSequences.id, id))
        .limit(1)
      if (
        stored &&
        (stored.identity !== identity ||
          !Number.isSafeInteger(stored.next) ||
          stored.next < 1 ||
          stored.next > 2147483648)
      )
        throw new Error('RUNTIME_CHANNEL_SEQUENCE_CORRUPT')
      const first = Math.max(request.minimum, stored?.next ?? 1)
      const next = first + request.count
      if (next > 2147483648) throw new Error('RUNTIME_CHANNEL_SEQUENCE_EXHAUSTED')
      await tx
        .insert(runtimeChannelSequences)
        .values({ id, identity, next })
        .onConflictDoUpdate({ target: runtimeChannelSequences.id, set: { next } })
      return first
    })
  }
}
