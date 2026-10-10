import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { accountWorkspaceSummaries } from '../../src/account-summary'
import { createDatabase, type DatabaseConnection } from '../../src/connection'
import {
  createGroupChannel,
  createMessage,
  deleteMessage,
  setChannelParticipants,
} from '../../src/conversations'
import { createTemporaryUserSession } from '../../src/identity'
import { setProjectMember, setProjectVisibility } from '../../src/project-sharing'
import { createProject } from '../../src/projects'
import { markChannelReadState } from '../../src/read-state'
import * as schema from '../../src/schema'
import {
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
  archiveWorkspace,
  createWorkspaceWithOwner,
} from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

describe.skipIf(!connectionUrl)('account workspace summaries', () => {
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
      credentialDigest: `summary-${label}-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    userIds.push(session.principal.userId)
    return session.principal
  }

  async function workspace(owner: UserPrincipalRef, name: string) {
    const { workspace: created } = await createWorkspaceWithOwner(connection.db, {
      idempotencyKey: `summary-${crypto.randomUUID()}`,
      name,
      owner,
    })
    workspaceIds.push(created.id)
    return created.id
  }

  async function projectChannel(workspaceId: string, owner: UserPrincipalRef, name: string) {
    return (await projectWithChannel(workspaceId, owner, name)).channelId
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
      bodyText: 'summary fixture',
      idempotencyKey: crypto.randomUUID(),
      sender,
      ...extra,
    })
  }

  async function latest(channelId: string) {
    const [row] = await connection.db
      .select({ latest: channels.latestMessageSequence })
      .from(channels)
      .where(eq(channels.id, channelId))
    return row!.latest
  }

  test('maintains the channel frontier on insert, thread reply, and delete', async () => {
    const owner = await user('frontier')
    const workspaceId = await workspace(owner, 'Frontier HQ')
    const channelId = await projectChannel(workspaceId, owner, 'Frontier')
    expect(await latest(channelId)).toBe(0)

    const first = await post(workspaceId, channelId, owner)
    expect(await latest(channelId)).toBe(first.sequence)
    const second = await post(workspaceId, channelId, owner)
    expect(await latest(channelId)).toBe(second.sequence)

    // A thread reply is not a top-level message: the frontier does not move.
    await post(workspaceId, channelId, owner, { threadRootMessageId: first.id })
    expect(await latest(channelId)).toBe(second.sequence)

    // Deleting an older message leaves the frontier; deleting the newest
    // moves it back to the newest remaining live top-level message.
    const third = await post(workspaceId, channelId, owner)
    await deleteMessage(connection.db, workspaceId, second.id, owner, second.version)
    expect(await latest(channelId)).toBe(third.sequence)
    await deleteMessage(connection.db, workspaceId, third.id, owner, third.version)
    expect(await latest(channelId)).toBe(first.sequence)
    await deleteMessage(connection.db, workspaceId, first.id, owner, first.version)
    expect(await latest(channelId)).toBe(0)

    // An idempotent retry does not change the frontier.
    const retried = await post(workspaceId, channelId, owner, { idempotencyKey: 'retry' })
    await post(workspaceId, channelId, owner, { idempotencyKey: 'retry' })
    expect(await latest(channelId)).toBe(retried.sequence)
  })

  test('counts unread channels and mentions per member workspace in one query', async () => {
    const alice = await user('alice')
    const bob = await user('bob')
    const one = await workspace(alice, 'One')
    const two = await workspace(alice, 'Two')
    const three = await workspace(alice, 'Three')
    const foreign = await workspace(bob, 'Foreign')
    await addWorkspaceMembership(connection.db, one, bob, 'member')
    await addWorkspaceMembership(connection.db, two, bob, 'member')

    // One: two unread workspace-visible channels, one with a mention, plus a
    // private channel alice cannot see (with a mention she must never count).
    const general = await projectChannel(one, alice, 'General')
    const design = await projectChannel(one, alice, 'Design')
    await post(one, general, bob, { mentions: [alice] })
    await post(one, general, bob)
    await post(one, design, bob)
    const hidden = await createGroupChannel(connection.db, one, bob, {
      idempotencyKey: 'hidden',
      title: 'Bob only',
    })
    await post(one, hidden.id, bob)
    // Thread replies count in workspace read state, not in the summary.
    const root = await post(two, await projectChannel(two, alice, 'Replies'), alice)
    await markChannelReadState(connection.db, two, root.channelId, alice, 'read')
    await post(two, root.channelId, bob, { mentions: [alice], threadRootMessageId: root.id })

    // Two: a private channel alice participates in, with a mention.
    const shared = await createGroupChannel(connection.db, two, bob, {
      idempotencyKey: 'shared',
      title: 'Shared',
    })
    const widened = await setChannelParticipants(
      connection.db,
      two,
      shared.id,
      bob,
      [bob, alice],
      shared.version
    )
    await post(two, shared.id, bob, { mentions: [alice] })
    await post(two, shared.id, bob, { mentions: [alice] })

    // Three: no messages at all. Foreign: busy, but alice is not a member.
    await projectChannel(three, alice, 'Quiet')
    await post(foreign, await projectChannel(foreign, bob, 'Elsewhere'), bob)

    let queries = 0
    const counting = postgres(connectionUrl!, {
      debug: () => {
        queries += 1
      },
      max: 1,
      prepare: false,
    })
    try {
      // Connection setup (type discovery) is not part of the summary's cost.
      await counting`select 1`
      queries = 0
      const summaries = await accountWorkspaceSummaries(drizzle(counting, { schema }), alice)
      expect(queries).toBe(1)
      expect(summaries).toEqual([
        { mentions: 1, unreadChannels: 2, workspaceId: one },
        { mentions: 2, unreadChannels: 1, workspaceId: two },
        { mentions: 0, unreadChannels: 0, workspaceId: three },
      ])
    } finally {
      await counting.end({ timeout: 5 })
    }

    // Membership isolation: bob sees his own workspaces, alice never sees Foreign.
    const bobView = await accountWorkspaceSummaries(connection.db, bob)
    expect(bobView.map(({ workspaceId }) => workspaceId).toSorted()).toEqual(
      [one, two, foreign].toSorted()
    )
    expect(bobView.find(({ workspaceId }) => workspaceId === one)).toMatchObject({
      // bob sent everything in One, but he has no read marks yet.
      mentions: 0,
      unreadChannels: 3,
    })

    // Reading resets counts; a manual unread mark counts without new messages.
    await markChannelReadState(connection.db, one, general, alice, 'read')
    await markChannelReadState(connection.db, one, design, alice, 'read')
    await markChannelReadState(connection.db, two, shared.id, alice, 'unread')
    let after = await accountWorkspaceSummaries(connection.db, alice)
    expect(after.find(({ workspaceId }) => workspaceId === one)).toMatchObject({
      mentions: 0,
      unreadChannels: 0,
    })
    expect(after.find(({ workspaceId }) => workspaceId === two)).toMatchObject({
      mentions: 0,
      unreadChannels: 1,
    })
    await markChannelReadState(connection.db, two, shared.id, alice, 'read')
    after = await accountWorkspaceSummaries(connection.db, alice)
    expect(after.find(({ workspaceId }) => workspaceId === two)).toMatchObject({
      mentions: 0,
      unreadChannels: 0,
    })

    // Removing alice from a private channel removes it from her count.
    await post(two, shared.id, bob, { mentions: [alice] })
    expect(
      (await accountWorkspaceSummaries(connection.db, alice)).find(
        ({ workspaceId }) => workspaceId === two
      )
    ).toMatchObject({ mentions: 1, unreadChannels: 1 })
    await setChannelParticipants(connection.db, two, shared.id, bob, [bob], widened.version)
    expect(
      (await accountWorkspaceSummaries(connection.db, alice)).find(
        ({ workspaceId }) => workspaceId === two
      )
    ).toMatchObject({ mentions: 0, unreadChannels: 0 })

    // An archived workspace drops out of the summary.
    await archiveWorkspace(connection.db, three, alice)
    expect(
      (await accountWorkspaceSummaries(connection.db, alice)).map(({ workspaceId }) => workspaceId)
    ).toEqual([one, two])
  })

  test('excludes members-only projects the user cannot see', async () => {
    const owner = await user('hidden-owner')
    const outsider = await user('hidden-outsider')
    const listed = await user('hidden-listed')
    const admin = await user('hidden-admin')
    const workspaceId = await workspace(owner, 'Hidden HQ')
    await addWorkspaceMembership(connection.db, workspaceId, outsider, 'member')
    await addWorkspaceMembership(connection.db, workspaceId, listed, 'member')
    await addWorkspaceMembership(connection.db, workspaceId, admin, 'admin')

    // An unread workspace-visible project channel everyone counts, and a
    // secret project whose unread mentions predate the visibility change.
    const open = await projectChannel(workspaceId, owner, 'Open')
    await post(workspaceId, open, owner)
    const secret = await projectWithChannel(workspaceId, owner, 'Secret')
    await post(workspaceId, secret.channelId, owner, { mentions: [outsider, listed, admin] })
    await setProjectVisibility(connection.db, workspaceId, secret.projectId, owner, 'members')
    await setProjectMember(connection.db, workspaceId, secret.projectId, owner, {
      role: 'viewer',
      userId: listed.userId,
    })

    const summary = async (principal: UserPrincipalRef) =>
      (await accountWorkspaceSummaries(connection.db, principal)).find(
        (row) => row.workspaceId === workspaceId
      )
    // Not listed on the project: neither its channel nor its mention leaks.
    expect(await summary(outsider)).toEqual({ mentions: 0, unreadChannels: 1, workspaceId })
    // Listed project members and workspace admins see it.
    expect(await summary(listed)).toEqual({ mentions: 1, unreadChannels: 2, workspaceId })
    expect(await summary(admin)).toEqual({ mentions: 1, unreadChannels: 2, workspaceId })

    // Switching the project back to workspace visibility restores it.
    await setProjectVisibility(connection.db, workspaceId, secret.projectId, owner, 'workspace')
    expect(await summary(outsider)).toEqual({ mentions: 1, unreadChannels: 2, workspaceId })
  })
})
