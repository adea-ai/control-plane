import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { RuntimeNodeCredentialClaimsSchema } from '@control-plane/runtime-gateway-protocol'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresRuntimeChannelOwnershipRepository } from './runtime-channel-ownership-repository.ts'
import { PostgresRuntimeNodeIdentityRepository } from './runtime-node-identity-repository.ts'

// Store-path proofs for the canonical binding of a presented credential: the fenced consumption
// rejects a wrong node, a wrong workspace, and a superseded generation without consuming the
// credential, and a revocation racing consumption or channel claim is fenced by PostgreSQL.
const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
// The ownership fence checks expiry against the database clock, so the validity window is anchored to
// the real clock rather than to a fixed fixture instant.
const now = new Date()
const issuedAt = new Date(now.getTime() - 60_000).toISOString()
const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString()
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function ulid26() {
  return Array.from(randomBytes(26), (byte) => CROCKFORD[byte % 32]).join('')
}

function nodeIdentifier() {
  return `rnr_${ulid26()}`
}

function workspaceIdentifier() {
  return `wsp_${ulid26()}`
}

function randomIdentifier(prefix) {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}

function makeKeyPair() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const thumbprint = `sha256:${createHash('sha256')
    .update(publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex')}`
  return { publicKeyPem, thumbprint }
}

function ownershipRecord({ nodeId, workspaceId, channelGeneration }) {
  return {
    nodeId,
    workspaceId,
    gatewayInstanceId: 'gateway-binding-proof',
    connectionId: `connection-${channelGeneration}`,
    channelGeneration,
    protocolVersion: { major: 1, minor: 0 },
    connectedAt: now.toISOString(),
    lastHeartbeatAt: now.toISOString(),
  }
}

