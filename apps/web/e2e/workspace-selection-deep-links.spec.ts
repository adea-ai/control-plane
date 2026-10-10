// Deep-linkable selection ownership: view, scene, and workspace switches.
//
// The router's search params own deep-linkable selection (issue #616): a scene
// or view change is one navigation, a `?scene=` deep link selects the
// workspace with that scene, and a `?workspace=` link switches with the scene
// following the destination. These journeys are functional-only (no visual
// snapshots): the visual lane covers pixels in conventional-workspace.spec.ts.
//
// The spec mocks every workspace API response, so no database is needed.
import { expect, test, type Page } from '@playwright/test'

const timestamp = '2026-09-22T10:00:00.000Z'
const workWorkspace = {
  id: 'workspace-selection-work',
  name: 'Work',
  scene: 'work',
  accent: null,
  logo: { kind: 'monogram' as const },
  sortOrder: 0,
  version: 1,
  updatedAt: timestamp,
}
const homeWorkspace = {
  id: 'workspace-selection-home',
  name: 'Home',
  scene: 'home',
  accent: null,
  logo: { kind: 'monogram' as const },
  sortOrder: 1,
  version: 1,
  updatedAt: timestamp,
}

// Boots the app with two workspaces; the Work workspace is the account's
// active one, so a scene-less URL lands on Work and a `?scene=home` deep link
// must land on Home (workspace-navigation-entry picks the workspace whose
// scene matches the requested scene).
async function mockTwoWorkspaceBootstrap(page: Page) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('adea:e2e-initialized')) {
      localStorage.clear()
      localStorage.setItem('theme', 'light')
      sessionStorage.setItem('adea:e2e-initialized', 'true')
    }
  })
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: workWorkspace,
        principal: { temporary: true, userId: 'selection-e2e-user' },
        workspaces: [workWorkspace, homeWorkspace],
      },
    })
  )
  await page.route('**/api/v1/workspaces/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/read-state'))
      return route.fulfill({ contentType: 'application/json', json: { readState: [] } })
    if (url.pathname.endsWith('/messages'))
      return route.fulfill({
        contentType: 'application/json',
        json: { messages: [], nextAfterSequence: null },
      })
    if (route.request().method() !== 'GET')
      return route.fulfill({ contentType: 'application/json', json: {} })
    if (url.pathname.endsWith('/search'))
      return route.fulfill({
        contentType: 'application/json',
        json: { privateResultsUnavailable: true, results: [] },
      })
    return route.fulfill({ contentType: 'application/json', json: [] })
  })
}

async function openWorkspaceNavigation(page: Page, url: string) {
  await page.goto(url, { timeout: 60_000 })
  const globalNavigation = page.getByRole('navigation', { name: 'Global navigation' })
  // Cold dev-server transforms of the lazy workspace chunk can be slow on a
  // busy machine; give the mount the same headroom the Dev lane gives itself.
  await expect(globalNavigation).toBeVisible({ timeout: 60_000 })
  return globalNavigation
}

// The contextual sidebar's Workspaces accordion (ADR 0011): the active
// workspace is the expanded one, titled by a level-3 heading; every other
// workspace is one row whose click switches to it.
const workspaceNav = (page: Page) => page.getByRole('navigation', { name: 'Workspaces' })
const activeWorkspaceHeading = (page: Page, name: string) =>
  workspaceNav(page).getByRole('heading', { name, level: 3 })
const collapsedWorkspaceRow = (page: Page, name: string) =>
  workspaceNav(page).getByRole('button', { name: new RegExp(`^${name}(?: |$)`) })

test('a scene deep link opens the workspace with that scene', async ({ page }) => {
  await mockTwoWorkspaceBootstrap(page)
  await openWorkspaceNavigation(page, '/?scene=home')
  await expect(activeWorkspaceHeading(page, 'Home')).toBeVisible()
  // The deep link's scene survives reconciliation: the URL keeps the fact.
  await expect(page).toHaveURL(/scene=home/)
  await expect(page).not.toHaveURL(/scene=work/)
})

test('a scene-less URL reconciles to the active workspace scene', async ({ page }) => {
  await mockTwoWorkspaceBootstrap(page)
  await openWorkspaceNavigation(page, '/')
  // The router owns the scene: once the server-authoritative summary lands,
  // the URL carries the active workspace's scene without a second writer.
  await expect(page).toHaveURL(/scene=work/)
})

test('switching workspaces updates the scene with one navigation', async ({ page }) => {
  await mockTwoWorkspaceBootstrap(page)
  await openWorkspaceNavigation(page, '/')
  await expect(activeWorkspaceHeading(page, 'Work')).toBeVisible()

  await collapsedWorkspaceRow(page, 'Home').click()
  await expect(activeWorkspaceHeading(page, 'Home')).toBeVisible()
  await expect(collapsedWorkspaceRow(page, 'Work')).toBeVisible()
  await expect(page).toHaveURL(/scene=home/)

  await collapsedWorkspaceRow(page, 'Work').click()
  await expect(activeWorkspaceHeading(page, 'Work')).toBeVisible()
  await expect(page).toHaveURL(/scene=work/)
})

test('a workspace deep link switches and the scene follows the destination', async ({ page }) => {
  await mockTwoWorkspaceBootstrap(page)
  await openWorkspaceNavigation(page, `/?workspace=${homeWorkspace.id}`)
  await expect(activeWorkspaceHeading(page, 'Home')).toBeVisible()
  // The consumed `?workspace=` param is stripped and the scene reconciles to
  // the destination workspace.
  await expect(page).not.toHaveURL(/workspace=/)
  await expect(page).toHaveURL(/scene=home/)
})

