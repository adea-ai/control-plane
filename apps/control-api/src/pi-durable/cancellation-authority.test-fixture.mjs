import { randomUUID } from 'node:crypto'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'

export function createMemoryCommittedCancellationAuthority({
  now = () => new Date().toISOString(),
} = {}) {
  const records = new Map()
  const acknowledged = new Set()
  let version = 0
  return {
    async commit(proposal) {
      const key = `${proposal.handleId}\u0000${proposal.idempotencyKey}`
      const existing = records.get(key)
      if (existing) {
        if (existing.requestDigest !== proposal.requestDigest)
          throw new RuntimeAdapterError({
            code: 'PI_CANCELLATION_INTENT_CONFLICT',
            classification: 'conflict',
            message: 'PI_CANCELLATION_INTENT_CONFLICT',
            retryable: false,
          })
        return structuredClone(existing)
      }
      const intent = {
        schemaVersion: 'pi-committed-cancellation/v1',
        intentId: randomUUID(),
        committedAuthorityVersion: ++version,
        committedAt: now(),
        ...structuredClone(proposal),
      }
      records.set(key, intent)
      return structuredClone(intent)
    },
    async pendingHandles() {
      return [
        ...new Set(
          [...records.values()]
            .filter((intent) => !acknowledged.has(intent.intentId))
            .map((intent) => intent.handleId)
        ),
      ]
    },
    async pendingForHandle(handleId) {
      return [...records.values()]
        .filter((intent) => intent.handleId === handleId && !acknowledged.has(intent.intentId))
        .map((intent) => structuredClone(intent))
    },
    async pending() {
      return [...records.values()]
        .filter((intent) => !acknowledged.has(intent.intentId))
        .map((intent) => structuredClone(intent))
    },
    async acknowledge(intentId) {
      acknowledged.add(intentId)
    },
    intentForHandle(handleId, idempotencyKey) {
      const matches = [...records.values()].filter(
        (intent) =>
          intent.handleId === handleId &&
          (idempotencyKey === undefined || intent.idempotencyKey === idempotencyKey)
      )
      const intent = matches.at(-1)
      return intent ? structuredClone(intent) : undefined
    },
  }
}
