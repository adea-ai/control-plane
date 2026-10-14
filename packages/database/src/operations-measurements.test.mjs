import { describe, expect, test } from 'bun:test'
import { operationsMetricNames } from '@control-plane/telemetry'
import {
  assemblePostgresOperationsPoints,
  createPostgresOperationsMeasurementProducer,
  createPostgresRuntimeMeasurements,
  postgresMeasuredNamespaces,
} from './operations-measurements.ts'

const WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFG'
const NOW = new Date('2026-10-14T12:00:00.000Z')

const storage = (bytes, rewritten = 0) => ({ bytes, rewritten })
const stats = (value) => ({ min: value, median: value, max: value })

function completeOutcomes(overrides = {}) {
  const complete = (facts) => ({ status: 'complete', facts })
  return {
    executions: complete({ active: 3, reconciliation: stats(10), storage: storage(100, 5) }),
    'execution-attempts': complete({
      active: 2,
      gap: stats(20),
      current: stats(30),
      storage: storage(200, 6),
    }),
    'interaction-requests': complete({
      pending: 1,
      responded: stats(40),
      waiting: stats(50),
      storage: storage(300, 7),
    }),
    'runtime-commands': complete({
      active: 4,
      dispatch: stats(60),
      waiting: stats(70),
      storage: storage(400, 8),
    }),
    'execution-events': complete({ active: 5, storage: storage(500, 9) }),
    'runtime-discovery-sessions': complete({ active: 6, storage: storage(600, 10) }),
    'runtime-discovery-connections': complete({ storage: storage(700, 11) }),
    'execution-plans': complete({ storage: storage(800, 12) }),
    'usage-ledger-entries': complete({
      usd: { exact: 1_500_000, inexact: 250_000 },
      storage: storage(900, 13),
    }),
    'usage-budgets': complete({
      records: 2,
      currencies: ['USD'],
      usdSpentMicrounits: 3_500_000,
      storage: storage(1000, null),
    }),
    'usage-effects': complete({ storage: storage(1100, null) }),
    ...overrides,
  }
}

const find = (points, name, labels = {}) =>
  points.filter(
    (point) =>
      point.name === name && Object.entries(labels).every(([k, v]) => point.labels?.[k] === v)
  )

