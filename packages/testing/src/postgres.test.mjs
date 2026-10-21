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
// so the fixture under test is unchanged.
//
// Every step after the directory is allocated can fail, and no failure may leave
// the directory behind: the allocation and the directory creation are one guarded
// step, the write is guarded as well as the import, and the removal is registered
// before the fixture is loaded. A removal that fails is reported next to the
// failure that caused it instead of replacing it.

/** The path of the fixture file inside an owned directory. */
function fixtureFilePath(directory) {
  return join(directory, 'dist', 'postgres-fixture.mjs')
}

/** Removes an owned directory and everything in it. */
async function removeFixtureDirectory(directory) {
  await rm(directory, { recursive: true, force: true })
}

/**
 * The error a failure is reported as.
 *
 * The failure that caused the cleanup is kept, and a cleanup that failed too is
 * reported beside it rather than in place of it.
 */
function fixtureFailure(error, cleanupError) {
  if (!cleanupError) return error
  return new AggregateError(
    [error, cleanupError],
    'the fixture failed and its cleanup failed too',
    {
      cause: error,
    }
  )
}

/**
 * Runs a step that owns a directory, and removes that directory when the step fails.
 */
async function owningDirectory(directory, step, remove = removeFixtureDirectory) {
  try {
    return await step()
  } catch (error) {
    try {
      await remove(directory)
    } catch (cleanupError) {
      throw fixtureFailure(error, cleanupError)
    }
    throw error
  }
}

/**
 * The directory that holds the fixture file.
 *
 * The allocation and the directory creation are one guarded step: a directory that
 * was allocated and then not filled is removed instead of being left behind.
 */
async function createFixtureDirectory({
  allocate = mkdtemp,
  mkdir: makeDirectory = mkdir,
  remove = removeFixtureDirectory,
} = {}) {
  const directory = await allocate(join(tmpdir(), 'control-plane-postgres-fixture-'))
  return owningDirectory(
    directory,
    async () => {
      // The bundle is generated output, so it is written into a dist/ directory: the
      // repository's coverage configuration already ignores generated output, and the
      // coverage report keeps the rows it had before.
      await makeDirectory(join(directory, 'dist'))
      return directory
    },
    remove
  )
}

/**
 * Writes the fixture and loads it.
 *
 * The write is inside the guard too: a file that cannot be written leaves the owned
 * directory behind unless the directory is removed here.
 */
async function loadFixtureModule(
  directory,
  source,
  { writeFile: write = writeFile, remove = removeFixtureDirectory } = {}
) {
  return owningDirectory(
    directory,
    async () => {
      await write(fixtureFilePath(directory), source)
      return import(pathToFileURL(fixtureFilePath(directory)).href)
    },
    remove
  )
}

const fixtureSource = await built.outputs[0].text()
const fixtureDirectory = await createFixtureDirectory()
const fixtureFile = fixtureFilePath(fixtureDirectory)
// The removal is registered before the fixture is loaded, so a failure while the
// fixture is written or imported still has a registered cleanup.
afterAll(async () => {
  await removeFixtureDirectory(fixtureDirectory)
})
const { configure, createIsolatedPostgres, withIsolatedPostgres } = await loadFixtureModule(
  fixtureDirectory,
  fixtureSource
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

test('removes the owned directory when the fixture directory cannot be created', async () => {
  const allocated = []
  const failure = new Error('the fixture directory could not be created')
  const error = await createFixtureDirectory({
    allocate: async (prefix) => {
      const directory = await mkdtemp(prefix)
      allocated.push(directory)
      return directory
    },
    mkdir: async () => {
      throw failure
    },
  }).catch((thrown) => thrown)

  expect(error).toBe(failure)
  expect(allocated).toHaveLength(1)
  expect(existsSync(allocated[0])).toBe(false)
})

test('removes the owned directory when the fixture file cannot be written', async () => {
  const directory = await createFixtureDirectory()
  const failure = new Error('the fixture file could not be written')
  const error = await loadFixtureModule(directory, 'export const probe = 1\n', {
    writeFile: async () => {
      throw failure
    },
  }).catch((thrown) => thrown)

  expect(error).toBe(failure)
  expect(existsSync(directory)).toBe(false)
})

test('removes the owned directory when the fixture cannot be imported', async () => {
  const directory = await createFixtureDirectory()
  const error = await loadFixtureModule(directory, 'export const broken = (').catch(
    (thrown) => thrown
  )

  expect(error).toBeInstanceOf(Error)
  expect(existsSync(directory)).toBe(false)
})

test('keeps the original failure when the cleanup fails too', async () => {
  const directory = await createFixtureDirectory()
  const failure = new Error('the fixture file could not be written')
  const cleanupFailure = new Error('the owned directory could not be removed')
  const error = await loadFixtureModule(directory, 'export const probe = 1\n', {
    writeFile: async () => {
      throw failure
    },
    remove: async () => {
      throw cleanupFailure
    },
  }).catch((thrown) => thrown)

  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors[0]).toBe(failure)
  expect(error.errors[1]).toBe(cleanupFailure)
  expect(error.cause).toBe(failure)
  // The injected cleanup could not remove the directory, so the test removes it.
  await removeFixtureDirectory(directory)
  expect(existsSync(directory)).toBe(false)
})

test('leaves directories it does not own untouched', async () => {
  const neighbour = await createFixtureDirectory()
  const directory = await createFixtureDirectory()
  const failure = new Error('the fixture file could not be written')

  await loadFixtureModule(directory, 'export const probe = 1\n', {
    writeFile: async () => {
      throw failure
    },
  }).catch(() => {})

  expect(existsSync(neighbour)).toBe(true)
  expect(existsSync(directory)).toBe(false)
  await removeFixtureDirectory(neighbour)
})
