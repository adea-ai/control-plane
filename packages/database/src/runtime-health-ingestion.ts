import {
  RuntimeAvailabilityChangeSchema,
  RuntimeConnectionRegistry,
  RuntimeHealthIngestionService,
  type RuntimeHealthIngestionPolicy,
  type RuntimeHealthIngestionResult,
  type RuntimeConnection,
} from '@control-plane/runtime-sdk'
import type { ControlPlaneDatabase } from './connection.js'
import { PostgresRuntimeConnectionRepository } from './runtime-connection-repository.js'
import { outboxEvents } from './schema/messaging.js'

/** Commits registry updates and pending events together; does not perform external delivery. */
export class PostgresRuntimeHealthIngestionService {
  constructor(
    readonly database: Pick<ControlPlaneDatabase, 'transaction'>,
    readonly policy: RuntimeHealthIngestionPolicy
  ) {}

  ingest(report: unknown, evaluatedAt: string): Promise<RuntimeHealthIngestionResult> {
    return this.#run((service) => service.ingest(report, evaluatedAt))
  }

  refresh(input: unknown): Promise<RuntimeHealthIngestionResult> {
    return this.#run((service) => service.refresh(input))
  }

  markDisappeared(input: unknown): Promise<RuntimeConnection> {
    return this.#run((service) => service.markDisappeared(input))
  }

  #run<Result>(
    operation: (service: RuntimeHealthIngestionService) => Promise<Result>
  ): Promise<Result> {
    return this.database.transaction((transaction) =>
      operation(createPostgresRuntimeHealthInTransaction(transaction, this.policy))
    )
  }
}

export function createPostgresRuntimeHealthInTransaction(
  transaction: Pick<ControlPlaneDatabase, 'select' | 'insert' | 'update'>,
  policy: RuntimeHealthIngestionPolicy
): RuntimeHealthIngestionService {
  return new RuntimeHealthIngestionService({
    registry: new RuntimeConnectionRegistry(new PostgresRuntimeConnectionRepository(transaction)),
    policy,
    changes: {
      publish: async (input) => {
        const change = RuntimeAvailabilityChangeSchema.parse(input)
        await transaction.insert(outboxEvents).values({
          aggregateType: 'runtime_connection',
          aggregateId: change.runtimeConnectionId,
          eventType: change.type,
          payload: change,
        })
      },
    },
  })
}
