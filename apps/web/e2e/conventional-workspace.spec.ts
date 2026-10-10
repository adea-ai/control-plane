// Workspace visual and flow gate.
//
// Baselines are committed per platform: `-darwin` snapshots for the
// hardware-backed workstation lane (`bun run test:e2e:visual` on macOS) and
// `-linux` snapshots for the `Workspace visual lane` workflow, which runs
// inside the pinned Playwright container so the rendering stays reproducible.
// A UI change that moves pixels updates both sets with `--update-snapshots`.
// The spec mocks every workspace API response, so no database is needed.
import { createHash } from 'node:crypto'

// The visual helpers install transition suppression for every capture; see
// helpers/visual.ts for the race this closes.
import { expect, test, type Locator, type Page } from './helpers/visual'

import { canonicalThemeCssTokens } from '../../../packages/ui/src/components/canonical-theme-css-data'
import { verifyRegistryArtifacts } from '../../../packages/workspace-ui/src/marketplace-catalog'

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
  id: 'workspace-home-e2e',
  name: 'Home',
  scene: 'home',
  accent: null,
  logo: { kind: 'monogram' as const },
  sortOrder: 0,
  version: 1,
  updatedAt: timestamp,
}
const user = { kind: 'user' as const, userId: 'user-e2e' }

// The contextual sidebar is the shared Workspaces accordion (ADR 0011): the
// active workspace's projects form one tree, and a project's default
// conversation is its first leaf, named after the project.
const workspaceNav = (scope: Page | Locator) =>
  scope.getByRole('navigation', { name: 'Workspaces' })
// Virtual names projects as rooms, so its tree is "<workspace> rooms".
const projectTree = (scope: Page | Locator, workspaceName = 'Work', noun = 'projects') =>
  scope.getByRole('tree', { name: `${workspaceName} ${noun}` })
// A leaf's accessible name leads with its status word, then its label.
const projectConversation = (scope: Page | Locator, name: string) =>
  scope.getByRole('treeitem', {
    name: new RegExp(`^(?:Idle|Running|In review|Needs you) ${name}(?: |$)`),
    level: 2,
  })
const createProjectButton = (scope: Page | Locator, workspaceName = 'Work') =>
  scope.getByRole('button', { name: `New project in ${workspaceName}`, exact: true })
const agentPrincipal = { kind: 'agent' as const, agentId: 'agent-research' }

const marketplacePluginSpecs = [
  ['gmail', 'Gmail', 'productivity', 'connector'],
  ['github', 'GitHub', 'developer-tools', 'connector'],
  ['google-drive', 'Google Drive', 'productivity', 'connector'],
  ['google-calendar', 'Google Calendar', 'productivity', 'connector'],
  ['notion', 'Notion', 'productivity', 'connector'],
  ['slack', 'Slack', 'communication', 'connector'],
  ['asana', 'Asana', 'productivity', 'connector'],
  ['trello', 'Trello', 'productivity', 'connector'],
  ['project-summaries', 'Project Summaries', 'productivity', 'skill'],
  ['todoist', 'Todoist', 'productivity', 'connector'],
  ['calendly', 'Calendly', 'productivity', 'connector'],
  ['linear', 'Linear', 'developer-tools', 'connector'],
] as const

function marketplaceCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(marketplaceCanonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${marketplaceCanonicalJson(object[key])}`)
    .join(',')}}`
}

function marketplaceDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(marketplaceCanonicalJson(value)).digest('hex')}`
}

// Token values arrive as `#rrggbb`/`#rgb`; computed colors arrive as
// `rgb(r, g, b)`. Normalize both to an [r, g, b] tuple before comparing — the
// overlay band gate (below) asserts a computed paint equals its token.
function parseColor(value: string): number[] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (hex) {
    const digits = hex[1]
    const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits
    return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16))
  }
  return (value.match(/\d+(\.\d+)?/g) ?? []).map(Number).slice(0, 3)
}

function marketplaceFixture() {
  const plugins = marketplacePluginSpecs.map(([name, displayName, category, kind], index) => {
    const token = (index + 1).toString(16).padStart(2, '0').repeat(32)
    const releaseId = `release:${token}`
    const release = {
      capabilities: [
        {
          metadata: {},
          name: displayName,
          paths: [],
          securityImpact: 'low',
          type: kind === 'skill' ? 'skill' : 'connector',
        },
      ],
      canonicalContentDigest: `sha256:${token}`,
      contentResolution: 'complete',
      fileIndex: [],
      pluginSubdirectory: `plugins/${name}`,
      releaseId,
      releaseMetadata: { publishedAt: timestamp },
      requiredConnectors: [],
      requiredCredentials: [],
      resolvedCommitSha: token.slice(0, 40),
      resolvedRepositoryUrl: 'https://github.com/adea-ai/plugins',
    }
    return {
      authors: ['Registry fixture'],
      availableReleases: [release],
      capabilitySummary: { [kind]: 1 },
      categories: [category],
      currentReleaseId: releaseId,
      description: `${displayName} registry fixture.`,
      displayName,
      harnessCompatibility: { codex: { status: 'portable' } },
      icons: [],
      keywords: [name, category],
      license: { name: 'Apache-2.0' },
      pluginId: `plugin:openai-official:${name}`,
      productGroupingKey: name,
      provenance: {
        repositoryUrl: 'https://github.com/openai/plugins',
        resolvedCommitSha: token.slice(0, 40),
      },
      securityClassification: { level: 'standard' },
      sourceId: 'openai-official',
    }
  })
  const body = {
    generatedAt: timestamp,
    plugins,
    schemaVersion: 1,
    sources: [{ repository: 'https://github.com/openai/plugins', sourceId: 'openai-official' }],
  }
  const catalogId = `catalog:${marketplaceDigest(body).slice('sha256:'.length)}`
  const catalog = { ...body, catalogId }
  const catalogText = JSON.stringify(catalog)
  const summaryText = JSON.stringify({
    catalogId,
    generatedAt: timestamp,
    pluginCount: plugins.length,
    schemaVersion: 1,
  })
  const categoriesText = JSON.stringify({
    categories: [...new Set(plugins.flatMap((plugin) => plugin.categories))],
    catalogId,
    schemaVersion: 1,
  })
  const compatibilityText = JSON.stringify({ catalogId, plugins: [], schemaVersion: 1 })
  const lockText = JSON.stringify({ catalogId, schemaVersion: 1, sources: [] })
  const files = {
    'catalog-summary.v1.json': summaryText,
    'catalog.v1.json': catalogText,
    'categories.v1.json': categoriesText,
    'compatibility.v1.json': compatibilityText,
    'sources.lock.json': lockText,
  }
  const integrityFiles = Object.fromEntries(
    Object.entries(files).map(([name, value]) => [name, marketplaceDigest(value)])
  )
  const artifacts = {
    'catalog-latest.v1.json': catalogText,
    'catalog-summary.v1.json': summaryText,
    'catalog.v1.json': catalogText,
    'categories.v1.json': categoriesText,
    'compatibility.v1.json': compatibilityText,
    'integrity.json': JSON.stringify({ catalogId, files: integrityFiles, schemaVersion: 1 }),
    'sources.lock.json': lockText,
  }
  return { artifacts, catalog, catalogId, plugins }
}
const projects = [
  {
    createdAt: timestamp,
    iconKey: 'product',
    id: 'project-product',
    lifecycleState: 'active',
    name: 'Product',
    sortOrder: 0,
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    iconKey: 'support',
    id: 'project-support',
    lifecycleState: 'active',
    name: 'Support',
    sortOrder: 1,
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
]
const workspaceLead = {
  createdAt: timestamp,
  id: 'agent-workspace-lead',
  isWorkspaceLead: true,
  lifecycleState: 'active' as const,
  name: 'Workspace lead',
  presentationMetadata: {},
  profile: { id: 'workspace-lead-unconfigured', state: 'missing', version: 'unconfigured' },
  projectId: null,
  revision: 0,
  roleSummary: 'Coordinates work in this workspace',
  updatedAt: timestamp,
  workspaceId: workspace.id,
}
const agents = [
  {
    createdAt: timestamp,
    id: 'agent-research',
    lifecycleState: 'active',
    name: 'Research Agent',
    presentationMetadata: {},
    profile: { id: 'profile-research', state: 'available', version: '1' },
    roleSummary: 'Customer and market research',
    projectId: 'project-product',
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    id: 'agent-writer',
    lifecycleState: 'active',
    name: 'Writer Agent',
    presentationMetadata: {},
    profile: { id: 'profile-writer', state: 'missing', version: '1' },
    roleSummary: 'Product copy',
    updatedAt: timestamp,
    workspaceId: workspace.id,
  },
]
const channels = [
  {
    createdAt: timestamp,
    id: 'channel-product',
    isPrimaryProjectChannel: true,
    kind: 'project',
    lifecycleState: 'active',
    participants: [user],
    projectId: 'project-product',
    sortOrder: 0,
    title: 'Product',
    updatedAt: timestamp,
    version: 1,
    visibility: 'workspace',
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    id: 'channel-support',
    isPrimaryProjectChannel: true,
    kind: 'project',
    lifecycleState: 'active',
    participants: [user],
    projectId: 'project-support',
    sortOrder: 0,
    title: 'Support',
    updatedAt: timestamp,
    version: 1,
    visibility: 'workspace',
    workspaceId: workspace.id,
  },
  {
    agentId: 'agent-research',
    createdAt: timestamp,
    id: 'channel-agent',
    isPrimaryProjectChannel: false,
    kind: 'direct_agent',
    lifecycleState: 'active',
    participants: [user, agentPrincipal],
    sortOrder: 2,
    title: 'Research Agent',
    updatedAt: timestamp,
    version: 1,
    visibility: 'participants',
    workspaceId: workspace.id,
  },
  {
    createdAt: timestamp,
    id: 'channel-group',
    isPrimaryProjectChannel: false,
    kind: 'group',
    lifecycleState: 'active',
    participants: [user, agentPrincipal],
    sortOrder: 3,
    title: 'Launch group',
    updatedAt: timestamp,
    version: 1,
    visibility: 'participants',
    workspaceId: workspace.id,
  },
]
const tasks = [
  {
    agentId: 'agent-research',
    artifactRefs: ['artifact-brief'],
    conversation: { channelId: 'channel-product', messageId: 'message-task' },
    createdAt: timestamp,
    creator: user,
    dependencyIds: [],
    id: 'task-launch',
    lifecycleState: 'created',
    objective: 'Prepare the launch brief and confirm audience.',
    priority: 'high',
    projectId: 'project-product',
    title: 'Launch planning',
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
  {
    artifactRefs: [],
    conversation: {},
    createdAt: timestamp,
    creator: user,
    dependencyIds: ['task-launch'],
    id: 'task-review',
    lifecycleState: 'queued',
    objective: 'Review the customer-facing plan.',
    priority: 'normal',
    title: 'Review launch',
    updatedAt: timestamp,
    version: 2,
    workspaceId: workspace.id,
  },
]
const artifacts = [
  {
    availability: 'available',
    checksumSha256: 'a'.repeat(64),
    createdAt: timestamp,
    deletionState: 'active',
    filename: 'launch-brief.md',
    id: 'artifact-brief',
    location: { reference: 'artifact://launch-brief', type: 'object_store' },
    mediaType: 'text/markdown',
    owner: user,
    provenance: { source: 'e2e' },
    retentionPolicy: 'standard',
    sensitivity: 'workspace',
    sizeBytes: 2048,
    sourceArtifactRef: 'artifact://launch-brief',
    sourcePrincipal: user,
    taskId: 'task-launch',
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
]
const messages = [
  {
    artifactIds: [],
    bodyText: 'Welcome to the Product Project. This is durable workspace history.',
    channelId: 'channel-product',
    createdAt: timestamp,
    deleted: false,
    id: 'message-root',
    mentions: [],
    sender: { kind: 'system', systemId: 'agent-hq' },
    sequence: 1,
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
  {
    artifactIds: ['artifact-brief'],
    bodyText: 'The launch brief is ready for review. @Research Agent',
    channelId: 'channel-product',
    createdAt: timestamp,
    deleted: false,
    id: 'message-task',
    mentions: [agentPrincipal],
    sender: user,
    sequence: 2,
    taskId: 'task-launch',
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
  {
    artifactIds: [],
    bodyContentRefId: 'content-private',
    channelId: 'channel-product',
    createdAt: timestamp,
    deleted: false,
    id: 'message-private',
    mentions: [],
    sender: agentPrincipal,
    sequence: 3,
    updatedAt: timestamp,
    version: 1,
    workspaceId: workspace.id,
  },
]
const reply = {
  artifactIds: [],
  bodyText: 'I will add competitor evidence here.',
  channelId: 'channel-product',
  createdAt: timestamp,
  deleted: false,
  id: 'message-reply',
  mentions: [],
  replyToMessageId: 'message-root',
  sender: agentPrincipal,
  sequence: 4,
  threadRootMessageId: 'message-root',
  updatedAt: timestamp,
  version: 1,
  workspaceId: workspace.id,
}
const readState = [
  {
    channelId: 'channel-product',
    lastReadSequence: 0,
    latestTopLevelSequence: 3,
    manuallyUnread: false,
    threadUnreadCount: 1,
    threads: [
      {
        lastReadSequence: 0,
        latestSequence: 4,
        manuallyUnread: false,
        threadRootMessageId: 'message-root',
        unreadCount: 1,
      },
    ],
    topLevelUnreadCount: 3,
    unread: true,
    workspaceId: workspace.id,
  },
]

async function mockWorkspace(page: Page, empty = false) {
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
      json: { activeWorkspace: workspace, principal: { temporary: true }, workspaces: [workspace] },
    })
  )
  await page.route('**/api/v1/account/summary', (route) =>
    route.fulfill({ contentType: 'application/json', json: { workspaces: [] } })
  )
  await page.route('**/api/v1/workspaces/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/read-state'))
      return route.fulfill({ contentType: 'application/json', json: { readState } })
    if (
      url.pathname.includes('/agents/agent-research/') &&
      ['PATCH', 'POST'].includes(route.request().method())
    ) {
      const body = route.request().postDataJSON() as Record<string, unknown>
      // Mirror the server: presentation and placement edits advance the Agent revision.
      const { expectedRevision, ...fields } = body
      const updated = {
        ...agents[0],
        ...(url.pathname.endsWith('/presentation') ? fields : {}),
        ...(url.pathname.endsWith('/project') ? { projectId: body.projectId } : {}),
        ...(url.pathname.endsWith('/presentation') || url.pathname.endsWith('/project')
          ? { revision: Number(expectedRevision) + 1 }
          : {}),
        ...(url.pathname.endsWith('/profile')
          ? {
              profile: {
                id: body.profileId,
                state: body.profileState ?? 'available',
                version: body.profileVersion,
              },
            }
          : {}),
      }
      return route.fulfill({ contentType: 'application/json', json: { agent: updated } })
    }
    if (url.pathname.endsWith('/agents/agent-research') && route.request().method() === 'DELETE')
      return route.fulfill({ contentType: 'application/json', json: { archived: true } })
    if (route.request().method() !== 'GET')
      return route.fulfill({ contentType: 'application/json', json: {} })
    if (url.pathname.endsWith('/search')) {
      const query = url.searchParams.get('q')?.toLocaleLowerCase() ?? ''
      const results = query.includes('brief')
        ? [
            {
              id: 'artifact-brief',
              kind: 'artifact',
              label: 'launch-brief.md',
              secondary: 'text/markdown',
              taskId: 'task-launch',
              workspaceId: workspace.id,
            },
          ]
        : query.includes('durable')
          ? [
              {
                channelId: 'channel-product',
                id: 'message-root',
                kind: 'message',
                label: 'This is durable workspace history.',
                messageId: 'message-root',
                projectId: 'project-product',
                secondary: 'Product · Message',
                workspaceId: workspace.id,
              },
            ]
          : []
      return route.fulfill({
        contentType: 'application/json',
        json: { privateResultsUnavailable: true, results },
      })
    }
    if (url.pathname.endsWith('/projects'))
      return route.fulfill({ contentType: 'application/json', json: empty ? [] : projects })
    // The lead exists with no approved profile yet, so the Agents status shows the
    // unconfigured state. The lead is kept out of the roster list below.
    if (url.pathname.endsWith('/agents/lead'))
      return route.fulfill({
        contentType: 'application/json',
        json: { lead: empty && request.method() === 'GET' ? null : workspaceLead },
      })
    if (url.pathname.endsWith('/agents'))
      return route.fulfill({ contentType: 'application/json', json: empty ? [] : agents })
    if (url.pathname.endsWith('/tasks'))
      return route.fulfill({ contentType: 'application/json', json: empty ? [] : tasks })
    if (url.pathname.endsWith('/artifacts'))
      return route.fulfill({ contentType: 'application/json', json: empty ? [] : artifacts })
    if (url.pathname.endsWith('/channels'))
      return route.fulfill({ contentType: 'application/json', json: empty ? [] : channels })
    if (url.pathname.endsWith('/messages')) {
      const channelId = url.pathname.split('/').at(-2)
      const threadRoot = url.searchParams.get('threadRootMessageId')
      const channelMessages = empty
        ? []
        : channelId === 'channel-product'
          ? messages
          : [
              {
                ...messages[0],
                bodyText:
                  channelId === 'channel-agent'
                    ? 'Private planning with Research Agent.'
                    : 'Launch group coordination.',
                channelId,
                id: `message-${channelId}`,
              },
            ]
      return route.fulfill({
        contentType: 'application/json',
        json: { messages: threadRoot ? [reply] : channelMessages, nextAfterSequence: null },
      })
    }
    return route.fulfill({ contentType: 'application/json', json: {} })
  })
}

