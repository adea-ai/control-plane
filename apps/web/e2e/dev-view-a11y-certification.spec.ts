import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/*
 * M12 #541 manual keyboard + screen-reader-semantics certification (2026-10-06).
 *
 * The automated axe pass (docs/evidence/m12-426-a11y-2026-09-22.md) covered
 * static WCAG scanning; the release gate kept manual keyboard/AT
 * certification as the accepted v1 gap. This spec is the certification
 * harness: keyboard-only reachability and operability for the Dev View owner
 * journey surfaces, dialog focus management, live-region announcements,
 * pointer-target geometry, and per-surface aria snapshots. The evidence
 * document maps each WCAG 2.2 AA criterion to the assertions here.
 */

const DEV_URL = '/?view=dev&devE2e=preserved'

async function openDevView(page: Page, url = DEV_URL) {
  await page.goto(url)
  await expect(page.getByRole('main')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })
}

/** Keyboard-focused element descriptor for focus-order walks. */
function describeActiveElement(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement
    if (!element || element === document.body)
      return { tag: 'body', name: '', role: null, focusVisible: false }
    return {
      tag: element.tagName.toLowerCase(),
      name: (element.getAttribute('aria-label') ?? element.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60),
      role: element.getAttribute('role'),
      focusVisible: element.matches(':focus-visible'),
    }
  })
}

test('cert 2.4.1/2.4.3: the skip link is the first tab stop and bypasses the frame chrome', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page)

  // The frame's first tabbable element is the bypass link, before the ~21
  // repeated top-bar and rail controls.
  await page.keyboard.press('Tab')
  const firstStop = await describeActiveElement(page)
  expect(firstStop.tag).toBe('a')
  expect(firstStop.name).toBe('Skip to workspace content')

  // Activating it moves focus past the top bar, rail, and sidebar into the
  // dev center panes.
  await page.keyboard.press('Enter')
  await expect(page.locator('#dev-center')).toBeFocused()

  // The same contract holds for the conventional shell's main landmark. The
  // bypass link must be attached before the walk: a Tab pressed during the
  // dev-server hydration window lands nowhere (focus stays on <body>) and
  // measures the harness, not the frame. The activation target mounts after
  // the frame, so wait for it too before measuring the Enter.
  await page.goto('/?view=chat')
  await expect(page.getByRole('main')).toBeVisible({ timeout: 60_000 })
  await page.locator('.workspace-skip-link').waitFor({ state: 'attached' })
  await page.locator('#workspace-main').waitFor({ state: 'attached' })
  await page.keyboard.press('Tab')
  const chatFirstStop = await describeActiveElement(page)
  expect(chatFirstStop.name).toBe('Skip to workspace content')
  await page.keyboard.press('Enter')
  await expect(page.locator('#workspace-main')).toBeFocused()
})

