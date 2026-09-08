import { createHash } from 'node:crypto'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'
import {
  InteractionRequestSchema,
  type InteractionRepository,
  type InteractionRequest,
} from '@control-plane/domain'

const namespace = 'interaction-requests'
const recordId = (id: string) => `r-${createHash('sha256').update(id).digest('hex')}`
const json = (value: InteractionRequest): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue

/** Mirrors PostgreSQL's immutable request fields and version-conditional response updates. */
export class SqliteInteractionRepository implements InteractionRepository {
  constructor(readonly provider: PersistenceProvider) {}

  async insert(input: InteractionRequest): Promise<boolean> {
    const request = InteractionRequestSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(request.interactionId)
      if (await transaction.get(namespace, id)) return false
      await transaction.put({ namespace, id, value: json(request) })
      return true
    })
  }

  async get(interactionId: string): Promise<InteractionRequest | undefined> {
    InteractionRequestSchema.shape.interactionId.parse(interactionId)
    return this.provider.transaction(async (transaction) => {
      const row = await transaction.get(namespace, recordId(interactionId))
      return row === undefined ? undefined : InteractionRequestSchema.parse(row.value)
    })
  }

  async compareAndSet(expectedVersion: number, input: InteractionRequest): Promise<boolean> {
    const request = InteractionRequestSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(request.interactionId)
      const row = await transaction.get(namespace, id)
      if (row === undefined) return false
      const current = InteractionRequestSchema.parse(row.value)
      if (current.version !== expectedVersion) return false
      const updated = InteractionRequestSchema.parse({
        ...current,
        state: request.state,
        version: request.version,
        response: request.response,
        resolvedAt: request.resolvedAt,
      })
      await transaction.put({ namespace, id, expectedRevision: row.revision, value: json(updated) })
      return true
    })
  }
}
