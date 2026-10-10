import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

import {
  addWorkspaceMembership,
  artifactReferenceGrants,
  artifacts,
  createArtifact,
  createDatabase,
  createProject,
  createTask,
  createTemporaryUserSession,
  createWorkspaceWithOwner,
  getArtifactForUser,
  projects,
  registerArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
  type DatabaseConnection,
} from '@adea-ai/db'
import type { ArtifactReferenceTarget, UserPrincipalRef } from '@adea-ai/types'

/**
 * Route-flow lane for artifact-reference publication and retrieval (#1216).
 * The caller is the wire contract itself: a real `Request` reaches the
 * exported route handlers, the real durable grant store and the real artifact
 * evidence back the decision, and the principal is injected the way the
 * repo's other route-flow lanes inject it. What this proves beyond the pure
 * policy suite: the HTTP contract carries identity only, revocation and
 * audience are re-read at the route, and a locator/URL never grants access.
 */

const connectionUrl = process.env.DATABASE_URL
const CHECKSUM = 'c'.repeat(64)

function resolutionFor(principal: UserPrincipalRef) {
  return Object.freeze({
    clearTemporaryCredential: false,
    principal: Object.freeze({ kind: 'user' as const, userId: principal.userId }),
    sessionRotated: false,
    temporary: true,
  })
}

const allow = async () => ({ allowed: true })
const deny = async () => ({ allowed: false })

async function handlers() {
  const { withRequestScope } = await import('../../src/server/request-scope')
  const { publishArtifactReferenceResponse, retrieveArtifactReferenceResponse } =
    await import('../../src/server/artifact-reference-request')
  return { publishArtifactReferenceResponse, retrieveArtifactReferenceResponse, withRequestScope }
}

function target(
  artifactId: string,
  sourceWorkspaceId: string,
  audienceWorkspaceId: string
): ArtifactReferenceTarget {
  return {
    artifactId,
    audienceWorkspaceId,
    checksumSha256: CHECKSUM,
    sourceWorkspaceId,
    version: 1,
  }
}

