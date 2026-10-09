import { operationalMetrics } from './catalog.js'
import { sanitizeAttributes } from './redaction.js'
import type { MetricAdapter } from './types.js'

/**
 * Cataloged operational metric names for runtime operations measurement.
 * Every name must be a member of `operationalMetrics` in ./catalog.ts.
 */
export const operationsMetricNames = {
  queueLatency: 'execution.queue.latency',
  humanLatency: 'execution.human.latency',
  retryAge: 'execution.retry.age',
  reconciliationAge: 'execution.reconciliation.age',
  usageCostUsd: 'usage.cost.usd',
  storageRetainedBytes: 'storage.retained.bytes',
  storageGrowthBytes: 'storage.growth.bytes',
  activeObjectCount: 'runtime.active_object.count',
  operatingCostUsd: 'operations.operating_cost.usd',
} as const

export type OperationsMetricName =
  (typeof operationsMetricNames)[keyof typeof operationsMetricNames]

/**
 * Storage namespaces an operations measurement may label storage metrics with,
 * plus the measured-set `total`. Producers should report only these values;
 * anything else degrades to the bounded `other` label at the emitter.
 */
export const operationsStorageNamespaces = [
  'execution-attempts',
  'execution-events',
  'execution-plans',
  'executions',
  'interaction-requests',
  'runtime-channel-sequences',
  'runtime-commands',
  'runtime-discovery-connections',
  'runtime-discovery-sessions',
  'usage-budgets',
  'usage-effects',
  'usage-entry-sequences',
  'usage-ledger-entries',
  'total',
] as const

export type OperationsStorageNamespace = (typeof operationsStorageNamespaces)[number]

const latencyStatistics = new Set(['min', 'median', 'max'])

/**
 * The complete label contract for operations metrics: label key → allowed
 * values, per metric name. Label cardinality is bounded by construction, the
 * same rule `consistency.ts` applies: objective text, workspace identifiers,
 * execution identifiers and other unbounded values can never reach a metric
 * label, and unknown values degrade to `other` instead of multiplying series.
 * Workspace scoping lives in the measurement report (and in span/log correlation
 * attributes), never in metric labels.
 */
const operationsMetricLabels: Readonly<
  Record<OperationsMetricName, Readonly<Record<string, ReadonlySet<string>>>>
> = {
  [operationsMetricNames.queueLatency]: {
    stage: new Set(['dispatch', 'wait']),
    statistic: latencyStatistics,
  },
  [operationsMetricNames.humanLatency]: {
    outcome: new Set(['responded', 'waiting']),
    statistic: latencyStatistics,
  },
  [operationsMetricNames.retryAge]: {
    kind: new Set(['gap', 'current']),
    statistic: latencyStatistics,
  },
  [operationsMetricNames.reconciliationAge]: {
    statistic: latencyStatistics,
  },
  [operationsMetricNames.usageCostUsd]: {
    exactness: new Set(['exact', 'inexact']),
  },
  [operationsMetricNames.storageRetainedBytes]: {
    namespace: new Set(operationsStorageNamespaces),
  },
  [operationsMetricNames.storageGrowthBytes]: {
    namespace: new Set(operationsStorageNamespaces),
  },
  [operationsMetricNames.activeObjectCount]: {
    object_kind: new Set(['execution', 'job', 'attempt', 'session', 'approval', 'effect']),
  },
  [operationsMetricNames.operatingCostUsd]: {
    component: new Set(['storage', 'total']),
  },
}

/**
 * One telemetry-ready measurement point produced by an operations measurement
 * report: a cataloged metric name, a non-negative finite value and bounded
 * labels. Points carry identifiers and payloads nowhere — they are counts,
 * byte totals, latencies in milliseconds and costs in US dollars only.
 */
export interface OperationsMetricPoint {
  readonly name: string
  readonly value: number
  readonly labels?: Readonly<Record<string, string>>
}

/** The single operations-measurement emission port. */
export interface OperationsMetricEmitter {
  record(point: OperationsMetricPoint): void
}

function isOperationsMetricName(name: string): name is OperationsMetricName {
  return Object.hasOwn(operationsMetricLabels, name)
}

function boundLabels(
  name: OperationsMetricName,
  labels: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const allowed = operationsMetricLabels[name]
  const bounded: Record<string, string> = {}
  if (labels === undefined) return bounded
  for (const [key, value] of Object.entries(labels)) {
    const allowedValues = allowed[key]
    // Unknown label keys are dropped rather than forwarded: a producer outside
    // this contract must not be able to attach arbitrary series dimensions.
    if (allowedValues === undefined) continue
    const candidate = typeof value === 'string' ? value : ''
    bounded[key] = allowedValues.has(candidate) ? candidate : 'other'
  }
  return bounded
}

/**
 * Records operations measurement points through the shared metric adapter.
 * Emission is observability, never authority: an unknown metric name, an
 * invalid value or an exporter exception is dropped without failing the
 * caller, and every label value is coerced into the fixed contract above
 * after `sanitizeAttributes` has run over the final attribute set.
 */
export function createOperationsMetricEmitter(
  adapter: MetricAdapter,
  serviceName: string
): OperationsMetricEmitter {
  return {
    record(point: OperationsMetricPoint): void {
      try {
        if (!isOperationsMetricName(point.name)) return
        if (!isOperationsMetricCataloged(point.name)) return
        if (!Number.isFinite(point.value) || point.value < 0) return
        const attributes = sanitizeAttributes({
          'service.name': serviceName,
          ...boundLabels(point.name, point.labels),
        })
        adapter.add(point.name, point.value, attributes)
      } catch {
        // Observability is deliberately non-authoritative and fail-open.
      }
    },
  }
}

/** True when the name is an operations metric cataloged for emission. */
export function isOperationsMetricCataloged(name: string): boolean {
  return isOperationsMetricName(name) && (operationalMetrics as readonly string[]).includes(name)
}
