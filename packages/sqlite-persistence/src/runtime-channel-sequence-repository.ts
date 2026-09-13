import { createHash } from 'node:crypto'
import type { PersistenceProvider } from '@control-plane/deployment'
import {
  RuntimeChannelSequenceRequestSchema,
  type RuntimeChannelSequenceRequest,
  type RuntimeChannelSequenceRepository,
} from '@control-plane/runtime-sdk'

export class SqliteRuntimeChannelSequenceRepository implements RuntimeChannelSequenceRepository {
  constructor(readonly provider: PersistenceProvider) {}

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
    const id = `r-${createHash('sha256').update(identity).digest('hex')}`
    return this.provider.transaction(async (transaction) => {
      const stored = await transaction.get('runtime-channel-sequences', id)
      const value = stored?.value as { identity?: unknown; next?: unknown } | undefined
      if (
        stored &&
        (!value ||
          value.identity !== identity ||
          !Number.isSafeInteger(value.next) ||
          (value.next as number) < 1 ||
          (value.next as number) > 2147483648)
      )
        throw new Error('RUNTIME_CHANNEL_SEQUENCE_CORRUPT')
      const first = Math.max(request.minimum, (value?.next as number | undefined) ?? 1)
      const next = first + request.count
      if (next > 2147483648) throw new Error('RUNTIME_CHANNEL_SEQUENCE_EXHAUSTED')
      await transaction.put({
        namespace: 'runtime-channel-sequences',
        id,
        ...(stored ? { expectedRevision: stored.revision } : {}),
        value: { identity, next },
      })
      return first
    })
  }
}
