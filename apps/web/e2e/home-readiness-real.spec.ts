// Real-backend Home readiness journey (#1214). No request is mocked: `page.route` is
// never used. The browser runs the production shell against the dev server, which
// talks to the owned, disposable Postgres named by DATABASE_URL. Browser sessions
// are the app's own temporary sessions, minted by the bootstrap route.
//
// The Control Plane is not reachable from this lane. Model inventory, profile
// approval and funding are therefore reported as the app really renders them when
// the binding is missing: unknown or setup-blocked, never ready, and no model runs.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { and, eq } from 'drizzle-orm'

import { createDatabase, type DatabaseConnection } from '../../../packages/db/src/connection'
import {
  agents,
  leadTurnIntents,
  messages,
  taskSubmissions,
  workspaces,
} from '../../../packages/db/src/schema'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the Home real-backend journey; it never skips')
}

type Bootstrap = {
  activeWorkspace: { id: string; name: string; isPersonal?: boolean } | null
  workspaces: { id: string; name: string; isPersonal?: boolean }[]
}

let connection: DatabaseConnection
test.beforeAll(async ({ browser }) => {
  connection = createDatabase(databaseUrl!)
  // A cold dev server re-optimizes its dependencies on the first page loads; one warm-up walk
  // through the Home shell runs before the proofs, so the first proof is not the cold one.
  const context = await browser.newContext()
  const page = await context.newPage()
  await openHome(page)
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible({
    timeout: 120_000,
  })
  await context.close()
})
test.afterAll(async () => {
  await connection.close()
})

/** A fresh browser context: no cookies, so the first bootstrap mints the temporary session. */
async function freshContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext()
}

/** Opens the root shell and returns the bootstrap the page received. */
async function openHome(page: Page): Promise<Bootstrap> {
  const bootstrapped = page.waitForResponse(
    (candidate) => candidate.url().includes('/api/workspaces/bootstrap'),
    { timeout: 60_000 }
  )
  await page.goto('/')
  return (await (await bootstrapped).json()) as Bootstrap
}

/** The lead rows of one workspace, read from the database. */
async function leadsIn(workspaceId: string) {
  return connection.db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.isWorkspaceLead, true)))
}

/** Rows that model inference or execution would create, counted for one workspace. */
async function executionFootprint(workspaceId: string) {
  const [intents, submissions, chat] = await Promise.all([
    connection.db
      .select({ id: leadTurnIntents.id })
      .from(leadTurnIntents)
      .where(eq(leadTurnIntents.workspaceId, workspaceId)),
    connection.db
      .select({ id: taskSubmissions.id })
      .from(taskSubmissions)
      .where(eq(taskSubmissions.workspaceId, workspaceId)),
    connection.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.workspaceId, workspaceId)),
  ])
  return { intents: intents.length, messages: chat.length, submissions: submissions.length }
}

/** Requests the page sent after `reset()`, recorded without interfering with them. */
function recordRequests(page: Page) {
  const seen: { body: string | null; method: string; url: string }[] = []
  page.on('request', (request) =>
    seen.push({ body: request.postData(), method: request.method(), url: request.url() })
  )
  return {
    seen,
    reset: () => {
      seen.length = 0
    },
  }
}

/** The POSTs a browse may send: the session bootstrap, and read-only model metadata. */
function isBrowseRead(entry: { body: string | null; url: string }): boolean {
  const path = new URL(entry.url).pathname
  if (path === '/api/workspaces/bootstrap') return true
  if (!/^\/api\/workspaces\/[^/]+\/model-connections$/.test(path)) return false
  try {
    const action = (JSON.parse(entry.body ?? 'null') as { action?: unknown }).action
    return action === 'list' || action === 'defaults.get'
  } catch {
    return false
  }
}

const EXECUTION_PATH =
  /\/(lead-turn|lead-turns|submission|commands\/pull|prepare|progress)(\/|$|\?)/