test('cert 2.5.8: sidebar disclosure rows and drag strips meet the 24px target minimum', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page)

  // Disclosure triggers: the shared workspace sidebar's project rows (ADR
  // 0011). Each tree row must still be a 24px-tall target.
  for (const rowName of ['Example project', 'Runtime tools']) {
    const row = page.locator('[role="treeitem"][data-project-id]').filter({ hasText: rowName })
    await expect(row).toBeVisible()
    const box = await row.boundingBox()
    expect(box, `disclosure row ${rowName} should render`).not.toBeNull()
    expect(box!.height, `disclosure row ${rowName} pointer target height`).toBeGreaterThanOrEqual(
      24
    )
  }

  // Drag strips: the visible line stays 1px, the ::after pointer extension
  // reaches 24px on the drag axis.
  await page.getByRole('button', { name: 'Split pane', exact: true }).click()
  await expect(page.getByRole('separator', { name: 'Resize workspace panes' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Expand utility sidebar' }).click()
  await expect(
    page.getByRole('complementary', { name: 'Shared developer utilities' })
  ).toBeVisible()

  // The left utility slot is collapsed on first run (#1168), so its drag strip
  // exists only after the owner opens the slot. Assert the collapsed state, then
  // open it from the keyboard with its toolbar control; a click would be a no-op
  // or a collapse if the slot were already open.
  const leftToggle = page.getByRole('button', { name: 'Expand left utility sidebar' })
  const leftStrip = page.getByRole('separator', { name: 'Resize left utility pane' })
  await expect(leftToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(leftStrip).toHaveCount(0)
  await leftToggle.focus()
  await page.keyboard.press('Enter')
  await expect(leftStrip).toHaveCount(1)
  // The toolbar control relabels to "Collapse" once the slot is open.
  await expect(
    page.getByRole('button', { name: 'Collapse left utility sidebar', exact: true })
  ).toHaveAttribute('aria-expanded', 'true')

  const strips = [
    { label: 'Resize workspace navigation', axis: 'width' as const },
    { label: 'Resize left utility pane', axis: 'width' as const },
    { label: 'Resize right utility pane', axis: 'width' as const },
    { label: 'Resize workspace panes', axis: 'width' as const },
  ]
  for (const strip of strips) {
    const separator = page.getByRole('separator', { name: strip.label }).first()
    await expect(separator).toBeAttached()
    const geometry = await separator.evaluate((element) => {
      const style = getComputedStyle(element, '::after')
      const box = element.getBoundingClientRect()
      return {
        lineWidth: Math.round(box.width),
        hitWidth: Number.parseFloat(style.width),
        hitHeight: Number.parseFloat(style.height),
      }
    })
    expect(geometry.lineWidth, `${strip.label} visible line`).toBeLessThanOrEqual(2)
    expect(
      Math.max(geometry.hitWidth, geometry.hitHeight),
      `${strip.label} pointer target`
    ).toBeGreaterThanOrEqual(24)
  }
})

test('cert 2.5.8: narrow-viewport controls keep 24px targets without overlap', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await openDevView(page)

  // At the narrow end the sidebar is a sheet overlay. Open it for the archive
  // shelf check, then close it: while the sheet is up the topbar sits under
  // the overlay legitimately (modal context), so the toggle's own geometry is
  // measured with the sheet dismissed.
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  if (!(await sidebar.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /Expand contextual sidebar/ }).click()
    await expect(sidebar).toBeVisible()
  }

  // The archive shelf's ghost disclosure is a published small size; the repo
  // hook lifts it to the minimum.
  const shelfToggle = page.getByRole('button', { name: /archived sessions/i })
  await expect(shelfToggle).toBeVisible()
  const shelfBox = await shelfToggle.boundingBox()
  expect(shelfBox, 'archive shelf disclosure should render').not.toBeNull()
  expect(
    Math.min(shelfBox!.width, shelfBox!.height),
    'archive shelf pointer target minimum'
  ).toBeGreaterThanOrEqual(24)

  // Close the sheet and measure the topbar context toggle in the base state.
  await page.keyboard.press('Escape')
  await expect(sidebar).toBeHidden()
  const toggle = page.locator('[data-context-toggle]')
  await expect(toggle).toBeVisible()
  const box = await toggle.boundingBox()
  expect(box, 'topbar context toggle should render').not.toBeNull()
  expect(
    Math.min(box!.width, box!.height),
    'topbar context toggle pointer target minimum'
  ).toBeGreaterThanOrEqual(24)

  // The narrow topbar's nav groups must not paint over each other: the view
  // actions previously overlapped the context toggle's edge, leaving it 20.9px
  // of usable target (the axe partiallyObscured finding this pins).
  const usable = await toggle.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const samples = [0.05, 0.25, 0.5, 0.75, 0.95].map((fraction) => {
      const probe = document.elementFromPoint(
        rect.x + rect.width * fraction,
        rect.y + rect.height / 2
      )
      return probe === element || element.contains(probe)
    })
    return samples
  })
  expect(
    usable.every((hit) => hit),
    'context toggle fully usable at 320px'
  ).toBe(true)
})

test('cert 4.1.2: worktree rows announce status and branch as separated tokens', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page)

  // The shared tree's leaf rows (ADR 0011): the status is words, not only a
  // glyph, and it stays a distinct token from the branch in the name.
  const row = page.getByRole('treeitem', { name: /feature\/example/ })
  await expect(row).toBeVisible()
  await expect(row).toHaveAccessibleName(/^Running feature\/example$/)
  await expect(page.getByRole('treeitem', { name: /feature\/runtime/ })).toHaveAccessibleName(
    /^feature\/runtime Needs you$/
  )
})

