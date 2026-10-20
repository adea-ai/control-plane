import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { loadDatabaseCredentials } from '@control-plane/config'

const postgres = createRequire(import.meta.resolve('@control-plane/database'))('postgres').default
const socketPattern = /^\/tmp\/pi-cancellation-pg\.[A-Za-z0-9]+\/socket$/
const databasePattern = /^control_plane_test_pi_cancel_[a-f0-9]{32}$/
const options = { max: 8, prepare: false, onnotice: () => {} }

export function cancellationPostgresEnabled(environment = process.env) {
  return (
    Boolean(environment.PI_CANCELLATION_TEST_PG_SOCKET) ||
    environment.RUN_DATABASE_INTEGRATION === 'true'
  )
}

function privateSocket(environment) {
  const socket = environment.PI_CANCELLATION_TEST_PG_SOCKET
  if (socket === undefined) return undefined
  if (!socketPattern.test(socket)) throw new Error('OWNED_TEST_SOCKET_REQUIRED')
  return socket
}

// The normal integration runner provides existing disposable-local credentials.
// There is no fallback to a remote database or to ambient credentials outside that lane.
function localCredentials(environment, role) {
  if (environment.RUN_DATABASE_INTEGRATION !== 'true')
    throw new Error('LOCAL_INTEGRATION_LANE_REQUIRED')
  const url = new URL(loadDatabaseCredentials(environment, role).url)
  // postgres 3.4.9 forwards unknown URL keys into StartupMessage, where database/user
  // can override its explicit identity. This harness supports only one private host path.
  const keys = [...url.searchParams.keys()]
  if (keys.some((key) => key !== 'host') || keys.length > 1)
    throw new Error('UNSUPPORTED_TEST_DATABASE_URL_PARAMETER')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('LOCAL_TEST_DATABASE_REQUIRED')
  const socket = url.searchParams.get('host')
  if (socket !== null && !socketPattern.test(socket)) throw new Error('OWNED_TEST_SOCKET_REQUIRED')
  return url
}

function localClient(input, max = options.max) {
  const url = new URL(input)
  const socket = url.searchParams.get('host')
  // Never forward URL search parameters or ambient database/user/port defaults.
  return postgres({
    ...options,
    max,
    host: socket ?? url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  })
}

async function assertDatabaseIdentity(client, database, username) {
  const rows = await client`select current_database() as database, current_user as username`
  if (rows.length !== 1 || rows[0].database !== database || rows[0].username !== username)
    throw new Error('CANCELLATION_TEST_DATABASE_IDENTITY_MISMATCH')
}

export async function verifyCancellationTestIdentity(client, environment = process.env) {
  if (privateSocket(environment))
    return assertDatabaseIdentity(client, 'postgres', userInfo().username)
  const url = localCredentials(environment, 'migration')
  return assertDatabaseIdentity(
    client,
    ownedName(environment.PI_CANCELLATION_TEST_DATABASE_NAME),
    decodeURIComponent(url.username)
  )
}

function ownedName(name) {
  if (!databasePattern.test(name ?? '')) throw new Error('OWNED_TEST_DATABASE_REQUIRED')
  return name
}

export function openCancellationTestClient(environment = process.env) {
  const socket = privateSocket(environment)
  if (socket) {
    return postgres({
      host: socket,
      port: 5432,
      database: 'postgres',
      username: userInfo().username,
      ...options,
    })
  }
  const url = localCredentials(environment, 'migration')
  url.pathname = `/${ownedName(environment.PI_CANCELLATION_TEST_DATABASE_NAME)}`
  return localClient(url)
}

export async function createCancellationTestDatabase(environment = process.env) {
  if (privateSocket(environment)) {
    const client = openCancellationTestClient(environment)
    try {
      await verifyCancellationTestIdentity(client, environment)
      return { client, environment, close: () => client.end({ timeout: 5 }) }
    } catch (error) {
      const cleanup = await client.end({ timeout: 5 }).then(
        () => ({ success: true }),
        (failure) => ({ success: false, failure })
      )
      if (!cleanup.success)
        throw new AggregateError(
          [error, cleanup.failure],
          'CANCELLATION_TEST_DATABASE_SETUP_FAILED',
          {
            cause: error,
          }
        )
      throw error
    }
  }
  const administration = localCredentials(environment, 'administration')
  const migration = localCredentials(environment, 'migration')
  if (
    administration.hostname !== migration.hostname ||
    administration.port !== migration.port ||
    administration.searchParams.get('host') !== migration.searchParams.get('host')
  )
    throw new Error('LOCAL_TEST_CLUSTER_MISMATCH')
  const name = `control_plane_test_pi_cancel_${randomUUID().replaceAll('-', '')}`
  const admin = localClient(administration, 1)
  let client
  let createAttempted = false
  let closePromise
  function close() {
    closePromise ??= (async () => {
      const failures = []
      try {
        await client?.end({ timeout: 5 })
      } catch (error) {
        failures.push(error)
      }
      if (createAttempted) {
        try {
          // Only this generated name is owned, including after a lost CREATE acknowledgement.
          await admin`drop database if exists ${admin(ownedName(name))}`
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        await admin.end({ timeout: 5 })
      } catch (error) {
        failures.push(error)
      }
      if (failures.length)
        throw new AggregateError(failures, `CANCELLATION_TEST_DATABASE_CLEANUP_FAILED: ${name}`, {
          cause: failures[0],
        })
    })()
    return closePromise
  }
  try {
    await assertDatabaseIdentity(
      admin,
      decodeURIComponent(administration.pathname.slice(1)),
      decodeURIComponent(administration.username)
    )
    createAttempted = true
    await admin`create database ${admin(name)} owner ${admin(decodeURIComponent(migration.username))}`
    const childEnvironment = { ...environment, PI_CANCELLATION_TEST_DATABASE_NAME: name }
    client = openCancellationTestClient(childEnvironment)
    // No migration or repository operation is admitted until the server confirms both pins.
    await verifyCancellationTestIdentity(client, childEnvironment)
    return { client, environment: childEnvironment, close }
  } catch (error) {
    const cleanup = await close().then(
      () => ({ success: true }),
      (failure) => ({ success: false, failure })
    )
    if (!cleanup.success)
      throw new AggregateError(
        [error, cleanup.failure],
        'CANCELLATION_TEST_DATABASE_SETUP_FAILED',
        {
          cause: error,
        }
      )
    throw error
  }
}