describe('assemblePostgresOperationsPoints', () => {
  test('emits every family from complete sources with no growth before a baseline', () => {
    const { points, nextBaseline } = assemblePostgresOperationsPoints(
      completeOutcomes(),
      undefined,
      undefined
    )
    expect(find(points, operationsMetricNames.queueLatency)).toHaveLength(6)
    expect(find(points, operationsMetricNames.humanLatency)).toHaveLength(6)
    expect(find(points, operationsMetricNames.retryAge)).toHaveLength(6)
    expect(find(points, operationsMetricNames.reconciliationAge)).toHaveLength(3)
    expect(find(points, operationsMetricNames.usageCostUsd, { exactness: 'exact' })[0].value).toBe(
      1.5
    )
    expect(find(points, operationsMetricNames.activeObjectCount)).toHaveLength(6)
    expect(find(points, operationsMetricNames.storageGrowthBytes)).toHaveLength(0)
    expect(
      find(points, operationsMetricNames.storageRetainedBytes, { namespace: 'total' })[0].value
    ).toBe(6600)
    // Rewritten bytes only where a last-write timestamp exists; never a total.
    expect(find(points, operationsMetricNames.storageRewrittenBytes)).toHaveLength(9)
    expect(
      find(points, operationsMetricNames.storageRewrittenBytes, { namespace: 'total' })
    ).toHaveLength(0)
    expect(find(points, operationsMetricNames.operatingCostUsd)).toHaveLength(0)
    expect(nextBaseline?.size).toBe(postgresMeasuredNamespaces.length)
  })

  test('computes signed growth against the baseline per namespace and in total', () => {
    const baseline = new Map(postgresMeasuredNamespaces.map((namespace) => [namespace, 1000]))
    const { points } = assemblePostgresOperationsPoints(completeOutcomes(), baseline, undefined)
    const growth = (namespace) =>
      find(points, operationsMetricNames.storageGrowthBytes, { namespace })[0]?.value
    expect(growth('executions')).toBe(-900)
    expect(growth('usage-effects')).toBe(100)
    expect(growth('total')).toBe(6600 - 11 * 1000)
  })

  test('suppresses aggregate bytes and growth when the cross-namespace sum is unsafe', () => {
    const outcomes = completeOutcomes({
      executions: {
        status: 'complete',
        facts: {
          active: 3,
          reconciliation: stats(10),
          storage: storage(Number.MAX_SAFE_INTEGER, 5),
        },
      },
    })
    const baseline = new Map(postgresMeasuredNamespaces.map((namespace) => [namespace, 1000]))
    const { points, nextBaseline } = assemblePostgresOperationsPoints(outcomes, baseline, 2)

    expect(
      find(points, operationsMetricNames.storageRetainedBytes, { namespace: 'executions' })[0].value
    ).toBe(Number.MAX_SAFE_INTEGER)
    expect(
      find(points, operationsMetricNames.storageRetainedBytes, { namespace: 'total' })
    ).toHaveLength(0)
    expect(
      find(points, operationsMetricNames.storageGrowthBytes, { namespace: 'total' })
    ).toHaveLength(0)
    expect(find(points, operationsMetricNames.operatingCostUsd)).toHaveLength(0)
    expect(nextBaseline?.size).toBe(postgresMeasuredNamespaces.length)
  })

  test('suppresses total growth when the baseline aggregate is unsafe', () => {
    const baseline = new Map(
      postgresMeasuredNamespaces.map((namespace) => [namespace, Number.MAX_SAFE_INTEGER])
    )
    const { points } = assemblePostgresOperationsPoints(completeOutcomes(), baseline, undefined)

    expect(
      find(points, operationsMetricNames.storageRetainedBytes, { namespace: 'total' })[0].value
    ).toBe(6600)
    expect(
      find(points, operationsMetricNames.storageGrowthBytes, { namespace: 'executions' })
    ).toHaveLength(1)
    expect(
      find(points, operationsMetricNames.storageGrowthBytes, { namespace: 'total' })
    ).toHaveLength(0)
  })

  test('suppresses priced storage points when computed microunits are unsafe', () => {
    const outcomes = completeOutcomes({
      executions: {
        status: 'complete',
        facts: {
          active: 3,
          reconciliation: stats(10),
          storage: storage(1_000_000_000_000_000, 5),
        },
      },
    })
    const { points } = assemblePostgresOperationsPoints(outcomes, undefined, 100_000)

    expect(
      find(points, operationsMetricNames.storageRetainedBytes, { namespace: 'total' })
    ).toHaveLength(1)
    expect(find(points, operationsMetricNames.operatingCostUsd)).toHaveLength(0)
  })

  test('a source that is not complete suppresses its points, the total, cost and baseline', () => {
    const outcomes = completeOutcomes({
      'runtime-commands': { status: 'incomplete', reason: 'row_budget_reached' },
      'usage-effects': { status: 'unavailable', reason: 'permission_denied' },
    })
    const baseline = new Map(postgresMeasuredNamespaces.map((namespace) => [namespace, 1]))
    const { points, nextBaseline } = assemblePostgresOperationsPoints(outcomes, baseline, 10)
    expect(find(points, operationsMetricNames.queueLatency)).toHaveLength(0)
    expect(
      find(points, operationsMetricNames.activeObjectCount, { object_kind: 'job' })
    ).toHaveLength(0)
    expect(
      find(points, operationsMetricNames.storageRetainedBytes, { namespace: 'runtime-commands' })
    ).toHaveLength(0)
    expect(
      find(points, operationsMetricNames.storageRetainedBytes, { namespace: 'total' })
    ).toHaveLength(0)
    expect(
      find(points, operationsMetricNames.storageGrowthBytes, { namespace: 'total' })
    ).toHaveLength(0)
    expect(find(points, operationsMetricNames.operatingCostUsd)).toHaveLength(0)
    expect(nextBaseline).toBeUndefined()
    // Independent sources still report.
    expect(
      find(points, operationsMetricNames.activeObjectCount, { object_kind: 'execution' })[0].value
    ).toBe(3)
  })

  test('emits no latency or usage-cost points without samples', () => {
    const outcomes = completeOutcomes({
      'runtime-commands': {
        status: 'complete',
        facts: { active: 0, dispatch: null, waiting: null, storage: storage(1) },
      },
      'usage-ledger-entries': { status: 'complete', facts: { usd: null, storage: storage(1) } },
    })
    const { points } = assemblePostgresOperationsPoints(outcomes, undefined, undefined)
    expect(find(points, operationsMetricNames.queueLatency)).toHaveLength(0)
    expect(find(points, operationsMetricNames.usageCostUsd)).toHaveLength(0)
    expect(
      find(points, operationsMetricNames.activeObjectCount, { object_kind: 'job' })[0].value
    ).toBe(0)
  })

  test('prices storage only with an explicit rate and totals only for one USD budget currency', () => {
    const priced = assemblePostgresOperationsPoints(completeOutcomes(), undefined, 2).points
    const storageUsd = find(priced, operationsMetricNames.operatingCostUsd, {
      component: 'storage',
    })[0].value
    expect(storageUsd).toBe(Math.round((6600 / 1024 ** 3) * 2 * 1e6) / 1e6)
    expect(
      find(priced, operationsMetricNames.operatingCostUsd, { component: 'total' })[0].value
    ).toBeCloseTo(storageUsd + 3.5, 9)

    const mixed = completeOutcomes({
      'usage-budgets': {
        status: 'complete',
        facts: {
          records: 2,
          currencies: ['EUR', 'USD'],
          usdSpentMicrounits: 1,
          storage: storage(1000, null),
        },
      },
    })
    const mixedPoints = assemblePostgresOperationsPoints(mixed, undefined, 2).points
    expect(
      find(mixedPoints, operationsMetricNames.operatingCostUsd, { component: 'storage' })
    ).toHaveLength(1)
    expect(
      find(mixedPoints, operationsMetricNames.operatingCostUsd, { component: 'total' })
    ).toHaveLength(0)

    const euroOnly = completeOutcomes({
      'usage-budgets': {
        status: 'complete',
        facts: {
          records: 1,
          currencies: ['EUR'],
          usdSpentMicrounits: null,
          storage: storage(1000, null),
        },
      },
    })
    expect(
      find(
        assemblePostgresOperationsPoints(euroOnly, undefined, 2).points,
        operationsMetricNames.operatingCostUsd,
        { component: 'total' }
      )
    ).toHaveLength(0)

    const overflow = completeOutcomes({
      'usage-budgets': {
        status: 'complete',
        facts: {
          records: 1,
          currencies: ['USD'],
          usdSpentMicrounits: Number.MAX_SAFE_INTEGER,
          storage: storage(1000, null),
        },
      },
    })
    expect(
      find(
        assemblePostgresOperationsPoints(overflow, undefined, 1e5).points,
        operationsMetricNames.operatingCostUsd,
        { component: 'total' }
      )
    ).toHaveLength(0)
  })
})

