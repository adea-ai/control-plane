import {
  RuntimeChannelOwnershipSchema,
  type RuntimeChannelOwnership,
  type RuntimeChannelOwnershipRepository,
} from '@control-plane/runtime-sdk'
import { eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { runtimeChannelOwnership } from './schema/runtime-channel-ownership.js'

export class PostgresRuntimeChannelOwnershipRepository implements RuntimeChannelOwnershipRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async lookup(nodeId: string): Promise<RuntimeChannelOwnership | undefined> {
    const [row] = await this.database
      .select()
      .from(runtimeChannelOwnership)
      .where(eq(runtimeChannelOwnership.nodeId, nodeId))
      .limit(1)
    return row?.active ? RuntimeChannelOwnershipSchema.parse(row.record) : undefined
  }

  async claim(
    input: RuntimeChannelOwnership
  ): Promise<{ accepted: boolean; previous?: RuntimeChannelOwnership }> {
    const record = RuntimeChannelOwnershipSchema.parse(input)
    return this.database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`runtime-channel:${record.nodeId}`}, 0))`
      )
      const [current] = await tx
        .select()
        .from(runtimeChannelOwnership)
        .where(eq(runtimeChannelOwnership.nodeId, record.nodeId))
        .limit(1)
      if (current && current.workspaceId !== record.workspaceId)
        throw new Error('RUNTIME_CHANNEL_WORKSPACE_MISMATCH')
      const previous = current?.active
        ? RuntimeChannelOwnershipSchema.parse(current.record)
        : undefined
      if (current && record.channelGeneration <= current.generation)
        return { accepted: false, ...(previous ? { previous } : {}) }
      await tx
        .insert(runtimeChannelOwnership)
        .values({
          nodeId: record.nodeId,
          workspaceId: record.workspaceId,
          generation: record.channelGeneration,
          active: true,
          record,
        })
        .onConflictDoUpdate({
          target: runtimeChannelOwnership.nodeId,
          set: { generation: record.channelGeneration, active: true, record },
        })
      return { accepted: true, ...(previous ? { previous } : {}) }
    })
  }

  heartbeat(record: RuntimeChannelOwnership): Promise<boolean> {
    return this.#mutate(record, false)
  }

  release(record: RuntimeChannelOwnership): Promise<boolean> {
    return this.#mutate(record, true)
  }

  async #mutate(input: RuntimeChannelOwnership, release: boolean): Promise<boolean> {
    const record = RuntimeChannelOwnershipSchema.parse(input)
    return this.database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`runtime-channel:${record.nodeId}`}, 0))`
      )
      const [row] = await tx
        .select()
        .from(runtimeChannelOwnership)
        .where(eq(runtimeChannelOwnership.nodeId, record.nodeId))
        .limit(1)
      if (
        !row?.active ||
        row.workspaceId !== record.workspaceId ||
        row.generation !== record.channelGeneration
      )
        return false
      const current = RuntimeChannelOwnershipSchema.parse(row.record)
      if (
        current.gatewayInstanceId !== record.gatewayInstanceId ||
        current.connectionId !== record.connectionId ||
        current.connectedAt !== record.connectedAt ||
        current.protocolVersion.major !== record.protocolVersion.major ||
        current.protocolVersion.minor !== record.protocolVersion.minor
      )
        return false
      if (!release && Date.parse(record.lastHeartbeatAt) < Date.parse(current.lastHeartbeatAt))
        return false
      await tx
        .update(runtimeChannelOwnership)
        .set(
          release
            ? { active: false }
            : { record: { ...current, lastHeartbeatAt: record.lastHeartbeatAt } }
        )
        .where(eq(runtimeChannelOwnership.nodeId, record.nodeId))
      return true
    })
  }
}
