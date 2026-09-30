import { expect, test } from 'bun:test'
import {
  completeIsolatedDatabaseSetup,
  createIsolatedDatabaseDisposer,
  ownedClientBackendTerminationStatement,
} from './isolated-database-cleanup.ts'

test('coalesces successful isolated database disposal without repeating actions', async () => {
  const calls = []
  const actions = Object.fromEntries(
    ['closeApplication', 'terminateSessions', 'dropDatabase', 'closeAdministration'].map((name) => [
      name,
      async () => {
        calls.push(name)
      },
    ])
  )
  const dispose = createIsolatedDatabaseDisposer(actions)
  const first = dispose()
  const concurrent = dispose()
  expect(concurrent).toBe(first)
  await Promise.all([first, concurrent])
  await dispose()
  expect(calls).toEqual(Object.keys(actions))
})

test('disposes a generated database after an ambiguous creation acknowledgement', async () => {
  const creationError = new Error('CREATE_ACK_LOST')
  const calls = []
  const dispose = createIsolatedDatabaseDisposer({
    closeApplication: async () => {
      calls.push('closeApplication')
    },
    terminateSessions: async () => {
      calls.push('terminateSessions')
    },
    dropDatabase: async () => {
      calls.push('dropOwnedDatabase')
    },
    closeAdministration: async () => {
      calls.push('closeAdministration')
    },
  })
  await expect(
    completeIsolatedDatabaseSetup(async () => {
      calls.push('createOwnedDatabase')
      throw creationError
    }, dispose)
  ).rejects.toBe(creationError)
  expect(calls).toEqual([
    'createOwnedDatabase',
    'closeApplication',
    'terminateSessions',
    'dropOwnedDatabase',
    'closeAdministration',
  ])
})

test('retains initialization and cleanup failures without reporting a fixture', async () => {
  const creationError = new Error('CREATE_FAILED')
  const cleanupError = new Error('CLEANUP_FAILED')
  const outcomes = await Promise.allSettled([
    completeIsolatedDatabaseSetup(
      async () => {
        throw creationError
      },
      async () => {
        throw cleanupError
      }
    ),
  ])
  expect(outcomes[0].status).toBe('rejected')
  expect(outcomes[0].reason).toBeInstanceOf(AggregateError)
  expect(outcomes[0].reason.errors).toEqual([creationError, cleanupError])
  expect(outcomes[0].reason.cause).toBe(creationError)
})

test('attempts every owned cleanup action and retains failure on concurrent and later calls', async () => {
  const calls = []
  const failures = [new Error('APPLICATION_CLOSE_FAILED'), new Error('DATABASE_DROP_FAILED')]
  const actions = Object.fromEntries(
    ['closeApplication', 'terminateSessions', 'dropDatabase', 'closeAdministration'].map(
      (name, index) => [
        name,
        async () => {
          calls.push(name)
          if (index === 0) throw failures[0]
          if (index === 2) throw failures[1]
        },
      ]
    )
  )
  const dispose = createIsolatedDatabaseDisposer(actions)
  const first = dispose()
  const concurrent = dispose()
  const outcomes = await Promise.allSettled([first, concurrent])
  expect(calls).toEqual(Object.keys(actions))
  expect(outcomes.map(({ status }) => status)).toEqual(['rejected', 'rejected'])
  expect(outcomes[0].reason).toBeInstanceOf(AggregateError)
  expect(outcomes[0].reason.errors).toEqual(failures)
  expect(outcomes[1].reason).toBe(outcomes[0].reason)
  const later = await Promise.allSettled([dispose()])
  expect(later[0].status).toBe('rejected')
  expect(later[0].reason).toBe(outcomes[0].reason)
  expect(calls).toEqual(Object.keys(actions))
})

test('terminates only client backends connected to its generated database', async () => {
  const statement = ownedClientBackendTerminationStatement('control_plane_test_owned')
  expect(statement.text).toContain('where datname = $1')
  expect(statement.text).toContain("and backend_type = 'client backend'")
  expect(statement.text).toContain('and pid <> pg_backend_pid()')
  expect(statement.parameters).toEqual(['control_plane_test_owned'])
})
