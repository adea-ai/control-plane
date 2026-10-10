import { describe, expect, test } from 'bun:test'
import { ApiClientError } from '@adea-ai/api-client'
import type { AgentSummary } from '@adea-ai/types'
import { loadWorkspaceLeadSetup, type WorkspaceLeadClient } from '../../src/workspace-lead-load'
import { markWorkspaceLeadChanged, workspaceLeadRevision } from '../../src/workspace-lead-revision'

const connectionRef = `mconn_${'a'.repeat(32)}`
const activeLead = {
  id: 'lead-1',
  isWorkspaceLead: true,
  lifecycleState: 'active',
  profile: { id: 'lead-profile', state: 'available', version: '2' },
  name: 'Workspace lead',
  presentationMetadata: {},
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  workspaceId: 'workspace-1',
} as AgentSummary
const unconfiguredLead = {
  ...activeLead,
  profile: { id: 'workspace-lead-unconfigured', state: 'missing', version: 'unconfigured' },
} as AgentSummary
const readyInventory = (canManage: boolean) => ({
  availability: 'available' as const,
  canManage,
  target: {
    location: 'remote_host' as const,
    harness: 'pi_durable' as const,
    harnessVersion: '1.0.0',
    providerBinding: 'pi_durable_models' as const,
  },
  connections: [
    {
      connectionRef,
      revision: 1,
      provider: 'fixture-provider',
      accountRef: 'provider-account',
      authKind: 'api_key' as const,
      fundingSource: 'byo_api' as const,
      status: 'active' as const,
      models: [
        {
          providerModel: 'fixture-model',
          readiness: { ready: true, reasonCode: 'READY', remedy: null },
        },
      ],
    },
  ],
})
const defaultsPage = (canManage: boolean) => ({
  availability: 'available' as const,
  canManage,
  defaults: { revision: 1, lead: { connectionRef, providerModel: 'fixture-model' } },
})

function fakeClient(options: {
  lead?: AgentSummary | null
  leadError?: unknown
  canManage?: boolean
  inventoryFails?: boolean
  write?: () => Promise<{ lead: AgentSummary | null }>
}) {
  const calls = { writes: 0 }
  const canManage = options.canManage ?? true
  const client: WorkspaceLeadClient = {
    getWorkspaceLead: async () => {
      if (options.leadError) throw options.leadError
      return { lead: options.lead ?? null }
    },
    ensureWorkspaceLead: async () => {
      calls.writes += 1
      if (options.write) return options.write()
      return { lead: unconfiguredLead }
    },
    listModelConnections: async () => {
      if (options.inventoryFails) throw new Error('unavailable')
      return readyInventory(canManage)
    },
    getWorkspaceModelDefaults: async () => defaultsPage(canManage),
  } as unknown as WorkspaceLeadClient
  return { client, calls }
}

const always = () => true

describe('lead load: authorization hint', () => {
  test('a member who cannot manage never issues the provisioning write', async () => {
    const { client, calls } = fakeClient({ canManage: false })
    const result = await loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-1',
      isCurrent: always,
    })
    expect(calls.writes).toBe(0)
    expect(result).toMatchObject({ current: true, setup: { state: 'not_permitted' } })
  })

  test('an admin with no lead provisions once and lands on the unconfigured state', async () => {
    const { client, calls } = fakeClient({ canManage: true })
    const result = await loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-1',
      isCurrent: always,
    })
    expect(calls.writes).toBe(1)
    expect(result).toMatchObject({ current: true, setup: { state: 'unconfigured' } })
  })

  test('an existing lead is never rewritten, whatever the manage hint', async () => {
    const { client, calls } = fakeClient({ lead: unconfiguredLead, canManage: false })
    const result = await loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-1',
      isCurrent: always,
    })
    expect(calls.writes).toBe(0)
    expect(result).toMatchObject({ current: true, setup: { state: 'unconfigured' } })
  })
})

describe('lead load: scope and failures', () => {
  test('a scope switch during the reads never issues a write', async () => {
    const { client, calls } = fakeClient({})
    let current = true
    const pending = loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-old',
      isCurrent: () => current,
    })
    current = false
    expect(await pending).toEqual({ current: false })
    expect(calls.writes).toBe(0)
  })

  test('a write that completes after a scope switch is reported stale and not applied', async () => {
    let current = true
    const { client, calls } = fakeClient({
      write: async () => {
        current = false
        return { lead: unconfiguredLead }
      },
    })
    const result = await loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-old',
      isCurrent: () => current,
    })
    expect(calls.writes).toBe(1)
    expect(result).toEqual({ current: false })
  })

  test('an expired session on the lead read asks to sign in and never writes', async () => {
    const { client, calls } = fakeClient({
      leadError: new ApiClientError('Unauthorized', 401, 'workspace_unavailable'),
    })
    const result = await loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-1',
      isCurrent: always,
    })
    expect(calls.writes).toBe(0)
    expect(result).toMatchObject({ current: true, setup: { state: 'auth_required' } })
  })

  test('a provisioning refusal is a retryable failure, never a lead', async () => {
    const { client } = fakeClient({
      write: async () => {
        throw new ApiClientError('Unavailable', 404, 'workspace_unavailable')
      },
    })
    const result = await loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-1',
      isCurrent: always,
    })
    expect(result).toMatchObject({ current: true, setup: { state: 'provisioning_failed' } })
  })

  test('an empty provisioning result is a failure, not a success', async () => {
    const { client } = fakeClient({ write: async () => ({ lead: null }) })
    const result = await loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-1',
      isCurrent: always,
    })
    expect(result).toMatchObject({ current: true, setup: { state: 'provisioning_failed' } })
  })

  test('an unreadable inventory fails closed to funding_blocked for an active lead', async () => {
    const { client } = fakeClient({ lead: activeLead, inventoryFails: true })
    const result = await loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-1',
      isCurrent: always,
    })
    expect(result).toMatchObject({ current: true, setup: { state: 'funding_blocked' } })
  })
})

describe('lead revision signal', () => {
  test('marking a workspace changes only that workspace revision', () => {
    const before = workspaceLeadRevision('ws-revision-a')
    const other = workspaceLeadRevision('ws-revision-b')
    markWorkspaceLeadChanged('ws-revision-a')
    expect(workspaceLeadRevision('ws-revision-a')).toBe(before + 1)
    expect(workspaceLeadRevision('ws-revision-b')).toBe(other)
  })
})

describe('lead load: roster refresh hook', () => {
  test('a provisioning write refreshes the roster list exactly once', async () => {
    const { client, calls } = fakeClient({ canManage: true })
    let refreshes = 0
    await loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-1',
      isCurrent: always,
      onProvisioned: () => {
        refreshes += 1
      },
    })
    expect(calls.writes).toBe(1)
    expect(refreshes).toBe(1)
  })

  test('an existing lead never refreshes the roster list', async () => {
    const { client } = fakeClient({ lead: unconfiguredLead, canManage: true })
    let refreshes = 0
    await loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-1',
      isCurrent: always,
      onProvisioned: () => {
        refreshes += 1
      },
    })
    expect(refreshes).toBe(0)
  })

  test('a write that lands after a scope switch does not refresh the new scope', async () => {
    let current = true
    const { client } = fakeClient({
      write: async () => {
        current = false
        return { lead: unconfiguredLead }
      },
    })
    let refreshes = 0
    await loadWorkspaceLeadSetup({
      client,
      workspaceId: 'workspace-old',
      isCurrent: () => current,
      onProvisioned: () => {
        refreshes += 1
      },
    })
    expect(refreshes).toBe(0)
  })
})
