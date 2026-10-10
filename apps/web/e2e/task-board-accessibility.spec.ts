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
// Coverage class: modal-close accessibility state. The task sheet is a modal
// dialog: while it is open the workspace frame is aria-hidden, and closing it
// must restore the frame before the panel unmounts. The captured failure trace
// for the intermittent missing "Task board" region showed the board present in
// the DOM (role="region", aria-label="Task board") while the workspace frame
// still carried aria-hidden="true" and the body kept pointer-events:none — so
// the role query found nothing even though the board was visually rendered.
// This lane repeats the open/close cycle and asserts the route, portal
// cleanup, ancestor aria state and the accessible snapshot after every close.
// ---------------------------------------------------------------------------

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable'

type Principal = { kind: 'user'; userId: string }
type SignInSession = Readonly<{ homeWorkspaceId: string; principal: Principal }>

const TASK_TITLE = 'Browser UI Accessibility Keep Visible'
const SAVED_TITLE = 'Browser UI Accessibility Saved'
const CREATED_TITLE = 'Browser UI Accessibility Created'
const RACE_FIRST_TITLE = 'Browser UI Accessibility Race First'
const RACE_SECOND_TITLE = 'Browser UI Accessibility Race Second'

async function openSignedInApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'User settings' })).toBeVisible({
    timeout: 20_000,
  })
}

/** The frame state every close path must converge to. */
async function frameAccessibilityState(page: Page) {
  return page.evaluate(() => {
    const frame = document.querySelector('.workspace-frame')
    const boardElement = document.querySelector('.conventional-workspace--board')
    const hiddenAncestor = boardElement?.closest('[aria-hidden="true"], [inert]') ?? null
    return {
      frameAriaHidden: frame?.getAttribute('aria-hidden') ?? null,
      frameInert: frame ? frame.hasAttribute('inert') : null,
      hiddenAncestor: hiddenAncestor
        ? `${hiddenAncestor.tagName}.${hiddenAncestor.className}`.slice(0, 120)
        : null,
      bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
      dialogs: document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length,
    }
  })
}

