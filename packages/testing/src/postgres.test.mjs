import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// The bundle is loaded from a temporary file this test owns.
//
// A module imported from a data: URL is not reportable by the coverage reporter
// of the pinned Bun 1.4.3: it aborts the whole coverage run with "panic: range
// end index 1884 out of range for slice of length 1024" before any summary is
// printed. The file holds the bundle's bytes exactly as the build produced them,
// so the fixture under test is unchanged, and the directory is removed when the
// run ends and when the fixture cannot be loaded at all.

/** The directory that holds the fixture file, created empty and owned by the test. */
async function createFixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-postgres-fixture-'))
  // The bundle is generated output, so it is written into a dist/ directory: the
  // repository's coverage configuration already ignores generated output, and the
  // coverage report keeps the rows it had before.
  await mkdir(join(directory, 'dist'))
  return directory
}

/** The path of the fixture file inside an owned directory. */
function fixtureFilePath(directory) {
  return join(directory, 'dist', 'postgres-fixture.mjs')
}

/** Removes an owned directory and everything in it. */
async function removeFixtureDirectory(directory) {
  await rm(directory, { recursive: true, force: true })
}

/** Writes the fixture and loads it, leaving nothing behind when the load fails. */
async function loadFixtureModule(directory, source) {
  await writeFile(fixtureFilePath(directory), source)
  try {
    return await import(pathToFileURL(fixtureFilePath(directory)).href)
  } catch (error) {
    await removeFixtureDirectory(directory)
    throw error
  }
}

const fixtureSource = await built.outputs[0].text()
const fixtureDirectory = await createFixtureDirectory()
const fixtureFile = fixtureFilePath(fixtureDirectory)
const { configure, createIsolatedPostgres, withIsolatedPostgres } = await loadFixtureModule(
  fixtureDirectory,
  fixtureSource
)
afterAll(async () => {
  await removeFixtureDirectory(fixtureDirectory)
})

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

test('loads the fixture from the temporary file this test owns', async () => {
  expect(existsSync(fixtureFile)).toBe(true)
  expect(await readFile(fixtureFile, 'utf8')).toBe(fixtureSource)
  expect(fixtureDirectory.startsWith(tmpdir())).toBe(true)
  expect(typeof configure).toBe('function')
})

test('removes the temporary fixture directory it owns', async () => {
  const directory = await createFixtureDirectory()
  const file = fixtureFilePath(directory)
  await writeFile(file, 'export const probe = 1\n')

  expect(existsSync(file)).toBe(true)
  await removeFixtureDirectory(directory)
  expect(existsSync(directory)).toBe(false)
})

test('removes the temporary fixture directory when the fixture cannot be loaded', async () => {
  const directory = await createFixtureDirectory()

  await expect(loadFixtureModule(directory, 'export const broken = (')).rejects.toThrow()
  expect(existsSync(directory)).toBe(false)
})
