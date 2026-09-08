import { createHash } from 'node:crypto'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import {
  InteractionRequestSchema,
  type InteractionRepository,
  type InteractionRequest,
} from '@control-plane/domain'

const namespace = 'interaction-requests'
const recordId = (id: string) => `r-${createHash('sha256').update(id).digest('hex')}`
const attemptNamespace = (executionId: string, attemptId: string) =>
  `interaction-attempt-${createHash('sha256')
    .update(JSON.stringify([executionId, attemptId]))
    .digest('hex')}`
const indexNamespace = 'interaction-index-migrations'
const indexVersion = 'attempt-v1'
const json = (value: InteractionRequest): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue

/** Mirrors PostgreSQL's immutable request fields and version-conditional response updates. */
export class SqliteInteractionRepository implements InteractionRepository {
  constructor(readonly provider: PersistenceProvider) {}

  async insert(input: InteractionRequest): Promise<boolean> {
    const request = InteractionRequestSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      await this.#ensureAttemptIndex(transaction)
      const id = recordId(request.interactionId)
      if (await transaction.get(namespace, id)) return false
      await transaction.put({ namespace, id, value: json(request) })
      await this.#index(transaction, request)
      return true
    })
  }

  /** Includes resolved history; callers must recheck state when resolving a request. */
  async listForAttempt(executionId: string, attemptId: string): Promise<InteractionRequest[]> {
    InteractionRequestSchema.shape.executionId.parse(executionId)
    InteractionRequestSchema.shape.attemptId.parse(attemptId)
    return this.provider.transaction(async (transaction) => {
      await this.#ensureAttemptIndex(transaction)
      const pointers = await transaction.list(attemptNamespace(executionId, attemptId))
      const requests: InteractionRequest[] = []
      for (const pointer of pointers) {
        const row = await transaction.get(namespace, pointer.id)
        if (!row) throw new Error('SQLITE_INTERACTION_INDEX_INCONSISTENT')
        const request = InteractionRequestSchema.parse(row.value)
        if (request.executionId !== executionId || request.attemptId !== attemptId)
          throw new Error('SQLITE_INTERACTION_INDEX_INCONSISTENT')
        requests.push(request)
      }
      return requests
    })
  }

  async #index(transaction: PersistenceTransaction, request: InteractionRequest): Promise<void> {
    await transaction.put({
      namespace: attemptNamespace(request.executionId, request.attemptId),
      id: recordId(request.interactionId),
      value: { interactionId: request.interactionId },
    })
  }

  async #ensureAttemptIndex(transaction: PersistenceTransaction): Promise<void> {
    if (await transaction.get(indexNamespace, indexVersion)) return
    // Backfill pre-index databases once, atomically with the completion marker.
    for (const row of await transaction.list(namespace))
      await this.#index(transaction, InteractionRequestSchema.parse(row.value))
    await transaction.put({ namespace: indexNamespace, id: indexVersion, value: { version: 1 } })
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
