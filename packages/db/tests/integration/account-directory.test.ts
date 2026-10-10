import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import { accountAgentDirectory, findAccountAgent } from '../../src/account-directory'
import { decodeAccountInboxCursor } from '../../src/account-cursor'
import { accountConversationInbox, findAccountConversation } from '../../src/account-inbox'
import { createAgent } from '../../src/agents'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  archiveChannel,
  createDirectAgentChannel,
  createGroupChannel,
  createMessage,
  createProjectChannel,
  setChannelParticipants,
  updateChannel,
} from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { setProjectMember, setProjectVisibility } from '../../src/project-sharing'
import { createProject } from '../../src/projects'
import {
  listReadStateForUser,
  markChannelReadState,
  markThreadReadState,
} from '../../src/read-state'
import {
  agents,
  channelParticipants,
  channelReadStates,
  channels,
  messageMentions,
  messages,
  projects,
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../src/schema'
import {
  addWorkspaceMembership,
  createWorkspaceWithOwner,
  removeWorkspaceMembership,
} from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

/** The directory's total order, evaluated exactly as the SQL orders rows. */
function byDirectoryOrder(
  left: { id: string; name: string; workspaceId: string },
  right: { id: string; name: string; workspaceId: string }
) {
  return (
    (left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0) ||
    (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}

describe.skipIf(!connectionUrl)('account-wide directory and inbox', () => {
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  beforeAll(() => {
    connection = createDatabase(connectionUrl!)
  })
  afterAll(async () => {
    const db = connection.db
    if (workspaceIds.length) {
      await db.delete(threadReadStates).where(inArray(threadReadStates.workspaceId, workspaceIds))
      await db.delete(channelReadStates).where(inArray(channelReadStates.workspaceId, workspaceIds))
      await db.delete(messageMentions).where(inArray(messageMentions.workspaceId, workspaceIds))
      // Replies reference their roots; drop them first.
      await db
        .delete(messages)
        .where(
          and(inArray(messages.workspaceId, workspaceIds), isNotNull(messages.threadRootMessageId))
        )
      await db.delete(messages).where(inArray(messages.workspaceId, workspaceIds))
      await db
        .delete(channelParticipants)
        .where(inArray(channelParticipants.workspaceId, workspaceIds))
      await db.delete(channels).where(inArray(channels.workspaceId, workspaceIds))
      await db.delete(agents).where(inArray(agents.workspaceId, workspaceIds))
      await db.delete(projects).where(inArray(projects.workspaceId, workspaceIds))
      await db.delete(workspaceEvents).where(inArray(workspaceEvents.workspaceId, workspaceIds))
      await db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, workspaceIds))
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    }
    if (userIds.length) {
      await db.delete(temporaryUserSessions).where(inArray(temporaryUserSessions.userId, userIds))
      await db.delete(users).where(inArray(users.id, userIds))
    }
    await connection.close()
  })

  async function user(label: string): Promise<UserPrincipalRef> {
    const session = await createTemporaryUserSession(connection.db, {
      credentialDigest: `directory-${label}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  async function workspace(owner: UserPrincipalRef, name: string) {
    const { workspace: created } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `directory-${crypto.randomUUID()}`,
      name,
      owner,
    })
    workspaceIds.push(created.id)
    return created.id
  }

  async function projectWithChannel(workspaceId: string, owner: UserPrincipalRef, name: string) {
    const project = await createProject(connection.db, workspaceId, owner, {
      iconKey: 'research',
      name,
    })
    const [channel] = await connection.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.projectId, project.id), eq(channels.isPrimaryProjectChannel, true)))
    return { channelId: channel!.id, projectId: project.id }
  }

  function post(
    workspaceId: string,
    channelId: string,
    sender: UserPrincipalRef,
    extra: Partial<Parameters<typeof createMessage>[4]> = {}
  ) {
    return createMessage(connection.db, workspaceId, channelId, sender, {
      bodyText: 'directory fixture',
      idempotencyKey: crypto.randomUUID(),
      sender,
      ...extra,
    })
  }

  /** A participants-only conversation; extra principals are added explicitly. */
  async function groupChannel(workspaceId: string, owner: UserPrincipalRef, title: string) {
    return createGroupChannel(connection.db, workspaceId, owner, {
      idempotencyKey: `directory-${crypto.randomUUID()}`,
      title,
    })
  }

  async function agent(
    workspaceId: string,
    owner: UserPrincipalRef,
    name: string,
    projectId?: string
  ) {
    return createAgent(connection.db, workspaceId, owner, {
      name,
      ...(projectId ? { projectId } : {}),
      profileId: 'profile',
      profileVersion: 'v1',
    })
  }

  test('directory lists same-name agents as distinct stable identities', async () => {
    const alice = await user('dir-alice')
    const bob = await user('dir-bob')
    const one = await workspace(alice, 'Directory One')
    const two = await workspace(alice, 'Directory Two')
    const foreign = await workspace(bob, 'Directory Foreign')
    await addWorkspaceMembership(connection.db, one, bob, 'member')
    // bob's own Atlas in his foreign workspace: a fourth same-name entry that
    // alice must never see.
    await agent(foreign, bob, 'Atlas')

    const atlasOne = await agent(one, alice, 'Atlas')
    const atlasAgain = await agent(one, alice, 'Atlas')
    const radar = await agent(one, alice, 'Radar')
    const atlasTwo = await agent(two, alice, 'Atlas')

    const all = await accountAgentDirectory(connection.db, alice)
    // Workspace-major, then name, then id: the total order the cursor
    // paginates on. Same-name Agents keep their own stable ids.
    const expected = [
      { id: atlasOne.id, name: 'Atlas', workspaceId: one },
      { id: atlasAgain.id, name: 'Atlas', workspaceId: one },
      { id: radar.id, name: 'Radar', workspaceId: one },
      { id: atlasTwo.id, name: 'Atlas', workspaceId: two },
    ].toSorted(byDirectoryOrder)
    expect(all.agents.map(({ id, name, workspaceId }) => ({ id, name, workspaceId }))).toEqual(
      expected
    )
    expect(all.nextCursor).toBeUndefined()

    // Cross-workspace isolation: bob sees his membership set — his own
    // foreign workspace included — and never a workspace only alice has.
    const bobView = await accountAgentDirectory(connection.db, bob)
    expect(bobView.agents.map(({ workspaceId }) => workspaceId).toSorted()).toEqual(
      [one, one, one, foreign].toSorted()
    )
    expect((await accountAgentDirectory(connection.db, alice, { limit: 2 })).agents).toHaveLength(2)

    // Keyset pagination walks one total order regardless of page size.
    const walk = async (limit: number) => {
      const seen: string[] = []
      let after: string | undefined
      for (let page = 0; page < 10; page += 1) {
        const result = await accountAgentDirectory(connection.db, alice, { after, limit })
        seen.push(...result.agents.map(({ id }) => id))
        after = result.nextCursor
        if (!after) break
      }
      expect(after).toBeUndefined()
      return seen
    }
    const byOne = await walk(1)
    const byThree = await walk(3)
    expect(byOne).toEqual(byThree)
    expect([...byOne].toSorted()).toEqual(expected.map(({ id }) => id).toSorted())

    // A new Agent lands on a fresh first page; continuing the open cursor
    // repeats nothing of what was already read.
    const firstPage = await accountAgentDirectory(connection.db, alice, { limit: 2 })
    const latecomer = await agent(one, alice, 'Zephyr')
    const secondPage = await accountAgentDirectory(connection.db, alice, {
      after: firstPage.nextCursor,
      limit: 2,
    })
    for (const entry of secondPage.agents)
      expect(firstPage.agents.some(({ id }) => id === entry.id)).toBe(false)
    expect(
      (await accountAgentDirectory(connection.db, alice, { limit: 100 })).agents.some(
        ({ id }) => id === latecomer.id
      )
    ).toBe(true)
  })

  test('directory project access stays distinct from membership and revocation hides everything', async () => {
    const owner = await user('dir-owner')
    const member = await user('dir-member')
    const outsider = await user('dir-outsider')
    const workspaceId = await workspace(owner, 'Access HQ')
    await addWorkspaceMembership(connection.db, workspaceId, member, 'member')

    const secret = await projectWithChannel(workspaceId, owner, 'Secret Plans')
    const hiddenAgent = await agent(workspaceId, owner, 'Secret Agent', secret.projectId)
    const openAgent = await agent(workspaceId, owner, 'Open Agent')

    const memberAgents = async () =>
      (await accountAgentDirectory(connection.db, member)).agents.map(({ id }) => id)
    const ownerAgents = async () =>
      (await accountAgentDirectory(connection.db, owner)).agents.map(({ id }) => id)

    // Project access (ADR 0012) is its own check: a member of the workspace
    // still cannot see a `members` project's Agent.
    await setProjectVisibility(connection.db, workspaceId, secret.projectId, owner, 'members')
    expect(await memberAgents()).toEqual([openAgent.id])
    expect((await ownerAgents()).toSorted()).toEqual([hiddenAgent.id, openAgent.id].toSorted())
    expect(await findAccountAgent(connection.db, member, hiddenAgent.id)).toBeNull()
    expect(await findAccountAgent(connection.db, outsider, openAgent.id)).toBeNull()
    expect(await findAccountAgent(connection.db, owner, hiddenAgent.id)).toMatchObject({
      id: hiddenAgent.id,
      projectId: secret.projectId,
    })

    // Being listed on the project restores exactly that Agent.
    await setProjectMember(connection.db, workspaceId, secret.projectId, owner, {
      role: 'viewer',
      userId: member.userId,
    })
    expect((await memberAgents()).toSorted()).toEqual([hiddenAgent.id, openAgent.id].toSorted())
    expect(await findAccountAgent(connection.db, member, hiddenAgent.id)).toMatchObject({
      id: hiddenAgent.id,
    })

    // Revoking the workspace membership removes everything at once; the
    // orphaned project grant alone grants nothing.
    await removeWorkspaceMembership(connection.db, workspaceId, member)
    expect(await memberAgents()).toEqual([])
    expect(await findAccountAgent(connection.db, member, openAgent.id)).toBeNull()
  })

  test('inbox keeps membership, project access and private participation distinct', async () => {
    const alice = await user('inbox-owner')
    const bob = await user('inbox-bob')
    const carol = await user('inbox-carol')
    const workspaceId = await workspace(alice, 'Inbox HQ')
    await addWorkspaceMembership(connection.db, workspaceId, bob, 'member')
    await addWorkspaceMembership(connection.db, workspaceId, carol, 'member')

    const open = await projectWithChannel(workspaceId, alice, 'Inbox Open')
    await post(workspaceId, open.channelId, alice)

    const inboxIds = async (principal: UserPrincipalRef) =>
      (await accountConversationInbox(connection.db, principal)).conversations.map(({ id }) => id)

    // Private participation is its own check: even the workspace owner who is
    // not a participant cannot see a participants-only conversation.
    const priv = await groupChannel(workspaceId, bob, 'Private lane')
    expect(await inboxIds(carol)).toEqual([open.channelId])
    expect(await inboxIds(alice)).toEqual([open.channelId])
    expect(await findAccountConversation(connection.db, alice, priv.id)).toBeNull()

    // A hidden project's channel is invisible to a member not listed on it,
    // while staying visible to the owner — the second distinct check.
    const secret = await projectWithChannel(workspaceId, alice, 'Inbox Secret')
    await post(workspaceId, secret.channelId, alice)
    await setProjectVisibility(connection.db, workspaceId, secret.projectId, alice, 'members')
    expect(await inboxIds(carol)).toEqual([open.channelId])
    expect(await findAccountConversation(connection.db, carol, secret.channelId)).toBeNull()
    await setProjectMember(connection.db, workspaceId, secret.projectId, alice, {
      role: 'viewer',
      userId: carol.userId,
    })
    expect((await inboxIds(carol)).toSorted()).toEqual(
      [open.channelId, secret.channelId].toSorted()
    )

    // Adding carol to the private conversation — not any role change — is
    // what makes it appear; revoked participation removes it again.
    const widened = await setChannelParticipants(
      connection.db,
      workspaceId,
      priv.id,
      bob,
      [bob, carol],
      priv.version
    )
    expect((await inboxIds(carol)).toSorted()).toEqual(
      [open.channelId, secret.channelId, priv.id].toSorted()
    )
    await setChannelParticipants(connection.db, workspaceId, priv.id, bob, [bob], widened.version)
    expect(await findAccountConversation(connection.db, carol, priv.id)).toBeNull()

    // Membership remains the outer gate: leave the workspace and even the
    // open project channel disappears without a trace.
    await removeWorkspaceMembership(connection.db, workspaceId, carol)
    expect(await inboxIds(carol)).toEqual([])
  })

  test('direct agent conversations appear with their agent and unread state follows the caller', async () => {
    const alice = await user('unread-owner')
    const bob = await user('unread-guest')
    const workspaceId = await workspace(alice, 'Unread HQ')
    await addWorkspaceMembership(connection.db, workspaceId, bob, 'member')
    const atlas = await agent(workspaceId, alice, 'Atlas')
    const lane = await createDirectAgentChannel(connection.db, workspaceId, atlas.id, alice)

    // The private direct lane lists for its participant with the agent id,
    // and not for a member who is not a participant.
    const aliceInbox = await accountConversationInbox(connection.db, alice)
    expect(aliceInbox.conversations.map(({ id, agentId }) => ({ id, agentId }))).toEqual([
      { id: lane.id, agentId: atlas.id },
    ])
    expect(await findAccountConversation(connection.db, bob, lane.id)).toBeNull()

    const first = await post(workspaceId, lane.id, alice)
    await post(workspaceId, lane.id, alice, { mentions: [alice] })
    await post(workspaceId, lane.id, alice, { threadRootMessageId: first.id })

    let entry = (await accountConversationInbox(connection.db, alice)).conversations[0]!
    expect(entry.unread).toBe(true)
    expect(entry.topLevelUnreadCount).toBe(2)
    expect(entry.unreadMentions).toBe(1)
    expect(entry.threadUnreadCount).toBe(1)
    expect(entry.latestTopLevelSequence).toBeGreaterThan(0)

    // Reading the channel drains the top-level counts and mentions, but a
    // thread with replies past the frontier still flags the row.
    await markChannelReadState(connection.db, workspaceId, lane.id, alice, 'read')
    entry = (await accountConversationInbox(connection.db, alice)).conversations[0]!
    expect(entry.topLevelUnreadCount).toBe(0)
    expect(entry.unreadMentions).toBe(0)
    expect(entry.threadUnreadCount).toBe(1)
    expect(entry.unread).toBe(true)

    // Reading the thread itself is what clears it.
    await markThreadReadState(connection.db, workspaceId, lane.id, first.id, alice, 'read')
    entry = (await accountConversationInbox(connection.db, alice)).conversations[0]!
    expect(entry.threadUnreadCount).toBe(0)
    expect(entry.unread).toBe(false)

    // A manual unread mark flags the row without inventing unread messages.
    await markChannelReadState(connection.db, workspaceId, lane.id, alice, 'unread')
    entry = (await accountConversationInbox(connection.db, alice)).conversations[0]!
    expect(entry.unread).toBe(true)
    expect(entry.topLevelUnreadCount).toBe(0)
    expect(entry.unreadMentions).toBe(0)
    await markChannelReadState(connection.db, workspaceId, lane.id, alice, 'read')

    // A new thread reply past the frontier flags the row again.
    await post(workspaceId, lane.id, alice, { threadRootMessageId: first.id })
    entry = (await accountConversationInbox(connection.db, alice)).conversations[0]!
    expect(entry.unread).toBe(true)
    expect(entry.threadUnreadCount).toBe(1)
  })

  test('archived conversations leave the inbox but keep resolving by deep link', async () => {
    const alice = await user('archive-owner')
    const workspaceId = await workspace(alice, 'Archive HQ')
    const quiet = await projectWithChannel(workspaceId, alice, 'Quiet')
    const topic = await createProjectChannel(connection.db, workspaceId, quiet.projectId, alice, {
      idempotencyKey: `archive-${crypto.randomUUID()}`,
      title: 'Quiet topic',
    })
    await post(workspaceId, topic.id, alice)
    await archiveChannel(connection.db, workspaceId, topic.id, alice, topic.version)

    // The archived topic drops out; the project's primary channel stays.
    expect(
      (await accountConversationInbox(connection.db, alice)).conversations.map(({ id }) => id)
    ).toEqual([quiet.channelId])
    const archived = await accountConversationInbox(connection.db, alice, {
      includeArchived: true,
    })
    expect(
      archived.conversations.map(({ id, lifecycleState }) => ({ id, lifecycleState }))
    ).toEqual([
      { id: topic.id, lifecycleState: 'archived' },
      { id: quiet.channelId, lifecycleState: 'active' },
    ])
    // The stable identity is what deep links survive on.
    expect(await findAccountConversation(connection.db, alice, topic.id)).toMatchObject({
      id: topic.id,
      lifecycleState: 'archived',
    })

    // Malformed identities are simply not found; they never reach the query.
    expect(await findAccountConversation(connection.db, alice, 'not-a-uuid')).toBeNull()
    expect(await findAccountAgent(connection.db, alice, 'not-a-uuid')).toBeNull()
  })

  test('search filters authorized rows only, for the whole cursor walk', async () => {
    const owner = await user('search-owner')
    const member = await user('search-member')
    const outsider = await user('search-outsider')
    const workspaceId = await workspace(owner, 'Search HQ')
    await addWorkspaceMembership(connection.db, workspaceId, member, 'member')

    // Case-insensitive substring over the Agent's name…
    const studioAlpha = await agent(workspaceId, owner, 'Studio Alpha')
    const studioBeta = await agent(workspaceId, owner, 'Studio Beta')
    await agent(workspaceId, owner, 'Garden Helper')
    // …and over the conversation's title, for the inbox.
    const studioLane = await projectWithChannel(workspaceId, owner, 'Studio Sync')
    await post(workspaceId, studioLane.channelId, owner)
    const gardenLane = await projectWithChannel(workspaceId, owner, 'Garden Club')
    await post(workspaceId, gardenLane.channelId, owner)

    const names = async (principal: UserPrincipalRef, q: string) =>
      (await accountAgentDirectory(connection.db, principal, { q })).agents.map(({ name }) => name)
    const titles = async (principal: UserPrincipalRef, q: string) =>
      (await accountConversationInbox(connection.db, principal, { q })).conversations.map(
        ({ title }) => title
      )

    expect(await names(owner, 'STUDIO')).toEqual(['Studio Alpha', 'Studio Beta'])
    expect(await titles(owner, 'studio')).toEqual(['Studio Sync'])
    expect(await names(owner, 'garden')).toEqual(['Garden Helper'])
    // No match is an ordinary empty page, not an error.
    expect(await names(owner, 'nothing-matches-this')).toEqual([])
    expect(await titles(owner, 'nothing-matches-this')).toEqual([])
    // An outsider matching by name still matches nothing: the filter runs
    // inside the authorization, so denied rows never surface.
    expect(await names(outsider, 'studio')).toEqual([])
    expect(await titles(outsider, 'studio')).toEqual([])

    // A hidden project's Agent cannot be found by searching for its exact name.
    const secret = await projectWithChannel(workspaceId, owner, 'Secret Ops')
    const hidden = await agent(workspaceId, owner, 'Studio Secret', secret.projectId)
    await setProjectVisibility(connection.db, workspaceId, secret.projectId, owner, 'members')
    expect(await names(member, 'studio secret')).toEqual([])
    expect(await names(owner, 'studio secret')).toEqual([hidden.name])
    await setProjectMember(connection.db, workspaceId, secret.projectId, owner, {
      role: 'viewer',
      userId: member.userId,
    })
    expect(await names(member, 'studio secret')).toEqual([hidden.name])

    // The filter is constant across a keyset walk: page one minted under `q`
    // continues under `q` and repeats nothing, and the unfiltered walk still
    // sees every row — search narrows, it does not hide.
    const firstPage = await accountAgentDirectory(connection.db, owner, {
      limit: 1,
      q: 'studio',
    })
    expect(firstPage.agents.map(({ id }) => id)).toEqual([studioAlpha.id])
    expect(firstPage.nextCursor).toBeDefined()
    const secondPage = await accountAgentDirectory(connection.db, owner, {
      after: firstPage.nextCursor!,
      limit: 1,
      q: 'studio',
    })
    expect(secondPage.agents.map(({ id }) => id)).toEqual([studioBeta.id])
    expect(
      (await accountAgentDirectory(connection.db, owner, { q: 'studio' })).agents.map(
        ({ id }) => id
      )
    ).toEqual([studioAlpha.id, studioBeta.id, hidden.id])
    expect(
      (await accountAgentDirectory(connection.db, owner)).agents.filter(({ name }) =>
        name.includes('Studio')
      ).length
    ).toBe(3)

    // Archived rows stay excluded until asked for, even when they match. A
    // primary project channel is never archivable, so the matching archived
    // row is a topic channel under its own project.
    const retired = await projectWithChannel(workspaceId, owner, 'Retired Shell')
    const archivedTopic = await createProjectChannel(
      connection.db,
      workspaceId,
      retired.projectId,
      owner,
      {
        idempotencyKey: `search-${crypto.randomUUID()}`,
        title: 'Studio Retired',
      }
    )
    await post(workspaceId, archivedTopic.id, owner)
    await archiveChannel(connection.db, workspaceId, archivedTopic.id, owner, archivedTopic.version)
    expect(await titles(owner, 'studio')).toEqual(['Studio Sync'])
    expect(
      (
        await accountConversationInbox(connection.db, owner, { includeArchived: true, q: 'studio' })
      ).conversations
        .map(({ id }) => id)
        .toSorted()
    ).toEqual([archivedTopic.id, studioLane.channelId].toSorted())
  })

  test('inbox pagination walks a stable keyset while the account keeps moving', async () => {
    const alice = await user('page-owner')
    const workspaceId = await workspace(alice, 'Paging HQ')
    const lanes: string[] = []
    for (const name of ['Paging One', 'Paging Two', 'Paging Three']) {
      lanes.push((await projectWithChannel(workspaceId, alice, name)).channelId)
    }
    for (const lane of lanes) await post(workspaceId, lane, alice)

    const page = await accountConversationInbox(connection.db, alice, { limit: 100 })
    expect(page.conversations.map(({ id }) => id).toSorted()).toEqual(lanes.toSorted())
    // The total order is (updated_at desc, id desc); every page boundary is a
    // strict step in it.
    for (let index = 1; index < page.conversations.length; index += 1) {
      const previous = page.conversations[index - 1]!
      const current = page.conversations[index]!
      expect(
        previous.updatedAt > current.updatedAt ||
          (previous.updatedAt === current.updatedAt && previous.id > current.id)
      ).toBe(true)
    }

    // A conversation created after page one was read appears on a fresh walk
    // and never rewinds the open cursor: the continuation repeats nothing.
    const firstPage = await accountConversationInbox(connection.db, alice, { limit: 2 })
    expect(firstPage.nextCursor).toBeDefined()
    const fresh = await projectWithChannel(workspaceId, alice, 'Paging Four')
    await post(workspaceId, fresh.channelId, alice)
    const secondPage = await accountConversationInbox(connection.db, alice, {
      after: firstPage.nextCursor,
      limit: 2,
    })
    for (const entry of secondPage.conversations)
      expect(firstPage.conversations.some(({ id }) => id === entry.id)).toBe(false)

    // Renaming bumps a conversation's metadata recency, and the entry keeps
    // its identity; a forged cursor is a caller error, not a crash.
    const [stale] = await connection.db.select().from(channels).where(eq(channels.id, lanes[0]!))
    await updateChannel(
      connection.db,
      workspaceId,
      stale!.id,
      alice,
      { title: 'Paging Renamed' },
      stale!.version
    )
    const renamed = await accountConversationInbox(connection.db, alice, { limit: 100 })
    expect(renamed.conversations.find(({ id }) => id === stale!.id)).toMatchObject({
      id: stale!.id,
      title: 'Paging Renamed',
    })
    expect(
      accountConversationInbox(connection.db, alice, { after: 'forged-cursor' })
    ).rejects.toThrow('Inbox cursor invalid')
  })

  test('inbox cursors carry microsecond precision and traverse tied rows exactly once', async () => {
    const alice = await user('micro-owner')
    const workspaceId = await workspace(alice, 'Microsecond HQ')
    const lanes: string[] = []
    for (const name of ['Micro One', 'Micro Two', 'Micro Three', 'Micro Four', 'Micro Five']) {
      lanes.push((await projectWithChannel(workspaceId, alice, name)).channelId)
    }
    // Three conversations share one exact microsecond instant, and the next
    // sits at the truncated millisecond a Date-normalized cursor used to
    // carry — the skipped-tie bug this walk pins shut.
    const tied = sql`timestamptz '2026-10-08 12:00:00.123456+00'`
    const truncated = sql`timestamptz '2026-10-08 12:00:00.123000+00'`
    await connection.db
      .update(channels)
      .set({ updatedAt: tied })
      .where(inArray(channels.id, [lanes[0]!, lanes[1]!, lanes[2]!]))
    await connection.db
      .update(channels)
      .set({ updatedAt: truncated })
      .where(eq(channels.id, lanes[3]!))
    await connection.db
      .update(channels)
      .set({ updatedAt: sql`timestamptz '2026-10-08 11:00:00.000001+00'` })
      .where(eq(channels.id, lanes[4]!))

    // The cursor itself carries the full microsecond text, not a Date's
    // millisecond rounding.
    const firstPage = await accountConversationInbox(connection.db, alice, { limit: 1 })
    expect(decodeAccountInboxCursor(firstPage.nextCursor!)).toEqual({
      id: firstPage.conversations[0]!.id,
      updatedAt: '2026-10-08T12:00:00.123456Z',
    })

    // limit=1 traverses every row exactly once across the tie.
    const seen: string[] = []
    let after: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const result = await accountConversationInbox(connection.db, alice, { after, limit: 1 })
      expect(result.conversations).toHaveLength(1)
      seen.push(result.conversations[0]!.id)
      after = result.nextCursor
      if (!after) break
    }
    expect(after).toBeUndefined()
    expect(seen).toHaveLength(lanes.length)
    expect(seen.toSorted()).toEqual(lanes.toSorted())

    // The tie group is contiguous and internally id-descending — the id
    // tiebreak is what makes the equal timestamps a total order.
    const tie = seen.filter((id) => [lanes[0], lanes[1], lanes[2]].includes(id))
    expect(tie).toHaveLength(3)
    const tieIndexes = tie.map((id) => seen.indexOf(id))
    expect(tieIndexes[1]).toBe(tieIndexes[0]! + 1)
    expect(tieIndexes[2]).toBe(tieIndexes[0]! + 2)
    expect([...tie].toSorted().toReversed()).toEqual(tie)
  })

  test('inbox thread unread sums unread replies and manual marks like workspace read state', async () => {
    const alice = await user('thread-owner')
    const workspaceId = await workspace(alice, 'Thread HQ')
    const lane = (await projectWithChannel(workspaceId, alice, 'Threads')).channelId
    const rootA = await post(workspaceId, lane, alice)
    const rootB = await post(workspaceId, lane, alice)
    for (let index = 0; index < 3; index += 1)
      await post(workspaceId, lane, alice, { threadRootMessageId: rootA.id })
    for (let index = 0; index < 2; index += 1)
      await post(workspaceId, lane, alice, { threadRootMessageId: rootB.id })

    const inboxEntry = async () =>
      (await accountConversationInbox(connection.db, alice)).conversations.find(
        ({ id }) => id === lane
      )!
    const canonical = async () =>
      (await listReadStateForUser(connection.db, workspaceId, alice)).find(
        ({ channelId }) => channelId === lane
      )!

    // Three unread replies in one thread count as three, not one thread.
    expect((await inboxEntry()).threadUnreadCount).toBe(5)
    expect((await inboxEntry()).threadUnreadCount).toBe((await canonical()).threadUnreadCount)
    expect((await inboxEntry()).unread).toBe(true)

    // Reading thread A leaves exactly thread B's two replies.
    await markThreadReadState(connection.db, workspaceId, lane, rootA.id, alice, 'read')
    expect((await inboxEntry()).threadUnreadCount).toBe(2)
    expect((await inboxEntry()).threadUnreadCount).toBe((await canonical()).threadUnreadCount)

    // A manual mark on thread B adds one on top of its (now zero) unread
    // replies — the frontier itself moved to latest.
    await markThreadReadState(connection.db, workspaceId, lane, rootB.id, alice, 'unread')
    expect((await inboxEntry()).threadUnreadCount).toBe(1)
    expect((await inboxEntry()).threadUnreadCount).toBe((await canonical()).threadUnreadCount)

    // A new reply in the read thread flags through the manual mark on B.
    await post(workspaceId, lane, alice, { threadRootMessageId: rootA.id })
    expect((await inboxEntry()).threadUnreadCount).toBe(2)
    expect((await inboxEntry()).threadUnreadCount).toBe((await canonical()).threadUnreadCount)

    // Reading the threads drains the sum to zero, but the row's own top-level
    // roots are still unread — the flag only clears once the channel reads.
    await markThreadReadState(connection.db, workspaceId, lane, rootA.id, alice, 'read')
    await markThreadReadState(connection.db, workspaceId, lane, rootB.id, alice, 'read')
    expect((await inboxEntry()).threadUnreadCount).toBe(0)
    expect((await inboxEntry()).threadUnreadCount).toBe((await canonical()).threadUnreadCount)
    expect((await inboxEntry()).unread).toBe(true)
    await markChannelReadState(connection.db, workspaceId, lane, alice, 'read')
    expect((await inboxEntry()).unread).toBe(false)
    expect((await inboxEntry()).threadUnreadCount).toBe(0)
  })

  test('cross-workspace isolation: busy foreign workspaces never leak into the account view', async () => {
    const alice = await user('iso-alice')
    const bob = await user('iso-bob')
    const mine = await workspace(alice, 'Isolation Mine')
    const theirs = await workspace(bob, 'Isolation Theirs')

    const foreignLane = await projectWithChannel(theirs, bob, 'Isolation Foreign')
    await post(theirs, foreignLane.channelId, bob)
    await agent(theirs, bob, 'Foreign Agent')
    const mineLane = await projectWithChannel(mine, alice, 'Isolation Mine Lane')
    await post(mine, mineLane.channelId, alice)
    await agent(mine, alice, 'Mine Agent')

    expect(
      (await accountConversationInbox(connection.db, alice)).conversations.map(
        ({ workspaceId: id }) => id
      )
    ).toEqual([mine])
    expect(
      (await accountAgentDirectory(connection.db, alice)).agents.map(({ workspaceId: id }) => id)
    ).toEqual([mine])
    expect(
      (await accountConversationInbox(connection.db, bob)).conversations.map(
        ({ workspaceId: id }) => id
      )
    ).toEqual([theirs])
    expect(
      (await accountAgentDirectory(connection.db, bob)).agents.map(({ workspaceId: id }) => id)
    ).toEqual([theirs])
  })
})
