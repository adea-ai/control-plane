import { describe, expect, test } from 'bun:test'
import type { AgentSummary } from '@adea-ai/types'
import type { ApiModelConnectionsResponse } from '@adea-ai/api-client/model-connections'
import { projectWorkspaceLeadPresentation } from '../../src/workspace-lead-presentation'

const lead = { id: 'lead-1', isWorkspaceLead: true } as AgentSummary
const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.0.0',
  providerBinding: 'pi_durable_models',
} as const
const available = (targetValue: unknown): ApiModelConnectionsResponse =>
  ({
    availability: 'available',
    canManage: true,
    target: targetValue,
    connections: [],
  }) as unknown as ApiModelConnectionsResponse
const unavailable: ApiModelConnectionsResponse = {
  availability: 'unavailable',
  canManage: false,
  target: null,
  connections: [],
} as unknown as ApiModelConnectionsResponse

describe('lead placement from the host-supplied execution target only', () => {
  test('a bound target is shown from the inventory target', () => {
    const { placement } = projectWorkspaceLeadPresentation({
      lead,
      connections: available(target),
    })
    expect(placement).toEqual({ state: 'bound', label: 'Remote host · Pi durable' })
  })

  test('no target is unknown, never inferred from a selected model or a lead default', () => {
    const { placement } = projectWorkspaceLeadPresentation({
      lead,
      connections: available(null),
    })
    expect(placement.state).toBe('unknown')
    expect(placement.label).toContain('Placement is not inferred from model selection')
  })

  test('an unavailable inventory is unknown placement', () => {
    expect(
      projectWorkspaceLeadPresentation({ lead, connections: unavailable }).placement.state
    ).toBe('unknown')
    expect(projectWorkspaceLeadPresentation({ lead, connections: null }).placement.state).toBe(
      'unknown'
    )
  })

  test('unrecognised enum values never render a label, including prototype keys', () => {
    for (const bad of [
      { ...target, location: 'mars' },
      { ...target, harness: 'constructor' },
      { ...target, location: 'toString' },
    ]) {
      expect(
        projectWorkspaceLeadPresentation({ lead, connections: available(bad) }).placement.state
      ).toBe('unknown')
    }
  })
})

describe('lead audience from the membership-gated record', () => {
  test('a designated lead is visible to members, and topics keep their own participants', () => {
    const { audience } = projectWorkspaceLeadPresentation({ lead, connections: null })
    expect(audience.label).toBe('Visible to workspace members')
    expect(audience.detail).toContain('Workspace membership alone does not grant topic history')
  })

  test('no lead is not provisioned; a failed read is unknown, not absent', () => {
    expect(projectWorkspaceLeadPresentation({ lead: null, connections: null }).audience.label).toBe(
      'Not provisioned'
    )
    expect(
      projectWorkspaceLeadPresentation({ lead: null, leadKnown: false, connections: null }).audience
        .label
    ).toBe('Unknown')
  })
})