async function mockConnectedWorkspace(page: Page) {
  const mutableProjects = projects.map((project) => ({ ...project }))
  const mutableChannels = channels.map((channel) => ({ ...channel }))

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
        principal: { temporary: true, userId: 'user-e2e' },
        workspaces: [workspace, homeWorkspace],
      },
    })
  )
  // Counts-only status for the collapsed workspace chips and "Needs you".
  await page.route('**/api/v1/account/summary', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        workspaces: [
          { workspaceId: workspace.id, unreadChannels: 1, mentions: 0 },
          { workspaceId: homeWorkspace.id, unreadChannels: 2, mentions: 1 },
        ],
      },
    })
  )
  await page.route('**/api/v1/workspaces/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname.endsWith('/projects')) {
      const body = request.postDataJSON() as { iconKey: string; name: string }
      const createdProject = {
        createdAt: timestamp,
        iconKey: body.iconKey,
        id: 'project-created',
        lifecycleState: 'active' as const,
        name: body.name,
        sortOrder: mutableProjects.length,
        updatedAt: timestamp,
        workspaceId: workspace.id,
      }
      mutableProjects.push(createdProject)
      mutableChannels.push({
        createdAt: timestamp,
        id: 'channel-created-project',
        isPrimaryProjectChannel: true,
        kind: 'project',
        lifecycleState: 'active',
        participants: [user],
        projectId: createdProject.id,
        sortOrder: 0,
        title: createdProject.name,
        updatedAt: timestamp,
        version: 1,
        visibility: 'workspace',
        workspaceId: workspace.id,
      })
      return route.fulfill({
        contentType: 'application/json',
        json: { project: createdProject },
        status: 201,
      })
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/channels')) {
      const body = request.postDataJSON() as { agentId?: string; kind: string; title: string }
      if (body.kind === 'direct_agent') {
        const directChannel = mutableChannels.find(
          (channel) => channel.kind === 'direct_agent' && channel.agentId === body.agentId
        )
        return route.fulfill({
          contentType: 'application/json',
          json: { channel: directChannel },
          status: 201,
        })
      }
      const createdChannel = {
        createdAt: timestamp,
        id: 'channel-created-group',
        isPrimaryProjectChannel: false,
        kind: body.kind as 'group',
        lifecycleState: 'active' as const,
        participants: [user],
        sortOrder: mutableChannels.length,
        title: body.title,
        updatedAt: timestamp,
        version: 1,
        visibility: 'participants' as const,
        workspaceId: workspace.id,
      }
      mutableChannels.push(createdChannel)
      return route.fulfill({
        contentType: 'application/json',
        json: { channel: createdChannel },
        status: 201,
      })
    }
    if (request.method() !== 'GET')
      return route.fulfill({ contentType: 'application/json', json: {} })
    if (url.pathname.includes('/read-state'))
      return route.fulfill({ contentType: 'application/json', json: { readState } })
    if (url.pathname.endsWith('/members') && !url.pathname.includes('/projects'))
      return route.fulfill({
        contentType: 'application/json',
        json: {
          members: [
            { userId: 'user-e2e', displayName: 'E2E Owner', role: 'owner' },
            { userId: 'user-collaborator', displayName: 'Collaborator', role: 'member' },
          ],
        },
      })
    if (url.pathname.endsWith('/projects'))
      return route.fulfill({ contentType: 'application/json', json: mutableProjects })
    if (url.pathname.endsWith('/channels'))
      return route.fulfill({ contentType: 'application/json', json: mutableChannels })
    if (url.pathname.endsWith('/agents'))
      return route.fulfill({ contentType: 'application/json', json: agents })
    if (url.pathname.endsWith('/tasks'))
      return route.fulfill({ contentType: 'application/json', json: tasks })
    if (url.pathname.endsWith('/artifacts'))
      return route.fulfill({ contentType: 'application/json', json: artifacts })
    if (url.pathname.endsWith('/messages'))
      return route.fulfill({ contentType: 'application/json', json: { messages: [] } })
    return route.fulfill({ contentType: 'application/json', json: {} })
  })
}

async function captureMessageSubmissions(
  page: Page,
  failAttempts: readonly number[] = []
): Promise<Record<string, unknown>[]> {
  const submissions: Record<string, unknown>[] = []
  let attempt = 0
  await page.route('**/api/v1/workspaces/workspace-e2e/channels/*/messages', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') return route.fallback()

    attempt += 1
    const body = request.postDataJSON() as Record<string, unknown>
    const channelId = decodeURIComponent(new URL(request.url()).pathname.split('/').at(-2) ?? '')
    submissions.push({
      ...body,
      channelId,
      idempotencyKey: request.headers()['idempotency-key'],
    })
    if (failAttempts.includes(attempt)) {
      return route.fulfill({
        contentType: 'application/json',
        json: { error: 'temporary failure' },
        status: 503,
      })
    }

    const message = {
      ...messages[0],
      ...body,
      channelId,
      id: `message-composer-${attempt}`,
      sender: user,
      sequence: 20 + attempt,
    }
    return route.fulfill({
      contentType: 'application/json',
      json: { message },
      status: 201,
    })
  })
  return submissions
}

test('keeps a composition Enter from submitting a workspace message', async ({ page }) => {
  await mockWorkspace(page)
  const submissions = await captureMessageSubmissions(page)
  await page.goto('/')
  await projectConversation(page, 'Product').click()

  const composer = page.getByRole('textbox', { name: 'Message' }).first()
  await composer.fill('候補')
  await composer.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) throw new Error('Composer is not a textarea')
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '候補' }))
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '候補' }))
    element.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', keyCode: 229 })
    )
  })

  await expect.poll(() => submissions.length, { timeout: 1_000 }).toBe(0)
  await expect(composer).toHaveValue('候補')
})

test('submits channel messages with mentions, artifacts, and Shift+Enter newlines', async ({
  page,
}) => {
  await mockWorkspace(page)
  const submissions = await captureMessageSubmissions(page)
  await page.goto('/')
  await projectConversation(page, 'Product').click()

  const composer = page.getByRole('textbox', { name: 'Message' }).first()
  const composerForm = page.locator('form[data-slot="message-composer"]').first()
  const describedBy = await composer.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  await expect(page.locator(`#${describedBy}`)).toContainText(
    'Enter to send · Shift+Enter newline · Mod+Shift+M focus'
  )
  await expect(composer).toHaveAttribute('id', 'composer-channel-product')
  await expect(page.getByRole('button', { name: 'Start dictation' })).toBeDisabled()
  await composerForm.evaluate((form) => {
    form.dataset.submitEventCount = '0'
    form.addEventListener(
      'submit',
      () => {
        form.dataset.submitEventCount = String(Number(form.dataset.submitEventCount) + 1)
      },
      { capture: true }
    )
  })
  await composer.fill('Ask @Research')
  const mentionMenu = page.getByRole('group', { name: 'Mention an Agent' })
  const mentionOption = mentionMenu.getByRole('button', { name: 'Research Agent', exact: true })
  const mentionButtonSemantics = await mentionOption.evaluate((element) => {
    const button = element as HTMLButtonElement
    return {
      type: button.type,
      formAssociated: Boolean(button.form),
      insideComposerForm: button.closest('form[data-slot="message-composer"]') !== null,
    }
  })
  expect(mentionButtonSemantics).toEqual({
    type: 'button',
    formAssociated: true,
    insideComposerForm: true,
  })
  // A mention row carries the shared Button's primary text, so the menu owns
  // the rung pairing: the row's own text at rest, and the accent rung with
  // its contrast text on hover — never primary-foreground on transparent.
  // A mention row is the shared ghost button: at rest it is transparent with
  // the frame's foreground text, and hovering paints a real background — the
  // accent-rung pairing was a legibility hack for primary Buttons and died
  // with the local menu CSS.
  const readMentionRowPaint = () =>
    page.evaluate(() => {
      const row = document.querySelector<HTMLButtonElement>(
        'form[data-slot="message-composer"] [data-slot="composer-menu"] button'
      )
      const frame = row?.closest('.conventional-workspace')
      if (!row || !frame) return null
      const token = (name: string) => getComputedStyle(frame).getPropertyValue(name).trim()
      const style = getComputedStyle(row)
      return {
        color: style.color,
        background: style.backgroundColor,
        foreground: token('--foreground'),
      }
    })
  const restingMentionRow = await readMentionRowPaint()
  expect(parseColor(restingMentionRow!.color)).toEqual(parseColor(restingMentionRow!.foreground))
  expect(restingMentionRow!.background).toBe('rgba(0, 0, 0, 0)')
  await mentionOption.hover()
  const hoveredMentionRow = await readMentionRowPaint()
  expect(hoveredMentionRow!.background).not.toBe('rgba(0, 0, 0, 0)')
  // Dictation progress rides the shared composer's own live region — one
  // region per composer, never a second one racing the sending copy. The
  // muted/alert rungs are static utilities on the adapter's status lines
  // (lint-held), and the desktop transcription provider cannot run in this
  // lane, so the contract pinned here is the region itself.
  const composerStatus = page
    .locator('form[data-slot="message-composer"] > [role="status"]')
    .first()
  await expect(composerStatus).toBeAttached()
  await expect(composerStatus).toHaveText(/Sending message|^$/)
  await mentionOption.click()
  expect(await composerForm.getAttribute('data-submit-event-count')).toBe('0')
  expect(submissions).toHaveLength(0)
  await expect(composer).toBeFocused()
  await composer.evaluate((element) => element.blur())
  await page.keyboard.press('Control+Shift+m')
  await expect(composer).toBeFocused()
  await composer.press('Shift+Enter')
  await composer.type('with attached notes')
  await page.getByRole('button', { name: 'Attach an Artifact' }).click()
  const attachmentMenu = page.getByRole('group', { name: 'Attach Artifact' })
  await attachmentMenu.locator('label').filter({ hasText: 'launch-brief.md' }).click()
  await expect(attachmentMenu.getByRole('checkbox')).toBeChecked()
  await expect(
    page.getByRole('button', { name: '1 Artifact attached, add an Artifact' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Remove launch-brief.md' }).click()
  await expect(page.getByRole('button', { name: 'Attach an Artifact' })).toBeVisible()
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0)
  await attachmentMenu.locator('label').filter({ hasText: 'launch-brief.md' }).click()
  await expect(attachmentMenu.getByRole('checkbox')).toBeChecked()
  await expect(
    page.getByRole('button', { name: '1 Artifact attached, add an Artifact' })
  ).toBeVisible()
  await composer.press('Enter')

  await expect.poll(() => submissions.length).toBe(1)
  expect(submissions[0]).toMatchObject({
    artifactIds: ['artifact-brief'],
    bodyText: 'Ask @Research Agent \nwith attached notes',
    channelId: 'channel-product',
    mentions: [{ agentId: 'agent-research', kind: 'agent' }],
  })
  expect(submissions[0]?.idempotencyKey).toEqual(expect.any(String))
  await expect(composer).toHaveValue('')
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Attach an Artifact' })).toBeVisible()
})

test('keeps the project draft and attachments after a failed send, then clears on retry', async ({
  page,
}) => {
  await mockWorkspace(page)
  const submissions = await captureMessageSubmissions(page, [1])
  await page.goto('/')
  await projectConversation(page, 'Product').click()

  const composer = page.getByRole('textbox', { name: 'Message' }).first()
  const draft = 'Keep this draft when the connection fails.'
  await composer.fill(draft)
  await page.getByRole('button', { name: 'Attach an Artifact' }).click()
  const attachmentMenu = page.getByRole('group', { name: 'Attach Artifact' })
  await attachmentMenu.locator('label').filter({ hasText: 'launch-brief.md' }).click()
  await expect(attachmentMenu.getByRole('checkbox')).toBeChecked()
  await page.getByRole('button', { name: 'Send message' }).first().click()

  await expect(
    page.getByText(
      'Message not sent. Your draft is still here; retry when the connection recovers.'
    )
  ).toBeVisible()
  await expect(composer).toHaveValue(draft)
  await expect(page.getByLabel('Selected attachments')).toContainText('launch-brief.md')
  await composer.press('Enter')

  await expect.poll(() => submissions.length).toBe(2)
  expect(submissions[0]).toMatchObject({ artifactIds: ['artifact-brief'], bodyText: draft })
  expect(submissions[1]).toMatchObject({ artifactIds: ['artifact-brief'], bodyText: draft })
  expect(submissions[1]?.idempotencyKey).toBe(submissions[0]?.idempotencyKey)
  await expect(composer).toHaveValue('')
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0)
})

test('keeps thread reply metadata separate from the project draft', async ({ page }) => {
  await mockWorkspace(page)
  const submissions = await captureMessageSubmissions(page)
  await page.goto('/')
  await projectConversation(page, 'Product').click()

  const pane = page.locator('[data-slot="conversation-pane"]').first()
  await expect(pane).not.toHaveAttribute('data-conversation-thread-open', 'true')
  const projectComposer = page.getByRole('textbox', { name: 'Message' }).first()
  await projectComposer.fill('Project draft remains here.')
  await page.getByRole('button', { name: 'Thread', exact: true }).first().click()
  await expect(pane).toHaveAttribute('data-conversation-thread-open', 'true')
  const threadComposer = page.getByRole('textbox', { name: 'Message' }).nth(1)
  await expect(threadComposer).toHaveAttribute('id', 'composer-thread-message-root')
  const threadDescribedBy = await threadComposer.getAttribute('aria-describedby')
  expect(threadDescribedBy).toBeTruthy()
  await expect(page.locator(`#${threadDescribedBy}`)).toContainText(
    'Enter to send · Shift+Enter newline · Mod+Shift+M focus'
  )
  // The reply strip names the thread the composer answers.
  await expect(page.getByText(/^Replying to /)).toBeVisible()
  await threadComposer.fill('Reply with the root identity preserved.')
  await threadComposer.evaluate((element) =>
    element.setAttribute('data-thread-composer-instance', 'original')
  )
  await threadComposer.press('Enter')

  await expect.poll(() => submissions.length).toBe(1)
  expect(submissions[0]).toMatchObject({
    bodyText: 'Reply with the root identity preserved.',
    channelId: 'channel-product',
    replyToMessageId: 'message-root',
    threadRootMessageId: 'message-root',
  })
  await expect(projectComposer).toHaveValue('Project draft remains here.')
  await expect(threadComposer).toHaveValue('')
  await expect(threadComposer).toHaveAttribute('data-thread-composer-instance', 'original')

  // The strip's dismissal closes the thread without touching the drafts.
  await page.getByRole('button', { name: 'Cancel reply' }).click()
  await expect(threadComposer).toHaveCount(0)
  await expect(pane).not.toHaveAttribute('data-conversation-thread-open', 'true')
  await expect(projectComposer).toHaveValue('Project draft remains here.')

  // A closed thread must also restore the conversation at overlay widths.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(projectComposer).toBeVisible()
  await page.getByRole('button', { name: 'Thread', exact: true }).first().click()
  await expect(pane).toHaveAttribute('data-conversation-thread-open', 'true')
  await expect(page.locator('#composer-thread-message-root')).toBeVisible()
  await expect(pane.locator('form[data-slot="message-composer"]').first()).toBeHidden()
  await page.getByRole('button', { name: 'Cancel reply' }).click()
  await expect(pane).not.toHaveAttribute('data-conversation-thread-open', 'true')
  await expect(projectComposer).toBeVisible()
  await expect(projectComposer).toHaveValue('Project draft remains here.')
})

test('renders empty and populated Project-first workspace states', async ({ page }) => {
  await mockWorkspace(page, true)
  await page.goto('/')
  await expect(workspaceNav(page).getByRole('heading', { name: 'Work', level: 3 })).toBeVisible()
  await expect(workspaceNav(page).getByText('No projects yet.')).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-empty-light.png', { animations: 'disabled' })

  await page.unrouteAll({ behavior: 'wait' })
  await mockWorkspace(page)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Product', exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByText('Private content unavailable')).toBeVisible()
  await expect(page.getByLabel('Attachment launch-brief.md')).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-project-populated-light.png', {
    animations: 'disabled',
  })
})

test('centers creation dialogs in the viewport', async ({ page }) => {
  await mockConnectedWorkspace(page)
  await page.goto('/')
  await expect(projectTree(page)).toBeVisible()
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(viewport)
    // The published composition renders two structural variants: the desktop
    // aside in the workspace frame, and a mobile aside inside the sheet's
    // dialog content — which some platforms keep mounted (and laid out) after
    // the sheet closes. Select the variant the viewport actually presents:
    // the desktop aside above 48rem, and below it the mobile aside inside the
    // open sheet's dialog (its wrapper carries data-expanded only while the
    // sheet is open) — never a visibility probe, which is platform-dependent.
    const navigation =
      viewport.width > 768
        ? page.locator('aside[data-contextual-sidebar="desktop"]')
        : page
            .locator('[role="dialog"][data-expanded]')
            .locator('aside[data-contextual-sidebar="mobile"]')
    if (!(await navigation.isVisible())) {
      // Crossing below 48rem closed the shared navigation and the frame-only
      // opener is display:none in that layout, so reopen through the top-bar
      // toggle that survives the narrow breakpoint. The crossing can replace
      // the toggle between hit-testing and its handler running, so the click
      // retries until the navigation answers.
      const toggle = page.getByRole('button', { name: 'Expand contextual sidebar' })
      for (let attempt = 0; attempt < 3 && !(await navigation.isVisible()); attempt += 1) {
        // Bound the click like the probe: a landed click renames the toggle
        // to its collapse variant, and an unbounded retry would wait the
        // whole timeout against the renamed-away locator.
        await toggle.click({ timeout: 2_000 }).catch(() => undefined)
        await expect(navigation)
          .toBeVisible({ timeout: 2_000 })
          .catch(() => undefined)
      }
    }
    await expect(navigation).toBeVisible()
    await createProjectButton(navigation).click()
    const dialog = page.getByRole('dialog', { name: 'Create Project' })
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2)
    expect(Math.abs(box!.y + box!.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2)
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  }
})

test('uses the published Adea Light semantic theme by default', async ({ page }) => {
  await mockConnectedWorkspace(page)
  await page.goto('/')
  const tokens = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement)
    return {
      background: styles.getPropertyValue('--background').trim(),
      primary: styles.getPropertyValue('--primary').trim(),
    }
  })
  const canonical = canonicalThemeCssTokens('adea-light')
  expect(tokens.background).toBe(canonical['--background'])
  expect(tokens.primary).toBe(canonical['--primary'])
})

test('loads chat before secure-context-only authentication APIs are requested', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    })
  })
  await mockConnectedWorkspace(page)
  await page.goto('/')

  await expect(projectTree(page)).toBeVisible()
})

test('inline workspace create keeps the name on failure and switches on success', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  const created = {
    ...homeWorkspace,
    id: 'workspace-side-quest-e2e',
    name: 'Side Quest',
    sortOrder: 2,
  }
  const requests: Array<{ body: unknown; key: string | null }> = []
  await page.route('**/api/workspaces', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    requests.push({
      body: route.request().postDataJSON(),
      key: route.request().headers()['idempotency-key'] ?? null,
    })
    if (requests.length === 1)
      return route.fulfill({ status: 503, contentType: 'application/json', json: { error: 'x' } })
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      json: { created: true, workspace: created },
    })
  })
  await page.goto('/')
  const workspaces = workspaceNav(page)
  await expect(workspaces.getByRole('heading', { name: 'Work', level: 3 })).toBeVisible()

  await workspaces.getByRole('button', { name: 'New workspace', exact: true }).click()
  const draft = workspaces.getByRole('textbox', { name: 'New workspace name' })
  await expect(draft).toBeFocused()
  await draft.fill('Side Quest')
  await draft.press('Enter')
  // The failure is reported inline and the typed name is kept for a retry.
  await expect(workspaces.getByRole('alert')).toContainText('Workspace could not be created.')
  await expect(draft).toHaveValue('Side Quest')
  await expect(draft).toHaveAttribute('aria-invalid', 'true')

  await draft.press('Enter')
  await expect(workspaces.getByRole('heading', { name: 'Side Quest', level: 3 })).toBeVisible()
  await expect(draft).toHaveCount(0)
  await expect(page).toHaveURL(/scene=home/)
  // Each attempt is its own request with a fresh idempotency key and the
  // home world.
  expect(requests).toHaveLength(2)
  expect(requests.map(({ body }) => body)).toEqual([
    { name: 'Side Quest', scene: 'home' },
    { name: 'Side Quest', scene: 'home' },
  ])
  expect(requests[0]!.key).toMatch(/^[0-9a-f-]{36}$/)
  expect(requests[1]!.key).not.toBe(requests[0]!.key)
})

test('the active workspace accent themes the app and collapsed rows keep their own', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.route('**/api/workspaces/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: { ...workspace, accent: 'green' },
        principal: { temporary: true, userId: 'user-e2e' },
        workspaces: [{ ...workspace, accent: 'green' }, homeWorkspace],
      },
    })
  )
  await page.goto('/')
  const workspaces = workspaceNav(page)
  await expect(workspaces.getByRole('heading', { name: 'Work', level: 3 })).toBeVisible()
  const roles = await page.evaluate(() => {
    const home = document.querySelector('button[data-workspace-id="workspace-home-e2e"]')!
    return Object.fromEntries(
      Object.entries({
        root: document.documentElement,
        body: document.body,
        home: home.querySelector('.workspace-identity-mark')!,
      }).map(([key, element]) => [
        key,
        getComputedStyle(element).getPropertyValue('--primary').trim(),
      ])
    ) as { root: string; body: string; home: string }
  })
  // The workspace accent overrides the appearance accent while it is active;
  // a workspace without an accent keeps showing the appearance accent.
  expect(roles.body).not.toBe(roles.root)
  expect(roles.home).toBe(roles.root)

  await workspaces.getByRole('button', { name: /^Home( |$)/ }).click()
  await expect(workspaces.getByRole('heading', { name: 'Home', level: 3 })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.body.style.getPropertyValue('--primary').trim()))
    .toBe('')
})

