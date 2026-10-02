import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import process from 'node:process'
import { loadDatabaseCredentials, loadDatabaseSessionCredentials } from '@control-plane/config'
import { RuntimeNodeCredentialClaimsSchema } from '@control-plane/runtime-gateway-protocol'
import { sql } from 'drizzle-orm'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { createPostgresConnection } from './connection.ts'
import { PostgresRuntimeNodeIdentityRepository } from './runtime-node-identity-repository.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const nodeId = 'rnr_01JABCDEF0123456789ABCDEFG'
const otherNodeId = 'rnr_01JABCDEF0123456789ABCDEGH'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const otherWorkspaceId = 'wsp_01JABCDEF0123456789ABCDEGH'
const issuedAt = '2026-09-28T12:00:00.000Z'
const baseNow = new Date(issuedAt)

describe.skipIf(!enabled)('PostgreSQL RuntimeNode identity persistence', () => {
  let isolated
  let applicationRepository
  let notificationConnection

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
    await restrictApplicationIdentityPrivileges()
    const credentials = loadDatabaseSessionCredentials(process.env)
    const notificationUrl = new URL(credentials.url)
    notificationUrl.pathname = `/${isolated.name}`
    notificationConnection = createPostgresConnection(
      { ...credentials, url: notificationUrl.toString() },
      { maxConnections: 1 }
    )
    applicationRepository = new PostgresRuntimeNodeIdentityRepository(isolated.application, {
      revocationClient: notificationConnection.database.$client,
    })
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    try {
      await notificationConnection?.close()
    } finally {
      await isolated?.dispose()
    }
  })

  test('registration and issue reject key-ID collisions, inactive keys, and scope mismatch', async () => {
    const key = await registerKey()
    await expect(
      migrationRepository((repository) => repository.registerVerificationKey(key))
    ).rejects.toMatchObject({ code: 'RUNTIME_NODE_IDENTITY_KEY_ID_COLLISION' })
    await expect(
      migrationRepository((repository) =>
        repository.registerVerificationKey({ ...key, keyId: makeKeyId(), status: 'retired' })
      )
    ).rejects.toMatchObject({ code: 'RUNTIME_NODE_IDENTITY_KEY_INACTIVE_CONFLICT' })

    const mismatched = makeIssuedCredential(key, {
      nodeId: otherNodeId,
      workspaceId: otherWorkspaceId,
    })
    await expect(
      migrationRepository((repository) => repository.insertIssuedCredential(mismatched))
    ).rejects.toMatchObject({ code: 'RUNTIME_NODE_IDENTITY_SCOPE_MISMATCH' })
  })

  test('credential IDs are unique and registration never persists credential strings', async () => {
    const key = await registerKey()
    const credential = makeIssuedCredential(key)
    const created = await migrationRepository((repository) =>
      repository.insertIssuedCredential(credential)
    )
    expect(created.claims).toEqual(credential.claims)
    expect(created.revokedAt).toBeNull()
    expect(created.consumedAt).toBeNull()
    await expect(
      migrationRepository((repository) => repository.insertIssuedCredential(credential))
    ).rejects.toMatchObject({ code: 'RUNTIME_NODE_IDENTITY_CREDENTIAL_ID_COLLISION' })

    const columns = await isolated.withMigrationDatabase((database) =>
      database.execute(sql`
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'runtime_node_issued_credentials'
        order by ordinal_position
      `)
    )
    const names = columns.map(({ column_name }) => column_name)
    expect(names).not.toContain('credential')
    expect(names).not.toContain('credential_string')
    expect(names).not.toContain('signature')
    expect(names).not.toContain('secret')
  })

  test('application role can consume once atomically across concurrent repository calls', async () => {
    const key = await registerKey()
    const credential = makeIssuedCredential(key)
    await migrationRepository((repository) => repository.insertIssuedCredential(credential))

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        applicationRepository.consumeCredential(credential.credentialId, 1, baseNow)
      )
    )
    expect(outcomes.filter((outcome) => outcome === 'consumed')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === 'replayed')).toHaveLength(11)
  })

  test('application role cannot reset a consumed one-use credential', async () => {
    const key = await registerKey()
    const credential = makeIssuedCredential(key)
    await migrationRepository((repository) => repository.insertIssuedCredential(credential))

    await expect(
      applicationRepository.consumeCredential(credential.credentialId, 1, baseNow)
    ).resolves.toBe('consumed')
    const resetFailure = await isolated.application
      .execute(sql`
        update public.runtime_node_issued_credentials
        set consumed_at = null
        where credential_id = ${credential.credentialId}
      `)
      .then(
        () => undefined,
        (error) => error
      )
    expect(resetFailure).toMatchObject({ cause: { code: '23514' } })
    expect(resetFailure.cause.message).toContain('runtime_node_credential_consumption_immutable')
    await expect(
      applicationRepository.consumeCredential(credential.credentialId, 1, baseNow)
    ).resolves.toBe('replayed')
  })

  test('expiry, revocation, key retirement, and consumed state survive a fresh DB client', async () => {
    expect(await applicationRepository.getVerificationKey(makeKeyId())).toBeUndefined()
    expect(await applicationRepository.isCredentialRevoked('rgc_unknown_credential_001', 1)).toBe(
      true
    )
    expect(
      await applicationRepository.consumeCredential('rgc_unknown_credential_001', 1, baseNow)
    ).toBe('unknown')

    const key = await registerKey()
    const expired = makeIssuedCredential(key, {
      credentialId: makeCredentialId(),
      expiresAt: '2026-09-28T12:00:01.000Z',
    })
    await migrationRepository((repository) => repository.insertIssuedCredential(expired))
    expect(
      await applicationRepository.consumeCredential(
        expired.credentialId,
        1,
        new Date('2026-09-28T12:00:01.000Z')
      )
    ).toBe('expired')

    const revoked = makeIssuedCredential(key, { credentialId: makeCredentialId() })
    await migrationRepository((repository) => repository.insertIssuedCredential(revoked))
    await migrationRepository((repository) =>
      repository.revokeCredential(revoked.credentialId, baseNow)
    )
    expect(await applicationRepository.isCredentialRevoked(revoked.credentialId, 1)).toBe(true)
    await expect(
      applicationRepository.consumeCredential(revoked.credentialId, 1, baseNow)
    ).resolves.toBe('revoked')

    const used = makeIssuedCredential(key, { credentialId: makeCredentialId() })
    await migrationRepository((repository) => repository.insertIssuedCredential(used))
    await expect(
      applicationRepository.consumeCredential(used.credentialId, 1, baseNow)
    ).resolves.toBe('consumed')

    const credentials = loadDatabaseCredentials(process.env, 'application')
    const url = new URL(credentials.url)
    url.pathname = `/${isolated.name}`
    const restartedConnection = createPostgresConnection({ ...credentials, url: url.toString() })
    try {
      const restartedRepository = new PostgresRuntimeNodeIdentityRepository(
        restartedConnection.database
      )
      expect(await restartedRepository.isCredentialRevoked(revoked.credentialId, 1)).toBe(true)
      expect(await restartedRepository.getIssuedCredential(revoked.credentialId)).toMatchObject({
        revocationVersion: 2,
        revokedAt: baseNow.toISOString(),
      })
      expect(await restartedRepository.getIssuedCredential(used.credentialId)).toMatchObject({
        consumedAt: baseNow.toISOString(),
      })
    } finally {
      await restartedConnection.close()
    }
  })

  test('credential revocation and key retirement notify validated identity invalidations', async () => {
    const key = await registerKey()
    const credential = makeIssuedCredential(key)
    await migrationRepository((repository) => repository.insertIssuedCredential(credential))
    const received = []
    const unsubscribe = await applicationRepository.subscribeRevocations((invalidation) => {
      received.push(invalidation)
    })
    try {
      const first = await migrationRepository((repository) =>
        repository.revokeCredential(credential.credentialId, baseNow)
      )
      const repeated = await migrationRepository((repository) =>
        repository.revokeCredential(credential.credentialId, new Date(baseNow.getTime() + 1000))
      )
      expect(first.revocationVersion).toBe(2)
      expect(repeated.revocationVersion).toBe(2)
      await waitFor(() => received.length > 0)

      await migrationRepository((repository) =>
        repository.retireVerificationKey(key.keyId, 'retired')
      )
      await waitFor(() => received.length > 1)

      await isolated.withMigrationDatabase((database) =>
        database.execute(
          sql`select pg_notify('runtime_node_credential_revocations_v1', 'not-a-credential-id')`
        )
      )
      await isolated.withMigrationDatabase((database) =>
        database.execute(
          sql`select pg_notify('runtime_node_credential_revocations_v1', 'key:not-a-key')`
        )
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(received).toEqual([
        { kind: 'credential', credentialId: credential.credentialId },
        { kind: 'key', keyId: key.keyId },
      ])
    } finally {
      await unsubscribe()
    }
    await isolated.withMigrationDatabase((database) =>
      database.execute(
        sql`select pg_notify('runtime_node_credential_revocations_v1', ${credential.credentialId})`
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).toEqual([
      { kind: 'credential', credentialId: credential.credentialId },
      { kind: 'key', keyId: key.keyId },
    ])
  })

  test('application role can read identity state and update only consumption', async () => {
    const [privileges] = await isolated.application.execute(sql`
      select
        has_table_privilege(current_user, 'public.runtime_node_verification_keys', 'SELECT') as key_select,
        has_table_privilege(current_user, 'public.runtime_node_verification_keys', 'INSERT') as key_insert,
        has_table_privilege(current_user, 'public.runtime_node_verification_keys', 'UPDATE') as key_update,
        has_table_privilege(current_user, 'public.runtime_node_issued_credentials', 'SELECT') as credential_select,
        has_table_privilege(current_user, 'public.runtime_node_issued_credentials', 'INSERT') as credential_insert,
        has_table_privilege(current_user, 'public.runtime_node_issued_credentials', 'UPDATE') as credential_update,
        has_column_privilege(current_user, 'public.runtime_node_issued_credentials', 'consumed_at', 'UPDATE') as consumed_update,
        has_column_privilege(current_user, 'public.runtime_node_issued_credentials', 'revoked_at', 'UPDATE') as revoked_update
    `)
    expect(privileges).toMatchObject({
      key_select: true,
      key_insert: false,
      key_update: false,
      credential_select: true,
      credential_insert: false,
      credential_update: false,
      consumed_update: true,
      revoked_update: false,
    })

    const key = makeVerificationKey()
    await expect(applicationRepository.registerVerificationKey(key)).rejects.toThrow()
    await migrationRepository((repository) => repository.registerVerificationKey(key))
    const credential = makeIssuedCredential(key)
    await expect(applicationRepository.insertIssuedCredential(credential)).rejects.toThrow()
    await migrationRepository((repository) => repository.insertIssuedCredential(credential))
    await expect(
      applicationRepository.revokeCredential(credential.credentialId, baseNow)
    ).rejects.toThrow()
    await expect(
      applicationRepository.consumeCredential(credential.credentialId, 1, baseNow)
    ).resolves.toBe('consumed')
    await migrationRepository((repository) =>
      repository.retireVerificationKey(key.keyId, 'retired')
    )
    expect(await applicationRepository.isCredentialRevoked(credential.credentialId, 1)).toBe(true)
    await expect(
      applicationRepository.consumeCredential(credential.credentialId, 1, baseNow)
    ).resolves.toBe('revoked')
  })

  async function restrictApplicationIdentityPrivileges() {
    await isolated.withMigrationDatabase(async (database) => {
      await database.execute(
        sql`revoke all privileges on table public.runtime_node_verification_keys from control_plane_app`
      )
      await database.execute(
        sql`grant select on table public.runtime_node_verification_keys to control_plane_app`
      )
      await database.execute(
        sql`revoke all privileges on table public.runtime_node_issued_credentials from control_plane_app`
      )
      await database.execute(
        sql`grant select on table public.runtime_node_issued_credentials to control_plane_app`
      )
      await database.execute(
        sql`grant update (consumed_at) on table public.runtime_node_issued_credentials to control_plane_app`
      )
    })
  }

  async function registerKey() {
    const key = makeVerificationKey()
    return migrationRepository((repository) => repository.registerVerificationKey(key))
  }

  async function migrationRepository(operation) {
    return isolated.withMigrationDatabase((database) =>
      operation(new PostgresRuntimeNodeIdentityRepository(database))
    )
  }
})

