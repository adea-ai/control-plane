import { expect, test, type Page } from '@playwright/test'

import {
  WORKSPACE_LEAD_SETUP_HARNESS_PATH,
  workspaceLeadSetupHarnessHtml,
  workspaceLeadSetupHarnessModuleSource,
} from './helpers/workspace-lead-setup-harness'

async function mount(page: Page) {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**' + WORKSPACE_LEAD_SETUP_HARNESS_PATH, (route) =>
    route.fulfill({ contentType: 'text/html', body: workspaceLeadSetupHarnessHtml() })
  )
  await page.goto(WORKSPACE_LEAD_SETUP_HARNESS_PATH)
  await page.addScriptTag({ type: 'module', content: workspaceLeadSetupHarnessModuleSource() })
  await expect(page.getByLabel('Workspace lead').getByRole('status').first()).toBeVisible({
    timeout: 30_000,
  })
  return pageErrors
}

const leadState = (page: Page) => page.getByTestId('lead-setup-state')

test('returning entry provisions the structural lead once, and re-entry does not write again', async ({
  page,
}) => {
  const errors = await mount(page)
  await page.evaluate(() => window.leadHarness.select('ws-a'))
  await expect(leadState(page)).toHaveAttribute('data-state', 'unconfigured', { timeout: 30_000 })
  await expect(leadState(page)).toContainText('Choose an approved profile')

  await page.evaluate(() => window.leadHarness.select('ws-b'))
  await expect(leadState(page)).toHaveAttribute('data-state', 'setup_ready')
  await page.evaluate(() => window.leadHarness.select('ws-a'))
  await expect(leadState(page)).toHaveAttribute('data-state', 'unconfigured')

  expect(await page.evaluate(() => window.leadHarness.report())).toMatchObject({
    selected: 'ws-a',
    writes: ['ws-a'],
  })
  expect(errors).toEqual([])
})

test('direct session startup stays independent of lead funding that is blocked', async ({
  page,
}) => {
  const errors = await mount(page)
  await page.evaluate(() => window.leadHarness.select('ws-c'))
  await expect(leadState(page)).toHaveAttribute('data-state', 'funding_blocked')

  await page.getByLabel('Your first message').fill('start a direct session')
  await page.getByRole('button', { name: 'Start conversation' }).click()
  await expect.poll(() => page.evaluate(() => window.leadHarness.report().conversations)).toBe(1)
  // The direct start leaves lead setup untouched and never writes a lead.
  await expect(leadState(page)).toHaveAttribute('data-state', 'funding_blocked')
  expect(await page.evaluate(() => window.leadHarness.report().writes)).toEqual([])
  expect(errors).toEqual([])
})

test('a switch while the lead write is parked cannot apply the result to the new workspace', async ({
  page,
}) => {
  const errors = await mount(page)
  await page.evaluate(() => {
    window.leadHarness.hold('ws-a', 'POST')
    window.leadHarness.select('ws-a')
  })
  await expect.poll(() => page.evaluate(() => window.leadHarness.report().parked)).toBe(1)

  await page.evaluate(() => window.leadHarness.select('ws-b'))
  await expect(leadState(page)).toHaveAttribute('data-state', 'setup_ready')

  await page.evaluate(() => window.leadHarness.release())
  // The parked write completes server-side for ws-a, but the UI stays on ws-b.
  await expect.poll(() => page.evaluate(() => window.leadHarness.report().writes)).toEqual(['ws-a'])
  await expect(leadState(page)).toHaveAttribute('data-state', 'setup_ready')
  await expect(leadState(page)).not.toContainText('Choose an approved profile')
  expect(errors).toEqual([])
})

