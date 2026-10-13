import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { OperationsMeasurementLifecycle } from './operations-lifecycle.ts'

function fixture(measure, overrides = {}) {
  const observations = []
  const adapter = {
    add() { assert.fail('operations must never increment counters') },
    record(name, value, attributes) { observations.push({ name, value, attributes }) },
    recordGauge(name, value, attributes) { observations.push({ name, value, attributes }) },
  }
  const lifecycle = new OperationsMeasurementLifecycle({
    adapter, serviceName: 'local-control-plane', intervalMs: 1000, measure, ...overrides,
  })
  return { lifecycle, observations }
}

test('start emits bounded secret-free measurements; close prevents further observations', async () => {
  const points = [
    { name: 'runtime.active_object.count', value: 2, labels: { object_kind: 'execution', workspaceId: 'secret-canary', prompt: 'secret-canary' } },
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
  const pending = new Promise((resolve) => { release = resolve })
  const { lifecycle } = fixture(async () => { calls++; await pending; return [] })
  lifecycle.start()
  const first = lifecycle.sample()
  assert.equal(first, lifecycle.sample())
  await Promise.resolve()
  assert.equal(calls, 1)
  let closed = false
  const closing = lifecycle.close().then(() => { closed = true })
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
  const { lifecycle, observations } = fixture(() => Array(10).fill(point), { maxPoints: 2 })
  lifecycle.start()
  await lifecycle.sample()
  assert.equal(observations.length, 2)
  await lifecycle.close()
  const throwing = fixture(() => [point], {
    adapter: { add() { throw Error('secret') }, record() { throw Error('secret') }, recordGauge() { throw Error('secret') } },
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