test('Home bootstraps, provisions its lead once, and the server refuses to delete it', async ({
  browser,
}, testInfo) => {
  const context = await freshContext(browser)
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const requests = recordRequests(page)

  const boot = await openHome(page)
  const home = boot.activeWorkspace!
  expect(home.isPersonal).toBe(true)

  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible({
    timeout: 60_000,
  })

  // Agents entry: the structural lead is provisioned because none exists.
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  const status = page.locator('#workspace-main').getByTestId('lead-setup-state')
  await expect(status).toHaveAttribute('data-state', 'unconfigured', { timeout: 60_000 })
  await expect(page.getByRole('heading', { name: 'Workspace lead', exact: true })).toBeVisible()
  const leads = await leadsIn(home.id)
  expect(leads).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath('home-lead-provisioned.png') })

  // Reload and re-enter: the same lead is read back, and no second provisioning write is sent.
  requests.reset()
  await page.reload()
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await expect(status).toHaveAttribute('data-state', 'unconfigured', { timeout: 60_000 })
  expect(
    requests.seen.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/agents/lead'))
  ).toEqual([])
  expect(await leadsIn(home.id)).toEqual(leads)

  // Home is protected: the server refuses deletion from the page's own origin.
  const refusal = await page.evaluate(async (id) => {
    const response = await fetch(`/api/workspaces/${id}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmationName: 'Home', expectedVersion: 1 }),
    })
    return { status: response.status, body: await response.text() }
  }, home.id)
  testInfo.attach('home-delete-refusal', {
    body: JSON.stringify(refusal),
    contentType: 'application/json',
  })
  expect(refusal.status).toBeGreaterThanOrEqual(400)
  expect(refusal.body).toContain('workspace_personal_protected')
  const [row] = await connection.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, home.id))
  expect(row?.id).toBe(home.id)

  // The settings surface offers no deletion path for Home.
  await page.getByRole('button', { name: `Workspace settings for ${home.name}` }).click()
  const details = page.getByRole('dialog', { name: `${home.name} workspace settings` })
  await expect(details).toBeVisible()
  await expect(details.getByRole('button', { name: 'Delete workspace' })).toHaveCount(0)
  expect(pageErrors).toEqual([])
  await context.close()
})

test('a blank optional workspace gets its own lead and copies nothing from Home', async ({
  browser,
}, testInfo) => {
  const context = await freshContext(browser)
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const boot = await openHome(page)
  const home = boot.activeWorkspace!
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await expect(page.locator('#workspace-main').getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured',
    { timeout: 60_000 }
  )
  const homeLead = (await leadsIn(home.id))[0]!

  // A blank optional workspace, created through the production create route.
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/workspaces', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `blank-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ name: 'Blank optional', scene: 'work' }),
    })
    return {
      status: response.status,
      body: (await response.json()) as { workspace: { id: string } },
    }
  })
  expect(created.status).toBe(201)
  const blankId = created.body.workspace.id
  expect(blankId).not.toBe(home.id)

  // The shell reads its workspace list at load; a reload includes the new workspace, and the
  // contextual sidebar switches to it the way a person does.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible({
    timeout: 60_000,
  })
  await page.getByRole('button', { name: 'Blank optional', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Blank optional', level: 1 })).toBeVisible({
    timeout: 60_000,
  })
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  const status = page.locator('#workspace-main').getByTestId('lead-setup-state')
  await expect(status).toHaveAttribute('data-state', 'unconfigured', { timeout: 60_000 })
  const blankLeads = await leadsIn(blankId)
  expect(blankLeads).toHaveLength(1)
  expect(blankLeads[0]!.id).not.toBe(homeLead.id)
  // Nothing from Home is copied: no Home agent, message, submission or intent exists here.
  const blankAgents = await connection.db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.workspaceId, blankId))
  expect(blankAgents.map((row) => row.id)).toEqual([blankLeads[0]!.id])
  expect(await executionFootprint(blankId)).toEqual({ intents: 0, messages: 0, submissions: 0 })
  await page.screenshot({ path: testInfo.outputPath('blank-lead.png') })
  expect(pageErrors).toEqual([])
  await context.close()
})