test('a switch while the lead read is parked never issues a write for the old workspace', async ({
  page,
}) => {
  const errors = await mount(page)
  await page.evaluate(() => {
    window.leadHarness.hold('ws-a', 'GET')
    window.leadHarness.select('ws-a')
  })
  await expect.poll(() => page.evaluate(() => window.leadHarness.report().parked)).toBe(1)

  await page.evaluate(() => window.leadHarness.select('ws-b'))
  await expect(leadState(page)).toHaveAttribute('data-state', 'setup_ready')

  await page.evaluate(() => window.leadHarness.release())
  await expect(leadState(page)).toHaveAttribute('data-state', 'setup_ready')
  expect(await page.evaluate(() => window.leadHarness.report().writes)).toEqual([])
  expect(errors).toEqual([])
})

test('an expired session offers the existing sign-in action and never provisions', async ({
  page,
}) => {
  const errors = await mount(page)
  await page.evaluate(() => window.leadHarness.select('ws-d'))
  await expect(leadState(page)).toHaveAttribute('data-state', 'auth_required')
  await page.getByRole('button', { name: 'Sign in' }).click()
  expect(await page.evaluate(() => window.leadHarness.report().signIns)).toBe(1)
  expect(await page.evaluate(() => window.leadHarness.report().writes)).toEqual([])
  expect(errors).toEqual([])
})

test('a failed provisioning shows a retryable error, then retry provisions the lead', async ({
  page,
}) => {
  const errors = await mount(page)
  await page.evaluate(() => window.leadHarness.select('ws-e'))
  await expect(leadState(page)).toHaveAttribute('data-state', 'provisioning_failed')
  await expect(leadState(page)).not.toContainText('ready')

  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(leadState(page)).toHaveAttribute('data-state', 'unconfigured')
  expect(await page.evaluate(() => window.leadHarness.report().writes)).toEqual(['ws-e', 'ws-e'])
  expect(errors).toEqual([])
})

test('a member without manage rights sees the lead as not set up and no write is attempted', async ({
  page,
}) => {
  const errors = await mount(page)
  await page.evaluate(() => window.leadHarness.select('ws-f'))
  await expect(leadState(page)).toHaveAttribute('data-state', 'not_permitted')
  await expect(leadState(page)).toContainText('A workspace admin can set one up')
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  expect(await page.evaluate(() => window.leadHarness.report().writes)).toEqual([])
  expect(errors).toEqual([])
})

test('a lead write that completes after the status closes is persisted once and not duplicated on reopen', async ({
  page,
}) => {
  const errors = await mount(page)
  await page.evaluate(() => {
    window.leadHarness.hold('ws-a', 'POST')
    window.leadHarness.select('ws-a')
  })
  await expect.poll(() => page.evaluate(() => window.leadHarness.report().parked)).toBe(1)

  // The delayed write is in flight when the settings surface closes.
  await page.evaluate(() => window.leadHarness.unmount())
  await expect(leadState(page)).toHaveCount(0)
  await page.evaluate(() => window.leadHarness.release())
  await expect.poll(() => page.evaluate(() => window.leadHarness.report().writes)).toEqual(['ws-a'])

  // Reopening reads the persisted lead and does not write again.
  await page.evaluate(() => window.leadHarness.remount())
  await expect(leadState(page)).toHaveAttribute('data-state', 'unconfigured')
  expect(await page.evaluate(() => window.leadHarness.report().writes)).toEqual(['ws-a'])
  expect(errors).toEqual([])
})

test('a saved change elsewhere reloads a mounted lead status for the same workspace', async ({
  page,
}) => {
  const errors = await mount(page)
  await page.evaluate(() => window.leadHarness.select('ws-b'))
  await expect(leadState(page)).toHaveAttribute('data-state', 'setup_ready')
  const before = await page.evaluate(() => window.leadHarness.report().leadReads)

  await page.evaluate(() => window.leadHarness.bump())
  await expect
    .poll(() => page.evaluate(() => window.leadHarness.report().leadReads))
    .toBe(before + 1)
  await expect(leadState(page)).toHaveAttribute('data-state', 'setup_ready')
  expect(errors).toEqual([])
})