test('the project menu opens the lazy Share dialog from the accordion', async ({ page }) => {
  await mockConnectedWorkspace(page)
  await page.goto('/')
  const project = projectTree(page).locator('[data-project-id="project-product"]')
  await project.hover()
  await page.getByRole('button', { name: 'Project options for Product', exact: true }).click()
  await expect(page.getByRole('menuitem')).toHaveText([
    'Rename',
    'Project settings',
    'Share',
    'Archive',
    'Delete',
  ])
  await page.getByRole('menuitem', { name: 'Share', exact: true }).click()
  const share = page.getByRole('dialog', { name: 'Share Product' })
  await expect(share).toBeVisible()
  // The member search composes the published ComboboxControl, so the field
  // carries the shared chrome instead of a bare borderless input.
  const search = share.getByPlaceholder('Search members')
  await expect(search).toBeVisible()
  const chrome = await search.evaluate((input) => {
    const control = input.parentElement
    if (!control) return null
    const style = getComputedStyle(control)
    return { controlBorder: style.borderTopWidth, controlBorderColor: style.borderTopColor }
  })
  expect(chrome).not.toBeNull()
  expect(chrome!.controlBorder).toBe('1px')
  expect(chrome!.controlBorderColor).not.toBe('rgba(0, 0, 0, 0)')
})

test('the artifact detail keeps the surface header composition', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/?view=chat')
  const composer = page.locator('textarea[id^="composer-"]')
  await expect(composer).toBeVisible()
  await page.getByRole('button', { name: 'Search this conversation' }).click()
  const search = page.getByRole('dialog', { name: /Search/i })
  await search.getByPlaceholder('Find a Project, conversation, Agent, or Task').fill('brief')
  await search.getByText('launch-brief.md').click()
  const detail = page.locator('.conventional-artifact-detail')
  await expect(detail).toBeVisible()
  const composition = await page.evaluate(() => {
    const section = document.querySelector('.conventional-artifact-detail')
    const header = section?.querySelector('.conventional-surface-header')
    const h1 = section?.querySelector('h1')
    if (!section || !header || !h1) return null
    const sectionStyle = getComputedStyle(section)
    const sectionRect = section.getBoundingClientRect()
    const headerRect = header.getBoundingClientRect()
    return {
      sectionPaddingTop: sectionStyle.paddingTop,
      headerFullWidth:
        headerRect.left - sectionRect.left >= Number.parseFloat(sectionStyle.paddingLeft) - 2 &&
        headerRect.width > sectionRect.width * 0.6,
      h1Weight: getComputedStyle(h1).fontWeight,
    }
  })
  expect(composition).not.toBeNull()
  // The header keeps the standard surface inset and spans the view instead of
  // shrink-wrapping to its copy and centring the wrap.
  expect(Number.parseFloat(composition!.sectionPaddingTop)).toBeGreaterThan(0)
  expect(composition!.headerFullWidth).toBe(true)
  // The surface heading carries the published semibold role, not preflight's
  // inherited 400.
  expect(composition!.h1Weight).toBe('600')
})

test('the top-bar title slot shows Workspace › Project › Leaf without adding a row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await mockConnectedWorkspace(page)
  const roadmap = {
    ...channels[0]!,
    id: 'channel-roadmap',
    isPrimaryProjectChannel: false,
    sortOrder: 1,
    title: 'Roadmap',
  }
  await page.route(
    (url) => url.pathname.endsWith('/api/v1/workspaces/workspace-e2e/channels'),
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ contentType: 'application/json', json: [...channels, roadmap] })
        : route.fallback()
  )
  await page.goto('/')
  const toolbar = page.getByLabel('Workspace toolbar')
  const title = toolbar.locator('[data-topbar-title]')
  await expect(workspaceNav(page).getByRole('heading', { name: 'Work', level: 3 })).toBeVisible()
  const barBefore = await toolbar.boundingBox()

  await workspaceNav(page)
    .getByRole('treeitem', { name: /Roadmap/, level: 2 })
    .click()
  const crumbs = title.getByRole('navigation', { name: 'Breadcrumb' })
  // The crumbs live in the existing title slot; each names what it is for
  // assistive technology (Workspace, Project, Task) ahead of its label.
  await expect(crumbs.getByRole('listitem')).toHaveText([
    /Workspace: Work$/,
    /Project: Product$/,
    /Task: Roadmap$/,
  ])
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Task: Roadmap')
  await expect(crumbs.locator('.workspace-identity-mark')).toHaveCount(1)
  // No new row: the bar keeps its height and the crumbs sit on its one line.
  const barAfter = await toolbar.boundingBox()
  expect(barAfter?.height).toBe(barBefore?.height)
  const crumbBox = await crumbs.boundingBox()
  expect(crumbBox!.y).toBeGreaterThanOrEqual(barAfter!.y)
  expect(crumbBox!.y + crumbBox!.height).toBeLessThanOrEqual(barAfter!.y + barAfter!.height)
  expect(await title.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap')

  // The project crumb opens the project's default leaf; that leaf is named
  // after the project, so the path ends at the project and nothing links to
  // what is already shown.
  await crumbs.getByRole('link', { name: 'Project: Product' }).click()
  await expect(
    page.locator('#workspace-main').getByRole('heading', { name: 'Product', exact: true })
  ).toBeVisible()
  await expect(crumbs.getByRole('listitem')).toHaveText([/Workspace: Work$/, /Project: Product$/])
  await expect(crumbs.getByRole('link')).toHaveCount(0)

  // Another project's default leaf: the workspace crumb opens the first project.
  await workspaceNav(page)
    .getByRole('treeitem', { name: /Support/, level: 2 })
    .click()
  await expect(crumbs.getByRole('listitem')).toHaveText([/Workspace: Work$/, /Project: Support$/])
  await crumbs.getByRole('link', { name: 'Workspace: Work' }).click()
  await expect(crumbs.getByRole('listitem')).toHaveText([/Workspace: Work$/, /Project: Product$/])

  // Virtual reads the same tree and selection in its own nouns: the project
  // is a room and its other leaves are desks. (Selecting a desk in Virtual
  // opens it in Chat, so the desk is selected first.)
  await workspaceNav(page)
    .getByRole('treeitem', { name: /Roadmap/, level: 2 })
    .click()
  await page.locator('[data-global-rail]').getByRole('button', { name: 'Virtual view' }).click()
  await expect(page).toHaveURL(/view=virtual/)
  await expect(
    workspaceNav(page).getByRole('button', { name: 'New room in Work', exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(crumbs.getByRole('listitem')).toHaveText([
    /Workspace: Work$/,
    /Room: Product$/,
    /Desk: Roadmap$/,
  ])

  // App Library keeps its plain title.
  await page.goto('/?app=library')
  await expect(title).toHaveText('App Library')
  await expect(title.getByRole('navigation')).toHaveCount(0)
})

test('connects newly created Projects and group conversations to their canonical views', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/')

  await createProjectButton(page).last().click()
  const projectDialog = page.getByRole('dialog', { name: 'Create Project' })
  await projectDialog.getByLabel('Project name').fill('Runtime Review')
  await projectDialog.getByLabel('Icon key').fill('runtime-review')
  await projectDialog.getByRole('button', { name: 'Create Project', exact: true }).click()
  await expect(
    page.locator('#workspace-main').getByRole('heading', { name: 'Runtime Review', exact: true })
  ).toBeVisible()

  await page.getByRole('button', { name: 'Create group conversation' }).click()
  const groupDialog = page.getByRole('dialog', { name: 'New group conversation' })
  await groupDialog.getByLabel('Conversation name').fill('Connected review')
  await groupDialog.getByRole('button', { name: 'Create conversation' }).click()
  await expect(
    page.locator('#workspace-main').getByRole('heading', { name: 'Connected review', exact: true })
  ).toBeVisible()
  // The open conversation's row carries the sidebar rung.
  const connectedReviewRow = page
    .getByRole('complementary', { name: 'Workspace navigation' })
    .getByRole('button', { name: 'Connected review', exact: true })
  await expect(connectedReviewRow).toHaveAttribute('data-active', '')

  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  // The Agents surface keeps no stale leaf rung: the highlight follows the
  // current leaf only, while the selection itself stays live for breadcrumbs.
  await expect(
    page.locator('#workspace-main').getByRole('heading', { name: 'Agents', exact: true })
  ).toBeVisible()
  await expect(connectedReviewRow).not.toHaveAttribute('data-active', '')
  await page.getByRole('button', { name: 'Open conversation' }).first().click()
  await expect(
    page.locator('#workspace-main').getByRole('heading', { name: 'Research Agent', exact: true })
  ).toBeVisible()
})

test('toggles chat and virtual Project views without losing shared selection or drafts', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await mockConnectedWorkspace(page)
  await page.goto('/')
  const globalNavigation = page.getByRole('navigation', { name: 'Global navigation' })
  await expect(globalNavigation).toBeVisible()
  // The global rail renders permanently collapsed, where the shared rail draws
  // no chord glyph; the chord reaches assistive technology through
  // `aria-keyshortcuts`, which is the contract that must hold in that state.
  await expect(globalNavigation.getByRole('button', { name: 'Search workspace' })).toHaveAttribute(
    'aria-keyshortcuts',
    'Meta+K Control+K'
  )
  // Notifications lives in the top bar now, not on the global rail.
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
  await expect(
    globalNavigation.getByRole('button', { name: 'Notifications (coming soon)' })
  ).toHaveCount(0)
  // Workspaces live in the contextual sidebar's accordion (ADR 0011): the rail
  // keeps only the static product mark.
  await expect(globalNavigation.getByRole('button', { name: /Switch workspace/ })).toHaveCount(0)
  await expect(page.locator('#workspace-switcher')).toHaveCount(0)
  await expect(page.locator('.conventional-topbar')).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
  const workspaces = workspaceNav(page)
  await expect(workspaces.getByRole('heading', { name: 'Work', level: 3 })).toBeVisible()
  // The collapsed Home row shows its most urgent count and announces every
  // count; mentions put "Needs you" on the strip.
  const homeRow = workspaces.getByRole('button', { name: /^Home( |$)/ })
  await expect(homeRow).toContainText('1 mention')
  await expect(homeRow).toHaveAccessibleName(/1 mention, 2 unread/)
  await expect(workspaces.getByRole('button', { name: /^Needs you/ })).toContainText('1')
  await projectConversation(page, 'Product').click()
  await page.getByRole('textbox', { name: 'Message' }).fill('Keep this connected draft.')

  // Park the pointer on empty canvas so no row hover or tooltip paints.
  await page.mouse.move(640, 400)
  await expect(page.getByRole('tooltip')).toBeHidden()
  await expect(page).toHaveScreenshot('workspace-accordion.png', { animations: 'disabled' })
  await expect(page.getByText('Scenes', { exact: true })).toHaveCount(0)
  await homeRow.click()
  await expect(workspaces.getByRole('heading', { name: 'Home', level: 3 })).toBeVisible()
  await expect(projectTree(page, 'Work')).toHaveCount(0)
  await expect(page).toHaveURL(/scene=home/)
  // A switch starts a fresh workspace context: the draft stays with Work.
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('')

  await workspaces.getByRole('button', { name: /^Work( |$)/ }).click()
  await expect(page).toHaveURL(/scene=work/)
  await expect(workspaces.getByRole('heading', { name: 'Work', level: 3 })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Message' }).fill('Keep this connected draft.')

  await globalNavigation.getByRole('button', { name: 'Virtual view' }).click()
  await expect(page).toHaveURL(/view=virtual/)
  // The engine is entitled per build: a packed Agent Sim renders its own room
  // region and controls, and every other build renders the documented offline
  // fallback. Both are correct, so the gate accepts either and only checks the
  // engine's room controls when the engine is actually there.
  const virtualRoom = page.getByRole('region', { name: 'Virtual Room' })
  const engineFallback = page.getByRole('status', { name: 'Virtual view unavailable' })
  await expect(virtualRoom.or(engineFallback)).toBeVisible({ timeout: 30_000 })
  // Virtual view renders the same shared contextual sidebar as chat (main gave
  // it a separate "Virtual navigation" aside, which is why this used to assert
  // absence); the shared sidebar stays put across the view switch.
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
  if (await virtualRoom.count()) {
    // Scope to the room region: the shared sidebar also carries a "Product"
    // button, which would make a page-wide locator ambiguous.
    await expect(virtualRoom.getByRole('button', { name: 'Product', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  }

  await globalNavigation.getByRole('button', { name: 'Chat view' }).click()
  await expect(page).toHaveURL(/view=chat/)
  await expect(
    page.locator('#workspace-main').getByRole('heading', { name: 'Product', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
    'Keep this connected draft.'
  )
})

test('keeps Plugins unavailable until workspace bootstrap completes', async ({ page }) => {
  let releaseBootstrap!: () => void
  const bootstrapBlocked = new Promise<void>((resolve) => {
    releaseBootstrap = resolve
  })
  await page.route('**/api/workspaces/bootstrap', async (route) => {
    await bootstrapBlocked
    await route.fulfill({
      contentType: 'application/json',
      json: {
        activeWorkspace: workspace,
        principal: { temporary: true, userId: 'user-e2e' },
        workspaces: [workspace, homeWorkspace],
      },
    })
  })
  await page.goto('/?view=chat')
  const globalNavigation = page.getByRole('navigation', { name: 'Global navigation' })
  const pluginsButton = globalNavigation.getByRole('button', { name: 'Plugins' })
  await expect(pluginsButton).toBeVisible()
  await expect(pluginsButton).toBeDisabled()

  releaseBootstrap()
  await expect(pluginsButton).toBeEnabled()
})

test('browses the verified registry marketplace and submits an exact install request', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  const fixture = marketplaceFixture()
  await expect(verifyRegistryArtifacts(fixture.artifacts)).resolves.toBeTruthy()
  const installRequests: unknown[] = []
  await page.route('**/api/marketplace/catalog', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        artifacts: fixture.artifacts,
        catalogId: fixture.catalogId,
        installations: [],
        releaseId: fixture.catalogId,
        state: 'ready',
      },
    })
  )
  await page.route('**/api/marketplace/install', async (route) => {
    const request = route.request().postDataJSON() as {
      canonicalContentDigest: string
      idempotencyKey: string
      pluginId: string
      releaseId: string
      requestedHarness: string
    }
    installRequests.push(request)
    await route.fulfill({
      contentType: 'application/json',
      json: {
        canonicalContentDigest: request.canonicalContentDigest,
        installationId: 'ins_e2e-marketplace',
        message: 'Authorization is required before installation.',
        pluginId: request.pluginId,
        releaseId: request.releaseId,
        state: 'pending-authorization',
      },
    })
  })
  await page.goto('/?view=chat')
  const globalNavigation = page.getByRole('navigation', { name: 'Global navigation' })
  await globalNavigation.getByRole('button', { name: 'Plugins' }).click()
  const plugins = page.getByRole('dialog', { name: 'Plugins' })
  await expect(plugins).toBeVisible()
  await expect(plugins.getByRole('status').first()).toHaveText(/^\d+ plugins$/)

  const results = plugins.getByRole('region', { name: 'Plugin results', exact: true })
  await expect(results).toHaveAttribute('tabindex', '0')
  const pluginGroups = results.getByRole('region')
  const popularPlugins = pluginGroups.first()
  await expect(popularPlugins.getByRole('heading', { name: 'Popular' })).toBeVisible()
  await expect(popularPlugins.locator('[data-catalog-entry-id]')).toHaveCount(6)
  await expect(popularPlugins.getByRole('button', { name: /Gmail/ })).toBeVisible()
  await expect(popularPlugins.getByRole('button', { name: /GitHub/ })).toBeVisible()
  expect(
    await pluginGroups.evaluateAll((groups) =>
      groups.every((group) => group.querySelectorAll('[data-catalog-entry-id]').length <= 6)
    )
  ).toBe(true)

  const productivityPlugins = pluginGroups.filter({
    has: page.getByRole('heading', { name: 'Productivity', exact: true }),
  })
  await plugins.getByRole('button', { name: 'See Project Summaries, Todoist and more' }).click()
  await expect(productivityPlugins.locator('[data-catalog-entry-id]')).toHaveCount(9)
  await productivityPlugins.getByRole('button', { name: 'Show less' }).click()
  await expect(productivityPlugins.locator('[data-catalog-entry-id]')).toHaveCount(6)

  await plugins.getByRole('searchbox', { name: 'Search plugins' }).fill('github')
  await plugins.getByRole('button', { name: /GitHub/ }).click()
  await expect(plugins.getByRole('heading', { name: 'GitHub' })).toBeVisible()
  await expect(plugins.getByText('openai-official', { exact: true })).toBeVisible()
  await expect(plugins.getByText('MCP', { exact: true })).toBeVisible()
  await plugins.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(
    plugins.getByRole('button', { name: 'Authorization pending', exact: true })
  ).toBeVisible()
  expect(installRequests).toEqual([
    {
      canonicalContentDigest: `sha256:${'02'.repeat(32)}`,
      idempotencyKey:
        'marketplace:a6f55d19184dc1c1e0f3ed5765bc0fb1ca49437a32130aee7b6f9610953a9ad6',
      installationInstanceId:
        'marketplace:37f53eb6e39f6ecffb13eba915de46666a9403f31951ab444f3e17131cb57371',
      pluginId: 'plugin:openai-official:github',
      releaseId: `release:${'02'.repeat(32)}`,
      requestedHarness: 'codex',
      workspaceIdentity: { userId: 'user-e2e', workspaceId: workspace.id },
    },
  ])
  // The verified catalog is cached for stale-while-revalidate (the global
  // snapshot plus the legacy per-workspace entry), so the assertion is about
  // what must never be persisted: installations, authorizations, and
  // credentials. Anything else plugin-shaped in storage fails this gate.
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter(
        (key) =>
          /plugin/i.test(key) &&
          key !== 'adea:plugin-catalog-cache:v1' &&
          key !== 'adea:plugin-catalog-global:v1'
      )
    )
  ).toEqual([])
  await plugins.getByRole('button', { name: 'Back to plugins' }).click()
  await expect(plugins.getByRole('button', { name: /GitHub/ })).toBeFocused()
  await plugins.getByRole('tab', { name: 'Installed' }).click()
  await expect(plugins.getByText('No plugins added yet')).toBeVisible()
})

