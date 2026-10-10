import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'

import {
  authorizeArtifactReferencePublication,
  authorizeArtifactReferenceRetrieval,
  readArtifactReferenceEvidence,
} from '../../src/artifact-reference-policy'
import { createArtifact, deleteArtifact, setArtifactAvailability } from '../../src/artifacts'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  artifacts,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'
import type {
  ArtifactReferenceEvidence,
  ArtifactReferenceGrant,
  ArtifactReferenceGrantState,
  ArtifactReferenceTarget,
  UserPrincipalRef,
} from '@adea-ai/types'

/**
 * PostgreSQL access-evidence lane for the artifact-reference policy
 * (M15.03 #1180). The pure decision suites live in `tests/unit`; this file
 * exercises the evidence reading through the existing access helpers
 * (`createArtifact`, `setArtifactAvailability`, `deleteArtifact`) against
 * the disposable database the repo's integration lane provides, then feeds
 * that live evidence through the publication and retrieval gates.
 */

const connectionUrl = process.env.DATABASE_URL

const CHECKSUM = 'c'.repeat(64)

function grantFor(
  target: ArtifactReferenceTarget,
  overrides: Partial<ArtifactReferenceGrant> = {}
): { grant: ArtifactReferenceGrant; grantState: ArtifactReferenceGrantState } {
  return {
    grant: {
      artifactId: target.artifactId,
      audienceWorkspaceId: target.audienceWorkspaceId,
      checksumSha256: target.checksumSha256,
      expiresAt: null,
      grantId: 'grant-live',
      revokedAt: null,
      revision: 1,
      sourceWorkspaceId: target.sourceWorkspaceId,
      version: target.version,
      ...overrides,
    },
    grantState: {
      artifactId: target.artifactId,
      audienceWorkspaceIds: [target.audienceWorkspaceId],
      checksumSha256: target.checksumSha256,
      expiresAt: null,
      grantId: 'grant-live',
      revoked: false,
      revision: 1,
      sourceWorkspaceId: target.sourceWorkspaceId,
      version: target.version,
    },
  }
}

function targetFrom(
  evidence: NonNullable<ArtifactReferenceEvidence>,
  sourceWorkspaceId: string,
  audienceWorkspaceId: string
): ArtifactReferenceTarget {
  return {
    artifactId: evidence.id,
    audienceWorkspaceId,
    checksumSha256: evidence.checksumSha256,
    sourceWorkspaceId,
    version: evidence.version,
  }
}

