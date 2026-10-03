import { IdentifierSchemas } from '@control-plane/contracts'
import { eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { hostedGraphToolConfigurations } from './schema/hosted-graph-tool-configurations.js'

export interface HostedGraphToolConfigurationPin {
  readonly schemaVersion: 1
  readonly toolDefinitionId: string
  readonly toolVersionId: string
  readonly contentDigest: string
  readonly operation: string
  readonly currency: string
  readonly costMicrounits: number
  readonly configurationDigest: string
}

/** Pins an operator-selected tariff to an immutable system tool version. */
export class PostgresHostedGraphToolConfigurationRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async pin(input: HostedGraphToolConfigurationPin): Promise<void> {
    const record = validateConfigurationPin(input)
    await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${record.toolVersionId}, 0))`
      )
      await transaction.insert(hostedGraphToolConfigurations).values(record).onConflictDoNothing()
      const [stored] = await transaction
        .select()
        .from(hostedGraphToolConfigurations)
        .where(eq(hostedGraphToolConfigurations.toolVersionId, record.toolVersionId))
        .limit(1)
      if (
        stored === undefined ||
        stored.schemaVersion !== record.schemaVersion ||
        stored.toolDefinitionId !== record.toolDefinitionId ||
        stored.contentDigest !== record.contentDigest ||
        stored.operation !== record.operation ||
        stored.currency !== record.currency ||
        stored.costMicrounits !== record.costMicrounits ||
        stored.configurationDigest !== record.configurationDigest
      ) {
        throw new Error('HOSTED_GRAPH_TOOL_CONFIGURATION_CHANGED')
      }
    })
  }
}

function validateConfigurationPin(input: HostedGraphToolConfigurationPin) {
  const toolDefinitionId = IdentifierSchemas.toolDefinitionId.parse(input.toolDefinitionId)
  const toolVersionId = IdentifierSchemas.toolVersionId.parse(input.toolVersionId)
  if (
    input.schemaVersion !== 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(input.contentDigest) ||
    !/^[a-z][a-z0-9.-]{0,127}$/.test(input.operation) ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    !Number.isSafeInteger(input.costMicrounits) ||
    input.costMicrounits < 1 ||
    !/^[a-f0-9]{64}$/.test(input.configurationDigest)
  ) {
    throw new Error('HOSTED_GRAPH_TOOL_CONFIGURATION_INVALID')
  }
  return {
    schemaVersion: 1 as const,
    toolDefinitionId,
    toolVersionId,
    contentDigest: input.contentDigest,
    operation: input.operation,
    currency: input.currency,
    costMicrounits: input.costMicrounits,
    configurationDigest: input.configurationDigest,
  }
}