test('cert 2.4.7: keyboard focus stays visible across the sidebar and toolbar walk', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page)
  await page.getByRole('button', { name: 'Split pane', exact: true }).click()

  // Walk the top of the tab order: frame chrome, toolbar, rail, sidebar rows,
  // and both splitter kinds. Every keyboard stop must report :focus-visible,
  // and every stop must carry a drawn indicator (ring, outline, or the
  // separator's primary-state fill).
  let stops = 0
  let stuckCount = 0
  let previous = ''
  await page.keyboard.press('Tab')
  while (stops < 40) {
    const stop = await page.evaluate(() => {
      const element = document.activeElement
      if (!element || element === document.body) return null
      const style = getComputedStyle(element)
      const indicator =
        (Number.parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none') ||
        style.boxShadow !== 'none' ||
        element.matches('[role="separator"]')
      return {
        key: `${element.tagName}|${element.getAttribute('aria-label') ?? element.textContent?.slice(0, 30) ?? ''}`,
        focusVisible: element.matches(':focus-visible'),
        indicator,
        role: element.getAttribute('role'),
      }
    })
    if (!stop) break
    expect(stop.focusVisible, `stop ${stops} (${stop.key}) is a keyboard stop`).toBe(true)
    if (stop.role !== 'separator') {
      expect(stop.indicator, `stop ${stops} (${stop.key}) draws a focus indicator`).toBe(true)
    }
    stops += 1
    if (stop.key === previous) {
      stuckCount += 1
      expect(stuckCount, 'tab order cycles instead of trapping').toBeLessThan(3)
    } else {
      stuckCount = 0
    }
    previous = stop.key
    await page.keyboard.press('Tab')
  }
  expect(stops).toBeGreaterThanOrEqual(30)
})

test('cert 2.1.2/3.2.1: the walk neither traps nor changes context', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page)

  // The workspace summary mirrors the workspace's scene into the URL when its
  // query settles — a data-arrival write, not a focus-triggered context
  // change. Let it land before recording the baseline so the walk measures
  // the walk, not the summary's arrival.
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('scene=')
  const urlBefore = page.url()
  await page.getByRole('button', { name: 'Collapse contextual sidebar' }).focus()
  for (let i = 0; i < 16; i += 1) await page.keyboard.press('Tab')
  expect(page.url()).toBe(urlBefore)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Focus kept moving through distinct controls: no trap.
  const active = await describeActiveElement(page)
  expect(active.tag).not.toBe('body')
})

