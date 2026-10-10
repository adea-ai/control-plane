import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import process from 'node:process'
import { CredentialApiFixtures } from '@control-plane/contracts'
import {
  ConfiguredCredentialRevocationChecker,
  Ed25519ServiceCredentialVerifier,
  PolicyServiceAuthenticator,
  RepositoryRuntimeNodeCredentialRevocationService,
  createControlApiApplication,
} from '@control-plane/control-api'
import { loadDatabaseCredentials, loadDatabaseSessionCredentials } from '@control-plane/config'
import {
  PostgresRuntimeNodeIdentityRepository,
  createPostgresConnection,
} from '@control-plane/database'
import { createIsolatedTestDatabase, integrationTestTimeout } from '@control-plane/database/testing'
import {
  PostgresRuntimeNodeIdentityValidationPort,
  RuntimeNodeChannelAuthenticator,
  runtimeNodePublicKeyThumbprint,
} from '@control-plane/runtime-gateway'
import {
  RuntimeNodeCredentialClaimsSchema,
  runtimeNodeWebSocketChallenge,
} from '@control-plane/runtime-gateway-protocol'

// Disposable PostgreSQL proof for the hosted RuntimeNode revocation route. The route runs under the
// application role, which holds EXECUTE on the migration-owned revocation function and no write
// privilege on the identity tables or the audit table. The privilege block below mirrors the
// migrations (0054 and 0069). Every key is ephemeral test material generated for this run. No real
// credential, grant, or security setting is read or changed.

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const ISSUER = 'https://identity.example.test/runtime-nodes'
const RUNTIME_AUDIENCE = 'control-plane-runtime-gateway'
const ISSUER_KEY_ID = 'rnr-revocation-issuer-v1'
const CONTROL_ISSUER = 'https://runtime-node-revocation.example'
const CONTROL_AUDIENCE = 'control-plane'
const CONTROL_KEY_ID = 'rnr-revocation-operator-v1'
const CONTROL_PRINCIPAL = 'svc_agent-hq'
const WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFG'
const OTHER_WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEGH'
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const metadata = {
  serviceName: 'control-api',
  version: 'test',
  commitSha: 'test',
  environment: 'test',
  instanceId: 'runtime-node-revocation-integration',
}
const issuerKeys = generateKeyPairSync('ed25519')
const issuerPublicPem = issuerKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const controlKeys = generateKeyPairSync('ed25519')

