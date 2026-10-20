import {
  databaseReadinessProbe,
  defaultReadinessBudgetMs,
  evaluateWithinReadinessBudget,
  type PostgresConnection,
} from '@control-plane/database'

export interface DependencyReadinessOptions {
  /**
   * Upper bound for the whole readiness evaluation, so /ready answers within
   * health-check budgets. The manifest and the database probe share it.
   */
  readonly readinessTimeoutMs?: number
}

const DEFAULT_DATABASE_TIMEOUT_MS = defaultReadinessBudgetMs

export interface HostedDependencySurface {
  manifest(): Promise<{ components: ReadonlyArray<{ ready: boolean }> }>
  readonly connection: PostgresConnection
}

/**
 * The readiness evaluations in flight per owned surface. A surface owns one
 * connection, so it may have one probe in flight: a repeated call must not
 * start a second manifest or check while the first is unresolved, or the
 * unresolved work accumulates.
 */
const inFlightReadiness = new WeakMap<HostedDependencySurface, number>()

/**
 * Live dependency readiness: manifest components plus a bounded database probe.
 * Static manifest state alone reported ready while PostgreSQL was unreachable.
 *
 * The manifest and the probe share one bounded budget. The manifest used to be
 * awaited without a bound, so a manifest that never settled could hang the
 * readiness endpoint, and a bounded manifest plus a bounded probe could add up
 * to more than the caller allowed. The budget is fail-closed: when it expires,
 * or when a step fails, the readiness is not ready.
 *
 * The single-flight ownership is held until the underlying work settles, not
 * until the response budget expires. The probe's promise settles when its own
 * timeout expires, while the raw `connection.check` promise it started may
 * still be pending, so the raw check is owned for as long as it is pending: a
 * check that never settles keeps the surface single-flight, so a later call
 * starts no work and fails closed.
 */
export async function hostedDependencyReadiness(
  composition: HostedDependencySurface,
  options: DependencyReadinessOptions = {}
): Promise<boolean> {
  const inFlight = inFlightReadiness.get(composition) ?? 0
  if (inFlight > 0) {
    // One readiness evaluation at a time per owned surface. A repeated call
    // starts no work.
    return false
  }
  inFlightReadiness.set(composition, inFlight + 1)
  let released = false
  let evaluationSettled = false
  let pendingRawWork = 0
  const release = () => {
    if (released) return
    // The ownership is held until the evaluation settled and every raw
    // promise it started has settled.
    if (!evaluationSettled || pendingRawWork > 0) return
    released = true
    const current = inFlightReadiness.get(composition) ?? 1
    if (current <= 1) inFlightReadiness.delete(composition)
    else inFlightReadiness.set(composition, current - 1)
  }
  const ownRawWork = (work: Promise<unknown>) => {
    pendingRawWork += 1
    void work.then(
      () => {
        pendingRawWork -= 1
        release()
      },
      () => {
        pendingRawWork -= 1
        release()
      }
    )
  }
  let started = false
  try {
    const outcome = await evaluateWithinReadinessBudget(
      async (budget) => {
        // The manifest is inside the budget: an unbounded manifest can neither
        // hang the readiness endpoint nor silently pass it.
        const manifest = await composition.manifest()
        // A manifest that arrives after the budget expired must not start
        // another probe.
        if (budget.expired()) return false
        if (!manifest.components.every((component) => component.ready)) return false
        // The probe shares what is left of the budget. The raw check it starts
        // is owned until that check settles.
        return databaseReadinessProbe(composition.connection, budget.remainingMs(), ownRawWork)
      },
      options.readinessTimeoutMs ?? DEFAULT_DATABASE_TIMEOUT_MS,
      (work) => {
        started = true
        // The evaluation settles when its steps settle. The ownership is
        // released then only if no raw promise is still pending.
        void work.then(
          () => {
            evaluationSettled = true
            release()
          },
          () => {
            evaluationSettled = true
            release()
          }
        )
      }
    )
    return outcome.completed ? outcome.value : false
  } finally {
    // The work never began, so nothing owns it.
    if (!started) {
      evaluationSettled = true
      release()
    }
  }
}
