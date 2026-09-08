import { IdentifierSchemas } from '@control-plane/contracts'
import {
  RuntimeConnectionRegistry,
  RuntimeChannelOwnershipSchema,
  type RuntimeChannelOwnership,
  type RuntimeHealthIngestionPolicy,
} from '@control-plane/runtime-sdk'
import { eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { PostgresRuntimeConnectionRepository } from './runtime-connection-repository.js'
import { PostgresRuntimeDiscoveryRepository } from './runtime-discovery-repository.js'
import { PostgresRuntimeInventoryCheckpointRepository } from './runtime-inventory-checkpoint-repository.js'
import { createPostgresRuntimeHealthInTransaction } from './runtime-health-ingestion.js'
import { runtimeChannelOwnership } from './schema/runtime-channel-ownership.js'

export class PostgresRuntimeInventoryUnitOfWork {
  readonly #transactionTimeoutMs: number

  constructor(
    readonly database: Pick<ControlPlaneDatabase, 'transaction'>,
    readonly policy: RuntimeHealthIngestionPolicy,
    options: { readonly transactionTimeoutMs?: number } = {}
  ) {
    this.#transactionTimeoutMs = options.transactionTimeoutMs ?? 10_000
    if (
      !Number.isSafeInteger(this.#transactionTimeoutMs) ||
      this.#transactionTimeoutMs < 1 ||
      this.#transactionTimeoutMs > 30_000
    )
      throw new Error('Invalid inventory transactionTimeoutMs')
  }

  async run<Result>(
    scope: { workspaceId: string; runtimeNodeRefId: string; channel: RuntimeChannelOwnership },
    operation: (ports: {
      registry: RuntimeConnectionRegistry
      health: ReturnType<typeof createPostgresRuntimeHealthInTransaction>
      projections: PostgresRuntimeDiscoveryRepository
      checkpoints: PostgresRuntimeInventoryCheckpointRepository
    }) => Promise<Result>
  ): Promise<Result> {
    const workspaceId = IdentifierSchemas.workspaceId.parse(scope.workspaceId)
    const nodeId = IdentifierSchemas.runtimeNodeRefId.parse(scope.runtimeNodeRefId)
    const channel = RuntimeChannelOwnershipSchema.parse(scope.channel)
    if (channel.nodeId !== nodeId || channel.workspaceId !== workspaceId)
      throw new Error('INVENTORY_SCOPE_MISMATCH')
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select set_config('transaction_timeout', ${String(this.#transactionTimeoutMs)}, true)`
      )
      await transaction.execute(sql`SET LOCAL lock_timeout = '5s'`)
      // Claims, heartbeats and releases take this same lock. Keep ownership
      // stable through commit, always before acquiring the inventory lock.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`runtime-channel:${nodeId}`}, 0))`
      )
      const [owner] = await transaction
        .select()
        .from(runtimeChannelOwnership)
        .where(eq(runtimeChannelOwnership.nodeId, nodeId))
        .limit(1)
      if (!owner?.active) throw new Error('INVENTORY_CHANNEL_STALE')
      const currentChannel = RuntimeChannelOwnershipSchema.parse(owner.record)
      if (
        owner.workspaceId !== workspaceId ||
        owner.generation !== channel.channelGeneration ||
        currentChannel.nodeId !== nodeId ||
        currentChannel.workspaceId !== workspaceId ||
        currentChannel.channelGeneration !== channel.channelGeneration ||
        currentChannel.gatewayInstanceId !== channel.gatewayInstanceId ||
        currentChannel.connectionId !== channel.connectionId ||
        currentChannel.connectedAt !== channel.connectedAt ||
        currentChannel.protocolVersion.major !== channel.protocolVersion.major ||
        currentChannel.protocolVersion.minor !== channel.protocolVersion.minor
      )
        throw new Error('INVENTORY_CHANNEL_STALE')
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`runtime-inventory:${nodeId}`}, 0))`
      )
      const checkpoints = new PostgresRuntimeInventoryCheckpointRepository(transaction)
      const current = await checkpoints.get(nodeId)
      if (current && current.workspaceId !== workspaceId)
        throw new Error('INVENTORY_SCOPE_MISMATCH')
      return operation({
        registry: new RuntimeConnectionRegistry(
          new PostgresRuntimeConnectionRepository(transaction)
        ),
        health: createPostgresRuntimeHealthInTransaction(transaction, this.policy),
        projections: new PostgresRuntimeDiscoveryRepository(transaction),
        checkpoints,
      })
    })
  }
}