describe.skipIf(!connectionUrl)('Artifact reference evidence and gates', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => {
    await cleanup()
    await connection.close()
  })

  async function cleanup() {
    // One statement per table for the whole batch, children before parents.
    if (workspaceIds.length) {
      await connection.db.delete(artifacts).where(inArray(artifacts.workspaceId, workspaceIds))
      await connection.db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, workspaceIds))
      await connection.db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    }
    if (userIds.length) {
      await connection.db
        .delete(temporaryUserSessions)
        .where(inArray(temporaryUserSessions.userId, userIds))
      await connection.db.delete(users).where(inArray(users.id, userIds))
    }
    workspaceIds.length = 0
    userIds.length = 0
  }

  async function temporaryUser(name: string): Promise<UserPrincipalRef> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `artifact-ref-${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  /** A source workspace with an owner, an audience workspace, and a stranger. */
  async function fixture(name: string) {
    const owner = await temporaryUser(`${name}-owner`)
    const outsider = await temporaryUser(`${name}-outsider`)
    const destinationOwner = await temporaryUser(`${name}-destination`)
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `artifact-ref-${name}-source-${crypto.randomUUID()}`,
      name: `${name} source`,
      owner,
    })
    const { workspace: destination } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `artifact-ref-${name}-destination-${crypto.randomUUID()}`,
      name: `${name} destination`,
      owner: destinationOwner,
    })
    workspaceIds.push(source.id, destination.id)
    return { destination, destinationOwner, outsider, owner, source }
  }

  async function createAvailableArtifact(sourceWorkspaceId: string, owner: UserPrincipalRef) {
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

  test('evidence is read through the existing helper and projected to identity fields only', async () => {
    const { owner, source } = await fixture('evidence')
    const created = await createAvailableArtifact(source.id, owner)
    const evidence = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      created.id,
      owner
    )
    expect(evidence).toEqual({
      availability: 'available',
      checksumSha256: CHECKSUM,
      deletionState: 'active',
      id: created.id,
      sensitivity: 'workspace',
      version: 1,
      workspaceId: source.id,
    })
    // No filename, no location, no provenance: evidence cannot carry the
    // artifact's private context into any decision.
    expect(Object.keys(evidence!).toSorted()).toEqual([
      'availability',
      'checksumSha256',
      'deletionState',
      'id',
      'sensitivity',
      'version',
      'workspaceId',
    ])
  })

  test('a URL or artifact id alone grants nothing: strangers and unknown ids read null evidence', async () => {
    const { destination, destinationOwner, outsider, owner, source } = await fixture('no-access')
    const created = await createAvailableArtifact(source.id, owner)

    expect(
      await readArtifactReferenceEvidence(connection.db, source.id, created.id, outsider)
    ).toBeNull()
    expect(
      await readArtifactReferenceEvidence(connection.db, source.id, created.id, destinationOwner)
    ).toBeNull()
    expect(
      await readArtifactReferenceEvidence(connection.db, source.id, crypto.randomUUID(), owner)
    ).toBeNull()

    const target: ArtifactReferenceTarget = {
      artifactId: created.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      sourceWorkspaceId: source.id,
      version: 1,
    }
    const { grant, grantState } = grantFor(target)
    // Even a structurally perfect grant cannot compensate for missing
    // current evidence: the locator is not authorization.
    const held = authorizeArtifactReferencePublication({
      authority: { kind: 'workspace_grant' },
      evidence: null,
      grant,
      grantState,
      now: new Date().toISOString(),
      target,
    })
    expect(held).toEqual({
      action: 'hold',
      ok: false,
      producerEffect: 'unaffected',
      reason: 'evidence_unavailable',
      stage: 'publication',
    })
  })

  test('a live exact match publishes to the audience and delivers back to it only', async () => {
    const { destination, owner, source } = await fixture('admit')
    const created = await createAvailableArtifact(source.id, owner)
    const evidence = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      created.id,
      owner
    )
    expect(evidence).not.toBeNull()
    const target = targetFrom(evidence!, source.id, destination.id)
    const { grant, grantState } = grantFor(target)
    const now = new Date().toISOString()

    const publication = authorizeArtifactReferencePublication({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant,
      grantState,
      now,
      target,
    })
    expect(publication).toEqual({ action: 'publish', ok: true, stage: 'publication', target })

    const retrieval = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant,
      grantState,
      now,
      requestingWorkspaceId: destination.id,
      target,
    })
    expect(retrieval).toEqual({ action: 'deliver', ok: true, stage: 'retrieval', target })

    // Another workspace requesting the same reference is denied even though
    // everything else matches.
    const stranger = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant,
      grantState,
      now,
      requestingWorkspaceId: source.id,
      target,
    })
    expect(stranger).toEqual({
      action: 'deny',
      ok: false,
      reason: 'audience_not_authorized',
      stage: 'retrieval',
    })
  })

  test('a version bump holds publication of stale results and changes the live identity', async () => {
    const { destination, owner, source } = await fixture('stale-version')
    const created = await createAvailableArtifact(source.id, owner)
    const staleTarget: ArtifactReferenceTarget = {
      artifactId: created.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      sourceWorkspaceId: source.id,
      version: 1,
    }
    const { grant, grantState } = grantFor(staleTarget)

    await setArtifactAvailability(
      connection.db,
      source.id,
      created.id,
      owner,
      'available',
      created.version
    )
    const bumped = await readArtifactReferenceEvidence(connection.db, source.id, created.id, owner)
    expect(bumped?.version).toBe(created.version + 1)

    const held = authorizeArtifactReferencePublication({
      authority: { kind: 'workspace_grant' },
      evidence: bumped,
      grant,
      grantState,
      now: new Date().toISOString(),
      target: staleTarget,
    })
    expect(held).toEqual({
      action: 'hold',
      ok: false,
      producerEffect: 'unaffected',
      reason: 'stale_version',
      stage: 'publication',
    })
    const denied = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence: bumped,
      grant,
      grantState,
      now: new Date().toISOString(),
      requestingWorkspaceId: destination.id,
      target: staleTarget,
    })
    expect(denied).toEqual({
      action: 'deny',
      ok: false,
      reason: 'stale_version',
      stage: 'retrieval',
    })
  })

  test('a live digest mismatch and quarantine are refused by name', async () => {
    const { destination, owner, source } = await fixture('quarantine')
    const created = await createAvailableArtifact(source.id, owner)

    const tampered: ArtifactReferenceTarget = {
      artifactId: created.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: 'd'.repeat(64),
      sourceWorkspaceId: source.id,
      version: created.version,
    }
    const tamperedEvidence = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      created.id,
      owner
    )
    const held = authorizeArtifactReferencePublication({
      authority: { kind: 'workspace_grant' },
      evidence: tamperedEvidence,
      grant: grantFor(tampered).grant,
      grantState: grantFor(tampered).grantState,
      now: new Date().toISOString(),
      target: tampered,
    })
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('digest_mismatch')

    await setArtifactAvailability(
      connection.db,
      source.id,
      created.id,
      owner,
      'quarantined',
      created.version
    )
    const quarantined = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      created.id,
      owner
    )
    expect(quarantined?.availability).toBe('quarantined')
    const quarantineTarget = targetFrom(quarantined!, source.id, destination.id)
    const denied = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence: quarantined,
      grant: grantFor(quarantineTarget).grant,
      grantState: grantFor(quarantineTarget).grantState,
      now: new Date().toISOString(),
      requestingWorkspaceId: destination.id,
      target: quarantineTarget,
    })
    expect(denied).toEqual({
      action: 'deny',
      ok: false,
      reason: 'artifact_quarantined',
      stage: 'retrieval',
    })
  })

  test('a live grant identity cannot be relabelled onto a different live artifact', async () => {
    const { destination, owner, source } = await fixture('relabel')
    const granted = await createAvailableArtifact(source.id, owner)
    const other = await createAvailableArtifact(source.id, owner)
    const grantedEvidence = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      granted.id,
      owner
    )
    const otherEvidence = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      other.id,
      owner
    )
    expect(grantedEvidence).not.toBeNull()
    expect(otherEvidence).not.toBeNull()
    // The registration and the grant are for `granted`; the presented grant
    // and locator claim `other`, whose live evidence really exists. Only the
    // registered artifact field disagrees — that is enough to fail closed.
    const target = targetFrom(otherEvidence!, source.id, destination.id)
    const { grant, grantState } = grantFor(targetFrom(grantedEvidence!, source.id, destination.id))
    const held = authorizeArtifactReferencePublication({
      authority: { kind: 'workspace_grant' },
      evidence: otherEvidence,
      grant: { ...grant, artifactId: other.id },
      grantState,
      now: new Date().toISOString(),
      target,
    })
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.reason).toBe('grant_target_mismatch')
    const denied = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence: otherEvidence,
      grant: { ...grant, artifactId: other.id },
      grantState,
      now: new Date().toISOString(),
      requestingWorkspaceId: destination.id,
      target,
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toBe('grant_target_mismatch')
  })

  test('revocation holds the late publication and leaves the producing job output intact', async () => {
    const { destination, owner, source } = await fixture('revocation')
    const created = await createAvailableArtifact(source.id, owner)
    const evidence = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      created.id,
      owner
    )
    const target = targetFrom(evidence!, source.id, destination.id)
    const now = new Date().toISOString()
    const { grant, grantState } = grantFor(target)

    expect(
      authorizeArtifactReferencePublication({
        authority: { kind: 'workspace_grant' },
        evidence,
        grant,
        grantState,
        now,
        target,
      }).ok
    ).toBe(true)

    // The audience workspace revokes; the producing job has already finished
    // and its artifact is untouched.
    const revokedGrant = { ...grant, revokedAt: now }
    const revokedState = { ...grantState, revoked: true }

    const held = authorizeArtifactReferencePublication({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant: revokedGrant,
      grantState: revokedState,
      now,
      target,
    })
    expect(held).toEqual({
      action: 'hold',
      ok: false,
      producerEffect: 'unaffected',
      reason: 'grant_revoked',
      stage: 'publication',
    })
    const denied = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant: revokedGrant,
      grantState: revokedState,
      now,
      requestingWorkspaceId: destination.id,
      target,
    })
    expect(denied).toEqual({
      action: 'deny',
      ok: false,
      reason: 'grant_revoked',
      stage: 'retrieval',
    })

    // The gate held the publication; it did not touch the artifact the
    // producing job created.
    const afterRevocation = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      created.id,
      owner
    )
    expect(afterRevocation).toEqual(evidence)
  })

  test('a deleted artifact leaves no evidence and both gates refuse', async () => {
    const { destination, owner, source } = await fixture('deletion')
    const created = await createAvailableArtifact(source.id, owner)
    await deleteArtifact(connection.db, source.id, created.id, owner, created.version)

    const evidence = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      created.id,
      owner
    )
    expect(evidence).toBeNull()
    const target: ArtifactReferenceTarget = {
      artifactId: created.id,
      audienceWorkspaceId: destination.id,
      checksumSha256: CHECKSUM,
      sourceWorkspaceId: source.id,
      version: created.version,
    }
    const { grant, grantState } = grantFor(target)
    const denied = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant,
      grantState,
      now: new Date().toISOString(),
      requestingWorkspaceId: destination.id,
      target,
    })
    expect(denied).toEqual({
      action: 'deny',
      ok: false,
      reason: 'evidence_unavailable',
      stage: 'retrieval',
    })
  })
})
