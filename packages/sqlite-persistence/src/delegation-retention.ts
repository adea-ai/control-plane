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
 * names in the same transaction as the row, together with the namespace that
 * named them, so a retention candidate costs one exact-key read per owner
 * instead of a scan of every retained receipt. The index is append-only like the
 * receipts it mirrors: nothing releases a pin.
 */
export const receiptOwnerPinNamespace = 'delegation-receipt-owner-pins'
/** Rows read by one backfill transaction. */
export const RECEIPT_PIN_BACKFILL_PAGE = 64
/**
 * Most records one backfill transaction can write: every row naming the largest
 * number of distinct owners and plans its namespace can carry (a damaged legacy
 * admission row can name four executions and two plans), plus the cursor. A
 * well-formed admission row names two executions and two plans, so a full page
 * of those writes 257.
 */
export const RECEIPT_PIN_BACKFILL_MAX_WRITES =
  RECEIPT_PIN_BACKFILL_PAGE *
    Math.max(
      ...delegationReceiptNamespaces.map(
        (namespace) => executionPaths[namespace].length + planPaths[namespace].length
      )
    ) +
  1
const backfillStateId = recordId('backfill-state')

const pinId = (kind: 'execution' | 'plan', identity: string) => recordId(`${kind}:${identity}`)

async function putPin(
  transaction: PersistenceTransaction,
  kind: 'execution' | 'plan',
  identity: string,
  source: ReceiptNamespace
): Promise<void> {
  const id = pinId(kind, identity)
  const existing = await transaction.get(receiptOwnerPinNamespace, id)
  const sources = (existing?.value as { sources?: readonly string[] } | undefined)?.sources ?? []
  if (existing !== undefined && sources.includes(source)) return
  await transaction.put({
    namespace: receiptOwnerPinNamespace,
    id,
    ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
    value: { kind, identity, sources: [...sources, source].toSorted() },
  })
}

/** Writers call this right after retaining a receipt row, in the same transaction. */
export async function retainReceiptOwnerPins(
  transaction: PersistenceTransaction,
  namespace: ReceiptNamespace,
  value: unknown
): Promise<void> {
  const pins = receiptOwnerPins(namespace, value)
  for (const executionId of pins.executionIds)
    await putPin(transaction, 'execution', executionId, namespace)
  for (const planId of pins.planIds) await putPin(transaction, 'plan', planId, namespace)
}

/**
 * Full scan of the receipt namespaces in one transaction. Only tests use it, as
 * the oracle the index is compared with; sweeps page instead.
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

interface BackfillState {
  readonly complete: boolean
  readonly namespace: number
  readonly afterId?: string
}

/**
 * Indexes one page of rows retained before the index existed. The cursor is
 * persisted with the page, so a crash resumes where it stopped and no
 * transaction holds the write lock for more than one page.
 */
async function backfillOnePage(provider: PersistenceProvider): Promise<boolean> {
  return provider.transaction(async (transaction) => {
    const row = await transaction.get(receiptOwnerPinNamespace, backfillStateId)
    const state: BackfillState = (row?.value as BackfillState | undefined) ?? {
      complete: false,
      namespace: 0,
    }
    if (state.complete) return true
    const namespace = delegationReceiptNamespaces[state.namespace]!
    const page = await transaction.scan(namespace, {
      limit: RECEIPT_PIN_BACKFILL_PAGE,
      ...(state.afterId === undefined ? {} : { afterId: state.afterId }),
    })
    for (const record of page) {
      const pins = receiptOwnerPins(namespace, record.value)
      for (const executionId of pins.executionIds)
        await putPin(transaction, 'execution', executionId, namespace)
      for (const planId of pins.planIds) await putPin(transaction, 'plan', planId, namespace)
    }
    const namespaceDone = page.length < RECEIPT_PIN_BACKFILL_PAGE
    const next: BackfillState = namespaceDone
      ? {
          complete: state.namespace + 1 >= delegationReceiptNamespaces.length,
          namespace: state.namespace + 1,
        }
      : { complete: false, namespace: state.namespace, afterId: page.at(-1)!.id }
    await transaction.put({
      namespace: receiptOwnerPinNamespace,
      id: backfillStateId,
      ...(row === undefined ? {} : { expectedRevision: row.revision }),
      value: { ...next },
    })
    return next.complete
  })
}

/**
 * Paged scan for a dry run over a store that has not been backfilled. It writes
 * nothing, but every SQLite provider transaction begins as BEGIN IMMEDIATE, so
 * each page still takes the write lock for the length of one bounded page.
 */
async function scanLegacyPins(provider: PersistenceProvider): Promise<DelegationReceiptPins> {
  const executionIds = new Set<string>()
  const planIds = new Set<string>()
  for (const namespace of delegationReceiptNamespaces) {
    let afterId: string | undefined
    for (;;) {
      const page = await provider.transaction((transaction) =>
        transaction.scan(namespace, {
          limit: RECEIPT_PIN_BACKFILL_PAGE,
          ...(afterId === undefined ? {} : { afterId }),
        })
      )
      for (const record of page) {
        const pins = receiptOwnerPins(namespace, record.value)
        for (const executionId of pins.executionIds) executionIds.add(executionId)
        for (const planId of pins.planIds) planIds.add(planId)
      }
      if (page.length < RECEIPT_PIN_BACKFILL_PAGE) break
      afterId = page.at(-1)!.id
    }
  }
  return { executionIds, planIds }
}

export interface ReceiptOwnerPinReader {
  hasExecution(transaction: PersistenceTransaction, executionId: string): Promise<boolean>
  hasPlan(transaction: PersistenceTransaction, planId: string): Promise<boolean>
}

/**
 * Resolves the pin reader for one sweep. Rows written before the index existed
 * are indexed here, outside the candidate loop, one bounded page per
 * transaction; a dry run writes nothing and reads them in bounded pages
 * instead. Either way every candidate afterwards needs only exact-key reads
 * inside its own transaction, which also see pins written by receipt writers
 * after this point.
 */
export async function prepareReceiptOwnerPins(
  provider: PersistenceProvider,
  options: { readonly dryRun: boolean }
): Promise<ReceiptOwnerPinReader> {
  let legacy: DelegationReceiptPins | undefined
  const state = await provider.transaction((transaction) =>
    transaction.get(receiptOwnerPinNamespace, backfillStateId)
  )
  if ((state?.value as BackfillState | undefined)?.complete !== true) {
    if (options.dryRun) legacy = await scanLegacyPins(provider)
    else while (!(await backfillOnePage(provider)));
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
