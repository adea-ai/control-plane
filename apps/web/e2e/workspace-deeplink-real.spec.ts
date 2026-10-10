// Real-backend regression for `?workspace=<owned id>` deep links (Home receipt 1725).
// No request is mocked. Before the one-switch guard, a link re-ran its switch after every
// settle: the page kept writing the same URL, starved its own network responses, and never
// reached the shell. The selected workspace is asserted through the shell's document title,
// which the shell derives from the active workspace (`<name> | Adea`).
import { expect, test, type BrowserContext } from '@playwright/test'

/** Counts history writes from the first paint, so a re-switch loop is visible. */
const countHistoryWrites = () => {
  let writes = 0
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = History.prototype[method]
    History.prototype[method] = function (
      this: History,
      state: unknown,
      unused: string,
      url?: string | URL | null
    ) {
      writes += 1
      ;(window as unknown as { historyWriteCount: number }).historyWriteCount = writes
      return original.call(this, state, unused, url)
    }
  }
}

/** Mints the temporary session and creates a workspace through the app's own routes. */
async function createTarget(context: BrowserContext): Promise<string> {
  const bootstrap = await context.request.post('/api/workspaces/bootstrap')
  expect(bootstrap.ok()).toBe(true)
  const created = await context.request.post('/api/workspaces', {
    data: { name: 'Deep link target', scene: 'work' },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  })
  expect(created.ok(), `create workspace: ${created.status()}`).toBe(true)
  const body = (await created.json()) as { workspace?: { id: string }; id?: string }
  const targetId = body.workspace?.id ?? body.id
  expect(targetId).toBeTruthy()
  return targetId!
}

const targetTitle = 'Deep link target | Adea'

test('a ?workspace= link selects the target, and a later revisit by ID selects it again', async ({
  page,
}) => {
  await page.addInitScript(countHistoryWrites)
  const targetId = await createTarget(page.context())

  // First visit: the link selects the target and is consumed.
  await page.goto(`/?workspace=${encodeURIComponent(targetId)}`, { timeout: 120_000 })
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible({
    timeout: 120_000,
  })
  await expect(page).toHaveTitle(targetTitle, { timeout: 60_000 })
  await expect
    .poll(() => new URL(page.url()).searchParams.has('workspace'), { timeout: 30_000 })
    .toBe(false)
  await page.waitForTimeout(1_000)
  const firstWrites = await page.evaluate(
    () => (window as unknown as { historyWriteCount?: number }).historyWriteCount ?? 0
  )
  expect(firstWrites, 'history writes after the first link').toBeLessThanOrEqual(10)

  // Navigate away to the default entry, then come back with the same workspace ID.
  await page.goto('/', { timeout: 120_000 })
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible({
    timeout: 120_000,
  })
  await page.goto(`/?workspace=${encodeURIComponent(targetId)}`, { timeout: 120_000 })
  await expect(page).toHaveTitle(targetTitle, { timeout: 60_000 })
  await expect
    .poll(() => new URL(page.url()).searchParams.has('workspace'), { timeout: 30_000 })
    .toBe(false)
})

test('a scoped channel link keeps its workspace guard until the channel is applied', async ({
  page,
}) => {
  const context = page.context()
  const targetId = await createTarget(context)
  // The target's own channel list: the scoped destination must be applied from it.
  // A fresh workspace has no channel yet: create one through the app's own route.
  const createdChannel = await context.request.post(`/api/v1/workspaces/${targetId}/channels`, {
    data: { kind: 'group', title: 'Deep link channel' },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  })
  expect(createdChannel.ok(), `create channel: ${createdChannel.status()}`).toBe(true)
  const channelBody = (await createdChannel.json()) as { channel?: { id: string }; id?: string }
  const channelId = channelBody.channel?.id ?? channelBody.id
  expect(channelId, 'the created channel has an id').toBeTruthy()

  const channelSelected = page.waitForRequest((request) =>
    request.url().includes(`/channels/${channelId!}/messages`)
  )
  await page.goto(
    `/?workspace=${encodeURIComponent(targetId)}&channel=${encodeURIComponent(channelId!)}`,
    {
      timeout: 120_000,
    }
  )
  await expect(page).toHaveTitle(targetTitle, { timeout: 60_000 })
  // The destination is applied from the target, then the whole link is consumed.
  await channelSelected
  await expect
    .poll(
      () =>
        new URL(page.url()).searchParams.has('workspace') ||
        new URL(page.url()).searchParams.has('channel'),
      {
        timeout: 30_000,
      }
    )
    .toBe(false)
})
