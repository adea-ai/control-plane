import { IdentifierSchemas } from '@control-plane/contracts'
import { and, eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { executions } from './schema/executions.js'
import { graphToolCancellations } from './schema/graph-tool-cancellations.js'

type ToolCallCancellationTransaction = Parameters<
  Parameters<ControlPlaneDatabase['transaction']>[0]
>[0]

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
      await lockExecutionAdmission(transaction, executionId)
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

  /**
   * Fences a new tool-call receipt against cancellation using the same
   * execution lock held while the cancellation marker is persisted.
   */
  async assertNotCancelledInTransaction(
    transaction: ToolCallCancellationTransaction,
    executionIdInput: string,
    workspaceIdInput: string
  ): Promise<void> {
    const executionId = IdentifierSchemas.executionId.parse(executionIdInput)
    const workspaceId = IdentifierSchemas.workspaceId.parse(workspaceIdInput)
    await lockExecutionAdmission(transaction, executionId)
    const [cancellation] = await transaction
      .select({ executionId: graphToolCancellations.executionId })
      .from(graphToolCancellations)
      .where(
        and(
          eq(graphToolCancellations.workspaceId, workspaceId),
          eq(graphToolCancellations.executionId, executionId)
        )
      )
      .limit(1)
    if (cancellation !== undefined) throw new Error('HOSTED_GRAPH_TOOL_CANCELLED')
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

function lockExecutionAdmission(transaction: ToolCallCancellationTransaction, executionId: string) {
  return transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${executionId}, 0))`)
}
