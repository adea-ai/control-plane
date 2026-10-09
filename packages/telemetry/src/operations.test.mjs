import { describe, expect, test } from 'bun:test'
import {
  createOperationsMetricEmitter,
  isOperationsMetricCataloged,
  operationsMetricNames,
  operationsStorageNamespaces,
} from './operations.ts'
import { operationalMetrics } from './catalog.ts'

function recordingAdapter() {
  const added = []
  const adapter = {
    add(name, value, attributes) {
      added.push({ name, value, attributes })
    },
    record(name, value, attributes) {
      added.push({ name, value, attributes })
    },
  }
  return { adapter, added }
}

describe('operations metric contract', () => {
  test('every operations metric name is cataloged in operationalMetrics', () => {
    for (const name of Object.values(operationsMetricNames)) {
      expect(operationalMetrics).toContain(name)
      expect(isOperationsMetricCataloged(name)).toBe(true)
    }
    expect(isOperationsMetricCataloged('execution.not_a_metric')).toBe(false)
  })

  test('records a point with bounded labels and the service identity', () => {
    const { adapter, added } = recordingAdapter()
    const emitter = createOperationsMetricEmitter(adapter, 'local-control-plane')

    emitter.record({
      name: operationsMetricNames.queueLatency,
      value: 1500,
      labels: { stage: 'dispatch', statistic: 'median' },
    })

    expect(added).toEqual([
      {
        name: 'execution.queue.latency',
        value: 1500,
        attributes: {
          'service.name': 'local-control-plane',
          stage: 'dispatch',
          statistic: 'median',
        },
      },
    ])
  })

  test('drops unknown label keys, coerces unknown label values and skips invalid points', () => {
    const { adapter, added } = recordingAdapter()
    const emitter = createOperationsMetricEmitter(adapter, 'control-api')

    emitter.record({
      name: operationsMetricNames.activeObjectCount,
      value: 4,
      // `workspace.id` is an identifier and must never become a metric label;
      // the object_kind value is outside the fixed set and must degrade.
      labels: { object_kind: 'delegation', 'workspace.id': 'wsp_01ABC', extra: 'x' },
    })
    emitter.record({ name: 'execution.not_a_metric', value: 1 })
    emitter.record({ name: operationsMetricNames.usageCostUsd, value: -1 })
    emitter.record({ name: operationsMetricNames.usageCostUsd, value: Number.NaN })

    expect(added).toEqual([
      {
        name: 'runtime.active_object.count',
        value: 4,
        attributes: { 'service.name': 'control-api', object_kind: 'other' },
      },
    ])
  })

  test('accepts every storage namespace in the operations storage contract', () => {
    const { adapter, added } = recordingAdapter()
    const emitter = createOperationsMetricEmitter(adapter, 'local-control-plane')
    for (const namespace of operationsStorageNamespaces) {
      emitter.record({
        name: operationsMetricNames.storageRetainedBytes,
        value: 1024,
        labels: { namespace },
      })
    }
    expect(added.map(({ attributes }) => attributes.namespace)).toEqual([
      ...operationsStorageNamespaces,
    ])
    for (const { attributes } of added) expect(attributes.namespace).not.toBe('other')
  })

  test('is fail-open when the metric adapter throws', () => {
    const exploding = {
      add() {
        throw new Error('exporter down')
      },
      record() {
        throw new Error('exporter down')
      },
    }
    const emitter = createOperationsMetricEmitter(exploding, 'local-control-plane')
    expect(() =>
      emitter.record({ name: operationsMetricNames.reconciliationAge, value: 10 })
    ).not.toThrow()
  })

  test('never forwards prohibited payload fields through the attribute set', () => {
    const { adapter, added } = recordingAdapter()
    const emitter = createOperationsMetricEmitter(adapter, 'local-control-plane')
    emitter.record({
      name: operationsMetricNames.operatingCostUsd,
      value: 1.5,
      labels: { component: 'total' },
    })
    const serialized = JSON.stringify(added[0].attributes)
    expect(serialized).not.toContain('prompt')
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('token')
    expect(added[0].attributes).toEqual({
      'service.name': 'local-control-plane',
      component: 'total',
    })
  })
})
