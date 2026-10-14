import type { PersistenceTransaction } from '@control-plane/deployment'
import {
  childAdmissionNamespace,
  childMappingNamespace,
  childRuntimeLookupNamespace,
  childSessionNamespace,
} from './delegation-child-mapping.js'
import { terminalReceiptNamespace } from './delegation-terminal-receipt.js'

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

export interface DelegationReceiptPins {
  readonly executionIds: ReadonlySet<string>
  readonly planIds: ReadonlySet<string>
}

type Path = readonly string[]

const executionPaths: Readonly<
  Record<(typeof delegationReceiptNamespaces)[number], readonly Path[]>
> = {
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

const planPaths: Readonly<Record<(typeof delegationReceiptNamespaces)[number], readonly Path[]>> = {
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

/**
 * Fresh read of every execution and plan the receipt namespaces still name, in
 * the caller's transaction. Like the neighbouring `delegations` check it pins on
 * positively identified owners, so a damaged field cannot widen or narrow what
 * another field still pins.
 */
export async function readDelegationReceiptPins(
  transaction: PersistenceTransaction,
  from: readonly (typeof delegationReceiptNamespaces)[number][] = delegationReceiptNamespaces
): Promise<DelegationReceiptPins> {
  const executionIds = new Set<string>()
  const planIds = new Set<string>()
  for (const namespace of from) {
    for (const row of await transaction.list(namespace)) {
      for (const path of executionPaths[namespace]) {
        const executionId = read(row.value, path)
        if (executionId !== undefined) executionIds.add(executionId)
      }
      for (const path of planPaths[namespace]) {
        const planId = read(row.value, path)
        if (planId !== undefined) planIds.add(planId)
      }
    }
  }
  return { executionIds, planIds }
}
