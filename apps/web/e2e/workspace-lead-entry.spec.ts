// Canonical lead setup through the production shell's Agents entry.
// The shell, controller, API client and roster run in a real browser against a
// mocked workspace API. The lead is provisioned from the Agents entry only when
// none exists, the roster keeps listing its available agent either way, and a
// broken lead route shows a retryable error without hiding direct roster work.
import { expect, test, type Page, type Route } from '@playwright/test'

const timestamp = '2026-08-30T12:00:00.000Z'
const workspace = {
  accent: null,
  id: 'workspace-e2e',
  logo: { kind: 'monogram' as const },
  name: 'Work',
  scene: 'work',
  sortOrder: 0,
  updatedAt: timestamp,
  version: 1,
}
const homeWorkspace = {
  accent: null,
  id: 'workspace-home-e2e',
  logo: { kind: 'home' as const },
  name: 'Home',
  scene: 'home',
  sortOrder: 1,
  updatedAt: timestamp,
  version: 1,
}
const researchAgent = {
  createdAt: timestamp,
  id: 'agent-research',
  lifecycleState: 'active',
  name: 'Research Agent',
  presentationMetadata: {},
  profile: { id: 'profile-research', state: 'available', version: '1' },
  projectId: null,
  revision: 0,
  roleSummary: 'Finds sources',
  updatedAt: timestamp,
  workspaceId: workspace.id,
}
const connectionRef = `mconn_${'a'.repeat(32)}`
const readyChoice = { connectionRef, providerModel: 'fixture-model' }

type Lead = Record<string, unknown>
type Hold = 'leadPost' | 'defaultsSave'
type MountOptions = {
  canManage?: boolean
  /** A non-member: the lead and model routes refuse the workspace. */
  nonMember?: boolean
  /** Model inventory and defaults are readable (funding is not fail-closed). */
  models?: boolean
  /** The Work lead already exists with an approved profile. */
  availableLead?: boolean
  /** Model inventory is readable but binds no execution target. */
  targetless?: boolean
  /** A lead model is already selected in the workspace defaults. */
  leadModelSelected?: boolean
}
type LeadState = {
  /** Work workspace lead (the primary fixture). */
  lead: Lead | null
  postsFail: number
  posts: number
  gets: number
  /** Home workspace lead. */
  home: { lead: Lead | null; posts: number; gets: number }
  defaults: { revision: number; lead?: typeof readyChoice }
  defaultsRequests: number
  /** Profile saves through the roster's Customize form, and the agent they named. */
  profileSaves: number
  profileSaveAgentId: string | null
  /** Holds the next matching request until the returned function is called. */
  hold(kind: Hold): () => void
}

function leadFor(workspaceId: string, available: boolean): Lead {
  return {
    createdAt: timestamp,
    id: `agent-lead-${workspaceId}`,
    isWorkspaceLead: true,
    lifecycleState: 'active',
    name: 'Workspace lead',
    presentationMetadata: {},
    profile: available
      ? { id: 'lead-profile', state: 'available', version: '2' }
      : { id: 'workspace-lead-unconfigured', state: 'missing', version: 'unconfigured' },
    projectId: null,
    revision: 0,
    roleSummary: 'Coordinates work in this workspace',
    updatedAt: timestamp,
    workspaceId,
  }
}

function readyInventory(canManage: boolean) {
  return {
    availability: 'available',
    canManage,
    target: {
      location: 'remote_host',
      harness: 'pi_durable',
      harnessVersion: '1.0.0',
      providerBinding: 'pi_durable_models',
    },
    connections: [
      {
        connectionRef,
        revision: 1,
        provider: 'fixture-provider',
        accountRef: 'provider-account',
        authKind: 'api_key',
        fundingSource: 'byo_api',
        status: 'active',
        models: [
          {
            providerModel: 'fixture-model',
            readiness: { ready: true, reasonCode: 'READY', remedy: null },
          },
        ],
      },
    ],
  }
}

