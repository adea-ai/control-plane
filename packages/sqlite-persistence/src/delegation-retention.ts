import type { RetentionClassId } from '@control-plane/config'
import type { PersistenceProvider, PersistenceTransaction } from '@control-plane/deployment'
import {
  childAdmissionNamespace,
  childMappingNamespace,
  childRuntimeLookupNamespace,
  childSessionNamespace,
  terminalReceiptNamespace,
} from './delegation-receipt-namespaces.js'
import { recordId } from './record-storage.js'

/**
 * Retention lifecycle of the child admission, mapping and terminal receipt
 * namespaces (#1022).
 *
 * These records are reference-governed evidence, not a retention class of their
 * own. They carry no age clock and no deletion path, so no retention duration
 * applies to them and none is introduced here. Each one pins the canonical
 * parent and child executions (and, for admission and lookup receipts, the
 * plans) it was written for: the `executions` and `execution-plans` classes
 * refuse to delete an owner while any of these rows still names it, whether or
 * not the `delegations` row is still present. Releasing them needs an owner
 * decision on which class governs their eventual deletion; until then they
 * outlive every sweep.
 *
 * Pending terminal publication intents and native-start lookup receipts are the
 * records the crash-repair paths read, so they are part of this set on purpose.
 */
export const delegationReceiptNamespaces = [
  childAdmissionNamespace,
  childMappingNamespace,
  childSessionNamespace,
  childRuntimeLookupNamespace,
  terminalReceiptNamespace,
] as const

type ReceiptNamespace = (typeof delegationReceiptNamespaces)[number]

/**
 * Existing retention class that governs each namespace's eventual deletion
 * (owner decision on #1022). Recording it adds no deletion path and no period:
 * `native-admission-fences` is unbounded, and `native-terminal-snapshots` only
 * becomes deletable once a path with settlement and reference proof is built
 * and registered in scripts/retention-classes.mjs.
 */
export const delegationReceiptRetentionClass: Readonly<Record<ReceiptNamespace, RetentionClassId>> =
  {
    [childAdmissionNamespace]: 'native-admission-fences',
    [childMappingNamespace]: 'native-admission-fences',
    [childSessionNamespace]: 'native-admission-fences',
    [childRuntimeLookupNamespace]: 'native-admission-fences',
    [terminalReceiptNamespace]: 'native-terminal-snapshots',
  }

export interface DelegationReceiptPins {
  readonly executionIds: ReadonlySet<string>
  readonly planIds: ReadonlySet<string>
}

type Path = readonly string[]

const executionPaths: Readonly<Record<ReceiptNamespace, readonly Path[]>> = {
  [childAdmissionNamespace]: [
    ['request', 'parentExecutionId'],
    ['request', 'childExecutionId'],
    ['receipt', 'parentExecutionId'],
    ['receipt', 'childExecutionId'],
  ],
  [childMappingNamespace]: [['parentExecutionId'], ['childExecutionId']],
  [childSessionNamespace]: [['parentExecutionId'], ['childExecutionId']],
  [childRuntimeLookupNamespace]: [
    ['parentExecutionId'],
    ['childExecutionId'],
    ['request', 'executionId'],
  ],
  [terminalReceiptNamespace]: [
    ['event', 'parentExecutionId'],
    ['event', 'childExecutionId'],
  ],
}

const planPaths: Readonly<Record<ReceiptNamespace, readonly Path[]>> = {
  [childAdmissionNamespace]: [
    ['request', 'parentPlan', 'executionPlanId'],
    ['request', 'childPlan', 'executionPlanId'],
  ],
  [childMappingNamespace]: [],
  [childSessionNamespace]: [],
  [childRuntimeLookupNamespace]: [['request', 'executionPlan', 'executionPlanId']],
  [terminalReceiptNamespace]: [],
}

function read(value: unknown, path: Path): string | undefined {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : undefined
}

/** Owners and plans a receipt row positively identifies; a damaged field pins nothing else. */
export function receiptOwnerPins(
  namespace: ReceiptNamespace,
  value: unknown
): DelegationReceiptPins {
  const executionIds = new Set<string>()
  const planIds = new Set<string>()
  for (const path of executionPaths[namespace]) {
    const executionId = read(value, path)
    if (executionId !== undefined) executionIds.add(executionId)
  }
  for (const path of planPaths[namespace]) {
    const planId = read(value, path)
    if (planId !== undefined) planIds.add(planId)
  }
  return { executionIds, planIds }
}

