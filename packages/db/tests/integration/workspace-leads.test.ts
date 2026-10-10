import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  archiveAgent,
  assignAgentToProject,
  changeAgentProfile,
  createAgent,
  ensureWorkspaceLead,
  getAgentForUser,
  getWorkspaceLeadForUser,
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

// Postgres reports the violated constraint on the error that drizzle wraps as `cause`.
async function expectConstraintViolation(promise: Promise<unknown>, code: string, name: string) {
  const failure = await promise.then(
    () => {
      throw new Error(`Expected ${name} to refuse the write`)
    },
    (error: unknown) => error
  )
  const cause = (failure as { cause?: unknown }).cause ?? failure
  expect(cause).toMatchObject({ code, constraint_name: name })
}

describe.skipIf(!connectionUrl)('structural workspace lead', () => {
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

  async function agentRow(agentId: string) {
    const [row] = await connection.db.select().from(agents).where(eq(agents.id, agentId))
    if (!row) throw new Error('Agent row missing')
    return row
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

  test('provisions exactly one lead under concurrent retries without replacing existing Agents', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `lead-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Lead fixture',
      owner: owner.principal,
    })
    const custom = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Custom',
      profileId: 'custom-profile',
      profileVersion: '1',
    })
    const archived = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Archived',
      profileId: 'historical-profile',
      profileVersion: '1',
    })
    await archiveAgent(connection.db, workspace.id, archived.id, owner.principal)
    expect(await getWorkspaceLeadForUser(connection.db, workspace.id, owner.principal)).toBeNull()
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
      )
    )
    expect(new Set(results.map((lead) => lead.id)).size).toBe(1)
    const lead = results[0]!
    expect(lead).toMatchObject({
      isWorkspaceLead: true,
      workspaceId: workspace.id,
      lifecycleState: 'active',
      profile: { state: 'missing', revision: 0 },
    })
    expect(lead.projectId).toBeUndefined()
    const renamed = await updateAgentPresentation(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { expectedRevision: 0, name: 'My lead', roleSummary: 'Customized lead' }
    )
    expect(await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)).toEqual(renamed)
    const rows = await connection.db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, workspace.id))
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.id === custom.id)).toMatchObject({
      profileId: 'custom-profile',
      isWorkspaceLead: false,
    })
    expect(rows.find((row) => row.id === archived.id)).toMatchObject({
      lifecycleState: 'archived',
      isWorkspaceLead: false,
    })
    const events = await connection.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, workspace.id))
    expect(events.filter((event) => event.eventType === 'agent.created')).toHaveLength(3)
    await expect(
      archiveAgent(connection.db, workspace.id, lead.id, owner.principal)
    ).rejects.toThrow('Agent unavailable')
    await expect(
      connection.db
        .insert(agents)
        .values({
          workspaceId: workspace.id,
          name: 'Duplicate',
          profileId: 'p',
          profileVersion: '1',
          isWorkspaceLead: true,
        })
        .execute()
    ).rejects.toThrow()
  })

  test('denies outsiders, member provisioning, and cross-workspace discovery without side effects', async () => {
    const owner = await createTemporaryUserSession(connection.db, {
      credentialDigest: `lead-scope-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const outsider = await createTemporaryUserSession(connection.db, {
      credentialDigest: `lead-denied-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Private',
      owner: owner.principal,
    })
    await expect(
      ensureWorkspaceLead(connection.db, workspace.id, outsider.principal)
    ).rejects.toThrow('Agent unavailable')
    expect(
      await getWorkspaceLeadForUser(connection.db, workspace.id, outsider.principal)
    ).toBeNull()
    expect(
      await connection.db.select().from(agents).where(eq(agents.workspaceId, workspace.id))
    ).toHaveLength(0)
    await connection.db
      .insert(workspaceMemberships)
      .values({ workspaceId: workspace.id, userId: outsider.principal.userId, role: 'member' })
    await expect(
      ensureWorkspaceLead(connection.db, workspace.id, outsider.principal)
    ).rejects.toThrow('Agent unavailable')
    await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    expect(
      await getWorkspaceLeadForUser(connection.db, crypto.randomUUID(), owner.principal)
    ).toBeNull()
  })

  test('gives each workspace its own single lead and never reads one through another', async () => {
    const owner = await temporarySession('lead-cross-owner')
    const member = await temporarySession('lead-cross-member')
    const first = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'First',
      owner: owner.principal,
    })
    const second = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Second',
      owner: owner.principal,
    })
    const firstLead = await ensureWorkspaceLead(connection.db, first.workspace.id, owner.principal)
    const secondLead = await ensureWorkspaceLead(
      connection.db,
      second.workspace.id,
      owner.principal
    )

    expect(secondLead.id).not.toBe(firstLead.id)
    expect(secondLead.workspaceId).toBe(second.workspace.id)
    expect(await ensureWorkspaceLead(connection.db, first.workspace.id, owner.principal)).toEqual(
      firstLead
    )
    const leads = await connection.db
      .select({ id: agents.id, workspaceId: agents.workspaceId })
      .from(agents)
      .where(
        and(
          inArray(agents.workspaceId, [first.workspace.id, second.workspace.id]),
          eq(agents.isWorkspaceLead, true)
        )
      )
    expect(leads.filter((lead) => lead.workspaceId === first.workspace.id)).toEqual([
      { id: firstLead.id, workspaceId: first.workspace.id },
    ])
    expect(leads.filter((lead) => lead.workspaceId === second.workspace.id)).toEqual([
      { id: secondLead.id, workspaceId: second.workspace.id },
    ])
    expect(
      await getWorkspaceLeadForUser(connection.db, first.workspace.id, owner.principal)
    ).toEqual(firstLead)
    expect(
      await getAgentForUser(connection.db, first.workspace.id, secondLead.id, owner.principal)
    ).toBeNull()

    // Membership in only the second workspace reveals only its lead.
    await connection.db
      .insert(workspaceMemberships)
      .values({ workspaceId: second.workspace.id, userId: member.principal.userId, role: 'member' })
    expect(
      await getWorkspaceLeadForUser(connection.db, first.workspace.id, member.principal)
    ).toBeNull()
    expect(
      await getWorkspaceLeadForUser(connection.db, second.workspace.id, member.principal)
    ).toEqual(secondLead)

    await cleanup(
      [first.workspace.id, second.workspace.id],
      [owner.principal.userId, member.principal.userId]
    )
  })

  test('refuses a second lead in the same workspace even through a direct write', async () => {
    const owner = await temporarySession('lead-direct-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Direct writes',
      owner: owner.principal,
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const custom = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Would-be lead',
      profileId: 'custom-profile',
      profileVersion: '1',
    })

    await expectConstraintViolation(
      connection.db
        .update(agents)
        .set({ isWorkspaceLead: true })
        .where(eq(agents.id, custom.id))
        .execute(),
      '23505',
      'agents_workspace_lead_unique'
    )
    expect(await agentRow(custom.id)).toMatchObject({ isWorkspaceLead: false })
    expect(
      await getWorkspaceLeadForUser(connection.db, workspace.id, owner.principal)
    ).toMatchObject({ id: lead.id })

    await cleanup([workspace.id], [owner.principal.userId])
  })

  test('keeps a designated lead out of Projects and out of archive', async () => {
    const owner = await temporarySession('lead-placement-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Placement',
      owner: owner.principal,
    })
    const project = await createProject(connection.db, workspace.id, owner.principal, {
      iconKey: 'engineering',
      name: 'Engineering',
    })
    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)

    await expectConstraintViolation(
      assignAgentToProject(connection.db, workspace.id, lead.id, owner.principal, {
        expectedRevision: 0,
        projectId: project.id,
      }),
      '23514',
      'agents_workspace_lead_standalone'
    )
    await expect(
      archiveAgent(connection.db, workspace.id, lead.id, owner.principal)
    ).rejects.toThrow('Agent unavailable')
    expect(await agentRow(lead.id)).toMatchObject({
      isWorkspaceLead: true,
      lifecycleState: 'active',
      projectId: null,
      revision: 0,
    })

    await cleanup([workspace.id], [owner.principal.userId])
  })

  test('leaves custom Agent identity, pins, placement, and attribution intact through lead provisioning and edits', async () => {
    const owner = await temporarySession('lead-identity-owner')
    const { workspace } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: crypto.randomUUID(),
      name: 'Identity',
      owner: owner.principal,
    })
    const project = await createProject(connection.db, workspace.id, owner.principal, {
      iconKey: 'engineering',
      name: 'Engineering',
    })
    const custom = await createAgent(connection.db, workspace.id, owner.principal, {
      name: 'Ada',
      profileId: 'software-engineer',
      profileVersion: '1.0.0',
      roleSummary: 'Builds systems',
    })
    const placed = await assignAgentToProject(
      connection.db,
      workspace.id,
      custom.id,
      owner.principal,
      { expectedRevision: 0, projectId: project.id }
    )
    const customBefore = await agentRow(custom.id)

    const lead = await ensureWorkspaceLead(connection.db, workspace.id, owner.principal)
    const named = await updateAgentPresentation(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { expectedRevision: 0, name: 'My lead' }
    )
    const adopted = await changeAgentProfile(
      connection.db,
      workspace.id,
      lead.id,
      owner.principal,
      { expectedRevision: 0, profileId: 'lead-profile', profileVersion: '1.0.0' }
    )
    expect(adopted).toMatchObject({ id: lead.id, isWorkspaceLead: true, name: 'My lead' })
    expect(named.id).toBe(lead.id)

    // Provisioning and editing the lead must not touch any custom Agent row.
    expect(await agentRow(custom.id)).toEqual(customBefore)
    expect(await getAgentForUser(connection.db, workspace.id, custom.id, owner.principal)).toEqual(
      placed
    )
    expect(customBefore.controlPlaneAgentId).not.toBe((await agentRow(lead.id)).controlPlaneAgentId)

    const created = (
      await connection.db
        .select({ aggregateId: workspaceEvents.aggregateId, actorId: workspaceEvents.actorId })
        .from(workspaceEvents)
        .where(
          and(
            eq(workspaceEvents.workspaceId, workspace.id),
            eq(workspaceEvents.eventType, 'agent.created')
          )
        )
    ).toSorted((left, right) => (left.aggregateId ?? '').localeCompare(right.aggregateId ?? ''))
    expect(created).toEqual(
      [custom.id, lead.id]
        .map((aggregateId) => ({ aggregateId, actorId: owner.principal.userId }))
        .toSorted((left, right) => left.aggregateId.localeCompare(right.aggregateId))
    )

    await cleanup([workspace.id], [owner.principal.userId])
  })
})