describe.skipIf(!enabled)('PostgreSQL RuntimeNode credential canonical binding', () => {
  let isolated
  let applicationIdentity
  let applicationOwnership

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
    applicationIdentity = new PostgresRuntimeNodeIdentityRepository(isolated.application)
    applicationOwnership = new PostgresRuntimeChannelOwnershipRepository(isolated.application)
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    await isolated?.dispose()
  })

  async function migration(operation) {
    return isolated.withMigrationDatabase((database) =>
      operation(new PostgresRuntimeNodeIdentityRepository(database))
    )
  }

  async function registerKey(nodeId, workspaceId) {
    const pair = makeKeyPair()
    const key = {
      keyId: randomIdentifier('rgk'),
      nodeId,
      workspaceId,
      publicKeyPem: pair.publicKeyPem,
      thumbprint: pair.thumbprint,
      status: 'active',
    }
    await migration((repository) => repository.registerVerificationKey(key))
    return key
  }

  async function issueCredential(
    key,
    { channelGeneration, credentialId = randomIdentifier('rgc') }
  ) {
    const claims = RuntimeNodeCredentialClaimsSchema.parse({
      schemaVersion: 1,
      credentialKind: 'runtime_node',
      credentialId,
      issuer: 'https://identity.example.test/runtime-nodes',
      audience: 'control-plane-runtime-gateway',
      nodeId: key.nodeId,
      workspaceId: key.workspaceId,
      keyId: key.keyId,
      proofKeyThumbprint: key.thumbprint,
      revocationVersion: 1,
      channelGeneration,
      issuedAt,
      expiresAt,
    })
    await migration((repository) =>
      repository.insertIssuedCredential({
        credentialId,
        nodeId: key.nodeId,
        workspaceId: key.workspaceId,
        keyId: key.keyId,
        claims,
        revocationVersion: 1,
        issuedAt,
        expiresAt,
      })
    )
    return { credentialId }
  }

  async function unconsumed(credentialId) {
    const record = await migration((repository) => repository.getIssuedCredential(credentialId))
    return record.consumedAt === null
  }

  async function establishOwner(nodeId, workspaceId, channelGeneration) {
    const key = await registerKey(nodeId, workspaceId)
    const { credentialId } = await issueCredential(key, { channelGeneration })
    const consumed = await applicationIdentity.consumeCredential(credentialId, 1, now, {
      nodeId,
      workspaceId,
      channelGeneration,
    })
    expect(consumed).toBe('consumed')
    const claimed = await applicationOwnership.claim(
      ownershipRecord({ nodeId, workspaceId, channelGeneration }),
      { credentialId, revocationVersion: 1 }
    )
    expect(claimed.accepted).toBe(true)
    return { key, credentialId }
  }

  test(
    'a credential for another workspace is rejected by the fenced consumption and stays unconsumed',
    async () => {
      const nodeId = nodeIdentifier()
      const owner = workspaceIdentifier()
      const other = workspaceIdentifier()
      const established = await establishOwner(nodeId, owner, 1)
      const otherKey = await registerKey(nodeId, other)
      const wrong = await issueCredential(otherKey, { channelGeneration: 2 })

      expect(
        await applicationIdentity.consumeCredential(wrong.credentialId, 1, now, {
          nodeId,
          workspaceId: other,
          channelGeneration: 2,
        })
      ).toBe('workspace_mismatch')
      expect(await unconsumed(wrong.credentialId)).toBe(true)

      const correct = await issueCredential(established.key, { channelGeneration: 2 })
      expect(
        await applicationIdentity.consumeCredential(correct.credentialId, 1, now, {
          nodeId,
          workspaceId: owner,
          channelGeneration: 2,
        })
      ).toBe('consumed')
      expect(
        await applicationOwnership.claim(
          ownershipRecord({ nodeId, workspaceId: owner, channelGeneration: 2 }),
          { credentialId: correct.credentialId, revocationVersion: 1 }
        )
      ).toMatchObject({ accepted: true })
    },
    integrationTestTimeout(60_000)
  )

  test(
    'a superseded or equal channel generation is rejected inside the fence and stays unconsumed',
    async () => {
      const nodeId = nodeIdentifier()
      const workspaceId = workspaceIdentifier()
      const established = await establishOwner(nodeId, workspaceId, 2)

      const stale = await issueCredential(established.key, { channelGeneration: 1 })
      const equal = await issueCredential(established.key, { channelGeneration: 2 })
      for (const credential of [stale, equal]) {
        const channelGeneration = credential === stale ? 1 : 2
        expect(
          await applicationIdentity.consumeCredential(credential.credentialId, 1, now, {
            nodeId,
            workspaceId,
            channelGeneration,
          })
        ).toBe('superseded')
        expect(await unconsumed(credential.credentialId)).toBe(true)
      }

      const next = await issueCredential(established.key, { channelGeneration: 3 })
      expect(
        await applicationIdentity.consumeCredential(next.credentialId, 1, now, {
          nodeId,
          workspaceId,
          channelGeneration: 3,
        })
      ).toBe('consumed')
    },
    integrationTestTimeout(60_000)
  )

  test(
    'a binding for another node is rejected without consuming the presented credential',
    async () => {
      const nodeId = nodeIdentifier()
      const otherNode = nodeIdentifier()
      const workspaceId = workspaceIdentifier()
      const key = await registerKey(nodeId, workspaceId)
      const { credentialId } = await issueCredential(key, { channelGeneration: 1 })

      expect(
        await applicationIdentity.consumeCredential(credentialId, 1, now, {
          nodeId: otherNode,
          workspaceId,
          channelGeneration: 1,
        })
      ).toBe('node_mismatch')
      expect(await unconsumed(credentialId)).toBe(true)
      expect(
        await applicationIdentity.consumeCredential(credentialId, 1, now, {
          nodeId,
          workspaceId,
          channelGeneration: 1,
        })
      ).toBe('consumed')
    },
    integrationTestTimeout(60_000)
  )

  test(
    'a revoked credential cannot be consumed, and a consumed one cannot be claimed after revocation',
    async () => {
      const nodeId = nodeIdentifier()
      const workspaceId = workspaceIdentifier()
      const key = await registerKey(nodeId, workspaceId)
      const refused = await issueCredential(key, { channelGeneration: 1 })
      await migration((repository) => repository.revokeCredential(refused.credentialId, now))
      expect(
        await applicationIdentity.consumeCredential(refused.credentialId, 1, now, {
          nodeId,
          workspaceId,
          channelGeneration: 1,
        })
      ).toBe('revoked')
      expect(await unconsumed(refused.credentialId)).toBe(true)

      const claimed = await issueCredential(key, { channelGeneration: 2 })
      expect(
        await applicationIdentity.consumeCredential(claimed.credentialId, 1, now, {
          nodeId,
          workspaceId,
          channelGeneration: 2,
        })
      ).toBe('consumed')
      await migration((repository) => repository.revokeCredential(claimed.credentialId, now))
      expect(
        await applicationOwnership.claim(
          ownershipRecord({ nodeId, workspaceId, channelGeneration: 2 }),
          { credentialId: claimed.credentialId, revocationVersion: 1 }
        )
      ).toMatchObject({ accepted: false })
    },
    integrationTestTimeout(60_000)
  )

  test(
    'a consumption racing a revocation is totally ordered: consumed implies the revocation followed it',
    async () => {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const nodeId = nodeIdentifier()
        const workspaceId = workspaceIdentifier()
        const key = await registerKey(nodeId, workspaceId)
        const { credentialId } = await issueCredential(key, { channelGeneration: 1 })
        const binding = { nodeId, workspaceId, channelGeneration: 1 }
        const [consumption] = await Promise.all([
          applicationIdentity.consumeCredential(credentialId, 1, now, binding),
          migration((repository) => repository.revokeCredential(credentialId, now)),
        ])

        expect(['consumed', 'revoked']).toContain(consumption)
        const record = await migration((repository) => repository.getIssuedCredential(credentialId))
        expect(record.revokedAt).not.toBeNull()
        expect(record.consumedAt !== null).toBe(consumption === 'consumed')
        if (consumption === 'consumed') {
          expect(
            await applicationOwnership.claim(
              ownershipRecord({ nodeId, workspaceId, channelGeneration: 1 }),
              {
                credentialId,
                revocationVersion: 1,
              }
            )
          ).toMatchObject({ accepted: false })
        }
      }
    },
    integrationTestTimeout(120_000)
  )

  test(
    'consumption, ownership claim, and revocation racing on one node settle without deadlock or unfenced ownership',
    async () => {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const nodeId = nodeIdentifier()
        const workspaceId = workspaceIdentifier()
        const key = await registerKey(nodeId, workspaceId)
        const { credentialId } = await issueCredential(key, { channelGeneration: 1 })
        const binding = { nodeId, workspaceId, channelGeneration: 1 }
        const results = await Promise.allSettled([
          applicationIdentity.consumeCredential(credentialId, 1, now, binding),
          applicationOwnership.claim(
            ownershipRecord({ nodeId, workspaceId, channelGeneration: 1 }),
            {
              credentialId,
              revocationVersion: 1,
            }
          ),
          migration((repository) => repository.revokeCredential(credentialId, now)),
        ])
        expect(results.map((result) => result.status)).toEqual([
          'fulfilled',
          'fulfilled',
          'fulfilled',
        ])
        const [consumption, claim] = results.map((result) => result.value)
        if (claim.accepted) expect(consumption).toBe('consumed')
      }
    },
    integrationTestTimeout(120_000)
  )

  test(
    'malformed bindings are rejected as input errors before any write, and unbound consumption is unchanged',
    async () => {
      const nodeId = nodeIdentifier()
      const workspaceId = workspaceIdentifier()
      const key = await registerKey(nodeId, workspaceId)
      const { credentialId } = await issueCredential(key, { channelGeneration: 1 })
      for (const binding of [
        { nodeId: 'not-a-node', workspaceId, channelGeneration: 1 },
        { nodeId, workspaceId, channelGeneration: 0 },
      ]) {
        await expect(
          applicationIdentity.consumeCredential(credentialId, 1, now, binding)
        ).rejects.toMatchObject({ code: 'RUNTIME_NODE_IDENTITY_INVALID_INPUT' })
      }
      expect(await unconsumed(credentialId)).toBe(true)
      expect(await applicationIdentity.consumeCredential(credentialId, 1, now)).toBe('consumed')
    },
    integrationTestTimeout(60_000)
  )
})
