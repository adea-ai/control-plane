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
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceMemberships,
  workspaces,
} from '../../../packages/db/src/schema'

// ---------------------------------------------------------------------------
// Coverage class: chat continuity over the real app server (the lane's Vite
// dev server hosting the TanStack Start worker) and the REAL restricted
// Postgres over real HTTP — the same class as
// account-directory-auth.spec.ts. No request is mocked: `page.route` is
// never used. Fixtures are created through the @adea-ai/db domain functions
// and every created id is deleted again in afterAll, which runs on success
// AND failure. A missing or unreachable database fails the lane; nothing
// skips.
//
// What this proves that harness suites cannot: posted messages read back
// contiguous across pages, the transcript survives reload, read state
// converges after activity and explicit reads, replies stay threaded,
// channels never leak each other's messages, offline reads fail in-browser
// while reconnect replays fresh, and the workspace event stream resumes
// from a cursor without gaps or replays.
// ---------------------------------------------------------------------------

// Same fallback contract as playwright.config.ts: CI provides DATABASE_URL;
// local shells fall back to the compose Postgres that `bun run test:e2e`
// starts (scripts/e2e-setup.mjs).
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable'

type Principal = { kind: 'user'; userId: string }
type PostedMessage = { id: string; sequence: number; bodyText?: string }
type MessagePage = {
  messages: { id: string; sequence: number; bodyText?: string; replyToMessageId?: string }[]
  nextAfterSequence?: number
}

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

