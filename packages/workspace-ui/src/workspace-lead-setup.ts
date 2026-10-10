import type { AgentSummary } from '@adea-ai/types'
import type { ApiWorkspaceModelDefaults } from '@adea-ai/api-client/model-connections'
import { projectRoleModel, type SelectableModel } from './lead-model-state'

/**
 * Lead-specific setup state for the canonical workspace entry. It reads only the
 * structural lead record, its profile availability, and the existing lead role
 * model projection (#1211 eligibility). It never selects another roster agent,
 * never infers funding from account presence, and fails closed to funding_blocked
 * whenever the eligibility projection yields no ready model.
 *
 * setup_ready is a UI projection only: execution still requires CP prepare and
 * funding evidence.
 */
export type WorkspaceLeadSetup =
  | Readonly<{ state: 'auth_required'; detail: string }>
  | Readonly<{ state: 'unavailable'; detail: string }>
  | Readonly<{ state: 'not_permitted'; detail: string }>
  | Readonly<{ state: 'missing'; detail: string }>
  | Readonly<{ state: 'provisioning_failed'; detail: string }>
  | Readonly<{ state: 'inactive'; detail: string }>
  | Readonly<{ state: 'unconfigured'; detail: string }>
  | Readonly<{ state: 'funding_blocked'; detail: string }>
  | Readonly<{ state: 'setup_ready'; detail: string; model: SelectableModel }>

export function projectWorkspaceLeadSetup(input: {
  lead: AgentSummary | null | undefined
  /** A read or session failure, or a missing manage permission; never reads as a lead. */
  failure?: 'auth_required' | 'unavailable' | 'not_permitted'
  /** Provisioning outcome from the protected lead route; `failed` never reads as a lead. */
  provisioning?: 'failed'
  connections: unknown
  defaults: ApiWorkspaceModelDefaults | null | undefined
}): WorkspaceLeadSetup {
  if (input.failure === 'auth_required')
    return { state: 'auth_required', detail: 'Sign in to set up the workspace lead.' }
  if (input.failure === 'unavailable')
    return { state: 'unavailable', detail: 'Lead status could not be read. Try again.' }
  if (input.failure === 'not_permitted')
    return {
      state: 'not_permitted',
      detail: 'This workspace has no lead yet. A workspace admin can set one up.',
    }
  const lead = input.lead
  if (!lead || lead.isWorkspaceLead !== true) {
    return input.provisioning === 'failed'
      ? {
          state: 'provisioning_failed',
          detail: 'The workspace lead could not be set up. Try again.',
        }
      : { state: 'missing', detail: 'This workspace has no lead yet.' }
  }
  if (lead.lifecycleState !== 'active')
    return { state: 'inactive', detail: 'The workspace lead is not active.' }
  if (lead.profile.state !== 'available')
    return {
      state: 'unconfigured',
      detail: 'Choose an approved profile for the workspace lead in Customize.',
    }
  const model = projectRoleModel(input.connections, input.defaults, 'lead')
  if (!model)
    return {
      state: 'funding_blocked',
      detail: 'Choose a ready model for the workspace lead in agent models before it can run.',
    }
  return {
    state: 'setup_ready',
    detail:
      'A ready model is selected for the lead. Execution still requires the prepare and funding check.',
    model,
  }
}
