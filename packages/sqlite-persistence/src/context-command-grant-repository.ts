import { createHash } from 'node:crypto'
import type { PersistenceProvider } from '@control-plane/deployment'
import {
  ContextCommandGrantSchema,
  type ContextCommandGrant,
  type ContextCommandGrantRepository,
} from '@control-plane/domain'

const namespace = 'context-command-grants'
const key = (workspaceId: string, authorizationRef: string) =>
  createHash('sha256')
    .update(JSON.stringify([workspaceId, authorizationRef]))
    .digest('hex')

export class SqliteContextCommandGrantRepository implements ContextCommandGrantRepository {
  constructor(readonly provider: PersistenceProvider) {}

  async create(input: ContextCommandGrant): Promise<void> {
    const grant = ContextCommandGrantSchema.parse(input)
    if (grant.status !== 'active') throw new Error('CONTEXT_GRANT_CREATE_INVALID')
    const id = key(grant.workspaceId, grant.authorizationRef)
    await this.provider.transaction(async (tx) => {
      if (await tx.get(namespace, id)) throw new Error('CONTEXT_GRANT_ALREADY_EXISTS')
      await tx.put({ namespace, id, value: grant })
    })
  }

  async get(
    workspaceId: string,
    authorizationRef: string
  ): Promise<ContextCommandGrant | undefined> {
    const stored = await this.provider.transaction((tx) =>
      tx.get(namespace, key(workspaceId, authorizationRef))
    )
    if (!stored) return undefined
    const grant = ContextCommandGrantSchema.parse(stored.value)
    if (grant.workspaceId !== workspaceId || grant.authorizationRef !== authorizationRef)
      throw new Error('CONTEXT_GRANT_SCOPE_MISMATCH')
    return grant
  }

  async revoke(workspaceId: string, authorizationRef: string): Promise<void> {
    const id = key(workspaceId, authorizationRef)
    await this.provider.transaction(async (tx) => {
      const stored = await tx.get(namespace, id)
      if (!stored) throw new Error('CONTEXT_GRANT_NOT_FOUND')
      const grant = ContextCommandGrantSchema.parse(stored.value)
      if (grant.workspaceId !== workspaceId || grant.authorizationRef !== authorizationRef)
        throw new Error('CONTEXT_GRANT_SCOPE_MISMATCH')
      if (grant.status === 'revoked') return
      await tx.put({
        namespace,
        id,
        expectedRevision: stored.revision,
        value: { ...grant, status: 'revoked' },
      })
    })
  }
}
