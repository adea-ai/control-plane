import { createMemo } from 'solid-js'
import type { AgentSummary } from '@adea-ai/types'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import type { StatusTone } from '@adea-ai/ui/components/ui/status-chip'
import { agentProfileStateNotice } from './agent-profile-state'

const TONES: Record<string, StatusTone> = {
  ready: 'success',
  warning: 'warning',
  muted: 'neutral',
  unknown: 'unknown',
}

export function agentStatusModel(agent: AgentSummary) {
  const { lifecycleState, profile } = agent
  const archived = lifecycleState === 'archived'
  const configurationError = lifecycleState === 'configuration_error'
  const configuration = archived
    ? { label: 'Archived', tone: 'muted' as const }
    : profile.state === 'unavailable'
      ? { label: 'Profile unavailable', tone: 'unknown' as const }
      : configurationError || profile.state !== 'available'
        ? { label: 'Needs configuration', tone: 'warning' as const }
        : { label: 'Configured', tone: 'ready' as const }
  return Object.freeze({
    configuration: Object.freeze({
      ...configuration,
      detail: archived
        ? 'Archived Agent.'
        : configurationError
          ? 'Review configuration.'
          : agentProfileStateNotice(profile),
    }),
    execution: Object.freeze({
      detail: 'Execution activity has not been reported.',
      label: 'Activity unknown',
      tone: 'unknown' as const,
    }),
    runtime: Object.freeze({
      detail: 'Runtime availability has not been reported.',
      label: 'Runtime unknown',
      tone: 'unknown' as const,
    }),
  })
}

export function AgentStatusBadge(props: { agent: AgentSummary }) {
  const status = createMemo(() => agentStatusModel(props.agent).configuration)
  return <StatusChip detail={status().detail} label={status().label} tone={TONES[status().tone]} />
}

export function AgentStatus(props: { agent: AgentSummary; compact?: boolean }) {
  const status = createMemo(() => agentStatusModel(props.agent))
  return (
    <div
      class={`conventional-agent-status${props.compact ? ' conventional-agent-status--compact' : ''}`}
    >
      <StatusChip
        detail={status().configuration.detail}
        label={status().configuration.label}
        tone={TONES[status().configuration.tone]}
      />
      <StatusChip
        detail={status().runtime.detail}
        label={status().runtime.label}
        tone={TONES[status().runtime.tone]}
      />
      <StatusChip
        detail={status().execution.detail}
        label={status().execution.label}
        tone={TONES[status().execution.tone]}
      />
    </div>
  )
}
