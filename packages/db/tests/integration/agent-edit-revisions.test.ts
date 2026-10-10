import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  AgentRevisionConflictError,
  assignAgentToProject,
  changeAgentProfile,
  createAgent,
  ensureWorkspaceLead,
  getAgentForUser,
  updateAgentPresentation,
} from '../../src/agents'
import { createProject } from '../../src/projects'
import {
  agents,
  channels,
  projects,
  temporaryUserSessions,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('Agent edit revisions', () => {
  let connection: DatabaseConnection

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => connection.close())

  function temporarySession(label: string) {
    return createTemporaryUserSession(connection.db, {
      credentialDigest: `${label}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
  }

  async function cleanup(workspaceIds: string[], userIds: string[]) {
    // One statement per table for the whole batch, children before parents.
    if (workspaceIds.length) {
      await connection.db.delete(agents).where(inArray(agents.workspaceId, workspaceIds))
      await connection.db.delete(channels).where(inArray(channels.workspaceId, workspaceIds))
      await connection.db.delete(projects).where(inArray(projects.workspaceId, workspaceIds))
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
  }

  test('advances one revision per presentation or placement edit and refuses stale openings without writing', async () => {
    const owner = await temporarySession('revision-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Revisions',
      owner: owner.principal,
    })
    const project = await createProject(connection.db, workspace.id, owner.principal, {
      iconKey: 'engineering',
      name: 'Engineering',
    })
    const ada = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Ada',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
    })
    expect(ada.revision).toBe(0)

    const renamed = await updateAgentPresentation(
      connection.db,
      workspace.id,
      ada.id,
      owner.principal,
      { expectedRevision: 0, name: 'Ada Lovelace', roleSummary: 'Principal engineer' }
    )
    expect(renamed).toMatchObject({ id: ada.id, name: 'Ada Lovelace', revision: 1 })

    const assigned = await assignAgentToProject(
      connection.db,
      workspace.id,
      ada.id,
      owner.principal,
      {
        expectedRevision: 1,
        projectId: project.id,
      }
    )
    expect(assigned).toMatchObject({ id: ada.id, projectId: project.id, revision: 2 })

    // Both attempts were opened before the rename and placement; neither may overwrite them.
    await expect(
      updateAgentPresentation(connection.db, workspace.id, ada.id, owner.principal, {
        expectedRevision: 0,
        name: 'Stale rename',
      })
    ).rejects.toBeInstanceOf(AgentRevisionConflictError)
    await expect(
      assignAgentToProject(connection.db, workspace.id, ada.id, owner.principal, {
        expectedRevision: 1,
        projectId: null,
      })
    ).rejects.toBeInstanceOf(AgentRevisionConflictError)

    expect(
      await getAgentForUser(connection.db, workspace.id, ada.id, owner.principal)
    ).toMatchObject({ name: 'Ada Lovelace', projectId: project.id, revision: 2 })
    const events = await connection.db
      .select({ eventType: workspaceEvents.eventType })
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, workspace.id))
    expect(events.filter((event) => event.eventType === 'agent.presentation_updated')).toHaveLength(
      1
    )
    expect(events.filter((event) => event.eventType === 'agent.project_assigned')).toHaveLength(1)

    await cleanup([workspace.id], [owner.principal.userId])
  })

  test('concurrent presentation edits from one opening produce exactly one winner', async () => {
    const owner = await temporarySession('revision-race-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Race',
      owner: owner.principal,
    })
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Grace',
      profileId: 'compiler-engineer',
      profileVersion: '1.0.0',
    })

    const race = await Promise.allSettled(
      ['Grace Hopper', 'Rear Admiral Hopper'].map((name) =>
        updateAgentPresentation(connection.db, workspace.id, agent.id, owner.principal, {
          expectedRevision: 0,
          name,
        })
      )
    )
    const won = race.filter((result) => result.status === 'fulfilled')
    const lost = race.filter((result) => result.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(AgentRevisionConflictError)

    const winner = (won[0] as PromiseFulfilledResult<{ name: string; revision?: number }>).value
    expect(winner.revision).toBe(1)
    expect(
      await getAgentForUser(connection.db, workspace.id, agent.id, owner.principal)
    ).toMatchObject({ name: winner.name, revision: 1 })

    await cleanup([workspace.id], [owner.principal.userId])
  })

  test('profile pins and presentation revisions advance independently', async () => {
    const owner = await temporarySession('revision-independence-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Independence',
      owner: owner.principal,
    })
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Linus',
      profileId: 'kernel-engineer',
      profileVersion: '1.0.0',
    })

    const repinned = await changeAgentProfile(
      connection.db,
      workspace.id,
      agent.id,
      owner.principal,
      {
        expectedRevision: 0,
        profileId: 'kernel-engineer',
        profileVersion: '1.1.0',
      }
    )
    expect(repinned).toMatchObject({ revision: 0, profile: { revision: 1, version: '1.1.0' } })

    const renamed = await updateAgentPresentation(
      connection.db,
      workspace.id,
      agent.id,
      owner.principal,
      {
        expectedRevision: 0,
        name: 'Linus Torvalds',
      }
    )
    expect(renamed).toMatchObject({ revision: 1, profile: { revision: 1, version: '1.1.0' } })

    // The pin opening is still current: a presentation edit never bumps the profile revision.
    const repinnedAgain = await changeAgentProfile(
      connection.db,
      workspace.id,
      agent.id,
      owner.principal,
      { expectedRevision: 1, profileId: 'kernel-engineer', profileVersion: '1.2.0' }
    )
    expect(repinnedAgain).toMatchObject({ revision: 1, profile: { revision: 2, version: '1.2.0' } })

    await cleanup([workspace.id], [owner.principal.userId])
  })

  test('the workspace lead keeps its identity through revision-checked presentation edits', async () => {
    const owner = await temporarySession('revision-lead-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Lead revisions',
      owner: owner.principal,
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    expect(lead.revision).toBe(0)

    const named = await updateAgentPresentation(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      {
        expectedRevision: 0,
        name: 'My lead',
      }
    )
    expect(named).toMatchObject({
      id: lead.id,
      isWorkspaceLead: true,
      name: 'My lead',
      revision: 1,
    })

    // A second window that still shows the provisioned lead must not replace the first edit.
    await expect(
      updateAgentPresentation(connection.db, workspace.id, lead.id, owner.principal, {
        expectedRevision: 0,
        name: 'Stale lead',
      })
    ).rejects.toBeInstanceOf(AgentRevisionConflictError)
    expect(
      await getAgentForUser(connection.db, workspace.id, lead.id, owner.principal)
    ).toMatchObject({ id: lead.id, isWorkspaceLead: true, name: 'My lead', revision: 1 })

    await cleanup([workspace.id], [owner.principal.userId])
  })

  test('malformed or out-of-range expected revisions never write', async () => {
    const owner = await temporarySession('revision-malformed-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Malformed',
      owner: owner.principal,
    })
    const agent = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Hedy',
      profileId: 'inventor',
      profileVersion: '1.0.0',
    })

    for (const expectedRevision of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 1]) {
      await expect(
        updateAgentPresentation(connection.db, workspace.id, agent.id, owner.principal, {
          expectedRevision,
          name: 'Invalid write',
        })
      ).rejects.toBeInstanceOf(AgentRevisionConflictError)
    }
    expect(
      await getAgentForUser(connection.db, workspace.id, agent.id, owner.principal)
    ).toMatchObject({ name: 'Hedy', revision: 0 })

    await cleanup([workspace.id], [owner.principal.userId])
  })
})
