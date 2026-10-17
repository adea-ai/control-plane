import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  ChildUsageLedger,
  type ChildUsageLedgerSnapshot,
  type CanonicalDelegationAdmission,
} from '@control-plane/orchestration'

/** The durable home of one delegation's child cost-state projection. */
export interface ChildUsageOutcomeStore {
  load(): Promise<
    { readonly revision: number; readonly snapshot: ChildUsageLedgerSnapshot } | undefined
  >
  save(record: {
    readonly revision: number
    readonly snapshot: ChildUsageLedgerSnapshot
  }): Promise<unknown>
}

/** The store for one delegation. The same factory serves the bridge and the terminal settlement. */
export type ChildUsageOutcomesFor = (delegationId: string) => ChildUsageOutcomeStore

export interface ChildUsageIdentity {
  readonly parentExecutionId: string
  readonly delegationId: string
  readonly childExecutionId: string
  readonly childAttemptId: string
}

export function childUsageIdentity(
  admission: Pick<CanonicalDelegationAdmission, 'identity' | 'record'>
): ChildUsageIdentity {
  return {
    parentExecutionId: admission.identity.parentExecutionId,
    delegationId: admission.identity.delegationId,
    childExecutionId: admission.record.childExecutionId,
    childAttemptId: admission.identity.childAttemptId,
  }
}

/**
 * The cost-state projection is never held in memory between steps: each step loads the durable
 * snapshot, applies its evidence and saves a newer revision only when something changed. A restart
 * therefore resumes from exactly what was recorded.
 */
export async function mutateChildUsage<T>(
  store: ChildUsageOutcomeStore,
  apply: (usage: ChildUsageLedger) => T
): Promise<T> {
  const stored = await store.load()
  const usage = new ChildUsageLedger()
  if (stored) usage.restore(stored.snapshot)
  const result = apply(usage)
  const snapshot = usage.snapshot()
  if (!stored || canonicalJsonStringify(stored.snapshot) !== canonicalJsonStringify(snapshot))
    await store.save({ revision: (stored?.revision ?? 0) + 1, snapshot })
  return result
}

/** The retained cost state for one child attempt, read without recording anything. */
export async function readChildUsage(store: ChildUsageOutcomeStore, identity: ChildUsageIdentity) {
  const stored = await store.load()
  const usage = new ChildUsageLedger()
  if (stored) usage.restore(stored.snapshot)
  return usage.status(identity)
}
