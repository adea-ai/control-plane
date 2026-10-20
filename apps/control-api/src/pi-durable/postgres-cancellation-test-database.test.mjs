import { expect, test } from 'bun:test'
import {
  cancellationPostgresEnabled,
  createCancellationTestDatabase,
  openCancellationTestClient,
  verifyCancellationTestIdentity,
} from './postgres-cancellation-test-database.fixture.mjs'

const local = {
  RUN_DATABASE_INTEGRATION: 'true',
  DATABASE_ADMIN_URL: 'postgresql://existing_admin@127.0.0.1:54329/postgres',
  DATABASE_MIGRATION_URL: 'postgresql://existing_migration@127.0.0.1:54329/postgres',
}

test('only an explicit integration lane or private socket enables PostgreSQL qualification', () => {
  expect(cancellationPostgresEnabled({})).toBe(false)
  expect(cancellationPostgresEnabled({ RUN_DATABASE_INTEGRATION: 'false' })).toBe(false)
  expect(cancellationPostgresEnabled({ RUN_DATABASE_INTEGRATION: 'true' })).toBe(true)
  expect(
    cancellationPostgresEnabled({
      PI_CANCELLATION_TEST_PG_SOCKET: '/tmp/pi-cancellation-pg.abc/socket',
    })
  ).toBe(true)
})

test.each([
  { database: 'postgres', username: 'existing_migration' },
  { database: `control_plane_test_pi_cancel_${'a'.repeat(32)}`, username: 'another_role' },
])('server identity drift refuses database operations: %j', async (observed) => {
  const probe = async () => [observed]
  await expect(
    verifyCancellationTestIdentity(probe, {
      ...local,
      PI_CANCELLATION_TEST_DATABASE_NAME: `control_plane_test_pi_cancel_${'a'.repeat(32)}`,
    })
  ).rejects.toThrow('CANCELLATION_TEST_DATABASE_IDENTITY_MISMATCH')
})

test('ambient migration credentials cannot enable the integration connection', () => {
  const { RUN_DATABASE_INTEGRATION: _enabled, ...ambient } = local
  expect(() => openCancellationTestClient(ambient)).toThrow('LOCAL_INTEGRATION_LANE_REQUIRED')
})

test('an invalid private socket never falls back to provided database credentials', async () => {
  const environment = { ...local, PI_CANCELLATION_TEST_PG_SOCKET: '/tmp/unowned/socket' }
  expect(() => openCancellationTestClient(environment)).toThrow('OWNED_TEST_SOCKET_REQUIRED')
  await expect(createCancellationTestDatabase(environment)).rejects.toThrow(
    'OWNED_TEST_SOCKET_REQUIRED'
  )
})

test('remote credentials and redirected socket hosts are refused before connection', async () => {
  for (const url of [
    'postgresql://existing_migration@remote.invalid/postgres',
    'postgresql://existing_migration@localhost/postgres?host=/tmp/unowned/socket',
  ]) {
    const environment = { ...local, DATABASE_MIGRATION_URL: url }
    expect(() => openCancellationTestClient(environment)).toThrow()
    await expect(createCancellationTestDatabase(environment)).rejects.toThrow()
  }
  await expect(
    createCancellationTestDatabase({
      ...local,
      DATABASE_ADMIN_URL: 'postgresql://existing_admin@remote.invalid/postgres',
    })
  ).rejects.toThrow('LOCAL_TEST_DATABASE_REQUIRED')
})

test('administration and migration must target the same explicit local cluster', async () => {
  await expect(
    createCancellationTestDatabase({
      ...local,
      DATABASE_MIGRATION_URL: 'postgresql://existing_migration@localhost:54329/postgres',
    })
  ).rejects.toThrow('LOCAL_TEST_CLUSTER_MISMATCH')
})

test('restart readers require the exact owned database name instead of the credential database', () => {
  for (const name of [undefined, 'postgres', 'control_plane_test_pi_cancel_other', '../postgres']) {
    expect(() =>
      openCancellationTestClient({ ...local, PI_CANCELLATION_TEST_DATABASE_NAME: name })
    ).toThrow('OWNED_TEST_DATABASE_REQUIRED')
  }
})

test.each([
  'database=postgres',
  'user=another_role',
  '%64atabase=postgres',
  'role=another_role',
  'options=-c%20role%3Danother_role',
  'host=/tmp/pi-cancellation-pg.abc/socket&host=/tmp/pi-cancellation-pg.def/socket',
])('URL startup overrides are rejected before connecting: %s', async (query) => {
  const unsafe = `postgresql://existing_migration@127.0.0.1:54329/postgres?${query}`
  const environment = {
    ...local,
    DATABASE_MIGRATION_URL: unsafe,
    PI_CANCELLATION_TEST_DATABASE_NAME: `control_plane_test_pi_cancel_${'a'.repeat(32)}`,
  }
  expect(() => openCancellationTestClient(environment)).toThrow(
    'UNSUPPORTED_TEST_DATABASE_URL_PARAMETER'
  )
  await expect(createCancellationTestDatabase(environment)).rejects.toThrow(
    'UNSUPPORTED_TEST_DATABASE_URL_PARAMETER'
  )
  await expect(
    createCancellationTestDatabase({ ...local, DATABASE_ADMIN_URL: unsafe })
  ).rejects.toThrow('UNSUPPORTED_TEST_DATABASE_URL_PARAMETER')
})
