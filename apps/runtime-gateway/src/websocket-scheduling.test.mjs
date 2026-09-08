import { expect, test } from 'bun:test'
import { RuntimeGatewayWebSocketServer } from './websocket-server.ts'
import { RuntimeHealthDeliveryWorker } from './runtime-health-delivery-worker.ts'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('held health delivery does not overlap or delay ownership sweeps and drains once', async () => {
  let sweeps = 0
  let deliveries = 0
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const worker = new RuntimeHealthDeliveryWorker({
    intervalMs: 5,
    dispatcher: {
      async dispatchBatch(limit) {
        expect(limit).toBe(1)
        deliveries++
        await held
        return { delivered: 1, failed: 0, conflicts: 0 }
      },
    },
  })
  const { server } = fixture(async () => {
    sweeps++
  })
  server.start()
  worker.start()
  try {
    await until(() => deliveries === 1 && sweeps >= 3)
    expect(deliveries).toBe(1)
    const closing = worker.close()
    expect(worker.close()).toBe(closing)
    let closed = false
    void closing.then(() => {
      closed = true
    })
    await server.close()
    await pause(10)
    expect(closed).toBe(false)
    release()
    await closing
    await pause(15)
    expect(deliveries).toBe(1)
    expect(() => worker.start()).toThrow()
  } finally {
    release()
    await worker.close()
    await server.close()
  }
})

test('health delivery failures and reporting errors retain later passes', async () => {
  let calls = 0
  const reports = []
  const worker = new RuntimeHealthDeliveryWorker({
    intervalMs: 5,
    dispatcher: {
      async dispatchBatch() {
        calls++
        if (calls === 1) throw new Error('private')
        return { delivered: 0, failed: calls === 2 ? 1 : 0, conflicts: 0 }
      },
    },
    onError: (...args) => {
      reports.push(args)
      throw new Error('private sink')
    },
  })
  worker.start()
  try {
    await until(() => calls >= 3)
    expect(reports).toEqual([[], []])
  } finally {
    await worker.close()
  }
})

test('health delivery close before start or first tick prevents dispatch', async () => {
  let calls = 0
  const options = {
    intervalMs: 20,
    dispatcher: {
      async dispatchBatch() {
        calls++
        return { delivered: 0, failed: 0, conflicts: 0 }
      },
    },
  }
  const unopened = new RuntimeHealthDeliveryWorker(options)
  await unopened.close()
  expect(() => unopened.start()).toThrow()
  const worker = new RuntimeHealthDeliveryWorker(options)
  worker.start()
  expect(() => worker.start()).toThrow()
  await worker.close()
  await pause(30)
  expect(calls).toBe(0)
  for (const intervalMs of [0, -1, 1.5, 60_001])
    expect(() => new RuntimeHealthDeliveryWorker({ ...options, intervalMs })).toThrow()
  for (const batchSize of [0, -1, 1.5, 129])
    expect(() => new RuntimeHealthDeliveryWorker({ ...options, batchSize })).toThrow()
})
async function until(predicate) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Scheduler test timed out')
    await pause(2)
  }
}

function fixture(sweep, overrides = {}) {
  const events = []
  const server = new RuntimeGatewayWebSocketServer({
    lifecycle: { sweep, close: async () => events.push('close') },
    authenticateUpgrade: async () => {
      throw new Error('unused')
    },
    hostname: '127.0.0.1',
    port: 0,
    limits: { maxFrameBytes: 1024, maxBufferedBytes: 1024, idleTimeoutSeconds: 30 },
    sweepIntervalMs: 5,
    serve: () => ({ stop: async (force) => events.push(['stop', force]) }),
    ...overrides,
  })
  return { server, events }
}

test('scheduled sweeps do not overlap and shutdown waits for in-flight work', async () => {
  let calls = 0
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const { server, events } = fixture(async () => {
    calls++
    await held
  })
  server.start()
  try {
    await until(() => calls === 1)
    await pause(25)
    expect(calls).toBe(1)
    const closing = server.close()
    expect(server.close()).toBe(closing)
    await pause(10)
    expect(events).toEqual([])
    release()
    await closing
    expect(events).toEqual(['close', ['stop', true]])
    await pause(20)
    expect(calls).toBe(1)
    expect(() => server.start()).toThrow()
  } finally {
    release()
    await server.close()
  }
})

test('sweep and reporting failures do not leak raw errors or stop subsequent sweeps', async () => {
  let calls = 0
  const reports = []
  const { server } = fixture(
    async () => {
      calls++
      if (calls === 1) throw new Error('private database detail')
    },
    {
      onSweepError: (...args) => {
        reports.push(args)
        throw new Error('sink down')
      },
    }
  )
  server.start()
  try {
    await until(() => calls >= 2)
    expect(reports).toEqual([[]])
  } finally {
    await server.close()
  }
})

test('closing before the first sweep cancels it and stops the native listener on drain failure', async () => {
  let calls = 0
  const { server, events } = fixture(
    async () => {
      calls++
    },
    {
      sweepIntervalMs: 30,
      lifecycle: {
        sweep: async () => {
          calls++
        },
        close: async () => {
          throw new Error('drain failed')
        },
      },
    }
  )
  server.start()
  await expect(server.close()).rejects.toThrow('drain failed')
  await pause(40)
  expect(calls).toBe(0)
  expect(events).toEqual([['stop', true]])
})

test.each([0, -1, 1.5, 60_001])('rejects invalid sweep interval %s', (sweepIntervalMs) => {
  expect(() => fixture(async () => {}, { sweepIntervalMs })).toThrow('Invalid sweepIntervalMs')
})

test('rejects upgrades that finish authentication after shutdown starts', async () => {
  let options
  let release
  let upgrades = 0
  const authenticated = new Promise((resolve) => {
    release = resolve
  })
  const { server } = fixture(async () => {}, {
    authenticateUpgrade: () => authenticated,
    serve: (input) => {
      options = input
      return { stop: async () => {} }
    },
  })
  server.start()
  const request = new Request('http://127.0.0.1/runtime-gateway/v1/connect', {
    headers: { upgrade: 'websocket' },
  })
  const native = {
    upgrade: () => {
      upgrades++
      return true
    },
  }
  const pending = options.fetch(request, native)
  await server.close()
  release({})
  expect((await pending).status).toBe(503)
  expect((await options.fetch(request, native)).status).toBe(503)
  expect(upgrades).toBe(0)
})

test('scheduled maintenance follows lifecycle checks and reports incomplete pages', async () => {
  const order = []
  let reports = 0
  const { server } = fixture(
    async () => {
      order.push('lifecycle')
    },
    {
      inventoryMaintenance: {
        runPage: async () => {
          order.push('inventory')
          return { visited: 1, updated: 0, conflicts: 1, failed: [], cycleComplete: false }
        },
      },
      onSweepError: () => {
        reports++
      },
    }
  )
  server.start()
  try {
    await until(() => reports > 0)
    expect(order.slice(0, 2)).toEqual(['lifecycle', 'inventory'])
  } finally {
    await server.close()
  }
})