test('navigates direct, group, and thread surfaces', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Research Agent', exact: true }).click()
  await expect(page.getByText('Direct Conversation', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-direct-agent.png', { animations: 'disabled' })

  await page.getByRole('button', { name: 'Launch group', exact: true }).click()
  await expect(
    page.locator('#workspace-main').getByText('Group conversation', { exact: true })
  ).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-group.png', { animations: 'disabled' })

  await projectConversation(page, 'Product').click()
  await page.getByRole('button', { name: 'Thread', exact: true }).first().click()
  // The shared thread panel titles itself through the aside's accessible name
  // ("Thread: <label>"); its visible "Thread" caption is a span, not a heading.
  await expect(
    page.getByRole('complementary', { name: 'Thread: Focused discussion' })
  ).toBeVisible()
  await expect(page.getByText('I will add competitor evidence here.')).toBeVisible()
  // The shared thread panel pads its own composer footer, so the composer
  // must not also carry the conversation transcript's 40px outer gutters.
  const threadComposerGutters = await page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>(
      '[data-conventional-thread] form[data-slot="message-composer"]'
    )
    if (!composer) return null
    const style = getComputedStyle(composer)
    return { left: style.marginLeft, right: style.marginRight }
  })
  expect(threadComposerGutters).toEqual({ left: '0px', right: '0px' })
  await expect
    .poll(() =>
      page.evaluate(() => ({
        documentScroll: document.documentElement.scrollLeft,
        workspaceScroll: document.querySelector('.conventional-workspace')?.scrollLeft ?? -1,
      }))
    )
    .toEqual({ documentScroll: 0, workspaceScroll: 0 })
  // Opening the panel narrows the transcript and reflows it taller; follow
  // mode re-pins it to the latest message on a later frame. Capture the
  // settled state (follow armed, offsets unchanged between two polls), not a
  // frame where "Jump to latest" shows mid-reflow.
  let previousOffsets = ''
  await expect
    .poll(
      async () => {
        const offsets = await page
          .locator('[data-conventional-transcript]')
          .evaluateAll((nodes) => nodes.map((node) => node.scrollTop).join(','))
        const settled = offsets === previousOffsets
        previousOffsets = offsets
        return settled
      },
      { intervals: [100] }
    )
    .toBe(true)
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)
  await expect(page).toHaveScreenshot('workspace-thread.png', { animations: 'disabled' })
  await page.getByRole('button', { name: 'Close thread' }).click()
})

test('restores a channel reading position without rearming transcript follow', async ({ page }) => {
  await mockWorkspace(page)
  await page.route('**/api/v1/workspaces/workspace-e2e/channels/*/messages**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const channelId = requestUrl.pathname.split('/').at(-2)
    if (route.request().method() !== 'GET' || channelId !== 'channel-product') {
      return route.fallback()
    }

    const history = Array.from({ length: 60 }, (_, index) => ({
      ...messages[0],
      bodyText: `Synthetic history row ${index + 1}. ${'Readable transcript content. '.repeat(5)}`,
      channelId,
      createdAt: new Date(Date.UTC(2026, 8, 30, 12, index)).toISOString(),
      id: `scroll-history-${index + 1}`,
      sequence: index + 1,
    }))
    return route.fulfill({
      contentType: 'application/json',
      json: { messages: history, nextAfterSequence: null },
    })
  })

  await page.goto('/')
  await projectConversation(page, 'Product').click()
  const transcript = page.locator('[data-conventional-transcript]')
  await expect.poll(() => transcript.evaluate((node) => node.scrollHeight)).toBeGreaterThan(1000)
  await transcript.evaluate((node) => {
    node.scrollTop = 420
    node.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(420)
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()

  await page.getByRole('button', { name: 'Research Agent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Research Agent', exact: true })).toBeVisible()
  await projectConversation(page, 'Product').click()

  await expect.poll(() => transcript.evaluate((node) => node.scrollTop)).toBe(420)
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
})

test('opens the Task panel beside the board and restores focus on dismissal', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/?view=chat&app=kanban')
  const taskTrigger = page.getByRole('button', { name: 'Launch planning', exact: true })
  await taskTrigger.click()
  const detail = page.getByRole('dialog', { name: 'Edit task', exact: true })
  await expect(detail.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
    'Launch planning'
  )
  // The panel shares the Appearance panel's shape: header, scrolling body, footer.
  const body = detail.locator('[data-slot="sheet-body"]')
  await expect(body).toHaveCSS('overflow-y', 'auto')
  // Nothing to save until something changes.
  await expect(detail.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  const rootFontSize = await page
    .locator('html')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(
    await detail.evaluate((element) => Number.parseFloat(getComputedStyle(element).width))
  ).toBeCloseTo(32 * rootFontSize, 1)
  // Docked inside the main view: below the top bar, one equal gap from the top
  // bar, the end edge and the bottom of the window.
  const topBar = await page.getByLabel('Workspace toolbar').boundingBox()
  // Measure the settled panel, not a frame of its slide-in.
  await detail.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished))
  )
  const panelBox = (await detail.boundingBox())!
  const viewport = page.viewportSize()!
  const gap = viewport.width - (panelBox.x + panelBox.width)
  expect(gap).toBeGreaterThan(0)
  expect(panelBox.y - (topBar!.y + topBar!.height)).toBeCloseTo(gap, 0)
  expect(viewport.height - (panelBox.y + panelBox.height)).toBeCloseTo(gap, 0)
  await detail.getByRole('textbox', { name: 'Title', exact: true }).focus()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(page).toHaveScreenshot('workspace-task-detail.png', { animations: 'disabled' })

  await page.setViewportSize({ width: 390, height: 480 })
  expect(
    await detail.evaluate((element) => Number.parseFloat(getComputedStyle(element).width))
  ).toBeCloseTo(390 - 2 * gap, 0)
  await expect
    .poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)
  await expect(taskTrigger).toBeFocused()

  await page.setViewportSize({ width: 1280, height: 720 })
  await taskTrigger.click()
  const reopenedDetail = page.getByRole('dialog', { name: 'Edit task', exact: true })
  await reopenedDetail.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(reopenedDetail).toHaveCount(0)
  await expect(taskTrigger).toBeFocused()
})

test('creates a Task from a side panel without moving the board', async ({ page }) => {
  await mockWorkspace(page)
  const created: unknown[] = []
  const boardTasks = tasks.map((task) => ({ ...task }))
  const refetch = { released: false, waiting: new Set<() => void>() }
  await page.route('**/api/v1/workspaces/**/tasks', async (route) => {
    if (route.request().method() === 'GET') {
      if (created.length > 0 && !refetch.released)
        await new Promise<void>((resolve) => {
          refetch.waiting.add(resolve)
        })
      return route.fulfill({ contentType: 'application/json', json: boardTasks })
    }
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON() as { title: string }
    created.push(body)
    const task = { ...tasks[0]!, id: 'task-new', title: body.title, version: 1 }
    boardTasks.push(task)
    return route.fulfill({
      contentType: 'application/json',
      json: { task },
    })
  })
  await page.goto('/?view=chat&app=kanban')
  // A CSS locator: the open modal panel hides the board from role queries.
  const board = page.locator('[role="region"][aria-label="Task board"]')
  await expect(board).toBeVisible()
  const before = await board.boundingBox()
  await page.getByRole('button', { name: 'New task', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'New task', exact: true })
  await expect(panel).toBeVisible()
  expect(await board.boundingBox()).toEqual(before)
  // Create is offered only once the task has a title.
  const create = panel.getByRole('button', { name: 'Create task', exact: true })
  await expect(create).toBeDisabled()
  await panel.getByRole('textbox', { name: 'Title', exact: true }).fill('   ')
  await expect(create).toBeDisabled()
  await panel.getByRole('textbox', { name: 'Title', exact: true }).fill('Write release notes')
  await expect(create).toBeEnabled()
  try {
    await panel.getByRole('button', { name: 'Create task', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await expect.poll(() => created.length).toBe(1)
    await expect.poll(() => refetch.waiting.size).toBeGreaterThan(0)
    // The server's create result supplies the card even while list reconciliation is held.
    await expect(
      board.getByRole('button', { name: 'Write release notes', exact: true })
    ).toBeVisible()
  } finally {
    refetch.released = true
    for (const release of refetch.waiting) release()
    refetch.waiting.clear()
  }
})

test('edits a Task with first-click selects and closes on Save without reopening', async ({
  page,
}) => {
  await mockWorkspace(page)
  const updates: unknown[] = []
  const boardTasks = tasks.map((task) => ({ ...task }))
  await page.route('**/api/v1/workspaces/**/tasks**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (method === 'GET' && url.pathname.endsWith('/tasks'))
      return route.fulfill({ contentType: 'application/json', json: boardTasks })
    if (method !== 'PATCH' || !url.pathname.endsWith('/tasks/task-launch')) return route.fallback()
    updates.push(route.request().postDataJSON())
    const index = boardTasks.findIndex(({ id }) => id === 'task-launch')
    const task = {
      ...boardTasks[index]!,
      priority: 'urgent',
      version: boardTasks[index]!.version + 1,
    }
    boardTasks.splice(index, 1, task)
    return route.fulfill({ contentType: 'application/json', json: { task } })
  })
  await page.goto('/?view=chat&app=kanban')
  const card = page.getByRole('button', { name: 'Launch planning', exact: true })
  await card.click()
  const detail = page.getByRole('dialog', { name: 'Edit task', exact: true })
  const save = detail.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toBeDisabled()

  // The Type and Priority rows carry the tint their card badge speaks as a
  // leading swatch dot (aria-hidden; the word carries the meaning).
  await detail.getByRole('button', { name: /^Type/ }).click()
  const typeListbox = page.getByRole('listbox', { name: 'Type' })
  await expect(typeListbox).toBeVisible()
  const typeSwatch = (name: string) =>
    typeListbox.getByRole('option', { name, exact: true }).locator('span[aria-hidden="true"]')
  await expect(typeSwatch('Feature')).toHaveClass(/bg-info/)
  await expect(typeSwatch('Bug')).toHaveClass(/bg-destructive/)
  await expect(typeSwatch('Chore')).toHaveClass(/bg-muted-foreground/)
  await typeListbox.getByRole('option', { name: 'Feature', exact: true }).click()

  // The Priority select opens on the first click and stays open.
  await detail.getByRole('button', { name: /^Priority/ }).click()
  const listbox = page.getByRole('listbox', { name: 'Priority' })
  await expect(listbox).toBeVisible()
  const prioritySwatch = (name: string) =>
    listbox.getByRole('option', { name, exact: true }).locator('span[aria-hidden="true"]')
  await expect(prioritySwatch('Urgent')).toHaveClass(/bg-destructive/)
  await expect(prioritySwatch('High')).toHaveClass(/bg-warning/)
  await expect(prioritySwatch('Normal')).toHaveClass(/bg-muted-foreground/)
  await page.waitForTimeout(300)
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: 'Urgent', exact: true }).click()
  await expect(detail.getByRole('button', { name: /^Priority/ })).toContainText('Urgent')
  await expect(detail.getByText('Unsaved changes', { exact: true })).toBeVisible()
  await expect(save).toBeEnabled()

  // Save closes the panel once, for good: count every dialog that mounts after it.
  await page.evaluate(() => {
    const seen = { count: 0 }
    ;(window as unknown as { kanbanDialogMounts: typeof seen }).kanbanDialogMounts = seen
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement && node.querySelector('[role="dialog"]')) seen.count++
    }).observe(document.body, { childList: true, subtree: true })
  })
  await save.click()
  await expect(detail).toHaveCount(0)
  await expect(page.getByLabel('Priority: Urgent')).toBeVisible()
  await expect.poll(() => updates.length).toBe(1)
  await page.waitForTimeout(500)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { kanbanDialogMounts: { count: number } }).kanbanDialogMounts.count
    )
  ).toBe(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Task board preserves task data and moves cards with keyboard and drag', async ({
  page,
}, testInfo) => {
  await mockWorkspace(page)
  let boardTasks = tasks.map((task) => ({ ...task }))
  const taskActions: string[] = []
  const nextStateByAction = {
    cancel: 'cancelled',
    complete: 'completed',
    queue: 'queued',
    review: 'in_review',
    start: 'in_progress',
  } as const
  await page.route('**/api/v1/workspaces/**/tasks**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (method === 'GET' && url.pathname.endsWith('/tasks'))
      return route.fulfill({ contentType: 'application/json', json: boardTasks })

    const action = url.pathname.split('/').at(-1) ?? ''
    const taskId = url.pathname.split('/').at(-2) ?? ''
    const nextState = nextStateByAction[action as keyof typeof nextStateByAction]
    if (method === 'POST' && nextState) {
      const taskIndex = boardTasks.findIndex((task) => task.id === taskId)
      if (taskIndex < 0) return route.fulfill({ status: 404, json: { error: 'Task not found' } })
      taskActions.push(`${taskId}/${action}`)
      const task = {
        ...boardTasks[taskIndex]!,
        lifecycleState: nextState,
        version: boardTasks[taskIndex]!.version + 1,
      }
      boardTasks.splice(taskIndex, 1, task)
      return route.fulfill({ contentType: 'application/json', json: { task } })
    }
    return route.fallback()
  })

  await page.goto('/?view=chat&app=kanban')
  const board = page.getByRole('region', { name: 'Task board' })
  const planned = board.getByRole('region', { name: 'Planned' })
  const queued = board.getByRole('region', { name: 'Queued' })
  const inProgress = board.getByRole('region', { name: 'In progress' })
  const completed = board.getByRole('region', { name: 'Completed' })
  const taskTrigger = planned.getByRole('button', { name: 'Launch planning', exact: true })

  await expect(taskTrigger).toBeVisible()
  await expect(planned.locator('[data-slot="board-column-count"]')).toHaveText('1')
  await expect(queued.locator('[data-slot="board-column-count"]')).toHaveText('1')
  await expect(planned.getByLabel('Priority: High')).toBeVisible()
  // Empty lanes fold to a sideways label; lanes holding cards stay open.
  await expect(inProgress).toHaveAttribute('data-collapsed', '')
  await expect(planned).not.toHaveAttribute('data-collapsed', '')
  await expect(planned.getByText('Prepare the launch brief and confirm audience.')).toBeVisible()
  await expect(planned.getByText('Research Agent')).toBeVisible()
  await expect(planned.getByText('Product', { exact: true })).toBeVisible()
  await expect(queued.getByRole('button', { name: 'Review launch', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('task-board.png'), animations: 'disabled' })

  await taskTrigger.focus()
  await page.keyboard.press('Control+ArrowRight')
  await expect(queued.getByRole('button', { name: 'Launch planning', exact: true })).toBeVisible()
  await expect(planned.locator('[data-slot="board-column-count"]')).toHaveText('0')
  await expect(queued.locator('[data-slot="board-column-count"]')).toHaveText('2')
  await expect.poll(() => taskActions).toContain('task-launch/queue')
  const queuedCard = queued
    .getByRole('button', { name: 'Launch planning', exact: true })
    .locator('xpath=ancestor::article[@aria-roledescription="Draggable card"]')
  await expect(queuedCard).toBeFocused()
  await queuedCard.dragTo(planned)
  await expect(planned.locator('[data-slot="board-column-count"]')).toHaveText('0')
  await expect(queued.locator('[data-slot="board-column-count"]')).toHaveText('2')
  await expect.poll(() => taskActions).toEqual(['task-launch/queue'])

  await queuedCard.focus()
  await page.keyboard.press('Control+ArrowRight')
  await expect(
    inProgress.getByRole('button', { name: 'Launch planning', exact: true })
  ).toBeVisible()
  await expect(queued.locator('[data-slot="board-column-count"]')).toHaveText('1')
  await expect(inProgress.locator('[data-slot="board-column-count"]')).toHaveText('1')
  await expect.poll(() => taskActions).toContain('task-launch/start')

  const inReview = board.getByRole('region', { name: 'In review' })
  const launchCard = inProgress
    .getByRole('button', { name: 'Launch planning', exact: true })
    .locator('xpath=ancestor::article[@aria-roledescription="Draggable card"]')
  await inReview.scrollIntoViewIfNeeded()
  await launchCard.dragTo(inReview)
  await expect(inReview.getByRole('button', { name: 'Launch planning', exact: true })).toBeVisible()
  await expect(inProgress.locator('[data-slot="board-column-count"]')).toHaveText('0')
  await expect(inReview.locator('[data-slot="board-column-count"]')).toHaveText('1')
  await expect.poll(() => taskActions).toContain('task-launch/review')
  const inReviewCard = inReview
    .getByRole('button', { name: 'Launch planning', exact: true })
    .locator('xpath=ancestor::article[@aria-roledescription="Draggable card"]')
  await expect(inReviewCard).toBeFocused()
  await page.keyboard.press('Control+ArrowRight')
  await expect(
    completed.getByRole('button', { name: 'Launch planning', exact: true })
  ).toBeVisible()
  await expect(inReview.locator('[data-slot="board-column-count"]')).toHaveText('0')
  await expect(completed.locator('[data-slot="board-column-count"]')).toHaveText('1')
  await expect.poll(() => taskActions).toContain('task-launch/complete')
  const completedCard = completed
    .getByRole('button', { name: 'Launch planning', exact: true })
    .locator('xpath=ancestor::article[@aria-roledescription="Draggable card"]')
  await expect(completedCard).toBeFocused()
})

test('supports narrow navigation, keyboard search, and dark mode', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockWorkspace(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Expand contextual sidebar' })).toBeVisible()
  await page.getByRole('button', { name: 'Expand contextual sidebar' }).click()
  const navigation = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(navigation).toBeVisible()
  // The modal sheet marks the frame aria-hidden, so the toolbar toggle is
  // unreachable for role queries; match it through the DOM instead. The DOM
  // query must be scoped: the default trailing toggle also carries the
  // contextual-sidebar label while its group is display:none below 48rem.
  await expect(
    page
      .locator('.workspace-topbar__navigation-controls')
      .locator('[aria-label="Collapse contextual sidebar"]')
  ).toHaveAttribute('aria-expanded', 'true')
  await expect(navigation.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(projectTree(navigation)).toBeVisible()
  await expect(navigation.getByRole('region', { name: 'Conversations' })).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-narrow-light.png', { animations: 'disabled' })
  // The published sheet owns the close chrome next to the navigation aside.
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  const contextualToggle = page.getByRole('button', { name: 'Expand contextual sidebar' })
  // Finish the sheet's close/focus-restoration transition before opening the
  // next overlay, so Search captures a persistent opener rather than its
  // departing close button.
  await expect(navigation).not.toBeVisible()
  await expect(contextualToggle).toBeFocused()

  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Search workspace' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Search workspace' })).not.toBeVisible()
  await expect(contextualToggle).toBeFocused()
  const workspaceMain = page.locator('#workspace-main')
  await workspaceMain.focus()
  await expect(workspaceMain).toBeFocused()
  // Dismissing the sheet mounts the collapsed toggle under the parked pointer;
  // move to the empty page corner before capturing the settled dark workspace.
  await page.mouse.move(0, 0)
  await expect(page.getByRole('tooltip')).toHaveCount(0)

  await page.evaluate(() => {
    localStorage.setItem('theme', 'dark')
    document.documentElement.classList.remove('light')
    document.documentElement.classList.add('dark')
  })
  await expect(page).toHaveScreenshot('workspace-narrow-dark.png', { animations: 'disabled' })
})

test('keeps contextual section actions visible on touch devices', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })

  try {
    const page = await context.newPage()
    await mockWorkspace(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Expand contextual sidebar' }).click()

    const navigation = page.getByRole('complementary', { name: 'Workspace navigation' })
    await expect(createProjectButton(navigation)).toBeVisible()
    await expect(navigation.getByRole('button', { name: 'New workspace' })).toBeVisible()
    await expect(
      navigation.getByRole('button', { name: 'Create group conversation' })
    ).toBeVisible()
  } finally {
    await context.close()
  }
})