describe.skipIf(!enabled)('hosted RuntimeNode credential revocation over PostgreSQL', () => {
  let isolated
  let notificationConnection
  let gatewayRepository
  let gatewayPort
  let authenticator
  let control

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
    await applyProductionPrivileges()

    const credentials = loadDatabaseSessionCredentials(process.env)
    const notificationUrl = new URL(credentials.url)
    notificationUrl.pathname = `/${isolated.name}`
    notificationConnection = createPostgresConnection(
      { ...credentials, url: notificationUrl.toString() },
      { maxConnections: 1 }
    )
    gatewayRepository = new PostgresRuntimeNodeIdentityRepository(isolated.application, {
      revocationClient: notificationConnection.database.$client,
    })
    gatewayPort = gatewayPortFor(gatewayRepository)
    await gatewayPort.startRevocationListener()
    authenticator = new RuntimeNodeChannelAuthenticator({
      identityValidator: gatewayPort,
      logger: { write: () => undefined },
    })

    // The route is wired over the application role, exactly as the hosted composition is.
    control = await controlApiFor(
      new RepositoryRuntimeNodeCredentialRevocationService({ repository: gatewayRepository })
    )
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    try {
      await control?.close()
      authenticator?.close()
      await gatewayPort?.close()
      await notificationConnection?.close()
    } finally {
      await isolated?.dispose()
    }
  })

  test(
    'an authorized revocation through the application role invalidates the channel, refuses re-authentication, and replays without a second notification',
    async () => {
      const provisioned = await provisionCredential()
      const channel = await authenticate(authenticator, provisioned)
      const observed = []
      const unsubscribe = gatewayPort.subscribeRevocations((invalidation) =>
        observed.push(invalidation)
      )
      try {
        const first = await revoke(control, provisioned.credentialId, WORKSPACE)
        expect(first.statusCode).toBe(200)
        expect(first.json().data.credential).toMatchObject({
          credentialId: provisioned.credentialId,
          nodeId: provisioned.nodeId,
          workspaceId: WORKSPACE,
          revocationVersion: 2,
        })

        await waitFor(() => channel.invalidatedReason === 'revoked')
        await expect(channel.assertActive()).rejects.toMatchObject({
          code: 'RUNTIME_NODE_CREDENTIAL_REVOKED',
        })
        // The signed claims still carry revocation version 1 while the durable version is 2, so
        // the gateway refuses the stale credential during verification, before any new channel.
        const reauthentication = await authenticate(authenticator, provisioned).catch(
          (error) => error
        )
        expect(reauthentication.code).toBe('RUNTIME_NODE_CREDENTIAL_MALFORMED')

        const replay = await revoke(control, provisioned.credentialId, WORKSPACE)
        expect(replay.statusCode).toBe(200)
        expect(replay.json().data.credential).toEqual(first.json().data.credential)
        expect(await storedCredential(provisioned.credentialId)).toMatchObject({
          revocationVersion: 2,
        })
        await settle()
        expect(
          observed.filter((item) => item.credentialId === provisioned.credentialId)
        ).toHaveLength(1)

        expect(await auditOutcomes(provisioned.credentialId)).toEqual([
          { outcome: 'applied', principalRef: CONTROL_PRINCIPAL, revocationVersion: 2 },
          { outcome: 'replayed', principalRef: CONTROL_PRINCIPAL, revocationVersion: 2 },
        ])
      } finally {
        unsubscribe()
      }
    },
    integrationTestTimeout(30_000)
  )

  test(
    'a stale channel is refused by the durable recheck even when no notification reaches it',
    async () => {
      const port = gatewayPortFor(gatewayRepository)
      const isolatedAuthenticator = new RuntimeNodeChannelAuthenticator({
        identityValidator: port,
        logger: { write: () => undefined },
      })
      try {
        const provisioned = await provisionCredential()
        const channel = await authenticate(isolatedAuthenticator, provisioned)
        const revoked = await revoke(control, provisioned.credentialId, WORKSPACE)
        expect(revoked.statusCode).toBe(200)
        expect(channel.invalidatedReason).toBeUndefined()

        await expect(channel.assertActive()).rejects.toMatchObject({
          code: 'RUNTIME_NODE_CREDENTIAL_REVOKED',
        })
        expect(channel.invalidatedReason).toBe('revoked')
      } finally {
        isolatedAuthenticator.close()
      }
    },
    integrationTestTimeout(30_000)
  )

  test(
    'a read-only principal is refused before any state change or audit row, and its channel stays active',
    async () => {
      const provisioned = await provisionCredential()
      const channel = await authenticate(authenticator, provisioned)

      const response = await revoke(control, provisioned.credentialId, WORKSPACE, {
        scopes: ['credential:read'],
      })
      expect(response.statusCode).toBe(403)
      expect(await storedCredential(provisioned.credentialId)).toMatchObject({
        revocationVersion: 1,
        revokedAt: null,
      })
      expect(await auditOutcomes(provisioned.credentialId)).toEqual([])
      await expect(channel.assertActive()).resolves.toBeUndefined()
    },
    integrationTestTimeout(30_000)
  )

  test(
    'a caller that is not the authenticated principal is refused before any state change or audit row',
    async () => {
      const provisioned = await provisionCredential()
      const channel = await authenticate(authenticator, provisioned)

      const wrongCaller = await revoke(control, provisioned.credentialId, WORKSPACE, {
        caller: 'svc_someone-else',
      })
      expect(wrongCaller.statusCode).toBe(403)
      expect(await storedCredential(provisioned.credentialId)).toMatchObject({
        revocationVersion: 1,
        revokedAt: null,
      })
      expect(await auditOutcomes(provisioned.credentialId)).toEqual([])
      await expect(channel.assertActive()).resolves.toBeUndefined()
    },
    integrationTestTimeout(30_000)
  )

  test(
    'a credential bound to another workspace is refused and audited without a state change',
    async () => {
      const provisioned = await provisionCredential()
      const channel = await authenticate(authenticator, provisioned)

      const wrongWorkspace = await revoke(control, provisioned.credentialId, OTHER_WORKSPACE, {
        principalWorkspaces: [WORKSPACE, OTHER_WORKSPACE],
      })
      expect(wrongWorkspace.statusCode).toBe(404)
      expect(wrongWorkspace.json().error.code).toBe('RUNTIME_NODE_CREDENTIAL_NOT_FOUND')

      expect(await storedCredential(provisioned.credentialId)).toMatchObject({
        revocationVersion: 1,
        revokedAt: null,
      })
      expect(await auditOutcomes(provisioned.credentialId)).toEqual([
        { outcome: 'workspace_refused', principalRef: CONTROL_PRINCIPAL, revocationVersion: null },
      ])
      await expect(channel.assertActive()).resolves.toBeUndefined()
    },
    integrationTestTimeout(30_000)
  )

  test(
    'an unknown credential is refused without an audit row, so unknown identifiers cannot flood the trail',
    async () => {
      const unknownId = `rgc_${randomUUID().replaceAll('-', '')}`
      const response = await revoke(control, unknownId, WORKSPACE)
      expect(response.statusCode).toBe(404)
      expect(await auditOutcomes(unknownId)).toEqual([])
    },
    integrationTestTimeout(30_000)
  )

  test(
    'the application role cannot write or read the identity or audit tables directly',
    async () => {
      const provisioned = await provisionCredential()
      const attempts = [
        `update public.runtime_node_issued_credentials set revoked_at = now(), revocation_version = 2 where credential_id = '${provisioned.credentialId}'`,
        `update public.runtime_node_issued_credentials set expires_at = now() where credential_id = '${provisioned.credentialId}'`,
        `insert into public.runtime_node_credential_audit_events (action, outcome, credential_id, workspace_id, principal_ref) values ('revoke', 'applied', '${provisioned.credentialId}', '${WORKSPACE}', 'forged')`,
        `select count(*) from public.runtime_node_credential_audit_events`,
        `update public.runtime_node_verification_keys set status = 'revoked'`,
      ]
      for (const statement of attempts) {
        const error = await isolated.application.execute(statement).then(
          () => undefined,
          (caught) => caught
        )
        expect(error, statement).toBeDefined()
        expect(databaseErrorCode(error), statement).toBe('42501')
      }
      expect(await storedCredential(provisioned.credentialId)).toMatchObject({
        revocationVersion: 1,
        revokedAt: null,
      })
      expect(await auditOutcomes(provisioned.credentialId)).toEqual([])
    },
    integrationTestTimeout(30_000)
  )

  test(
    'the audit trail is append-only even for the migration owner',
    async () => {
      const provisioned = await provisionCredential()
      const revoked = await revoke(control, provisioned.credentialId, WORKSPACE)
      expect(revoked.statusCode).toBe(200)
      const mutation = await isolated
        .withMigrationDatabase((database) =>
          database.execute(
            `update public.runtime_node_credential_audit_events set outcome = 'replayed' where credential_id = '${provisioned.credentialId}'`
          )
        )
        .then(
          () => undefined,
          (caught) => caught
        )
      expect(errorMessages(mutation)).toContain('RUNTIME_NODE_CREDENTIAL_AUDIT_IMMUTABLE')
      expect(await auditOutcomes(provisioned.credentialId)).toEqual([
        { outcome: 'applied', principalRef: CONTROL_PRINCIPAL, revocationVersion: 2 },
      ])
    },
    integrationTestTimeout(30_000)
  )

  test(
    'the operator path under the migration role revokes through the same function and records its own principal',
    async () => {
      const provisioned = await provisionCredential()
      const channel = await authenticate(authenticator, provisioned)
      const revokedAt = new Date()
      const revokedRecord = await migrationRepository((repository) =>
        repository.revokeCredential(provisioned.credentialId, revokedAt)
      )
      expect(revokedRecord).toMatchObject({ revocationVersion: 2 })
      await waitFor(() => channel.invalidatedReason === 'revoked')
      expect(await auditOutcomes(provisioned.credentialId)).toEqual([
        { outcome: 'applied', principalRef: 'control_plane_migrator', revocationVersion: 2 },
      ])
    },
    integrationTestTimeout(30_000)
  )

  // Mirrors the deployed privilege contract: migration 0054 for the identity tables and migration
  // 0069 for the audit table and revocation function. The isolated database grants broader table
  // access to the application role, so the proof re-applies the production shape after migration.
  async function applyProductionPrivileges() {
    await isolated.withMigrationDatabase(async (database) => {
      await database.execute(
        'revoke all privileges on table public.runtime_node_verification_keys from control_plane_app'
      )
      await database.execute(
        'grant select on table public.runtime_node_verification_keys to control_plane_app'
      )
      await database.execute(
        'revoke all privileges on table public.runtime_node_issued_credentials from control_plane_app'
      )
      await database.execute(
        'grant select on table public.runtime_node_issued_credentials to control_plane_app'
      )
      await database.execute(
        'grant update (consumed_at) on table public.runtime_node_issued_credentials to control_plane_app'
      )
      await database.execute(
        'revoke all privileges on table public.runtime_node_credential_audit_events from control_plane_app'
      )
      await database.execute(
        'revoke all on function public.revoke_runtime_node_credential(varchar, varchar, varchar, timestamp with time zone) from public'
      )
      await database.execute(
        'grant execute on function public.revoke_runtime_node_credential(varchar, varchar, varchar, timestamp with time zone) to control_plane_app'
      )
    })
  }

  function migrationRepository(operation) {
    return isolated.withMigrationDatabase((database) =>
      operation(new PostgresRuntimeNodeIdentityRepository(database))
    )
  }

  async function storedCredential(credentialId) {
    return migrationRepository((repository) => repository.getIssuedCredential(credentialId))
  }

  async function auditOutcomes(credentialId) {
    return isolated.withMigrationDatabase(async (database) => {
      const rows = await database.execute(`
        select outcome, principal_ref as "principalRef", revocation_version as "revocationVersion"
        from public.runtime_node_credential_audit_events
        where credential_id = '${credentialId}'
        order by sequence
      `)
      return [...rows].map((row) => ({
        outcome: row.outcome,
        principalRef: row.principalRef,
        revocationVersion: row.revocationVersion === null ? null : Number(row.revocationVersion),
      }))
    })
  }

  async function provisionCredential() {
    // A fresh node per credential: the gateway keeps one active channel per node, and a second
    // channel for the same node must present a higher generation.
    const nodeId = randomNodeId()
    const device = generateKeyPairSync('ed25519')
    const devicePublicPem = device.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const thumbprint = runtimeNodePublicKeyThumbprint(devicePublicPem)
    const keyId = `rgk_${randomUUID().replaceAll('-', '')}`
    await migrationRepository((repository) =>
      repository.registerVerificationKey({
        keyId,
        nodeId,
        workspaceId: WORKSPACE,
        publicKeyPem: devicePublicPem,
        thumbprint,
        status: 'active',
      })
    )
    const credentialId = `rgc_${randomUUID().replaceAll('-', '')}`
    const issuedAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    const claims = RuntimeNodeCredentialClaimsSchema.parse({
      schemaVersion: 1,
      credentialKind: 'runtime_node',
      credentialId,
      issuer: ISSUER,
      audience: RUNTIME_AUDIENCE,
      nodeId,
      workspaceId: WORKSPACE,
      keyId,
      proofKeyThumbprint: thumbprint,
      revocationVersion: 1,
      channelGeneration: 1,
      issuedAt,
      expiresAt,
    })
    await migrationRepository((repository) =>
      repository.insertIssuedCredential({
        credentialId,
        nodeId,
        workspaceId: WORKSPACE,
        keyId,
        claims,
        revocationVersion: 1,
        issuedAt,
        expiresAt,
      })
    )
    return { credentialId, nodeId, claims, devicePrivateKey: device.privateKey }
  }

  function gatewayPortFor(repository) {
    return new PostgresRuntimeNodeIdentityValidationPort(
      repository,
      new Map([[ISSUER_KEY_ID, issuerPublicPem]])
    )
  }
})

