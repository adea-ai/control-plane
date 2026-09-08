import { IdentifierSchemas } from '@control-plane/contracts'
import {
  RuntimeConnectionRegistry,
  type RuntimeHealthIngestionPolicy,
} from '@control-plane/runtime-sdk'
import { sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { PostgresRuntimeConnectionRepository } from './runtime-connection-repository.js'
import { PostgresRuntimeDiscoveryRepository } from './runtime-discovery-repository.js'
import { PostgresRuntimeInventoryCheckpointRepository } from './runtime-inventory-checkpoint-repository.js'
import { createPostgresRuntimeHealthInTransaction } from './runtime-health-ingestion.js'

export class PostgresRuntimeInventoryUnitOfWork {
  constructor(
    readonly database: Pick<ControlPlaneDatabase, 'transaction'>,
    readonly policy: RuntimeHealthIngestionPolicy
  ) {}

  run<Result>(
    scope: { workspaceId: string; runtimeNodeRefId: string },
    operation: (ports: {
      registry: RuntimeConnectionRegistry
      health: ReturnType<typeof createPostgresRuntimeHealthInTransaction>
      projections: PostgresRuntimeDiscoveryRepository
      checkpoints: PostgresRuntimeInventoryCheckpointRepository
    }) => Promise<Result>
  ): Promise<Result> {
    const workspaceId = IdentifierSchemas.workspaceId.parse(scope.workspaceId)
    const nodeId = IdentifierSchemas.runtimeNodeRefId.parse(scope.runtimeNodeRefId)
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL lock_timeout = '5s'`)
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
