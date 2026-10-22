import { readFileSync } from 'node:fs'

const recordedContract = JSON.parse(
  readFileSync(
    new URL('../infrastructure/railway/production-database.json', import.meta.url),
    'utf8'
  )
)

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((name) => Object.hasOwn(value, name))
  )
}

// This is reviewed source metadata, never an environment-selected hostname or a
// credential. The live cutover owner supplies the verified identity before the
// production gate can run. Keeping it absent refuses promotion before any I/O.
export function resolveProductionDatabaseTarget(contract = recordedContract) {
  const identity = contract?.identity
  if (
    !exactKeys(contract, ['schemaVersion', 'provider', 'status', 'identity']) ||
    contract.schemaVersion !== 1 ||
    contract?.provider !== 'railway-postgres' ||
    contract?.status !== 'verified' ||
    !exactKeys(identity, ['serviceId', 'database', 'migration', 'runtime']) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity.serviceId ?? '') ||
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(identity.database ?? '')
  ) {
    throw new Error('Production database target is not verified in the repository contract')
  }
  for (const endpoint of [identity.migration, identity.runtime]) {
    if (
      !exactKeys(endpoint, ['hostname', 'port']) ||
      typeof endpoint.hostname !== 'string' ||
      endpoint.hostname.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(endpoint.hostname) ||
      endpoint.hostname.includes('..') ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65535
    ) {
      throw new Error('Production database endpoint identity is invalid')
    }
  }
  return {
    database: identity.database,
    migration: {
      ...identity.migration,
      database: identity.database,
      username: 'control_plane_migrator',
    },
    runtime: { ...identity.runtime, database: identity.database, username: 'control_plane_app' },
  }
}