/** A database double: canned rows per source, in the producer's fixed read order. */
function fakeDatabase({ rowsBySource, failBegin, failSources = [], log = [] }) {
  let read = 0
  const savepoint = () => ({
    execute: async () => {
      const index = read
      read += 1
      const namespace = postgresMeasuredNamespaces[index]
      if (failSources.includes(namespace)) {
        throw Object.assign(new Error(`relation secret_table denied for role pw-leaky-secret`), {
          code: '42501',
        })
      }
      return [rowsBySource[namespace]]
    },
  })
  return {
    log,
    transaction: async (callback, config) => {
      log.push({ config })
      if (failBegin) throw new Error('connect ECONNREFUSED postgres://user:pw-leaky-secret@host/db')
      return callback({
        execute: async () => [],
        transaction: async (inner) => inner(savepoint()),
      })
    },
  }
}

const baseRow = (overrides = {}) => ({
  scanned: '1',
  executions_truncated: false,
  active: '0',
  pending: '0',
  bytes: '10',
  rewritten: '1',
  reconciliation_n: '0',
  gap_n: '0',
  current_n: '0',
  responded_n: '0',
  waiting_n: '0',
  dispatch_n: '0',
  usd_entries: '0',
  negative_entries: '0',
  usd_exact: '0',
  usd_inexact: '0',
  malformed: '0',
  currencies: '',
  usd_spent: '0',
  ...overrides,
})

