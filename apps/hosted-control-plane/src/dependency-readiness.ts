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
 * Live dependency readiness: manifest components plus a bounded database probe.
 * Static manifest state alone reported ready while PostgreSQL was unreachable.
 *
 * The manifest and the probe share one bounded budget. The manifest used to be
 * awaited without a bound, so a manifest that never settled could hang the
 * readiness endpoint, and a bounded manifest plus a bounded probe could add up
 * to more than the caller allowed. The budget is fail-closed: when it expires,
 * or when a step fails, the readiness is not ready.
 */
export async function hostedDependencyReadiness(
  composition: HostedDependencySurface,
  options: DependencyReadinessOptions = {}
): Promise<boolean> {
  const outcome = await evaluateWithinReadinessBudget(async (budget) => {
    // The manifest is inside the budget: an unbounded manifest can neither
    // hang the readiness endpoint nor silently pass it.
    const manifest = await composition.manifest()
    if (!manifest.components.every((component) => component.ready)) return false
    // The probe shares what is left of the budget.
    return databaseReadinessProbe(composition.connection, budget.remainingMs())
  }, options.readinessTimeoutMs ?? DEFAULT_DATABASE_TIMEOUT_MS)
  return outcome.completed ? outcome.value : false
}