test('operates unread actions and deep-linked search entirely by keyboard', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/')
  // The project's default conversation leaf carries the unread badge.
  await expect(
    projectConversation(page, 'Product').locator('[data-slot="workspace-nav-unread"]')
  ).toBeVisible({ timeout: 15_000 })

  await page.keyboard.press('Control+k')
  const globalSearch = page.getByRole('dialog', { name: 'Search workspace' })
  const searchInput = globalSearch.getByRole('combobox', { name: 'Search workspace' })
  const results = globalSearch.getByRole('listbox', { name: 'Search results' })
  const options = results.getByRole('option')
  await expect(searchInput).toBeFocused()
  await expect(options).toHaveCount(13)

  const supportPrefetch = page.waitForRequest((request) =>
    request.url().includes('/channels/channel-support/messages')
  )
  await searchInput.press('ArrowDown')
  await searchInput.press('ArrowDown')
  await searchInput.press('ArrowDown')
  const supportChannel = globalSearch.getByRole('option', {
    name: /Support Project conversation/,
  })
  await expect(supportChannel).toHaveAttribute('aria-selected', 'true')
  expect(await searchInput.getAttribute('aria-controls')).toBe(await results.getAttribute('id'))
  expect(await searchInput.getAttribute('aria-activedescendant')).toBe(
    await supportChannel.getAttribute('id')
  )
  await supportPrefetch

  await searchInput.fill('launch brief')
  await expect(globalSearch.getByRole('option', { name: /launch-brief\.md/ })).toBeVisible()
  await expect(searchInput).toBeFocused()
  await expect(globalSearch.getByRole('option', { name: /launch-brief\.md/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'launch-brief.md' })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+f')
  const conversationSearch = page.getByRole('dialog', { name: 'Search this conversation' })
  await conversationSearch.getByRole('combobox', { name: 'Search workspace' }).fill('durable')
  await expect(conversationSearch.getByRole('option', { name: /durable workspace/ })).toBeVisible()
  await page.keyboard.press('Enter')
  // The shared message row signals `highlighted` with design tokens instead of
  // the app-local `conventional-message--highlighted` class, and makes the
  // jumped-to row programmatically focusable.
  const jumpedTo = page.locator('[data-message-id="message-root"]')
  await expect(jumpedTo).toHaveClass(/bg-primary-subtle shadow-\[inset_3px_0_var\(--primary\)\]/)
  await expect(jumpedTo).toHaveAttribute('tabindex', '-1')

  const unreadRequest = page.waitForRequest((request) =>
    request.url().includes('/read-state/channels/channel-product')
  )
  await page.keyboard.press('Control+Shift+u')
  expect((await unreadRequest).postDataJSON()).toEqual({ action: 'unread' })
})

test('shared sidebar reports failed mark-all-read actions and preserves Virtual status', async ({
  page,
}) => {
  await mockWorkspace(page)
  await page.route('**/api/v1/workspaces/workspace-e2e/read-state', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        contentType: 'application/json',
        json: { error: 'temporary failure' },
        status: 503,
      })
      return
    }
    await route.fallback()
  })
  await page.goto('/?view=chat')

  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(sidebar.getByRole('button', { name: 'Mark all read' })).toBeEnabled()
  await sidebar.getByRole('button', { name: 'Mark all read' }).click()
  await expect(sidebar.getByRole('alert')).toContainText(
    'Unread conversations could not be marked as read.'
  )

  const toolbar = page.getByLabel('Workspace toolbar')
  await page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('button', { name: 'Virtual view', exact: true })
    .click()
  const virtualSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(virtualSidebar.getByRole('button', { name: 'Mark all read' })).toBeEnabled()
  await virtualSidebar.getByRole('button', { name: 'Mark all read' }).click()
  await expect(virtualSidebar.getByRole('alert')).toContainText(
    'Unread conversations could not be marked as read.'
  )
  await toolbar.getByRole('button', { name: 'Collapse contextual sidebar' }).click()
  await expect(virtualSidebar).toBeHidden()
  const viewportWidth = await page
    .locator('.workspace-scene-viewport')
    .evaluate((element) => element.getBoundingClientRect().width)
  const shellWidth = await page
    .locator('.workspace-shell--contextual')
    .evaluate((element) => element.getBoundingClientRect().width)
  expect(viewportWidth).toBeGreaterThanOrEqual(shellWidth - 1)
  await toolbar.getByRole('button', { name: 'Expand contextual sidebar' }).click()
  await expect(virtualSidebar).toBeVisible()
  await expect(virtualSidebar.getByRole('alert')).toContainText(
    'Unread conversations could not be marked as read.'
  )
})

test('workspace search keeps duplicate destination labels tied to their domain identity', async ({
  page,
}) => {
  await mockWorkspace(page)
  await page.goto('/')
  // Control+k pressed during the first paint lands before the workspace
  // installs its shortcut listener, so anchor on loaded chrome first.
  // The project's default conversation leaf carries the unread badge.
  await expect(
    projectConversation(page, 'Product').locator('[data-slot="workspace-nav-unread"]')
  ).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Control+k')

  const dialog = page.getByRole('dialog', { name: 'Search workspace' })
  const input = dialog.getByRole('combobox', { name: 'Search workspace' })
  const results = dialog.getByRole('listbox', { name: 'Search results' })
  const project = results.getByRole('option', { name: 'Support Project', exact: true })
  const channel = results.getByRole('option', { name: 'Support Project conversation', exact: true })
  await expect(results.getByRole('option')).toHaveCount(13)

  const channelPrefetch = page.waitForRequest((request) =>
    request.url().includes('/channels/channel-support/messages')
  )
  await channel.hover()
  await channelPrefetch
  await expect(channel).toHaveAttribute('aria-selected', 'true')
  await expect(project).toHaveAttribute('aria-selected', 'false')
  // The result label's emphasis draws the dialog's real foreground token;
  // an undefined custom property would silently fall back to inheritance.
  const emphasisPaint = await page.evaluate(() => {
    const searchField = document.querySelector<HTMLInputElement>(
      'input[placeholder="Find a Project, conversation, Agent, or Task"]'
    )
    const option = searchField
      ?.closest('[role="dialog"]')
      ?.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')
    const emphasis = option?.querySelector('strong')
    if (!emphasis) return null
    // The dialog portals outside the workspace frame; the --cw-* aliases
    // resolve at :root (#1115), so read the token where the emphasis sits.
    return {
      emphasis: getComputedStyle(emphasis).color,
      text: getComputedStyle(emphasis).getPropertyValue('--cw-text').trim(),
    }
  })
  expect(parseColor(emphasisPaint!.emphasis)).toEqual(parseColor(emphasisPaint!.text))
  expect(await input.getAttribute('aria-activedescendant')).toBe(await channel.getAttribute('id'))
})

test('global rail opens workspace search from Virtual and Dev', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/?view=virtual')
  await expect(workspaceNav(page)).toBeVisible({ timeout: 20_000 })

  const searchDialog = page.getByRole('dialog', { name: 'Search workspace' })
  await page.keyboard.press('Control+k')
  await expect(searchDialog).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(/view=chat/)
  await page.keyboard.press('Escape')
  await expect(searchDialog).toBeHidden()

  await page.goto('/?view=dev&devE2e=preserved')
  await expect(page.getByRole('button', { name: 'Dev view', exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await page.keyboard.press('Control+k')
  await expect(searchDialog).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(/view=chat/)
})

test('retains drafts across navigation and reloads at supported breakpoints', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/')
  const draft = 'Evidence to preserve while I check another conversation.'
  await page.getByRole('textbox', { name: 'Message' }).fill(draft)
  await page.getByRole('button', { name: 'Research Agent', exact: true }).click()
  await projectConversation(page, 'Product').click()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(draft)
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(draft)

  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 })
    await expect(page.locator('.conventional-workspace')).toBeVisible()
    const viewport = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }))
    expect(viewport.documentWidth).toBe(viewport.viewportWidth)
  }
})

test('the live appearance popover previews the visible workspace at wide and narrow widths', async ({
  page,
}) => {
  await mockWorkspace(page)
  const popup = page.getByRole('dialog', { name: 'Appearance', exact: true })
  const appearanceControl = page.getByRole('button', { name: 'Appearance settings', exact: true })
  // The control lazy-loads the appearance panel, and the cold-server flake can
  // strike at any point of that import: the SSR shell renders the same button
  // enabled (a click there lands on no listener), and a dev-server reload
  // drops a hydrated page back to the shell. Drive the open as a self-healing
  // loop — re-navigate to a hydrated workspace whenever the shell regressed,
  // then open through the trigger's own state.
  await expect(async () => {
    const hydrated = await page
      .getByRole('complementary', { name: 'Workspace navigation' })
      .isVisible()
      .catch(() => false)
    if (!hydrated) {
      await page.goto('/?view=chat&scene=work', { timeout: 30_000 })
    }
    await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(appearanceControl).toBeEnabled({ timeout: 30_000 })
    // Gate on the trigger's own state: isVisible lags the portal mount on a
    // loaded machine, and a blind re-click would toggle the popover closed.
    if ((await appearanceControl.getAttribute('aria-expanded')) !== 'true') {
      await appearanceControl.click()
    }
    await expect(popup).toBeVisible()
  }).toPass({ timeout: 120_000 })
  const modes = popup.getByRole('radiogroup', { name: 'Appearance mode' })
  // The editor's sheet body is the scroll container, and pointer or focus
  // work during the open loop can leave it scrolled; a taller option list
  // scrolls farther, so each capture pins the scroll to the top first to
  // stay deterministic.
  const settleSheet = async () => {
    await popup
      .locator('div.overflow-y-auto')
      .first()
      .evaluate((node) => {
        node.scrollTop = 0
      })
    await page.waitForTimeout(150)
  }
  await modes.getByText('Light', { exact: true }).click()
  await settleSheet()
  await expect(page).toHaveScreenshot('workspace-appearance-popover-light.png', {
    animations: 'disabled',
  })
  await modes.getByText('Dark', { exact: true }).click()
  await settleSheet()
  await expect(page).toHaveScreenshot('workspace-appearance-popover-dark.png', {
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleSheet()
  await expect(page).toHaveScreenshot('workspace-appearance-popover-narrow.png', {
    animations: 'disabled',
  })
})

// The two-toned overlay bands (packages/ui/src/styles/theme.css) paint --muted
// on the published sheet header/footer and the settings dialog header. The
// pixel lanes cannot gate them: the band's contrast against the panel surface
// sits far below toHaveScreenshot's perceptual threshold, and a dev-server
// cold start can transiently serve a page whose stylesheet predates the route
// CSS assembly (the 2026-10-06 linux-lane divergence). This gate therefore
// asserts the computed paint directly, so a selector drift, a cascade demotion
// below the published utilities, or an incompletely assembled stylesheet fails
// loudly instead of silently baking a flat render into the baselines.
test('overlay bands paint the muted rung on sheets and the settings dialog', async ({ page }) => {
  await mockWorkspace(page)
  const probeSheetBands = () =>
    page.evaluate(() => {
      const header = document.querySelector("[data-slot='sheet-header']")
      const footer = document.querySelector("[data-slot='sheet-footer']")
      const body = document.querySelector("[data-slot='sheet-body']")
      return {
        mutedToken: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(),
        sheetHeader: header ? getComputedStyle(header).backgroundColor : null,
        sheetFooter: footer ? getComputedStyle(footer).backgroundColor : null,
        sheetBody: body ? getComputedStyle(body).backgroundColor : null,
      }
    })

  // The appearance sheet carries all three published sheet parts.
  const popup = page.getByRole('dialog', { name: 'Appearance', exact: true })
  const appearanceControl = page.getByRole('button', { name: 'Appearance settings', exact: true })
  await expect(async () => {
    const hydrated = await page
      .getByRole('complementary', { name: 'Workspace navigation' })
      .isVisible()
      .catch(() => false)
    if (!hydrated) {
      await page.goto('/?view=chat&scene=work', { timeout: 30_000 })
    }
    await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(appearanceControl).toBeEnabled({ timeout: 30_000 })
    if ((await appearanceControl.getAttribute('aria-expanded')) !== 'true') {
      await appearanceControl.click()
    }
    await expect(popup).toBeVisible()
  }).toPass({ timeout: 120_000 })
  const modes = popup.getByRole('radiogroup', { name: 'Appearance mode' })
  await modes.getByText('Light', { exact: true }).click()
  const sheet = await probeSheetBands()
  const muted = parseColor(sheet.mutedToken)
  expect(muted.length).toBe(3)
  expect(parseColor(sheet.sheetHeader!)).toEqual(muted)
  expect(parseColor(sheet.sheetFooter!)).toEqual(muted)
  expect(parseColor(sheet.sheetBody!)).not.toEqual(muted)

  // The settings dialog's band is the published ModalDialog settings header,
  // so it is probed on its own surface.
  await page.goto('/#settings/privacy-data')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  const dialogBands = await settings.evaluate((dialog) => {
    const header = dialog?.querySelector("[data-slot='dialog-header']")
    return {
      mutedToken: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(),
      header: header ? getComputedStyle(header).backgroundColor : null,
      panel: dialog ? getComputedStyle(dialog).backgroundColor : null,
    }
  })
  const dialogMuted = parseColor(dialogBands.mutedToken)
  expect(dialogMuted.length).toBe(3)
  expect(parseColor(dialogBands.header!)).toEqual(dialogMuted)
  expect(parseColor(dialogBands.header!)).not.toEqual(parseColor(dialogBands.panel!))
})

test('deep-links settings and customizes an Agent without fabricating runtime status', async ({
  page,
}, testInfo) => {
  await mockWorkspace(page)
  const profileId = 'prf_01JABCDEF0123456789ABCDEFG'
  const profileVersion = 'pfv_01JABCDEF0123456789ABCDEFH'
  await page.route('**/api/v1/workspaces/*/agents', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      contentType: 'application/json',
      json: [
        {
          ...agents[0],
          profile: {
            ...agents[0]!.profile,
            id: profileId,
            version: 'pfv_01JABCDEF0123456789ABCDEFG',
            revision: 0,
          },
        },
        ...agents.slice(1),
      ],
    })
  })
  await page.goto('/#settings/privacy-data')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('heading', { name: 'Privacy & data' })).toBeVisible()
  await expect(settings.getByText('Unavailable in this app or on this device.')).toBeVisible()

  await settings.getByRole('tab', { name: 'Input & notifications' }).click()
  await expect(settings.getByRole('button', { name: 'Check microphone' })).toBeDisabled()
  const mentionSwitch = settings.getByRole('switch', { name: 'Mention notifications' })
  const mentionSwitchControl = mentionSwitch.locator('xpath=following-sibling::*[1]')
  await mentionSwitchControl.click()
  await expect(mentionSwitch).not.toBeChecked()
  await mentionSwitch.press('Space')
  await expect(mentionSwitch).toBeChecked()
  await mentionSwitch.press('Space')
  await expect(mentionSwitch).not.toBeChecked()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem('adea:workspace-preferences:v1')
        return raw ? JSON.parse(raw).notifyMentions : undefined
      })
    )
    .toBe(false)
  await page.reload()
  const reloadedSettings = page.getByRole('dialog', { name: 'Settings' })
  await expect(reloadedSettings).toBeVisible()
  await expect(
    reloadedSettings.getByRole('switch', { name: 'Mention notifications' })
  ).not.toBeChecked()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(page).toHaveScreenshot('workspace-settings-light.png', { animations: 'disabled' })
  await page.evaluate(() => {
    localStorage.setItem('theme', 'dark')
    document.documentElement.classList.remove('light')
    document.documentElement.classList.add('dark')
  })
  await expect(page).toHaveScreenshot('workspace-settings-dark.png', { animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  // Crossing below 48rem closes the shared navigation; that path must not
  // dismiss the dialog the test is capturing.
  await expect(reloadedSettings).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-settings-narrow.png', { animations: 'disabled' })
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth)
  ).toBe(true)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.evaluate(() => {
    localStorage.setItem('theme', 'light')
    document.documentElement.classList.remove('dark')
    document.documentElement.classList.add('light')
  })

  await settings.getByRole('tab', { name: 'Agents' }).focus()
  await page.keyboard.press('End')
  // 'permissions' is the newest section, so it owns the End edge now.
  await expect(settings.getByRole('tab', { name: 'Permissions' })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(settings.getByRole('tab', { name: 'Account & app' })).toBeFocused()
  await settings.getByRole('tab', { name: 'Agents' }).click()
  await settings.getByRole('button', { name: 'Customize Agents' }).click()

  const configured = page.getByText('Configured', { exact: true }).first()
  await expect(configured).toBeVisible()
  await expect(page.getByText('Runtime unknown', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Activity unknown', { exact: true }).first()).toBeVisible()
  expect((await page.locator('.conventional-agent-card').allTextContents()).join(' ')).not.toMatch(
    /online|working/i
  )

  await page.getByRole('button', { name: 'Customize', exact: true }).first().click()
  const form = page.locator('form.conventional-agent-customization')
  // The bold label is the grid's field header; the controls themselves keep
  // the normal weight, and the native select fills its grid column so its
  // chevron sits at the select's edge instead of the column's end.
  const fieldPaint = await form.evaluate((formElement) => {
    const input = formElement.querySelector<HTMLInputElement>('input[name="name"]')
    const select = formElement.querySelector<HTMLSelectElement>('select[name="projectId"]')
    const selectWrapper = select?.parentElement
    if (!input || !select || !selectWrapper) return null
    return {
      inputWeight: getComputedStyle(input).fontWeight,
      selectWidth: getComputedStyle(select).width,
      wrapperWidth: getComputedStyle(selectWrapper).width,
    }
  })
  expect(fieldPaint).not.toBeNull()
  expect(fieldPaint!.inputWeight).toBe('400')
  expect(fieldPaint!.selectWidth).toBe(fieldPaint!.wrapperWidth)
  await form.getByLabel('Name').fill('Research Lead')
  await form.getByLabel('Role or persona').fill('Market evidence and customer research')
  await form.getByLabel('Project').selectOption('project-support')
  await form.getByLabel('Profile version ID').fill(profileVersion)
  const presentation = page.waitForRequest((request) => request.url().endsWith('/presentation'))
  const project = page.waitForRequest((request) => request.url().endsWith('/project'))
  const profile = page.waitForRequest((request) => request.url().endsWith('/profile'))
  await form.getByRole('button', { name: 'Save changes' }).click()
  expect((await presentation).postDataJSON()).toMatchObject({
    expectedRevision: 0,
    name: 'Research Lead',
  })
  // The placement edit chains the revision the presentation response returned.
  expect((await project).postDataJSON()).toEqual({
    expectedRevision: 1,
    projectId: 'project-support',
  })
  expect((await profile).postDataJSON()).toMatchObject({
    profileId,
    profileVersion,
    expectedRevision: 0,
  })

  await page.getByRole('button', { name: 'Customize', exact: true }).first().click()
  await expect(page.getByText('Permanent deletion is unavailable')).toBeVisible()
  await page.getByRole('button', { name: 'Archive Agent' }).click()
  await expect(page.getByRole('alertdialog', { name: 'Archive Research Agent' })).toBeVisible()
  await expect(page).toHaveScreenshot('workspace-agent-customization.png', {
    animations: 'disabled',
  })
  await page
    .getByRole('alertdialog', { name: 'Archive Research Agent' })
    .getByRole('button', { name: 'Cancel' })
    .click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const mode of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.classList.remove('light', 'dark')
      document.documentElement.classList.add(theme)
    }, mode)
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const version = form.getByLabel('Profile version ID')
      await version.focus()
      await page.keyboard.press('Tab')
      await expect(form.getByRole('button', { name: 'Save changes' })).toBeFocused()
      const bounds = await version.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`agent-profile-${mode}-${width}.png`) })
      if (width === 320) {
        await form.getByLabel('Profile ID', { exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: testInfo.outputPath(`agent-profile-${mode}-320-fields.png`) })
      }
    }
  }
  // The production client surfaces the opening-revision conflict, with no provider text.
  await page.route('**/agents/agent-research/profile', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      json: { code: 'AGENT_PROFILE_CONFLICT', message: 'private-provider-canary' },
    })
  )
  await form.getByLabel('Profile version ID').fill(profileVersion)
  await form.getByRole('button', { name: 'Save changes' }).click()
  await expect(form.getByRole('alert')).toContainText('review the current version')
  await expect(form).not.toContainText('private-provider-canary')
})

