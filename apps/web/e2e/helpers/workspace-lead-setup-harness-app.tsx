import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'

import { AgentHqApiClient } from '@adea-ai/api-client'
import {
  FirstRunOnboarding,
  type FirstRunConversation,
  type FirstRunFacts,
} from '@adea-ai/dev-view/chat'

import { markWorkspaceLeadChanged } from '../../../../packages/workspace-ui/src/workspace-lead-revision'
import { WorkspaceLeadStatus } from '../../../../packages/workspace-ui/src/workspace-lead-status'

type Lead = Record<string, unknown> | null
type Fixture = {
  lead: Lead
  reads401?: boolean
  failWrites: number
  inventory: Record<string, unknown>
  defaults: Record<string, unknown>
}

const readyInventory = {
  availability: 'available',
  canManage: true,
  target: {
    location: 'remote_host',
    harness: 'pi_durable',
    harnessVersion: '1.0.0',
    providerBinding: 'pi_durable_models',
  },
  connections: [
    {
      connectionRef: `mconn_${'a'.repeat(32)}`,
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
const unavailableInventory = {
  availability: 'unavailable',
  canManage: true,
  target: null,
  connections: [],
}
const memberInventory = { ...unavailableInventory, canManage: false }
const readyDefaults = {
  availability: 'available',
  canManage: true,
  defaults: {
    revision: 1,
    lead: { connectionRef: `mconn_${'a'.repeat(32)}`, providerModel: 'fixture-model' },
  },
}
const unavailableDefaults = { availability: 'unavailable', canManage: true, defaults: null }
const memberDefaults = { availability: 'unavailable', canManage: false, defaults: null }

function activeLead(workspaceId: string): Record<string, unknown> {
  return {
    id: `lead-${workspaceId}`,
    isWorkspaceLead: true,
    lifecycleState: 'active',
    name: 'Workspace lead',
    presentationMetadata: {},
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    workspaceId,
    profile: { id: 'lead-profile', state: 'available', version: '2' },
  }
}

const workspaces: Record<string, Fixture> = {
  // Empty workspace: entry provisions the structural lead, which stays unconfigured.
  'ws-a': {
    lead: null,
    failWrites: 0,
    inventory: unavailableInventory,
    defaults: unavailableDefaults,
  },
  // Lead with an eligible model: the canonical setup is ready.
  'ws-b': {
    lead: activeLead('ws-b'),
    failWrites: 0,
    inventory: readyInventory,
    defaults: readyDefaults,
  },
  // Lead profile available but no eligible model: funding fails closed.
  'ws-c': {
    lead: activeLead('ws-c'),
    failWrites: 0,
    inventory: unavailableInventory,
    defaults: unavailableDefaults,
  },
  // Expired session on the protected lead route.
  'ws-d': {
    lead: null,
    reads401: true,
    failWrites: 0,
    inventory: unavailableInventory,
    defaults: unavailableDefaults,
  },
  // Provisioning fails once, then succeeds on retry.
  'ws-e': {
    lead: null,
    failWrites: 1,
    inventory: unavailableInventory,
    defaults: unavailableDefaults,
  },
  // Workspace member without manage rights: no lead, and no write may be attempted.
  'ws-f': {
    lead: null,
    failWrites: 0,
    inventory: memberInventory,
    defaults: memberDefaults,
  },
}

const writes: string[] = []
let leadReads = 0
let parked = 0
const holds: {
  workspaceId: string
  method: string
  release: () => void
  promise: Promise<void>
}[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function gate(workspaceId: string, method: string): Promise<void> {
  const hold = holds.find((item) => item.workspaceId === workspaceId && item.method === method)
  if (!hold) return Promise.resolve()
  parked += 1
  return hold.promise
}

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), 'http://fake.test')
  const method = (init?.method ?? 'GET').toUpperCase()
  const match = /\/workspaces\/([^/]+)\//.exec(url.pathname)
  const workspaceId = decodeURIComponent(match?.[1] ?? '')
  const ws = workspaces[workspaceId]
  if (!ws) return json({ code: 'workspace_unavailable' }, 404)
  if (url.pathname.endsWith('/agents/lead')) {
    await gate(workspaceId, method)
    if (method === 'GET') {
      leadReads += 1
      if (ws.reads401) return json({ code: 'workspace_unavailable', message: 'expired' }, 401)
      return json({ lead: ws.lead })
    }
    writes.push(workspaceId)
    if (ws.failWrites > 0) {
      ws.failWrites -= 1
      return json({ code: 'workspace_unavailable' }, 404)
    }
    if (!ws.lead)
      ws.lead = {
        ...activeLead(workspaceId),
        profile: { id: 'workspace-lead-unconfigured', state: 'missing', version: 'unconfigured' },
      }
    return json({ lead: ws.lead })
  }
  const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string }
  if (body.action === 'list') return json(ws.inventory)
  if (body.action === 'defaults.get') return json(ws.defaults)
  return json({ code: 'invalid_request' }, 400)
}

const client = new AgentHqApiClient({ baseUrl: '/api', fetchImpl: fakeFetch as typeof fetch })

const facts: FirstRunFacts = {
  identity: 'signed_in',
  managedPi: { state: 'ready' },
  modelAccess: 'byok',
  projectReady: true,
  agentProfileReady: true,
}

let conversations = 0
let signIns = 0
const port = {
  installManagedPi: async () => ({ state: 'ready' as const }),
  createConversation: async (): Promise<FirstRunConversation> => ({
    runtimeSessionId: `direct-${conversations + 1}`,
  }),
}

function App() {
  const [workspaceId, setWorkspaceId] = createSignal('ws-b')
  const [mounted, setMounted] = createSignal(true)
  window.leadHarness = {
    select: (next) => setWorkspaceId(next),
    hold: (next, method) => {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      holds.push({ workspaceId: next, method, release, promise })
    },
    release: () => {
      for (const hold of holds.splice(0)) hold.release()
    },
    unmount: () => setMounted(false),
    remount: () => setMounted(true),
    bump: () => markWorkspaceLeadChanged(workspaceId()),
    report: () => ({
      selected: workspaceId(),
      parked,
      leadReads,
      writes: [...writes],
      conversations,
      signIns,
    }),
  }
  return (
    <main>
      <Show when={mounted()}>
        <WorkspaceLeadStatus
          client={client}
          workspaceId={workspaceId()}
          onSignIn={() => {
            signIns += 1
          }}
        />
      </Show>
      <FirstRunOnboarding
        facts={facts}
        port={port}
        onAction={() => undefined}
        onConversation={() => {
          conversations += 1
        }}
      />
    </main>
  )
}

declare global {
  interface Window {
    leadHarness: {
      select(workspaceId: string): void
      hold(workspaceId: string, method: string): void
      release(): void
      unmount(): void
      remount(): void
      bump(): void
      report(): {
        selected: string
        parked: number
        leadReads: number
        writes: string[]
        conversations: number
        signIns: number
      }
    }
  }
}

const root = document.getElementById('harness-root')
if (!root) throw new Error('harness root missing')
render(() => <App />, root)
