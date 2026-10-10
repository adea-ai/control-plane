import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialApiFixtures } from '@control-plane/contracts'
import {
  createControlApiApplication,
  createCredentialAdministrationService,
  PolicyServiceAuthenticator,
} from '@control-plane/control-api'
import {
  SqliteCredentialVaultRepository,
  SqliteEncryptedSecretStore,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'

// Synthetic test values only. The canary is a marker that must never appear in stored bytes.
const CANARY = 'local-credential-revocation-SECRET-canary-7f21'
const ENCRYPTION_KEY = 'd'.repeat(64)
const KEY_REFERENCE = 'control-plane-local-secret-key'
const SECRET_PREFIX = 'local://credential-secrets'
const workspaceId = CredentialApiFixtures.create.request.workspaceId
const principal = CredentialApiFixtures.create.request.caller.servicePrincipalId
const metadata = {
  serviceName: 'control-api',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'local-credential-revocation-test',
}

function claims(overrides = {}) {
  const now = Date.now()
  return {
    audience: 'control-plane',
    issuer: 'https://local-credential.example',
    credentialKind: 'service',
    credentialId: 'credential-local-revocation-test',
    keyId: 'local-credential-key',
    principalId: principal,
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    scopes: ['credential:write', 'credential:read'],
    workspaceIds: [workspaceId],
    projectIds: [],
    ...overrides,
  }
}

async function openPersistence(path) {
  const persistence = new SqlitePersistenceProvider({ path })
  await persistence.migrate()
  return persistence
}

/** Real Local composition pieces: SQLite persistence, the operator-keyed service, and the authenticator. */
async function createLocalCredentialApp(
  persistence,
  { authorizedClaims, withService = true } = {}
) {
  const logs = []
  const logger = { write: (entry) => logs.push(entry) }
  return await createControlApiApplication({
    metadata,
    logger,
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    serviceAuthenticator: new PolicyServiceAuthenticator({
      audience: 'control-plane',
      issuer: 'https://local-credential.example',
      clockSkewMs: 30_000,
      now: () => new Date(),
      logger,
      revocationChecker: { isRevoked: async () => false },
      verifier: { verify: async () => authorizedClaims ?? claims() },
    }),
    ...(withService
      ? {
          credentialAdministrationService: createCredentialAdministrationService({
            repository: new SqliteCredentialVaultRepository(persistence),
            secretStore: new SqliteEncryptedSecretStore(persistence),
            encryptionKey: ENCRYPTION_KEY,
            keyReference: KEY_REFERENCE,
            secretPrefix: SECRET_PREFIX,
          }),
        }
      : {}),
  })
}

const bearer = { authorization: 'Bearer local-credential-revocation-token' }

async function secretRecordCount(persistence) {
  return await persistence.transaction(async (transaction) => {
    return (await transaction.list('credential-secrets')).length
  })
}

test('Local profile revokes a connector credential durably and deletes its secret revisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-credential-revocation-'))
  const path = join(directory, 'control-plane.sqlite')
  let persistence = await openPersistence(path)
  let app = await createLocalCredentialApp(persistence)
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/credentials/create',
      headers: bearer,
      payload: {
        ...CredentialApiFixtures.create.request,
        payload: { ...CredentialApiFixtures.create.request.payload, secret: CANARY },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.body.includes(CANARY)).toBe(false)
    const credentialId = created.json().data.credential.credentialId
    expect(await secretRecordCount(persistence)).toBe(1)

    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/credentials/revoke',
      headers: bearer,
      payload: {
        ...CredentialApiFixtures.revoke.request,
        payload: { credentialId },
      },
    })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json().data.credential).toMatchObject({ credentialId, status: 'revoked' })
    // The provider deleted every secret revision on revocation.
    expect(await secretRecordCount(persistence)).toBe(0)

    await app.close()
    persistence.close({ checkpoint: true })

    // Restart: the revocation is durable and the secret stays gone.
    persistence = await openPersistence(path)
    app = await createLocalCredentialApp(persistence)
    const afterRestart = await app.inject({
      method: 'POST',
      url: '/v1/credentials/get',
      headers: bearer,
      payload: {
        ...CredentialApiFixtures.get.request,
        parameters: { credentialId },
      },
    })
    expect(afterRestart.statusCode).toBe(200)
    expect(afterRestart.json().data.credential.status).toBe('revoked')
    expect(await secretRecordCount(persistence)).toBe(0)
  } finally {
    await app?.close()
    persistence?.close({ checkpoint: true })
  }

  // The synthetic secret canary never reached the database bytes in plaintext.
  const files = await readdir(directory)
  for (const file of files) {
    const bytes = await readFile(join(directory, file))
    expect(bytes.includes(Buffer.from(CANARY))).toBe(false)
  }
  await rm(directory, { recursive: true, force: true })
})

test('revocation requires credential:write; a read-only principal is refused before any state change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-credential-scope-'))
  const persistence = await openPersistence(join(directory, 'control-plane.sqlite'))
  const app = await createLocalCredentialApp(persistence, {
    authorizedClaims: claims({ scopes: ['credential:read'] }),
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/credentials/revoke',
      headers: bearer,
      payload: {
        ...CredentialApiFixtures.revoke.request,
        payload: { credentialId: 'credential-never-created' },
      },
    })
    expect(response.statusCode).toBe(403)
    expect(await secretRecordCount(persistence)).toBe(0)
  } finally {
    await app.close()
    persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('without an operator-supplied key the Local revocation route stays typed unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-credential-unconfigured-'))
  const persistence = await openPersistence(join(directory, 'control-plane.sqlite'))
  const app = await createLocalCredentialApp(persistence, { withService: false })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/credentials/revoke',
      headers: bearer,
      payload: {
        ...CredentialApiFixtures.revoke.request,
        payload: { credentialId: 'credential-never-created' },
      },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('CREDENTIAL_VAULT_NOT_CONFIGURED')
  } finally {
    await app.close()
    persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a malformed operator key fails closed at composition instead of serving a default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'local-credential-key-'))
  const persistence = await openPersistence(join(directory, 'control-plane.sqlite'))
  try {
    expect(() =>
      createCredentialAdministrationService({
        repository: new SqliteCredentialVaultRepository(persistence),
        secretStore: new SqliteEncryptedSecretStore(persistence),
        encryptionKey: 'not-a-valid-key',
        keyReference: KEY_REFERENCE,
        secretPrefix: SECRET_PREFIX,
      })
    ).toThrow('CREDENTIAL_ENCRYPTION_KEY_INVALID')
  } finally {
    persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})
