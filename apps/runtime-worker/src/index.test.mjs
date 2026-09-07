import { expect, test } from 'bun:test'
import { start } from './index.js'

function options(environment = 'production') {
  const listeners = new Map()
  const processAdapter = {
    listeners,
    on: (event, listener) => listeners.set(event, listener),
    off: (event) => listeners.delete(event),
    setExitCode(code) {
      this.exitCode = code
    },
  }
  return {
    environment: {
      APP_ENV: environment,
      COMMIT_SHA: 'worker-startup-test',
      INSTANCE_ID: 'worker-startup-test',
      SERVICE_VERSION: '1.3.0',
    },
    logger: { write() {} },
    processAdapter,
  }
}

test('Runtime Worker rejects an absent hosted worker in staging and production', async () => {
  for (const environment of ['staging', 'production']) {
    const input = options(environment)
    let runtime
    try {
      await expect(
        (async () => {
          runtime = await start(input)
        })()
      ).rejects.toMatchObject({ name: 'ServiceStartupError' })
      expect(input.processAdapter.exitCode).toBe(1)
      expect(input.processAdapter.listeners.size).toBe(0)
    } finally {
      await runtime?.shutdown('test')
    }
  }
})

test('Runtime Worker closes its hosted worker when readiness fails or throws', async () => {
  for (const throws of [false, true]) {
    const input = options()
    let closes = 0
    await expect(
      start({
        ...input,
        hostedManagedPiWorker: {
          readiness: async () => {
            if (throws) throw new Error('probe failed')
            return { ready: false, reason: 'HOST_UNAVAILABLE' }
          },
          close: async () => {
            closes++
          },
        },
      })
    ).rejects.toMatchObject({ name: 'ServiceStartupError' })
    expect(closes).toBe(1)
    expect(input.processAdapter.listeners.size).toBe(0)
  }
})

test('Runtime Worker retains local startup and drains a ready hosted worker once', async () => {
  const local = await start(options('test'))
  expect(local.readiness().status).toBe('ready')
  await local.shutdown('test')
  let closes = 0
  const input = options()
  const runtime = await start({
    ...input,
    hostedManagedPiWorker: {
      readiness: async () => ({ ready: true, reason: 'READY' }),
      close: async () => {
        closes++
      },
    },
  })
  expect(runtime.readiness().status).toBe('ready')
  await Promise.all([runtime.shutdown('test'), runtime.shutdown('test')])
  expect(closes).toBe(1)
  expect(input.processAdapter.listeners.size).toBe(0)
})
