import { sanitizeAttributes } from './redaction.js'
import type { MetricAdapter } from './types.js'

/**
 * Cataloged operational metric names for execution-consistency observability.
 * Every name must be a member of `operationalMetrics` in ./catalog.ts.
 */
export const consistencyMetricNames = {
  commandInboxDuplicate: 'control.command_inbox.duplicate.count',
  commandInboxConflict: 'control.command_inbox.conflict.count',
  contextProviderResolution: 'context.provider_resolution.count',
  memoryWriteDecision: 'memory.write.decision.count',
  eventQuarantine: 'control.event.quarantine.count',
  executionReconciliation: 'execution.reconciliation.count',
  executionManualIntervention: 'execution.manual_intervention.count',
} as const

const commandInboxOutcomes = new Set(['accepted', 'duplicate', 'conflict'])
const providerResolutionOutcomes = new Set([
  'included',
  'degraded',
  'omitted',
  'awaiting_input',
  'disabled',
])
const providerResolutionReasonCategories = new Set([
  'PROVIDER_SELECTED',
  'CACHE_HIT',
  'POLICY_DISABLED',
  'NO_ELIGIBLE_PROVIDER',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REVOKED',
  'PROVIDER_SCOPE_MISMATCH',
  'PROVIDER_OUTPUT_INVALID',
  'PROVIDER_OUTPUT_STALE',
  'PROVIDER_BUDGET_EXCEEDED',
])
const memoryWriteDecisions = new Set(['approved', 'denied', 'expired'])
const reconciliationReasons = new Set([
  'accepted_unstarted',
  'stale_heartbeat',
  'runtime_disconnected',
  'runtime_disappeared',
  'workflow_stalled',
  'runtime_terminal_unrecorded',
  'terminal_undelivered',
  'healthy',
])

/**
 * Label cardinality is bounded by construction: every label value must be a member
 * of the fixed sets above (or a fixed fallback). Objective text, scope digests,
 * provider identifiers, workspace identifiers and other unbounded values can never
 * reach a metric label.
 */
const unboundedLabelFallback = 'other'

function boundedLabel(value: string, allowed: ReadonlySet<string>): string {
  return allowed.has(value) ? value : unboundedLabelFallback
}

function quarantineReasonCategory(code: string): string {
  if (code === 'TRANSPORT_ERROR') return 'transport_error'
  if (code === 'SCHEMA_MISMATCH' || code === 'RAW_RUNTIME_PAYLOAD') return 'schema_mismatch'
  if (code === 'AUTHENTICATION_CONFIGURATION') return 'auth_configuration'
  if (/^HTTP_5\d\d$/.test(code)) return 'http_server'
  if (/^HTTP_4(?:08|25|29)$/.test(code)) return 'http_retryable'
  if (/^HTTP_4\d\d$/.test(code)) return 'http_client'
  return unboundedLabelFallback
}

export type CommandInboxAcceptanceOutcome = 'accepted' | 'duplicate' | 'conflict'

/**
 * The single consistency-metric emission port. One instance structurally satisfies
 * every package-local metrics hook (`CommandInboxMetrics`, `ReconciliationMetrics`,
 * `ContextProviderResolutionMetrics`, `MemoryWriteDecisionMetrics`,
 * `EventDeliveryMetrics`), so compositions wire one object everywhere.
 */
export interface ConsistencyMetricEmitter {
  recordAcceptanceOutcome(outcome: CommandInboxAcceptanceOutcome): void
  recordResolution(outcome: string, reasonCategory: string): void
  recordApprovalDecision(decision: string): void
  recordQuarantine(input: { readonly reason: string; readonly attempted: boolean }): void
  recordCheckpoint(input: {
    readonly reason: string
    readonly state: string
    readonly created: boolean
  }): void
}

export function createConsistencyMetricEmitter(
  adapter: MetricAdapter,
  serviceName: string
): ConsistencyMetricEmitter {
  // Per-emission isolation: an exporter exception can never fail the emitting operation.
  function add(name: string, labels: Readonly<Record<string, string | boolean>>): void {
    try {
      adapter.add(name, 1, sanitizeAttributes({ 'service.name': serviceName, ...labels }))
    } catch {
      // Observability is deliberately non-authoritative and fail-open.
    }
  }
  return {
    recordAcceptanceOutcome(outcome) {
      if (!commandInboxOutcomes.has(outcome) || outcome === 'accepted') return
      add(
        outcome === 'duplicate'
          ? consistencyMetricNames.commandInboxDuplicate
          : consistencyMetricNames.commandInboxConflict,
        { outcome }
      )
    },
    recordResolution(outcome, reasonCategory) {
      add(consistencyMetricNames.contextProviderResolution, {
        outcome: boundedLabel(outcome, providerResolutionOutcomes),
        reason: boundedLabel(reasonCategory, providerResolutionReasonCategories),
      })
    },
    recordApprovalDecision(decision) {
      add(consistencyMetricNames.memoryWriteDecision, {
        decision: boundedLabel(decision, memoryWriteDecisions),
      })
    },
    recordQuarantine(input) {
      add(consistencyMetricNames.eventQuarantine, {
        reason_category: quarantineReasonCategory(input.reason),
        attempted: input.attempted,
      })
    },
    recordCheckpoint(input) {
      const reason = boundedLabel(input.reason, reconciliationReasons)
      add(consistencyMetricNames.executionReconciliation, {
        reason,
        outcome: input.created ? 'created' : 'observed',
      })
      if (input.state === 'manual_intervention') {
        add(consistencyMetricNames.executionManualIntervention, { reason })
      }
    },
  }
}
