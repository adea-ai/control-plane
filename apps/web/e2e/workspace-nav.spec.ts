import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

async function openHarness(page: Page, query = '') {
  const path = `/__workspace-nav${query}`
  await page.route('**' + path, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto(path)
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/workspace-nav-harness-app.tsx')
  )
  await expect(page.getByRole('tree', { name: 'Adea projects' })).toBeVisible()
}

const events = (page: Page) => page.getByRole('list', { name: 'Nav events' })
const nav = (page: Page) => page.getByRole('navigation', { name: 'Workspaces' })

test('a collapsed workspace row switches the active workspace', async ({ page }) => {
  await openHarness(page)
  const pinkBinder = nav(page).getByRole('button', { name: /Pink Binder/ })
  await expect(pinkBinder).toContainText('2 running')
  await pinkBinder.click()
  await expect(events(page)).toContainText('workspace:pink-binder')
  await expect(page.getByRole('tree', { name: 'Pink Binder projects' })).toBeVisible()
  await expect(page.getByRole('tree', { name: 'Adea projects' })).toHaveCount(0)
  await expect(nav(page).getByRole('button', { name: /Adea/ })).toBeVisible()
})

test('inline workspace create commits on Enter and cancels on Escape', async ({ page }) => {
  await openHarness(page)
  const create = page.getByRole('button', { name: 'New workspace', exact: true })
  await create.click()
  const input = page.getByRole('textbox', { name: 'New workspace name' })
  await expect(input).toBeFocused()
  await input.fill('Side Quest')
  await input.press('Enter')
  await expect(events(page)).toContainText('create-workspace:Side Quest')
  await expect(input).toHaveCount(0)

  await create.click()
  await page.getByRole('textbox', { name: 'New workspace name' }).fill('Discarded')
  await page.getByRole('textbox', { name: 'New workspace name' }).press('Escape')
  await expect(page.getByRole('textbox', { name: 'New workspace name' })).toHaveCount(0)
  await expect(events(page)).not.toContainText('Discarded')

  // Leaving the field creates when a name was typed and cancels when empty.
  await create.click()
  await page.getByRole('textbox', { name: 'New workspace name' }).fill('Blurred')
  await page.getByRole('textbox', { name: 'New workspace name' }).blur()
  await expect(events(page)).toContainText('create-workspace:Blurred')
  await create.click()
  await page.getByRole('textbox', { name: 'New workspace name' }).blur()
  await expect(page.getByRole('textbox', { name: 'New workspace name' })).toHaveCount(0)
  await expect(events(page).getByText(/^create-workspace:/)).toHaveCount(2)
})

test('the draft context names a known owner and stays honest unknown', async ({ page }) => {
  // Known identity reaches the row through the host call-site chain.
  await openHarness(page, '?owner=Acme')
  await nav(page).getByRole('button', { name: 'New workspace', exact: true }).click()
  await expect(nav(page).getByText('Owned by Acme · Only you · Location unknown')).toBeVisible()

  // Without a fed label the same row falls back without inventing identity.
  await openHarness(page)
  await nav(page).getByRole('button', { name: 'New workspace', exact: true }).click()
  await expect(
    nav(page).getByText("You'll be the owner · Only you · Location unknown")
  ).toBeVisible()
})

test('group-by switches between project, status and recent renderings', async ({ page }) => {
  await openHarness(page)
  const tree = page.getByRole('tree', { name: 'Adea projects' })
  await page.getByRole('button', { name: /Group by/ }).click()
  await page.getByRole('menuitemradio', { name: /Status/ }).click()
  await expect(events(page)).toContainText('group:status')
  await expect(tree.locator('[data-status-group]')).toHaveText([
    /^Needs you\s*1$/,
    /^Running\s*2$/,
    /^In review\s*1$/,
    /^Idle\s*4$/,
  ])
  await expect(tree.getByRole('treeitem', { name: 'Needs you 1' })).toHaveAttribute(
    'aria-expanded',
    'true'
  )

  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.getByRole('button', { name: /Group by/ }).click()
  await expect(page.getByRole('menuitemradio', { name: /Status/ })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await page.getByRole('menuitemradio', { name: /Recent/ }).click()
  await expect(events(page)).toContainText('group:recent')
  await expect(tree.getByRole('treeitem').first()).toContainText('sidebar-ux-redesign')

  await nav(page)
    .getByRole('button', { name: /^Needs you/ })
    .click()
  await expect(events(page)).toContainText('group:status')
})

test('row menus come from the adapter and the checkout has no delete', async ({ page }) => {
  await openHarness(page)
  await page.getByRole('treeitem', { name: /sidebar-ux-redesign/ }).hover()
  await page.getByRole('button', { name: 'Worktree options for sidebar-ux-redesign' }).click()
  await expect(page.getByRole('menuitem')).toHaveText([
    'Rename',
    'Copy link',
    'Share',
    'Open in Finder',
    'Archive',
    'Delete',
  ])
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(events(page)).toContainText('leaf-menu:archive:sidebar-ux-redesign')

  const checkout = page.locator('[data-leaf-id="adea-main"]')
  await checkout.hover()
  await checkout.getByRole('button', { name: 'Worktree options for main' }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Copy path', 'Open in Finder', 'Share'])
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.locator('[data-project-id="adea"]').hover()
  await page.getByRole('button', { name: 'Project options for adea', exact: true }).click()
  await expect(page.getByRole('menuitem')).toHaveText([
    'Rename',
    'Project settings',
    'Share',
    'Archive',
    'Delete',
  ])
})

test('the tree supports keyboard navigation, disclosure and selection', async ({ page }) => {
  await openHarness(page)
  const tree = page.getByRole('tree', { name: 'Adea projects' })
  const project = tree.locator('[data-project-id="adea"]')
  await project.focus()
  await expect(project).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(project).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('[data-leaf-id="adea-main"]')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(project).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowDown')
  const checkout = page.locator('[data-leaf-id="adea-main"]')
  await expect(checkout).toBeFocused()
  await page.keyboard.press('ArrowDown')
  const worktree = page.locator('[data-leaf-id="sidebar-ux-redesign"]')
  await expect(worktree).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(events(page)).toContainText('leaf:sidebar-ux-redesign')
  await expect(worktree).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(project).toBeFocused()
})

test('the Workspaces heading actions stay visible without hover or focus', async ({ page }) => {
  await openHarness(page)
  await page.mouse.move(0, 0)
  for (const name of [/^Group by/, /^New workspace$/]) {
    const action = nav(page).getByRole('button', { name })
    await expect(action).toBeVisible()
    await expect
      .poll(() =>
        action.evaluate((element) => {
          // Every ancestor up to the nav must be fully opaque.
          let node: Element | null = element
          while (node && node.getAttribute('data-slot') !== 'workspace-nav') {
            if (getComputedStyle(node).opacity !== '1') return false
            node = node.parentElement
          }
          return true
        })
      )
      .toBe(true)
  }
})
