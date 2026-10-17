import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  PostgresRuntimeChannelOwnershipRepository,
  PostgresRuntimeNodeIdentityRepository,
} from '@control-plane/database'
import { createIsolatedTestDatabase, integrationTestTimeout } from '@control-plane/database/testing'
import {
  RuntimeNodeCredentialClaimsSchema,
  runtimeNodeWebSocketChallenge,
} from '@control-plane/runtime-gateway-protocol'
import { RuntimeNodeChannelAuthenticator } from './authentication.ts'
import {
  authenticateRuntimeNodeUpgrade,
  PostgresRuntimeNodeIdentityValidationPort,
  runtimeNodePublicKeyThumbprint,
} from './postgres-runtime-node-identity.ts'
import { RepositoryRuntimeNodeCoordination } from './websocket-coordination.ts'

// The production upgrade path against PostgreSQL: a signed credential is admitted only when its
// node, workspace, and channel generation agree with the canonical owner and the credential is not
// revoked. A rejected attempt leaves the credential unconsumed, and a racing revocation is fenced.
const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const issuer = 'https://identity.example.test/runtime-nodes'
const audience = 'control-plane-runtime-gateway'
const issuerKeyId = 'operator-issuer-v1'
const websocketKey = 'dGhlIHNhbXBsZSBub25jZQ=='
const challenge = runtimeNodeWebSocketChallenge(websocketKey)
const silentLogger = { write() {} }
const operator = generateKeyPairSync('ed25519')
const operatorPem = operator.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const trust = {
  issuer,
  audience,
  issuerPublicKeys: new Map([[issuerKeyId, operatorPem]]),
}

// The Postgres fences compare expiry with the database clock, so the window is anchored to real time.
const now = new Date()
const issuedAt = new Date(now.getTime() - 60_000).toISOString()
const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString()

