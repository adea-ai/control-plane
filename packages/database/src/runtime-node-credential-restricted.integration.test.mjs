import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { RuntimeNodeCredentialClaimsSchema } from '@control-plane/runtime-gateway-protocol'
import { sql } from 'drizzle-orm'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresRuntimeChannelOwnershipRepository } from './runtime-channel-ownership-repository.ts'
import { PostgresRuntimeNodeIdentityRepository } from './runtime-node-identity-repository.ts'

// Production-shaped proofs: the database is upgraded in place from the predecessor chain, and the
// application role holds only the grants the migrations declare plus the ownership DML the existing
// claim path already requires. Refusals stay fenced, and nothing is consumed on refusal.
const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
// The ownership fence checks expiry against the database clock, so the window is anchored to real time.
const now = new Date()
const issuedAt = new Date(now.getTime() - 60_000).toISOString()
const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString()

function ulid26() {
  return Array.from(randomBytes(26), (byte) => CROCKFORD[byte % 32]).join('')
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
    gatewayInstanceId: 'gateway-restricted-proof',
    connectionId: `connection-${channelGeneration}`,
    channelGeneration,
    protocolVersion: { major: 1, minor: 0 },
    connectedAt: now.toISOString(),
    lastHeartbeatAt: now.toISOString(),
  }
}

