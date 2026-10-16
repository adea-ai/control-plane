import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { OperationsMeasurementLifecycle } from './operations-lifecycle.ts'

function fixture(measure, overrides = {}) {
  const observations = []
  const adapter = {
    add() {
      assert.fail('operations must never increment counters')
    },
    record(name, value, attributes) {
      observations.push({ name, value, attributes })
    },
    recordGauge(name, value, attributes) {
      observations.push({ name, value, attributes })
    },
  }
  const lifecycle = new OperationsMeasurementLifecycle({
    adapter,
    serviceName: 'local-control-plane',
    intervalMs: 1000,
    measure,
    ...overrides,
  })
  return { lifecycle, observations }
}

test('start emits bounded secret-free measurements; close prevents further observations', async () => {
  const points = [
    {
      name: 'runtime.active_object.count',
      value: 2,
      labels: { object_kind: 'execution', workspaceId: 'secret-canary', prompt: 'secret-canary' },
    },
    { name: 'storage.growth.bytes', value: -4, labels: { namespace: 'executions' } },
    { name: 'unrecognized', value: 1 },
  ]
  const { lifecycle, observations } = fixture(() => points)
  await lifecycle.sample()
  assert.equal(observations.length, 0)
  lifecycle.start()
  lifecycle.start()
  await lifecycle.sample()
  assert.equal(observations.length, 2)
  assert.equal(observations[1].value, -4)
  assert.equal(JSON.stringify(observations).includes('secret-canary'), false)
  await lifecycle.close()
  lifecycle.start()
  await lifecycle.sample()
  assert.equal(observations.length, 2)
})

test('concurrent sampling coalesces; close drains before persistence may shut down', async () => {
  let release
  let calls = 0
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const { lifecycle } = fixture(async () => {
    calls++
    await pending
    return []
  })
  lifecycle.start()
  const first = lifecycle.sample()
  assert.equal(first, lifecycle.sample())
  await Promise.resolve()
  assert.equal(calls, 1)
  let closed = false
  const closing = lifecycle.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  assert.equal(closed, false)
  release()
  await first
  await closing
  assert.equal(closed, true)
  assert.equal(calls, 1)
})

test('source failures and unsupported substrates do not emit fabricated zeros; next pass recovers', async () => {
  let calls = 0
  const { lifecycle, observations } = fixture(() => {
    calls++
    if (calls === 1) throw new Error('producer-secret-canary')
    if (calls === 2) return undefined
    return [{ name: 'runtime.active_object.count', value: 3, labels: { object_kind: 'job' } }]
  })
  lifecycle.start()
  await lifecycle.sample()
  await lifecycle.sample()
  assert.equal(observations.length, 0)
  await lifecycle.sample()
  assert.equal(observations.length, 1)
  await lifecycle.close()
})

test('emission is volume-bounded and exporter failures remain non-authoritative', async () => {
  const point = { name: 'runtime.active_object.count', value: 1 }
  const { lifecycle, observations } = fixture(
    () => Array.from({ length: 10 }, () => ({ ...point })),
    { maxPoints: 2 }
  )
  lifecycle.start()
  await lifecycle.sample()
  assert.equal(observations.length, 2)
  await lifecycle.close()
  const throwing = fixture(() => [point], {
    adapter: {
      add() {
        throw Error('secret')
      },
      record() {
        throw Error('secret')
      },
      recordGauge() {
        throw Error('secret')
      },
    },
  }).lifecycle
  throwing.start()
  await throwing.sample()
  await throwing.close()
})

test('invalid cadence and point limits fail before scheduling', () => {
  for (const intervalMs of [0, 999, NaN, Infinity, 86_400_001, 1000.1]) {
    assert.throws(() => fixture(() => [], { intervalMs }), /INTERVAL_INVALID/)
  }
  for (const maxPoints of [0, 1025, NaN, 1.1]) {
    assert.throws(() => fixture(() => [], { maxPoints }), /POINT_LIMIT_INVALID/)
  }
})

