import { createHash, X509Certificate } from 'node:crypto'
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
    !exactKeys(identity, [
      'serviceId',
      'environmentId',
      'database',
      'migration',
      'runtime',
      'runtimeVerification',
      'tls',
    ]) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity.serviceId ?? '') ||
    identity.environmentId !== '52f5b0ac-2af0-4792-aa56-30d80e5db31e' ||
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(identity.database ?? '')
  ) {
    throw new Error('Production database target is not verified in the repository contract')
  }
  for (const endpoint of [identity.migration, identity.runtime, identity.runtimeVerification]) {
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
  if (
    !exactKeys(identity.tls, ['serverName', 'caSha256']) ||
    typeof identity.tls.serverName !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(identity.tls.serverName) ||
    identity.tls.serverName.includes('..') ||
    identity.tls.serverName.length > 253 ||
    (identity.tls.caSha256 !== null && !/^[a-f0-9]{64}$/.test(identity.tls.caSha256)) ||
    (identity.tls.caSha256 === null && identity.tls.serverName !== identity.migration.hostname)
  ) {
    throw new Error('Production database TLS identity is invalid')
  }
  // Both public connections must use the one reviewed proxy mapping for this
  // service/environment. No environment variable may introduce a second target.
  if (
    identity.runtimeVerification.hostname !== identity.migration.hostname ||
    identity.runtimeVerification.port !== identity.migration.port
  ) {
    throw new Error('Production database verification endpoint identity is invalid')
  }
  return {
    tls: { ...identity.tls },
    runtimeVerification: {
      ...identity.runtimeVerification,
      database: identity.database,
      username: 'control_plane_app',
    },
    database: identity.database,
    migration: {
      ...identity.migration,
      database: identity.database,
      username: 'control_plane_migrator',
    },
    runtime: { ...identity.runtime, database: identity.database, username: 'control_plane_app' },
  }
}

// Trust material is supplied separately from credentials and never chooses its
// own peer or fingerprint. Hash the DER certificate, independent of PEM wrapping.
export function resolveProductionDatabaseTls(contract, caCertificate) {
  const { tls } = resolveProductionDatabaseTarget(contract)
  if (tls.caSha256 === null) {
    if (caCertificate !== undefined && caCertificate !== '') {
      throw new Error('Production database CA does not match reviewed TLS policy')
    }
    return Object.freeze({ rejectUnauthorized: true, servername: tls.serverName })
  }
  try {
    if (
      typeof caCertificate !== 'string' ||
      caCertificate.length > 65536 ||
      (caCertificate.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1 ||
      !/^\s*-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(caCertificate)
    ) {
      throw new Error('invalid CA')
    }
    const certificate = new X509Certificate(caCertificate)
    if (createHash('sha256').update(certificate.raw).digest('hex') !== tls.caSha256) {
      throw new Error('incorrect CA')
    }
    return Object.freeze({
      rejectUnauthorized: true,
      servername: tls.serverName,
      ca: caCertificate,
    })
  } catch {
    throw new Error('Production database CA does not match reviewed TLS policy')
  }
}
