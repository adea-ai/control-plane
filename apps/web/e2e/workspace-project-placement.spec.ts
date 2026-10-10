import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { inArray, sql } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../../packages/db/src/connection'
import { createDirectAgentTopic } from '../../../packages/db/src/conversations'
import { ensureWorkspaceLead } from '../../../packages/db/src/agents'
import {
  authorizationAuditRecords,
  channelParticipants,
  channelReadStates,
  channels,
  messageMentions,
  messages,
  projectMembers,
  projects,
  tasks,
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceMemberships,
  workspaces,
} from '../../../packages/db/src/schema'
import { addWorkspaceMembership } from '../../../packages/db/src/workspaces'

// ---------------------------------------------------------------------------
// Coverage class: workspace/project placement over the real app server (the
// lane's Vite dev server hosting the TanStack Start worker) and the REAL
// restricted Postgres over real HTTP — the same class as
// account-directory-auth.spec.ts and chat-continuity.spec.ts. No request is
// mocked: `page.route` is never used. Fixtures are created through the
// @adea-ai/db domain functions and every created id is deleted again in
// afterAll, which runs on success AND failure. A missing or unreachable
// database fails the lane; nothing skips.
//
// What this proves that harness suites cannot: channels, tasks, messages,
// and projects stay inside the workspace and project they were placed in —
// listings never cross the boundary, cross-workspace reads and writes fence
// without leaking, members-only projects hide their content from
// non-members, and visibility changes re-place content both ways.
// Session/host identity stays out of scope here: the cloud holds no session
// facts, so placement is proven for the server-known chain (workspace ->
// project -> channel / task / message) with the credential only ever
// proving login.
// ---------------------------------------------------------------------------

// Same fallback contract as playwright.config.ts: CI provides DATABASE_URL;
// local shells fall back to the compose Postgres that `bun run test:e2e`
// starts (scripts/e2e-setup.mjs).
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable'

type Principal = { kind: 'user'; userId: string }

