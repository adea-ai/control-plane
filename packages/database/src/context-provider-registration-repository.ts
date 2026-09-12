import {
  ContextProviderRegistrationSchema,
  contextProviderRegistrationIdentity,
  type ContextProviderRegistration,
  type ContextProviderRegistrationRepository,
} from '@control-plane/domain'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { contextProviderRegistrations as table } from './schema/context-provider-registrations.js'

function parse(row: typeof table.$inferSelect): ContextProviderRegistration {
  const record = ContextProviderRegistrationSchema.parse(row.record)
  const connection = record.readModel.connection
  if (
    connection.workspaceId !== row.workspaceId ||
    connection.connectionId !== row.connectionId ||
    connection.principalRef !== row.principalRef ||
    connection.state !== row.state
  )
    throw new Error('CONTEXT_PROVIDER_REGISTRY_SCOPE_MISMATCH')
  return record
}

export class PostgresContextProviderRegistrationRepository implements ContextProviderRegistrationRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async save(expectedVersion: number, input: ContextProviderRegistration): Promise<boolean> {
    const next = ContextProviderRegistrationSchema.parse(input)
    if (
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 ||
      next.version !== expectedVersion + 1
    )
      return false
    const connection = next.readModel.connection
    return this.database.transaction(async (tx) => {
      // Serialize both first creation of an identity and scoped capacity checks across instances.
      const identity = JSON.stringify([connection.workspaceId, connection.connectionId])
      const scope = JSON.stringify([connection.workspaceId, connection.principalRef])
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`context-provider:${identity}`}, 0))`
      )
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`context-provider-scope:${scope}`}, 0))`
      )
      const predicate = and(
        eq(table.workspaceId, connection.workspaceId),
        eq(table.connectionId, connection.connectionId)
      )
      const [stored] = await tx.select().from(table).where(predicate).limit(1)
      if (stored) {
        const current = parse(stored)
        if (
          current.version !== expectedVersion ||
          contextProviderRegistrationIdentity(current) !==
            contextProviderRegistrationIdentity(next) ||
          Date.parse(next.readModel.health.checkedAt) <
            Date.parse(current.readModel.health.checkedAt) ||
          (current.readModel.connection.state === 'revoked' && connection.state !== 'revoked')
        )
          return false
      } else {
        if (expectedVersion !== 0 || connection.state !== 'active') return false
        const active = await tx
          .select({ connectionId: table.connectionId })
          .from(table)
          .where(
            and(
              eq(table.workspaceId, connection.workspaceId),
              eq(table.principalRef, connection.principalRef),
              eq(table.state, 'active')
            )
          )
          .limit(32)
        if (active.length >= 32) return false
      }
      const values = {
        workspaceId: connection.workspaceId,
        connectionId: connection.connectionId,
        principalRef: connection.principalRef,
        state: connection.state,
        record: next,
      }
      if (stored) await tx.update(table).set(values).where(predicate)
      else await tx.insert(table).values(values)
      return true
    })
  }

  async list(scope: {
    workspaceId: string
    principalRef: string
  }): Promise<ContextProviderRegistration[]> {
    const rows = await this.database
      .select()
      .from(table)
      .where(
        and(
          eq(table.workspaceId, scope.workspaceId),
          eq(table.principalRef, scope.principalRef),
          eq(table.state, 'active')
        )
      )
      .orderBy(asc(table.connectionId))
      .limit(33)
    if (rows.length > 32) throw new Error('CONTEXT_PROVIDER_REGISTRY_LIMIT_EXCEEDED')
    return rows.map(parse)
  }
}
