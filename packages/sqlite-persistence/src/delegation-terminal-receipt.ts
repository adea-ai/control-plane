import { canonicalJsonStringify } from '@control-plane/contracts'
import type { PersistenceTransaction } from '@control-plane/deployment'
import {
  DelegationEventSchema,
  type DelegationEvent,
  type DelegationRecord,
} from '@control-plane/orchestration'
import { terminalReceiptNamespace } from './delegation-receipt-namespaces.js'
import { retainReceiptOwnerPins } from './delegation-retention.js'
import { json, recordId } from './record-storage.js'

export { terminalReceiptNamespace }
export interface DelegationTerminalReceipt {
  readonly idempotencyKey: string
  readonly status: 'pending' | 'published'
  readonly event: DelegationEvent
}

export function terminalReceipt(record: DelegationRecord): DelegationTerminalReceipt | undefined {
  const publication = record.terminalPublication
  if (!publication) return undefined
  const event = DelegationEventSchema.parse({
    type:
      record.state === 'completed'
        ? 'delegation.completed'
        : record.state === 'cancelled'
          ? 'delegation.cancelled'
          : 'delegation.failed',
    delegationId: record.delegationId,
    parentExecutionId: record.parentExecutionId,
    childExecutionId: record.childExecutionId,
    occurredAt: record.updatedAt,
    details: {
      state: record.state,
      ...(record.childAttemptId ? { childAttemptId: record.childAttemptId } : {}),
      ...(publication.resolution ? { resolution: publication.resolution } : {}),
      ...(record.terminalResultRef ? { terminalResultRef: record.terminalResultRef } : {}),
      ...(record.terminalConclusion ? { conclusion: record.terminalConclusion } : {}),
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
      ...(publication.reason ? { reason: publication.reason } : {}),
    },
  })
  return { idempotencyKey: publication.idempotencyKey, status: publication.status, event }
}

/** The record CAS and complete publication payload commit in the caller's transaction. */
export async function retainTerminalReceipt(
  tx: PersistenceTransaction,
  current: DelegationRecord,
  next: DelegationRecord
): Promise<void> {
  const receipt = terminalReceipt(next)
  const prior = terminalReceipt(current)
  if (
    prior &&
    (!receipt ||
      !sameOutcome(prior, receipt) ||
      (prior.status === 'published' && receipt.status !== 'published'))
  )
    throw new Error('DELEGATION_TERMINAL_RECEIPT_CONFLICT')
  if (!receipt) return
  if (!prior && receipt.status !== 'pending')
    throw new Error('DELEGATION_TERMINAL_RECEIPT_CONFLICT')
  const id = recordId(next.delegationId)
  const existing = await tx.get(terminalReceiptNamespace, id)
  if (existing && canonicalJsonStringify(existing.value) !== canonicalJsonStringify(prior))
    throw new Error('DELEGATION_TERMINAL_RECEIPT_CONFLICT')
  await tx.put({
    namespace: terminalReceiptNamespace,
    id,
    ...(existing ? { expectedRevision: existing.revision } : {}),
    value: json(receipt),
  })
  await retainReceiptOwnerPins(tx, terminalReceiptNamespace, receipt)
}

function sameOutcome(left: DelegationTerminalReceipt, right: DelegationTerminalReceipt): boolean {
  return (
    canonicalJsonStringify({ ...left, status: undefined }) ===
    canonicalJsonStringify({ ...right, status: undefined })
  )
}
