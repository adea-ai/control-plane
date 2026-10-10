// The new-workspace draft names the signed-in account as the owner. The real shell and
// the real Dev nav host are mounted; only the bootstrap principal is supplied, so the
// owner comes from the same account label the settings surface shows. Guests and unknown
// identities keep the generic owner sentence.
import type { Page } from '@playwright/test'

import { expect, test } from '../start/browser/fixtures'

const workspace = {
  id: 'workspace-creation-owner-e2e',
  name: 'Acme home',
  scene: 'home',
  accent: null,
  logo: { kind: 'monogram' as const },
  sortOrder: 0,
  version: 1,
  updatedAt: '2026-10-10T00:00:00.000Z',
}

async function mockPrincipal(page: Page, principal: Record<string, unknown>) {
  await page.route('**/api/workspaces/bootstrap', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: { activeWorkspace: workspace, principal, workspaces: [workspace] },
    })
  })
}

test("a signed-in owner's new-workspace draft names the account in the chat sidebar", async ({
  page,
}) => {
  await mockPrincipal(page, { temporary: false, displayName: 'Acme Ops', userId: 'owner-e2e' })
  await page.goto('/?view=chat')
  const workspaceNav = page.getByRole('navigation', { name: 'Workspaces' })
  await expect(workspaceNav.getByRole('button', { name: 'New workspace' })).toBeVisible({
    timeout: 30_000,
  })
  await workspaceNav.getByRole('button', { name: 'New workspace' }).click()
  await expect(workspaceNav.getByLabel('New workspace name')).toBeFocused()
  await expect(
    workspaceNav.getByText('Owned by Acme Ops · Only you · Location unknown')
  ).toBeVisible()
})

for (const view of ['/?view=virtual', '/?view=chat'] as const) {
  test(`a guest's new-workspace draft keeps the generic owner wording (${view})`, async ({
    page,
  }) => {
    await mockPrincipal(page, { temporary: true })
    await page.goto(view)
    const workspaceNav = page.getByRole('navigation', { name: 'Workspaces' })
    await expect(workspaceNav.getByRole('button', { name: 'New workspace' })).toBeVisible({
      timeout: 30_000,
    })
    await workspaceNav.getByRole('button', { name: 'New workspace' }).click()
    await expect(workspaceNav.getByLabel('New workspace name')).toBeFocused()
    await expect(
      workspaceNav.getByText("You'll be the owner · Only you · Location unknown")
    ).toBeVisible()
    await expect(workspaceNav.getByText(/Owned by/)).toHaveCount(0)
  })
}

test("a signed-in owner's new-workspace draft names the account in the Dev sidebar", async ({
  page,
}) => {
  await mockPrincipal(page, { temporary: false, displayName: 'Acme Ops', userId: 'owner-e2e' })
  await page.goto('/?view=dev')
  const workspaceNav = page.getByRole('navigation', { name: 'Workspaces' })
  await expect(workspaceNav.getByRole('button', { name: 'New workspace' })).toBeVisible({
    timeout: 30_000,
  })
  await workspaceNav.getByRole('button', { name: 'New workspace' }).click()
  await expect(workspaceNav.getByLabel('New workspace name')).toBeFocused()
  await expect(
    workspaceNav.getByText('Owned by Acme Ops · Only you · Location unknown')
  ).toBeVisible()
})