function randomNodeId() {
  return `rnr_${Array.from(randomBytes(26), (byte) => CROCKFORD[byte % CROCKFORD.length]).join('')}`
}

function signCredential(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${encode({ alg: 'EdDSA', typ: 'RNGC', kid: ISSUER_KEY_ID })}.${encode(claims)}`
  return `${signingInput}.${sign(null, Buffer.from(signingInput), issuerKeys.privateKey).toString('base64url')}`
}

async function authenticate(channelAuthenticator, provisioned) {
  const challenge = runtimeNodeWebSocketChallenge(randomBytes(16).toString('base64'))
  const credential = signCredential(provisioned.claims)
  const proofInput = `${createHash('sha256').update(credential).digest('base64url')}.${challenge}`
  const signature = sign(null, Buffer.from(proofInput), provisioned.devicePrivateKey).toString(
    'base64url'
  )
  return channelAuthenticator.authenticate(
    { credential, proof: { challenge, signature } },
    {
      issuer: ISSUER,
      audience: RUNTIME_AUDIENCE,
      nodeId: provisioned.nodeId,
      workspaceId: WORKSPACE,
      channelGeneration: 1,
      challenge,
    }
  )
}

async function controlApiFor(revocationService) {
  const verifier = new Ed25519ServiceCredentialVerifier([
    { keyId: CONTROL_KEY_ID, publicKey: controlKeys.publicKey.export({ format: 'jwk' }).x },
  ])
  const application = await createControlApiApplication({
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    metadata,
    logger: { write: () => undefined },
    serviceAuthenticator: new PolicyServiceAuthenticator({
      audience: CONTROL_AUDIENCE,
      issuer: CONTROL_ISSUER,
      clockSkewMs: 30_000,
      now: () => new Date(),
      logger: { write: () => undefined },
      verifier,
      revocationChecker: new ConfiguredCredentialRevocationChecker([]),
    }),
    runtimeNodeCredentialRevocationService: revocationService,
  })
  return { application, close: () => application.close() }
}

function controlBearer({
  scopes = ['credential:write'],
  workspaceIds = [WORKSPACE, OTHER_WORKSPACE],
} = {}) {
  const claims = {
    audience: CONTROL_AUDIENCE,
    credentialId: 'credential-runtime-node-revocation-integration',
    credentialKind: 'service',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    issuer: CONTROL_ISSUER,
    keyId: CONTROL_KEY_ID,
    principalId: CONTROL_PRINCIPAL,
    projectIds: [],
    scopes,
    workspaceIds,
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: CONTROL_KEY_ID })}.${encode(claims)}`
  return `${signingInput}.${sign(null, Buffer.from(signingInput), controlKeys.privateKey).toString('base64url')}`
}

async function revoke(control, credentialId, workspaceId, options = {}) {
  const base = CredentialApiFixtures.revoke.request
  return control.application.inject({
    method: 'POST',
    url: '/v1/runtime-node-credentials/revoke',
    headers: {
      authorization: `Bearer ${controlBearer({
        scopes: options.scopes,
        workspaceIds: options.principalWorkspaces ?? [WORKSPACE, OTHER_WORKSPACE],
      })}`,
    },
    payload: {
      ...base,
      operation: 'runtime-node-credential.revoke',
      workspaceId,
      caller: { servicePrincipalId: options.caller ?? CONTROL_PRINCIPAL },
      idempotencyKey: `runtime-node-revoke-${randomUUID().slice(0, 8)}`,
      payload: { credentialId },
    },
  })
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for gateway invalidation')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 250))
}

function databaseErrorCode(error) {
  let current = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const code = Reflect.get(current, 'code')
    if (typeof code === 'string') return code
    current = Reflect.get(current, 'cause')
  }
  return undefined
}

function errorMessages(error) {
  const messages = []
  let current = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const message = Reflect.get(current, 'message')
    if (typeof message === 'string') messages.push(message)
    current = Reflect.get(current, 'cause')
  }
  return messages.join('\n')
}