test('two entries provision one lead, and a repeated provisioning call returns that same lead', async ({
  browser,
}) => {
  const context = await freshContext(browser)
  const first = await context.newPage()
  const boot = await openHome(first)
  const home = boot.activeWorkspace!

  const second = await context.newPage()
  await Promise.all(
    [first, second].map(async (page) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
    })
  )
  for (const page of [first, second]) {
    await expect(page.locator('#workspace-main').getByTestId('lead-setup-state')).toHaveAttribute(
      'data-state',
      'unconfigured',
      { timeout: 60_000 }
    )
  }
  const [only] = await leadsIn(home.id)
  expect(await leadsIn(home.id)).toHaveLength(1)

  // The protected route is idempotent: a repeated provisioning call returns the same lead.
  const repeated = await first.evaluate(async (id) => {
    const post = async () => {
      const response = await fetch(`/api/v1/workspaces/${id}/agents/lead`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: '{}',
      })
      return { status: response.status, body: (await response.json()) as { lead: { id: string } } }
    }
    return [await post(), await post()]
  }, home.id)
  expect(repeated.map((entry) => entry.status)).toEqual([200, 200])
  expect(new Set(repeated.map((entry) => entry.body.lead.id))).toEqual(new Set([only!.id]))
  expect(await leadsIn(home.id)).toHaveLength(1)
  await context.close()
})

test('browsing makes no model inference or execution request and writes no execution state', async ({
  browser,
}) => {
  const context = await freshContext(browser)
  const page = await context.newPage()
  const requests = recordRequests(page)
  const boot = await openHome(page)
  const home = boot.activeWorkspace!
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await expect(page.locator('#workspace-main').getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured',
    { timeout: 60_000 }
  )
  const before = await executionFootprint(home.id)

  requests.reset()
  // Browse: move through the surfaces a person reads, without sending anything.
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.reload()
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page
    .getByRole('button', { name: `Workspace settings for ${boot.activeWorkspace!.name}` })
    .click()
  await page.getByRole('dialog').first().press('Escape')
  await page.waitForTimeout(1_000)

  // Browse may read model metadata (list and defaults.get are POSTs by contract) and the
  // session bootstrap. Any other write, and any inference or execution path, fails the proof.
  // The browse really sent requests: the proof is not vacuous.
  expect(requests.seen.length).toBeGreaterThan(0)
  const writes = requests.seen.filter(
    (entry) => entry.method !== 'GET' && entry.method !== 'HEAD' && !isBrowseRead(entry)
  )
  expect(writes).toEqual([])
  expect(requests.seen.filter((entry) => EXECUTION_PATH.test(new URL(entry.url).pathname))).toEqual(
    []
  )
  expect(await executionFootprint(home.id)).toEqual(before)
  await context.close()
})

test('a missing Control Plane binding stays unknown and setup-blocked, never ready', async ({
  browser,
}, testInfo) => {
  const context = await freshContext(browser)
  const page = await context.newPage()
  const boot = await openHome(page)
  const home = boot.activeWorkspace!
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  const status = page.locator('#workspace-main').getByTestId('lead-setup-state')
  await expect(status).toHaveAttribute('data-state', 'unconfigured', { timeout: 60_000 })
  // Without an approved profile and a bound execution target, nothing reads as ready.
  await expect(page.locator('#workspace-main').getByText('setup_ready')).toHaveCount(0)
  await expect(status).not.toHaveAttribute('data-state', 'setup_ready')
  await expect(
    page.locator('#workspace-main').getByText(/Unknown: no execution target is bound/)
  ).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: testInfo.outputPath('home-lead-setup-blocked.png') })
  // The model inventory the page reads is what the server really answers, without a binding. The
  // route is a POST carrying the read action; a read that cannot reach the Control Plane is not
  // availability.
  const inventory = await page.evaluate(async (id) => {
    const response = await fetch(`/api/workspaces/${id}/model-connections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list', input: {} }),
    })
    return { status: response.status, body: await response.text() }
  }, home.id)
  testInfo.attach('model-inventory', {
    body: JSON.stringify(inventory),
    contentType: 'application/json',
  })
  expect(inventory.status).toBe(200)
  const availability = (JSON.parse(inventory.body) as { availability?: unknown }).availability
  expect(availability).toEqual(expect.any(String))
  expect(availability).toBe('unavailable')
  expect((JSON.parse(inventory.body) as { target: unknown }).target).toBeNull()
  await context.close()
})