const point = {
  name: 'runtime.active_object.count',
  value: 1,
  labels: { object_kind: 'execution' },
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a stalled pass is aborted at its deadline; sample is bounded and a late result is discarded', async () => {
  let release
  let signal
  const { lifecycle, observations } = fixture(
    (context) => {
      signal = context.signal
      return new Promise((resolve) => {
        release = resolve
      })
    },
    { passTimeoutMs: 20 }
  )
  lifecycle.start()
  const started = Date.now()
  await lifecycle.sample()
  assert.ok(Date.now() - started < 1000)
  assert.equal(signal.aborted, true)
  assert.equal(observations.length, 0)
  release([point])
  await sleep(10)
  assert.equal(observations.length, 0)
  await lifecycle.close()
})

test('no new pass starts on top of a stalled producer; metrics resume once it settles', async () => {
  let calls = 0
  const releases = []
  const { lifecycle, observations } = fixture(
    () => {
      calls++
      return new Promise((resolve) => releases.push(resolve))
    },
    { passTimeoutMs: 20 }
  )
  lifecycle.start()
  await lifecycle.sample()
  await lifecycle.sample()
  await lifecycle.sample()
  assert.equal(calls, 1)
  releases[0]([point])
  await sleep(10)
  assert.equal(observations.length, 0)
  const next = lifecycle.sample()
  await Promise.resolve()
  releases[1]([point])
  await next
  assert.equal(calls, 2)
  assert.equal(observations.length, 1)
  await lifecycle.close()
})

test('a producer that observes the signal rejects after abandonment without an unhandled error', async () => {
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const { lifecycle, observations } = fixture(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      { passTimeoutMs: 20 }
    )
    lifecycle.start()
    await lifecycle.sample()
    await sleep(20)
    assert.equal(unhandled.length, 0)
    assert.equal(observations.length, 0)
    await lifecycle.sample()
    await lifecycle.close()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('close against a never-settling producer returns within its deadline and aborts the pass', async () => {
  let signal
  const { lifecycle, observations } = fixture(
    (context) => {
      signal = context.signal
      return new Promise(() => undefined)
    },
    { passTimeoutMs: 60_000, closeTimeoutMs: 30 }
  )
  lifecycle.start()
  void lifecycle.sample()
  await Promise.resolve()
  const started = Date.now()
  await lifecycle.close()
  assert.ok(Date.now() - started < 1000)
  assert.equal(signal.aborted, true)
  assert.equal(observations.length, 0)
})

test('close drains a pass that finishes inside the deadline and emits it exactly once', async () => {
  let release
  let signal
  const { lifecycle, observations } = fixture(
    (context) => {
      signal = context.signal
      return new Promise((resolve) => {
        release = resolve
      })
    },
    { closeTimeoutMs: 500 }
  )
  lifecycle.start()
  void lifecycle.sample()
  await Promise.resolve()
  const closing = lifecycle.close()
  release([point])
  await closing
  assert.equal(observations.length, 1)
  assert.equal(signal.aborted, false)
})

test('repeated and concurrent close share one completion; nothing is emitted after close resolves', async () => {
  let release
  const { lifecycle, observations } = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
    { closeTimeoutMs: 20 }
  )
  lifecycle.start()
  void lifecycle.sample()
  await Promise.resolve()
  const first = lifecycle.close()
  const second = lifecycle.close()
  assert.equal(first, second)
  await first
  await lifecycle.close()
  release([point])
  await sleep(10)
  assert.equal(observations.length, 0)
  lifecycle.start()
  await lifecycle.sample()
  assert.equal(observations.length, 0)
})

test('close without an active pass resolves immediately and stays idempotent', async () => {
  const { lifecycle } = fixture(() => [point], { closeTimeoutMs: 20 })
  lifecycle.start()
  await lifecycle.close()
  await lifecycle.close()
})

test('invalid pass and close deadlines fail before scheduling', () => {
  for (const overrides of [
    { passTimeoutMs: 9 },
    { passTimeoutMs: 600_001 },
    { passTimeoutMs: 1.5 },
    { closeTimeoutMs: 9 },
    { closeTimeoutMs: 60_001 },
    { closeTimeoutMs: Number.NaN },
  ])
    assert.throws(() => fixture(() => [], overrides))
})