test('Agent profile remediation preserves the exact pin across blocked states and catalog outages', async ({
  page,
}, testInfo) => {
  await mockWorkspace(page)
  const states = [
    'deprecated',
    'revoked',
    'missing',
    'incompatible',
    'unapproved',
    'unavailable',
  ] as const
  const profileId = 'prf_01JABCDEF0123456789ABCDEFG'
  const profileVersion = 'pfv_01JABCDEF0123456789ABCDEFG'
  await page.route('**/api/v1/workspaces/*/agents', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: states.map((state) => ({
        ...agents[0],
        id: `agent-${state}`,
        name: `${state} Agent`,
        profile: {
          id: profileId,
          version: profileVersion,
          revision: 7,
          state,
          checkedAt: timestamp,
        },
      })),
    })
  )
  await page.goto('/#settings/agents')
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Customize Agents' })
    .click()
  for (const state of states) {
    const card = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: `${state} Agent`, exact: true }) })
    await expect(card).toContainText(profileId)
    await expect(card).toContainText(profileVersion)
    await expect(card).not.toContainText('Configured')
    await expect(card).toContainText(
      state === 'unavailable' ? 'selected version is unchanged' : 'Customize'
    )
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.classList.remove('light', 'dark')
      document.documentElement.classList.add(value)
    }, theme)
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      await page.screenshot({
        path: testInfo.outputPath(`profile-remediation-${theme}-${width}.png`),
      })
    }
  }
  const revoked = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'revoked Agent', exact: true }) })
  await revoked.getByRole('button', { name: 'Customize', exact: true }).focus()
  await page.keyboard.press('Enter')
  const form = page.locator('form.conventional-agent-customization')
  await expect(form.getByLabel('Profile ID', { exact: true })).toHaveValue(profileId)
  await expect(form.getByLabel('Profile version ID')).toHaveValue(profileVersion)
})

test('the settings dialog survives re-selecting its active tab and keeps its dismissal contract', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await mockWorkspace(page)
  await page.goto('/#settings/account')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()

  // Re-clicking the already-selected trigger must keep the dialog open (#601):
  // re-writing the current `#settings/…` hash re-resolved the route, whose
  // server-only entry loader then ran on the client, crashed the route, and
  // unmounted the whole workspace behind the error surface.
  await settings.getByRole('tab', { name: 'Account & app' }).click()
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('tab', { name: 'Account & app' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  await expect(page).toHaveURL(/#settings\/account$/)

  // Escape dismisses per the dialog convention and leaves no inert background.
  await page.keyboard.press('Escape')
  await expect(settings).not.toBeVisible()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  expect(await page.locator('[inert]').count()).toBe(0)

  // Outside pointerdown dismisses per the same convention.
  await page.getByRole('button', { name: 'User settings' }).click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await expect(settings).toBeVisible()
  await page.mouse.click(24, 400)
  await expect(settings).not.toBeVisible()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  expect(await page.locator('[inert]').count()).toBe(0)
  expect(pageErrors).toEqual([])
})

for (const { width, fontSize } of [
  { width: 320, fontSize: '100%' },
  { width: 768, fontSize: '100%' },
  { width: 1440, fontSize: '100%' },
  { width: 320, fontSize: '200%' },
]) {
  test(`settings tabs keep shared vertical keyboard focus at ${width}px and ${fontSize}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await mockWorkspace(page)
    await page.goto('/#settings/account')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings).toBeVisible()
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size
    }, fontSize)

    const tablist = settings.getByRole('tablist', { name: 'Settings sections' })
    const account = tablist.getByRole('tab', { name: 'Account & app', exact: true })
    const appearance = tablist.getByRole('tab', { name: 'Appearance', exact: true })
    const agentsTab = tablist.getByRole('tab', { name: 'Agents', exact: true })
    const permissions = tablist.getByRole('tab', { name: 'Permissions', exact: true })
    await expect(tablist).toHaveAttribute('data-slot', 'settings-navigation')
    await expect(tablist).toHaveAttribute('aria-orientation', 'vertical')

    await account.focus()
    await page.keyboard.press('ArrowDown')
    await expect(appearance).toBeFocused()
    await expect(appearance).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/#settings\/appearance$/)

    // Workspace-scoped sections moved to the workspace settings dialog, so
    // Appearance hands straight over to Agents.
    await page.keyboard.press('ArrowDown')
    await expect(agentsTab).toBeFocused()
    await expect(agentsTab).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/#settings\/agents$/)

    await page.keyboard.press('Home')
    await expect(account).toBeFocused()
    await expect(page).toHaveURL(/#settings\/account$/)

    await page.keyboard.press('End')
    await expect(permissions).toBeFocused()
    // Font metrics shift fractional line heights at the narrow widths, so the
    // scrolled-in tab can sit a sub-pixel outside the viewport; require the
    // focus target to be visible, not pixel-exact.
    await expect(permissions).toBeInViewport({ ratio: 0.99 })
    await expect(
      settings.getByRole('heading', { name: 'Permissions', level: 3, exact: true })
    ).toBeInViewport({ ratio: 0.99 })
    await expect(page).toHaveURL(/#settings\/permissions$/)

    await page.keyboard.press('ArrowDown')
    await expect(account).toBeFocused()
    await expect(account).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/#settings\/account$/)
  })
}

test('the sidebar workspace gear opens the workspace settings dialog, not app Settings', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await mockWorkspace(page)
  await page.goto('/')
  await page.getByRole('button', { name: `Workspace settings for ${workspace.name}` }).click()
  const details = page.getByRole('dialog', { name: `${workspace.name} workspace settings` })
  await expect(details).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(/#workspace-settings\/general$/)
  const tablist = details.getByRole('tablist', { name: 'Workspace settings sections' })
  await expect(tablist.getByRole('tab')).toHaveText(['General', 'Memory', 'Skills', 'Connections'])
  const general = tablist.getByRole('tab', { name: 'General', exact: true })
  await expect(general).toHaveAttribute('aria-selected', 'true')
  await expect(details.getByRole('textbox', { name: 'Workspace name' })).toHaveValue(workspace.name)
  await expect(details.getByText('Changes save as you make them.')).toBeVisible()

  await general.focus()
  await page.keyboard.press('ArrowDown')
  await expect(tablist.getByRole('tab', { name: 'Memory', exact: true })).toBeFocused()
  await expect(page).toHaveURL(/#workspace-settings\/memory$/)
  await page.keyboard.press('End')
  await expect(tablist.getByRole('tab', { name: 'Connections', exact: true })).toBeFocused()
  await expect(page).toHaveURL(/#workspace-settings\/connections$/)

  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
  expect(new URL(page.url()).hash).toBe('')
  expect(await page.locator('[inert]').count()).toBe(0)
  expect(pageErrors).toEqual([])
})

for (const [legacy, tab] of [
  ['workspace', 'General'],
  ['memory', 'Memory'],
  ['skills', 'Skills'],
  ['connections', 'Connections'],
] as const) {
  test(`the retired #settings/${legacy} link opens workspace settings at ${tab}`, async ({
    page,
  }) => {
    await mockWorkspace(page)
    await page.goto(`/#settings/${legacy}`)
    const details = page.getByRole('dialog', { name: `${workspace.name} workspace settings` })
    await expect(details).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0)
    await expect(details.getByRole('tab', { name: tab, exact: true })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(page).toHaveURL(
      new RegExp(`#workspace-settings/${legacy === 'workspace' ? 'general' : legacy}$`)
    )
  })
}

test('the appearance section keeps the ported Zeron composition', async ({ page }) => {
  await mockWorkspace(page)
  // The appearance editor is the settings section now (the rail entry is gone,
  // #425), and the settings deep link is how the lane reaches a section.
  await page.goto('/#settings/appearance')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  const panel = page.getByRole('region', { name: 'Appearance', exact: true })
  await expect(panel).toBeVisible()
  // The three live mode cards: System renders the split light/dark miniature.
  await expect(panel.locator('[data-theme-miniature]')).toHaveCount(4)
  await expect(panel).toHaveScreenshot('appearance-panel-light.png', { animations: 'disabled' })
})

test('integrated chrome keeps the global rail while Virtual navigation collapses', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=virtual')
  const toolbar = page.getByLabel('Workspace toolbar')
  await expect(toolbar).toBeVisible()
  const navigation = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(navigation).toBeVisible()
  await expect(page.getByRole('main')).toHaveCount(1)
  await toolbar.getByRole('button', { name: 'Collapse contextual sidebar' }).click()
  await expect(navigation).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Global navigation' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'Expand contextual sidebar' }).click()
  await expect(navigation).toBeVisible()
  const bounds = await page.locator('.workspace-frame').evaluate((frame) => {
    const bar = frame.querySelector('[data-slot="top-bar"]')!.getBoundingClientRect()
    const rail = frame.querySelector('[data-global-rail]')!.getBoundingClientRect()
    return {
      sameWidth: bar.width === frame.getBoundingClientRect().width,
      below: rail.top >= bar.bottom,
    }
  })
  expect(bounds).toEqual({ sameWidth: true, below: true })
})

for (const designer of ['roomDesigner', 'characterDesigner'] as const) {
  test(`Virtual ${designer} keeps the global rail without contextual sidebars`, async ({
    page,
  }) => {
    await mockConnectedWorkspace(page)
    await page.goto(`/?view=chat&${designer}=1`)
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    await expect(
      page.getByRole('heading', { name: 'Virtual view lives in Agent Sim' })
    ).toBeVisible()
    // Edit mode drops the contextual sidebar on purpose: the designer fills the
    // viewport, and the top bar plus the designer's own close are the way back.
    await expect(sidebar).toHaveCount(0)
    await expect(page.getByRole('main')).toHaveCount(1)
    const fallback = page.getByRole('status', { name: 'Virtual view unavailable' })
    expect(
      await fallback.evaluate((element) => {
        const viewport = element.closest('.workspace-scene-viewport')!
        return {
          fillsViewport:
            element.getBoundingClientRect().height === viewport.getBoundingClientRect().height,
          height: element.getBoundingClientRect().height,
        }
      })
    ).toEqual({ fillsViewport: true, height: expect.any(Number) })
    expect(
      await fallback.evaluate((element) => element.getBoundingClientRect().height)
    ).toBeGreaterThan(600)
    const rail = page.getByRole('navigation', { name: 'Global navigation' })
    await expect(rail).toBeVisible()
    await expect(
      page.getByRole('complementary', { name: 'Shared developer utilities' })
    ).toHaveCount(0)
    const toolbar = page.getByLabel('Workspace toolbar')
    await expect(
      toolbar.getByRole('button', { name: /(?:Collapse|Expand) (?:contextual|utility) sidebar/ })
    ).toHaveCount(0)
    const bounds = await page.locator('.workspace-frame').evaluate((frame) => {
      const railBounds = frame.querySelector('[data-global-rail]')!.getBoundingClientRect()
      const surface = frame.querySelector('.workspace-frame__surface')!.getBoundingClientRect()
      return { railWidth: railBounds.width, gap: Math.abs(surface.left - railBounds.right) }
    })
    expect(bounds.railWidth).toBeGreaterThan(0)
    expect(bounds.gap).toBeLessThanOrEqual(1)
    await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
    await expect(rail).toBeVisible()
    await expect(page).not.toHaveURL(/(?:roomDesigner|characterDesigner)=1/)
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`${designer}=1`))
    await expect(
      page.getByRole('heading', { name: 'Virtual view lives in Agent Sim' })
    ).toBeVisible()
    await expect(sidebar).toHaveCount(0)
    await expect(rail).toBeVisible()
    await expect(
      toolbar.getByRole('button', { name: /(?:Collapse|Expand) (?:contextual|utility) sidebar/ })
    ).toHaveCount(0)
  })
}

