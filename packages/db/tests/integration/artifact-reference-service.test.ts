import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

import {
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
} from '../../src/artifact-reference-grants'
import {
  publishArtifactReference,
  retrieveArtifactReference,
} from '../../src/artifact-reference-service'
import { createArtifact } from '../../src/artifacts'
import { createDatabase, type AgentHqDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  artifactReferenceGrants,
  artifacts,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import type { ArtifactReferenceTarget, UserPrincipalRef } from '@adea-ai/types'

/**
 * PostgreSQL wiring lane for artifact-reference publication and retrieval
 * (M15.03.1 #1216). The pure policy suites prove the decision table; this
 * file drives the REAL durable grant store through the real service at both
 * gates: exact version/audience, current revocation, wrong-audience denial,
 * locator-only requests, and sanitized delivery.
 */

const connectionUrl = process.env.DATABASE_URL
const CHECKSUM = 'c'.repeat(64)

function target(
  artifactId: string,
  sourceWorkspaceId: string,
  audienceWorkspaceId: string,
  overrides: Partial<ArtifactReferenceTarget> = {}
): ArtifactReferenceTarget {
  return {
    artifactId,
    audienceWorkspaceId,
    checksumSha256: CHECKSUM,
    sourceWorkspaceId,
    version: 1,
    ...overrides,
  }
}

const presentation = (grantId: string) => ({ grantId, revision: 1 })

/**
 * Wrap the database so every `select` marks that a read has started before it
 * runs. The injected clock reports the expired time only once a read has been
 * observed, so a decision sampled before the awaits fails these regressions.
 */
function databaseThatMarksReads(database: AgentHqDatabase, onRead: () => void): AgentHqDatabase {
  return new Proxy(database, {
    get(databaseTarget, property, receiver) {
      const value = Reflect.get(databaseTarget, property, receiver)
      if (property !== 'select') return value
      return (...args: unknown[]) => {
        onRead()
        return (value as (...parameters: unknown[]) => unknown).apply(databaseTarget, args)
      }
    },
  }) as AgentHqDatabase
}

describe('artifact-reference publication and retrieval wiring', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  beforeAll(() => {
    if (!connectionUrl)
      throw new Error(
        'The artifact-reference service lane requires the integration database (DATABASE_URL).'
      )
    connection = createDatabase(connectionUrl)
  })

  afterAll(async () => {
    if (!connection) return
    if (workspaceIds.length) {
      await connection.db
        .delete(artifactReferenceGrants)
        .where(inArray(artifactReferenceGrants.sourceWorkspaceId, workspaceIds))
      await connection.db.delete(artifacts).where(inArray(artifacts.workspaceId, workspaceIds))
      await connection.db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, workspaceIds))
      await connection.db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    }
    for (const userId of userIds) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(eq(temporaryUserSessions.userId, userId))
      await connection.db.delete(users).where(eq(users.id, userId))
    }
    await connection.close()
  })

  async function temporaryUser(name: string): Promise<UserPrincipalRef> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `artifact-ref-service-${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  async function fixture(name: string) {
    const owner = await temporaryUser(`${name}-owner`)
    const destinationOwner = await temporaryUser(`${name}-destination`)
    const stranger = await temporaryUser(`${name}-stranger`)
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `artifact-ref-service-${name}-source-${crypto.randomUUID()}`,
      name: `${name} source`,
      owner,
    })
    const { workspace: destination } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `artifact-ref-service-${name}-destination-${crypto.randomUUID()}`,
      name: `${name} destination`,
      owner: destinationOwner,
    })
    const { workspace: third } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `artifact-ref-service-${name}-third-${crypto.randomUUID()}`,
      name: `${name} third`,
      owner: stranger,
    })
    workspaceIds.push(source.id, destination.id, third.id)
    return { destination, destinationOwner, owner, source, stranger, third }
  }

  async function availableArtifact(sourceWorkspaceId: string, owner: UserPrincipalRef) {
    return createArtifact(connection.db, sourceWorkspaceId, owner, {
      availability: 'available',
      checksumSha256: CHECKSUM,
      filename: 'result.txt',
      location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 32,
      sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
      sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
    })
  }

  async function registerGrant(
    sourceWorkspaceId: string,
    owner: UserPrincipalRef,
    artifactId: string,
    audienceWorkspaceId: string,
    grantId: string
  ) {
    return registerArtifactReferenceGrant(connection.db, sourceWorkspaceId, owner, {
      artifactId,
      audienceWorkspaceId,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: 1,
    })
  }

  test('an exact live grant publishes and delivers the sanitized target only', async () => {
    const { destination, owner, source } = await fixture('admit')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerGrant(source.id, owner, artifact.id, destination.id, grantId)
    const exact = target(artifact.id, source.id, destination.id)

    const publication = await publishArtifactReference(
      connection.db,
      { grant: presentation(grantId), target: exact },
      owner
    )
    expect(publication.decision).toEqual({
      action: 'publish',
      ok: true,
      stage: 'publication',
      target: exact,
    })

    const retrieval = await retrieveArtifactReference(connection.db, {
      grant: presentation(grantId),
      requestingWorkspaceId: destination.id,
      target: exact,
    })
    expect(retrieval.decision).toEqual({
      action: 'deliver',
      ok: true,
      stage: 'retrieval',
      target: exact,
    })

    // The wiring never surfaces a filename, location or URL.
    const serialized = JSON.stringify({ publication, retrieval })
    expect(serialized).not.toContain('object_store')
    expect(serialized).not.toContain('result.txt')
    expect(serialized).not.toContain('outputs/')
  })

  test('an unregistered grant is held at publication and denied at retrieval', async () => {
    const { destination, owner, source } = await fixture('unregistered')
    const artifact = await availableArtifact(source.id, owner)
    const exact = target(artifact.id, source.id, destination.id)

    const publication = await publishArtifactReference(
      connection.db,
      { grant: presentation(`grant-${crypto.randomUUID()}`), target: exact },
      owner
    )
    expect(publication.decision).toMatchObject({
      action: 'hold',
      ok: false,
      reason: 'grant_not_registered',
      stage: 'publication',
    })

    const retrieval = await retrieveArtifactReference(connection.db, {
      grant: presentation(`grant-${crypto.randomUUID()}`),
      requestingWorkspaceId: destination.id,
      target: exact,
    })
    expect(retrieval.decision).toMatchObject({
      action: 'deny',
      ok: false,
      reason: 'grant_not_registered',
      stage: 'retrieval',
    })
  })

  test('a caller without access to the source workspace is held', async () => {
    const { destination, destinationOwner, owner, source } = await fixture('no-source-access')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerGrant(source.id, owner, artifact.id, destination.id, grantId)
    const exact = target(artifact.id, source.id, destination.id)

    // The destination owner holds a valid grant presentation but no source
    // workspace access; evidence must be unreadable, so publication is held.
    const held = await publishArtifactReference(
      connection.db,
      { grant: presentation(grantId), target: exact },
      destinationOwner
    )
    expect(held.decision).toMatchObject({
      action: 'hold',
      ok: false,
      reason: 'evidence_unavailable',
      stage: 'publication',
    })
  })

  test('publication samples the trusted clock after the evidence and grant reads', async () => {
    const { destination, owner, source } = await fixture('clock-publication')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    // The grant is live for real time; the clock only reports the expired time
    // once the wrapped database has actually been read.
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    await registerArtifactReferenceGrant(connection.db, source.id, owner, {
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt,
      grantId,
      version: 1,
    })
    const exact = target(artifact.id, source.id, destination.id)

    let readsStarted = false
    let sampledAfterRead = false
    const result = await publishArtifactReference(
      databaseThatMarksReads(connection.db, () => {
        readsStarted = true
      }),
      { grant: presentation(grantId), target: exact },
      owner,
      () => {
        sampledAfterRead = readsStarted
        return sampledAfterRead
          ? new Date(Date.now() + 120_000).toISOString()
          : new Date(Date.now() - 1_000).toISOString()
      }
    )

    expect(readsStarted).toBe(true)
    expect(sampledAfterRead).toBe(true)
    expect(result.decision).toMatchObject({
      action: 'hold',
      ok: false,
      reason: 'grant_expired',
      stage: 'publication',
    })
  })

  test('retrieval samples the trusted clock after the evidence and grant reads', async () => {
    const { destination, owner, source } = await fixture('clock-retrieval')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    await registerArtifactReferenceGrant(connection.db, source.id, owner, {
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt,
      grantId,
      version: 1,
    })
    const exact = target(artifact.id, source.id, destination.id)

    let readsStarted = false
    let sampledAfterRead = false
    const result = await retrieveArtifactReference(
      databaseThatMarksReads(connection.db, () => {
        readsStarted = true
      }),
      { grant: presentation(grantId), requestingWorkspaceId: destination.id, target: exact },
      () => {
        sampledAfterRead = readsStarted
        return sampledAfterRead
          ? new Date(Date.now() + 120_000).toISOString()
          : new Date(Date.now() - 1_000).toISOString()
      }
    )

    expect(readsStarted).toBe(true)
    expect(sampledAfterRead).toBe(true)
    expect(result.decision).toMatchObject({
      action: 'deny',
      ok: false,
      reason: 'grant_expired',
      stage: 'retrieval',
    })
  })

  test('revocation is absolute at both gates even while the artifact stays live', async () => {
    const { destination, owner, source } = await fixture('revoked')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerGrant(source.id, owner, artifact.id, destination.id, grantId)
    const revoked = await revokeArtifactReferenceGrant(connection.db, source.id, owner, grantId)
    expect(revoked?.revoked).toBe(true)
    const exact = target(artifact.id, source.id, destination.id)

    const publication = await publishArtifactReference(
      connection.db,
      { grant: presentation(grantId), target: exact },
      owner
    )
    expect(publication.decision).toMatchObject({
      action: 'hold',
      ok: false,
      reason: 'grant_revoked',
      stage: 'publication',
    })

    const retrieval = await retrieveArtifactReference(connection.db, {
      grant: presentation(grantId),
      requestingWorkspaceId: destination.id,
      target: exact,
    })
    expect(retrieval.decision).toMatchObject({
      action: 'deny',
      ok: false,
      reason: 'grant_revoked',
      stage: 'retrieval',
    })
  })

  test('a different audience workspace is denied even with the registered grant', async () => {
    const { destination, owner, source, third } = await fixture('audience')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerGrant(source.id, owner, artifact.id, destination.id, grantId)
    const exact = target(artifact.id, source.id, destination.id)

    const strangerRetrieval = await retrieveArtifactReference(connection.db, {
      grant: presentation(grantId),
      requestingWorkspaceId: third.id,
      target: exact,
    })
    expect(strangerRetrieval.decision).toMatchObject({
      action: 'deny',
      ok: false,
      reason: 'audience_not_authorized',
      stage: 'retrieval',
    })

    const movedTarget = target(artifact.id, source.id, third.id)
    const movedPublication = await publishArtifactReference(
      connection.db,
      { grant: presentation(grantId), target: movedTarget },
      owner
    )
    expect(movedPublication.decision).toMatchObject({
      action: 'hold',
      ok: false,
      reason: 'audience_not_authorized',
      stage: 'publication',
    })
  })

  test('a stale version or substituted digest never matches', async () => {
    const { destination, owner, source } = await fixture('exactness')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerGrant(source.id, owner, artifact.id, destination.id, grantId)

    const stale = await publishArtifactReference(
      connection.db,
      {
        grant: presentation(grantId),
        target: target(artifact.id, source.id, destination.id, { version: 2 }),
      },
      owner
    )
    expect(stale.decision).toMatchObject({
      action: 'hold',
      ok: false,
      reason: 'stale_version',
      stage: 'publication',
    })

    const tampered = await publishArtifactReference(
      connection.db,
      {
        grant: presentation(grantId),
        target: target(artifact.id, source.id, destination.id, { checksumSha256: 'd'.repeat(64) }),
      },
      owner
    )
    expect(tampered.decision).toMatchObject({
      action: 'hold',
      ok: false,
      reason: 'digest_mismatch',
      stage: 'publication',
    })
  })

  test('a locator or URL alone never grants access', async () => {
    const { destination, owner, source } = await fixture('locator')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerGrant(source.id, owner, artifact.id, destination.id, grantId)

    // A target smuggling a private location is malformed: it is refused before
    // any evidence or grant is trusted.
    const withLocator = {
      ...target(artifact.id, source.id, destination.id),
      location: 'https://private.invalid/outputs/result.txt',
    } as unknown as ArtifactReferenceTarget
    const smuggled = await publishArtifactReference(
      connection.db,
      { grant: presentation(grantId), target: withLocator },
      owner
    )
    expect(smuggled.decision).toMatchObject({
      action: 'hold',
      ok: false,
      reason: 'reference_malformed',
      stage: 'publication',
    })

    // A private URL presented as the artifact id finds no evidence at all.
    const urlOnly = await retrieveArtifactReference(connection.db, {
      grant: presentation(grantId),
      requestingWorkspaceId: destination.id,
      target: target('https://private.invalid/outputs/result.txt', source.id, destination.id),
    })
    expect(urlOnly.decision).toMatchObject({
      action: 'deny',
      ok: false,
      reason: 'evidence_unavailable',
      stage: 'retrieval',
    })
    expect(JSON.stringify({ smuggled, urlOnly })).not.toContain('private.invalid')
  })
})