// The predecessor chain is the candidate chain without its last entry. The candidate is the last
// journal entry, so removing it reproduces the state before this change was applied.
async function predecessorMigrationFolder() {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-predecessor-migrations-'))
  await cp(fileURLToPath(new URL('../drizzle', import.meta.url)), directory, { recursive: true })
  const journalPath = join(directory, 'meta', '_journal.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  const candidate = journal.entries.at(-1)
  journal.entries = journal.entries.slice(0, -1)
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  await rm(join(directory, `${candidate.tag}.sql`))
  await rm(join(directory, 'meta', `${String(candidate.idx).padStart(4, '0')}_snapshot.json`))
  return { directory, journalLength: journal.entries.length + 1 }
}

describe.skipIf(!enabled)(
  'PostgreSQL RuntimeNode credentials under production-shaped grants',
  () => {
    let isolated
    let predecessor
    let applicationRole
    let applicationIdentity
    let applicationOwnership
    let predecessorApplied
    let candidateJournalLength

    beforeAll(async () => {
      applicationRole = new URL(loadDatabaseCredentials(process.env, 'application').url).username
      isolated = await createIsolatedTestDatabase({
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      })
      predecessor = await predecessorMigrationFolder()
      candidateJournalLength = predecessor.journalLength
      await isolated.migrate({
        migrationsFolder: predecessor.directory,
        applicationGrants: 'migrations-only',
      })
      predecessorApplied = await appliedCount()
      await isolated.migrate({ applicationGrants: 'migrations-only' })
      // The existing claim path already requires ownership DML; nothing beyond it is granted here.
      await isolated.withMigrationDatabase((database) =>
        database.execute(
          sql`grant select, insert, update on table public.runtime_channel_ownership to ${sql.identifier(applicationRole)}`
        )
      )
      applicationIdentity = new PostgresRuntimeNodeIdentityRepository(isolated.application)
      applicationOwnership = new PostgresRuntimeChannelOwnershipRepository(isolated.application)
    }, integrationTestTimeout(120_000))

    afterAll(async () => {
      await isolated?.dispose()
      if (predecessor) await rm(predecessor.directory, { recursive: true, force: true })
    })

    async function appliedCount() {
      return isolated.withMigrationDatabase(async (database) => {
        const [row] = await database.execute(
          sql`select count(*)::int as count from drizzle.__drizzle_migrations`
        )
        return row.count
      })
    }

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

    async function issueCredential(key, { channelGeneration }) {
      const credentialId = randomIdentifier('rgc')
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

    // Drizzle wraps the driver error, so the SQLSTATE sits on the cause.
    async function expectPermissionDenied(promise) {
      const error = await promise.then(
        () => undefined,
        (caught) => caught
      )
      expect(error?.cause?.code ?? error?.code).toBe('42501')
    }

    async function unconsumed(credentialId) {
      const record = await migration((repository) => repository.getIssuedCredential(credentialId))
      return record.consumedAt === null
    }

    async function establishOwner(nodeId, workspaceId, channelGeneration) {
      const key = await registerKey(nodeId, workspaceId)
      const { credentialId } = await issueCredential(key, { channelGeneration })
      expect(
        await applicationIdentity.consumeCredential(credentialId, 1, now, {
          nodeId,
          workspaceId,
          channelGeneration,
        })
      ).toBe('consumed')
      expect(
        await applicationOwnership.claim(
          ownershipRecord({ nodeId, workspaceId, channelGeneration }),
          { credentialId, revocationVersion: 1 }
        )
      ).toMatchObject({ accepted: true })
      return { key }
    }

    test(
      'an in-place upgrade from the predecessor chain applies the candidate migration and its table',
      async () => {
        expect(predecessorApplied).toBe(candidateJournalLength - 1)
        expect(await appliedCount()).toBe(candidateJournalLength)
        const [row] = await isolated.withMigrationDatabase((database) =>
          database.execute(
            sql`select to_regclass('public.persistence_records') is not null as present`
          )
        )
        expect(row.present).toBe(true)
      },
      integrationTestTimeout(60_000)
    )

    test(
      'the application role cannot revoke, issue, or register identity records under migrations-only grants',
      async () => {
        const nodeId = `rnr_${ulid26()}`
        const workspaceId = `wsp_${ulid26()}`
        const key = await registerKey(nodeId, workspaceId)
        const credential = await issueCredential(key, { channelGeneration: 1 })
        await expectPermissionDenied(
          applicationIdentity.revokeCredential(credential.credentialId, now)
        )
        const pair = makeKeyPair()
        await expectPermissionDenied(
          applicationIdentity.registerVerificationKey({
            keyId: randomIdentifier('rgk'),
            nodeId,
            workspaceId,
            publicKeyPem: pair.publicKeyPem,
            thumbprint: pair.thumbprint,
            status: 'active',
          })
        )
        expect(await unconsumed(credential.credentialId)).toBe(true)
      },
      integrationTestTimeout(60_000)
    )

    test(
      'same-transaction binding refusals consume nothing for the application role, and a current credential still consumes',
      async () => {
        const nodeId = `rnr_${ulid26()}`
        const owner = `wsp_${ulid26()}`
        const other = `wsp_${ulid26()}`
        const established = await establishOwner(nodeId, owner, 2)
        const otherKey = await registerKey(nodeId, other)

        const foreign = await issueCredential(otherKey, { channelGeneration: 3 })
        expect(
          await applicationIdentity.consumeCredential(foreign.credentialId, 1, now, {
            nodeId,
            workspaceId: other,
            channelGeneration: 3,
          })
        ).toBe('workspace_mismatch')
        expect(await unconsumed(foreign.credentialId)).toBe(true)

        const stale = await issueCredential(established.key, { channelGeneration: 1 })
        expect(
          await applicationIdentity.consumeCredential(stale.credentialId, 1, now, {
            nodeId,
            workspaceId: owner,
            channelGeneration: 1,
          })
        ).toBe('superseded')
        expect(await unconsumed(stale.credentialId)).toBe(true)

        const misdirected = await issueCredential(established.key, { channelGeneration: 3 })
        expect(
          await applicationIdentity.consumeCredential(misdirected.credentialId, 1, now, {
            nodeId: `rnr_${ulid26()}`,
            workspaceId: owner,
            channelGeneration: 3,
          })
        ).toBe('node_mismatch')
        expect(await unconsumed(misdirected.credentialId)).toBe(true)

        const current = await issueCredential(established.key, { channelGeneration: 3 })
        expect(
          await applicationIdentity.consumeCredential(current.credentialId, 1, now, {
            nodeId,
            workspaceId: owner,
            channelGeneration: 3,
          })
        ).toBe('consumed')
      },
      integrationTestTimeout(120_000)
    )

    test(
      'a revocation racing application consumption is totally ordered under migrations-only grants',
      async () => {
        for (let iteration = 0; iteration < 6; iteration += 1) {
          const nodeId = `rnr_${ulid26()}`
          const workspaceId = `wsp_${ulid26()}`
          const key = await registerKey(nodeId, workspaceId)
          const { credentialId } = await issueCredential(key, { channelGeneration: 1 })
          const [consumption] = await Promise.all([
            applicationIdentity.consumeCredential(credentialId, 1, now, {
              nodeId,
              workspaceId,
              channelGeneration: 1,
            }),
            migration((repository) => repository.revokeCredential(credentialId, now)),
          ])
          expect(['consumed', 'revoked']).toContain(consumption)
          const record = await migration((repository) =>
            repository.getIssuedCredential(credentialId)
          )
          expect(record.revokedAt).not.toBeNull()
          expect(record.consumedAt !== null).toBe(consumption === 'consumed')
        }
      },
      integrationTestTimeout(120_000)
    )
  }
)
