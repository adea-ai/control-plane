// Protected Home and blank optional workspaces: no inferred lead, agents, channels or
// context are copied between workspaces, and provisioning makes no outbound call.
// Reuses the existing bootstrap, creation, lead and personal-root guards; it adds no Home
// logic of its own. Credentials and model defaults live in the Control Plane and are
// never written here, so the transport spy is the copy/inference check for them.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import { createTemporaryUserSession } from '../../src/identity'
import {
  archiveWorkspace,
  createWorkspaceWithOwner,
  deleteWorkspace,
  ensureBootstrapWorkspaces,
} from '../../src/workspaces'
import { createAgent, ensureWorkspaceLead, getWorkspaceLeadForUser } from '../../src/agents'
import {
  agents,
  channels,
  projects,
  runtimeNodes,
  tasks,
  temporaryUserSessions,
  users,
  workspaceDeletions,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'

describe.skipIf(!process.env.DATABASE_URL)('blank workspace isolation and protected Home', () => {
  let connection: DatabaseConnection
  const fixtureUsers: string[] = []
  let outbound = 0
  const realFetch = globalThis.fetch

  beforeAll(() => {
    connection = createDatabase(process.env.DATABASE_URL!)
  })
  beforeEach(() => {
    outbound = 0
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      outbound += 1
      return realFetch(...args)
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  afterAll(async () => {
    const rows = await connection.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.ownerUserId, fixtureUsers))
    const ids = rows.map((row) => row.id)
    if (ids.length) {
      await connection.db.delete(agents).where(inArray(agents.workspaceId, ids))
      await connection.db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, ids))
      await connection.db.delete(workspaces).where(inArray(workspaces.id, ids))
    }
    await connection.db
      .delete(workspaceDeletions)
      .where(inArray(workspaceDeletions.ownerUserId, fixtureUsers))
    await connection.db
      .delete(temporaryUserSessions)
      .where(inArray(temporaryUserSessions.userId, fixtureUsers))
    await connection.db.delete(users).where(inArray(users.id, fixtureUsers))
    await connection.close()
  })

  async function guest() {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
    })
    fixtureUsers.push(session.principal.userId)
    return session.principal
  }

  async function assertBlank(workspaceId: string) {
    for (const table of [projects, agents, tasks, runtimeNodes, channels])
      expect(
        await connection.db.select().from(table).where(eq(table.workspaceId, workspaceId))
      ).toEqual([])
  }

  test('Home is provisioned with no lead and no outbound call; its lead is only created on request', async () => {
    const principal = await guest()
    const [home] = await ensureBootstrapWorkspaces(connection.db, principal)
    expect(home).toMatchObject({ isPersonal: true, logo: { kind: 'home' } })
    expect(await getWorkspaceLeadForUser(connection.db, home!.id, principal)).toBeNull()
    await assertBlank(home!.id)
    expect(outbound).toBe(0)
  })

  test('an optional blank workspace inherits nothing from Home: no lead, agents, channels, or context', async () => {
    const principal = await guest()
    const [home] = await ensureBootstrapWorkspaces(connection.db, principal)
    await ensureWorkspaceLead(connection.db, home!.id, principal)
    await createAgent(connection.db, home!.id, principal, {
      name: 'Home only',
      profileId: 'profile-home',
      profileVersion: '1',
    })

    const { workspace: blank, created } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `blank-${crypto.randomUUID()}`,
      name: 'Blank',
      owner: principal,
      scene: 'work',
    })
    expect(created).toBe(true)
    expect(blank).toMatchObject({ isPersonal: false, logo: { kind: 'box' } })
    expect(await getWorkspaceLeadForUser(connection.db, blank.id, principal)).toBeNull()
    await assertBlank(blank.id)
    // Home still holds its own lead and agent; the blank workspace has neither.
    expect(await getWorkspaceLeadForUser(connection.db, home!.id, principal)).not.toBeNull()
    expect(outbound).toBe(0)
  })

  test('the personal root refuses deletion and archive through the existing guards', async () => {
    const principal = await guest()
    const [home] = await ensureBootstrapWorkspaces(connection.db, principal)
    const confirmation = { confirmationName: home!.name, expectedVersion: home!.version }
    await expect(deleteWorkspace(connection.db, home!.id, principal, confirmation)).rejects.toThrow(
      'personal workspace cannot be deleted'
    )
    await expect(archiveWorkspace(connection.db, home!.id, principal)).rejects.toThrow(
      'personal workspace cannot be deleted'
    )
    expect(outbound).toBe(0)
  })
})