const allRows = (overrides = {}) =>
  Object.fromEntries(postgresMeasuredNamespaces.map((n) => [n, baseRow(overrides[n])]))

describe('createPostgresOperationsMeasurementProducer', () => {
  const producer = (database, extra = {}) =>
    createPostgresOperationsMeasurementProducer({
      database,
      workspaceId: WORKSPACE,
      now: () => NOW,
      ...extra,
    })

  test('rejects invalid scope and bounds before any query', () => {
    const database = fakeDatabase({ rowsBySource: allRows() })
    const invalid = (extra) => () => producer(database, extra)
    expect(() =>
      createPostgresOperationsMeasurementProducer({ database, workspaceId: 'not-a-workspace' })
    ).toThrow('POSTGRES_MEASUREMENT_WORKSPACE_INVALID')
    expect(invalid({ maxScanRows: 0 })).toThrow('POSTGRES_MEASUREMENT_SCAN_BOUND_INVALID')
    expect(invalid({ maxScanRows: 1_000_001 })).toThrow('POSTGRES_MEASUREMENT_SCAN_BOUND_INVALID')
    expect(invalid({ windowSeconds: 59 })).toThrow('POSTGRES_MEASUREMENT_WINDOW_INVALID')
    expect(invalid({ statementTimeoutMs: 9 })).toThrow(
      'POSTGRES_MEASUREMENT_STATEMENT_TIMEOUT_INVALID'
    )
    expect(invalid({ lockTimeoutMs: 20_000 })).toThrow('POSTGRES_MEASUREMENT_LOCK_TIMEOUT_INVALID')
    expect(invalid({ storageUsdPerGiBMonth: -1 })).toThrow(
      'POSTGRES_MEASUREMENT_STORAGE_RATE_INVALID'
    )
    expect(invalid({ storageUsdPerGiBMonth: Number.NaN })).toThrow(
      'POSTGRES_MEASUREMENT_STORAGE_RATE_INVALID'
    )
    expect(database.log).toEqual([])
  })

  test('opens exactly one read-only repeatable-read transaction per pass', async () => {
    const database = fakeDatabase({ rowsBySource: allRows() })
    const result = await producer(database).measureDetailed()
    expect(result.baselineCommitted).toBe(true)
    expect(database.log).toEqual([
      { config: { isolationLevel: 'repeatable read', accessMode: 'read only' } },
    ])
  })

  test('a failed transaction resolves undefined and never surfaces driver text', async () => {
    const database = fakeDatabase({ rowsBySource: allRows(), failBegin: true })
    const subject = producer(database)
    await expect(subject.measure()).resolves.toBeUndefined()
    await expect(subject.measureDetailed()).resolves.toBeUndefined()
  })

  test('when every source is unreadable nothing is claimed', async () => {
    const database = fakeDatabase({
      rowsBySource: allRows(),
      failSources: [...postgresMeasuredNamespaces],
    })
    await expect(producer(database).measure()).resolves.toBeUndefined()
  })

  test('source failures reduce to fixed reason codes without driver messages', async () => {
    const database = fakeDatabase({
      rowsBySource: allRows(),
      failSources: ['usage-budgets'],
    })
    const result = await producer(database).measureDetailed()
    expect(result.sources['usage-budgets']).toEqual({
      status: 'unavailable',
      reason: 'permission_denied',
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('pw-leaky-secret')
    expect(serialized).not.toContain('secret_table')
    expect(result.baselineCommitted).toBe(false)
  })

  test('truncated executions, over-bound scans, malformed and overflowing rows are incomplete', async () => {
    const database = fakeDatabase({
      rowsBySource: allRows({
        'execution-attempts': { executions_truncated: true },
        'execution-events': { scanned: '10001' },
        'runtime-commands': { active: 'not-a-number' },
        'usage-ledger-entries': { usd_entries: '1', usd_exact: '9007199254740993' },
        'usage-budgets': { malformed: '1' },
        'runtime-discovery-sessions': { malformed: '2' },
      }),
    })
    const { sources } = await producer(database).measureDetailed()
    expect(sources['execution-attempts']).toEqual({
      status: 'incomplete',
      reason: 'row_budget_reached',
    })
    expect(sources['execution-events']).toEqual({
      status: 'incomplete',
      reason: 'row_budget_reached',
    })
    expect(sources['runtime-commands']).toEqual({
      status: 'incomplete',
      reason: 'malformed_records',
    })
    expect(sources['usage-ledger-entries']).toEqual({
      status: 'incomplete',
      reason: 'unsafe_total',
    })
    expect(sources['usage-budgets']).toEqual({ status: 'incomplete', reason: 'malformed_records' })
    expect(sources['runtime-discovery-sessions']).toEqual({
      status: 'incomplete',
      reason: 'malformed_records',
    })
    expect(sources.executions).toEqual({ status: 'complete' })
  })

  test('baseline advances only on complete passes and growth is measured against it', async () => {
    let bytes = 100
    const database = {
      transaction: async (callback) => {
        let read = 0
        return callback({
          execute: async () => [],
          transaction: async (inner) =>
            inner({
              execute: async () => {
                const namespace = postgresMeasuredNamespaces[read]
                read += 1
                return [
                  baseRow({
                    bytes: String(bytes),
                    ...(bytes === 150 && namespace === 'executions' ? { scanned: '10001' } : {}),
                  }),
                ]
              },
            }),
        })
      },
    }
    const subject = producer(database)
    const first = await subject.measureDetailed()
    expect(first.baselineCommitted).toBe(true)
    bytes = 150
    const partial = await subject.measureDetailed()
    expect(partial.baselineCommitted).toBe(false)
    bytes = 130
    const third = await subject.measureDetailed()
    const growth = third.points.find(
      (point) =>
        point.name === operationsMetricNames.storageGrowthBytes &&
        point.labels.namespace === 'total'
    )
    expect(growth.value).toBe((130 - 100) * postgresMeasuredNamespaces.length)
  })

  test('concurrent callers coalesce onto one pass', async () => {
    let transactions = 0
    const database = {
      transaction: async (callback) => {
        transactions += 1
        let read = 0
        return callback({
          execute: async () => [],
          transaction: async (inner) =>
            inner({
              execute: async () => {
                read += 1
                await new Promise((resolve) => setTimeout(resolve, 5))
                return [baseRow()]
              },
            }),
        })
      },
    }
    const subject = producer(database)
    const [first, second] = await Promise.all([
      subject.measureDetailed(),
      subject.measureDetailed(),
    ])
    expect(second).toBe(first)
    expect(transactions).toBe(1)
    await subject.measureDetailed()
    expect(transactions).toBe(2)
  })
})

describe('createPostgresRuntimeMeasurements', () => {
  test('feeds the shared lifecycle under the hosted service name and drains on close', async () => {
    const recorded = []
    const adapter = {
      add: () => {},
      record: (name, value, attributes) => recorded.push({ name, value, attributes }),
      recordGauge: (name, value, attributes) => recorded.push({ name, value, attributes }),
    }
    const database = fakeDatabase({ rowsBySource: allRows() })
    const lifecycle = createPostgresRuntimeMeasurements({
      database,
      adapter,
      intervalMs: 3_600_000,
      workspaceId: WORKSPACE,
      now: () => NOW,
    })
    lifecycle.start()
    await lifecycle.close()
    expect(recorded.length).toBeGreaterThan(0)
    expect(new Set(recorded.map((entry) => entry.attributes['service.name']))).toEqual(
      new Set(['hosted-control-plane'])
    )
    const emitted = recorded.length
    await lifecycle.sample()
    expect(recorded.length).toBe(emitted)
  })

  test('rejects an invalid cadence or scope at construction', () => {
    const adapter = { add() {}, record() {}, recordGauge() {} }
    const database = fakeDatabase({ rowsBySource: allRows() })
    expect(() =>
      createPostgresRuntimeMeasurements({
        database,
        adapter,
        intervalMs: 5,
        workspaceId: WORKSPACE,
      })
    ).toThrow('OPERATIONS_MEASUREMENT_INTERVAL_INVALID')
    expect(() =>
      createPostgresRuntimeMeasurements({
        database,
        adapter,
        intervalMs: 5000,
        workspaceId: 'nope',
      })
    ).toThrow('POSTGRES_MEASUREMENT_WORKSPACE_INVALID')
  })
})