test('Chat and Virtual use the same resizable sidebar and preserve selection and thread state', async ({
  page,
}) => {
  await mockWorkspace(page)
  await page.setViewportSize({ width: 1280, height: 840 })
  await page.goto('/?view=chat')

  const toolbar = page.getByLabel('Workspace toolbar')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const chatSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const expectAlignedDivider = async () => {
    for (const width of [1024, 1280]) {
      await page.setViewportSize({ width, height: 840 })
      await expect
        .poll(async () => {
          const sidebar = await chatSidebar.boundingBox()
          const divider = await toolbar.locator('[data-topbar-view-divider]').boundingBox()
          if (!sidebar || !divider) return Number.POSITIVE_INFINITY
          return Math.abs(divider.x - (sidebar.x + sidebar.width))
        })
        .toBeLessThanOrEqual(1)
    }
  }
  await expect(
    chatSidebar.getByRole('button', { name: 'Research Agent', exact: true })
  ).toBeVisible()
  await expect(chatSidebar.getByRole('button', { name: 'Launch group', exact: true })).toBeVisible()
  await expectAlignedDivider()
  await expect(
    projectConversation(chatSidebar, 'Product').locator('[data-slot="workspace-nav-unread"]')
  ).toBeVisible()

  await chatSidebar.getByRole('button', { name: 'Research Agent', exact: true }).click()
  await expect(page.getByText('Direct Conversation', { exact: true })).toBeVisible()
  const resizeHandle = page.getByRole('separator', { name: 'Resize workspace navigation' })
  const initialWidth = await chatSidebar.evaluate(
    (element) => element.getBoundingClientRect().width
  )
  await resizeHandle.focus()
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(() => chatSidebar.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(initialWidth)
  const resizedWidth = await chatSidebar.evaluate(
    (element) => element.getBoundingClientRect().width
  )
  await expectAlignedDivider()

  // The keyboard resize leaves :focus-visible on the handle, which is
  // interaction state rather than rendering identity; drop it so the capture
  // compares the sidebar itself.
  await resizeHandle.evaluate((element) => element.blur())
  // Capture each sidebar immediately after its own view switch: a freshly
  // mounted view rasterizes identically, while capturing chat straight after
  // the keyboard reflow can round the unread pill's antialiasing differently.
  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  const virtualSidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(virtualSidebar).toBeVisible()
  await expectAlignedDivider()
  await expect(
    virtualSidebar.getByRole('button', { name: 'Research Agent', exact: true })
  ).toHaveAttribute('aria-current', 'page')
  expect(await virtualSidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(
    resizedWidth
  )
  // Virtual renders the same tree in its own words (ADR 0011: projects are
  // rooms there), so the two sidebars share structure and width, not pixels.
  await expect(projectConversation(virtualSidebar, 'Product')).toBeVisible()
  await expect(
    virtualSidebar.getByRole('button', { name: 'New room in Work', exact: true })
  ).toBeVisible()

  await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
  await expect(page.getByText('Direct Conversation', { exact: true })).toBeVisible()
  expect(await chatSidebar.evaluate((element) => element.getBoundingClientRect().width)).toBe(
    resizedWidth
  )

  await projectConversation(page, 'Product').click()
  await page.getByRole('button', { name: 'Thread', exact: true }).first().click()
  // The shared thread panel titles itself through the aside's accessible name
  // ("Thread: <label>"); its visible "Thread" caption is a span, not a heading.
  await expect(
    page.getByRole('complementary', { name: 'Thread: Focused discussion' })
  ).toBeVisible()
  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  await expect(projectConversation(virtualSidebar, 'Product')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
  await expect(
    page.getByRole('complementary', { name: 'Thread: Focused discussion' })
  ).toBeVisible()

  await page.setViewportSize({ width: 390, height: 840 })
  // Narrow layouts start with the contextual sidebar collapsed, so the collapse
  // control is already gone; only click it if the sidebar survived the resize.
  if (await chatSidebar.isVisible()) {
    await toolbar.getByRole('button', { name: 'Collapse contextual sidebar' }).click()
  }
  await expect(chatSidebar).toBeHidden()
  await toolbar.getByRole('button', { name: 'Expand contextual sidebar' }).click()
  await expect(chatSidebar).toBeVisible()
  await expect(projectTree(chatSidebar)).toBeVisible()
  // At this width the expanded sidebar is a modal sheet that hides the rest of
  // the app (aria-hidden), so dismiss it before touching the rail.
  await page.keyboard.press('Escape')
  await expect(chatSidebar).toBeHidden()
  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  if (!(await virtualSidebar.isVisible())) {
    await toolbar.getByRole('button', { name: 'Expand contextual sidebar' }).click()
  }
  await expect(virtualSidebar).toBeVisible()
  await expect(projectTree(virtualSidebar, 'Work', 'rooms')).toBeVisible()
})

test('Virtual sidebar actions create a project and group conversation through workspace services', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=virtual')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  // Virtual names projects as rooms (ADR 0011); the dialog is the same.
  const newRoom = sidebar.getByRole('button', { name: 'New room in Work', exact: true })
  await expect(newRoom).toBeVisible()

  await newRoom.click()
  await page.getByRole('button', { name: 'Engineering', exact: true }).click()
  await expect(rail.getByRole('button', { name: 'Chat view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(projectConversation(page, 'Engineering')).toBeVisible()

  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  await expect(sidebar).toBeVisible()
  await sidebar.getByRole('button', { name: 'Create group conversation' }).click()
  const groupDialog = page.getByRole('dialog', { name: 'New group conversation' })
  await groupDialog.getByLabel('Conversation name').fill('Virtual group')
  await groupDialog.getByRole('button', { name: 'Create conversation' }).click()
  await expect(page.getByRole('button', { name: 'Virtual group', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  )
  await expect(page.getByText('Group conversation', { exact: true })).toBeVisible()
})

test.describe('touch workspace sidebar actions', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  })

  test('exposes row actions without hover and opens the project menu by touch', async ({
    page,
  }) => {
    await mockConnectedWorkspace(page)
    await page.goto('/?view=chat')

    // The frame-only opener is display:none in this layout, so open the
    // navigation through the top-bar toggle instead.
    const openNavigation = page.getByRole('button', { name: 'Expand contextual sidebar' })
    await expect(openNavigation).toBeVisible()
    await openNavigation.tap()

    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    const projectOptions = sidebar.getByRole('button', { name: 'Project options for Product' })
    const conversationOptions = sidebar.getByRole('button', {
      name: 'Conversation options for Research Agent',
    })
    await expect(projectOptions).toBeVisible()
    await expect(conversationOptions).toBeVisible()

    const projectActions = projectOptions.locator(
      'xpath=ancestor::*[contains(concat(" ", @class, " "), " workspace-nav-row-actions ")]'
    )
    const conversationActions = conversationOptions.locator(
      'xpath=ancestor::*[@data-slot="sidebar-nav-row-actions"]'
    )
    // Tree row actions are display:flex on a coarse pointer (no hover needed).
    await expect
      .poll(() => projectActions.evaluate((node) => getComputedStyle(node).display))
      .toBe('flex')
    await expect
      .poll(() => conversationActions.evaluate((node) => getComputedStyle(node).opacity))
      .toBe('1')

    await projectOptions.tap()
    // The row menu portals to the document body, outside the navigation aside.
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
  })

  test('keeps a navigation opened during boot open when the sidebar mounts', async ({ page }) => {
    await mockConnectedWorkspace(page)
    // Hold the bootstrap response: the shell must not resolve its workspace
    // until after the press below arms the store's open flag.
    let releaseBootstrap: (() => void) | undefined
    const bootGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve
    })
    // Registered last, so this gate shadows mockConnectedWorkspace's
    // bootstrap fulfilment while every other route falls through to it.
    await page.route('**/api/workspaces/bootstrap', async (route) => {
      await bootGate
      return route.fallback()
    })
    // Hold the chat entry chunk as well. While it loads, the frame renders
    // its own fallback — top bar and toggle present, sidebar absent — which
    // is the window in which a boot-time press can arm the open flag. Once
    // the chunk lands, the shell takes over and, with bootstrap still held,
    // hides the toggle (its bootstrap fallback renders no contextual
    // sidebar), so the press has to happen before this gate releases.
    let releaseEntry: (() => void) | undefined
    const entryGate = new Promise<void>((resolve) => {
      releaseEntry = resolve
    })
    await page.route('**/components/conventional-workspace-entry*', async (route) => {
      await entryGate
      return route.fallback()
    })

    await page.goto('/?view=chat')
    const toolbar = page.getByLabel('Workspace toolbar')
    const navigationToggle = toolbar.getByRole('button', {
      name: /^(Expand|Collapse) contextual sidebar$/,
    })
    await expect(page.locator('.conventional-workspace--loading')).toBeVisible()
    await expect(navigationToggle).toBeVisible()

    await navigationToggle.press('Enter')

    // The entry chunk lands; the shell mounts and holds bootstrap on its own
    // skeleton fallback, which hides the toggle. The armed flag has to
    // survive that unmount.
    releaseEntry!()
    await expect(page.locator('.conventional-skeleton')).toBeVisible()
    await expect(navigationToggle).toHaveCount(0)

    // Boot lands; the sidebar mounts with the open flag armed. The viewport
    // guard used to misread that mount as a desktop-to-narrow crossing and
    // force-close the flag, so the Sheet never appeared at all.
    releaseBootstrap!()
    const navigationDialog = page.getByRole('dialog')
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    await expect(navigationDialog).toHaveAttribute('data-expanded', '')
    await expect(sidebar).toBeVisible()
    await expect(sidebar.locator('button:not(:disabled)').first()).toBeFocused()

    // Give any late boot churn time to land, then re-assert: the Sheet must
    // not flip closed on its own.
    await page.waitForTimeout(1000)
    await expect(navigationDialog).toHaveAttribute('data-expanded', '')
    await expect(sidebar).toBeVisible()
  })

  test('keeps Chat and Virtual navigation controls inside a 320px viewport at 200% root size', async ({
    page,
  }) => {
    await mockConnectedWorkspace(page)
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto('/?view=chat')
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%'
    })

    const toolbar = page.getByLabel('Workspace toolbar')
    const navigationToggle = toolbar.getByRole('button', {
      name: /^(Expand|Collapse) contextual sidebar$/,
    })
    await expect(navigationToggle).toBeVisible()
    const toggleBounds = await navigationToggle.boundingBox()
    expect(toggleBounds).not.toBeNull()
    expect(toggleBounds!.x).toBeGreaterThanOrEqual(0)
    expect(toggleBounds!.x + toggleBounds!.width).toBeLessThanOrEqual(320)

    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    const assertSidebarFits = async () => {
      const layout = await sidebar.evaluate((element) => {
        const panel = element.getBoundingClientRect()
        const title = element.querySelector('h1')
        const titleBounds = title?.getBoundingClientRect()
        // The published sheet owns the close chrome; it sits in the dialog,
        // not inside the navigation aside.
        const close = document.querySelector('[role="dialog"] [aria-label="Close"]')
        const closeBounds = close?.getBoundingClientRect()
        const actionButtons = Array.from(
          element.querySelectorAll('[data-slot="sidebar-nav-row-actions"] button')
        )
        const labels = Array.from(
          element.querySelectorAll('[data-slot="sidebar-nav-label"]')
        ).filter((label) => label.closest('button'))
        const withinPanel = (bounds: DOMRect) =>
          bounds.left >= panel.left - 1 && bounds.right <= panel.right + 1

        return {
          actionBounds: actionButtons.map((button) => {
            // The sheet content scrolls at this size; bring each control into
            // view so the hit test measures the control, not the pinned
            // footer band or the viewport edge covering it off-screen.
            button.scrollIntoView({ block: 'center' })
            const bounds = button.getBoundingClientRect()
            const hitTarget = document.elementFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2
            )
            return {
              fits: withinPanel(bounds),
              receivesHit: hitTarget === button || button.contains(hitTarget),
            }
          }),
          closeFits: closeBounds ? withinPanel(closeBounds) : false,
          titleFits: titleBounds ? withinPanel(titleBounds) : false,
          labelBounds: labels.map((label) => {
            const bounds = label.getBoundingClientRect()
            const style = getComputedStyle(label)
            return {
              fits: withinPanel(bounds),
              minWidth: style.minWidth,
              textOverflow: style.textOverflow,
              width: bounds.width,
              whiteSpace: style.whiteSpace,
            }
          }),
          panel: { left: panel.left, right: panel.right, width: panel.width },
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        }
      })

      expect(layout.documentWidth).toBe(layout.viewportWidth)
      expect(layout.panel.left).toBeGreaterThanOrEqual(0)
      expect(layout.panel.right).toBeLessThanOrEqual(layout.viewportWidth + 1)
      expect(layout.closeFits).toBe(true)
      expect(layout.titleFits).toBe(true)
      expect(layout.actionBounds.length).toBeGreaterThan(0)
      expect(layout.actionBounds.every(({ fits, receivesHit }) => fits && receivesHit)).toBe(true)
      expect(layout.labelBounds.length).toBeGreaterThan(0)
      expect(
        layout.labelBounds.every(
          ({ fits, minWidth, textOverflow, width, whiteSpace }) =>
            fits &&
            width > 0 &&
            minWidth === '0px' &&
            textOverflow === 'ellipsis' &&
            whiteSpace === 'nowrap'
        )
      ).toBe(true)
      return layout
    }

    await navigationToggle.tap()
    await expect(sidebar).toBeVisible()
    await expect(projectConversation(sidebar, 'Product')).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Project options for Product' })).toBeVisible()
    await expect
      .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().left))
      .toBeGreaterThanOrEqual(0)
    const chatLayout = await assertSidebarFits()

    // The published sheet owns the close chrome next to the navigation aside.
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).tap()
    await page
      .getByRole('navigation', { name: 'Global navigation' })
      .getByRole('button', { name: 'Virtual view', exact: true })
      .tap()
    const expandVirtualNavigation = toolbar.getByRole('button', {
      name: 'Expand contextual sidebar',
    })
    await expect(expandVirtualNavigation).toBeVisible()
    await expandVirtualNavigation.tap()
    await expect(sidebar).toBeVisible()
    await expect
      .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().left))
      .toBeGreaterThanOrEqual(0)
    const virtualLayout = await assertSidebarFits()
    expect(virtualLayout.panel).toEqual(chatLayout.panel)
    expect(virtualLayout.actionBounds.length).toBe(chatLayout.actionBounds.length)
    expect(virtualLayout.labelBounds.map(({ width }) => width)).toEqual(
      chatLayout.labelBounds.map(({ width }) => width)
    )
  })

  test('mobile navigation traps focus, closes with Escape, and restores focus', async ({
    page,
  }) => {
    await mockConnectedWorkspace(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/?view=chat')

    const toolbar = page.getByLabel('Workspace toolbar')
    const navigationToggle = toolbar.getByRole('button', {
      name: /^(Expand|Collapse) contextual sidebar$/,
    })
    // Keyboard activation through the locator, not focus + a raw keypress:
    // the toolbar re-renders as boot responses land, a focus captured earlier
    // can be dropped before the keypress fires, and on loaded runners the
    // Enter then hits nothing and the sheet never opens. press() resolves the
    // button again under actionability right before pressing.
    await navigationToggle.press('Enter')

    const navigationDialog = page.getByRole('dialog')
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    const sidebarButtons = sidebar.locator('button:not(:disabled)')
    // Kobalte marks the open dialog with data-expanded rather than aria-modal;
    // the Tab-wrap assertions below prove the modality behaviorally.
    await expect(navigationDialog).toHaveAttribute('data-expanded', '')
    await expect(sidebar).toBeVisible()
    await expect(sidebarButtons.first()).toBeFocused()

    await page.keyboard.press('Shift+Tab')
    // The sheet's own close is the dialog's trailing focusable, so the wrap
    // backwards from the navigation content reaches it first.
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })
    ).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(sidebarButtons.first()).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(sidebar).not.toBeVisible()
    await expect(navigationToggle).toBeFocused()

    await navigationToggle.press('Enter')
    await expect(sidebar).toBeVisible()

    const createProject = createProjectButton(sidebar)
    await createProject.click()
    const projectDialog = page.getByRole('dialog', { name: 'Create Project' })
    await expect(projectDialog.locator(':focus')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(projectDialog).not.toBeVisible()
    await expect(sidebar).toBeVisible()
    await expect(createProject).toBeFocused()
    // The open sheet hides the toolbar from role queries, so query the DOM
    // directly; locator resolution would keep failing on the hidden element.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const toggle = document.querySelector(
            '[aria-label="Expand contextual sidebar"], [aria-label="Collapse contextual sidebar"]'
          )
          return Boolean(toggle) && toggle !== document.activeElement
        })
      )
      .toBe(true)

    const createGroup = sidebar.getByRole('button', { name: 'Create group conversation' })
    await createGroup.click()
    const groupDialog = page.getByRole('dialog', { name: 'New group conversation' })
    await expect(groupDialog.getByLabel('Conversation name')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(groupDialog).not.toBeVisible()
    await expect(sidebar).toBeVisible()
    await expect(createGroup).toBeFocused()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const toggle = document.querySelector(
            '[aria-label="Expand contextual sidebar"], [aria-label="Collapse contextual sidebar"]'
          )
          return Boolean(toggle) && toggle !== document.activeElement
        })
      )
      .toBe(true)

    await sidebar.getByRole('button', { name: 'Research Agent', exact: true }).click()
    await expect(sidebar).not.toBeVisible()
    await expect(navigationToggle).toBeFocused()
    await expect(page.locator('#workspace-main')).toContainText('Research Agent')
  })

  test('selecting navigation closes the shared mobile sheet in Chat and Virtual', async ({
    page,
  }) => {
    await mockConnectedWorkspace(page)
    await page.setViewportSize({ width: 390, height: 844 })

    for (const view of ['chat', 'virtual'] as const) {
      await page.goto(`/?view=${view}`)
      const toolbar = page.getByLabel('Workspace toolbar')
      const navigationToggle = toolbar.getByRole('button', {
        name: /^(Expand|Collapse) contextual sidebar$/,
      })
      await navigationToggle.press('Enter')

      const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
      await expect(sidebar).toBeVisible()
      await sidebar.getByRole('button', { name: 'Research Agent', exact: true }).click()
      await expect(sidebar).not.toBeVisible()
      await expect(navigationToggle).toHaveAttribute('aria-expanded', 'false')
      await expect(navigationToggle).toBeFocused()
    }
  })

  test('mobile Sheet reparenting preserves the persisted inline sidebar width', async ({
    page,
  }) => {
    await mockConnectedWorkspace(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(() => {
      localStorage.setItem('adea:workspace-sidebar-width', '320')
    })
    await page.goto('/?view=chat')

    const toolbar = page.getByLabel('Workspace toolbar')
    const navigationToggle = toolbar.getByRole('button', {
      name: /^(Expand|Collapse) contextual sidebar$/,
    })
    await navigationToggle.press('Enter')
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    await expect(sidebar).toBeVisible()

    await page.setViewportSize({ width: 1280, height: 844 })
    // Crossing to a wide viewport reparents the navigation into the inline
    // desktop aside; the mobile sheet instance stays mounted but hidden, so
    // target the desktop instance for the inline assertions.
    const inlineSidebar = page.locator('aside[data-contextual-sidebar="desktop"]')
    await expect(inlineSidebar).toBeVisible()
    await expect(
      page.getByRole('separator', { name: 'Resize workspace navigation' })
    ).toBeAttached()
    await expect
      .poll(() => inlineSidebar.evaluate((element) => element.getBoundingClientRect().width))
      .toBe(320)
  })
})

test('collapsed Chat navigation is absent from keyboard and accessibility navigation', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 840 })
    const toolbar = page.getByLabel('Workspace toolbar')
    const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
    const toggle = toolbar.getByRole('button', { name: /^(Expand|Collapse) contextual sidebar$/ })
    if (width < 768) {
      // Crossing below 48rem closes the sheet-backed navigation, so settle
      // that contract, reopen it, then collapse through the dialog's own
      // dismissal — the modal sheet hides the toolbar from role queries.
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await expect(sidebar).toBeVisible()
      await page.keyboard.press('Escape')
    } else {
      await expect(sidebar).toBeVisible()
      await toggle.click()
    }
    await expect(sidebar).toBeHidden()
    await expect(sidebar).toHaveCount(0)
    // A zero-width grid column alone clips pixels but leaves its controls in
    // the focus order and native accessibility tree. Below 48rem the panel
    // unmounts entirely; both cases must leave nothing focusable behind.
    expect(
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-conventional-sidebar] button'
        )
        if (!button) return false
        button.focus()
        return button === document.activeElement
      })
    ).toBe(false)
    await toolbar.getByRole('button', { name: 'Expand contextual sidebar' }).click()
    await expect(sidebar).toBeVisible()
  }
})

test('App Library enables views separately from Plugins and remains reachable with all apps disabled', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  const library = page.getByRole('main', { name: 'App Library' })
  await expect(library).toBeVisible()
  const viewGroup = rail.getByRole('group', { name: 'Workspace views' })
  const selectedRailActions = viewGroup.locator('button[aria-pressed="true"]')
  await expect(selectedRailActions).toHaveCount(1)
  await expect(selectedRailActions).toHaveAttribute('aria-label', 'App Library')
  for (const name of ['Virtual', 'Chat', 'Dev']) {
    await library.getByRole('button', { name: `Disable ${name}`, exact: true }).click()
  }
  await expect(rail.getByRole('button', { name: 'Chat view', exact: true })).toHaveCount(0)
  await expect(rail.getByRole('button', { name: 'Dev view', exact: true })).toHaveCount(0)
  await expect(rail.getByRole('button', { name: 'Virtual view', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(library).toBeVisible()
  // Search left the toolbar for the rail; the rail entry still routes to the
  // Library's app search when every app is disabled.
  await rail.getByRole('button', { name: 'Search workspace', exact: true }).click()
  await expect(library.getByRole('searchbox', { name: 'Search apps', exact: true })).toBeFocused()
  await library.getByRole('button', { name: 'Enable Chat', exact: true }).click()
  await library.getByRole('button', { name: 'Open Chat', exact: true }).click()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  await expect(rail.getByRole('button', { name: 'Chat view', exact: true })).toBeVisible()
  await rail.getByRole('button', { name: 'Plugins', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Plugins', exact: true })).toBeVisible()
  await expect(page.getByRole('main', { name: 'App Library' })).toHaveCount(0)
})

test('top bar history traverses app destinations and truncates a forward branch', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const toolbar = page.getByLabel('Workspace toolbar')
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  await expect(page.getByRole('main', { name: 'App Library' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'Forward', exact: true })).toBeEnabled()
  await toolbar.getByRole('button', { name: 'Forward', exact: true }).click()
  await expect(page.getByRole('main', { name: 'App Library' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'Back', exact: true }).click()
  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'Forward', exact: true })).toBeDisabled()
})

test('top bar Back, Forward and the context toggle each take their own hits at 320px', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const toolbar = page.getByLabel('Workspace toolbar')
  const back = toolbar.getByRole('button', { name: 'Back', exact: true })
  const forward = toolbar.getByRole('button', { name: 'Forward', exact: true })
  // Chat -> Virtual -> App Library, then Back to Virtual: both history
  // controls are enabled (a disabled control takes no pointer hits) on a
  // view whose bar carries the context toggle.
  await rail.getByRole('button', { name: 'Virtual view', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  await expect(page.getByRole('main', { name: 'App Library' })).toBeVisible()
  await back.click()
  await expect(page.getByRole('main', { name: 'App Library' })).toHaveCount(0)
  await expect(back).toBeEnabled()
  await expect(forward).toBeEnabled()

  await page.setViewportSize({ width: 320, height: 800 })
  const toggle = toolbar.getByRole('button', {
    name: /^(Expand|Collapse) contextual sidebar$/,
  })
  for (const fontSize of ['100%', '200%']) {
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size
    }, fontSize)
    for (const [name, control] of [
      ['Back', back],
      ['Forward', forward],
      ['context toggle', toggle],
    ] as const) {
      await expect(control, `${name} renders at 320px`).toBeVisible()
      // The auto start column used to squeeze these controls until a neighbour
      // painted over their edges; every sample across each one must hit it.
      const hits = await control.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          width: rect.width,
          height: rect.height,
          inViewport: rect.left >= 0 && rect.right <= window.innerWidth,
          samples: [0.05, 0.25, 0.5, 0.75, 0.95].map((fraction) => {
            const probe = document.elementFromPoint(
              rect.x + rect.width * fraction,
              rect.y + rect.height / 2
            )
            return probe === element || element.contains(probe)
          }),
        }
      })
      expect(hits.inViewport, `${name} stays inside the 320px viewport`).toBe(true)
      expect(
        Math.min(hits.width, hits.height),
        `${name} pointer target minimum`
      ).toBeGreaterThanOrEqual(24)
      expect(hits.samples, `${name} fully usable at 320px, ${fontSize} root size`).toEqual([
        true,
        true,
        true,
        true,
        true,
      ])
    }
  }
})