test.describe('the task board stays in the accessibility tree across sheet closes', () => {
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
        'The task board accessibility lane requires the restricted local Postgres: run it through `bun run test:e2e` (which starts the compose Postgres or requires DATABASE_URL). It never skips.'
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
      idempotencyKey: `board-accessibility-${crypto.randomUUID()}`,
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

  test('every sheet close restores the board to the accessibility tree', async ({
    page,
    context,
  }) => {
    test.slow()
    const { homeWorkspaceId, principal: owner } = await signIn(context)
    const conversation = await seedConversation(homeWorkspaceId, owner, 'Board Accessibility Lane')
    const task = await seedTask(homeWorkspaceId, owner, TASK_TITLE)
    await seedMessage(homeWorkspaceId, conversation.id, owner, 'Accessibility anchor.', task.id)

    await openSignedInApp(page)
    await page.getByRole('button', { name: 'Global conversation inbox' }).click()
    const row = page.getByRole('button', { name: /Board Accessibility Lane/ })
    await expect(row).toBeVisible()
    await row.click()
    await expect(page.getByRole('textbox', { name: 'Message' }).first()).toBeVisible()

    await page.getByRole('button', { name: `Task · ${TASK_TITLE}` }).click()
    await expect(page).toHaveURL(/app=kanban/)
    const board = page.locator('.conventional-workspace--board')
    await expect(board).toBeVisible()
    const taskSheet = page.getByRole('dialog', { name: 'Edit task' })
    await expect(taskSheet).toBeVisible()
    const railKanban = page
      .getByRole('navigation', { name: 'Global navigation' })
      .getByRole('button', { name: 'Kanban', exact: true })
    // Modal state: while the sheet is open the frame is intentionally out of
    // the accessibility tree, so only CSS locators can see the board. The
    // close must restore it — that is what assertAccessibleBoard pins below.
    await expect
      .poll(async () => page.locator('.workspace-frame').getAttribute('aria-hidden'))
      .toBe('true')

    const assertAccessibleBoard = async () => {
      // The exact accessible lookup the linked-job flow uses: never weakened.
      await expect(page.getByRole('region', { name: 'Task board', exact: true })).toBeVisible()
      await expect(board).toBeVisible()

      const state = await page.evaluate(() => {
        const frame = document.querySelector('.workspace-frame')
        const boardElement = document.querySelector('.conventional-workspace--board')
        const hiddenAncestor = boardElement?.closest('[aria-hidden="true"], [inert]') ?? null
        return {
          frameAriaHidden: frame?.getAttribute('aria-hidden') ?? null,
          frameInert: frame ? frame.hasAttribute('inert') : null,
          hiddenAncestor: hiddenAncestor
            ? `${hiddenAncestor.tagName}.${hiddenAncestor.className}`.slice(0, 120)
            : null,
          bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
          dialogs: document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length,
          url: location.href,
        }
      })
      expect(state.frameAriaHidden).toBeNull()
      expect(state.frameInert).toBe(false)
      expect(state.hiddenAncestor).toBeNull()
      expect(state.bodyPointerEvents).not.toBe('none')
      expect(state.dialogs).toBe(0)
      expect(state.url).toContain('app=kanban')
      await expect(railKanban).toHaveAttribute('aria-pressed', 'true')

      // The accessible tree (not just the CSS) must expose the region.
      const snapshot = await page.locator('.workspace-frame').ariaSnapshot()
      expect(snapshot).toContain('region "Task board"')
    }

    await expect(taskSheet).toBeVisible()
    await taskSheet.getByRole('button', { name: 'Close task' }).click()
    await expect(taskSheet).toHaveCount(0)
    await assertAccessibleBoard()

    // A write Kobalte scheduled before disposal can land at any later frame,
    // on the element its close captured. The deep-link flow can remount the
    // workspace shell in between; the post-close lease then ends with the
    // replaced frame and the fresh frame stays untouched. Both outcomes keep
    // the board accessible, so the test pins the invariant — repair on the
    // same frame, a replaced frame left alone — not the remount timing.
    const dance = await page.evaluate(async () => {
      const frame = document.querySelector('.workspace-frame')
      if (!(frame instanceof HTMLElement)) throw new Error('workspace frame missing')
      frame.dataset.leaseProbe = '1'
      let frames = 0
      await new Promise<void>((done) => {
        const step = () => {
          frames += 1
          if (frames < 25) {
            requestAnimationFrame(step)
            return
          }
          frame.setAttribute('aria-hidden', 'true')
          frame.setAttribute('data-late-write', '1')
          done()
        }
        requestAnimationFrame(step)
      })
      return {
        wrote: frame.getAttribute('data-late-write') === '1',
        sameFrame: document.querySelector('.workspace-frame') === frame,
      }
    })
    expect(dance.wrote).toBe(true)
    if (dance.sameFrame) {
      await expect(page.locator('.workspace-frame')).not.toHaveAttribute('aria-hidden', 'true')
      await page
        .locator('.workspace-frame')
        .evaluate((frame) => frame.removeAttribute('data-late-write'))
    } else {
      await expect(page.locator('.workspace-frame')).not.toHaveAttribute('data-lease-probe')
      await expect(page.locator('.workspace-frame')).not.toHaveAttribute('aria-hidden', 'true')
    }
    await assertAccessibleBoard()

    const openFromCard = async (name: string) => {
      await page.getByRole('button', { name }).click()
      await expect(taskSheet).toBeVisible()
    }

    // A newer modal opened while that repair is still owned must keep its own
    // background state: the reopened sheet hides the frame and the previous
    // lease must not strip it. Escape then restores the accessible board.
    await openFromCard(TASK_TITLE)
    await expect
      .poll(async () => page.locator('.workspace-frame').getAttribute('aria-hidden'))
      .toBe('true')
    await page.keyboard.press('Escape')
    await expect(taskSheet).toHaveCount(0)
    await assertAccessibleBoard()
    await expect(page.getByRole('button', { name: TASK_TITLE })).toBeFocused()

    // Cancel
    await openFromCard(TASK_TITLE)
    await taskSheet.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(taskSheet).toHaveCount(0)
    await assertAccessibleBoard()
    await expect(page.getByRole('button', { name: TASK_TITLE })).toBeFocused()

    // Save closes through the dialog lifecycle and keeps the optimistic write:
    // the board card already shows the new title when the panel goes.
    await openFromCard(TASK_TITLE)
    await taskSheet.getByRole('textbox', { name: 'Title' }).fill(SAVED_TITLE)
    await taskSheet.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(taskSheet).toHaveCount(0)
    await assertAccessibleBoard()
    await expect(page.getByRole('button', { name: SAVED_TITLE })).toBeVisible()
    await expect(page.getByRole('button', { name: SAVED_TITLE })).toBeFocused()

    // Create completion closes through the same lifecycle.
    await page.getByRole('button', { name: 'New task' }).click()
    const createSheet = page.getByRole('dialog', { name: 'New task' })
    await expect(createSheet).toBeVisible()
    await createSheet.getByRole('textbox', { name: 'Title' }).fill(CREATED_TITLE)
    await createSheet
      .getByRole('textbox', { name: 'Description' })
      .fill('Created through the accessibility regression.')
    await createSheet.getByRole('button', { name: 'Create task' }).click()
    await expect(createSheet).toHaveCount(0)
    await assertAccessibleBoard()
    await expect(page.getByRole('button', { name: CREATED_TITLE })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New task' })).toBeFocused()

    // Archive confirmation: a second simultaneous overlay (the nested alert)
    // must not disturb the sheet or the frame's restoration once the sheet
    // itself closes. (Overlay ownership is pinned deterministically in the
    // dialog-background-state unit regression.)
    await openFromCard(SAVED_TITLE)
    await taskSheet.getByRole('button', { name: 'Archive', exact: true }).click()
    const archiveConfirm = page.getByRole('alertdialog', { name: 'Archive this task?' })
    await expect(archiveConfirm).toBeVisible()
    await archiveConfirm.getByRole('button', { name: 'Keep task', exact: true }).click()
    await expect(archiveConfirm).toHaveCount(0)
    await expect(taskSheet).toBeVisible()

    await taskSheet.getByRole('button', { name: 'Close task' }).click()
    await expect(taskSheet).toHaveCount(0)
    await assertAccessibleBoard()

    // Finish the archive through the nested confirmation.
    await openFromCard(SAVED_TITLE)
    await taskSheet.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(archiveConfirm).toBeVisible()
    await archiveConfirm.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(archiveConfirm).toHaveCount(0)
    await expect(taskSheet).toHaveCount(0)
    await assertAccessibleBoard()
    await expect(page.getByRole('button', { name: SAVED_TITLE })).toHaveCount(0)
  })

  test('a task opened during another close keeps the background isolated and holds focus', async ({
    page,
    context,
  }) => {
    const { homeWorkspaceId, principal: owner } = await signIn(context)
    const conversation = await seedConversation(homeWorkspaceId, owner, 'Board Close Race Lane')
    const first = await seedTask(homeWorkspaceId, owner, RACE_FIRST_TITLE)
    const second = await seedTask(homeWorkspaceId, owner, RACE_SECOND_TITLE)
    await seedMessage(homeWorkspaceId, conversation.id, owner, 'Race anchor one.', first.id)
    await seedMessage(homeWorkspaceId, conversation.id, owner, 'Race anchor two.', second.id)

    await openSignedInApp(page)
    await page.getByRole('button', { name: 'Global conversation inbox' }).click()
    const row = page.getByRole('button', { name: /Board Close Race Lane/ })
    await expect(row).toBeVisible()
    await row.click()
    await expect(page.getByRole('textbox', { name: 'Message' }).first()).toBeVisible()

    await page.getByRole('button', { name: `Task · ${RACE_FIRST_TITLE}` }).click()
    await expect(page).toHaveURL(/app=kanban/)
    const board = page.locator('.conventional-workspace--board')
    const taskSheet = page.getByRole('dialog', { name: 'Edit task' })
    await expect(board).toBeVisible()
    await expect(taskSheet).toBeVisible()
    await expect
      .poll(async () => page.locator('.workspace-frame').getAttribute('aria-hidden'))
      .toBe('true')

    // Both clicks in one task, before any timer or frame can run: the second
    // panel mounts while the first panel's close callback has not finished —
    // the interleaving that handed the background baseline to a capture taken
    // mid-close and stranded aria-hidden on the frame after the second sheet
    // closed.
    await page.evaluate(
      ([closeLabel, secondTitle]) => {
        const buttons = [...document.querySelectorAll('button')]
        buttons.find((button) => button.getAttribute('aria-label') === closeLabel)?.click()
        buttons.find((button) => button.textContent?.trim() === secondTitle)?.click()
      },
      ['Close task', RACE_SECOND_TITLE]
    )

    // The second sheet owns the background while it is open, and focus stayed
    // inside it instead of following the first close out.
    const secondSheet = page.getByRole('dialog', { name: 'Edit task' })
    await expect(secondSheet).toBeVisible()
    await expect
      .poll(async () => page.locator('.workspace-frame').getAttribute('aria-hidden'))
      .toBe('true')
    const focusInsideSecond = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      return dialog instanceof HTMLElement ? dialog.contains(document.activeElement) : false
    })
    expect(focusInsideSecond).toBe(true)

    await page.keyboard.press('Escape')
    await expect(secondSheet).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Task board', exact: true })).toBeVisible()
    await expect(board).toBeVisible()
    const state = await frameAccessibilityState(page)
    expect(state.frameAriaHidden).toBeNull()
    expect(state.frameInert).toBe(false)
    expect(state.hiddenAncestor).toBeNull()
    expect(state.bodyPointerEvents).not.toBe('none')
    expect(state.dialogs).toBe(0)
    await expect(page.getByRole('button', { name: RACE_SECOND_TITLE })).toBeVisible()
    const snapshot = await page.locator('.workspace-frame').ariaSnapshot()
    expect(snapshot).toContain('region "Task board"')
  })

  test('a stale post-close repair cannot reach a replacement workspace frame', async ({
    page,
    context,
  }) => {
    const { homeWorkspaceId, principal: owner } = await signIn(context)
    const conversation = await seedConversation(homeWorkspaceId, owner, 'Board Frame Swap Lane')
    const task = await seedTask(homeWorkspaceId, owner, TASK_TITLE)
    await seedMessage(homeWorkspaceId, conversation.id, owner, 'Frame swap anchor.', task.id)

    await openSignedInApp(page)
    await page.getByRole('button', { name: 'Global conversation inbox' }).click()
    await page.getByRole('button', { name: /Board Frame Swap Lane/ }).click()
    await expect(page.getByRole('textbox', { name: 'Message' }).first()).toBeVisible()
    await page.getByRole('button', { name: `Task · ${TASK_TITLE}` }).click()
    const taskSheet = page.getByRole('dialog', { name: 'Edit task' })
    await expect(taskSheet).toBeVisible()
    await taskSheet.getByRole('button', { name: 'Close task' }).click()
    await expect(taskSheet).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Task board', exact: true })).toBeVisible()

    // Navigation replaces the frame with a freshly rendered element while the
    // post-close lease is still alive. The stale write Kobalte can schedule
    // lands on the detached original; nothing may carry it (or any other
    // restoration) to the replacement.
    await page.evaluate(() => {
      const original = document.querySelector('.workspace-frame')
      if (!(original instanceof HTMLElement)) throw new Error('workspace frame missing')
      const replacement = document.createElement('div')
      replacement.className = original.className
      original.replaceWith(replacement)
      ;(window as unknown as { staleFrameMarker?: HTMLElement }).staleFrameMarker = original
      let frames = 0
      const step = () => {
        frames += 1
        if (frames < 25) {
          requestAnimationFrame(step)
          return
        }
        original.setAttribute('aria-hidden', 'true')
        original.setAttribute('data-stale-write', '1')
      }
      requestAnimationFrame(step)
    })
    await page.waitForFunction(
      () =>
        (window as unknown as { staleFrameMarker?: HTMLElement }).staleFrameMarker?.getAttribute(
          'data-stale-write'
        ) === '1'
    )
    // Several frames past the stale write: the repair window has passed.
    await page.waitForFunction(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))
        )
    )
    expect(await page.locator('.workspace-frame').getAttribute('aria-hidden')).toBeNull()
  })

  test('leaving the board ends the post-close background lease', async ({ page, context }) => {
    const { homeWorkspaceId, principal: owner } = await signIn(context)
    const conversation = await seedConversation(homeWorkspaceId, owner, 'Board Leave Lane')
    const task = await seedTask(homeWorkspaceId, owner, TASK_TITLE)
    await seedMessage(homeWorkspaceId, conversation.id, owner, 'Leave anchor.', task.id)

    await openSignedInApp(page)
    await page.getByRole('button', { name: 'Global conversation inbox' }).click()
    await page.getByRole('button', { name: /Board Leave Lane/ }).click()
    await expect(page.getByRole('textbox', { name: 'Message' }).first()).toBeVisible()
    await page.getByRole('button', { name: `Task · ${TASK_TITLE}` }).click()
    const taskSheet = page.getByRole('dialog', { name: 'Edit task' })
    await expect(taskSheet).toBeVisible()
    await taskSheet.getByRole('button', { name: 'Close task' }).click()
    await expect(taskSheet).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Task board', exact: true })).toBeVisible()

    // Navigate away from the kanban view: the board unmounts while the
    // workspace frame persists. No observer may outlive the board, so a late
    // Kobalte-style write afterwards finds nothing left to repair it.
    await page.getByRole('button', { name: 'Global conversation inbox' }).click()
    await expect(page.getByRole('region', { name: 'Task board', exact: true })).toHaveCount(0)
    await page.evaluate(() => {
      let frames = 0
      const step = () => {
        frames += 1
        if (frames < 25) {
          requestAnimationFrame(step)
          return
        }
        document.querySelector('.workspace-frame')?.setAttribute('aria-hidden', 'true')
        document.querySelector('.workspace-frame')?.setAttribute('data-late-write', '1')
      }
      requestAnimationFrame(step)
    })
    await page.waitForFunction(
      () => document.querySelector('.workspace-frame')?.getAttribute('data-late-write') === '1'
    )
    await page.waitForFunction(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))
        )
    )
    expect(await page.locator('.workspace-frame').getAttribute('aria-hidden')).toBe('true')
    await page.locator('.workspace-frame').evaluate((frame) => frame.removeAttribute('aria-hidden'))
  })
})
