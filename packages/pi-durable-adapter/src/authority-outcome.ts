import { RuntimeAdapterError } from '@control-plane/runtime-sdk'

/** Classification of a failed authority check. Only `denied` may persist a revocation. */
export type AuthorityOutcome = 'denied' | 'unavailable' | 'unclassified'

// Module-private registry. Only code in this package records an outcome, so caller-controlled
// messages, names, and properties can never establish an authoritative denial.
const recorded = new WeakMap<object, 'denied' | 'unavailable'>()

/** Records an explicit local policy decision. Call only where that decision is made. */
export function authoritativeDenial<T extends Error>(error: T): T {
  recorded.set(error, 'denied')
  return error
}

/** Records a port, transport, or availability failure: retryable, never a revocation. */
export function transientAuthorityFailure<T extends Error>(error: T): T {
  recorded.set(error, 'unavailable')
  return error
}

/** Classifies a thrown value. Anything neither recorded nor typed unavailable is unclassified. */
export function authorityOutcome(error: unknown): AuthorityOutcome {
  if (typeof error !== 'object' || error === null) return 'unclassified'
  const outcome = recorded.get(error)
  if (outcome) return outcome
  return error instanceof RuntimeAdapterError && error.classification === 'unavailable'
    ? 'unavailable'
    : 'unclassified'
}
