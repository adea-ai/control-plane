import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'

import {
  readCurrentArtifactReferenceGrant,
  registerArtifactReferenceGrant,
  regrantArtifactReferenceGrant,
  revokeArtifactReferenceGrant,
  withArtifactReferenceGrantLocks,
  type ArtifactReferenceGrantRegistrationInput,
} from '../../src/artifact-reference-grants'
import {
  authorizeArtifactReferencePublication,
  authorizeArtifactReferenceRetrieval,
  readArtifactReferenceEvidence,
} from '../../src/artifact-reference-policy'
import { createArtifact } from '../../src/artifacts'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  artifactReferenceGrants,
  artifacts,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { inTransaction } from '../../src/transactions'
import {
  addWorkspaceMembership,
  archiveWorkspace,
  createWorkspaceWithOwner,
  removeWorkspaceMembership,
} from '../../src/workspaces'
import type {
  ArtifactReferenceGrant,
  ArtifactReferenceTarget,
  UserPrincipalRef,
} from '@adea-ai/types'

/**
 * PostgreSQL grant-store lane for the artifact-reference policy
 * (M15.03 #1180). The durable store is what makes the policy's grant checks
 * authoritative: idempotent registration, store-owned positive revisions,
 * revoke/regrant isolation, and a transaction-scoped current-grant reader —
 * proven against the disposable database the repo's integration lane
 * provides, with the policy gates consuming what the store returns.
 */

const connectionUrl = process.env.DATABASE_URL

const CHECKSUM = 'b'.repeat(64)
/** Deliberately non-normalized: the store must preserve it verbatim. */
const EXPIRES_AT = '2030-06-15T12:00:00Z'

function inputFor(
  source: { id: string },
  audience: { id: string },
  artifactId: string,
  overrides: Partial<ArtifactReferenceGrantRegistrationInput> = {}
): ArtifactReferenceGrantRegistrationInput {
  return {
    artifactId,
    audienceWorkspaceId: audience.id,
    checksumSha256: CHECKSUM,
    expiresAt: null,
    grantId: `grant-${crypto.randomUUID()}`,
    version: 1,
    ...overrides,
  }
}

type ArtifactReferenceGrantStateValue = NonNullable<
  Awaited<ReturnType<typeof readCurrentArtifactReferenceGrant>>
>

/** The presentable grant the registered state authorizes. */
function grantFrom(
  state: ArtifactReferenceGrantStateValue,
  revokedAt: string | null = null
): ArtifactReferenceGrant {
  return {
    artifactId: state.artifactId,
    audienceWorkspaceId: state.audienceWorkspaceIds[0]!,
    checksumSha256: state.checksumSha256,
    expiresAt: state.expiresAt,
    grantId: state.grantId,
    revokedAt,
    revision: state.revision,
    sourceWorkspaceId: state.sourceWorkspaceId,
    version: state.version,
  }
}

