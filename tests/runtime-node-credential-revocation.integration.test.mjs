import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import process from 'node:process'
import { CredentialApiFixtures } from '@control-plane/contracts'
import {
  Ed25519ServiceCredentialVerifier,
  ConfiguredCredentialRevocationChecker,
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

// Disposable PostgreSQL proof for hosted RuntimeNode credential revocation. The control route,
// the existing revocation primitive, and the gateway's notification and durable-recheck path
// all run against an isolated database. Every key below is ephemeral test material generated
// for this run; no credential, issuer, or deployed grant is created or changed.
//
// The deployed application role holds no UPDATE on the revocation columns (migration 0054).
// Revocation therefore runs through the migration role in the control wiring below, which
// proves the revocation semantics; the application-role wiring proves the fail-closed refusal.

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
  let privilegedControl
  let applicationRoleControl

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
    await restrictApplicationPrivileges()

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

    privilegedControl = await controlApiFor(
      new RepositoryRuntimeNodeCredentialRevocationService({
        repository: {
          getIssuedCredential: (credentialId) =>
            migrationRepository((repository) => repository.getIssuedCredential(credentialId)),
          revokeCredential: (credentialId, now) =>
            migrationRepository((repository) => repository.revokeCredential(credentialId, now)),
        },
      })
    )
    applicationRoleControl = await controlApiFor(
      new RepositoryRuntimeNodeCredentialRevocationService({ repository: gatewayRepository })
    )
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    try {
      await privilegedControl?.close()
      await applicationRoleControl?.close()
      authenticator?.close()
      await gatewayPort?.close()
      await notificationConnection?.close()
    } finally {
      await isolated?.dispose()
    }
  })

  test(
    'an authorized revocation invalidates the authenticated channel, refuses re-authentication, and replays without a second notification',
    async () => {
      const provisioned = await provisionCredential()
      const channel = await authenticate(authenticator, provisioned)
      const observed = []
      const unsubscribe = gatewayPort.subscribeRevocations((invalidation) =>
        observed.push(invalidation)
      )
      try {
        const first = await revoke(privilegedControl, provisioned.credentialId, WORKSPACE)
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

        const replay = await revoke(privilegedControl, provisioned.credentialId, WORKSPACE)
        expect(replay.statusCode).toBe(200)
        expect(replay.json().data.credential).toEqual(first.json().data.credential)
        expect(
          await migrationRepository((repository) =>
            repository.getIssuedCredential(provisioned.credentialId)
          )
        ).toMatchObject({
          revocationVersion: 2,
        })
        await settle()
        expect(
          observed.filter((item) => item.credentialId === provisioned.credentialId)
        ).toHaveLength(1)
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
        const revoked = await revoke(privilegedControl, provisioned.credentialId, WORKSPACE)
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
    'a read-only principal is refused before any state change and its channel stays active',
    async () => {
      const provisioned = await provisionCredential()
      const channel = await authenticate(authenticator, provisioned)

      const response = await revoke(privilegedControl, provisioned.credentialId, WORKSPACE, {
        scopes: ['credential:read'],
      })
      expect(response.statusCode).toBe(403)
      expect(await storedCredential(provisioned.credentialId)).toMatchObject({
        revocationVersion: 1,
        revokedAt: null,
      })
      await expect(channel.assertActive()).resolves.toBeUndefined()
    },
    integrationTestTimeout(30_000)
  )

  test(
    'a caller that is not the authenticated principal, a wrong workspace, and an unknown credential are refused without a state change',
    async () => {
      const provisioned = await provisionCredential()
      const channel = await authenticate(authenticator, provisioned)

      const wrongCaller = await revoke(privilegedControl, provisioned.credentialId, WORKSPACE, {
        caller: 'svc_someone-else',
      })
      expect(wrongCaller.statusCode).toBe(403)

      const wrongWorkspace = await revoke(
        privilegedControl,
        provisioned.credentialId,
        OTHER_WORKSPACE,
        {
          principalWorkspaces: [WORKSPACE, OTHER_WORKSPACE],
        }
      )
      expect(wrongWorkspace.statusCode).toBe(404)
      expect(wrongWorkspace.json().error.code).toBe('RUNTIME_NODE_CREDENTIAL_NOT_FOUND')

      const unknown = await revoke(
        privilegedControl,
        `rgc_${randomUUID().replaceAll('-', '')}`,
        WORKSPACE
      )
      expect(unknown.statusCode).toBe(404)

      expect(await storedCredential(provisioned.credentialId)).toMatchObject({
        revocationVersion: 1,
        revokedAt: null,
      })
      await expect(channel.assertActive()).resolves.toBeUndefined()
    },
    integrationTestTimeout(30_000)
  )

  test(
    'the deployed application role is refused by the database and the control fails closed with no state change',
    async () => {
      const provisioned = await provisionCredential()
      const channel = await authenticate(authenticator, provisioned)

      const direct = await gatewayRepository
        .revokeCredential(provisioned.credentialId, new Date())
        .catch((error) => error)
      expect(databaseErrorCode(direct)).toBe('42501')

      const response = await revoke(applicationRoleControl, provisioned.credentialId, WORKSPACE)
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('RUNTIME_NODE_CREDENTIAL_REVOCATION_NOT_PERMITTED')
      expect(await storedCredential(provisioned.credentialId)).toMatchObject({
        revocationVersion: 1,
        revokedAt: null,
      })
      await expect(channel.assertActive()).resolves.toBeUndefined()
    },
    integrationTestTimeout(30_000)
  )

  async function restrictApplicationPrivileges() {
    // Mirrors the deployed grants from migration 0054 for the application role. The isolated
    // database grants broader table access for other suites; the proof must run on the real shape.
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

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

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
  return {
    close: () => application.close(),
    application,
  }
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
  const caller = options.caller ?? CONTROL_PRINCIPAL
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
      caller: { servicePrincipalId: caller },
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