async function mountShell(page: Page, options: MountOptions = {}): Promise<LeadState> {
  const canManage = options.canManage ?? true
  const holds: Partial<Record<Hold, Promise<void>>> = {}
  const state: LeadState = {
    lead: options.availableLead ? leadFor(workspace.id, true) : null,
    postsFail: 0,
    posts: 0,
    gets: 0,
    home: { lead: leadFor(homeWorkspace.id, true), posts: 0, gets: 0 },
    defaults: { revision: 1, ...(options.leadModelSelected ? { lead: readyChoice } : {}) },
    defaultsRequests: 0,
    profileSaves: 0,
    profileSaveAgentId: null,
    hold(kind) {
      let open!: () => void
      holds[kind] = new Promise<void>((resolve) => {
        open = resolve
      })
      return open
    },
  }
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
        activeWorkspace: workspace,
        principal: { temporary: false, userId: 'user-e2e' },
        workspaces: [workspace, homeWorkspace],
      },
    })
  )
  await page.route('**/api/v1/account/summary', (route) =>
    route.fulfill({ contentType: 'application/json', json: { workspaces: [] } })
  )
  // Model metadata: fail closed unless the scenario makes the inventory readable.
  await page.route('**/api/workspaces/*/model-connections', async (route: Route) => {
    const request = route.request()
    const workspaceId = /\/workspaces\/([^/]+)\//.exec(new URL(request.url()).pathname)?.[1]
    if (options.nonMember || workspaceId !== workspace.id)
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        json: { code: 'workspace_unavailable', message: 'Workspace unavailable' },
      })
    const body = (request.postDataJSON?.() ?? {}) as {
      action?: string
      input?: { lead?: typeof readyChoice; expectedRevision?: number }
    }
    if (body.action === 'list')
      return route.fulfill({
        contentType: 'application/json',
        json: options.models
          ? options.targetless
            ? { ...readyInventory(canManage), target: null }
            : readyInventory(canManage)
          : { availability: 'unavailable', canManage, target: null, connections: [] },
      })
    if (body.action === 'defaults.get' || body.action === 'defaults.set') {
      if (body.action === 'defaults.set') {
        state.defaultsRequests += 1
        if (holds.defaultsSave) await holds.defaultsSave
        state.defaults = {
          revision: state.defaults.revision + 1,
          ...(body.input?.lead
            ? { lead: body.input.lead }
            : state.defaults.lead
              ? { lead: state.defaults.lead }
              : {}),
        }
      }
      return route.fulfill({
        contentType: 'application/json',
        json: options.models
          ? { availability: 'available', canManage, defaults: state.defaults }
          : { availability: 'unavailable', canManage, defaults: null },
      })
    }
    return route.fulfill({ status: 400, contentType: 'application/json', json: {} })
  })
  await page.route('**/api/v1/workspaces/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const profileRoute = /\/workspaces\/workspace-e2e\/agents\/([^/]+)\/profile$/.exec(url.pathname)
    if (profileRoute && method === 'POST') {
      // The roster's Customize save: the named agent's profile becomes approved.
      const body = (request.postDataJSON?.() ?? {}) as { profileId: string; profileVersion: string }
      state.profileSaves += 1
      state.profileSaveAgentId = profileRoute[1]!
      if (state.lead && state.lead.id === profileRoute[1]) {
        const revision = Number(state.lead.revision ?? 0) + 1
        state.lead = {
          ...state.lead,
          profile: {
            id: body.profileId,
            revision,
            state: 'available',
            version: body.profileVersion,
          },
          revision,
          // The server advances updatedAt with the profile, so the roster row refreshes.
          updatedAt: '2026-08-30T12:01:00.000Z',
        }
      }
      return route.fulfill({
        contentType: 'application/json',
        json: { agent: state.lead },
      })
    }
    const leadRoute = /\/workspaces\/([^/]+)\/agents\/lead$/.exec(url.pathname)
    if (leadRoute) {
      const workspaceId = leadRoute[1]
      if (workspaceId === homeWorkspace.id) {
        if (method === 'GET') {
          state.home.gets += 1
          return route.fulfill({ contentType: 'application/json', json: { lead: state.home.lead } })
        }
        state.home.posts += 1
        state.home.lead ??= leadFor(homeWorkspace.id, false)
        return route.fulfill({ contentType: 'application/json', json: { lead: state.home.lead } })
      }
      if (method === 'GET') {
        state.gets += 1
        if (options.nonMember)
          return route.fulfill({
            status: 404,
            contentType: 'application/json',
            json: { code: 'workspace_unavailable', message: 'Workspace unavailable' },
          })
        return route.fulfill({ contentType: 'application/json', json: { lead: state.lead } })
      }
      state.posts += 1
      if (options.nonMember)
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          json: { code: 'workspace_unavailable', message: 'Workspace unavailable' },
        })
      if (holds.leadPost) await holds.leadPost
      if (state.postsFail > 0) {
        state.postsFail -= 1
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          json: { code: 'workspace_unavailable', message: 'Workspace unavailable' },
        })
      }
      state.lead ??= leadFor(workspace.id, false)
      return route.fulfill({ contentType: 'application/json', json: { lead: state.lead } })
    }
    if (method !== 'GET') return route.fulfill({ contentType: 'application/json', json: {} })
    if (url.pathname.endsWith('/agents'))
      // The roster lists every agent row, the workspace lead included.
      return route.fulfill({
        contentType: 'application/json',
        json: [researchAgent, ...(state.lead ? [state.lead] : [])],
      })
    if (url.pathname.endsWith('/projects') || url.pathname.endsWith('/tasks'))
      return route.fulfill({ contentType: 'application/json', json: [] })
    if (url.pathname.includes('/read-state'))
      return route.fulfill({ contentType: 'application/json', json: { readState: [] } })
    if (
      url.pathname.endsWith('/channels') ||
      url.pathname.endsWith('/artifacts') ||
      url.pathname.endsWith('/members') ||
      url.pathname.endsWith('/messages')
    )
      return route.fulfill({ contentType: 'application/json', json: [] })
    return route.fulfill({ contentType: 'application/json', json: {} })
  })
  await page.goto('/')
  return state
}

