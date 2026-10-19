import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// Bundle the real wrapper with private, synthetic dependency modules. Unlike
// mock.module, these stubs cannot replace database modules in other test files.
const built = await Bun.build({
  entrypoints: ['postgres-fixture-test'],
  target: 'bun',
  write: false,
  plugins: [
    {
      name: 'isolated-postgres-fixture',
      setup(build) {
        build.onResolve({ filter: /^postgres-fixture-test$/ }, () => ({
          path: 'entry',
          namespace: 'fixture',
        }))
        build.onResolve({ filter: /^@control-plane\/(config|database\/testing)$/ }, ({ path }) => ({
          path,
          namespace: 'fixture',
        }))
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          loader: 'js',
          contents:
            path === 'entry'
              ? `export * from ${JSON.stringify(fileURLToPath(new URL('./postgres.ts', import.meta.url)))};
             export { configure } from '@control-plane/database/testing';`
              : path === '@control-plane/config'
                ? 'export const loadDatabaseCredentials = (_environment, role) => ({ role, url: "synthetic-unused" });'
                : `let factory;
               export const configure = (value) => { factory = value; };
               export const createIsolatedTestDatabase = (credentials) => factory(credentials);`,
        }))
      },
    },
  ],
})
if (!built.success) throw new AggregateError(built.logs, 'Fixture test bundle failed')
const { configure, createIsolatedPostgres, withIsolatedPostgres } = await import(
  `data:text/javascript;base64,${Buffer.from(await built.outputs[0].text()).toString('base64')}`
)

function fixture({ migrationError, cleanupError, creationError } = {}) {
  const calls = []
  const database = {
    async migrate() {
      calls.push('migrate')
      if (migrationError) throw migrationError
    },
    async dispose() {
      calls.push('dispose')
      if (cleanupError) throw cleanupError
    },
  }
  configure(async () => {
    if (creationError) throw creationError
    return database
  })
  return { calls, database }
}

test('disposes after automatic migration fails without invoking the operation', async () => {
  const error = new Error('migration failed')
  const { calls } = fixture({ migrationError: error })
  await expect(
    withIsolatedPostgres(() => calls.push('operation'), { environment: {} })
  ).rejects.toBe(error)
  expect(calls).toEqual(['migrate', 'dispose'])
})

test('retains migration and disposal errors with the migration as cause', async () => {
  const migrationError = new Error('migration failed')
  const cleanupError = new Error('disposal failed')
  const { calls } = fixture({ migrationError, cleanupError })
  const [result] = await Promise.allSettled([createIsolatedPostgres({ environment: {} })])
  expect(result.status).toBe('rejected')
  expect(result.reason).toBeInstanceOf(AggregateError)
  expect(result.reason.cause).toBe(migrationError)
  expect(result.reason.errors).toEqual([migrationError, cleanupError])
  expect(calls).toEqual(['migrate', 'dispose'])
})

test('does not dispose when creation fails before a handle is returned', async () => {
  const error = new Error('creation failed')
  const { calls } = fixture({ creationError: error })
  await expect(createIsolatedPostgres({ environment: {} })).rejects.toBe(error)
  expect(calls).toEqual([])
})

test('returns a migrated fixture with disposal owned by its caller', async () => {
  const { calls, database } = fixture()
  expect(await createIsolatedPostgres({ environment: {} })).toBe(database)
  expect(calls).toEqual(['migrate'])
  await database.dispose()
  expect(calls).toEqual(['migrate', 'dispose'])
})

test('migration disabled returns the fixture without migrating or disposing it', async () => {
  const { calls, database } = fixture()
  expect(await createIsolatedPostgres({ environment: {}, migrate: false })).toBe(database)
  expect(calls).toEqual([])
})

test('successful operation disposes exactly once and returns its result', async () => {
  const { calls, database } = fixture()
  const result = await withIsolatedPostgres(
    (actual) => {
      expect(actual).toBe(database)
      calls.push('operation')
      return 'result'
    },
    { environment: {} }
  )
  expect(result).toBe('result')
  expect(calls).toEqual(['migrate', 'operation', 'dispose'])
})

test('operation failure still disposes exactly once', async () => {
  const error = new Error('operation failed')
  const { calls } = fixture()
  await expect(
    withIsolatedPostgres(
      () => {
        calls.push('operation')
        throw error
      },
      { environment: {} }
    )
  ).rejects.toBe(error)
  expect(calls).toEqual(['migrate', 'operation', 'dispose'])
})
