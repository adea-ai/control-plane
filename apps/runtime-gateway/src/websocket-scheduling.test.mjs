import { expect, test } from 'bun:test'
import { RuntimeGatewayWebSocketServer } from './websocket-server.ts'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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
