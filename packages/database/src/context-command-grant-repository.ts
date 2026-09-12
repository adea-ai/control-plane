import {
  ContextCommandGrantSchema,
  type ContextCommandGrant,
  type ContextCommandGrantRepository,
} from '@control-plane/domain'
import { and, eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { contextCommandGrants } from './schema/context-command-grants.js'

const scoped = (workspaceId: string, authorizationRef: string) =>
  and(
    eq(contextCommandGrants.workspaceId, workspaceId),
    eq(contextCommandGrants.authorizationRef, authorizationRef)
  )

function parse(
  record: unknown,
  workspaceId: string,
  authorizationRef: string
): ContextCommandGrant {
  const grant = ContextCommandGrantSchema.parse(record)
  if (grant.workspaceId !== workspaceId || grant.authorizationRef !== authorizationRef)
    throw new Error('CONTEXT_GRANT_SCOPE_MISMATCH')
  return grant
}

export class PostgresContextCommandGrantRepository implements ContextCommandGrantRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async create(input: ContextCommandGrant): Promise<void> {
    const grant = ContextCommandGrantSchema.parse(input)
    if (grant.status !== 'active') throw new Error('CONTEXT_GRANT_CREATE_INVALID')
    const created = await this.database
      .insert(contextCommandGrants)
      .values({
        workspaceId: grant.workspaceId,
        authorizationRef: grant.authorizationRef,
        record: grant,
      })
      .onConflictDoNothing()
      .returning({ workspaceId: contextCommandGrants.workspaceId })
    if (created.length !== 1) throw new Error('CONTEXT_GRANT_ALREADY_EXISTS')
  }

  async get(
    workspaceId: string,
    authorizationRef: string
  ): Promise<ContextCommandGrant | undefined> {
    const [row] = await this.database
      .select()
      .from(contextCommandGrants)
      .where(scoped(workspaceId, authorizationRef))
      .limit(1)
    return row ? parse(row.record, workspaceId, authorizationRef) : undefined
  }

  async revoke(workspaceId: string, authorizationRef: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(contextCommandGrants)
        .where(scoped(workspaceId, authorizationRef))
        .limit(1)
        .for('update')
      if (!row) throw new Error('CONTEXT_GRANT_NOT_FOUND')
      const grant = parse(row.record, workspaceId, authorizationRef)
      if (grant.status === 'revoked') return
      await tx
        .update(contextCommandGrants)
        .set({ record: { ...grant, status: 'revoked' } })
        .where(scoped(workspaceId, authorizationRef))
    })
  }
}