function makeVerificationKey({ keyId = makeKeyId(), node = nodeId, workspace = workspaceId } = {}) {
  const { publicKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const thumbprint = `sha256:${createHash('sha256')
    .update(publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex')}`
  return {
    keyId,
    nodeId: node,
    workspaceId: workspace,
    publicKeyPem,
    thumbprint,
    status: 'active',
  }
}

function makeIssuedCredential(
  key,
  {
    credentialId = makeCredentialId(),
    nodeId: issuedNodeId = key.nodeId,
    workspaceId: issuedWorkspaceId = key.workspaceId,
    expiresAt = '2026-09-28T12:05:00.000Z',
  } = {}
) {
  const claims = RuntimeNodeCredentialClaimsSchema.parse({
    schemaVersion: 1,
    credentialKind: 'runtime_node',
    credentialId,
    issuer: 'https://identity.example.test/runtime-nodes',
    audience: 'control-plane-runtime-gateway',
    nodeId: issuedNodeId,
    workspaceId: issuedWorkspaceId,
    keyId: key.keyId,
    proofKeyThumbprint: key.thumbprint,
    revocationVersion: 1,
    channelGeneration: 1,
    issuedAt,
    expiresAt,
  })
  return {
    credentialId: claims.credentialId,
    nodeId: claims.nodeId,
    workspaceId: claims.workspaceId,
    keyId: claims.keyId,
    claims,
    revocationVersion: claims.revocationVersion,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  }
}

function makeKeyId() {
  return `rgk_${randomUUID().replaceAll('-', '')}`
}

function makeCredentialId() {
  return `rgc_${randomUUID().replaceAll('-', '')}`
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for PostgreSQL notification')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
