import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import type { PersistenceProvider } from '@control-plane/deployment'
import {
  DelegationEventSchema,
  type DelegationEvent,
  type DelegationEventPublisher,
} from '@control-plane/orchestration'
import { json, recordId } from './record-storage.js'

const namespace = 'delegation-publications'

/** A durable parent inbox. Authorized product timeline delivery is a separate consumer. */
export class SqliteDelegationEventPublisher implements DelegationEventPublisher {
  readonly #parentExecutionId: string

  constructor(
    readonly provider: Pick<PersistenceProvider, 'transaction'>,
    parentExecutionId: string
  ) {
    this.#parentExecutionId = IdentifierSchemas.executionId.parse(parentExecutionId)
  }

  async publish(input: DelegationEvent, idempotencyKey: string): Promise<void> {
    const event = DelegationEventSchema.parse(input)
    if (
      event.parentExecutionId !== this.#parentExecutionId ||
      idempotencyKey.length > 256 ||
      !/^delegation:dlg_[A-Za-z0-9]+:[A-Za-z0-9.:_-]+$/.test(idempotencyKey) ||
      !idempotencyKey.startsWith(`delegation:${event.delegationId}:`)
    ) {
      throw new Error('DELEGATION_PUBLICATION_SCOPE_MISMATCH')
    }
    const id = recordId(canonicalJsonStringify([this.#parentExecutionId, idempotencyKey]))
    await this.provider.transaction(async (transaction) => {
      const existing = await transaction.get(namespace, id)
      if (existing) {
        if (
          canonicalJsonStringify(existing.value) !==
          canonicalJsonStringify({ idempotencyKey, event })
        ) {
          throw new Error('DELEGATION_PUBLICATION_CONFLICT')
        }
        return
      }
      await transaction.put({ namespace, id, value: json({ idempotencyKey, event }) })
    })
  }

  async list(): Promise<readonly DelegationEvent[]> {
    return this.provider.transaction(async (transaction) => {
      const records = await transaction.list(namespace)
      return records.flatMap((record) => {
        const receipt = asRecord(record.value)
        const candidate = asRecord(receipt?.['event'])
        // Filter by the stored owner before validation so another parent's
        // malformed legacy row cannot poison this inbox's read.
        if (candidate?.['parentExecutionId'] !== this.#parentExecutionId) return []
        const parsed = DelegationEventSchema.safeParse(candidate)
        // Older awaiting-input rows lack authenticated interaction context.
        // Reject only that row and continue replaying valid publications.
        return parsed.success ? [parsed.data] : []
      })
    })
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