const leadStatus = (page: Page) => page.getByRole('region', { name: 'Workspace lead' })
const workspaceNav = (page: Page) => page.getByRole('navigation', { name: 'Workspaces' })

async function openAgents(page: Page) {
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
}

test('the Agents entry provisions the structural lead once and keeps the roster usable', async ({
  page,
}) => {
  const state = await mountShell(page)
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured',
    { timeout: 30_000 }
  )
  // The available roster agent is not the lead: setup never reads as ready.
  await expect(leadStatus(page)).not.toContainText('ready')
  await expect(page.getByText('Research Agent').first()).toBeVisible()
  expect(state.posts).toBe(1)
})

test('re-entering Agents after a reload does not provision the lead again', async ({ page }) => {
  const state = await mountShell(page)
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured',
    { timeout: 30_000 }
  )
  await page.reload()
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured',
    { timeout: 30_000 }
  )
  expect(state.posts).toBe(1)
  expect(state.gets).toBeGreaterThanOrEqual(2)
})

test('a failed lead provisioning shows a retryable error while the roster stays usable', async ({
  page,
}) => {
  const state = await mountShell(page)
  state.postsFail = 1
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'provisioning_failed',
    { timeout: 30_000 }
  )
  await expect(page.getByText('Research Agent').first()).toBeVisible()
  await leadStatus(page).getByRole('button', { name: 'Try again' }).click()
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured'
  )
  expect(state.posts).toBe(2)
})

test('a member without manage rights sees the lead as not set up and the roster stays usable', async ({
  page,
}) => {
  const state = await mountShell(page, { canManage: false })
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'not_permitted',
    { timeout: 30_000 }
  )
  await expect(leadStatus(page).getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await expect(page.getByText('Research Agent').first()).toBeVisible()
  expect(state.posts).toBe(0)
})