/** Reads go through the browser's own origin, cookie jar and network stack. */
async function fetchFromPage<T>(
  page: Page,
  route: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; body: T }> {
  // Page-bound fetches need a committed origin for relative URLs.
  // Navigate to the target itself: API documents carry no client router,
  // so no redirect can ever destroy an open stream or in-flight read.
  // goto resolves relative paths against the configured baseURL and
  // succeeds on any HTTP status; only a network failure throws.
  if (new URL(page.url()).protocol === 'about:') await page.goto(route, { waitUntil: 'commit' })
  const idempotencyKey = crypto.randomUUID()
  return page.evaluate(
    async ({ target, options, key }) => {
      const response = await fetch(target, {
        method: options.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
          'x-request-id': crypto.randomUUID(),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      return { status: response.status, body: (await response.json()) as T }
    },
    { target: route, options: { method: init?.method, body: init?.body }, key: idempotencyKey }
  )
}

// The documented denial contract for fenced reads and writes: 404 with a
// body that discloses nothing (missing, foreign, and forbidden are
// indistinguishable). A 5xx is never authorization proof.
const DENIED_BODY = { code: 'workspace_unavailable', message: 'Workspace unavailable' } as const

async function expectDenied(
  page: Page,
  route: string,
  canaries: readonly string[],
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  const response = await fetchFromPage<unknown>(page, route, init)
  expect(response.status).toBe(404)
  expect(response.body).toEqual(DENIED_BODY)
  const text = JSON.stringify(response.body)
  for (const canary of canaries) expect(text).not.toContain(canary)
  return response.body
}

async function expectUnknownMatchesDenied(
  page: Page,
  route: string,
  deniedBody: unknown,
  init?: { method?: string; body?: unknown }
): Promise<void> {
  // An unresolvable id must fence byte-identically: no oracle may
  // distinguish "hidden" from "missing".
  const response = await fetchFromPage<unknown>(page, route, init)
  expect(response.status).toBe(404)
  expect(response.body).toEqual(deniedBody)
  expect(response.body).toEqual(DENIED_BODY)
}

const unknownId = () => crypto.randomUUID()

/** Real sign-in: the browser asks the app itself for a session. */
async function signIn(
  connection: DatabaseConnection,
  workspaceIds: string[],
  userIds: string[],
  context: BrowserContext
): Promise<{ principal: Principal; workspaceId: string; page: Page }> {
  const response = await context.request.post('/api/workspaces/bootstrap')
  expect(response.status()).toBe(200)
  const payload = (await response.json()) as {
    principal: { temporary: boolean; userId: string }
    workspaces: { id: string }[]
  }
  expect(payload.principal.temporary).toBe(true)
  const workspaceId = payload.workspaces[0]!.id
  workspaceIds.push(workspaceId)
  userIds.push(payload.principal.userId)
  return {
    principal: { kind: 'user', userId: payload.principal.userId },
    workspaceId,
    page: await context.newPage(),
  }
}

async function directTopic(
  connection: DatabaseConnection,
  workspaceId: string,
  owner: Principal,
  title: string
): Promise<string> {
  const lead = await ensureWorkspaceLead(connection.db, workspaceId, owner)
  const topic = await createDirectAgentTopic(connection.db, workspaceId, lead.id, owner, {
    title,
    idempotencyKey: crypto.randomUUID(),
  })
  return topic.id
}

test.describe('workspace and project placement over real routes', () => {
  // The lane runs with one worker (playwright.config.ts); these tests share
  // one database connection and one tracked fixture set.
  let connection: DatabaseConnection
  const workspaceIds: string[] = []
  const userIds: string[] = []

  test.beforeAll(async () => {
    connection = createDatabase(databaseUrl)
    try {
      await connection.db.execute(sql`select 1`)
    } catch {
      await connection.close().catch(() => undefined)
      throw new Error(
        'The placement browser lane requires the restricted local Postgres: run it through `bun run test:e2e` (which starts the compose Postgres or requires DATABASE_URL). It never skips.'
      )
    }
  })

  test.afterAll(async () => {
    // FK-ordered teardown; runs on success and failure, and a cleanup
    // failure fails the lane rather than leaking rows.
    const db = connection.db
    if (workspaceIds.length) {
      await db
        .delete(authorizationAuditRecords)
        .where(inArray(authorizationAuditRecords.workspaceId, workspaceIds))
      await db.delete(threadReadStates).where(inArray(threadReadStates.workspaceId, workspaceIds))
      await db.delete(channelReadStates).where(inArray(channelReadStates.workspaceId, workspaceIds))
      await db.delete(messageMentions).where(inArray(messageMentions.workspaceId, workspaceIds))
      await db.delete(messages).where(inArray(messages.workspaceId, workspaceIds))
      await db
        .delete(channelParticipants)
        .where(inArray(channelParticipants.workspaceId, workspaceIds))
      await db.delete(channels).where(inArray(channels.workspaceId, workspaceIds))
      await db.delete(tasks).where(inArray(tasks.workspaceId, workspaceIds))
      await db.delete(projectMembers).where(inArray(projectMembers.workspaceId, workspaceIds))
      await db.delete(projects).where(inArray(projects.workspaceId, workspaceIds))
      await db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, workspaceIds))
    }
    if (workspaceIds.length) {
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    }
    if (userIds.length) {
      await db.delete(temporaryUserSessions).where(inArray(temporaryUserSessions.userId, userIds))
      await db.delete(users).where(inArray(users.id, userIds))
    }
    await connection.close().catch(() => undefined)
  })

  test('channels list stays inside their workspace', async ({ browser }) => {
    const first = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const channelId = await directTopic(connection, first.workspaceId, first.principal, 'Placed DM')
    const listed = await fetchFromPage<{ id: string }[]>(
      first.page,
      `/api/v1/workspaces/${first.workspaceId}/channels`
    )
    expect(listed.status).toBe(200)
    expect(listed.body.map((channel) => channel.id)).toContain(channelId)

    const second = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const foreign = await fetchFromPage<{ id: string }[]>(
      second.page,
      `/api/v1/workspaces/${second.workspaceId}/channels`
    )
    expect(foreign.status).toBe(200)
    expect(foreign.body.map((channel) => channel.id)).not.toContain(channelId)
    await first.page.context().close()
    await second.page.context().close()
  })

  test('cross-workspace channel reads fence without leaking', async ({ browser }) => {
    const home = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const channelId = await directTopic(connection, home.workspaceId, home.principal, 'Home DM')
    const away = await signIn(connection, workspaceIds, userIds, await browser.newContext())

    // Through the stranger's own workspace the channel does not exist;
    // through the home workspace the stranger is not a member. Both fence
    // with the documented denial, byte-identical to an unknown id.
    for (const workspaceId of [away.workspaceId, home.workspaceId]) {
      const denied = await expectDenied(
        away.page,
        `/api/v1/workspaces/${workspaceId}/channels/${channelId}/messages`,
        [channelId]
      )
      await expectUnknownMatchesDenied(
        away.page,
        `/api/v1/workspaces/${workspaceId}/channels/${unknownId()}/messages`,
        denied
      )
    }
    await home.page.context().close()
    await away.page.context().close()
  })

  test('tasks stay inside their workspace', async ({ browser }) => {
    const owner = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const created = await fetchFromPage<{ task: { id: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks`,
      { method: 'POST', body: { title: 'Placed task', objective: 'Do placed work' } }
    )
    expect(created.status).toBe(201)

    const listed = await fetchFromPage<{ id: string }[]>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks`
    )
    expect(listed.status).toBe(200)
    expect(listed.body.map((task) => task.id)).toContain(created.body.task.id)

    const stranger = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const foreign = await fetchFromPage<{ id: string }[]>(
      stranger.page,
      `/api/v1/workspaces/${stranger.workspaceId}/tasks`
    )
    expect(foreign.body.map((task) => task.id)).not.toContain(created.body.task.id)
    const denied = await expectDenied(
      stranger.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks/${created.body.task.id}`,
      [created.body.task.id, 'Placed task']
    )
    await expectUnknownMatchesDenied(
      stranger.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks/${unknownId()}`,
      denied
    )
    await owner.page.context().close()
    await stranger.page.context().close()
  })

  test('members-only projects hide tasks and messages from non-members', async ({ browser }) => {
    const owner = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const created = await fetchFromPage<{ project: { id: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/projects`,
      { method: 'POST', body: { name: 'Secret plans', iconKey: 'lock' } }
    )
    expect(created.status).toBe(201)
    const projectId = created.body.project.id
    const visibility = await fetchFromPage<{ project?: { visibility?: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/projects/${projectId}/visibility`,
      { method: 'PATCH', body: { visibility: 'members' } }
    )
    expect(visibility.status).toBe(200)

    const task = await fetchFromPage<{ task: { id: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks`,
      {
        method: 'POST',
        body: { title: 'Secret task', objective: 'Hidden work', projectId },
      }
    )
    expect(task.status).toBe(201)
    // The channel itself lives in the hidden project, so its messages are
    // fenced with it — no task-link ambiguity in this fixture.
    const channel = await fetchFromPage<{ channel: { id: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/channels`,
      { method: 'POST', body: { kind: 'project', projectId, title: 'Secret channel' } }
    )
    expect(channel.status).toBe(201)
    const channelId = channel.body.channel.id
    const posted = await fetchFromPage<{ message: { id: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/channels/${channelId}/messages`,
      { method: 'POST', body: { bodyText: 'secret line', taskId: task.body.task.id } }
    )
    expect(posted.status).toBe(201)
    const ownerRead = await fetchFromPage<{ messages?: { id?: string }[] }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/channels/${channelId}/messages`
    )
    expect(
      (ownerRead.body.messages ?? []).some((message) => message.id === posted.body.message.id)
    ).toBe(true)

    // A workspace member who is not on the project reads the workspace but
    // never the hidden project's task, channel, or messages.
    const member = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    await addWorkspaceMembership(connection.db, owner.workspaceId, member.principal, 'member')
    const deniedTask = await expectDenied(
      member.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks/${task.body.task.id}`,
      [task.body.task.id, 'Secret task']
    )
    await expectUnknownMatchesDenied(
      member.page,
      `/api/v1/workspaces/${owner.workspaceId}/tasks/${unknownId()}`,
      deniedTask
    )
    const deniedChannel = await expectDenied(
      member.page,
      `/api/v1/workspaces/${owner.workspaceId}/channels/${channelId}/messages`,
      [channelId, 'secret line']
    )
    await expectUnknownMatchesDenied(
      member.page,
      `/api/v1/workspaces/${owner.workspaceId}/channels/${unknownId()}/messages`,
      deniedChannel
    )
    await owner.page.context().close()
    await member.page.context().close()
  })

  test('visibility changes re-place project content both ways', async ({ browser }) => {
    const owner = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const created = await fetchFromPage<{ project: { id: string } }>(
      owner.page,
      `/api/v1/workspaces/${owner.workspaceId}/projects`,
      { method: 'POST', body: { name: 'Flip plans', iconKey: 'lock' } }
    )
    expect(created.status).toBe(201)
    const projectId = created.body.project.id
    const projectPath = `/api/v1/workspaces/${owner.workspaceId}/projects/${projectId}`

    const member = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    await addWorkspaceMembership(connection.db, owner.workspaceId, member.principal, 'member')

    // Workspace-visible projects list for every member.
    const listed = await fetchFromPage<{ id: string }[]>(
      member.page,
      `/api/v1/workspaces/${owner.workspaceId}/projects`
    )
    expect(listed.body.map((project) => project.id)).toContain(projectId)

    // Restricting to members hides it; reopening reveals it again. Only a
    // manager can change visibility: the member's own attempt fences.
    await expectDenied(member.page, projectPath + '/visibility', [projectId], {
      method: 'PATCH',
      body: { visibility: 'members' },
    })
    const restricted = await fetchFromPage(owner.page, projectPath + '/visibility', {
      method: 'PATCH',
      body: { visibility: 'members' },
    })
    expect(restricted.status).toBe(200)
    const deniedProject = await expectDenied(member.page, projectPath, [projectId])
    await expectUnknownMatchesDenied(
      member.page,
      `/api/v1/workspaces/${owner.workspaceId}/projects/${unknownId()}`,
      deniedProject
    )
    // The member cannot change visibility themselves: only a manager can.
    await expectDenied(member.page, projectPath + '/visibility', [projectId], {
      method: 'PATCH',
      body: { visibility: 'workspace' },
    })
    const ownerReopened = await fetchFromPage(owner.page, projectPath + '/visibility', {
      method: 'PATCH',
      body: { visibility: 'workspace' },
    })
    expect(ownerReopened.status).toBe(200)
    const visible = await fetchFromPage<{ project?: { id: string } }>(member.page, projectPath)
    expect(visible.status).toBe(200)
    await owner.page.context().close()
    await member.page.context().close()
  })

  test('cross-workspace writes never land', async ({ browser }) => {
    const home = await signIn(connection, workspaceIds, userIds, await browser.newContext())
    const channelId = await directTopic(connection, home.workspaceId, home.principal, 'Guarded DM')
    const away = await signIn(connection, workspaceIds, userIds, await browser.newContext())

    // The stranger posts into the home channel: the write fences with the
    // documented denial, disclosing nothing — while the owner's own write
    // admits, proving the fence is authorization rather than breakage.
    await expectDenied(
      away.page,
      `/api/v1/workspaces/${home.workspaceId}/channels/${channelId}/messages`,
      [channelId, 'forged line'],
      { method: 'POST', body: { bodyText: 'forged line' } }
    )
    const admitted = await fetchFromPage<{ message: { id: string } }>(
      home.page,
      `/api/v1/workspaces/${home.workspaceId}/channels/${channelId}/messages`,
      { method: 'POST', body: { bodyText: 'home line' } }
    )
    expect(admitted.status).toBe(201)
    const read = await fetchFromPage<{ messages: { bodyText?: string }[] }>(
      home.page,
      `/api/v1/workspaces/${home.workspaceId}/channels/${channelId}/messages`
    )
    expect(read.status).toBe(200)
    expect(read.body.messages.map((message) => message.bodyText)).toContain('home line')
    expect(read.body.messages.map((message) => message.bodyText)).not.toContain('forged line')
    await home.page.context().close()
    await away.page.context().close()
  })
})
