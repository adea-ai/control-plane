// Direct first-run onboarding through the production DesktopFirstRunChat.
// Lead configuration never gates direct sessions: the lead route is broken in
// this harness and must never be called from the direct path.
import { expect, test, type Page } from '@playwright/test'

import {
  DESKTOP_FIRST_RUN_ENTRY_HARNESS_PATH,
  desktopFirstRunEntryHarnessHtml,
  desktopFirstRunEntryHarnessModuleSource,
} from './helpers/desktop-first-run-entry-harness'

async function mount(page: Page, pi: 'ready' | 'absent') {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript((value) => {
    ;(window as unknown as { adeaFirstRunPi: string }).adeaFirstRunPi = value
  }, pi)
  await page.route('**' + DESKTOP_FIRST_RUN_ENTRY_HARNESS_PATH, (route) =>
    route.fulfill({ contentType: 'text/html', body: desktopFirstRunEntryHarnessHtml() })
  )
  await page.goto(DESKTOP_FIRST_RUN_ENTRY_HARNESS_PATH)
  await page.addScriptTag({ type: 'module', content: desktopFirstRunEntryHarnessModuleSource() })
  return errors
}

test('direct first-run composer opens while the lead route is broken and never calls it', async ({
  page,
}) => {
  const errors = await mount(page, 'ready')
  await expect(page.getByRole('heading', { name: 'Start a conversation' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByLabel('Your first message').fill('a direct session')
  await expect(page.getByRole('button', { name: 'Start conversation' })).toBeEnabled()
  expect(await page.evaluate(() => window.directFirstRunHarness.report())).toMatchObject({
    leadCalls: 0,
  })
  expect(errors).toEqual([])
})

test('an absent managed agent keeps the existing install gate and never reads lead state', async ({
  page,
}) => {
  const errors = await mount(page, 'absent')
  await expect(page.getByRole('heading', { name: 'Preparing your agent' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: 'Install agent' })).toBeVisible()
  expect(await page.evaluate(() => window.directFirstRunHarness.report())).toMatchObject({
    leadCalls: 0,
  })
  expect(errors).toEqual([])
})