/** Real sign-in: the browser asks the app itself for a session. */
async function signIn(
  connection: DatabaseConnection,
  workspaceIds: string[],
  userIds: string[],
  context: BrowserContext
): Promise<Principal> {
  const response = await context.request.post('/api/workspaces/bootstrap')
  expect(response.status()).toBe(200)
  const payload = (await response.json()) as {
    principal: { temporary: boolean; userId: string }
    workspaces: { id: string }[]
  }
  expect(payload.principal.temporary).toBe(true)
  for (const workspace of payload.workspaces) workspaceIds.push(workspace.id)
  userIds.push(payload.principal.userId)
  return { kind: 'user', userId: payload.principal.userId }
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

async function postMessage(
  page: Page,
  workspaceId: string,
  channelId: string,
  body: Record<string, unknown>
): Promise<PostedMessage> {
  const response = await fetchFromPage<{ message: PostedMessage }>(
    page,
    `/api/v1/workspaces/${workspaceId}/channels/${channelId}/messages`,
    { method: 'POST', body }
  )
  expect(response.status).toBe(201)
  return response.body.message
}

async function readMessages(
  page: Page,
  workspaceId: string,
  channelId: string,
  query = ''
): Promise<{ status: number; body: MessagePage }> {
  return fetchFromPage<MessagePage>(
    page,
    `/api/v1/workspaces/${workspaceId}/channels/${channelId}/messages${query}`
  )
}

test.describe('chat continuity over real routes', () => {
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
        'The chat continuity browser lane requires the restricted local Postgres: run it through `bun run test:e2e` (which starts the compose Postgres or requires DATABASE_URL). It never skips.'
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

  test('posted messages read back contiguous across pages', async ({ page, context }) => {
    const owner = await signIn(connection, workspaceIds, userIds, context)
    const workspaceId = workspaceIds[workspaceIds.length - 1]!
    const channelId = await directTopic(connection, workspaceId, owner, 'Continuity DM')
    const bodies = ['first', 'second', 'third', 'fourth', 'fifth']
    for (const text of bodies) await postMessage(page, workspaceId, channelId, { bodyText: text })

    // Page through two at a time: every body arrives once, in order, with
    // contiguous sequences and no gaps or replays.
    const seen: { id: string; sequence: number; bodyText?: string }[] = []
    let after: number | undefined
    for (let round = 0; round < 4; round += 1) {
      const query = after === undefined ? '?limit=2' : `?limit=2&afterSequence=${after}`
      const response = await readMessages(page, workspaceId, channelId, query)
      expect(response.status).toBe(200)
      seen.push(...response.body.messages)
      if (response.body.nextAfterSequence === undefined) break
      after = response.body.nextAfterSequence
    }
    expect(seen.map((message) => message.bodyText)).toEqual(bodies)
    const sequences = seen.map((message) => message.sequence)
    expect(new Set(sequences).size).toBe(sequences.length)
    for (let index = 1; index < sequences.length; index += 1)
      expect(sequences[index]).toBeGreaterThan(sequences[index - 1]!)
  })

  test('the transcript survives reload', async ({ page, context }) => {
    const owner = await signIn(connection, workspaceIds, userIds, context)
    const workspaceId = workspaceIds[workspaceIds.length - 1]!
    const channelId = await directTopic(connection, workspaceId, owner, 'Reload DM')
    await postMessage(page, workspaceId, channelId, { bodyText: 'durable line' })

    const first = await readMessages(page, workspaceId, channelId)
    expect(first.body.messages.map((message) => message.bodyText)).toContain('durable line')

    await page.reload()
    const second = await readMessages(page, workspaceId, channelId)
    expect(second.body.messages.map((message) => message.bodyText)).toContain('durable line')
    expect(second.body.messages.length).toBe(first.body.messages.length)
  })

  test('read state converges after activity and an explicit read', async ({ page, context }) => {
    const owner = await signIn(connection, workspaceIds, userIds, context)
    const workspaceId = workspaceIds[workspaceIds.length - 1]!
    const channelId = await directTopic(connection, workspaceId, owner, 'Read-state DM')
    const posted = await postMessage(page, workspaceId, channelId, { bodyText: 'unread line' })

    const marked = await fetchFromPage<{
      readState: { channelId: string; lastReadSequence: number }[]
    }>(page, `/api/v1/workspaces/${workspaceId}/read-state/channels/${channelId}`, {
      method: 'POST',
      body: { action: 'read', lastReadSequence: posted.sequence },
    })
    expect(marked.status).toBe(200)
    expect(
      marked.body.readState.find((entry) => entry.channelId === channelId)?.lastReadSequence
    ).toBe(posted.sequence)
  })

  test('replies stay threaded to their root across reads', async ({ page, context }) => {
    const owner = await signIn(connection, workspaceIds, userIds, context)
    const workspaceId = workspaceIds[workspaceIds.length - 1]!
    const channelId = await directTopic(connection, workspaceId, owner, 'Thread DM')
    const root = await postMessage(page, workspaceId, channelId, { bodyText: 'root line' })
    await postMessage(page, workspaceId, channelId, {
      bodyText: 'reply line',
      replyToMessageId: root.id,
      threadRootMessageId: root.id,
    })

    const thread = await readMessages(
      page,
      workspaceId,
      channelId,
      `?threadRootMessageId=${root.id}`
    )
    expect(thread.status).toBe(200)
    // The thread filter returns replies, not the root itself (the root
    // carries no threadRootMessageId): linkage is proven by replyTo.
    expect(thread.body.messages.map((message) => message.bodyText)).toEqual(['reply line'])
    expect(thread.body.messages[0]?.replyToMessageId).toBe(root.id)
  })

  test('a channel never shows another channel’s messages', async ({ page, context }) => {
    const owner = await signIn(connection, workspaceIds, userIds, context)
    const workspaceId = workspaceIds[workspaceIds.length - 1]!
    const first = await directTopic(connection, workspaceId, owner, 'Isolated A')
    const second = await directTopic(connection, workspaceId, owner, 'Isolated B')
    await postMessage(page, workspaceId, first, { bodyText: 'only in A' })

    const other = await readMessages(page, workspaceId, second)
    expect(other.status).toBe(200)
    expect(other.body.messages.map((message) => message.bodyText)).not.toContain('only in A')
  })

  test('offline reads fail in-browser while reconnect replays fresh', async ({ page, context }) => {
    const owner = await signIn(connection, workspaceIds, userIds, context)
    const workspaceId = workspaceIds[workspaceIds.length - 1]!
    const channelId = await directTopic(connection, workspaceId, owner, 'Offline DM')
    const path = `/api/v1/workspaces/${workspaceId}/channels/${channelId}/messages`
    // Commit a real same-origin page first: without it, fetch fails even
    // online and the offline proof below would be vacuous.
    await page.goto(path, { waitUntil: 'commit' })

    // The exact read succeeds online, proving the page, credential, and
    // route before anything is disconnected.
    const online = await readMessages(page, workspaceId, channelId)
    expect(online.status).toBe(200)

    try {
      await context.setOffline(true)
      // Offline the same read rejects at the network (a thrown TypeError),
      // never an HTTP error status — the browser cannot reach the route.
      const dropped = await page.evaluate(async (target) => {
        try {
          await fetch(target)
          return 'responded'
        } catch (error) {
          return error instanceof TypeError ? 'network-failure' : `unexpected:${String(error)}`
        }
      }, path)
      expect(dropped).toBe('network-failure')
    } finally {
      // Neighbor tests share the browser profile pool: never leak offline.
      await context.setOffline(false)
    }

    // Reconnect replays fresh: the same read succeeds again with the
    // identical body, and activity posted after the drop reads back with
    // no stale cached copy surviving it.
    const back = await readMessages(page, workspaceId, channelId)
    expect(back.status).toBe(200)
    expect(back.body).toEqual(online.body)
    await postMessage(page, workspaceId, channelId, { bodyText: 'after the drop' })
    const after = await readMessages(page, workspaceId, channelId)
    expect(after.status).toBe(200)
    expect(after.body.messages.map((message) => message.bodyText)).toContain('after the drop')
  })

  test('the workspace event stream resumes from a cursor without gaps', async ({
    page,
    context,
  }) => {
    const owner = await signIn(connection, workspaceIds, userIds, context)
    const workspaceId = workspaceIds[workspaceIds.length - 1]!
    const channelId = await directTopic(connection, workspaceId, owner, 'Stream DM')
    const streamPath = `/api/v1/workspaces/${workspaceId}/events`
    // A leaked interval or a throwing poll callback surfaces here as a
    // page error; the stream phases below must leave none behind.
    const streamErrors: string[] = []
    const onStreamError = (error: Error) => streamErrors.push(error.message)
    page.on('pageerror', onStreamError)
    // Commit a redirect-free origin before opening the stream: API
    // documents never boot the client router.
    await page.goto(`/api/v1/workspaces/${workspaceId}/channels`, { waitUntil: 'commit' })

    // One stream at a time: the route caps concurrent workspace streams.
    // Each phase runs subscribe → open-barrier → post → collect → close
    // inside ONE evaluate, so ordering is structural, never racy, and the
    // stream closes on every path (failures included) via finally.
    // Deliveries arrive as the named workspace.event type; audience,
    // resync, and withheld siblings never match the collector below.
    const runStreamPhase = (target: string, texts: string[], want: number) =>
      page.evaluate(
        async ({ stream, bodies, post, keys, want: wanted }) => {
          type Delivery = { id: string; sequence: number; messageId: string }
          const seen: Delivery[] = []
          const posted: { id: string }[] = []
          const source = new EventSource(stream)
          try {
            source.addEventListener('workspace.event', (event: MessageEvent) => {
              try {
                const data = JSON.parse(event.data) as {
                  workspaceSequence?: number
                  eventType?: string
                  payload?: { messageId?: string }
                }
                if (
                  data.eventType === 'message.created' &&
                  typeof data.workspaceSequence === 'number' &&
                  typeof data.payload?.messageId === 'string'
                )
                  seen.push({
                    id: event.lastEventId,
                    sequence: data.workspaceSequence,
                    messageId: data.payload.messageId,
                  })
              } catch {
                // Control frames carry no delivery payload.
              }
            })
            // Readiness barrier: the subscription is established only once
            // the stream opens. Posts before this point race registration
            // and may never be delivered to this stream.
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('stream open timeout')), 10_000)
              source.addEventListener(
                'open',
                () => {
                  clearTimeout(timer)
                  resolve()
                },
                { once: true }
              )
              source.addEventListener(
                'error',
                () => {
                  clearTimeout(timer)
                  reject(new Error('stream open failed'))
                },
                { once: true }
              )
            })
            for (let index = 0; index < bodies.length; index += 1) {
              const response = await fetch(post, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'idempotency-key': keys[index]!,
                  'x-request-id': crypto.randomUUID(),
                },
                body: JSON.stringify({ bodyText: bodies[index] }),
              })
              if (response.status !== 201) throw new Error(`phase post failed: ${response.status}`)
              const payload = (await response.json()) as { message: { id: string } }
              posted.push({ id: payload.message.id })
            }
            await new Promise<void>((resolve, reject) => {
              const done = (error?: Error) => {
                clearTimeout(timer)
                clearInterval(interval)
                if (error) reject(error)
                else resolve()
              }
              const timer = setTimeout(
                () =>
                  done(
                    new Error(
                      `stream collect timeout: wanted ${wanted} deliveries, observed ${seen.length}`
                    )
                  ),
                15_000
              )
              const interval = setInterval(() => {
                if (seen.length >= wanted) done()
              }, 200)
            })
          } finally {
            source.close()
          }
          return { posted, seen }
        },
        {
          stream: target,
          bodies: texts,
          post: `/api/v1/workspaces/${workspaceId}/channels/${channelId}/messages`,
          keys: texts.map(() => crypto.randomUUID()),
          want,
        }
      )
    const live = await runStreamPhase(streamPath, ['stream one', 'stream two'], 2)
    expect(live.posted.map((message) => message.id)).toHaveLength(2)
    expect(live.seen.map((delivery) => delivery.messageId)).toEqual(
      live.posted.map((message) => message.id)
    )
    expect(live.seen[1]!.sequence).toBe(live.seen[0]!.sequence + 1)

    // Resume from the last observed cursor: only the newer delivery
    // arrives, contiguous with what came before — no replay, no gap.
    const resumed = await runStreamPhase(
      `${streamPath}?cursor=${encodeURIComponent(live.seen[1]!.id)}`,
      ['stream three'],
      1
    )
    expect(resumed.posted.map((message) => message.id)).toHaveLength(1)
    expect(resumed.seen.map((delivery) => delivery.messageId)).toEqual(
      resumed.posted.map((message) => message.id)
    )
    expect(resumed.seen[0]!.sequence).toBe(live.seen[1]!.sequence + 1)
    page.off('pageerror', onStreamError)
    expect(streamErrors).toEqual([])
  })
})
