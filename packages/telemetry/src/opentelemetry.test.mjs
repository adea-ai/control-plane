import { describe, expect, test } from 'bun:test'
import { metrics } from '@opentelemetry/api'
import {
  InMemoryMetricExporter,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { createOpenTelemetryMetricAdapter } from './opentelemetry.ts'
import { createOperationsMetricEmitter, operationsMetricNames } from './operations.ts'

/**
 * Walks the collected resource metrics and returns the metric by name. The
 * adapter binds instruments through the global meter provider, so every test
 * installs its own MeterProvider + in-memory reader and restores the global
 * state afterwards.
 */
function findMetric(resourceMetrics, name) {
  for (const resource of resourceMetrics) {
    for (const scope of resource.scopeMetrics) {
      const metric = scope.metrics.find((candidate) => candidate.descriptor.name === name)
      if (metric !== undefined) return metric
    }
  }
  throw new Error(`metric not collected: ${name}`)
}

describe('OpenTelemetry metric adapter (real SDK instruments)', () => {
  test('signed growth observations survive the actual adapter path as gauge points', async () => {
    const exporter = new InMemoryMetricExporter()
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 2_147_483_647,
    })
    const provider = new MeterProvider({ readers: [reader] })
    metrics.setGlobalMeterProvider(provider)
    try {
      const adapter = createOpenTelemetryMetricAdapter('operations-otel-proof')
      const emitter = createOperationsMetricEmitter(adapter, 'operations-otel-proof')

      // Shrinkage, zero and growth each observe through the gauge instrument;
      // the bounding namespaces keep them as three distinct data points.
      emitter.record({
        name: operationsMetricNames.storageGrowthBytes,
        value: -512,
        labels: { namespace: 'executions' },
      })
      emitter.record({
        name: operationsMetricNames.storageGrowthBytes,
        value: 0,
        labels: { namespace: 'usage-ledger-entries' },
      })
      emitter.record({
        name: operationsMetricNames.storageGrowthBytes,
        value: 2048,
        labels: { namespace: 'total' },
      })
      // Re-measuring the same series re-observes the last value: the gauge is
      // non-additive, never an accumulating counter.
      emitter.record({
        name: operationsMetricNames.storageGrowthBytes,
        value: -256,
        labels: { namespace: 'executions' },
      })
      // Latency keeps histogram observation semantics.
      emitter.record({
        name: operationsMetricNames.queueLatency,
        value: 1500,
        labels: { stage: 'dispatch', statistic: 'median' },
      })

      await reader.forceFlush()
      const collected = exporter.getMetrics()

      const growth = findMetric(collected, operationsMetricNames.storageGrowthBytes)
      expect(growth.descriptor.type).toBe(InstrumentType.GAUGE)
      expect([...growth.dataPoints].map((point) => point.value).toSorted((a, b) => a - b)).toEqual([
        -256, 0, 2048,
      ])
      const executions = growth.dataPoints.find(
        (point) => point.attributes.namespace === 'executions'
      )
      // The re-observation replaced -512 with -256 (last-value semantics).
      expect(executions.value).toBe(-256)

      const latency = findMetric(collected, operationsMetricNames.queueLatency)
      expect(latency.descriptor.type).toBe(InstrumentType.HISTOGRAM)
      expect(latency.dataPoints).toHaveLength(1)
      expect(latency.dataPoints[0].value.count).toBe(1)
      expect(latency.dataPoints[0].value.sum).toBe(1500)
    } finally {
      await provider.shutdown()
      metrics.disable()
    }
  })

  test('the real histogram path silently drops negative values, which is why growth must not use it', async () => {
    const exporter = new InMemoryMetricExporter()
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 2_147_483_647,
    })
    const provider = new MeterProvider({ readers: [reader] })
    metrics.setGlobalMeterProvider(provider)
    try {
      const adapter = createOpenTelemetryMetricAdapter('operations-otel-histogram-proof')
      // Direct adapter calls: the SDK histogram warns via diag and discards
      // the negative observation without throwing — the silent loss the
      // gauge routing removes.
      adapter.record('execution.queue.latency', -4096, {})
      adapter.record('execution.queue.latency', 1500, { stage: 'dispatch' })

      await reader.forceFlush()
      const latency = findMetric(exporter.getMetrics(), 'execution.queue.latency')
      expect(latency.descriptor.type).toBe(InstrumentType.HISTOGRAM)
      expect(latency.dataPoints).toHaveLength(1)
      expect(latency.dataPoints[0].value.count).toBe(1)
      expect(latency.dataPoints[0].value.sum).toBe(1500)
    } finally {
      await provider.shutdown()
      metrics.disable()
    }
  })
})