test('a non-member lead read is unavailable, never provisions, and offers no success state', async ({
  page,
}) => {
  const state = await mountShell(page, { nonMember: true })
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unavailable',
    { timeout: 30_000 }
  )
  await expect(leadStatus(page)).toContainText('could not be read')
  await expect(leadStatus(page)).not.toContainText('ready')
  expect(state.posts).toBe(0)
  expect(state.gets).toBeGreaterThanOrEqual(1)
})

test('a workspace switch while the lead write is parked never applies it to the new workspace', async ({
  page,
}) => {
  const state = await mountShell(page)
  const releaseWrite = state.hold('leadPost')
  await openAgents(page)
  // The provisioning write for Work is in flight, parked on the route.
  await expect.poll(() => state.posts).toBe(1)

  await workspaceNav(page)
    .getByRole('button', { name: /^Home( |$)/ })
    .click()
  await expect(page.getByRole('heading', { name: 'Home', level: 3 })).toBeVisible()
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'funding_blocked',
    { timeout: 30_000 }
  )

  releaseWrite()
  // The Work write completes server-side, but Home's status must stay Home's own.
  await expect.poll(() => state.lead).not.toBeNull()
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'funding_blocked'
  )
  // Home already has its lead (approved profile, no eligible model): the switch must not provision there, and Work's result must not show here.
  expect(state.home.posts).toBe(0)
  expect(state.posts).toBe(1)
})

test('a delayed defaults save that completes after settings close still updates the Agents lead status', async ({
  page,
}) => {
  const state = await mountShell(page, { availableLead: true, models: true })
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'funding_blocked',
    { timeout: 30_000 }
  )

  const releaseSave = state.hold('defaultsSave')
  await page.getByRole('button', { name: 'Workspace settings for Work' }).click()
  const details = page.getByRole('dialog', { name: 'Work workspace settings' })
  await expect(details).toBeVisible()
  await details.getByRole('tab', { name: 'Connections', exact: true }).click()
  await expect(details.getByRole('heading', { name: 'Agent models' })).toBeVisible()
  await details.getByRole('button', { name: 'Use for workspace lead', exact: true }).click()
  await expect.poll(() => state.defaultsRequests).toBe(1)

  // The settings surface closes while the save is still in flight.
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
  releaseSave()

  await expect(page.locator('#workspace-main').getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'setup_ready',
    { timeout: 30_000 }
  )
  // Reopening shows the persisted default, with no second save.
  await page.getByRole('button', { name: 'Workspace settings for Work' }).click()
  await expect(details).toBeVisible()
  await details.getByRole('tab', { name: 'Connections', exact: true }).click()
  await expect(details.getByText('Selected', { exact: true })).toBeVisible()
  expect(state.defaultsRequests).toBe(1)
})

test('refreshing agent models in workspace settings reloads the Agents lead status behind it', async ({
  page,
}) => {
  const state = await mountShell(page)
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured',
    { timeout: 30_000 }
  )

  await page.getByRole('button', { name: 'Workspace settings for Work' }).click()
  const details = page.getByRole('dialog', { name: 'Work workspace settings' })
  await expect(details).toBeVisible()
  await details.getByRole('tab', { name: 'Connections', exact: true }).click()
  await expect(details.getByRole('heading', { name: 'Agent models' })).toBeVisible()
  // Both lead statuses (the pane's and the Agents surface's) have settled.
  await expect(details.getByTestId('lead-setup-state')).toBeVisible()
  const before = state.gets

  await details.getByRole('button', { name: 'Refresh models', exact: true }).click()
  await expect.poll(() => state.gets).toBeGreaterThan(before)
  await expect(page.locator('#workspace-main').getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured'
  )
  expect(state.posts).toBe(1)
})