test('optional apps open actual task and source control views without hiding the global rail', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  const library = page.getByRole('main', { name: 'App Library' })
  // Kanban is on by default: it is the only place tasks are listed.
  await expect(library.getByRole('button', { name: 'Disable Kanban', exact: true })).toBeVisible()
  await library.getByRole('button', { name: 'Open Kanban', exact: true }).click()
  await expect(page).toHaveURL(/app=kanban/)
  await expect(page.locator('.conventional-workspace--board')).toBeVisible()
  // The board is a full-width app: no workspace sidebar beside it.
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Task board', exact: true })).toBeVisible()
  await expect(rail.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  await library.getByRole('button', { name: 'Enable Source control', exact: true }).click()
  await library.getByRole('button', { name: 'Open Source control', exact: true }).click()
  await expect(page).toHaveURL(/app=source-control/)
  // The source control app needs the desktop runtime; the web build says so
  // instead of rendering an empty inbox.
  const sourceControl = page.getByRole('main', { name: 'Source control' })
  await expect(sourceControl).toBeVisible()
  await expect(sourceControl).toContainText('Source control needs the Adea desktop runtime')
  await expect(rail.getByRole('button', { name: 'Source control', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.getByRole('button', { name: 'Restore utility pane', exact: true })).toHaveCount(
    0
  )
})

test('all-off stale links remain in Library while enabling the first app', async ({ page }) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  const library = page.getByRole('main', { name: 'App Library' })
  for (const name of ['Virtual', 'Chat', 'Dev', 'Kanban'])
    await library.getByRole('button', { name: `Disable ${name}`, exact: true }).click()
  await page.goto('/?view=dev')
  await expect(page).toHaveURL(/app=library/)
  await library.getByRole('button', { name: 'Enable Chat', exact: true }).click()
  await expect(library).toBeVisible()
  await expect(library.getByRole('button', { name: 'Open Chat', exact: true })).toBeVisible()
  await library.getByRole('button', { name: 'Open Chat', exact: true }).click()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
})

test('Kanban leaves the prior Chat surface intact and rail keyboard reorders persist until reset', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const views = rail.getByRole('group', { name: 'Workspace views' })
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  // Alt+Arrow moves the focused rail view; the live region announces it.
  await views.getByRole('button', { name: 'Chat view', exact: true }).click()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(rail.getByRole('status')).toHaveText('Chat moved to position 1 of 4')
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Chat view')
  await page.reload()
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Chat view')
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  const library = page.getByRole('main', { name: 'App Library' })
  await library.getByRole('button', { name: 'Open Kanban', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Kanban', exact: true })).toBeVisible()
  await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
  await expect(page.locator('.conventional-workspace')).toBeVisible()
  // The Agents panel selection persists through a debounced writer, so a
  // surface that reloaded quickly after the click restores the default
  // conversation view; open the panel deliberately instead of assuming.
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
  await rail.getByRole('button', { name: 'App Library', exact: true }).click()
  await library.getByRole('button', { name: 'Reset Navigation', exact: true }).click()
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Virtual view')
  // Reset restores the defaults, and Kanban is one of them.
  await expect(rail.getByRole('button', { name: 'Kanban', exact: true })).toHaveCount(1)
})

test('App Library drag and keyboard ordering shares rail placements and persists hidden apps', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat&app=library')
  const library = page.getByRole('main', { name: 'App Library' })
  const views = page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('group', { name: 'Workspace views' })

  const appOrder = () =>
    library
      .locator('.workspace-app-library__grid > [data-app-id]')
      .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-app-id')))
  const railOrder = () =>
    views.locator('[data-row-id]').evaluateAll((items) =>
      items
        .map((item) => item.getAttribute('data-row-id'))
        .filter((rowId): rowId is string => rowId?.startsWith('rail-view:') === true)
        .map((rowId) => rowId.replace('rail-view:', ''))
    )
  const enabledAppOrder = () =>
    library
      .locator('.workspace-app-library__grid > [data-app-id][data-enabled="true"]')
      .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-app-id')))

  await expect.poll(appOrder).toEqual(['virtual', 'chat', 'dev', 'kanban', 'source-control'])
  // An enabled-only filter must not replace the canonical order with its
  // partial list. Move Dev with a keyboard-activated shared ActionButton.
  await library.getByRole('button', { name: 'Show enabled only', exact: true }).click()
  await expect.poll(appOrder).toEqual(['virtual', 'chat', 'dev', 'kanban'])
  const moveDevLeft = library.getByRole('button', { name: 'Move Dev left', exact: true })
  await moveDevLeft.focus()
  await page.keyboard.press('Enter')
  await expect.poll(appOrder).toEqual(['virtual', 'dev', 'chat', 'kanban'])
  await expect(library.getByRole('button', { name: 'Move Dev left', exact: true })).toBeFocused()
  await expect(library.getByRole('status')).toHaveText('Dev moved to position 2 of 5')
  await library.getByRole('button', { name: 'Show enabled only', exact: true }).click()
  await expect.poll(appOrder).toEqual(['virtual', 'dev', 'chat', 'kanban', 'source-control'])
  await expect.poll(railOrder).toEqual(['virtual', 'dev', 'chat', 'kanban'])

  // Drag the optional, currently hidden app before Virtual. Reordering keeps
  // it hidden until the explicit Enable action and retains the remaining apps.
  const sourceTile = library.locator('[data-app-id="source-control"]')
  const sourceGrip = sourceTile.getByRole('button', {
    name: 'Drag Source control to reorder',
    exact: true,
  })
  await sourceTile.hover()
  await expect(sourceGrip).toBeVisible()
  await sourceGrip.click({ trial: true })
  await sourceGrip.dragTo(library.locator('[data-app-id="virtual"]'), {
    targetPosition: { x: 1, y: 24 },
  })
  await expect.poll(appOrder).toEqual(['source-control', 'virtual', 'dev', 'chat', 'kanban'])
  await expect(
    library.getByRole('button', { name: 'Enable Source control', exact: true })
  ).toBeVisible()
  await expect.poll(railOrder).toEqual(['virtual', 'dev', 'chat', 'kanban'])

  await library.getByRole('button', { name: 'Enable Source control', exact: true }).click()
  await expect
    .poll(async () => ({ enabledApps: await enabledAppOrder(), rail: await railOrder() }))
    .toEqual({
      enabledApps: ['source-control', 'virtual', 'dev', 'chat', 'kanban'],
      rail: ['source-control', 'virtual', 'dev', 'chat', 'kanban'],
    })
  await page.reload()
  await expect(library).toBeVisible()
  await expect.poll(appOrder).toEqual(['source-control', 'virtual', 'dev', 'chat', 'kanban'])
  await expect(
    library.getByRole('button', { name: 'Disable Source control', exact: true })
  ).toBeVisible()
  await expect
    .poll(async () => ({ enabledApps: await enabledAppOrder(), rail: await railOrder() }))
    .toEqual({
      enabledApps: ['source-control', 'virtual', 'dev', 'chat', 'kanban'],
      rail: ['source-control', 'virtual', 'dev', 'chat', 'kanban'],
    })
})

test('App Library reorder actions are visible and operable on touch devices', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })

  try {
    const page = await context.newPage()
    await mockConnectedWorkspace(page)
    await page.goto('/?view=chat&app=library')
    const library = page.getByRole('main', { name: 'App Library' })
    expect(
      await page.evaluate(
        () => matchMedia('(hover: none)').matches || matchMedia('(pointer: coarse)').matches
      )
    ).toBe(true)
    const appOrder = () =>
      library
        .locator('.workspace-app-library__grid > [data-app-id]')
        .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-app-id')))

    const devTile = library.locator('[data-app-id="dev"]')
    const moveDevLeft = devTile.getByRole('button', { name: 'Move Dev left', exact: true })
    await expect(moveDevLeft).toBeVisible()
    await expect(moveDevLeft).toHaveCSS('pointer-events', 'auto')
    await expect.poll(appOrder).toEqual(['virtual', 'chat', 'dev', 'kanban', 'source-control'])

    await moveDevLeft.tap()
    await expect.poll(appOrder).toEqual(['virtual', 'dev', 'chat', 'kanban', 'source-control'])
  } finally {
    await context.close()
  }
})

test('Rail drag-and-drop reorders views across disabled apps and persists after reload', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat&app=library')
  const library = page.getByRole('main', { name: 'App Library' })
  const views = page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('group', { name: 'Workspace views' })
  await expect(
    library.getByRole('button', { name: 'Move Virtual left', exact: true })
  ).toBeVisible()
  await library.getByRole('button', { name: 'Disable Chat', exact: true }).click()
  // Dropping on the upper half of a row inserts before it, the lower half after.
  await views
    .getByRole('button', { name: 'Dev view', exact: true })
    .dragTo(views.getByRole('button', { name: 'Virtual view', exact: true }), {
      targetPosition: { x: 24, y: 4 },
    })
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Dev view')
  await views
    .getByRole('button', { name: 'Dev view', exact: true })
    .dragTo(views.getByRole('button', { name: 'Virtual view', exact: true }), {
      targetPosition: { x: 24, y: 28 },
    })
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Virtual view')
  await page.reload()
  await expect(views.getByRole('button').first()).toHaveAttribute('aria-label', 'Virtual view')
  await library.getByRole('button', { name: 'Enable Chat', exact: true }).click()
  await expect(views.getByRole('button').nth(2)).toHaveAttribute('aria-label', 'Chat view')
})

test('themed shell and Library remain usable across desktop and narrow layouts', async ({
  page,
}, testInfo) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat&app=library')
  const library = page.getByRole('main', { name: 'App Library' })
  const toolbar = page.getByLabel('Workspace toolbar')
  await expect(library).toBeVisible()
  const light = await toolbar.evaluate((element) => getComputedStyle(element).backgroundColor)
  await page.screenshot({ path: testInfo.outputPath('library-light-desktop.png') })
  await page.getByRole('button', { name: 'User settings', exact: true }).click()
  // Not `exact`: the shared account item appends the platform chord glyph
  // (`⌘,` or `Ctrl,`) to the accessible name, which workspace-guest.spec.ts
  // asserts is displayed.
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('tab', { name: 'Appearance', exact: true }).click()
  const appearance = settings.getByRole('region', { name: 'Appearance', exact: true })
  await appearance
    .getByRole('radiogroup', { name: 'Appearance mode', exact: true })
    .getByText('Dark', { exact: true })
    .click()
  await appearance.getByRole('button', { name: 'Save', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await expect(page.locator('html')).toHaveClass(/dark/)
  const dark = await toolbar.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(dark).not.toBe(light)
  await page.screenshot({ path: testInfo.outputPath('library-dark-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(library.getByRole('searchbox', { name: 'Search apps', exact: true })).toBeVisible()
  // Park the pointer off-page so no hover tooltip from the settings flow is
  // captured over the page content.
  await page.mouse.move(0, 0)
  await page.screenshot({ path: testInfo.outputPath('library-dark-mobile.png') })
  await page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('button', { name: 'Virtual view', exact: true })
    .click()
  // The shared navigation stays closed across view switches below 48rem —
  // reopen it through the top-bar toggle, then check the modal dismissal
  // contract before measuring the horizontal overflow.
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeHidden()
  await toolbar.getByRole('button', { name: 'Expand contextual sidebar', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
  await page.screenshot({ path: testInfo.outputPath('virtual-dark-mobile.png') })
})

test('integrated chrome stays keyboard-operable under reduced motion and transparency', async ({
  page,
}, testInfo) => {
  await mockConnectedWorkspace(page)
  // Reduced settings are OS-level choices. Emulate both before the app mounts
  // so every stylesheet resolves under them, then operate the integrated bar
  // and the Library by keyboard alone. The captures are evidence artifacts,
  // not pixel baselines: the visual lane owns regression baselines.
  await page.emulateMedia({ reducedMotion: 'reduce', reducedTransparency: 'reduce' })
  await page.goto('/?view=chat')
  const toolbar = page.getByLabel('Workspace toolbar')
  await expect(toolbar).toBeVisible()
  // The OS backstops hold: frost clamps to an opaque surface and the
  // workspace surface collapses its motion to the near-zero duration the
  // reduced-motion rule imposes.
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--surface-alpha').trim()
    )
  ).toBe('1')
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(sidebar).toBeVisible()
  // Chromium serializes 0.01ms as "1e-05s"; compare the duration, not the
  // engine's string form.
  const transitionSeconds = await sidebar.evaluate(
    (element) => Number.parseFloat(getComputedStyle(element).transitionDuration) || Number.NaN
  )
  expect(transitionSeconds).toBeCloseTo(0.00001, 6)

  // Keyboard-only chrome operation: collapse and reopen the contextual
  // sidebar from the integrated bar without touching the pointer.
  const collapse = toolbar.getByRole('button', { name: 'Collapse contextual sidebar' })
  await collapse.focus()
  await page.keyboard.press('Enter')
  await expect(sidebar).toBeHidden()
  const expand = toolbar.getByRole('button', { name: 'Expand contextual sidebar' })
  await expect(expand).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(sidebar).toBeVisible()
  await page.mouse.move(0, 0)
  await page.screenshot({ path: testInfo.outputPath('chat-reduced-settings-desktop.png') })

  // The Library opens from the rail by keyboard and stays operable.
  const libraryButton = page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('button', { name: 'App Library', exact: true })
  await libraryButton.focus()
  await page.keyboard.press('Enter')
  const library = page.getByRole('main', { name: 'App Library' })
  await expect(library).toBeVisible()
  await expect(library.getByRole('searchbox', { name: 'Search apps', exact: true })).toBeVisible()
  await page.mouse.move(0, 0)
  await page.screenshot({ path: testInfo.outputPath('library-reduced-settings-desktop.png') })
})

test('Chat conversation surface follows the shared light and dark theme background', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  const surface = page.locator('#workspace-main')
  await expect(surface).toBeVisible()
  for (const mode of ['Light', 'Dark']) {
    await page.getByRole('button', { name: 'User settings', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('tab', { name: 'Appearance', exact: true }).click()
    const appearance = settings.getByRole('region', { name: 'Appearance', exact: true })
    await appearance
      .getByRole('radiogroup', { name: 'Appearance mode', exact: true })
      .getByText(mode, { exact: true })
      .click()
    // Save persists only a dirty draft: the legacy theme key pins light, so
    // the Light iteration is already committed and leaves Save disabled with
    // the mode already on the document; Dark is a real change and saves.
    const save = appearance.getByRole('button', { name: 'Save', exact: true })
    if (await save.isEnabled()) await save.click()
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-appearance-mode', mode.toLowerCase())
    const colors = await surface.evaluate((element) => ({
      conversation: getComputedStyle(element).backgroundColor,
      workspace: getComputedStyle(element.closest('.conventional-workspace')!).backgroundColor,
    }))
    expect(colors.conversation).toBe(colors.workspace)
  }
})

test('repeated Chat and Library transitions release workspace event listeners', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const tracked = new Set(['hashchange', 'online', 'offline', 'keydown'])
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
    const originalAdd = window.addEventListener.bind(window)
    const originalRemove = window.removeEventListener.bind(window)
    window.addEventListener = (type, listener, options) => {
      if (listener && tracked.has(type)) {
        const id = type + ':' + Boolean(typeof options === 'boolean' ? options : options?.capture)
        const entries = listeners.get(id) ?? new Set<EventListenerOrEventListenerObject>()
        entries.add(listener)
        listeners.set(id, entries)
        if (typeof options === 'object' && options.signal) {
          options.signal.addEventListener('abort', () => entries.delete(listener), { once: true })
        }
      }
      originalAdd(type, listener, options)
    }
    window.removeEventListener = (type, listener, options) => {
      const id = type + ':' + Boolean(typeof options === 'boolean' ? options : options?.capture)
      if (listener) listeners.get(id)?.delete(listener)
      originalRemove(type, listener, options)
    }
    Object.defineProperty(window, 'workspaceListenerCounts', {
      value: () => Object.fromEntries([...listeners].map(([id, entries]) => [id, entries.size])),
    })
  })
  await mockWorkspace(page)
  await page.goto('/?view=chat')
  const rail = page.getByRole('navigation', { name: 'Global navigation' })
  const cycle = async () => {
    await rail.getByRole('button', { name: 'App Library', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'App Library', exact: true })).toBeVisible()
    await rail.getByRole('button', { name: 'Chat view', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Workspace navigation' })).toBeVisible()
  }
  // Warm lazy destinations once before comparing retained listeners.
  await cycle()
  const counts = () =>
    page.evaluate(() => {
      const read = Reflect.get(window, 'workspaceListenerCounts')
      if (typeof read !== 'function') throw new Error('Listener instrumentation is missing')
      return read()
    })
  const baseline = await counts()
  await cycle()
  await cycle()
  await expect.poll(counts).toEqual(baseline)
})

test('App Library tiles retain readable content and actions in narrow and enlarged layouts', async ({
  page,
}) => {
  await mockConnectedWorkspace(page)
  await page.goto('/?view=chat')
  await page
    .getByRole('navigation', { name: 'Global navigation' })
    .getByRole('button', { name: 'App Library', exact: true })
    .click()
  const library = page.getByRole('main', { name: 'App Library' })
  await expect(library).toBeVisible()
  const tiles = library.locator('[class~="workspace-app-library__tile"]')
  await expect(tiles.first()).toBeVisible()
  for (const scale of [1, 2]) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate((factor) => {
      document.documentElement.style.fontSize = `${16 * factor}px`
    }, scale)
    const bounds = await tiles.evaluateAll((elements) =>
      elements.map((element) => {
        const tile = element.getBoundingClientRect()
        const media = element
          .querySelector('[class*="workspace-app-library__tile-media"]')
          ?.getBoundingClientRect()
        const name = element
          .querySelector('[class*="workspace-app-library__tile-name"], [data-tile-open]')
          ?.getBoundingClientRect()
        const controls = Array.from(element.querySelectorAll('button')).map((button) =>
          button.getBoundingClientRect()
        )
        return {
          // The tile is a vertical stack: the name sits below the icon mark
          // and stays readable, and every control — the corner toggle and the
          // open action — remains inside the tile at both font scales.
          nameBelowMedia: !!media && !!name && name.top >= media.bottom - 1 && name.width >= 24,
          controlsContained: controls.every(
            (control) =>
              control.left >= tile.left - 1 &&
              control.right <= tile.right + 1 &&
              control.top >= tile.top - 1 &&
              control.bottom <= tile.bottom + 1
          ),
        }
      })
    )
    expect(bounds.length).toBeGreaterThan(0)
    for (const tile of bounds) {
      expect(tile.nameBelowMedia).toBe(true)
      expect(tile.controlsContained).toBe(true)
    }
  }
})

test('workspace navigation captures full-height pointer resizing and persists the width', async ({
  page,
}) => {
  await mockWorkspace(page)
  await page.setViewportSize({ width: 1280, height: 840 })
  await page.goto('/?view=chat')
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' })
  const handle = page.getByRole('separator', { name: 'Resize workspace navigation' })
  await expect(sidebar).toBeVisible()
  const before = await sidebar.evaluate((element) => element.getBoundingClientRect().width)
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 3
  await page.mouse.move(x, y)
  await page.mouse.down()
  await expect(handle).toHaveAttribute('data-dragging', '')
  await page.mouse.move(x + 80, y, { steps: 6 })
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(before + 60)
  await page.mouse.up()
  await expect(handle).not.toHaveAttribute('data-dragging', '')
  const resized = await sidebar.evaluate((element) => element.getBoundingClientRect().width)
  await page.reload()
  await expect(sidebar).toBeVisible()
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(resized)
})

test('the contextual sidebar toggle hides while the chat shell renders its bootstrap fallback', async ({
  page,
}) => {
  // Mirror of the trailing-slot rule: a control with nothing to control is
  // noise. While the shell's bootstrap is pending or failed, the frame keeps
  // its top bar but mounts no contextual sidebar, so the toggle hides instead
  // of advertising a collapse that cannot happen.
  const toggle = () =>
    page
      .getByRole('button', { name: 'Collapse contextual sidebar' })
      .or(page.getByRole('button', { name: 'Expand contextual sidebar' }))

  let releaseBootstrap!: (response: { status: number; body?: string }) => void
  const bootstrapHeld = new Promise<{ status: number; body?: string }>((resolve) => {
    releaseBootstrap = resolve
  })
  await page.route('**/api/workspaces/bootstrap', async (route) => {
    const response = await bootstrapHeld
    await route.fulfill({
      contentType: 'application/json',
      status: response.status,
      ...(response.body ? { body: response.body } : {}),
    })
  })
  await page.goto('/?view=chat')

  // Pending bootstrap: the skeleton renders, no sidebar, no toggle.
  await expect(page.locator('.conventional-skeleton')).toBeVisible()
  await expect(toggle()).toHaveCount(0)

  // Failed bootstrap: the error state renders, still no sidebar, no toggle.
  releaseBootstrap({ status: 500, body: 'bootstrap refused' })
  await expect(page.getByRole('alert')).toContainText('Something interrupted the workspace')
  await expect(toggle()).toHaveCount(0)

  // Released bootstrap: the workspace mounts with its sidebar, and exactly
  // one contextual control returns.
  await page.unroute('**/api/workspaces/bootstrap')
  await mockWorkspace(page)
  await page.reload()
  await expect(workspaceNav(page)).toBeVisible()
  await expect(toggle()).toHaveCount(1)
})
