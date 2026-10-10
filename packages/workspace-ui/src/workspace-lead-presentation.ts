import type { AgentSummary } from '@adea-ai/types'
import type { ApiModelConnectionsResponse } from '@adea-ai/api-client/model-connections'

/**
 * Audience and execution placement for the structural lead, from authoritative
 * records only:
 * - audience: the lead record's membership-gated visibility, plus the rule that
 *   each conversation's audience is its own participants (docs/evidence/
 *   pi-durable-foundations.md). Workspace membership alone grants no topic history.
 * - placement: the execution target the host supplies in the model-connections
 *   inventory. It is never inferred from a selected model, a lead default, or an
 *   operator environment variable. Without a bound target the placement is unknown.
 */
export type WorkspaceLeadAudience = Readonly<{ label: string; detail: string }>
export type WorkspaceLeadPlacement =
  | Readonly<{ state: 'bound'; label: string }>
  | Readonly<{ state: 'unknown'; label: string }>
export type WorkspaceLeadPresentation = Readonly<{
  audience: WorkspaceLeadAudience
  placement: WorkspaceLeadPlacement
}>

const LOCATIONS: Readonly<Record<string, string>> = {
  local_device: 'This device',
  remote_host: 'Remote host',
  agent_hq_cloud: 'Adea cloud',
}
const HARNESSES: Readonly<Record<string, string>> = {
  pi: 'Pi',
  pi_durable: 'Pi durable',
  cloudflare_agents: 'Cloudflare agents',
  acp: 'ACP',
}

const UNKNOWN_PLACEMENT: WorkspaceLeadPlacement = {
  state: 'unknown',
  label:
    'Unknown: no execution target is bound to this workspace. Placement is not inferred from model selection.',
}

export function projectWorkspaceLeadPresentation(input: {
  lead: AgentSummary | null | undefined
  /** False when the lead record could not be read: its state is unknown, not absent. */
  leadKnown?: boolean
  connections: ApiModelConnectionsResponse | null
}): WorkspaceLeadPresentation {
  const audience: WorkspaceLeadAudience =
    input.leadKnown === false
      ? { label: 'Unknown', detail: 'The lead record could not be read.' }
      : input.lead?.isWorkspaceLead === true
        ? {
            label: 'Visible to workspace members',
            detail:
              'Each conversation keeps its own participants. Workspace membership alone does not grant topic history.',
          }
        : {
            label: 'Not provisioned',
            detail: 'Once set up, the lead is visible to workspace members.',
          }
  const target = input.connections?.availability === 'available' ? input.connections.target : null
  const location =
    target && Object.hasOwn(LOCATIONS, target.location) ? LOCATIONS[target.location] : undefined
  const harness =
    target && Object.hasOwn(HARNESSES, target.harness) ? HARNESSES[target.harness] : undefined
  const placement: WorkspaceLeadPlacement =
    location && harness ? { state: 'bound', label: `${location} · ${harness}` } : UNKNOWN_PLACEMENT
  return { audience, placement }
}
