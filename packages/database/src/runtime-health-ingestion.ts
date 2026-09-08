import {
  RuntimeAvailabilityChangeSchema,
  RuntimeConnectionRegistry,
  RuntimeHealthIngestionService,
  type RuntimeHealthIngestionPolicy,
  type RuntimeHealthIngestionResult,
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

  #run(
    operation: (service: RuntimeHealthIngestionService) => Promise<RuntimeHealthIngestionResult>
  ): Promise<RuntimeHealthIngestionResult> {
    return this.database.transaction(async (transaction) => {
      const service = new RuntimeHealthIngestionService({
        registry: new RuntimeConnectionRegistry(
          new PostgresRuntimeConnectionRepository(transaction)
        ),
        policy: this.policy,
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
      return operation(service)
    })
  }
}