describe('artifact-reference routes', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  beforeAll(() => {
    if (!connectionUrl)
      throw new Error(
        'DATABASE_URL is required for the artifact-reference route-flow lane: run it through `bun run test:integration`'
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
      credentialDigest: `artifact-ref-route-${name}-${crypto.randomUUID()}`,
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
      idempotencyKey: `artifact-ref-route-${name}-source-${crypto.randomUUID()}`,
      name: `${name} source`,
      owner,
    })
    const { workspace: destination } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `artifact-ref-route-${name}-destination-${crypto.randomUUID()}`,
      name: `${name} destination`,
      owner: destinationOwner,
    })
    const { workspace: third } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `artifact-ref-route-${name}-third-${crypto.randomUUID()}`,
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

  async function publish(
    sourceWorkspaceId: string,
    principal: UserPrincipalRef,
    body: unknown,
    authorize: typeof allow | typeof deny = allow
  ) {
    const { publishArtifactReferenceResponse, withRequestScope } = await handlers()
    const request = new Request(
      `http://local/api/v1/workspaces/${sourceWorkspaceId}/artifact-references`,
      { body: JSON.stringify(body), method: 'POST' }
    )
    return withRequestScope(() =>
      publishArtifactReferenceResponse(
        request,
        connection.db,
        resolutionFor(principal),
        sourceWorkspaceId,
        authorize
      )
    )
  }

  async function retrieve(
    audienceWorkspaceId: string,
    principal: UserPrincipalRef,
    input: { artifactId: string; grantId: string; sourceWorkspaceId: string; revision?: number },
    authorize: typeof allow | typeof deny = allow
  ) {
    const { retrieveArtifactReferenceResponse, withRequestScope } = await handlers()
    const query = new URLSearchParams({
      artifactId: input.artifactId,
      checksumSha256: CHECKSUM,
      grantId: input.grantId,
      revision: String(input.revision ?? 1),
      sourceWorkspaceId: input.sourceWorkspaceId,
      version: '1',
    })
    const request = new Request(
      `http://local/api/v1/workspaces/${audienceWorkspaceId}/artifact-references?${query}`
    )
    return withRequestScope(() =>
      retrieveArtifactReferenceResponse(
        request,
        connection.db,
        resolutionFor(principal),
        audienceWorkspaceId,
        authorize
      )
    )
  }

  test('an authorized route flow publishes and retrieves without leaking a locator', async () => {
    const { destination, destinationOwner, owner, source } = await fixture('route-admit')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerArtifactReferenceGrant(connection.db, source.id, owner, {
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: 1,
    })
    const exact = target(artifact.id, source.id, destination.id)

    const published = await publish(source.id, owner, { grantId, revision: 1, target: exact })
    expect(published.status).toBe(202)
    expect(await published.json()).toEqual({ reference: exact })

    const delivered = await retrieve(destination.id, destinationOwner, {
      artifactId: artifact.id,
      grantId,
      sourceWorkspaceId: source.id,
    })
    expect(delivered.status).toBe(200)
    const payload = (await delivered.json()) as {
      artifact: { id: string; version: number } | null
      reference: ArtifactReferenceTarget
    }
    expect(payload.reference).toEqual(exact)
    expect(payload.artifact).toMatchObject({ id: artifact.id, version: 1 })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('object_store')
    expect(serialized).not.toContain('result.txt')
    expect(serialized).not.toContain('outputs/')
  })

  test('revocation is re-read at the route for both publication and retrieval', async () => {
    const { destination, destinationOwner, owner, source } = await fixture('route-revoked')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerArtifactReferenceGrant(connection.db, source.id, owner, {
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: 1,
    })
    await revokeArtifactReferenceGrant(connection.db, source.id, owner, grantId)
    const exact = target(artifact.id, source.id, destination.id)

    const held = await publish(source.id, owner, { grantId, revision: 1, target: exact })
    expect(held.status).toBe(403)
    expect(await held.json()).toMatchObject({
      code: 'artifact_reference_held',
      reason: 'grant_revoked',
      stage: 'publication',
    })

    const denied = await retrieve(destination.id, destinationOwner, {
      artifactId: artifact.id,
      grantId,
      sourceWorkspaceId: source.id,
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      code: 'artifact_reference_denied',
      reason: 'grant_revoked',
      stage: 'retrieval',
    })
  })

  test('a workspace outside the registered audience is denied', async () => {
    const { destination, owner, source, stranger, third } = await fixture('route-audience')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerArtifactReferenceGrant(connection.db, source.id, owner, {
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: 1,
    })

    const denied = await retrieve(third.id, stranger, {
      artifactId: artifact.id,
      grantId,
      sourceWorkspaceId: source.id,
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      code: 'artifact_reference_denied',
      reason: 'audience_not_authorized',
      stage: 'retrieval',
    })
  })

  test('a locator or URL possession alone never grants access', async () => {
    const { destination, owner, source } = await fixture('route-locator')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerArtifactReferenceGrant(connection.db, source.id, owner, {
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: 1,
    })
    const exact = target(artifact.id, source.id, destination.id)

    // A body that carries a locator alongside the identity contract is not a
    // valid request.
    const smuggled = await publish(source.id, owner, {
      grantId,
      location: 'https://private.invalid/outputs/result.txt',
      revision: 1,
      target: exact,
    })
    expect(smuggled.status).toBe(400)

    // A target that smuggles a locator inside itself is not a valid target.
    const nested = await publish(source.id, owner, {
      grantId,
      revision: 1,
      target: { ...exact, location: 'https://private.invalid/outputs/result.txt' },
    })
    expect(nested.status).toBe(400)

    // A URL presented as the artifact id is rejected by the identity contract.
    const urlOnly = await retrieve(destination.id, owner, {
      artifactId: 'https://private.invalid/outputs/result.txt',
      grantId,
      sourceWorkspaceId: source.id,
    })
    expect(urlOnly.status).toBe(400)
    const serialized = JSON.stringify({
      smuggled: await smuggled.json(),
      nested: await nested.json(),
      urlOnly: await urlOnly.json(),
    })
    expect(serialized).not.toContain('private.invalid')
  })

  test('another workspace target cannot be published through this source route', async () => {
    const { destination, owner, source, stranger, third } = await fixture('route-cross-source')
    const foreignArtifact = await availableArtifact(third.id, stranger)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerArtifactReferenceGrant(connection.db, third.id, stranger, {
      artifactId: foreignArtifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: 1,
    })
    const foreignTarget = target(foreignArtifact.id, third.id, destination.id)

    // The caller has source-workspace A access and B's valid grant/target;
    // the publication route binds the target source to its own workspace, so
    // B's artifact can never be announced through A.
    const refused = await publish(source.id, owner, {
      grantId,
      revision: 1,
      target: foreignTarget,
    })
    expect(refused.status).toBe(400)
    expect(JSON.stringify(await refused.json())).not.toContain(foreignArtifact.id)
  })

  test('source membership without project visibility cannot publish the artifact', async () => {
    const { destination, owner, source } = await fixture('route-hidden-project')
    const member = await temporaryUser('route-hidden-project-member')
    await addWorkspaceMembership(connection.db, source.id, member, 'member')
    const project = await createProject(connection.db, source.id, owner, {
      iconKey: 'engineering',
      name: 'Hidden project',
    })
    await connection.db
      .update(projects)
      .set({ visibility: 'members' })
      .where(eq(projects.id, project.id))
    const task = await createTask(
      connection.db,
      source.id,
      owner,
      { objective: 'Hidden objective', projectId: project.id, title: 'Hidden task' },
      { idempotencyKey: `hidden-${crypto.randomUUID()}`, requestId: crypto.randomUUID() }
    )
    const artifact = await createArtifact(connection.db, source.id, owner, {
      availability: 'available',
      checksumSha256: CHECKSUM,
      filename: 'hidden.txt',
      location: { reference: `outputs/${crypto.randomUUID()}`, type: 'object_store' },
      mediaType: 'text/plain',
      sizeBytes: 8,
      sourceArtifactRef: `runtime-output:${crypto.randomUUID()}`,
      sourcePrincipal: { kind: 'system', systemId: 'job-runner' },
      taskId: task.id,
    })
    const grantId = `grant-${crypto.randomUUID()}`
    await registerArtifactReferenceGrant(connection.db, source.id, owner, {
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: 1,
    })
    const exact = target(artifact.id, source.id, destination.id)

    // The privileged owner sees the artifact; the plain member cannot, so
    // publication evidence is unavailable for them.
    expect(await getArtifactForUser(connection.db, source.id, artifact.id, owner)).not.toBeNull()
    expect(await getArtifactForUser(connection.db, source.id, artifact.id, member)).toBeNull()

    const held = await publish(source.id, member, { grantId, revision: 1, target: exact })
    expect(held.status).toBe(403)
    expect(await held.json()).toMatchObject({
      code: 'artifact_reference_held',
      reason: 'evidence_unavailable',
      stage: 'publication',
    })

    const admitted = await publish(source.id, owner, { grantId, revision: 1, target: exact })
    expect(admitted.status).toBe(202)
  })

  test('unknown or duplicated query fields are rejected by the identity contract', async () => {
    const { destination, destinationOwner, owner, source } = await fixture('route-query-strict')
    const artifact = await availableArtifact(source.id, owner)
    const grantId = `grant-${crypto.randomUUID()}`
    await registerArtifactReferenceGrant(connection.db, source.id, owner, {
      artifactId: artifact.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      expiresAt: null,
      grantId,
      version: 1,
    })
    const { retrieveArtifactReferenceResponse, withRequestScope } = await handlers()
    const base = new URLSearchParams({
      artifactId: artifact.id,
      checksumSha256: CHECKSUM,
      grantId,
      revision: '1',
      sourceWorkspaceId: source.id,
      version: '1',
    })

    const unknown = new Request(
      `http://local/api/v1/workspaces/${destination.id}/artifact-references?${base}&extra=1`
    )
    const unknownResponse = await withRequestScope(() =>
      retrieveArtifactReferenceResponse(
        unknown,
        connection.db,
        resolutionFor(destinationOwner),
        destination.id,
        allow
      )
    )
    expect(unknownResponse.status).toBe(400)

    const duplicate = new Request(
      `http://local/api/v1/workspaces/${destination.id}/artifact-references?${base}&grantId=other`
    )
    const duplicateResponse = await withRequestScope(() =>
      retrieveArtifactReferenceResponse(
        duplicate,
        connection.db,
        resolutionFor(destinationOwner),
        destination.id,
        allow
      )
    )
    expect(duplicateResponse.status).toBe(400)
  })

  test('workspace authorization still gates the route before the store is read', async () => {
    const { owner, source } = await fixture('route-workspace-denied')
    const artifact = await availableArtifact(source.id, owner)
    const exact = target(artifact.id, source.id, source.id)
    const refused = await publish(
      source.id,
      owner,
      { grantId: 'grant-x', revision: 1, target: exact },
      deny
    )
    expect(refused.status).toBe(404)
    expect(JSON.stringify(await refused.json())).not.toContain('artifact')
  })
})
