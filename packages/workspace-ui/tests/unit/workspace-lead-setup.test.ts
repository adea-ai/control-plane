import { describe, expect, test } from 'bun:test'
import type { AgentSummary } from '@adea-ai/types'
import type {
  ApiModelConnectionsResponse,
  ApiWorkspaceModelDefaults,
} from '@adea-ai/api-client/model-connections'
import { projectWorkspaceLeadSetup } from '../../src/workspace-lead-setup'

const connectionRef = `mconn_${'a'.repeat(32)}`
const lead = {
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

const defaults: ApiWorkspaceModelDefaults = {
  revision: 1,
  lead: { connectionRef, providerModel: 'fixture-model' },
}

function inventory(ready: boolean): ApiModelConnectionsResponse {
  return {
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
            readiness: ready
              ? { ready: true, reasonCode: 'READY', remedy: null }
              : { ready: false, reasonCode: 'QUOTA_EXHAUSTED', remedy: null },
          },
        ],
      },
    ],
  }
}

describe('lead-specific setup projection', () => {
  test('no lead is missing, or provisioning_failed when the protected route failed', () => {
    expect(
      projectWorkspaceLeadSetup({ lead: null, connections: inventory(true), defaults }).state
    ).toBe('missing')
    expect(
      projectWorkspaceLeadSetup({
        lead: null,
        provisioning: 'failed',
        connections: inventory(true),
        defaults,
      }).state
    ).toBe('provisioning_failed')
  })

  test('an active available-profile roster agent that is not the lead never reads as ready', () => {
    const other = { ...lead, id: 'agent-2', isWorkspaceLead: false } as AgentSummary
    expect(
      projectWorkspaceLeadSetup({ lead: other, connections: inventory(true), defaults }).state
    ).toBe('missing')
  })

  test('an archived lead is inactive, not ready', () => {
    expect(
      projectWorkspaceLeadSetup({
        lead: { ...lead, lifecycleState: 'archived' } as AgentSummary,
        connections: inventory(true),
        defaults,
      }).state
    ).toBe('inactive')
  })

  test('a lead whose profile is not available stays unconfigured even with a ready model', () => {
    expect(
      projectWorkspaceLeadSetup({
        lead: { ...lead, profile: { ...lead.profile, state: 'missing' } } as AgentSummary,
        connections: inventory(true),
        defaults,
      }).state
    ).toBe('unconfigured')
  })

  test('funding fails closed: no lead default, unavailable inventory, or a non-ready model', () => {
    expect(
      projectWorkspaceLeadSetup({ lead, connections: inventory(true), defaults: null }).state
    ).toBe('funding_blocked')
    expect(
      projectWorkspaceLeadSetup({
        lead,
        connections: { ...inventory(true), availability: 'unavailable' },
        defaults,
      }).state
    ).toBe('funding_blocked')
    expect(projectWorkspaceLeadSetup({ lead, connections: inventory(false), defaults }).state).toBe(
      'funding_blocked'
    )
  })

  test('setup_ready only when the existing lead role model is eligible for an active lead', () => {
    const result = projectWorkspaceLeadSetup({ lead, connections: inventory(true), defaults })
    expect(result.state).toBe('setup_ready')
    if (result.state === 'setup_ready')
      expect(result.model.choice.providerModel).toBe('fixture-model')
  })
})
