export interface IsolatedDatabaseCleanupActions {
  readonly closeApplication: () => Promise<void>
  readonly terminateSessions: () => Promise<void>
  readonly dropDatabase: () => Promise<void>
  readonly closeAdministration: () => Promise<void>
}

export function ownedClientBackendTerminationStatement(databaseName: string) {
  return {
    text: `
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = $1
        and backend_type = 'client backend'
        and pid <> pg_backend_pid()
    `,
    parameters: [databaseName] as const,
  }
}

/** The disposer must already be bound before any database creation is attempted. */
export async function completeIsolatedDatabaseSetup<Result>(
  initialize: () => Promise<Result>,
  dispose: () => Promise<void>
): Promise<Result> {
  try {
    return await initialize()
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      const setupError = new AggregateError(
        [error, cleanupError],
        'ISOLATED_TEST_DATABASE_SETUP_FAILED',
        { cause: error }
      )
      throw setupError
    }
    throw error
  }
}

/** Test-fixture disposal only; each action is already bound to its owned database. */
export function createIsolatedDatabaseDisposer(
  actions: IsolatedDatabaseCleanupActions
): () => Promise<void> {
  let disposal: Promise<void> | undefined
  return () => {
    // Cache failure as well as success: repeated disposal must not hide a
    // possibly surviving database. Recovery needs explicit resource inspection.
    disposal ??= Promise.resolve().then(async () => {
      const errors: unknown[] = []
      for (const operation of [
        actions.closeApplication,
        actions.terminateSessions,
        actions.dropDatabase,
        actions.closeAdministration,
      ]) {
        try {
          await operation()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0)
        throw new AggregateError(errors, 'ISOLATED_TEST_DATABASE_DISPOSAL_FAILED')
    })
    return disposal
  }
}