test('cert dialogs: the settings tab pattern and help-center focus restore hold by keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?view=dev&devE2e=preserved')
  await expect(page.getByRole('region', { name: 'Developer workspace panes' })).toBeVisible({
    timeout: 60_000,
  })

  const userSettings = page.getByRole('button', { name: 'User settings' })
  const openAccountMenu = async () => {
    await userSettings.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menu')).toBeVisible()
    // The menu takes focus for itself a moment after it opens, on its first
    // enabled item. Wait for that focus before the test moves it: a focus set
    // earlier is overwritten, and Enter then activates the item the menu chose.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('role')))
      .toBe('menuitem')
  }

  // Settings: tabs pattern.
  await openAccountMenu()
  await page.getByRole('menu').getByRole('menuitem', { name: 'Settings' }).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('tablist', { name: 'Settings sections' })).toBeVisible()
  const accountTab = dialog.getByRole('tab', { name: 'Account & app' })
  await expect(accountTab).toBeFocused()

  // Roving arrows move both focus and selection within the tablist.
  await page.keyboard.press('ArrowDown')
  await expect(dialog.getByRole('tab', { name: 'Appearance' })).toBeFocused()
  await expect(dialog.getByRole('tab', { name: 'Appearance' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.keyboard.press('ArrowUp')
  await expect(dialog.getByRole('tab', { name: 'Account & app' })).toHaveAttribute(
    'aria-selected',
    'true'
  )

  // Re-activating the selected tab is a no-op (issue #601), never a dismissal.
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()

  // Focus is trapped while the modal is open.
  for (let i = 0; i < 25; i += 1) await page.keyboard.press('Tab')
  expect(
    await page.evaluate(() => document.activeElement?.closest('[role="dialog"]'))
  ).not.toBeNull()

  // Escape closes the topmost layer first. The tab walk can end on a control
  // whose focus-triggered tooltip is open, and that tooltip is the top
  // dismissable layer — its Escape closes the tooltip without moving focus
  // (ARIA APG tooltip pattern); the next Escape closes the dialog and
  // restores the opener. Dismiss the tooltip when present so the dialog's
  // own Escape is measured deterministically.
  const tooltipOpen = await page.evaluate(() => document.querySelector('[role="tooltip"]') !== null)
  if (tooltipOpen) {
    await page.keyboard.press('Escape')
    // The tooltip must be fully detached before the next Escape, or both
    // keypresses land on the still-mounted tooltip layer.
    await page
      .locator('[role="tooltip"]')
      .waitFor({ state: 'detached', timeout: 5_000 })
      .catch(() => {})
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(userSettings).toBeFocused()

  // Help Center: Escape must not drop focus on the page (restore regression).
  await openAccountMenu()
  await page.getByRole('menu').getByRole('menuitem', { name: 'Help Center' }).focus()
  await page.keyboard.press('Enter')
  const help = page.getByRole('dialog', { name: 'Help Center' })
  await expect(help).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
  await expect(userSettings).toBeFocused()

  // About panel keeps the same contract.
  await openAccountMenu()
  await page.getByRole('menu').getByRole('menuitem', { name: 'About' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(userSettings).toBeFocused()
})

test('cert 4.1.3: the workspace rail announces keyboard reorder moves', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page)

  // #1053 removed the dev-sidebar project reorder; the workspace rail is the
  // reorder surface the release ships. Alt+Arrow moves the focused view one
  // slot, focus follows the moved row, and the rail's own live region
  // announces the new position. Reorderable rows carry the documented
  // aria-description (App Library does not), and the target is the last
  // reorderable row so an upward move always exists.
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const viewRows = rail.getByRole('button', {
    description: 'Press Alt with Arrow Up or Arrow Down to move this view.',
  })
  const count = await viewRows.count()
  expect(count, 'the rail has more than one reorderable view').toBeGreaterThan(1)
  const target = viewRows.nth(count - 1)
  const rowId = await target.getAttribute('data-row-id')
  const targetName = await target.getAttribute('aria-label')
  await target.focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(viewRows.nth(count - 2)).toHaveAttribute('data-row-id', rowId!)
  await expect(rail.getByRole('button', { name: targetName! })).toBeFocused()
  await expect(rail.getByRole('status')).toContainText(
    `${targetName} moved to position ${count - 1} of ${count}`
  )
})

test('cert terminal: the fixture pane keeps the production keyboard contract', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page, `${DEV_URL}&devProject=fixture-adea&devSession=fixture-shell`)
  const output = page.getByRole('region', { name: 'Terminal output' })
  await expect(output).toBeVisible({ timeout: 60_000 })

  // The scrollable output is a labelled, keyboard-focusable region.
  await output.focus()
  await expect(output).toBeFocused()

  // Search opens by keyboard, focuses its input, and Escape closes it,
  // returning focus to the terminal surface.
  await page.keyboard.press('ControlOrMeta+Shift+f')
  const search = page.getByRole('search', { name: 'Search terminal' })
  await expect(search).toBeVisible()
  // type=search carries the searchbox role, not textbox.
  await expect(page.getByRole('searchbox', { name: 'Search terminal' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(search).toBeHidden()
  await expect(output).toBeFocused()

  // The compose input is labelled and reachable.
  await page.getByRole('textbox', { name: 'Compose terminal input' }).focus()
  await expect(page.getByRole('textbox', { name: 'Compose terminal input' })).toBeFocused()
})

test('cert 3.3.1/3.3.2: the add-project form is keyboard-operable with labelled controls and announced errors', async ({
  page,
}) => {
  test.slow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.route('**/__dev-add-project', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body><div id="harness-root"></div></body></html>',
    })
  )
  await page.goto('/__dev-add-project')
  await page.evaluate(
    async (url) => {
      await import(url)
    },
    '/@fs' + resolve(process.cwd(), 'apps/web/e2e/helpers/dev-add-project-harness-app.tsx')
  )
  await expect(page.getByTestId('ready')).toHaveText('ready')

  // 2.5.8: the dialog opener is a full pointer target as well.
  const opener = page.getByRole('button', { name: 'Add repository…', exact: true })
  const openerBox = await opener.boundingBox()
  expect(openerBox!.height).toBeGreaterThanOrEqual(24)

  // Keyboard-only open: Enter opens the Add repository dialog.
  await opener.focus()
  await page.keyboard.press('Enter')
  const path = page.getByRole('textbox', { name: 'Folder path to authorize' })
  await expect(path).toBeVisible()

  // 3.3.1: a refused authorization announces its error (role=alert).
  await path.fill('/etc/disallowed')
  await page.keyboard.press('Enter')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('/etc/disallowed is not authorized for import')

  // A valid path authorizes, lists the root, and scans it.
  await path.fill('/srv/checkout')
  await page.keyboard.press('Enter')
  await expect(alert).toBeHidden()

  // 3.3.2: every control carries a programmatic label.
  for (const labelText of ['Folder path to authorize', 'Authorized root to scan']) {
    expect(
      (await page.getByRole('combobox', { name: labelText, includeHidden: true }).count()) +
        (await page.getByRole('textbox', { name: labelText }).count())
    ).toBeGreaterThan(0)
  }

  // Scan, confirm, and import complete without a pointer.
  await page
    .getByRole('combobox', { name: 'Authorized root to scan', includeHidden: true })
    .selectOption('authorized')
  const confirm = page.getByRole('checkbox', { name: /Fixture project/ })
  await expect(confirm).toBeVisible()
  await confirm.focus()
  await page.keyboard.press('Space')
  await expect(confirm).toBeChecked()
  await page.getByRole('button', { name: 'Import confirmed packages' }).click()
  await expect(page.getByTestId('announcement')).toHaveText('Imported 1 project.')
})

test('cert semantics: surfaces expose structured aria snapshots', async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page)

  // The shared workspace tree (ADR 0011): project rows at level 1 with
  // their checkout and worktree rows at level 2. Leaf names are the status
  // and branch tokens (the 4.1.2 certification), asserted as full names —
  // the fixture data is deterministic. The tree's own name carries the
  // workspace name, which the E2E database owns.
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' }).getByRole('tree'))
    .toMatchAriaSnapshot(`
    - tree /projects$/:
      - treeitem "Example project" [expanded] [level=1]
      - treeitem "main" [level=2]
      - treeitem "Running feature/example" [level=2] [selected]
      - treeitem "Runtime tools" [expanded] [level=1]
      - treeitem "feature/runtime Needs you" [level=2]
      - treeitem "Idle docs/runtime-notes" [level=2]
  `)

  // The right utility rail keeps its labelled navigation and pane regions.
  // aria-current is asserted separately: the snapshot grammar in this
  // Playwright build has no [current] token.
  await page.getByRole('button', { name: 'Expand utility sidebar' }).click()
  const rightUtilities = page.getByRole('complementary', { name: 'Shared developer utilities' })
  await expect(rightUtilities).toMatchAriaSnapshot(`
    - complementary "Shared developer utilities":
      - navigation "Right utility panes":
        - button "Browser"
        - button "Devices"
        - button "Agents"
        - button "History"
      - region "Browser":
        - heading "Browser" [level=2]
  `)
  await expect(rightUtilities.getByRole('button', { name: 'Browser' })).toHaveAttribute(
    'aria-current',
    /true|page/
  )
})

