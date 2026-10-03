import { IdentifierSchemas } from '@control-plane/contracts'
import { and, eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { executions } from './schema/executions.js'
import { graphToolCancellations } from './schema/graph-tool-cancellations.js'

export interface GraphToolCancellation {
  readonly workspaceId: string
  readonly executionId: string
  readonly threadId: string
  readonly idempotencyKey: string
  readonly createdAt: Date
}

/** Persistent cancellation intent, scoped to the accepted execution owner. */
export class PostgresGraphToolCancellationRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async record(input: Omit<GraphToolCancellation, 'createdAt'>): Promise<{
    readonly cancellation: GraphToolCancellation
    readonly inserted: boolean
  }> {
    const workspaceId = IdentifierSchemas.workspaceId.parse(input.workspaceId)
    const executionId = IdentifierSchemas.executionId.parse(input.executionId)
    if (
      input.threadId !== `graph:${executionId}` ||
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 256
    ) {
      throw new Error('GRAPH_TOOL_CANCELLATION_INVALID')
    }
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${executionId}, 0))`
      )
      const [owner] = await transaction
        .select({ workspaceId: executions.workspaceId })
        .from(executions)
        .where(eq(executions.executionId, executionId))
        .limit(1)
        .for('key share')
      if (owner === undefined || owner.workspaceId !== workspaceId) {
        throw new Error('GRAPH_TOOL_CANCELLATION_SCOPE_MISMATCH')
      }
      const [inserted] = await transaction
        .insert(graphToolCancellations)
        .values({ ...input, workspaceId, executionId })
        .onConflictDoNothing()
        .returning({ executionId: graphToolCancellations.executionId })
      const [cancellation] = await transaction
        .select()
        .from(graphToolCancellations)
        .where(
          and(
            eq(graphToolCancellations.workspaceId, workspaceId),
            eq(graphToolCancellations.executionId, executionId)
          )
        )
        .limit(1)
      if (
        cancellation === undefined ||
        cancellation.threadId !== input.threadId ||
        cancellation.idempotencyKey !== input.idempotencyKey
      ) {
        throw new Error('GRAPH_TOOL_CANCELLATION_CONFLICT')
      }
      return { cancellation, inserted: inserted !== undefined }
    })
  }

  async get(
    executionIdInput: string,
    workspaceIdInput: string
  ): Promise<GraphToolCancellation | undefined> {
    const executionId = IdentifierSchemas.executionId.parse(executionIdInput)
    const workspaceId = IdentifierSchemas.workspaceId.parse(workspaceIdInput)
    const [cancellation] = await this.database
      .select()
      .from(graphToolCancellations)
      .where(
        and(
          eq(graphToolCancellations.workspaceId, workspaceId),
          eq(graphToolCancellations.executionId, executionId)
        )
      )
      .limit(1)
    return cancellation
  }
}
