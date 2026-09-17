import { databaseReadinessProbe, type PostgresConnection } from '@control-plane/database'

export interface DependencyReadinessOptions {
  /** Upper bound for the database probe so /ready answers within health-check budgets. */
  readonly databaseTimeoutMs?: number
}

const DEFAULT_DATABASE_TIMEOUT_MS = 3000

export interface HostedDependencySurface {
  manifest(): Promise<{ components: ReadonlyArray<{ ready: boolean }> }>
  readonly connection: PostgresConnection
}

/**
 * Live dependency readiness: manifest components plus a bounded database probe.
 * Static manifest state alone reported ready while PostgreSQL was unreachable.
 */
export async function hostedDependencyReadiness(
  composition: HostedDependencySurface,
  options: DependencyReadinessOptions = {}
): Promise<boolean> {
  const manifest = await composition.manifest()
  if (!manifest.components.every((component) => component.ready)) return false
  return databaseReadinessProbe(
    composition.connection,
    options.databaseTimeoutMs ?? DEFAULT_DATABASE_TIMEOUT_MS
  )
}
