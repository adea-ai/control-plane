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
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('LOCAL_TEST_DATABASE_REQUIRED')
  const socket = url.searchParams.get('host')
  if (socket !== null && !socketPattern.test(socket)) throw new Error('OWNED_TEST_SOCKET_REQUIRED')
  return url
}

function localClient(input, max = options.max) {
  const url = new URL(input)
  const socket = url.searchParams.get('host')
  url.searchParams.delete('host')
  return postgres(url.toString(), { ...options, max, ...(socket ? { host: socket } : {}) })
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
    return { client, environment, close: () => client.end({ timeout: 5 }) }
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
    createAttempted = true
    await admin`create database ${admin(name)} owner ${admin(decodeURIComponent(migration.username))}`
    const childEnvironment = { ...environment, PI_CANCELLATION_TEST_DATABASE_NAME: name }
    client = openCancellationTestClient(childEnvironment)
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