test('the virtual-view handoff preserves the scene in the URL', async ({ page }) => {
  await mockTwoWorkspaceBootstrap(page)
  const globalNavigation = await openWorkspaceNavigation(page, '/')
  await expect(page).toHaveURL(/scene=work/)

  await globalNavigation.getByRole('button', { name: 'Virtual view' }).click()
  await expect(page).toHaveURL(/view=virtual/)
  await expect(page).toHaveURL(/scene=work/)
  // The engine is entitled per build: a packed Agent Sim renders its own room
  // region and controls, and every other build renders the documented offline
  // fallback. Both are correct outcomes of the same handoff.
  await expect(
    page.getByRole('region', { name: 'Virtual Room' }).or(
      page.getByRole('status', {
        name: 'Virtual view unavailable',
      })
    )
  ).toBeVisible({ timeout: 30_000 })
})

test('view navigation is history-traversable with the scene intact', async ({ page }) => {
  await mockTwoWorkspaceBootstrap(page)
  const globalNavigation = await openWorkspaceNavigation(page, '/')
  // The default app is not written into the URL: a scene-less boot reconciles
  // the scene only, and `view` appears once the user leaves the default.
  await expect(page).toHaveURL(/scene=work/)
  await expect(page).not.toHaveURL(/view=/)

  await globalNavigation.getByRole('button', { name: 'Virtual view' }).click()
  await expect(page).toHaveURL(/view=virtual/)

  await page.goBack()
  await expect(page).toHaveURL(/scene=work/)
  await expect(page).not.toHaveURL(/view=/)
  await page.goForward()
  await expect(page).toHaveURL(/view=virtual/)
  await expect(page).toHaveURL(/scene=work/)
})

// A scoped link (channel or task) names a destination inside the target workspace. The
// shell applies it only against that workspace's own lists and consumes the link after
// applying it, so the `workspace` param must survive until then. These cases hold the
// target's lists back: the switch settles first, and the destination is applied only
// once the target's data lands.
const homeChannelId = 'selection-home-channel'
const homeTaskId = 'selection-home-task'

async function holdTargetLists(page: Page, path: 'channels' | 'tasks', body: unknown) {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  await page.route(`**/api/v1/workspaces/${homeWorkspace.id}/${path}`, async (route) => {
    await released
    await route.fulfill({ contentType: 'application/json', json: body })
  })
  return () => release()
}

test('a scoped channel link keeps its workspace guard until the target channels land', async ({
  page,
}) => {
  await mockTwoWorkspaceBootstrap(page)
  const releaseChannels = await holdTargetLists(page, 'channels', [
    {
      createdAt: timestamp,
      id: homeChannelId,
      isPrimaryProjectChannel: false,
      kind: 'group',
      lifecycleState: 'active',
      participants: [],
      sortOrder: 0,
      title: 'Home channel',
      updatedAt: timestamp,
      version: 1,
      visibility: 'workspace',
      workspaceId: homeWorkspace.id,
    },
  ])
  const channelLoaded = page.waitForRequest((request) =>
    request.url().includes(`/channels/${homeChannelId}/messages`)
  )

  await openWorkspaceNavigation(page, `/?workspace=${homeWorkspace.id}&channel=${homeChannelId}`)
  // The switch settles while the target channels are held: the guard is still in the URL.
  await expect(activeWorkspaceHeading(page, 'Home')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`workspace=${homeWorkspace.id}`))
  await expect(page).toHaveURL(new RegExp(`channel=${homeChannelId}`))

  releaseChannels()
  // The destination is applied against the target, then the whole link is consumed.
  await channelLoaded
  await expect(page).not.toHaveURL(/channel=|workspace=/)
})

test('a scoped task link keeps its workspace guard until the target tasks land', async ({
  page,
}) => {
  await mockTwoWorkspaceBootstrap(page)
  // The shell applies a destination only once the target's channel list is non-empty.
  await page.route(`**/api/v1/workspaces/${homeWorkspace.id}/channels`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: [
        {
          createdAt: timestamp,
          id: 'selection-home-general',
          isPrimaryProjectChannel: false,
          kind: 'group',
          lifecycleState: 'active',
          participants: [],
          sortOrder: 0,
          title: 'General',
          updatedAt: timestamp,
          version: 1,
          visibility: 'workspace',
          workspaceId: homeWorkspace.id,
        },
      ],
    })
  )
  const releaseTasks = await holdTargetLists(page, 'tasks', [
    {
      artifactRefs: [],
      conversation: {},
      createdAt: timestamp,
      creator: { kind: 'user', userId: 'selection-e2e-user' },
      dependencyIds: [],
      id: homeTaskId,
      kind: 'chore',
      lifecycleState: 'created',
      priority: 'normal',
      title: 'Home task',
      updatedAt: timestamp,
      version: 1,
      workspaceId: homeWorkspace.id,
    },
  ])

  await openWorkspaceNavigation(page, `/?workspace=${homeWorkspace.id}&task=${homeTaskId}`)
  await expect(activeWorkspaceHeading(page, 'Home')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`workspace=${homeWorkspace.id}`))
  await expect(page).toHaveURL(new RegExp(`task=${homeTaskId}`))

  releaseTasks()
  await expect(page).not.toHaveURL(/task=|workspace=/, { timeout: 30_000 })
})