/**
 * Owner pin index. Each receipt writer records the executions and plans its row
 * names in the same transaction as the row, so a retention candidate costs one
 * exact-key read per owner instead of a scan of every retained receipt. The index
 * is append-only like the receipts it mirrors: nothing releases a pin.
 */
export const receiptOwnerPinNamespace = 'delegation-receipt-owner-pins'
const backfillMarker = 'backfill-complete'

const pinId = (kind: 'execution' | 'plan', identity: string) => recordId(`${kind}:${identity}`)

async function putPin(
  transaction: PersistenceTransaction,
  kind: 'execution' | 'plan',
  identity: string
): Promise<void> {
  const id = pinId(kind, identity)
  if ((await transaction.get(receiptOwnerPinNamespace, id)) === undefined)
    await transaction.put({ namespace: receiptOwnerPinNamespace, id, value: { kind, identity } })
}

/** Writers call this right after retaining a receipt row, in the same transaction. */
export async function retainReceiptOwnerPins(
  transaction: PersistenceTransaction,
  namespace: ReceiptNamespace,
  value: unknown
): Promise<void> {
  const pins = receiptOwnerPins(namespace, value)
  for (const executionId of pins.executionIds) await putPin(transaction, 'execution', executionId)
  for (const planId of pins.planIds) await putPin(transaction, 'plan', planId)
}

/**
 * Full scan of the receipt namespaces. Only the one-time index backfill and a
 * read-only assessment of a store that has not been backfilled use it; no
 * per-candidate path does.
 */
export async function readDelegationReceiptPins(
  transaction: PersistenceTransaction,
  from: readonly ReceiptNamespace[] = delegationReceiptNamespaces
): Promise<DelegationReceiptPins> {
  const executionIds = new Set<string>()
  const planIds = new Set<string>()
  for (const namespace of from)
    for (const row of await transaction.list(namespace)) {
      const pins = receiptOwnerPins(namespace, row.value)
      for (const executionId of pins.executionIds) executionIds.add(executionId)
      for (const planId of pins.planIds) planIds.add(planId)
    }
  return { executionIds, planIds }
}

export interface ReceiptOwnerPinReader {
  hasExecution(transaction: PersistenceTransaction, executionId: string): Promise<boolean>
  hasPlan(transaction: PersistenceTransaction, planId: string): Promise<boolean>
}

/**
 * Resolves the pin reader for one sweep. Rows written before the index existed
 * are indexed once, here, outside the candidate loop; a dry run writes nothing
 * and falls back to one read-only scan of the legacy rows. Either way every
 * candidate afterwards needs only exact-key reads inside its own transaction,
 * which also see pins written by receipt writers after this point.
 */
export async function prepareReceiptOwnerPins(
  provider: PersistenceProvider,
  options: { readonly dryRun: boolean }
): Promise<ReceiptOwnerPinReader> {
  const complete = (transaction: PersistenceTransaction) =>
    transaction.get(receiptOwnerPinNamespace, recordId(backfillMarker))
  let legacy: DelegationReceiptPins | undefined
  if ((await provider.transaction(complete)) === undefined) {
    if (options.dryRun) legacy = await provider.transaction(readDelegationReceiptPins)
    else
      await provider.transaction(async (transaction) => {
        if ((await complete(transaction)) !== undefined) return
        const pins = await readDelegationReceiptPins(transaction)
        for (const executionId of pins.executionIds)
          await putPin(transaction, 'execution', executionId)
        for (const planId of pins.planIds) await putPin(transaction, 'plan', planId)
        await transaction.put({
          namespace: receiptOwnerPinNamespace,
          id: recordId(backfillMarker),
          value: { backfilled: true },
        })
      })
  }
  const indexed = async (
    transaction: PersistenceTransaction,
    kind: 'execution' | 'plan',
    identity: string
  ) => (await transaction.get(receiptOwnerPinNamespace, pinId(kind, identity))) !== undefined
  return {
    async hasExecution(transaction, executionId) {
      return (
        legacy?.executionIds.has(executionId) === true ||
        (await indexed(transaction, 'execution', executionId))
      )
    },
    async hasPlan(transaction, planId) {
      return legacy?.planIds.has(planId) === true || (await indexed(transaction, 'plan', planId))
    },
  }
}