test('cert 1.3.1/2.1.1: splitter geometry and pane regions are exposed and operable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openDevView(page)

  await expect(page.getByRole('region', { name: 'terminal pane' })).toBeVisible()
  await page.getByRole('button', { name: 'Split pane', exact: true }).click()
  await expect(page.getByRole('region', { name: 'terminal pane' })).toHaveCount(2)

  const separator = page.getByRole('separator', { name: 'Resize workspace panes' })
  await expect(separator).toHaveAttribute('aria-valuemin', '10')
  await expect(separator).toHaveAttribute('aria-valuemax', '90')
  await separator.focus()
  await page.keyboard.press('ArrowRight')
  const valueAfter = Number(await separator.getAttribute('aria-valuenow'))
  expect(valueAfter).toBeGreaterThan(50)
  expect(valueAfter).toBeLessThanOrEqual(90)
  await expect(separator).toBeFocused()

  // The pane-move chord keeps focus on the moved pane (existing contract).
  // The move re-orders the panes in the DOM, so the assertion must follow the
  // moved pane by its own id, not by DOM order.
  const movedPane = page.locator('[data-pane-id]').first()
  await movedPane.click()
  const movedPaneId = await movedPane.getAttribute('data-pane-id')
  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight')
  await expect(page.locator(`[data-pane-id="${movedPaneId}"]`)).toBeFocused()
})
