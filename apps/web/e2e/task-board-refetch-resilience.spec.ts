import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import { createGroupChannel, createMessage } from '../../../packages/db/src/conversations'
import { createDatabase, type DatabaseConnection } from '../../../packages/db/src/connection'
import { createTask } from '../../../packages/db/src/tasks'
import {
  agents,
  authorizationAuditRecords,
  channelParticipants,
  channelReadStates,
  channels,
  messageMentions,
  messages,
  projects,
  tasks,
  temporaryUserSessions,
  threadReadStates,
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from '../../../packages/db/src/schema'

// ---------------------------------------------------------------------------
// Coverage class: deterministic fault injection into the real workspace
// surface. Unlike account-directory-ui.spec.ts (which never intercepts a
// request), this lane proves that a transient failure of a workspace query
// refetch cannot unmount an already-rendered surface. `page.route` is used
// deliberately, and only to fail the list refetch after data is on screen.
// ---------------------------------------------------------------------------

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable'

type Principal = { kind: 'user'; userId: string }
type SignInSession = Readonly<{ homeWorkspaceId: string; principal: Principal }>

async function openSignedInApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({
    timeout: 20_000,
  })
}

test.describe('the task board survives a transient workspace refetch failure', () => {
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
        'The task board resilience lane requires the restricted local Postgres: run it through `bun run test:e2e` (which starts the compose Postgres or requires DATABASE_URL). It never skips.'
      )
    }
  })

  test.afterAll(async () => {
    const db = connection.db
    if (workspaceIds.length) {
      await db
        .delete(authorizationAuditRecords)
        .where(inArray(authorizationAuditRecords.workspaceId, workspaceIds))
      await db.delete(threadReadStates).where(inArray(threadReadStates.workspaceId, workspaceIds))
      await db.delete(channelReadStates).where(inArray(channelReadStates.workspaceId, workspaceIds))
      await db.delete(messageMentions).where(inArray(messageMentions.workspaceId, workspaceIds))
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
      await db.delete(tasks).where(inArray(tasks.workspaceId, workspaceIds))
      await db.delete(agents).where(inArray(agents.workspaceId, workspaceIds))
      await db.delete(projects).where(inArray(projects.workspaceId, workspaceIds))
      await db.delete(workspaceEvents).where(inArray(workspaceEvents.workspaceId, workspaceIds))
      await db
        .delete(workspaceMemberships)
        .where(inArray(workspaceMemberships.workspaceId, workspaceIds))
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    }
    for (const userId of userIds) {
      await db.delete(temporaryUserSessions).where(eq(temporaryUserSessions.userId, userId))
      await db.delete(users).where(eq(users.id, userId))
    }
    await connection.close()
  })

  async function signIn(context: BrowserContext): Promise<SignInSession> {
    const response = await context.request.post('/api/workspaces/bootstrap')
    expect(response.status()).toBe(200)
    const payload = (await response.json()) as {
      principal: { temporary: boolean; userId: string }
      workspaces: { id: string }[]
    }
    const homeWorkspaceId = payload.workspaces[0]?.id
    if (!homeWorkspaceId)
      throw new Error('The account bootstrap returned no workspace for the new account')
    for (const workspace of payload.workspaces) workspaceIds.push(workspace.id)
    userIds.push(payload.principal.userId)
    return { homeWorkspaceId, principal: { kind: 'user', userId: payload.principal.userId } }
  }

  async function seedConversation(workspaceId: string, owner: Principal, title: string) {
    return createGroupChannel(connection.db, workspaceId, owner, {
      idempotencyKey: `board-resilience-${crypto.randomUUID()}`,
      title,
    })
  }

  async function seedMessage(
    workspaceId: string,
    channelId: string,
    sender: Principal,
    bodyText: string,
    taskId?: string
  ): Promise<void> {
    await createMessage(connection.db, workspaceId, channelId, sender, {
      bodyText,
      idempotencyKey: crypto.randomUUID(),
      sender,
      ...(taskId ? { taskId } : {}),
    })
  }

  async function seedTask(workspaceId: string, owner: Principal, title: string) {
    return createTask(
      connection.db,
      workspaceId,
      owner,
      { objective: `Objective for ${title}`, title },
      { idempotencyKey: crypto.randomUUID(), requestId: crypto.randomUUID() }
    )
  }

  test('a failed workspace query refetch keeps the board mounted and accessible', async ({
    page,
    context,
  }) => {
    test.slow()
    const { homeWorkspaceId, principal: owner } = await signIn(context)
    const conversation = await seedConversation(homeWorkspaceId, owner, 'Board Resilience Lane')
    const task = await seedTask(homeWorkspaceId, owner, 'Board Resilience Keep Visible')
    await seedMessage(
      homeWorkspaceId,
      conversation.id,
      owner,
      'The linked job keeps the board on screen.',
      task.id
    )

    await openSignedInApp(page)
    await page.getByRole('button', { name: 'Global conversation inbox' }).click()
    const row = page.getByRole('button', { name: /Board Resilience Lane/ })
    await expect(row).toBeVisible()
    await row.click()
    const composer = page.getByRole('textbox', { name: 'Message' }).first()
    await expect(composer).toBeVisible()

    // Open the linked job: the board renders with its task sheet on top.
    await page.getByRole('button', { name: 'Task · Board Resilience Keep Visible' }).click()
    await expect(page).toHaveURL(/app=kanban/)
    const board = page.locator('.conventional-workspace--board')
    await expect(board).toBeVisible()
    const taskSheet = page.getByRole('dialog', { name: 'Edit task' })
    await expect(taskSheet).toBeVisible()
    await taskSheet.getByRole('button', { name: 'Close task' }).click()
    await expect(taskSheet).toHaveCount(0)

    // Healthy invariants of the failing scenario: the board is a real DOM
    // node, is not inside an aria-hidden/inert subtree, has no modal portal
    // over it, the kanban route state is intact, and the rail agrees.
    const rail = page.getByRole('navigation', { name: 'Global navigation' })
    const railKanban = rail.getByRole('button', { name: 'Kanban', exact: true })
    await expect(page.getByRole('region', { name: 'Task board', exact: true })).toBeVisible()
    expect(await board.count()).toBe(1)
    expect(await board.evaluate((el) => Boolean(el.closest('[aria-hidden="true"], [inert]')))).toBe(
      false
    )
    expect(await page.getByRole('dialog').count()).toBe(0)
    expect(page.url()).toContain('app=kanban')
    await expect(railKanban).toHaveAttribute('aria-pressed', 'true')

    // Deterministic transient failure: the next workspace task-list refetch
    // fails at the network layer, exactly like a flaky server-function call.
    // The abort is armed only after data is on screen, so the query has data
    // (`isRefetchError`, not `isLoadingError`).
    let aborted = 0
    await page.route('**/api/v1/workspaces/*/tasks', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      aborted += 1
      await route.abort('failed')
    })

    // Trigger a real refetch of the task list through the surface itself:
    // starting the created card invalidates the workspace's task list.
    await board.getByRole('button', { name: 'Start' }).click()
    await expect.poll(() => aborted, { timeout: 15_000 }).toBeGreaterThan(0)
    // The failed refetch retries on TanStack's default backoff (~1s/2s/4s);
    // wait for it to settle before asserting the surface behaviour.
    await page.waitForTimeout(10_000)

    // Desired behaviour: one transient refetch failure must not tear the
    // board out of the document or the accessibility tree.
    await expect(page.getByRole('region', { name: 'Task board', exact: true })).toBeVisible()
    await expect(board).toBeVisible()
    expect(page.url()).toContain('app=kanban')
    await expect(railKanban).toHaveAttribute('aria-pressed', 'true')
    expect(await board.evaluate((el) => Boolean(el.closest('[aria-hidden="true"], [inert]')))).toBe(
      false
    )
    expect(aborted).toBeGreaterThan(0)
  })
})
