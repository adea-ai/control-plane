import type { AgentSummary } from '@adea-ai/types'

/** The unconfigured workspace lead is not a missing version: nothing was chosen yet. */
export const UNCONFIGURED_LEAD_PROFILE_ID = 'workspace-lead-unconfigured'

export function agentProfileStateNotice(profile: AgentSummary['profile']): string {
  if (profile.state === 'available') return 'The selected profile version is configured.'
  if (profile.state === 'unavailable')
    return 'Profile check unavailable. Refresh to retry; the selected version is unchanged.'
  if (profile.id === UNCONFIGURED_LEAD_PROFILE_ID)
    return 'No profile is selected for the workspace lead yet. Choose an approved profile in Customize.'
  return `This profile version is ${profile.state}. Choose an approved, compatible version in Customize.`
}