function ulid26() {
  return Array.from(randomBytes(26), (byte) => CROCKFORD[byte % 32]).join('')
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function sha256Base64url(value) {
  return createHash('sha256').update(value).digest('base64url')
}

// The predecessor chain is the candidate chain without its last journal entry, which is the candidate.
async function predecessorMigrationFolder() {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-gateway-predecessor-'))
  const source = fileURLToPath(new URL('../../../packages/database/drizzle', import.meta.url))
  await cp(source, directory, { recursive: true })
  const journalPath = join(directory, 'meta', '_journal.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  const candidate = journal.entries.at(-1)
  journal.entries = journal.entries.slice(0, -1)
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  await rm(join(directory, `${candidate.tag}.sql`))
  await rm(join(directory, 'meta', `${String(candidate.idx).padStart(4, '0')}_snapshot.json`))
  return directory
}

describe.skipIf(!enabled)(
  'PostgreSQL credential binding through the production upgrade path',
  () => {
    let isolated
    let validator
    let applicationIdentity
    let coordination
    let predecessorDirectory

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase({
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      })
      // Production-shaped: the predecessor chain is upgraded in place, and the application role holds
      // only migration-declared grants plus the ownership DML the existing claim path requires.
      predecessorDirectory = await predecessorMigrationFolder()
      await isolated.migrate({
        migrationsFolder: predecessorDirectory,
        applicationGrants: 'migrations-only',
      })
      await isolated.migrate({ applicationGrants: 'migrations-only' })
      const applicationRole = new URL(loadDatabaseCredentials(process.env, 'application').url)
        .username
      if (!/^[a-z_][a-z0-9_]*$/.test(applicationRole)) throw new Error('UNEXPECTED_ROLE_NAME')
      await isolated.withMigrationDatabase((database) =>
        database.$client.unsafe(
          `grant select, insert, update on table public.runtime_channel_ownership to ${applicationRole}`
        )
      )
      applicationIdentity = new PostgresRuntimeNodeIdentityRepository(isolated.application)
      validator = new PostgresRuntimeNodeIdentityValidationPort(
        applicationIdentity,
        trust.issuerPublicKeys
      )
      coordination = new RepositoryRuntimeNodeCoordination(
        new PostgresRuntimeChannelOwnershipRepository(isolated.application)
      )
    }, integrationTestTimeout(60_000))

    afterAll(async () => {
      if (predecessorDirectory !== undefined)
        await rm(predecessorDirectory, { recursive: true, force: true })
      await isolated?.dispose()
    })

    async function migration(operation) {
      return isolated.withMigrationDatabase((database) =>
        operation(new PostgresRuntimeNodeIdentityRepository(database))
      )
    }

    async function registerDevice(nodeId, workspaceId) {
      const pair = generateKeyPairSync('ed25519')
      const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
      const device = {
        keyId: `rgk_${randomBytes(16).toString('hex')}`,
        nodeId,
        workspaceId,
        privateKey: pair.privateKey,
        thumbprint: runtimeNodePublicKeyThumbprint(publicKeyPem),
      }
      await migration((repository) =>
        repository.registerVerificationKey({
          keyId: device.keyId,
          nodeId,
          workspaceId,
          publicKeyPem,
          thumbprint: device.thumbprint,
          status: 'active',
        })
      )
      return device
    }

    async function issueCredential(device, channelGeneration) {
      const credentialId = `rgc_${randomBytes(16).toString('hex')}`
      const claims = RuntimeNodeCredentialClaimsSchema.parse({
        schemaVersion: 1,
        credentialKind: 'runtime_node',
        credentialId,
        issuer,
        audience,
        nodeId: device.nodeId,
        workspaceId: device.workspaceId,
        keyId: device.keyId,
        proofKeyThumbprint: device.thumbprint,
        revocationVersion: 1,
        channelGeneration,
        issuedAt,
        expiresAt,
      })
      await migration((repository) =>
        repository.insertIssuedCredential({
          credentialId,
          nodeId: device.nodeId,
          workspaceId: device.workspaceId,
          keyId: device.keyId,
          claims,
          revocationVersion: 1,
          issuedAt,
          expiresAt,
        })
      )
      return { credentialId, credential: signCredential(claims), device }
    }

    function signCredential(claims) {
      const header = encode({ alg: 'EdDSA', typ: 'RNGC', kid: issuerKeyId })
      const signingInput = `${header}.${encode(claims)}`
      return `${signingInput}.${sign(null, Buffer.from(signingInput), operator.privateKey).toString('base64url')}`
    }

    function upgradeRequest({ credential, device }) {
      const proof = sign(
        null,
        Buffer.from(`${sha256Base64url(credential)}.${challenge}`),
        device.privateKey
      ).toString('base64url')
      return new Request('https://gateway.example.test/runtime-gateway/v1/connect', {
        headers: {
          authorization: `RuntimeNode ${credential}`,
          'x-runtime-node-proof': proof,
          'sec-websocket-key': websocketKey,
        },
      })
    }

    // A fresh authenticator per attempt has no in-memory channel state, so only PostgreSQL decides.
    async function admit(presented) {
      const authenticator = new RuntimeNodeChannelAuthenticator({
        identityValidator: validator,
        logger: silentLogger,
        now: () => new Date(),
      })
      try {
        const channel = await authenticateRuntimeNodeUpgrade(
          upgradeRequest(presented),
          authenticator,
          trust
        )
        return { channel }
      } catch (error) {
        authenticator.close()
        return { code: error.code }
      }
    }

    async function claimOwnership(presented, channelGeneration) {
      const { device, credentialId } = presented
      return coordination.claim(
        {
          nodeId: device.nodeId,
          workspaceId: device.workspaceId,
          gatewayInstanceId: 'gateway-binding-e2e',
          connectionId: `connection-${channelGeneration}`,
          channelGeneration,
          protocolVersion: { major: 1, minor: 0 },
          connectedAt: now.toISOString(),
          lastHeartbeatAt: now.toISOString(),
        },
        { credentialId, revocationVersion: 1 }
      )
    }

    async function unconsumed(credentialId) {
      const record = await migration((repository) => repository.getIssuedCredential(credentialId))
      return record.consumedAt === null
    }

    test(
      'the upgrade path admits only the canonical owner workspace and generation, and fails closed on the rest',
      async () => {
        const nodeId = `rnr_${ulid26()}`
        const owner = `wsp_${ulid26()}`
        const other = `wsp_${ulid26()}`
        const ownerDevice = await registerDevice(nodeId, owner)
        const otherDevice = await registerDevice(nodeId, other)

        const first = await issueCredential(ownerDevice, 1)
        const admitted = await admit(first)
        expect(admitted.channel).toBeDefined()
        expect(await claimOwnership(first, 1)).toMatchObject({ accepted: true })

        const wrongWorkspace = await issueCredential(otherDevice, 2)
        expect(await admit(wrongWorkspace)).toEqual({
          code: 'RUNTIME_NODE_CREDENTIAL_WORKSPACE_MISMATCH',
        })
        expect(await unconsumed(wrongWorkspace.credentialId)).toBe(true)

        // A signed credential naming another node with this device's key has no issued record, so it fails closed.
        const misdirectedClaims = RuntimeNodeCredentialClaimsSchema.parse({
          schemaVersion: 1,
          credentialKind: 'runtime_node',
          credentialId: `rgc_${randomBytes(16).toString('hex')}`,
          issuer,
          audience,
          nodeId: `rnr_${ulid26()}`,
          workspaceId: owner,
          keyId: ownerDevice.keyId,
          proofKeyThumbprint: ownerDevice.thumbprint,
          revocationVersion: 1,
          channelGeneration: 3,
          issuedAt,
          expiresAt,
        })
        const misdirected = {
          credentialId: misdirectedClaims.credentialId,
          credential: signCredential(misdirectedClaims),
          device: ownerDevice,
        }
        expect(await admit(misdirected)).toEqual({ code: 'RUNTIME_NODE_CREDENTIAL_MALFORMED' })
        expect(
          await migration((repository) => repository.getIssuedCredential(misdirected.credentialId))
        ).toBeUndefined()

        const next = await issueCredential(ownerDevice, 2)
        expect((await admit(next)).channel).toBeDefined()
        expect(await claimOwnership(next, 2)).toMatchObject({ accepted: true })

        const superseded = await issueCredential(ownerDevice, 1)
        expect(await admit(superseded)).toEqual({
          code: 'RUNTIME_NODE_CHANNEL_GENERATION_SUPERSEDED',
        })
        expect(await unconsumed(superseded.credentialId)).toBe(true)

        expect(await admit(next)).toEqual({ code: 'RUNTIME_NODE_CREDENTIAL_REPLAYED' })

        const revoked = await issueCredential(ownerDevice, 3)
        await migration((repository) => repository.revokeCredential(revoked.credentialId, now))
        expect(await admit(revoked)).toEqual({ code: 'RUNTIME_NODE_CREDENTIAL_REVOKED' })
        expect(await unconsumed(revoked.credentialId)).toBe(true)
      },
      integrationTestTimeout(120_000)
    )

    test(
      'a revocation racing the upgrade admission never leaves an accepted ownership claim',
      async () => {
        for (let iteration = 0; iteration < 5; iteration += 1) {
          const nodeId = `rnr_${ulid26()}`
          const workspaceId = `wsp_${ulid26()}`
          const device = await registerDevice(nodeId, workspaceId)
          const presented = await issueCredential(device, 1)
          const [admission] = await Promise.all([
            admit(presented),
            migration((repository) => repository.revokeCredential(presented.credentialId, now)),
          ])
          expect(
            admission.channel !== undefined || admission.code === 'RUNTIME_NODE_CREDENTIAL_REVOKED'
          ).toBe(true)
          expect(await claimOwnership(presented, 1)).toMatchObject({ accepted: false })
        }
      },
      integrationTestTimeout(180_000)
    )
  }
)
