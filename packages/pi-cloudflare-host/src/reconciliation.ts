import { RuntimeExecutionResultSchema, RuntimeUsageSchema } from '@control-plane/runtime-sdk'
import type { RuntimeExecutionResult, RuntimeUsage } from '@control-plane/runtime-sdk'
import type { CloudflareAcceptedTask, CloudflareOwnerPins, CloudflareTaskRecord } from './owner.js'
import { stableJson } from './owner.js'

/** Returned only by a trusted broker/ledger reader, never supplied by a caller or model. */
export interface CloudflareSettlementReceipt {
  readonly schemaVersion: 1
  readonly receiptRef: string
  readonly task: CloudflareAcceptedTask
  readonly owner: CloudflareOwnerPins
  readonly recoveryEpoch: number
  readonly disposition: 'completed' | 'cancelled'
  readonly result?: RuntimeExecutionResult
  readonly terminalUsage?: RuntimeUsage
}

export interface CloudflareReconciliationAuthority {
  /** Read-only: reconcile prior dispatch/usage; this port must never dispatch or authorize a retry. */
  readSettlement(
    task: CloudflareAcceptedTask,
    owner: CloudflareOwnerPins,
    recoveryEpoch: number
  ): Promise<CloudflareSettlementReceipt | undefined>
}

export function assertSettlementReceipt(
  receipt: CloudflareSettlementReceipt,
  record: CloudflareTaskRecord,
  owner: CloudflareOwnerPins,
  epoch: number
): void {
  const keys = [
    'schemaVersion',
    'receiptRef',
    'task',
    'owner',
    'recoveryEpoch',
    'disposition',
    'result',
    'terminalUsage',
  ]
  if (
    Object.keys(receipt).some((key) => !keys.includes(key)) ||
    receipt.schemaVersion !== 1 ||
    typeof receipt.receiptRef !== 'string' ||
    !receipt.receiptRef.length ||
    receipt.receiptRef.length > 256 ||
    receipt.recoveryEpoch !== epoch ||
    stableJson(receipt.task) !== stableJson(record.task) ||
    stableJson(receipt.owner) !== stableJson(owner) ||
    !['completed', 'cancelled'].includes(receipt.disposition) ||
    (receipt.disposition === 'completed') !== (receipt.result !== undefined) ||
    (receipt.disposition === 'cancelled') !== (receipt.terminalUsage !== undefined)
  )
    throw new Error('CLOUDFLARE_SETTLEMENT_IDENTITY_DENIED')
  if (receipt.result !== undefined) RuntimeExecutionResultSchema.parse(receipt.result)
  if (receipt.terminalUsage !== undefined) RuntimeUsageSchema.parse(receipt.terminalUsage)
  if (
    record.observedResult &&
    stableJson(record.observedResult.usage) !==
      stableJson(receipt.result?.usage ?? receipt.terminalUsage)
  )
    throw new Error('CLOUDFLARE_SETTLEMENT_USAGE_CONFLICT')
  if (
    record.observedResult &&
    receipt.result &&
    stableJson(record.observedResult) !== stableJson(receipt.result)
  )
    throw new Error('CLOUDFLARE_SETTLEMENT_RESULT_CONFLICT')
}
