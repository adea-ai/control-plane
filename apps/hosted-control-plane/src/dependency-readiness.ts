import type { PostgresConnection } from '@control-plane/database'

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
  return databaseReady(
    composition.connection,
    options.databaseTimeoutMs ?? DEFAULT_DATABASE_TIMEOUT_MS
  )
}

async function databaseReady(connection: PostgresConnection, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      connection.check().then(
        () => true,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