test('the lead status sits inside the roster padding, under the header', async ({ page }) => {
  await mountShell(page)
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toBeVisible({ timeout: 30_000 })
  const directory = await page.locator('section.conventional-directory').boundingBox()
  const header = await page.locator('.conventional-surface-header').boundingBox()
  const status = await leadStatus(page).boundingBox()
  expect(directory).not.toBeNull()
  expect(header).not.toBeNull()
  expect(status).not.toBeNull()
  // Inside the directory's left padding, and below the header rather than flush to the top.
  expect(status!.x).toBeGreaterThanOrEqual(directory!.x + 16)
  expect(status!.y).toBeGreaterThanOrEqual(header!.y + header!.height)
})

test('an auto-provisioned lead reaches Customize, and its profile save updates the mounted status without a reload', async ({
  page,
}) => {
  const state = await mountShell(page)
  await openAgents(page)
  await expect(leadStatus(page).getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'unconfigured',
    { timeout: 30_000 }
  )
  expect(state.posts).toBe(1)
  // The provisioned lead is a roster row, so Customize reaches the same agent.
  const leadCard = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Workspace lead', exact: true }) })
  await expect(leadCard).toBeVisible()

  // Same-document marker: a reload would clear it.
  await page.evaluate(() => {
    ;(window as unknown as { journeyDocument: string }).journeyDocument = 'same'
  })
  await leadCard.getByRole('button', { name: 'Customize', exact: true }).click()
  const form = page.locator('form.conventional-agent-customization')
  await form.getByLabel('Profile ID').fill('prf_lead_approved')
  await form.getByLabel('Profile version ID').fill('pfv_lead_v1')
  await form.getByRole('button', { name: 'Save changes' }).click()

  // The roster refetch and the status both settle on the saved profile.
  await expect.poll(() => state.profileSaves).toBe(1)
  expect(state.profileSaveAgentId).toBe(state.lead?.id)
  await expect(page.locator('#workspace-main').getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'funding_blocked',
    { timeout: 30_000 }
  )
  await expect(page.getByText('prf_lead_approved').first()).toBeVisible()
  // Setup stayed idempotent and the document was never reloaded.
  expect(state.posts).toBe(1)
  expect(
    await page.evaluate(() => (window as unknown as { journeyDocument?: string }).journeyDocument)
  ).toBe('same')
})

test('a bound execution target is shown as placement, alongside the lead audience', async ({
  page,
}) => {
  await mountShell(page, { models: true })
  await openAgents(page)
  const main = page.locator('#workspace-main')
  await expect(main.getByTestId('lead-setup-state')).toHaveAttribute('data-state', 'unconfigured', {
    timeout: 30_000,
  })
  await expect(main.getByTestId('lead-placement')).toHaveAttribute('data-state', 'bound')
  await expect(main.getByTestId('lead-placement')).toHaveText('Remote host · Pi durable')
  await expect(main.getByTestId('lead-audience')).toContainText('Visible to workspace members')
})

test('a selected lead model with no bound execution target never infers placement and stays fail-closed', async ({
  page,
}) => {
  const state = await mountShell(page, {
    availableLead: true,
    models: true,
    targetless: true,
    leadModelSelected: true,
  })
  await openAgents(page)
  const main = page.locator('#workspace-main')
  await expect(main.getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'funding_blocked',
    {
      timeout: 30_000,
    }
  )
  await expect(main.getByTestId('lead-placement')).toHaveAttribute('data-state', 'unknown')
  await expect(main.getByTestId('lead-placement')).toContainText(
    'Placement is not inferred from model selection'
  )
  expect(state.posts).toBe(0)
})

test('without a model inventory the lead shows unknown placement and no inferred audience', async ({
  page,
}) => {
  await mountShell(page, { availableLead: true })
  await openAgents(page)
  const main = page.locator('#workspace-main')
  await expect(main.getByTestId('lead-setup-state')).toHaveAttribute(
    'data-state',
    'funding_blocked',
    {
      timeout: 30_000,
    }
  )
  await expect(main.getByTestId('lead-placement')).toHaveAttribute('data-state', 'unknown')
  await expect(main.getByTestId('lead-audience')).toContainText('Visible to workspace members')
})
