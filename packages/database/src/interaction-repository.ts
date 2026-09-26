import {
  InteractionRequestSchema,
  type InteractionRepository,
  type InteractionRequest,
} from '@control-plane/domain'
import { and, eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { interactionRequests } from './schema/interactions.js'
import { executionAttempts, executions } from './schema/executions.js'

export class PostgresInteractionRepository implements InteractionRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async insert(request: InteractionRequest): Promise<boolean> {
    const parsed = InteractionRequestSchema.parse(request)
    return this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ interactionId: interactionRequests.interactionId })
        .from(interactionRequests)
        .where(eq(interactionRequests.interactionId, parsed.interactionId))
        .limit(1)
      if (existing !== undefined) return false

      const [owner] = await transaction
        .select({ executionId: executions.executionId })
        .from(executions)
        .where(eq(executions.executionId, parsed.executionId))
        .for('key share')
        .limit(1)
      if (owner === undefined) throw new Error('INTERACTION_EXECUTION_MISSING')

      const [attempt] = await transaction
        .select({ executionId: executionAttempts.executionId })
        .from(executionAttempts)
        .where(eq(executionAttempts.attemptId, parsed.attemptId))
        .for('key share')
        .limit(1)
      if (attempt === undefined) throw new Error('INTERACTION_ATTEMPT_MISSING')
      if (attempt.executionId !== parsed.executionId)
        throw new Error('INTERACTION_ATTEMPT_EXECUTION_MISMATCH')

      const inserted = await transaction
        .insert(interactionRequests)
        .values(toInteractionRow(parsed))
        .onConflictDoNothing()
        .returning({ interactionId: interactionRequests.interactionId })
      return inserted.length === 1
    })
  }

  async get(interactionId: string): Promise<InteractionRequest | undefined> {
    const [row] = await this.database
      .select()
      .from(interactionRequests)
      .where(eq(interactionRequests.interactionId, interactionId))
      .limit(1)
    return row ? fromInteractionRow(row) : undefined
  }

  async compareAndSet(expectedVersion: number, request: InteractionRequest): Promise<boolean> {
    const parsed = InteractionRequestSchema.parse(request)
    const updated = await this.database
      .update(interactionRequests)
      .set(toInteractionUpdate(parsed))
      .where(
        and(
          eq(interactionRequests.interactionId, parsed.interactionId),
          eq(interactionRequests.version, expectedVersion)
        )
      )
      .returning({ interactionId: interactionRequests.interactionId })
    return updated.length === 1
  }
}

type InteractionRow = typeof interactionRequests.$inferSelect

function toInteractionRow(request: InteractionRequest): typeof interactionRequests.$inferInsert {
  return {
    interactionId: request.interactionId,
    executionId: request.executionId,
    attemptId: request.attemptId,
    kind: request.kind,
    state: request.state,
    prompt: request.prompt,
    allowedActions: request.allowedActions,
    allowedPrincipalIds: request.allowedPrincipalIds,
    version: request.version,
    requestedAt: new Date(request.requestedAt),
    expiresAt: new Date(request.expiresAt),
    response: request.response ?? null,
    resolvedAt: request.resolvedAt ? new Date(request.resolvedAt) : null,
  }
}

function toInteractionUpdate(
  request: InteractionRequest
): Partial<typeof interactionRequests.$inferInsert> {
  return {
    state: request.state,
    version: request.version,
    response: request.response ?? null,
    resolvedAt: request.resolvedAt ? new Date(request.resolvedAt) : null,
  }
}

function fromInteractionRow(row: InteractionRow): InteractionRequest {
  return InteractionRequestSchema.parse({
    interactionId: row.interactionId,
    executionId: row.executionId,
    attemptId: row.attemptId,
    kind: row.kind,
    state: row.state,
    prompt: row.prompt,
    allowedActions: row.allowedActions,
    allowedPrincipalIds: row.allowedPrincipalIds,
    version: row.version,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.response ? { response: row.response } : {}),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}),
  })
}