describe.skipIf(!connectionUrl)('Artifact reference grant store', () => {
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
    // One statement per table for the whole batch, children before parents, so every
    // row the per-workspace loop deleted is still deleted in the same foreign-key order.
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
      credentialDigest: `artifact-grant-${name}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  /** A granting (source) workspace, its audience, and a stranger to both. */
  async function fixture(name: string) {
    const owner = await temporaryUser(`${name}-owner`)
    const audienceOwner = await temporaryUser(`${name}-audience`)
    const outsider = await temporaryUser(`${name}-outsider`)
    const { workspace: source } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `artifact-grant-${name}-source-${crypto.randomUUID()}`,
      name: `${name} source`,
      owner,
    })
    const { workspace: audience } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `artifact-grant-${name}-audience-${crypto.randomUUID()}`,
      name: `${name} audience`,
      owner: audienceOwner,
    })
    workspaceIds.push(source.id, audience.id)
    return { audience, audienceOwner, outsider, owner, source }
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

  async function storedRows(grantId: string) {
    return connection.db
      .select()
      .from(artifactReferenceGrants)
      .where(eq(artifactReferenceGrants.grantId, grantId))
  }

  test('registration is idempotent for an identical grant: one row, unchanged revision', async () => {
    const { audience, owner, source } = await fixture('idempotent')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const first = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(first.outcome).toBe('registered')
    expect(first.state.revision).toBe(1)
    expect(first.state.revoked).toBe(false)

    const replay = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(replay.outcome).toBe('existing')
    expect(replay.state).toEqual(first.state)
    expect(await storedRows(input.grantId)).toHaveLength(1)

    // A replay with a divergent expiry is not the identical grant: it fails
    // closed instead of silently reusing or rewriting the registration.
    expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, {
        ...input,
        expiresAt: EXPIRES_AT,
      })
    ).rejects.toThrow('Artifact reference grant identity conflict')

    // A replay that relabels the artifact is refused by the artifact-first
    // lock order: an artifact id that anchors nothing is unknown before any
    // grant row is consulted.
    expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, {
        ...input,
        artifactId: crypto.randomUUID(),
      })
    ).rejects.toThrow('Artifact reference grant artifact unknown')

    // Relabelling to a REAL artifact resolves the locks and then still fails
    // closed on the identity conflict: a registered grant id can never be
    // moved to a different artifact.
    const secondArtifact = await createAvailableArtifact(source.id, owner)
    expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, {
        ...input,
        artifactId: secondArtifact.id,
      })
    ).rejects.toThrow('Artifact reference grant identity conflict')
    expect(await storedRows(input.grantId)).toHaveLength(1)
  })

  test('a non-member cannot register or revoke, and both bound parties may revoke', async () => {
    const { audience, audienceOwner, outsider, owner, source } = await fixture('authority')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    expect(
      registerArtifactReferenceGrant(connection.db, source.id, outsider, input)
    ).rejects.toThrow('Artifact reference grant issuer unauthorized')

    const registered = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(registered.outcome).toBe('registered')

    // The granting workspace revokes.
    const revokedBySource = await revokeArtifactReferenceGrant(
      connection.db,
      source.id,
      owner,
      input.grantId
    )
    expect(revokedBySource?.revoked).toBe(true)

    // Revocation is idempotent and never bumps the revision.
    const revokedAgain = await revokeArtifactReferenceGrant(
      connection.db,
      source.id,
      owner,
      input.grantId
    )
    expect(revokedAgain).toEqual(revokedBySource)

    // Restoring access is the explicit regrant's job, not a registration
    // replay; the audience renounces its own access and a stranger to both
    // cannot revoke at all.
    const regranted = await regrantArtifactReferenceGrant(connection.db, source.id, owner, input, 1)
    expect(regranted.outcome).toBe('registered')
    expect(regranted.state.revision).toBe(2)
    expect(
      revokeArtifactReferenceGrant(connection.db, audience.id, outsider, input.grantId)
    ).rejects.toThrow('Artifact reference grant unavailable')
    const revokedByAudience = await revokeArtifactReferenceGrant(
      connection.db,
      audience.id,
      audienceOwner,
      input.grantId
    )
    expect(revokedByAudience?.revoked).toBe(true)
    expect(await storedRows(input.grantId)).toHaveLength(1)
  })

  test('revisions are store-owned and positive: none below one can exist or read as current', async () => {
    const { audience, owner, source } = await fixture('positive-revisions')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const registered = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(registered.state.revision).toBe(1)

    // The durable check constraint refuses non-positive revisions even for a
    // direct write, so no zero or negative revision can ever be stored.
    for (const revision of [0, -2]) {
      let rejected = false
      try {
        await connection.db
          .update(artifactReferenceGrants)
          .set({ revision })
          .where(eq(artifactReferenceGrants.grantId, input.grantId))
      } catch {
        rejected = true
      }
      expect(rejected).toBe(true)
    }

    // Malformed or non-positive presentations never read as current.
    for (const revision of [0, -1, 2.5, Number.NaN]) {
      expect(
        await readCurrentArtifactReferenceGrant(connection.db, {
          grantId: input.grantId,
          revision,
        })
      ).toBeNull()
    }
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: input.grantId,
        revision: 1,
      })
    ).toEqual(registered.state)
  })

  test('a revoked grant cannot authorize, and a regrant yields a new revision the old one cannot regain', async () => {
    const { audience, audienceOwner, owner, source } = await fixture('regrant-isolation')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const first = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(first.state.revision).toBe(1)

    // The audience revokes; the stale revision reads revoked and the gate
    // refuses delivery by name.
    await revokeArtifactReferenceGrant(connection.db, audience.id, audienceOwner, input.grantId)
    const revokedState = await readCurrentArtifactReferenceGrant(connection.db, {
      grantId: input.grantId,
      revision: 1,
    })
    expect(revokedState?.revoked).toBe(true)

    // Regranting explicitly at the current revision mints the next revision.
    const second = await regrantArtifactReferenceGrant(connection.db, source.id, owner, input, 1)
    expect(second.outcome).toBe('registered')
    expect(second.state.revision).toBe(2)
    expect(second.state.revoked).toBe(false)
    expect(await storedRows(input.grantId)).toHaveLength(1)

    // The old revision is stale forever: it reads absent — never as the
    // current registration — and the gate denies it on that alone.
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: input.grantId,
        revision: 1,
      })
    ).toBeNull()
    const evidence = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      created.id,
      owner
    )
    expect(evidence).not.toBeNull()
    const staleTarget: ArtifactReferenceTarget = {
      artifactId: created.id,
      audienceWorkspaceId: audience.id,
      checksumSha256: CHECKSUM,
      sourceWorkspaceId: source.id,
      version: created.version,
    }
    const staleDenial = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant: { ...grantFrom(first.state), revokedAt: new Date().toISOString() },
      grantState: null,
      now: new Date().toISOString(),
      requestingWorkspaceId: audience.id,
      target: staleTarget,
    })
    expect(staleDenial).toEqual({
      action: 'deny',
      ok: false,
      reason: 'grant_not_registered',
      stage: 'retrieval',
    })

    // Only the new revision reads current.
    const currentState = await readCurrentArtifactReferenceGrant(connection.db, {
      grantId: input.grantId,
      revision: 2,
    })
    expect(currentState).toEqual(second.state)
  })

  test('the complete identity survives storage and authorizes the exact presented grant', async () => {
    const { audience, audienceOwner, owner, source } = await fixture('complete-identity')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id, { expiresAt: EXPIRES_AT })

    const registered = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    const state = await readCurrentArtifactReferenceGrant(connection.db, {
      grantId: input.grantId,
      revision: registered.state.revision,
    })
    expect(state).not.toBeNull()
    // Every identity field is preserved, and the expiry string round-trips
    // verbatim — the policy compares expiry by exact string equality.
    expect(state).toEqual({
      artifactId: created.id,
      audienceWorkspaceIds: [audience.id],
      checksumSha256: CHECKSUM,
      expiresAt: EXPIRES_AT,
      grantId: input.grantId,
      revoked: false,
      revision: 1,
      sourceWorkspaceId: source.id,
      version: 1,
    })

    // The registered state authorizes the presented grant end to end against
    // live evidence: publication admits, retrieval delivers to the audience.
    const evidence = await readArtifactReferenceEvidence(
      connection.db,
      source.id,
      created.id,
      owner
    )
    expect(evidence).not.toBeNull()
    const target: ArtifactReferenceTarget = {
      artifactId: created.id,
      audienceWorkspaceId: audience.id,
      checksumSha256: CHECKSUM,
      sourceWorkspaceId: source.id,
      version: created.version,
    }
    const presented = grantFrom(state!)
    const now = new Date().toISOString()
    expect(
      authorizeArtifactReferencePublication({
        authority: { kind: 'workspace_grant' },
        evidence,
        grant: presented,
        grantState: state!,
        now,
        target,
      })
    ).toEqual({ action: 'publish', ok: true, stage: 'publication', target })
    expect(
      authorizeArtifactReferenceRetrieval({
        authority: { kind: 'workspace_grant' },
        evidence,
        grant: presented,
        grantState: state!,
        now,
        requestingWorkspaceId: audience.id,
        target,
      })
    ).toEqual({ action: 'deliver', ok: true, stage: 'retrieval', target })

    // A forged presentation borrowing the registered grant id but relabelling
    // its content digest no longer binds the presented target and fails
    // closed under the policy's typed refusal.
    const forged = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant: { ...presented, checksumSha256: 'a'.repeat(64) },
      grantState: state!,
      now,
      requestingWorkspaceId: audience.id,
      target,
    })
    expect(forged).toEqual({
      action: 'deny',
      ok: false,
      reason: 'target_mismatch',
      stage: 'retrieval',
    })

    // Revocation flips the stored state, and the gate refuses by name.
    await revokeArtifactReferenceGrant(connection.db, audience.id, audienceOwner, input.grantId)
    const revoked = await readCurrentArtifactReferenceGrant(connection.db, {
      grantId: input.grantId,
      revision: 1,
    })
    expect(revoked?.revoked).toBe(true)
    const denied = authorizeArtifactReferenceRetrieval({
      authority: { kind: 'workspace_grant' },
      evidence,
      grant: { ...presented, revokedAt: now },
      grantState: revoked!,
      now,
      requestingWorkspaceId: audience.id,
      target,
    })
    expect(denied).toEqual({
      action: 'deny',
      ok: false,
      reason: 'grant_revoked',
      stage: 'retrieval',
    })
  })

  test('the current-grant reader is transaction scoped', async () => {
    const { audience, owner, source } = await fixture('transaction-scope')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)
    await registerArtifactReferenceGrant(connection.db, source.id, owner, input)

    await inTransaction(connection.db, async (transaction) => {
      // The reader resolves through the caller's transaction handle.
      const committed = await readCurrentArtifactReferenceGrant(transaction, {
        grantId: input.grantId,
        revision: 1,
      })
      expect(committed?.grantId).toBe(input.grantId)

      // An uncommitted registration is visible inside, never outside.
      const uncommitted = inputFor(source, audience, created.id)
      await transaction.insert(artifactReferenceGrants).values({
        artifactId: uncommitted.artifactId,
        audienceWorkspaceId: uncommitted.audienceWorkspaceId,
        checksumSha256: uncommitted.checksumSha256,
        grantId: uncommitted.grantId,
        revision: 1,
        sourceWorkspaceId: source.id,
        version: 1,
      })
      const inside = await readCurrentArtifactReferenceGrant(transaction, {
        grantId: uncommitted.grantId,
        revision: 1,
      })
      expect(inside?.grantId).toBe(uncommitted.grantId)
      const outside = await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: uncommitted.grantId,
        revision: 1,
      })
      expect(outside).toBeNull()
      throw new Error('rollback marker')
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== 'rollback marker') throw error
    })

    // The rolled-back registration never became durable.
    expect(
      await connection.db
        .select()
        .from(artifactReferenceGrants)
        .where(
          and(
            eq(artifactReferenceGrants.grantId, input.grantId),
            eq(artifactReferenceGrants.revision, 1)
          )
        )
    ).toHaveLength(1)
  })

  test('registration resolves the canonical artifact record: divergent version or checksum is refused and nothing persists', async () => {
    const { audience, owner, source } = await fixture('canonical')
    const created = await createAvailableArtifact(source.id, owner)

    // A version the artifact record does not carry is refused; nothing is
    // persisted: the caller never gets to relabel the granted version.
    const staleVersion = inputFor(source, audience, created.id, { version: created.version + 1 })
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, staleVersion)
    ).rejects.toThrow('Artifact reference grant target diverges from the artifact record')
    expect(await storedRows(staleVersion.grantId)).toHaveLength(0)

    // Likewise a checksum that is not the artifact's content identity.
    const foreignDigest = inputFor(source, audience, created.id, { checksumSha256: 'c'.repeat(64) })
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, foreignDigest)
    ).rejects.toThrow('Artifact reference grant target diverges from the artifact record')
    expect(await storedRows(foreignDigest.grantId)).toHaveLength(0)

    // Matching values persist bound to the canonical record.
    const canonical = inputFor(source, audience, created.id)
    const registered = await registerArtifactReferenceGrant(
      connection.db,
      source.id,
      owner,
      canonical
    )
    expect(registered.state.version).toBe(created.version)
    expect(registered.state.checksumSha256).toBe(created.checksumSha256)
    expect(await storedRows(canonical.grantId)).toHaveLength(1)
  })

  test('grant registration requires an authoritative issuer and live workspaces on both sides', async () => {
    const { audience, owner, source } = await fixture('issuer-authority')
    const created = await createAvailableArtifact(source.id, owner)
    const member = await temporaryUser('issuer-authority-member')
    await addWorkspaceMembership(connection.db, source.id, member, 'member')
    const input = inputFor(source, audience, created.id)

    // A mere member is not an issuer: granting cross-workspace access is an
    // authoritative act reserved to owner/admin roles.
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, member, input)
    ).rejects.toThrow('Artifact reference grant issuer unauthorized')
    expect(await storedRows(input.grantId)).toHaveLength(0)

    // A dead (archived) source workspace cannot anchor a grant.
    await archiveWorkspace(connection.db, source.id, owner)
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    ).rejects.toThrow('Artifact reference grant workspace inactive')
    expect(await storedRows(input.grantId)).toHaveLength(0)

    // ... and neither can a dead audience workspace.
    const second = await fixture('issuer-authority-audience')
    const secondArtifact = await createAvailableArtifact(second.source.id, second.owner)
    await archiveWorkspace(connection.db, second.audience.id, second.audienceOwner)
    const secondInput = inputFor(second.source, second.audience, secondArtifact.id)
    await expect(
      registerArtifactReferenceGrant(connection.db, second.source.id, second.owner, secondInput)
    ).rejects.toThrow('Artifact reference grant workspace inactive')
    expect(await storedRows(secondInput.grantId)).toHaveLength(0)
  })

  test('a registration retry after revocation fails closed and never restores access', async () => {
    const { audience, owner, source } = await fixture('retry-after-revocation')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const first = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(first.state.revision).toBe(1)
    await revokeArtifactReferenceGrant(connection.db, source.id, owner, input.grantId)

    // Retrying the ORIGINAL registration after revocation must fail closed:
    // it never restores access and never bumps the revision. Restoring access
    // is an explicit, revision-checked regrant — never a registration replay.
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    ).rejects.toThrow(
      'Artifact reference grant registration after revocation requires an explicit regrant'
    )

    // The refusal changed nothing: same revision, still revoked, no new state.
    const [row] = await storedRows(input.grantId)
    expect(row?.revision).toBe(1)
    expect(row?.revokedAt).not.toBeNull()
    const current = await readCurrentArtifactReferenceGrant(connection.db, {
      grantId: input.grantId,
      revision: 1,
    })
    expect(current?.revoked).toBe(true)
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: input.grantId,
        revision: 2,
      })
    ).toBeNull()
  })

  test('explicit regrant is revision-checked: wrong expectations are refused, the correct one mints the next revision', async () => {
    const { audience, owner, source } = await fixture('explicit-regrant')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const first = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(first.state.revision).toBe(1)
    await revokeArtifactReferenceGrant(connection.db, source.id, owner, input.grantId)

    // A malformed, stale, or ahead-of-store expected revision is refused and
    // changes nothing: the row stays revoked at its current revision.
    for (const expectedRevision of [0, -1, 2.5, Number.NaN, 2]) {
      await expect(
        regrantArtifactReferenceGrant(connection.db, source.id, owner, input, expectedRevision)
      ).rejects.toThrow('Artifact reference grant revision conflict')
    }
    const unchanged = await storedRows(input.grantId)
    expect(unchanged).toHaveLength(1)
    expect(unchanged[0]?.revision).toBe(1)
    expect(unchanged[0]?.revokedAt).not.toBeNull()

    // Regranting an id that was never registered is refused too.
    await expect(
      regrantArtifactReferenceGrant(
        connection.db,
        source.id,
        owner,
        inputFor(source, audience, created.id),
        1
      )
    ).rejects.toThrow('Artifact reference grant not registered')

    // The correct expectation mints the next positive revision and access.
    const second = await regrantArtifactReferenceGrant(connection.db, source.id, owner, input, 1)
    expect(second.outcome).toBe('registered')
    expect(second.state.revision).toBe(2)
    expect(second.state.revoked).toBe(false)

    // The old revision stays denied forever; only the new one reads current.
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: input.grantId,
        revision: 1,
      })
    ).toBeNull()
    expect(
      await readCurrentArtifactReferenceGrant(connection.db, {
        grantId: input.grantId,
        revision: 2,
      })
    ).toEqual(second.state)

    // A retry of the completed regrant presents the superseded revision: refused.
    await expect(
      regrantArtifactReferenceGrant(connection.db, source.id, owner, input, 1)
    ).rejects.toThrow('Artifact reference grant revision conflict')

    // The live grant presented at its current revision replays unchanged.
    const replay = await regrantArtifactReferenceGrant(connection.db, source.id, owner, input, 2)
    expect(replay.outcome).toBe('existing')
    expect(replay.state).toEqual(second.state)
    expect(await storedRows(input.grantId)).toHaveLength(1)
  })

  test('revocation cannot race the locked authorization callback', async () => {
    const { audience, audienceOwner, owner, source } = await fixture('lock-race')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)
    await registerArtifactReferenceGrant(connection.db, source.id, owner, input)

    const scope = {
      artifactId: created.id,
      grantId: input.grantId,
      revision: 1,
      sourceWorkspaceId: source.id,
    }
    const events: string[] = []
    const callbackEntered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()

    // The authorize path holds the artifact and grant row locks across the
    // callback; a slow callback parks the transaction inside them.
    const authorized = withArtifactReferenceGrantLocks(connection.db, scope, async (_t, state) => {
      events.push('callback-entered')
      callbackEntered.resolve()
      await release.promise
      events.push('callback-completed')
      return state
    })
    await callbackEntered.promise

    let revocationSettled = false
    const revocation = revokeArtifactReferenceGrant(
      connection.db,
      audience.id,
      audienceOwner,
      input.grantId
    ).then((state) => {
      events.push('revocation-committed')
      revocationSettled = true
      return state
    })

    // Observe the real lock wait before releasing it; no fixed sleep guesses
    // the schedule (the runtime-node-delivery lane's pattern).
    try {
      await waitForLockWait('artifact_reference_grants')
      expect(revocationSettled).toBe(false)
    } catch (error) {
      const activity = await connection.db.execute(
        sql`select state, wait_event_type, wait_event, left(query, 70) as q
            from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`
      )
      throw new Error(
        `race wait failed: settled=${revocationSettled} events=${JSON.stringify(events)} activity=${JSON.stringify(activity)}`,
        { cause: error }
      )
    } finally {
      // Never leave the authorize transaction parked: a failure here would
      // hold its row locks and block cleanup behind it.
      release.resolve()
    }

    const authorizedState = await authorized
    await revocation

    // The callback observed a consistent live grant; the revocation could
    // only commit after the callback completed and the locks were released.
    expect(authorizedState?.revoked).toBe(false)
    expect(events).toEqual(['callback-entered', 'callback-completed', 'revocation-committed'])

    // Once revocation is visible, a fresh authorization attempt reads the
    // locked current grant as revoked.
    const afterRevocation = await withArtifactReferenceGrantLocks(
      connection.db,
      scope,
      (_t, state) => Promise.resolve(state)
    )
    expect(afterRevocation?.revoked).toBe(true)
  })

  test('regrant and locked authorization race under one artifact-first lock order', async () => {
    const { audience, owner, source } = await fixture('regrant-authorize-order')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)
    await registerArtifactReferenceGrant(connection.db, source.id, owner, input)

    // Two dedicated single-session lanes: a lock cycle needs two independent
    // sessions, and a session-level statement timeout bounds each side so a
    // regressed order fails the test instead of hanging it.
    const authorityLane = createDatabase(connectionUrl!)
    const regrantLane = createDatabase(connectionUrl!)
    try {
      await authorityLane.db.execute(sql`set statement_timeout = '15s'`)
      await regrantLane.db.execute(sql`set statement_timeout = '15s'`)

      for (let round = 1; round <= 3; round++) {
        // Each round regrants a revoked grant at its current revision, so the
        // regrant takes the full CAS path while the authorize transaction is
        // parked inside the locks.
        await revokeArtifactReferenceGrant(connection.db, source.id, owner, input.grantId)
        const scope = {
          artifactId: created.id,
          grantId: input.grantId,
          revision: round,
          sourceWorkspaceId: source.id,
        }
        const callbackEntered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()

        const authorized = withArtifactReferenceGrantLocks(
          authorityLane.db,
          scope,
          async (_t, state) => {
            callbackEntered.resolve()
            await release.promise
            return state
          }
        )
        await callbackEntered.promise

        // The regrant races the parked authorization: it must block, and it
        // must block on the ARTIFACT row — the same artifact-first order the
        // authorize path uses — never on the grant row behind an
        // authorization that holds the artifact. pg_stat_activity and
        // pg_locks observe the real wait: the blocked transaction's first
        // statement has already taken its table lock, so the relation set
        // names which row it reached without guessing a schedule.
        const regranted = regrantArtifactReferenceGrant(
          regrantLane.db,
          source.id,
          owner,
          input,
          round
        )
        let waitingRelations: string[] = []
        try {
          waitingRelations = await waitForLockedRelations()
          // The grant-table statement has not started: the wait is on the
          // artifact row, and only the artifact table lock is held.
          expect(waitingRelations).toContain('artifacts')
          expect(waitingRelations).not.toContain('artifact_reference_grants')
        } catch (error) {
          const activity = await connection.db.execute(
            sql`select state, wait_event_type, left(query, 120) as q
                from pg_stat_activity
                where datname = current_database() and pid <> pg_backend_pid()`
          )
          throw new Error(
            `lock-order observation failed: waiting=${JSON.stringify(waitingRelations)} activity=${JSON.stringify(activity)}`,
            { cause: error }
          )
        } finally {
          // Never leave the authorize transaction parked: a failure here
          // would hold its row locks and block cleanup behind it.
          release.resolve()
        }

        // One waits, both complete: no deadlock abort under the bounded
        // statement timeouts.
        const [authorizedState, regrantState] = await Promise.all([authorized, regranted])
        expect(authorizedState?.revoked).toBe(true)
        expect(regrantState.outcome).toBe('registered')
        expect(regrantState.state.revision).toBe(round + 1)
      }

      // The regrants really landed: the final revision reads current and live.
      const final = await withArtifactReferenceGrantLocks(
        connection.db,
        {
          artifactId: created.id,
          grantId: input.grantId,
          revision: 4,
          sourceWorkspaceId: source.id,
        },
        (_t, state) => Promise.resolve(state)
      )
      expect(final?.revoked).toBe(false)
      expect(final?.revision).toBe(4)
    } finally {
      await authorityLane.close()
      await regrantLane.close()
    }
  })

  test('an issuer whose authority was revoked cannot recover a grant by retrying registration', async () => {
    const { audience, owner, source } = await fixture('revoked-issuer')
    const created = await createAvailableArtifact(source.id, owner)

    // An admin is an authoritative issuer at registration time.
    const admin = await temporaryUser('revoked-issuer-admin')
    await addWorkspaceMembership(connection.db, source.id, admin, 'admin')
    const adminInput = inputFor(source, audience, created.id)
    const registered = await registerArtifactReferenceGrant(
      connection.db,
      source.id,
      admin,
      adminInput
    )
    expect(registered.outcome).toBe('registered')
    expect(registered.state.revision).toBe(1)

    // The workspace removes the admin: per the schema's own membership
    // semantics, the issuer's authority ends with the membership.
    expect(await removeWorkspaceMembership(connection.db, source.id, admin)).toBe(true)

    // The SAME registration retried must not return the existing grant: a
    // caller whose CURRENT authority lapsed gets the same typed rejection a
    // fresh registration gets, and the stored grant is untouched.
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, admin, adminInput)
    ).rejects.toThrow('Artifact reference grant issuer unauthorized')

    const [row] = await storedRows(adminInput.grantId)
    expect(row?.revision).toBe(1)
    expect(row?.revokedAt).toBeNull()

    // A demotion from admin to member revokes issuer authority the same way.
    const demoted = await temporaryUser('revoked-issuer-demoted')
    await addWorkspaceMembership(connection.db, source.id, demoted, 'admin')
    const demotedInput = inputFor(source, audience, created.id)
    const demotedRegistration = await registerArtifactReferenceGrant(
      connection.db,
      source.id,
      demoted,
      demotedInput
    )
    expect(demotedRegistration.outcome).toBe('registered')
    await connection.db
      .update(workspaceMemberships)
      .set({ role: 'member' })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, source.id),
          eq(workspaceMemberships.userId, demoted.userId)
        )
      )
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, demoted, demotedInput)
    ).rejects.toThrow('Artifact reference grant issuer unauthorized')
    const [demotedRow] = await storedRows(demotedInput.grantId)
    expect(demotedRow?.revision).toBe(1)
    expect(demotedRow?.revokedAt).toBeNull()
  })

  test("an authoritative caller's idempotent retry still returns the same row and revision", async () => {
    const { audience, owner, source } = await fixture('idempotent-authority')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const first = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    expect(first.outcome).toBe('registered')
    expect(first.state.revision).toBe(1)

    // Authority is re-checked on every registration path; for a caller whose
    // authority holds, the retry stays idempotent: same state, same revision,
    // no duplicate row.
    for (let attempt = 0; attempt < 2; attempt++) {
      const replay = await registerArtifactReferenceGrant(connection.db, source.id, owner, input)
      expect(replay.outcome).toBe('existing')
      expect(replay.state).toEqual(first.state)
    }
    expect(await storedRows(input.grantId)).toHaveLength(1)
  })

  /** An in-flight revocation or archive, emulated at row-lock level. The
   *  barrier resolves `acquired` only after the exclusive row lock is held,
   *  and releases only when the test explicitly releases it; no fixed
   *  duration guesses the schedule. */
  function holdRowFor(
    table: typeof workspaceMemberships | typeof workspaces,
    column: typeof workspaceMemberships.userId | typeof workspaces.id,
    value: string
  ) {
    const acquired = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const done = connection.db.transaction(async (transaction) => {
      await transaction
        .select({ locked: column })
        .from(table)
        .where(eq(column, value))
        .for('update')
      acquired.resolve()
      await release.promise
    })
    return { acquired: acquired.promise, done, release: () => release.resolve() }
  }

  /** Wait, bounded and event-driven, until another backend is blocked on a row
   *  lock whose current statement mentions `needle`, then return. The caller
   *  releases the held lock only after this wait is observed, so no fixed
   *  duration is assumed. */
  async function waitForLockWait(needle: string): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const rows = await connection.db.execute(
        sql`select pid from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database()
              and pid <> pg_backend_pid()
              and query ilike ${`%${needle}%`}`
      )
      if (rows.length > 0) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const activity = await connection.db.execute(
      sql`select state, wait_event_type, wait_event, left(query, 90) as q
          from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`
    )
    throw new Error(`no backend blocked on ${needle}: ${JSON.stringify(activity)}`)
  }

  /** The granted relation set of the blocked backend, observed without fixed
   *  delays; the lock-order proof fails if no blocked backend ever appears. */
  async function waitForLockedRelations(): Promise<string[]> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const rows = await connection.db.execute(
        sql`select coalesce(array_agg(c.relname) filter (where c.relname is not null), '{}')
              as relations
            from pg_stat_activity a
            left join pg_locks l on l.pid = a.pid and l.granted
            left join pg_class c on c.oid = l.relation
              and c.relname in ('artifacts', 'artifact_reference_grants')
            where a.wait_event_type = 'Lock' and a.datname = current_database()
              and a.state <> 'idle'
            group by a.pid
            limit 1`
      )
      const relations = (rows[0] as { relations?: string[] } | undefined)?.relations
      if (relations !== undefined) return relations
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('no blocked backend was observed for the lock-order relations')
  }

  test('membership removal cannot interleave with registration: the issuer row is share-locked', async () => {
    const { audience, source } = await fixture('race-membership')
    const admin = await temporaryUser('race-membership-admin')
    await addWorkspaceMembership(connection.db, source.id, admin, 'admin')
    const created = await createAvailableArtifact(source.id, admin)
    const input = inputFor(source, audience, created.id)

    // An in-flight removal holds the issuer's membership row exclusively —
    // exactly the state a concurrent removeWorkspaceMembership creates
    // between its delete and its commit. The barrier resolves only once the
    // row lock is held; the registration is released only after its wait on
    // the share lock is observed.
    const holder = holdRowFor(workspaceMemberships, workspaceMemberships.userId, admin.userId)
    await holder.acquired

    const registration = registerArtifactReferenceGrant(connection.db, source.id, admin, input)
    try {
      // While the removal is unresolved, the registration cannot have passed
      // its authority check, so nothing may be written. Without the share lock
      // this read saw the grant row already committed here.
      await waitForLockWait('workspace_memberships')
      expect(await storedRows(input.grantId)).toHaveLength(0)
    } finally {
      holder.release()
    }
    await holder.done
    const registered = await registration
    expect(registered.outcome).toBe('registered')
    expect(await storedRows(input.grantId)).toHaveLength(1)
  })

  test('a membership removal that committed first refuses the registration', async () => {
    const { audience, source } = await fixture('race-revoked-first')
    const admin = await temporaryUser('race-revoked-first-admin')
    await addWorkspaceMembership(connection.db, source.id, admin, 'admin')
    const created = await createAvailableArtifact(source.id, admin)
    const input = inputFor(source, audience, created.id)

    expect(await removeWorkspaceMembership(connection.db, source.id, admin)).toBe(true)
    await expect(
      registerArtifactReferenceGrant(connection.db, source.id, admin, input)
    ).rejects.toThrow('Artifact reference grant issuer unauthorized')
    expect(await storedRows(input.grantId)).toHaveLength(0)
  })

  test('archiving the source workspace cannot interleave with registration: the workspace row is share-locked', async () => {
    const { audience, owner, source } = await fixture('race-archive')
    const created = await createAvailableArtifact(source.id, owner)
    const input = inputFor(source, audience, created.id)

    const holder = holdRowFor(workspaces, workspaces.id, source.id)
    await holder.acquired

    const registration = registerArtifactReferenceGrant(connection.db, source.id, owner, input)
    try {
      await waitForLockWait('workspaces')
      expect(await storedRows(input.grantId)).toHaveLength(0)
    } finally {
      holder.release()
    }
    await holder.done
    const registered = await registration
    expect(registered.outcome).toBe('registered')
    expect(await storedRows(input.grantId)).toHaveLength(1)
  })
})
